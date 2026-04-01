import { EmbedBuilder, PermissionsBitField, type ChatInputCommandInteraction, type Guild, type GuildTextBasedChannel, type Message } from "discord.js";
import { config } from "../config";
import { assertAdmin } from "../access";
import { enrichGithubUrl } from "../integrations/github";
import { fetchGuildMessages, listScanChannels } from "../scanner/fetcher";
import { attachEvidenceMessages, createScan, failScan, finalizeScan, getActiveCategoryNames, getChannelScanCursors, getOpenItemsInLookback, getScanChannel, getSkippableChatEngagedMessageIds, isIgnoredCandidate, listAdmins, listAllCategoryAssigneeIds, recordScannedMessages, recoverStaleScans, updateChannelScanCursors, updateItemGithubMetadata, updateItemTraceState, upsertIssue, updateHumanReply } from "../issues/store";
import { bindSummaryMessage, createDigestSession, replaceSessionCards, summaryMessagePayload } from "../issues/digest";
import { triageConversationTrace, type TraceTriageMessage } from "../scanner/traceTriage";
import { TRACE_ANALYSIS_VERSION, computeTraceFingerprint, getCachedTraceAnalysis, linkTraceToItem, upsertConversationTrace, upsertTraceAnalysisCache } from "../traces/store";
import type { FetchedMessage, GithubEnrichment, ItemMessageRole, NormalizedIssueInput, RenderedItem, ScanSummary } from "../types";
import { hoursFromPeriod } from "../utils/time";
import { contentFingerprint, extractGithubUrl, isLowSignalHelpMessage, likelySameTopic, preview } from "../utils/text";
import { logDebug, logError, logInfo } from "../utils/logger";

const GITHUB_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const LLAMA_ROLE_NAME = "llama";

function isLlamaRoleName(name: string): boolean {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .includes(LLAMA_ROLE_NAME);
}
const TRACE_EVIDENCE_LIMIT = 12;
const TRACE_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

const activeScans = new Map<string, { progressMessageId?: string; startedAt: number }>();

function errorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "unknown error";
}

async function updateProgress(
  interaction: ChatInputCommandInteraction,
  description: string
): Promise<void> {
  const loading = new EmbedBuilder().setTitle("scanning").setDescription(description);
  await interaction.editReply({ embeds: [loading], components: [] });
}

async function resolveOutputChannel(interaction: ChatInputCommandInteraction): Promise<GuildTextBasedChannel> {
  if (!interaction.guild || !interaction.guildId) {
    throw new Error("guild only command");
  }

  const configuredId = getScanChannel(interaction.guildId);
  const outputId = configuredId ?? interaction.channelId;
  const channel = await interaction.guild.channels.fetch(outputId);
  if (!channel?.isTextBased() || !("send" in channel) || !("messages" in channel)) {
    throw new Error("scan output channel is invalid.");
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  const permissions = me ? channel.permissionsFor(me) : null;
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel) || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
    throw new Error("i can't post in the configured scan channel.");
  }

  return channel as GuildTextBasedChannel;
}

interface ConversationTraceCandidate {
  messages: FetchedMessage[];
}

function buildConversationTraces(messages: FetchedMessage[]): ConversationTraceCandidate[] {
  const ordered = messages
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
  const traces: ConversationTraceCandidate[] = [];

  for (const message of ordered) {
    let target: ConversationTraceCandidate | null = null;
    for (let index = traces.length - 1; index >= 0; index -= 1) {
      const trace = traces[index];
      const last = trace.messages[trace.messages.length - 1];
      if (!last) {
        continue;
      }
      const sameReplyChain = Boolean(
        (message.referenceMessageId && trace.messages.some((entry) => entry.messageId === message.referenceMessageId))
        || trace.messages.some((entry) => entry.referenceMessageId === message.messageId)
      );
      const sameAuthorTopic = trace.messages.some((entry) => entry.authorId === message.authorId && likelySameTopic(entry.content, message.content));
      const sameChannelTopic = trace.messages.some((entry) => entry.channelId === message.channelId && likelySameTopic(entry.content, message.content));
      const nearInTime = Math.abs(Date.parse(message.createdAt) - Date.parse(last.createdAt)) <= TRACE_EVIDENCE_WINDOW_MS;
      if (nearInTime && (sameReplyChain || sameAuthorTopic || sameChannelTopic)) {
        target = trace;
        break;
      }
    }
    if (!target) {
      target = { messages: [] };
      traces.push(target);
    }
    if (!target.messages.some((entry) => entry.messageId === message.messageId)) {
      target.messages.push(message);
      target.messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
      if (target.messages.length > TRACE_EVIDENCE_LIMIT) {
        target.messages = target.messages.slice(-TRACE_EVIDENCE_LIMIT);
      }
    }
  }

  return traces;
}

