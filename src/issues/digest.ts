import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type Message,
  type StringSelectMenuBuilder
} from "discord.js";
import type { ItemMessageRow, RenderedItem } from "../types";
import { logDebug, logError } from "../utils/logger";
import { extractGithubUrl, isWeakFollowUpText } from "../utils/text";
import { ageLabel } from "../utils/time";

const PAGE_SIZE = 5;
const WIDTH_PAD = "\u200b" + "\u00A0".repeat(42) + "\u200b";
const SESSION_TTL_MS = 60 * 60 * 1000;

type DigestRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;

interface DigestSessionMeta {
  mode: "scan" | "issues" | "resolved" | "snoozed";
  totalCount: number;
  newCount?: number;
  returningCount?: number;
  lookbackHours?: number;
  channelsScanned?: number;
  channelsSkipped?: number;
  messagesFetched?: number;
  messagesReused?: number;
  messagesAnalyzed?: number;
  batchesSkipped?: number;
}

interface DigestSession {
  id: string;
  guildId: string;
  channelId: string;
  itemIds: number[];
  page: number;
  createdAt: number;
  touchedAt: number;
  summaryMessageId?: string;
  cardMessageIds: string[];
  cardMessages: Array<Message | null>;
  bottomNavMessageId?: string;
  bottomNavMessage?: Message | null;
  meta: DigestSessionMeta;
}

const sessions = new Map<string, DigestSession>();

function pruneExpiredSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.touchedAt < cutoff) {
      sessions.delete(sessionId);
    }
  }
}

function pageItems(items: RenderedItem[], page: number): RenderedItem[] {
  return items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
}

function totalPages(items: RenderedItem[]): number {
  return Math.max(1, Math.ceil(items.length / PAGE_SIZE));
}

function channelLabel(guild: Guild | null, channelId: string): string {
  const channel = guild?.channels.cache.get(channelId);
  return channel && "name" in channel && channel.name ? channel.name : channelId;
}

function effectiveGithubUrl(item: RenderedItem): string | null {
  return item.github_url ?? extractGithubUrl(`${item.content_preview} ${item.summary}`);
}

function parseGithubReference(url: string | null): { repoLabel: string; refLabel: string } | null {
  if (!url) {
    return null;
  }
  const pullMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (pullMatch) {
    const [, owner, repo, prNumber] = pullMatch;
    const repoLabel = owner.toLowerCase() === "defillama" ? repo : `${owner}/${repo}`;
    return { repoLabel, refLabel: `#${prNumber}` };
  }
  const commitMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)/i);
  if (commitMatch) {
    const [, owner, repo, sha] = commitMatch;
    const repoLabel = owner.toLowerCase() === "defillama" ? repo : `${owner}/${repo}`;
    return { repoLabel, refLabel: `commit ${sha.slice(0, 7)}` };
  }
  return null;
}

function githubMetadataLines(item: RenderedItem): string[] {
  const parsed = item.github_repo_label && item.github_ref_label
    ? { repoLabel: item.github_repo_label, refLabel: item.github_ref_label }
    : parseGithubReference(effectiveGithubUrl(item));
  if (!parsed) {
    return [];
  }

  const lines: string[] = [];
  if (item.projectName) {
    lines.push(item.projectName);
  }

  lines.push(`${parsed.repoLabel} ${parsed.refLabel}`);

  const statusBits: string[] = [];
  if (item.github_status) {
    statusBits.push(item.github_status);
  }
  if (item.github_owner_hint) {
    statusBits.push(`${item.github_owner_hint} commented`);
  }
  if (item.github_assignee_hint) {
    statusBits.push(`assigned: ${item.github_assignee_hint}`);
  }
  if (item.github_last_activity_at) {
    statusBits.push(`updated ${ageLabel(item.github_last_activity_at)}`);
  }
  if (statusBits.length > 0) {
    lines.push(statusBits.join(" • "));
  }
  return lines;
}

