import { db } from "../db/client";
import { writeAuditLog } from "../db/audit";
import type {
  ChatClassification,
  ChatConfidence,
  Category,
  CategoryRow,
  ChannelScanCursorRow,
  ChatEngagementRow,
  FetchedMessage,
  GithubEnrichment,
  ItemMessageRow,
  ItemRow,
  NormalizedIssueInput,
  RenderedItem,
  ScannedMessageRow,
  ScanSummary,
  Urgency
} from "../types";
import { ageLabel } from "../utils/time";
import { contentFingerprint, extractGithubPullKey, extractGithubUrl, extractProjectName, extractReference, fingerprint, sharedTokenCount, preview, isWeakFollowUpText } from "../utils/text";

const BUILTIN_CATEGORIES: Array<{ name: string; color: number }> = [
  { name: "listing", color: 0xfee75c },
  { name: "tvl", color: 0xed4245 },
  { name: "yields", color: 0xf39c12 },
  { name: "fees_volume", color: 0xe67e22 },
  { name: "emissions", color: 0x9b59b6 },
  { name: "ui", color: 0x3498db },
  { name: "partnerships", color: 0xf1c40f },
  { name: "ai", color: 0x5865f2 },
  { name: "indexer", color: 0x1abc9c },
  { name: "llamaswap", color: 0x2ecc71 },
  { name: "general", color: 0x95a5a6 }
];

const initializedGuildCategories = new Set<string>();

function normalizeCategoryName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!normalized) {
    throw new Error("invalid category name");
  }
  return normalized;
}

function autoCategoryColor(name: string): number {
  const builtIn = BUILTIN_CATEGORIES.find((category) => category.name === name);
  if (builtIn) {
    return builtIn.color;
  }
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const palette = [0x7289da, 0x2ecc71, 0xe67e22, 0x1abc9c, 0x3498db, 0x9b59b6, 0xf1c40f, 0xe91e63];
  return palette[hash % palette.length];
}

function ensureGuildCategories(guildId: string): void {
  if (initializedGuildCategories.has(guildId)) {
    return;
  }
  const insert = db.query(
    `INSERT INTO categories (guild_id, name, color, active)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(guild_id, name) DO UPDATE SET color = excluded.color`
  );
  for (const category of BUILTIN_CATEGORIES) {
    insert.run(guildId, category.name, category.color);
  }
  initializedGuildCategories.add(guildId);
}

function resolveExistingCategoryName(guildId: string, category: string): string | null {
  const normalized = normalizeCategoryName(category);
  const row = db.query(`SELECT name FROM categories WHERE guild_id = ? AND name = ? AND active = 1`).get(guildId, normalized) as
    | { name: string }
    | null;
  return row?.name ?? null;
}

function primaryCategoryAssignee(guildId: string, category: string): { userId: string | null; userName: string | null } {
  const row = db.query(
    `SELECT user_id, user_name
       FROM category_assignees
      WHERE guild_id = ? AND category_name = ?
      ORDER BY created_at ASC
      LIMIT 1`
  ).get(guildId, category) as { user_id: string; user_name: string } | null;
  if (!row) {
    return { userId: null, userName: null };
  }
  return { userId: row.user_id, userName: row.user_name };
}

function rowToItem(row: Record<string, unknown>): ItemRow {
  const requiredString = (key: keyof ItemRow): string => {
    const value = row[key as string];
    if (typeof value !== "string") {
      throw new Error(`invalid item row: ${String(key)}`);
    }
    return value;
  };
  const optionalString = (key: keyof ItemRow): string | null => {
    const value = row[key as string];
    return typeof value === "string" ? value : null;
  };
  const requiredNumber = (key: keyof ItemRow): number => {
    const value = row[key as string];
    if (typeof value !== "number") {
      throw new Error(`invalid item row: ${String(key)}`);
    }
    return value;
  };
  return {
    id: requiredNumber("id"),
    guild_id: requiredString("guild_id"),
    channel_id: requiredString("channel_id"),
    message_id: requiredString("message_id"),
    message_url: requiredString("message_url"),
    github_url: optionalString("github_url"),
    github_repo_label: optionalString("github_repo_label"),
    github_ref_label: optionalString("github_ref_label"),
    github_status: optionalString("github_status"),
    github_last_activity_at: optionalString("github_last_activity_at"),
    github_synced_at: optionalString("github_synced_at"),
    github_owner_hint: optionalString("github_owner_hint"),
    github_assignee_hint: optionalString("github_assignee_hint"),
    author_id: requiredString("author_id"),
    author_name: requiredString("author_name"),
    content_preview: requiredString("content_preview"),
    summary: requiredString("summary"),
    category: requiredString("category"),
    urgency: requiredString("urgency") as Urgency,
    status: requiredString("status") as ItemRow["status"],
    assignee_id: optionalString("assignee_id"),
    assignee_name: optionalString("assignee_name"),
    source_message_created_at: optionalString("source_message_created_at"),
    created_at: requiredString("created_at"),
    updated_at: requiredString("updated_at"),
    resolved_at: optionalString("resolved_at"),
    resolved_by: optionalString("resolved_by"),
    snooze_until: optionalString("snooze_until"),
    snoozed_by: optionalString("snoozed_by"),
    last_human_reply_at: optionalString("last_human_reply_at"),
    last_human_reply_user_id: optionalString("last_human_reply_user_id"),
    last_human_reply_name: optionalString("last_human_reply_name"),
    scan_id: typeof row.scan_id === "number" ? row.scan_id : null
  };
}