function extractGithubPullUrl(text: string): URL | null {
  const raw = text.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i)?.[0];
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isPrFollowUpMessage(text: string): boolean {
  const lower = text.toLowerCase();
  if (!extractGithubPullUrl(lower)) {
    return false;
  }
  return [
    "pr",
    "pull request",
    "merge",
    "merged",
    "review",
    "look at",
    "can you check",
    "can someone check",
    "any update",
    "when can this",
    "please review"
  ].some((phrase) => lower.includes(phrase));
}

async function classifyTraceParticipantRole(args: {
  guild: Guild;
  authorId: string;
  knownHandlerIds: Set<string>;
  roleCache: Map<string, Promise<ItemMessageRole>>;
}): Promise<ItemMessageRole> {
  if (args.roleCache.has(args.authorId)) {
    return args.roleCache.get(args.authorId)!;
  }
  const pending = (async (): Promise<ItemMessageRole> => {
    try {
      const member = await args.guild.members.fetch(args.authorId);
      if (member.roles.cache.some((role) => isLlamaRoleName(role.name))) {
        return "llama";
      }
    } catch {}
    if (args.knownHandlerIds.has(args.authorId)) {
      return "team";
    }
    return "user";
  })();
  args.roleCache.set(args.authorId, pending);
  return pending;
}

function itemGithubUrl(item: RenderedItem): string | null {
  return item.github_url ?? extractGithubUrl(`${item.content_preview} ${item.summary}`);
}

function needsGithubMetadataBackfill(item: RenderedItem): boolean {
  if (!itemGithubUrl(item)) {
    return false;
  }
  if (!item.github_repo_label || !item.github_ref_label || !item.github_status || !item.github_last_activity_at) {
    return true;
  }
  if (!item.github_synced_at) {
    return true;
  }
  const syncedAt = Date.parse(item.github_synced_at);
  return !Number.isFinite(syncedAt) || (Date.now() - syncedAt) >= GITHUB_REFRESH_WINDOW_MS;
}

async function backfillGithubMetadataForItems(args: {
  guildId: string;
  scanId: number;
  items: RenderedItem[];
  githubCache: Map<string, Promise<GithubEnrichment | null>>;
}): Promise<number> {
  let enrichedCount = 0;
  for (const item of args.items) {
    if (!needsGithubMetadataBackfill(item)) {
      continue;
    }
    const githubUrl = itemGithubUrl(item);
    if (!githubUrl) {
      continue;
    }
    const pending = args.githubCache.get(githubUrl) ?? enrichGithubUrl(githubUrl).catch((error) => {
      logError("scan.github.backfill.failed", error, {
        scanId: args.scanId,
        guildId: args.guildId,
        itemId: item.id,
        githubUrl
      });
      return null;
    });
    args.githubCache.set(githubUrl, pending);
    const enrichment = await pending;
    if (!enrichment) {
      continue;
    }
    updateItemGithubMetadata(item.id, args.guildId, enrichment);
    enrichedCount += 1;
    logDebug("scan.github.backfill.success", {
      scanId: args.scanId,
      guildId: args.guildId,
      itemId: item.id,
      githubUrl
    });
  }
  return enrichedCount;
}