function humanReplyLine(item: RenderedItem): string | null {
  if (!item.last_human_reply_at) {
    return null;
  }
  const actor = item.last_human_reply_user_id
    ? `<@${item.last_human_reply_user_id}>`
    : item.last_human_reply_name
      ? item.last_human_reply_name
      : "team";
  return `${actor} replied ${ageLabel(item.last_human_reply_at)}`;
}

function traceStateLine(item: RenderedItem): string | null {
  if (item.trace_state === "likely_handled") {
    return `Likely handled (${item.trace_state_confidence})`;
  }
  if (item.trace_state === "resolved_by_trace") {
    return `Resolved by trace (${item.trace_state_confidence})`;
  }
  if (item.trace_state === "unclear") {
    return `Trace unclear (${item.trace_state_confidence})`;
  }
  return null;
}

function traceAnswerLine(item: RenderedItem): string | null {
  if (!item.trace_answer_text) {
    return null;
  }
  const actor = item.trace_answer_author_name ? `${item.trace_answer_author_name}` : "team";
  return `${actor}: ${truncateForCard(item.trace_answer_text)}`;
}

export function renderIssuePage(items: RenderedItem[], page: number, title = "issues"): {
  embeds: EmbedBuilder[];
  components: DigestRow[];
} {
  const safePage = Math.min(page, totalPages(items) - 1);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(pageItems(items, safePage).map((item) => compactItemBlock(item)).join("\n\n") || "nothing here.")
    .setFooter({ text: `page ${safePage + 1}/${totalPages(items)}` });

  const components: DigestRow[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`nav-compact:prev:${safePage}`).setLabel("previous").setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
      new ButtonBuilder().setCustomId(`nav-compact:next:${safePage}`).setLabel("next").setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages(items) - 1)
    )
  ];

  return { embeds: [embed], components };
}

function compactItemBlock(item: RenderedItem): string {
  const lines = [
    `#${item.id} | ${item.category} | ${item.ageLabel}`,
    `<@${item.author_id}>: ${item.content_preview}`,
    item.trace_state !== "open" ? `trace: ${item.trace_state} (${item.trace_state_confidence})` : null,
    item.relatedCount > 0 ? `+${item.relatedCount} related messages` : null,
    item.assignee_id ? `assigned: <@${item.assignee_id}>` : "assigned: none"
  ];
  return lines.filter(Boolean).join("\n");
}

export function renderItemMessages(messages: ItemMessageRow[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("all messages")
    .setDescription(messages.map((message) => `- [${message.message_id}](${message.message_url}) by <@${message.author_id}>`).join("\n") || "none");
}

export function createDigestSession(args: {
  guildId: string;
  channelId: string;
  items: RenderedItem[];
  meta: DigestSessionMeta;
}): DigestSession {
  const session: DigestSession = {
    id: randomUUID().slice(0, 8),
    guildId: args.guildId,
    channelId: args.channelId,
    itemIds: args.items.map((item) => item.id),
    page: 0,
    createdAt: Date.now(),
    touchedAt: Date.now(),
    cardMessageIds: [],
    cardMessages: [],
    meta: args.meta
  };
  pruneExpiredSessions();
  sessions.set(session.id, session);
  return session;
}

export function getDigestSession(sessionId: string): DigestSession | undefined {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (session) {
    session.touchedAt = Date.now();
  }
  return session;
}

export function setDigestPage(sessionId: string, page: number): DigestSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) {
    return undefined;
  }
  session.page = Math.max(0, page);
  session.touchedAt = Date.now();
  return session;
}

export function bindSummaryMessage(sessionId: string, messageId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  session.summaryMessageId = messageId;
  session.touchedAt = Date.now();
}