function detectGithubUrlFromMessages(messages: FetchedMessage[]): string | null {
  for (const message of messages) {
    const found = extractGithubUrl(message.content);
    if (found) {
      return found;
    }
  }
  return null;
}

function canonicalTopicText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function likelySameTopic(left: string, right: string): boolean {
  const leftPull = extractGithubPullKey(left);
  const rightPull = extractGithubPullKey(right);
  if (leftPull && rightPull && leftPull === rightPull) {
    return true;
  }
  const leftRef = extractReference(left);
  const rightRef = extractReference(right);
  if (leftRef && rightRef && leftRef === rightRef) {
    return true;
  }

  const overlap = sharedTokenCount(left, right);
  if (overlap >= 4) {
    return true;
  }

  const normalizedLeft = canonicalTopicText(left);
  const normalizedRight = canonicalTopicText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function getGuildLookback(guildId: string, fallback: number): number {
  const row = db.query(`SELECT default_lookback_hours FROM guild_config WHERE guild_id = ?`).get(guildId) as
    | { default_lookback_hours: number }
    | null;
  return row?.default_lookback_hours ?? fallback;
}

function normalizeExpiredSnoozes(guildId: string): void {
  db.query(
    `UPDATE items
        SET status = 'open',
            snooze_until = NULL,
            snoozed_by = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
        AND status = 'snoozed'
        AND snooze_until IS NOT NULL
        AND datetime(snooze_until) <= datetime('now')`
  ).run(guildId);
}

function activeIgnoreRule(guildId: string, authorId: string, category: string, valueFingerprint: string): boolean {
  const row = db.query(
    `SELECT 1
       FROM ignore_rules
      WHERE guild_id = ?
        AND author_id = ?
        AND category = ?
        AND fingerprint = ?
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
      LIMIT 1`
  ).get(guildId, authorId, category, valueFingerprint) as { 1: number } | null;
  return Boolean(row);
}

export function getScanEmissionsChannelId(guildId: string): string | null {
  const row = db.query(`SELECT scan_emissions_channel_id FROM guild_config WHERE guild_id = ?`).get(guildId) as
    | { scan_emissions_channel_id: string | null }
    | null;
  return row?.scan_emissions_channel_id ?? null;
}

export function listCategories(guildId: string): CategoryRow[] {
  ensureGuildCategories(guildId);
  return db
    .query(`SELECT * FROM categories WHERE guild_id = ? AND active = 1 ORDER BY CASE WHEN name = 'general' THEN 1 ELSE 0 END, name ASC`)
    .all(guildId) as CategoryRow[];
}

export function getActiveCategoryNames(guildId: string): string[] {
  return listCategories(guildId).map((category) => category.name);
}

export function addCategory(guildId: string, name: string, actorId: string, actorName: string): string {
  ensureGuildCategories(guildId);
  const normalized = normalizeCategoryName(name);
  db.query(
    `INSERT INTO categories (guild_id, name, color, active)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(guild_id, name) DO UPDATE SET active = 1, updated_at = CURRENT_TIMESTAMP`
  ).run(guildId, normalized, autoCategoryColor(normalized));
  writeAuditLog({ guildId, actorId, actorName, action: "category_add", target: normalized });
  return normalized;
}

export function renameCategory(guildId: string, oldName: string, newName: string, actorId: string, actorName: string): { from: string; to: string } {
  ensureGuildCategories(guildId);
  const from = resolveExistingCategoryName(guildId, oldName);
  if (!from) {
    throw new Error("category not found");
  }
  if (from === "general") {
    throw new Error("general cannot be renamed");
  }
  const to = normalizeCategoryName(newName);
  db.query(`INSERT INTO categories (guild_id, name, color, active) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, name) DO UPDATE SET active = 1, updated_at = CURRENT_TIMESTAMP`)
    .run(guildId, to, autoCategoryColor(to));
  db.query(`UPDATE items SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND category = ?`).run(to, guildId, from);
  db.query(`UPDATE category_assignees SET category_name = ? WHERE guild_id = ? AND category_name = ?`).run(to, guildId, from);
  db.query(`UPDATE categories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND name = ?`).run(guildId, from);
  writeAuditLog({ guildId, actorId, actorName, action: "category_rename", target: from, details: { to } });
  return { from, to };
}

export function removeCategory(guildId: string, name: string, actorId: string, actorName: string): string {
  ensureGuildCategories(guildId);
  const normalized = resolveExistingCategoryName(guildId, name);
  if (!normalized) {
    throw new Error("category not found");
  }
  if (normalized === "general") {
    throw new Error("general cannot be removed");
  }
  db.query(`UPDATE items SET category = 'general', updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND category = ?`).run(guildId, normalized);
  db.query(`DELETE FROM category_assignees WHERE guild_id = ? AND category_name = ?`).run(guildId, normalized);
  db.query(`UPDATE categories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND name = ?`).run(guildId, normalized);
  writeAuditLog({ guildId, actorId, actorName, action: "category_remove", target: normalized });
  return normalized;
}

export function listCategoryAssignees(guildId: string, name: string): { user_id: string; user_name: string }[] {
  ensureGuildCategories(guildId);
  const normalized = resolveExistingCategoryName(guildId, name);
  if (!normalized) {
    throw new Error("category not found");
  }
  return db
    .query(`SELECT user_id, user_name FROM category_assignees WHERE guild_id = ? AND category_name = ? ORDER BY created_at ASC`)
    .all(guildId, normalized) as { user_id: string; user_name: string }[];
}

export function listAllCategoryAssigneeIds(guildId: string): string[] {
  return (
    db.query(`SELECT DISTINCT user_id FROM category_assignees WHERE guild_id = ? ORDER BY created_at ASC`).all(guildId) as {
      user_id: string;
    }[]
  ).map((row) => row.user_id);
}

export function addCategoryAssignee(
  guildId: string,
  name: string,
  userId: string,
  userName: string,
  actorId: string,
  actorName: string
): string {
  ensureGuildCategories(guildId);
  const normalized = resolveExistingCategoryName(guildId, name);
  if (!normalized) {
    throw new Error("category not found");
  }
  db.query(
    `INSERT OR IGNORE INTO category_assignees (guild_id, category_name, user_id, user_name)
     VALUES (?, ?, ?, ?)`
  ).run(guildId, normalized, userId, userName);
  writeAuditLog({ guildId, actorId, actorName, action: "category_assignee_add", target: normalized, details: { userId, userName } });
  return normalized;
}

export function removeCategoryAssignee(
  guildId: string,
  name: string,
  userId: string,
  actorId: string,
  actorName: string
): string {
  ensureGuildCategories(guildId);
  const normalized = resolveExistingCategoryName(guildId, name);
  if (!normalized) {
    throw new Error("category not found");
  }
  db.query(`DELETE FROM category_assignees WHERE guild_id = ? AND category_name = ? AND user_id = ?`).run(guildId, normalized, userId);
  writeAuditLog({ guildId, actorId, actorName, action: "category_assignee_remove", target: normalized, details: { userId } });
  return normalized;
}

export function upsertGuildConfig(guildId: string, hours: number): void {
  db.query(
    `INSERT INTO guild_config (guild_id, default_lookback_hours)
     VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET default_lookback_hours = excluded.default_lookback_hours`
  ).run(guildId, hours);
}

export function setScanEmissionsChannel(guildId: string, channelId: string): void {
  db.query(
    `INSERT INTO guild_config (guild_id, default_lookback_hours, scan_emissions_channel_id)
     VALUES (?, 24, ?)
     ON CONFLICT(guild_id) DO UPDATE SET scan_emissions_channel_id = excluded.scan_emissions_channel_id`
  ).run(guildId, channelId);
}

export function clearScanEmissionsChannel(guildId: string): void {
  db.query(`INSERT INTO guild_config (guild_id, default_lookback_hours, scan_emissions_channel_id)
            VALUES (?, 24, NULL)
            ON CONFLICT(guild_id) DO UPDATE SET scan_emissions_channel_id = NULL`).run(guildId);
}

export function isChatEnabled(guildId: string): boolean {
  const row = db.query(`SELECT chat_enabled FROM guild_config WHERE guild_id = ?`).get(guildId) as
    | { chat_enabled: number }
    | null;
  return Boolean(row?.chat_enabled);
}

export function setChatEnabled(guildId: string, enabled: boolean): void {
  db.query(
    `INSERT INTO guild_config (guild_id, default_lookback_hours, chat_enabled)
     VALUES (?, 24, ?)
     ON CONFLICT(guild_id) DO UPDATE SET chat_enabled = excluded.chat_enabled`
  ).run(guildId, enabled ? 1 : 0);
}

export function addChatChannel(guildId: string, channelId: string): void {
  db.query(`INSERT OR IGNORE INTO chat_channels (guild_id, channel_id) VALUES (?, ?)`).run(guildId, channelId);
}

export function removeChatChannel(guildId: string, channelId: string): void {
  db.query(`DELETE FROM chat_channels WHERE guild_id = ? AND channel_id = ?`).run(guildId, channelId);
}

export function listChatChannels(guildId: string): string[] {
  return (db.query(`SELECT channel_id FROM chat_channels WHERE guild_id = ? ORDER BY created_at ASC`).all(guildId) as { channel_id: string }[]).map(
    (row) => row.channel_id
  );
}

export function recordChatEngagement(args: {
  guildId: string;
  channelId: string;
  userId: string;
  userMessageId: string;
  botReplyMessageId: string;
  anchorMessageId?: string | null;
  conversationKey: string;
  classification: ChatClassification;
  confidence: ChatConfidence;
  needsClarification: boolean;
}): void {
  db.query(
    `INSERT INTO chat_engagements (
        guild_id,
        channel_id,
        user_id,
        user_message_id,
        bot_reply_message_id,
        anchor_message_id,
        conversation_key,
        classification,
        confidence,
        needs_clarification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_message_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        user_id = excluded.user_id,
        bot_reply_message_id = excluded.bot_reply_message_id,
        anchor_message_id = excluded.anchor_message_id,
        conversation_key = excluded.conversation_key,
        classification = excluded.classification,
        confidence = excluded.confidence,
        needs_clarification = excluded.needs_clarification`
  ).run(
    args.guildId,
    args.channelId,
    args.userId,
    args.userMessageId,
    args.botReplyMessageId,
    args.anchorMessageId ?? null,
    args.conversationKey,
    args.classification,
    args.confidence,
    args.needsClarification ? 1 : 0
  );
}

export function findChatEngagementByBotReply(guildId: string, botReplyMessageId: string): {
  userMessageId: string;
  classification: ChatClassification;
  confidence: ChatConfidence;
  needsClarification: boolean;
} | null {
  const row = db.query(
    `SELECT user_message_id, classification, confidence, needs_clarification
       FROM chat_engagements
      WHERE guild_id = ? AND bot_reply_message_id = ?
      LIMIT 1`
  ).get(guildId, botReplyMessageId) as {
    user_message_id: string;
    classification: ChatClassification;
    confidence: ChatConfidence;
    needs_clarification: number;
  } | null;

  if (!row) {
    return null;
  }

  return {
    userMessageId: row.user_message_id,
    classification: row.classification,
    confidence: row.confidence,
    needsClarification: row.needs_clarification === 1
  };
}

export function getSkippableChatEngagedMessageIds(guildId: string, messageIds: string[]): Set<string> {
  if (messageIds.length === 0) {
    return new Set();
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT user_message_id, bot_reply_message_id, anchor_message_id
       FROM chat_engagements
      WHERE guild_id = ?
        AND needs_clarification = 0
        AND confidence IN ('high', 'medium')
        AND classification IN ('out_of_scope')
        AND (
          user_message_id IN (${placeholders})
          OR bot_reply_message_id IN (${placeholders})
          OR anchor_message_id IN (${placeholders})
        )`
  ).all(guildId, ...messageIds, ...messageIds, ...messageIds) as Array<{
    user_message_id: string;
    bot_reply_message_id: string;
    anchor_message_id: string | null;
  }>;

  const engaged = new Set<string>();
  for (const row of rows) {
    engaged.add(row.user_message_id);
    engaged.add(row.bot_reply_message_id);
    if (row.anchor_message_id) {
      engaged.add(row.anchor_message_id);
    }
  }
  return engaged;
}

export function findChatConversation(guildId: string, messageIds: string[]): { conversationKey: string | null; botReplyCount: number } {
  if (messageIds.length === 0) {
    return { conversationKey: null, botReplyCount: 0 };
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  const row = db.query(
    `SELECT conversation_key
       FROM chat_engagements
      WHERE guild_id = ?
        AND (
          user_message_id IN (${placeholders})
          OR bot_reply_message_id IN (${placeholders})
          OR anchor_message_id IN (${placeholders})
        )
      ORDER BY created_at DESC
      LIMIT 1`
  ).get(guildId, ...messageIds, ...messageIds, ...messageIds) as { conversation_key: string | null } | null;

  if (!row?.conversation_key) {
    return { conversationKey: null, botReplyCount: 0 };
  }

  const count = db.query(
    `SELECT COUNT(*) AS count
       FROM chat_engagements
      WHERE guild_id = ? AND conversation_key = ?`
  ).get(guildId, row.conversation_key) as { count: number };

  return {
    conversationKey: row.conversation_key,
    botReplyCount: Number(count.count)
  };
}

export function createScan(guildId: string, triggeredBy: string, lookbackHours: number): number {
  db.query(
    `INSERT INTO scans (guild_id, triggered_by, lookback_hours, channels_scanned, messages_fetched, messages_reused, messages_analyzed, items_found, items_new, items_returning)
     VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0)`
  ).run(guildId, triggeredBy, lookbackHours);
  const row = db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return row.id;
}

export function finalizeScan(scanId: number, summary: Omit<ScanSummary, "id">): void {
  db.query(
    `UPDATE scans
       SET channels_scanned = ?,
           messages_fetched = ?,
           messages_reused = ?,
           messages_analyzed = ?,
           items_found = ?,
           items_new = ?,
           items_returning = ?,
           completed_at = CURRENT_TIMESTAMP,
           status = 'complete'
     WHERE id = ?`
  ).run(
    summary.channelsScanned,
    summary.messagesFetched,
    summary.messagesReused,
    summary.messagesAnalyzed,
    summary.itemsFound,
    summary.itemsNew,
    summary.itemsReturning,
    scanId
  );
}

export function getScannedMessages(guildId: string, messageIds: string[]): Map<string, ScannedMessageRow> {
  const output = new Map<string, ScannedMessageRow>();
  if (messageIds.length === 0) {
    return output;
  }
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT *
       FROM scanned_messages
      WHERE guild_id = ?
        AND message_id IN (${placeholders})`
  ).all(guildId, ...messageIds) as ScannedMessageRow[];
  for (const row of rows) {
    output.set(row.message_id, row);
  }
  return output;
}

