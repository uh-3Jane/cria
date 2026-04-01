import { EmbedBuilder, PermissionsBitField, type ChatInputCommandInteraction, type Guild, type GuildTextBasedChannel, type Message } from "discord.js";
import { config } from "../config";
import { assertAdmin } from "../access";
import { enrichGithubUrl } from "../integrations/github";
import { analyzeMessages } from "../scanner/analyzer";
import { groupAcrossScan, groupWithinScan } from "../scanner/dedup";
import { fetchGuildMessages, listScanChannels } from "../scanner/fetcher";
import { createScan, failScan, finalizeScan, getActiveCategoryNames, getChannelScanCursors, getItem, getOpenItemsInLookback, getScanChannel, getScannedMessages, getSkippableChatEngagedMessageIds, isIgnoredCandidate, listAdmins, listAllCategoryAssigneeIds, recordScannedMessages, recoverStaleScans, updateChannelScanCursors, updateItemGithubMetadata, upsertIssue, updateHumanReply } from "../issues/store";
import { bindSummaryMessage, createDigestSession, replaceSessionCards, summaryMessagePayload } from "../issues/digest";
import type { FetchedMessage, GithubEnrichment, NormalizedIssueInput, RenderedItem, ScanSummary } from "../types";
import { hoursFromPeriod } from "../utils/time";
import { contentFingerprint, extractGithubUrl, isLowSignalHelpMessage } from "../utils/text";
import { logDebug, logError, logInfo } from "../utils/logger";

const GITHUB_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

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

function buildMessageLookup(messages: FetchedMessage[]): Map<string, FetchedMessage> {
  return new Map(messages.map((message) => [message.messageId, message]));
}