export function summaryMessagePayload(session: DigestSession): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const total = session.itemIds.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(session.page, pages - 1);
  const title = session.meta.mode === "scan"
    ? `CRIA SCAN - ${session.meta.totalCount} items need attention`
    : session.meta.mode === "resolved"
      ? "CRIA - Recently Resolved"
      : session.meta.mode === "snoozed"
        ? `CRIA SNOOZED - ${session.meta.totalCount} snoozed items`
        : "CRIA - Current Outstanding";

  const lines = session.meta.mode === "scan"
    ? [
        `${session.meta.newCount ?? 0} new / ${session.meta.returningCount ?? 0} returning`,
        `${session.meta.lookbackHours ?? 24}h lookback - ${session.meta.channelsScanned ?? 0} channels - ${(session.meta.messagesFetched ?? 0).toLocaleString()} messages`,
        (session.meta.channelsSkipped ?? 0) > 0 ? `skipped ${session.meta.channelsSkipped} channels` : null,
        `${(session.meta.messagesReused ?? 0).toLocaleString()} reused / ${(session.meta.messagesAnalyzed ?? 0).toLocaleString()} analyzed`,
        (session.meta.batchesSkipped ?? 0) > 0 ? `skipped ${session.meta.batchesSkipped} failed batches` : null,
        `Page ${safePage + 1} of ${pages}`
      ].filter(Boolean) as string[]
    : [
        session.meta.mode === "resolved"
          ? `${session.meta.totalCount} total resolved items`
          : session.meta.mode === "snoozed"
            ? `${session.meta.totalCount} total snoozed`
            : `${session.meta.totalCount} total open items`,
        `Page ${safePage + 1} of ${pages}`
      ];

  const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join("\n"));
  return { embeds: [embed], components: [] };
}