export function getChannelScanCursors(guildId: string, channelIds: string[]): Map<string, ChannelScanCursorRow> {
  const output = new Map<string, ChannelScanCursorRow>();
  if (channelIds.length === 0) {
    return output;
  }
  const placeholders = channelIds.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT guild_id, channel_id, latest_message_id, latest_message_created_at, updated_at
       FROM channel_scan_cursors
      WHERE guild_id = ?
        AND channel_id IN (${placeholders})`
  ).all(guildId, ...channelIds) as ChannelScanCursorRow[];
  for (const row of rows) {
    output.set(row.channel_id, row);
  }
  return output;
}

export function updateChannelScanCursors(guildId: string, messages: FetchedMessage[]): void {
  if (messages.length === 0) {
    return;
  }
  const latestByChannel = new Map<string, FetchedMessage>();
  for (const message of messages) {
    const existing = latestByChannel.get(message.channelId);
    if (!existing || existing.createdAt < message.createdAt) {
      latestByChannel.set(message.channelId, message);
    }
  }
  const stmt = db.query(
    `INSERT INTO channel_scan_cursors (guild_id, channel_id, latest_message_id, latest_message_created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(guild_id, channel_id) DO UPDATE SET
       latest_message_id = excluded.latest_message_id,
       latest_message_created_at = excluded.latest_message_created_at,
       updated_at = CURRENT_TIMESTAMP`
  );
  for (const latest of latestByChannel.values()) {
    stmt.run(guildId, latest.channelId, latest.messageId, latest.createdAt);
  }
}

export function recordScannedMessages(
  guildId: string,
  scanId: number,
  messages: FetchedMessage[],
  itemIdsByMessageId: Map<string, number>
): void {
  if (messages.length === 0) {
    return;
  }
  const stmt = db.query(
    `INSERT INTO scanned_messages
      (guild_id, channel_id, message_id, message_url, author_id, author_name, source_message_created_at, content_fingerprint, last_scan_id, last_analyzed_at, classification_state, item_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(message_id) DO UPDATE SET
       channel_id = excluded.channel_id,
       message_url = excluded.message_url,
       author_id = excluded.author_id,
       author_name = excluded.author_name,
       source_message_created_at = excluded.source_message_created_at,
       content_fingerprint = excluded.content_fingerprint,
       last_scan_id = excluded.last_scan_id,
       last_analyzed_at = CURRENT_TIMESTAMP,
       classification_state = excluded.classification_state,
       item_id = excluded.item_id,
       updated_at = CURRENT_TIMESTAMP`
  );
  for (const message of messages) {
    const itemId = itemIdsByMessageId.get(message.messageId) ?? null;
    stmt.run(
      guildId,
      message.channelId,
      message.messageId,
      message.messageUrl,
      message.authorId,
      message.authorName,
      message.createdAt,
      contentFingerprint(message.content),
      scanId,
      itemId ? "item" : "noise",
      itemId
    );
  }
}

export function failScan(scanId: number): void {
  db.query(`UPDATE scans SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(scanId);
}

export function recoverStaleScans(staleMinutes: number): number {
  const result = db.query(
    `UPDATE scans
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND datetime(started_at) <= datetime('now', ?)`
  ).run(`-${staleMinutes} minutes`) as { changes?: number };
  return Number(result.changes ?? 0);
}

function findDuplicateItem(input: NormalizedIssueInput): ItemRow | null {
  const recent = db.query(
    `SELECT *
       FROM items
      WHERE guild_id = ?
        AND status = 'open'
        AND datetime(created_at) >= datetime('now', '-7 days')
      ORDER BY created_at DESC`
  ).all(input.guildId) as Record<string, unknown>[];

  for (const row of recent.map(rowToItem)) {
    const sameAuthor = row.author_id === input.authorId;
    const samePull = Boolean(
      extractGithubPullKey(`${input.summary} ${input.content}`)
      && extractGithubPullKey(`${input.summary} ${input.content}`) === extractGithubPullKey(`${row.summary} ${row.content_preview} ${row.github_url ?? ""}`)
    );
    if (!sameAuthor && !samePull) {
      continue;
    }
    if (!samePull && row.category !== input.category) {
      continue;
    }
    if (likelySameTopic(`${input.summary} ${input.content}`, `${row.summary} ${row.content_preview} ${row.github_url ?? ""}`)) {
      return row;
    }
  }
  return null;
}

function attachMessages(itemId: number, messages: FetchedMessage[]): void {
  const stmt = db.query(
    `INSERT OR IGNORE INTO item_messages
       (item_id, guild_id, channel_id, message_id, message_url, author_id, author_name, content_preview, source_message_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const message of messages) {
    stmt.run(
      itemId,
      message.guildId,
      message.channelId,
      message.messageId,
      message.messageUrl,
      message.authorId,
      message.authorName,
      preview(message.content),
      message.createdAt
    );
  }
}

export function upsertIssue(input: NormalizedIssueInput): { itemId: number; isNew: boolean } {
  ensureGuildCategories(input.guildId);
  const githubUrl = detectGithubUrlFromMessages(input.allMessages) ?? extractGithubUrl(input.content);
  const existingByMessage = db.query(
    `SELECT items.*
       FROM item_messages
       JOIN items ON items.id = item_messages.item_id
      WHERE item_messages.message_id = ?
      LIMIT 1`
  ).get(input.messageId) as Record<string, unknown> | null;

  if (existingByMessage) {
    const existingId = (existingByMessage as { id: number }).id;
    const category = resolveExistingCategoryName(input.guildId, input.category) ?? "general";
    const existing = rowToItem(existingByMessage);
    const fallbackAssignee = !existing.assignee_id
      ? (input.assigneeId
          ? { userId: input.assigneeId, userName: input.assigneeName ?? null }
          : primaryCategoryAssignee(input.guildId, category))
      : { userId: existing.assignee_id, userName: existing.assignee_name };
    db.query(
      `UPDATE items
          SET content_preview = ?,
              summary = ?,
              category = ?,
              urgency = ?,
              assignee_id = ?,
              assignee_name = ?,
              github_url = COALESCE(?, github_url),
              source_message_created_at = ?,
              scan_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(
      preview(input.content),
      input.summary,
      category,
      input.urgency,
      fallbackAssignee.userId ?? null,
      fallbackAssignee.userName ?? null,
      githubUrl,
      input.createdAt,
      input.scanId,
      existingId
    );
    return { itemId: (existingByMessage as { id: number }).id, isNew: false };
  }

  const duplicate = findDuplicateItem(input);
  if (duplicate) {
    attachMessages(duplicate.id, input.allMessages);
    db.query(
      `UPDATE items SET updated_at = CURRENT_TIMESTAMP, github_url = COALESCE(?, github_url), urgency = CASE
         WHEN urgency = 'high' OR ? = 'high' THEN 'high'
         WHEN urgency = 'medium' OR ? = 'medium' THEN 'medium'
         ELSE 'low' END
       WHERE id = ?`
    ).run(githubUrl, input.urgency, input.urgency, duplicate.id);
    return { itemId: duplicate.id, isNew: false };
  }

  const category = resolveExistingCategoryName(input.guildId, input.category) ?? "general";
  const defaultAssignee = input.assigneeId
    ? { userId: input.assigneeId, userName: input.assigneeName ?? null }
    : primaryCategoryAssignee(input.guildId, category);

  db.query(
    `INSERT INTO items
      (guild_id, channel_id, message_id, message_url, github_url, author_id, author_name, content_preview, summary, category, urgency, scan_id, assignee_id, assignee_name, source_message_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.guildId,
    input.channelId,
    input.messageId,
    input.messageUrl,
    githubUrl,
    input.authorId,
    input.authorName,
    preview(input.content),
    input.summary,
    category,
    input.urgency,
    input.scanId,
    defaultAssignee.userId ?? null,
    defaultAssignee.userName ?? null,
    input.createdAt
  );
  const row = db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  attachMessages(row.id, input.allMessages);
  return { itemId: row.id, isNew: true };
}

export function updateItemGithubMetadata(itemId: number, guildId: string, enrichment: GithubEnrichment): void {
  db.query(
    `UPDATE items
        SET github_url = COALESCE(?, github_url),
            github_repo_label = ?,
            github_ref_label = ?,
            github_status = ?,
            github_last_activity_at = ?,
            github_synced_at = CURRENT_TIMESTAMP,
            github_owner_hint = ?,
            github_assignee_hint = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(
    enrichment.url,
    enrichment.repoLabel,
    enrichment.refLabel,
    enrichment.status,
    enrichment.lastActivityAt,
    enrichment.ownerHint,
    enrichment.assigneeHint,
    itemId,
    guildId
  );
}

function hydrateRenderedItems(guildId: string, rows: Record<string, unknown>[]): RenderedItem[] {
  const itemIds = rows.map((row) => Number((row as { id: unknown }).id)).filter((id) => Number.isFinite(id));
  const categoryColors = new Map(
    listCategories(guildId).map((category) => [category.name, category.color] as const)
  );
  const relatedByItemId = new Map<number, Array<{ channel_id: string; source_message_created_at: string | null; created_at: string; content_preview: string | null }>>();

  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => "?").join(", ");
    const relatedRows = db.query(
      `SELECT item_id, channel_id, source_message_created_at, created_at, content_preview
         FROM item_messages
        WHERE item_id IN (${placeholders})
        ORDER BY item_id ASC, COALESCE(source_message_created_at, created_at) ASC`
    ).all(...itemIds) as Array<{
      item_id: number;
      channel_id: string;
      source_message_created_at: string | null;
      created_at: string;
      content_preview: string | null;
    }>;

    for (const row of relatedRows) {
      const bucket = relatedByItemId.get(row.item_id);
      if (bucket) {
        bucket.push(row);
      } else {
        relatedByItemId.set(row.item_id, [row]);
      }
    }
  }

  return rows.map((raw) => {
    const item = rowToItem(raw);
    const related = relatedByItemId.get(item.id) ?? [];
    const firstReportedAt = related[0]?.source_message_created_at ?? related[0]?.created_at ?? item.source_message_created_at ?? item.created_at;
    const relatedPreviews = related
      .map((row) => row.content_preview)
      .filter((value): value is string => Boolean(value));
    const candidatePreviews = relatedPreviews.length > 0 ? relatedPreviews : [item.content_preview];
    let bestPreview = candidatePreviews.find((text) => !isWeakFollowUpText(text)) ?? candidatePreviews[0] ?? item.content_preview;
    if (bestPreview) {
      bestPreview = bestPreview.replace(/\s+/g, " ").trim();
    }
    const projectNameSource = item.github_url || extractGithubUrl(item.content_preview)
      ? (bestPreview ?? item.content_preview)
      : `${item.summary} ${bestPreview ?? item.content_preview}`;
    const projectName = extractProjectName(projectNameSource);
    return {
      ...item,
      content_preview: bestPreview ?? item.content_preview,
      relatedCount: Math.max(0, related.length - 1),
      relatedChannels: Array.from(new Set(related.map((row) => row.channel_id))),
      ageLabel: ageLabel(firstReportedAt),
      source_message_created_at: firstReportedAt,
      categoryColor: categoryColors.get(item.category) ?? autoCategoryColor(item.category),
      projectName
    };
  });
}

export function getItems(options: {
  guildId: string;
  status?: "open" | "resolved" | "snoozed";
  category?: string;
  assigneeId?: string;
}): RenderedItem[] {
  ensureGuildCategories(options.guildId);
  normalizeExpiredSnoozes(options.guildId);
  const clauses = ["guild_id = ?"];
  const params: unknown[] = [options.guildId];

  if (options.status === "open") {
    clauses.push(`status = 'open'`);
  } else if (options.status === "resolved") {
    clauses.push(`status = 'resolved'`);
  } else if (options.status === "snoozed") {
    clauses.push(`status = 'snoozed'`);
  }

  if (options.category) {
    clauses.push("category = ?");
    params.push(options.category);
  }

  if (options.assigneeId) {
    clauses.push("assignee_id = ?");
    params.push(options.assigneeId);
  }

  const rows = db.query(
    `SELECT * FROM items WHERE ${clauses.join(" AND ")}`
  ).all(...params) as Record<string, unknown>[];

  const rendered = hydrateRenderedItems(options.guildId, rows);

  return rendered.sort((left, right) => {
    const leftTime = new Date(left.source_message_created_at ?? left.created_at).getTime();
    const rightTime = new Date(right.source_message_created_at ?? right.created_at).getTime();
    return leftTime - rightTime || left.id - right.id;
  });
}

export function getOpenItemsInLookback(guildId: string, lookbackHours: number): RenderedItem[] {
  ensureGuildCategories(guildId);
  normalizeExpiredSnoozes(guildId);
  const rows = db.query(
    `SELECT items.*
       FROM items
       LEFT JOIN (
         SELECT item_id, MIN(COALESCE(source_message_created_at, created_at)) AS first_reported_at
           FROM item_messages
          GROUP BY item_id
       ) related ON related.item_id = items.id
      WHERE items.guild_id = ?
        AND items.status = 'open'
        AND datetime(COALESCE(related.first_reported_at, items.source_message_created_at, items.created_at)) >= datetime('now', ?)
      ORDER BY datetime(COALESCE(related.first_reported_at, items.source_message_created_at, items.created_at)) ASC, items.id ASC`
  ).all(guildId, `-${lookbackHours} hours`) as Record<string, unknown>[];

  return hydrateRenderedItems(guildId, rows).sort((left, right) => {
    const leftTime = new Date(left.source_message_created_at ?? left.created_at).getTime();
    const rightTime = new Date(right.source_message_created_at ?? right.created_at).getTime();
    return leftTime - rightTime || left.id - right.id;
  });
}

export function getItem(itemId: number, guildId: string): ItemRow | null {
  normalizeExpiredSnoozes(guildId);
  const row = db.query(`SELECT * FROM items WHERE id = ? AND guild_id = ?`).get(itemId, guildId) as Record<string, unknown> | null;
  return row ? rowToItem(row) : null;
}

export function getItemMessages(itemId: number): ItemMessageRow[] {
  return db.query(`SELECT * FROM item_messages WHERE item_id = ? ORDER BY created_at ASC`).all(itemId) as ItemMessageRow[];
}

export function assignItem(itemId: number, guildId: string, userId: string, userName: string, actorId: string, actorName: string): void {
  db.query(`UPDATE items SET assignee_id = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND guild_id = ?`).run(
    userId,
    userName,
    itemId,
    guildId
  );
  writeAuditLog({ guildId, actorId, actorName, action: "assign", target: String(itemId), details: { userId, userName } });
}

export function recategorizeItem(itemId: number, guildId: string, categoryName: string, actorId: string, actorName: string): string {
  ensureGuildCategories(guildId);
  const category = resolveExistingCategoryName(guildId, categoryName) ?? "general";
  const item = getItem(itemId, guildId);
  if (!item) {
    throw new Error("item not found");
  }
  const defaultAssignee = !item.assignee_id ? primaryCategoryAssignee(guildId, category) : { userId: item.assignee_id, userName: item.assignee_name };
  db.query(
    `UPDATE items
        SET category = ?,
            assignee_id = ?,
            assignee_name = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(category, defaultAssignee.userId ?? null, defaultAssignee.userName ?? null, itemId, guildId);
  writeAuditLog({ guildId, actorId, actorName, action: "recategorize", target: String(itemId), details: { category } });
  return category;
}

export function resolveItem(itemId: number, guildId: string, actorId: string, actorName: string): void {
  db.query(
    `UPDATE items
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP,
            resolved_by = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(actorName, itemId, guildId);
  writeAuditLog({ guildId, actorId, actorName, action: "resolve", target: String(itemId) });
}

export function reopenItem(itemId: number, guildId: string, actorId: string, actorName: string): void {
  db.query(
    `UPDATE items
        SET status = 'open',
            resolved_at = NULL,
            resolved_by = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(itemId, guildId);
  writeAuditLog({ guildId, actorId, actorName, action: "reopen", target: String(itemId) });
}

export function snoozeItem(itemId: number, guildId: string, untilIso: string | null, actorId: string, actorName: string): void {
  db.query(
    `UPDATE items
        SET status = 'snoozed',
            snooze_until = ?,
            snoozed_by = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(untilIso, actorName, itemId, guildId);
  writeAuditLog({ guildId, actorId, actorName, action: "snooze", target: String(itemId), details: { untilIso } });
}

export function unsnoozeItem(itemId: number, guildId: string, actorId: string, actorName: string): void {
  db.query(
    `UPDATE items
        SET status = 'open',
            snooze_until = NULL,
            snoozed_by = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(itemId, guildId);
  writeAuditLog({ guildId, actorId, actorName, action: "unsnooze", target: String(itemId) });
}

export function addAdmin(guildId: string, userId: string, actorId: string, actorName: string): void {
  db.query(`INSERT OR IGNORE INTO admins (guild_id, user_id, added_by) VALUES (?, ?, ?)`).run(guildId, userId, actorId);
  writeAuditLog({ guildId, actorId, actorName, action: "admin_add", target: userId });
}

export function removeAdmin(guildId: string, userId: string, actorId: string, actorName: string): void {
  db.query(`DELETE FROM admins WHERE guild_id = ? AND user_id = ?`).run(guildId, userId);
  writeAuditLog({ guildId, actorId, actorName, action: "admin_remove", target: userId });
}

export function listAdmins(guildId: string): string[] {
  return (db.query(`SELECT user_id FROM admins WHERE guild_id = ? ORDER BY added_at ASC`).all(guildId) as { user_id: string }[]).map(
    (row) => row.user_id
  );
}

export function getConfigStatus(guildId: string, defaultLookbackHours: number): {
  lookbackHours: number;
  openCount: number;
  snoozedCount: number;
  resolvedCount: number;
  lastScanAt: string | null;
  scanEmissionsChannelId: string | null;
  chatEnabled: boolean;
  chatChannelIds: string[];
} {
  normalizeExpiredSnoozes(guildId);
  const lookbackHours = getGuildLookback(guildId, defaultLookbackHours);
  const scanEmissionsChannelId = getScanEmissionsChannelId(guildId);
  const chatEnabled = isChatEnabled(guildId);
  const chatChannelIds = listChatChannels(guildId);
  const openCount = Number((db.query(`SELECT COUNT(*) AS count FROM items WHERE guild_id = ? AND status = 'open'`).get(guildId) as { count: number }).count);
  const snoozedCount = Number((db.query(`SELECT COUNT(*) AS count FROM items WHERE guild_id = ? AND status = 'snoozed'`).get(guildId) as { count: number }).count);
  const resolvedCount = Number((db.query(`SELECT COUNT(*) AS count FROM items WHERE guild_id = ? AND status = 'resolved'`).get(guildId) as { count: number }).count);
  const lastScanAt = (db.query(`SELECT completed_at FROM scans WHERE guild_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 1`).get(
    guildId
  ) as { completed_at: string } | null)?.completed_at ?? null;
  return { lookbackHours, openCount, snoozedCount, resolvedCount, lastScanAt, scanEmissionsChannelId, chatEnabled, chatChannelIds };
}

export function isIgnoredCandidate(guildId: string, authorId: string, category: string, summary: string): boolean {
  return activeIgnoreRule(guildId, authorId, category, fingerprint(summary));
}

export function getAuditEntries(guildId: string, limit = 20): Array<{
  actor_id: string;
  actor_name: string;
  action: string;
  target: string | null;
  details: string | null;
  created_at: string;
}> {
  return db.query(
    `SELECT actor_id, actor_name, action, target, details, created_at
       FROM audit_log
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT ?`
  ).all(guildId, limit) as Array<{
    actor_id: string;
    actor_name: string;
    action: string;
    target: string | null;
    details: string | null;
    created_at: string;
  }>;
}

export function getScanChannel(guildId: string): string | null {
  return getScanEmissionsChannelId(guildId);
}

export function updateHumanReply(itemId: number, replyAtIso: string, replyUserId: string | null, replyName: string | null): void {
  db.query(
    `UPDATE items
        SET last_human_reply_at = ?,
            last_human_reply_user_id = ?,
            last_human_reply_name = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(replyAtIso, replyUserId, replyName, itemId);
}