function detectHumanHandling(
  input: NormalizedIssueInput,
  channelMessages: Map<string, FetchedMessage[]>,
  knownHandlerIds: Set<string>
): { repliedAt: string; replyUserId: string | null; replyName: string | null; replyText: string | null } | null {
  const phrases = ["looking into it", "checking", "team is working on it", "fixed now", "should be better now", "next hourly update"];
  const messages = channelMessages.get(input.channelId) ?? [];
  const inputTime = Date.parse(input.createdAt);
  const match = messages.find((message) => {
    if (message.authorId === input.authorId) {
      return false;
    }
    const messageTime = Date.parse(message.createdAt);
    if (!Number.isFinite(messageTime) || !Number.isFinite(inputTime) || messageTime <= inputTime) {
      return false;
    }
    if (!knownHandlerIds.has(message.authorId)) {
      return false;
    }
    const lower = message.content.toLowerCase();
    return phrases.some((phrase) => lower.includes(phrase));
  });
  if (!match) {
    return null;
  }
  return {
    repliedAt: match.createdAt,
    replyUserId: match.authorId,
    replyName: match.authorName,
    replyText: match.content
  };
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

function groupMessagesByChannel(messages: FetchedMessage[]): Map<string, FetchedMessage[]> {
  const grouped = new Map<string, FetchedMessage[]>();
  for (const message of messages) {
    const existing = grouped.get(message.channelId);
    if (existing) {
      existing.push(message);
    } else {
      grouped.set(message.channelId, [message]);
    }
  }
  for (const messagesForChannel of grouped.values()) {
    messagesForChannel.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
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
    const messagesById = buildMessageLookup(fetched.messages);
    const messagesByChannel = groupMessagesByChannel(fetched.messages);
    const githubCache = new Map<string, Promise<GithubEnrichment | null>>();
    const baseKnownHandlerIds = new Set<string>([
      interaction.guild.ownerId,
      ...listAdmins(interaction.guildId),
      ...listAllCategoryAssigneeIds(interaction.guildId)
    ]);
    const activeCategories = getActiveCategoryNames(interaction.guildId);
    const cachedMessages = getScannedMessages(interaction.guildId, fetched.messages.map((message) => message.messageId));
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
    const candidateMessages = fetched.messages.filter((message) => {
      if (chatEngagedSkippableIds.has(message.messageId)) {
        return false;
      }
      const cached = cachedMessages.get(message.messageId);
      return !cached || cached.content_fingerprint !== contentFingerprint(message.content);
    });
    const messagesSkippedAsChatEngaged = fetched.messages.filter((message) => chatEngagedSkippableIds.has(message.messageId));
    const messagesSkippedAsVague = candidateMessages.filter((message) => isLowSignalHelpMessage(message.content));
    const messagesToAnalyze = candidateMessages.filter((message) => !isLowSignalHelpMessage(message.content));
    const messagesReused = fetched.messages.length - messagesSkippedAsChatEngaged.length - candidateMessages.length;
    logDebug("scan.fetch.complete", {
      scanId,
      guildId: interaction.guildId,
      channelsScanned: fetched.channelsScanned,
      skippedChannels: fetched.skippedChannels,
      messagesFetched: fetched.messages.length,
      messagesReused,
      messagesSkippedAsChatEngaged: messagesSkippedAsChatEngaged.length,
      messagesSkippedAsVague: messagesSkippedAsVague.length,
      messagesToAnalyze: messagesToAnalyze.length
    });
    await updateProgress(
      interaction,
      `scanning last ${lookbackHours}h...\nfetched ${fetched.messages.length.toLocaleString()} messages from ${fetched.channelsScanned} channels.\nreused ${messagesReused.toLocaleString()} cached messages.\nskipped ${messagesSkippedAsChatEngaged.length.toLocaleString()} chat-engaged messages.\nskipped ${messagesSkippedAsVague.length.toLocaleString()} vague help messages.\nresults: ${outputLabel}`
    );
    const analyzedResult = messagesToAnalyze.length === 0
      ? { items: [], skippedBatches: 0 }
      : await analyzeMessages(messagesToAnalyze, activeCategories, async (current, total) => {
      logDebug("scan.batch.progress", {
        scanId,
        guildId: interaction.guildId,
        batchCurrent: current,
        batchTotal: total,
        messagesToAnalyze: messagesToAnalyze.length
      });
      await updateProgress(
        interaction,
        `scanning last ${lookbackHours}h...\nfetched ${fetched.messages.length.toLocaleString()} messages from ${fetched.channelsScanned} channels.\nreused ${messagesReused.toLocaleString()} cached messages.\nskipped ${messagesSkippedAsChatEngaged.length.toLocaleString()} chat-engaged messages.\nskipped ${messagesSkippedAsVague.length.toLocaleString()} vague help messages.\nanalyzing ${messagesToAnalyze.length.toLocaleString()} new/changed messages (batch ${current}/${total})...\nresults: ${outputLabel}`
      );
    });
    const grouped = groupAcrossScan(groupWithinScan(analyzedResult.items, messagesById), messagesById);

    let itemsNew = 0;
    let itemsReturning = 0;
    const newItemIds = new Set<number>();
    const scannedItemIds = new Set<number>();
    const itemIdsByMessageId = new Map<string, number>();

    for (const candidate of grouped) {
      const primary = messagesById.get(candidate.message_id);
      if (!primary) {
        continue;
      }
      const allMessages = Array.from(
        new Map(
          candidate.allMessageIds
            .map((id) => messagesById.get(id))
            .filter((message): message is FetchedMessage => Boolean(message))
            .map((message) => [message.messageId, message])
        ).values()
      );
      const normalized: NormalizedIssueInput = {
        guildId: primary.guildId,
        channelId: primary.channelId,
        messageId: primary.messageId,
        messageUrl: primary.messageUrl,
        authorId: primary.authorId,
        authorName: primary.authorName,
        content: primary.content,
        summary: candidate.summary,
        category: activeCategories.includes(candidate.category) ? candidate.category : "general",
        urgency: candidate.urgency,
        createdAt: primary.createdAt,
        allMessages,
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
      logDebug("scan.issue.upserted", {
        scanId,
        guildId: interaction.guildId,
        itemId,
        isNew,
        category: normalized.category,
        urgency: normalized.urgency,
        messageId: normalized.messageId,
        relatedMessageIds: allMessages.map((message) => message.messageId)
      });
      scannedItemIds.add(itemId);
      const githubUrl = extractGithubUrl(`${normalized.content} ${normalized.summary}`);
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
      for (const message of allMessages) {
        itemIdsByMessageId.set(message.messageId, itemId);
      }
      if (isNew) {
        itemsNew += 1;
        newItemIds.add(itemId);
      } else {
        itemsReturning += 1;
      }
      const currentItem = getItem(itemId, interaction.guildId);
      const knownHandlerIds = new Set(baseKnownHandlerIds);
      if (currentItem?.assignee_id) {
        knownHandlerIds.add(currentItem.assignee_id);
      }
      const reply = detectHumanHandling(normalized, messagesByChannel, knownHandlerIds);
      if (reply) {
        updateHumanReply(itemId, reply.repliedAt, reply.replyUserId, reply.replyName, reply.replyText);
      }
    }

    recordScannedMessages(interaction.guildId, scanId, [...messagesToAnalyze, ...messagesSkippedAsVague], itemIdsByMessageId);
    updateChannelScanCursors(interaction.guildId, fetched.messages);
    logDebug("scan.cache.recorded", {
      scanId,
      guildId: interaction.guildId,
      analyzedMessages: messagesToAnalyze.length,
      skippedAsVague: messagesSkippedAsVague.length,
      linkedMessages: itemIdsByMessageId.size
    });

    const summary: Omit<ScanSummary, "id"> = {
      channelsScanned: fetched.channelsScanned,
      channelsSkipped: fetched.skippedChannels.length,
      messagesFetched: fetched.messages.length,
      messagesReused,
      messagesAnalyzed: messagesToAnalyze.length,
      batchesSkipped: analyzedResult.skippedBatches,
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