export function itemCardPayload(item: RenderedItem, guild: Guild | null): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const channel = channelLabel(guild, item.channel_id);
  const preview = truncateForCard(preferredPreview(item));
  const isResolved = item.status === "resolved";
  const resolvedColor = 0x2d7d46;
  const githubUrl = effectiveGithubUrl(item);
  const githubLines = githubMetadataLines(item);
  const bodyLines = isResolved
    ? [`<@${item.author_id}> in #${channel} -- ${preview}`]
    : [`<@${item.author_id}> in #${channel}`];

  if (!isResolved && githubLines.length > 0) {
    bodyLines.push("", ...githubLines, "", preview);
  } else if (!isResolved) {
    bodyLines.push("", preview);
  }

  if (item.relatedCount > 0) {
    if (isResolved) {
      bodyLines.push(`+${item.relatedCount} related messages`);
    } else {
      bodyLines.push("", `+${item.relatedCount} related messages`);
    }
  }

  const handledLine = !isResolved ? humanReplyLine(item) : null;
  const traceLine = !isResolved ? traceStateLine(item) : null;
  const traceAnswer = !isResolved ? traceAnswerLine(item) : null;
  if (handledLine) {
    bodyLines.push("", handledLine);
  }
  if (traceLine) {
    bodyLines.push("", traceLine);
  }
  if (traceAnswer) {
    bodyLines.push("", traceAnswer);
  }

  if (!isResolved && item.assignee_id) {
    bodyLines.push("", `Assigned: <@${item.assignee_id}>`);
  }

  bodyLines.push("", `#${item.id}`);
  bodyLines.push("", WIDTH_PAD);

  const header = isResolved
    ? `**${item.category} | Resolved | ${item.ageLabel}**`
    : `**${item.category} | ${item.ageLabel}**`;

  const embed = new EmbedBuilder()
    .setColor(isResolved ? resolvedColor : item.categoryColor)
    .setDescription(`${header}\n\n${bodyLines.join("\n")}`);

  const buttons: ButtonBuilder[] = [];
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (isResolved) {
    buttons.push(new ButtonBuilder().setCustomId(`reopen:${item.id}`).setLabel("reopen").setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setURL(item.message_url).setLabel("jump").setStyle(ButtonStyle.Link));
    if (githubUrl) {
      buttons.push(new ButtonBuilder().setURL(githubUrl).setLabel("github").setStyle(ButtonStyle.Link));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  } else if (item.status === "snoozed") {
    buttons.push(new ButtonBuilder().setCustomId(`unsnooze:${item.id}`).setLabel("unsnooze").setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setURL(item.message_url).setLabel("jump").setStyle(ButtonStyle.Link));
    if (githubUrl) {
      buttons.push(new ButtonBuilder().setURL(githubUrl).setLabel("github").setStyle(ButtonStyle.Link));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  } else {
    buttons.push(
      new ButtonBuilder().setCustomId(`assign:${item.id}`).setLabel(item.assignee_id ? "reassign" : "assign").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`resolve:${item.id}`).setLabel("resolve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`category:${item.id}`).setLabel("category").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`snooze:${item.id}`).setLabel("snooze").setStyle(ButtonStyle.Secondary)
    );
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    const linkButtons = [
      new ButtonBuilder().setURL(item.message_url).setLabel("jump").setStyle(ButtonStyle.Link)
    ];
    if (githubUrl) {
      linkButtons.push(new ButtonBuilder().setURL(githubUrl).setLabel("github").setStyle(ButtonStyle.Link));
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(linkButtons));
  }

  return {
    embeds: [embed],
    components
  };
}

function preferredPreview(item: RenderedItem): string {
  const content = item.content_preview.replace(/\s+/g, " ").trim();
  const summary = item.summary.replace(/\s+/g, " ").trim();
  if (!content) {
    return summary || content;
  }
  if (!summary) {
    return content;
  }

  return isWeakFollowUpText(content) ? summary : content;
}

function truncateForCard(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 120) {
    return clean;
  }
  return `${clean.slice(0, 117).trimEnd()}...`;
}
function bottomNavPayload(session: DigestSession): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const total = session.itemIds.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(session.page, pages - 1);
  return {
    content: `Page ${safePage + 1} of ${pages}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`nav-public:prev:${session.id}`)
          .setLabel("< previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(`nav-public:next:${session.id}`)
          .setLabel("next >")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= pages - 1)
      )
    ]
  };
}

export async function replaceSessionCards(args: {
  session: DigestSession;
  items: RenderedItem[];
  channel: {
    send(options: { content?: string; embeds?: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }): Promise<Message>;
    messages: { fetch(id: string): Promise<Message> };
  };
  guild: Guild | null;
}): Promise<void> {
  logDebug("digest.replace_cards.start", {
    sessionId: args.session.id,
    mode: args.session.meta.mode,
    page: args.session.page,
    itemIds: args.session.itemIds,
    summaryMessageId: args.session.summaryMessageId,
    cardMessageIds: args.session.cardMessageIds,
    bottomNavMessageId: args.session.bottomNavMessageId,
    channelId: args.session.channelId
  });
  args.session.touchedAt = Date.now();
  const cards = pageItems(args.items, args.session.page);
  const nextCardMessageIds: string[] = [];
  const nextCardMessages: Array<Message | null> = [];
  for (let index = 0; index < cards.length; index += 1) {
    const item = cards[index];
    const existingMessageId = args.session.cardMessageIds[index];
    const cachedMessage = args.session.cardMessages[index];
    const existingMessage = cachedMessage && cachedMessage.id === existingMessageId
      ? cachedMessage
      : existingMessageId
        ? await args.channel.messages.fetch(existingMessageId).catch(() => null)
        : null;

    if (existingMessage) {
      logDebug("digest.card.edit.start", {
        sessionId: args.session.id,
        itemId: item.id,
        page: args.session.page,
        cardMessageId: existingMessage.id
      });
      await existingMessage.edit(itemCardPayload(item, args.guild)).catch((error) => {
        logError("digest.card.edit.failed", error, {
          sessionId: args.session.id,
          itemId: item.id,
          cardMessageId: existingMessage.id
        });
        return undefined;
      });
      logDebug("digest.card.edit.success", {
        sessionId: args.session.id,
        itemId: item.id,
        page: args.session.page,
        cardMessageId: existingMessage.id
      });
      nextCardMessageIds.push(existingMessage.id);
      nextCardMessages.push(existingMessage);
      continue;
    }

    logDebug("digest.card.send.start", {
      sessionId: args.session.id,
      itemId: item.id,
      page: args.session.page,
      channelId: args.session.channelId
    });
    const message = await args.channel.send(itemCardPayload(item, args.guild));
    logDebug("digest.card.send.success", {
      sessionId: args.session.id,
      itemId: item.id,
      cardMessageId: message.id,
      page: args.session.page
    });
    nextCardMessageIds.push(message.id);
    nextCardMessages.push(message);
  }

  for (const staleMessageId of args.session.cardMessageIds.slice(cards.length)) {
    const staleMessage = await args.channel.messages.fetch(staleMessageId).catch(() => null);
    if (!staleMessage) {
      logDebug("digest.card.delete.missing", { sessionId: args.session.id, messageId: staleMessageId });
      continue;
    }
    logDebug("digest.card.delete.start", { sessionId: args.session.id, messageId: staleMessageId });
    await staleMessage.delete().catch((error) => {
      logError("digest.card.delete.failed", error, { sessionId: args.session.id, messageId: staleMessageId });
      return undefined;
    });
  }
  args.session.cardMessageIds = nextCardMessageIds;
  args.session.cardMessages = nextCardMessages;

  const totalPagesForSession = Math.max(1, Math.ceil(args.session.itemIds.length / PAGE_SIZE));
  if (totalPagesForSession <= 1) {
    if (args.session.bottomNavMessageId) {
      const cachedNav = args.session.bottomNavMessage && args.session.bottomNavMessage.id === args.session.bottomNavMessageId
        ? args.session.bottomNavMessage
        : null;
      const message = cachedNav ?? await args.channel.messages.fetch(args.session.bottomNavMessageId).catch(() => null);
      if (message) {
        logDebug("digest.bottom_nav.delete.start", { sessionId: args.session.id, messageId: args.session.bottomNavMessageId });
        await message.delete().catch((error) => {
          logError("digest.bottom_nav.delete.failed", error, { sessionId: args.session.id, messageId: args.session.bottomNavMessageId });
          return undefined;
        });
      }
      args.session.bottomNavMessageId = undefined;
      args.session.bottomNavMessage = null;
    }
    logDebug("digest.bottom_nav.skipped", {
      sessionId: args.session.id,
      page: args.session.page,
      pages: totalPagesForSession
    });
    return;
  }

  if (args.session.bottomNavMessageId) {
    const cachedNav = args.session.bottomNavMessage && args.session.bottomNavMessage.id === args.session.bottomNavMessageId
      ? args.session.bottomNavMessage
      : null;
    const navMessage = cachedNav ?? await args.channel.messages.fetch(args.session.bottomNavMessageId).catch(() => null);
    if (navMessage) {
      logDebug("digest.bottom_nav.edit.start", {
        sessionId: args.session.id,
        messageId: navMessage.id,
        page: args.session.page,
        pages: totalPagesForSession
      });
      await navMessage.edit(bottomNavPayload(args.session)).catch((error) => {
        logError("digest.bottom_nav.edit.failed", error, {
          sessionId: args.session.id,
          messageId: navMessage.id
        });
        return undefined;
      });
      logDebug("digest.bottom_nav.edit.success", {
        sessionId: args.session.id,
        messageId: navMessage.id,
        page: args.session.page
      });
      args.session.bottomNavMessage = navMessage;
      return;
    }
    args.session.bottomNavMessageId = undefined;
    args.session.bottomNavMessage = null;
  }

  logDebug("digest.bottom_nav.send.start", {
    sessionId: args.session.id,
    page: args.session.page,
    pages: totalPagesForSession
  });
  const navMessage = await args.channel.send(bottomNavPayload(args.session));
  args.session.bottomNavMessageId = navMessage.id;
  args.session.bottomNavMessage = navMessage;
  logDebug("digest.bottom_nav.send.success", {
    sessionId: args.session.id,
    messageId: navMessage.id,
    page: args.session.page
  });
}