export async function runScan(interaction: ChatInputCommandInteraction): Promise<void> {
  assertAdmin(interaction);
  if (!interaction.guild || !interaction.guildId) {
    throw new Error("guild only command");
  }
  recoverStaleScans(config.staleScanMinutes);
  if (activeScans.has(interaction.guildId)) {
    await interaction.reply({ content: "a scan is already in progress.", ephemeral: true });
    return;
  }

  const period = interaction.options.getString("period", false);
  const lookbackHours = Math.min(hoursFromPeriod(period), config.maxLookbackHours);
  const outputChannel = await resolveOutputChannel(interaction);
  const outputLabel = outputChannel.id === interaction.channelId ? "here" : `<#${outputChannel.id}>`;
  logInfo("scan.start", {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    outputChannelId: outputChannel.id,
    userId: interaction.user.id,
    requestedPeriod: period ?? null,
    lookbackHours
  });

  await interaction.deferReply({ ephemeral: false });
  await updateProgress(interaction, `scanning last ${lookbackHours}h...\nresults: ${outputLabel}`);
  const progressMessage = (await interaction.fetchReply()) as Message;
  activeScans.set(interaction.guildId, { progressMessageId: progressMessage.id, startedAt: Date.now() });

  const scanId = createScan(interaction.guildId, interaction.user.id, lookbackHours);
  logDebug("scan.row.created", {
    scanId,
    guildId: interaction.guildId,
    lookbackHours,
    userId: interaction.user.id
  });

  try {
    const scanChannels = await listScanChannels(interaction.guild);
    const candidateChannelIds = [...scanChannels.keys()];
    const cursors = getChannelScanCursors(interaction.guildId, candidateChannelIds);
    const fetched = await fetchGuildMessages(
      interaction.guild,
      lookbackHours,
      undefined,
      cursors,
      async (current, total) => {
        if (current === 1 || current === total || current % 5 === 0) {
          await updateProgress(
            interaction,
            `scanning last ${lookbackHours}h...\nscanned ${current}/${total} channels...\nresults: ${outputLabel}`
          );
        }
      }
    );
    const githubCache = new Map<string, Promise<GithubEnrichment | null>>();
    const baseKnownHandlerIds = new Set<string>([
      interaction.guild.ownerId,
      ...listAdmins(interaction.guildId),
      ...listAllCategoryAssigneeIds(interaction.guildId)
    ]);
    const activeCategories = getActiveCategoryNames(interaction.guildId);
    const chatEngagedMessageIds = getSkippableChatEngagedMessageIds(
      interaction.guildId,
      fetched.messages.map((message) => message.messageId)
    );
    const chatEngagedSkippableIds = new Set(
      fetched.messages
        .filter((message) => chatEngagedMessageIds.has(message.messageId))
        .filter((message) => isLowSignalHelpMessage(message.content))
        .map((message) => message.messageId)
    );
    const messagesSkippedAsChatEngaged = fetched.messages.filter((message) => chatEngagedSkippableIds.has(message.messageId));
    const messagesForTraceTriage = fetched.messages.filter((message) => !chatEngagedSkippableIds.has(message.messageId));
    const traceCandidates = buildConversationTraces(messagesForTraceTriage);
    let messagesReused = 0;
    let messagesAnalyzed = 0;
    logDebug("scan.fetch.complete", {
      scanId,
      guildId: interaction.guildId,
      channelsScanned: fetched.channelsScanned,
      skippedChannels: fetched.skippedChannels,
      messagesFetched: fetched.messages.length,
      traceCandidates: traceCandidates.length,
      messagesSkippedAsChatEngaged: messagesSkippedAsChatEngaged.length,
      analysisVersion: TRACE_ANALYSIS_VERSION
    });
    await updateProgress(
      interaction,
      `scanning last ${lookbackHours}h...\nfetched ${fetched.messages.length.toLocaleString()} messages from ${fetched.channelsScanned} channels.\nbuilt ${traceCandidates.length.toLocaleString()} conversation traces.\nskipped ${messagesSkippedAsChatEngaged.length.toLocaleString()} chat-engaged messages.\nresults: ${outputLabel}`
    );

    let itemsNew = 0;
    let itemsReturning = 0;
    const newItemIds = new Set<number>();
    const itemIdsByMessageId = new Map<string, number>();
    const memberRoleCache = new Map<string, Promise<ItemMessageRole>>();
    for (let index = 0; index < traceCandidates.length; index += 1) {
      const traceCandidate = traceCandidates[index];
      const traceMessages = traceCandidate.messages;
      if (traceMessages.length === 0) {
        continue;
      }
      const knownHandlerIds = new Set(baseKnownHandlerIds);
      const triageMessages: TraceTriageMessage[] = [];
      for (const message of traceMessages) {
        triageMessages.push({
          message,
          role: await classifyTraceParticipantRole({
            guild: interaction.guild,
            authorId: message.authorId,
            knownHandlerIds,
            roleCache: memberRoleCache
          })
        });
      }
      const traceFingerprint = computeTraceFingerprint(traceMessages);
      const cachedAnalysis = getCachedTraceAnalysis({
        guildId: interaction.guildId,
        traceFingerprint,
        analysisVersion: TRACE_ANALYSIS_VERSION
      });
      const triage = cachedAnalysis
        ? {
            traceKind: cachedAnalysis.trace_kind,
            traceState: cachedAnalysis.trace_state,
            primaryIssueMessageId: cachedAnalysis.primary_issue_message_id,
            strongestAnswerMessageId: cachedAnalysis.strongest_answer_message_id,
            category: cachedAnalysis.category,
            urgency: cachedAnalysis.urgency,
            confidence: cachedAnalysis.confidence,
            reasonTags: cachedAnalysis.reason_tags ? cachedAnalysis.reason_tags.split(",").filter(Boolean) : []
          }
        : await triageConversationTrace({
            guildId: interaction.guildId,
            messages: triageMessages,
            allowedCategories: activeCategories
          });
      if (cachedAnalysis) {
        messagesReused += traceMessages.length;
      } else {
        messagesAnalyzed += traceMessages.length;
        upsertTraceAnalysisCache({
          guildId: interaction.guildId,
          traceFingerprint,
          analysisVersion: TRACE_ANALYSIS_VERSION,
          traceKind: triage.traceKind,
          traceState: triage.traceState,
          category: triage.category,
          urgency: triage.urgency,
          confidence: triage.confidence,
          primaryIssueMessageId: triage.primaryIssueMessageId,
          strongestAnswerMessageId: triage.strongestAnswerMessageId,
          reasonTags: triage.reasonTags
        });
      }

      const primaryMessage = triage.primaryIssueMessageId
        ? traceMessages.find((message) => message.messageId === triage.primaryIssueMessageId) ?? null
        : null;
      const traceId = upsertConversationTrace({
        guildId: interaction.guildId,
        primaryChannelId: primaryMessage?.channelId ?? traceMessages[0].channelId,
        primaryMessageId: primaryMessage?.messageId ?? traceMessages[0].messageId,
        primaryIssueMessageId: triage.primaryIssueMessageId,
        strongestAnswerMessageId: triage.strongestAnswerMessageId,
        traceFingerprint,
        traceKind: triage.traceKind,
        traceState: triage.traceState,
        traceCategory: triage.category,
        urgency: triage.urgency,
        confidence: triage.confidence,
        reasonTags: triage.reasonTags,
        source: "scan",
        analysisVersion: TRACE_ANALYSIS_VERSION
      }, triageMessages.map((entry, positionIndex) => ({
        guildId: entry.message.guildId,
        channelId: entry.message.channelId,
        messageId: entry.message.messageId,
        referenceMessageId: entry.message.referenceMessageId,
        authorId: entry.message.authorId,
        authorName: entry.message.authorName,
        content: entry.message.content,
        role: entry.role,
        createdAt: entry.message.createdAt,
        positionIndex
      })));

      if (triage.traceKind !== "actionable" || !primaryMessage) {
        continue;
      }

      const issueMessages = triageMessages
        .filter((entry) => entry.role === "user")
        .filter((entry) => {
          if (!triage.primaryIssueMessageId) {
            return true;
          }
          return Date.parse(entry.message.createdAt) <= Date.parse(primaryMessage.createdAt)
            || entry.message.messageId === triage.primaryIssueMessageId;
        })
        .map((entry) => entry.message);
      const actionableMessages = issueMessages.length > 0 ? issueMessages : [primaryMessage];
      const normalized: NormalizedIssueInput = {
        guildId: primaryMessage.guildId,
        channelId: primaryMessage.channelId,
        messageId: primaryMessage.messageId,
        messageUrl: primaryMessage.messageUrl,
        authorId: primaryMessage.authorId,
        authorName: primaryMessage.authorName,
        content: primaryMessage.content,
        summary: preview(primaryMessage.content, 220),
        category: activeCategories.includes(triage.category) ? triage.category : "general",
        urgency: triage.urgency,
        createdAt: primaryMessage.createdAt,
        allMessages: actionableMessages,
        scanId
      };

      if (isIgnoredCandidate(interaction.guildId, normalized.authorId, normalized.category, normalized.summary)) {
        logDebug("scan.issue.ignored", {
          scanId,
          guildId: interaction.guildId,
          authorId: normalized.authorId,
          category: normalized.category,
          summary: normalized.summary
        });
        continue;
      }

      const { itemId, isNew } = upsertIssue(normalized);
      linkTraceToItem(traceId, interaction.guildId, itemId);
      const answerMessage = triage.strongestAnswerMessageId
        ? triageMessages.find((entry) => entry.message.messageId === triage.strongestAnswerMessageId) ?? null
        : null;
      const evidenceMessages = triageMessages
        .filter((entry) => !actionableMessages.some((message) => message.messageId === entry.message.messageId));
      if (evidenceMessages.length > 0) {
        attachEvidenceMessages(itemId, evidenceMessages.map((entry) => ({
          guildId: entry.message.guildId,
          channelId: entry.message.channelId,
          messageId: entry.message.messageId,
          referenceMessageId: entry.message.referenceMessageId,
          messageUrl: entry.message.messageUrl,
          authorId: entry.message.authorId,
          authorName: entry.message.authorName,
          content: entry.message.content,
          createdAt: entry.message.createdAt,
          role: entry.role
        })));
      }
      updateItemTraceState({
        itemId,
        guildId: interaction.guildId,
        traceId,
        traceState: triage.traceState,
        confidence: triage.confidence,
        answerMessageId: answerMessage?.message.messageId ?? null,
        answerAuthorId: answerMessage?.message.authorId ?? null,
        answerAuthorName: answerMessage?.message.authorName ?? null,
        answerText: answerMessage?.message.content ?? null,
        answerAt: answerMessage?.message.createdAt ?? null,
        answerRole: answerMessage?.role ?? null
      });
      if (answerMessage && (answerMessage.role === "team" || answerMessage.role === "llama")) {
        updateHumanReply(itemId, answerMessage.message.createdAt, answerMessage.message.authorId, answerMessage.message.authorName, answerMessage.message.content);
      }

      const githubUrl = extractGithubUrl(traceMessages.map((message) => message.content).join("\n"));
      if (githubUrl) {
        const pending = githubCache.get(githubUrl) ?? enrichGithubUrl(githubUrl).catch((error) => {
          logError("scan.github.enrich.failed", error, {
            scanId,
            guildId: interaction.guildId,
            itemId,
            githubUrl
          });
          return null;
        });
        githubCache.set(githubUrl, pending);
        const enrichment = await pending;
        if (enrichment) {
          updateItemGithubMetadata(itemId, interaction.guildId, enrichment);
        }
      }

      for (const message of traceMessages) {
        itemIdsByMessageId.set(message.messageId, itemId);
      }
      if (isNew) {
        itemsNew += 1;
        newItemIds.add(itemId);
      } else {
        itemsReturning += 1;
      }
      logDebug("scan.trace_triage.upserted", {
        scanId,
        guildId: interaction.guildId,
        itemId,
        traceId,
        traceKind: triage.traceKind,
        traceState: triage.traceState,
        confidence: triage.confidence,
        messageIds: traceMessages.map((message) => message.messageId)
      });
      if (index === 0 || (index + 1) === traceCandidates.length || (index + 1) % 10 === 0) {
        await updateProgress(
          interaction,
          `scanning last ${lookbackHours}h...\nfetched ${fetched.messages.length.toLocaleString()} messages from ${fetched.channelsScanned} channels.\nbuilt ${traceCandidates.length.toLocaleString()} conversation traces.\nreused ${messagesReused.toLocaleString()} cached semantic judgments.\ntriaged ${messagesAnalyzed.toLocaleString()} messages across traces.\nresults: ${outputLabel}`
        );
      }
    }

    recordScannedMessages(interaction.guildId, scanId, messagesForTraceTriage, itemIdsByMessageId);
    updateChannelScanCursors(interaction.guildId, fetched.messages);
    logDebug("scan.cache.recorded", {
      scanId,
      guildId: interaction.guildId,
      analyzedMessages: messagesAnalyzed,
      linkedMessages: itemIdsByMessageId.size
    });

    const summary: Omit<ScanSummary, "id"> = {
      channelsScanned: fetched.channelsScanned,
      channelsSkipped: fetched.skippedChannels.length,
      messagesFetched: fetched.messages.length,
      messagesReused,
      messagesAnalyzed,
      batchesSkipped: 0,
      itemsFound: itemsNew + itemsReturning,
      itemsNew,
      itemsReturning
    };
    finalizeScan(scanId, summary);
    logInfo("scan.complete", {
      scanId,
      guildId: interaction.guildId,
      summary
    });

    let scanItems = getOpenItemsInLookback(interaction.guildId, lookbackHours);
    const githubBackfills = await backfillGithubMetadataForItems({
      guildId: interaction.guildId,
      scanId,
      items: scanItems,
      githubCache
    });
    if (githubBackfills > 0) {
      scanItems = getOpenItemsInLookback(interaction.guildId, lookbackHours);
      logDebug("scan.github.backfill.refetch", {
        scanId,
        guildId: interaction.guildId,
        githubBackfills,
        visibleItems: scanItems.length
      });
    }
    const scanNewCount = scanItems.filter((item) => newItemIds.has(item.id)).length;
    const scanReturningCount = Math.max(0, scanItems.length - scanNewCount);
    const session = createDigestSession({
      guildId: interaction.guildId,
      channelId: outputChannel.id,
      items: scanItems,
      meta: {
        mode: "scan",
        totalCount: scanItems.length,
        newCount: scanNewCount,
        returningCount: scanReturningCount,
        lookbackHours,
        channelsScanned: summary.channelsScanned,
        channelsSkipped: summary.channelsSkipped,
        messagesFetched: summary.messagesFetched,
        messagesReused: summary.messagesReused,
        messagesAnalyzed: summary.messagesAnalyzed,
        batchesSkipped: summary.batchesSkipped
      }
    });
    const summaryPayload = summaryMessagePayload(session);
    let summaryMessage: Message;
    if (outputChannel.id === interaction.channelId) {
      logDebug("scan.summary.reply.edit.start", {
        scanId,
        guildId: interaction.guildId,
        outputChannelId: outputChannel.id
      });
      await interaction.editReply(summaryPayload);
      summaryMessage = (await interaction.fetchReply()) as Message;
      logDebug("scan.summary.reply.edit.success", {
        scanId,
        summaryMessageId: summaryMessage.id
      });
    } else {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("scan complete")
            .setDescription(`posted results in <#${outputChannel.id}>.`)
        ],
        components: []
      });
      summaryMessage = await outputChannel.send(summaryPayload);
      logDebug("scan.summary.send.success", {
        scanId,
        summaryMessageId: summaryMessage.id,
        outputChannelId: outputChannel.id
      });
    }
    bindSummaryMessage(session.id, summaryMessage.id);
    await replaceSessionCards({
      session,
      items: scanItems,
      channel: outputChannel,
      guild: interaction.guild
    });
  } catch (error) {
    failScan(scanId);
    logError("scan.failed", error, {
      scanId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      outputChannelId: outputChannel.id,
      userId: interaction.user.id
    });
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("scan failed").setDescription(errorMessage(error))],
      components: []
    });
  } finally {
    activeScans.delete(interaction.guildId);
    logDebug("scan.lock.cleared", {
      scanId,
      guildId: interaction.guildId
    });
  }
}
