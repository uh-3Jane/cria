import { db } from "../db/client";
import type {
  ConversationTraceRow,
  FetchedMessage,
  ItemMessageRole,
  TraceAnalysisCacheRow,
  TraceKind,
  TraceOutcomeLabel,
  TraceState,
  TraceStateConfidence,
  TraceMessageRow,
  TrustedValidatedAnswerMatch,
  Urgency,
  ValidatedTraceMemoryRow
} from "../types";
import { contentFingerprint, preview, sharedTokenCount } from "../utils/text";

export const TRACE_ANALYSIS_VERSION = "trace_triage_v2_2026_04_02";

type CacheArgs = {
  guildId: string;
  traceFingerprint: string;
  analysisVersion?: string;
};

type UpsertTraceArgs = {
  guildId: string;
  primaryChannelId: string;
  primaryMessageId: string;
  primaryIssueMessageId?: string | null;
  strongestAnswerMessageId?: string | null;
  traceFingerprint: string;
  traceKind: TraceKind;
  traceState: TraceState;
  traceCategory: string;
  urgency: Urgency;
  confidence: TraceStateConfidence;
  reasonTags?: string[] | null;
  source?: "scan" | "chat";
  sourceItemId?: number | null;
  analysisVersion?: string;
};

type TraceMessageInput = {
  guildId: string;
  channelId: string;
  messageId: string;
  referenceMessageId?: string | null;
  authorId: string;
  authorName: string;
  content: string;
  role: ItemMessageRole;
  createdAt: string;
  positionIndex: number;
};

type RecordValidatedTraceOutcomeInput = {
  guildId: string;
  traceId?: number | null;
  itemId?: number | null;
  outcomeLabel: TraceOutcomeLabel;
  traceState: TraceState;
  category: string;
  primaryIssueText: string;
  strongestAnswerText?: string | null;
  contextText?: string | null;
  confidence: TraceStateConfidence;
  weight: number;
  sourceMessageId?: string | null;
  relatedMessageId?: string | null;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowToConversationTrace(row: Record<string, unknown>): ConversationTraceRow {
  return {
    id: row.id as number,
    guild_id: row.guild_id as string,
    primary_channel_id: row.primary_channel_id as string,
    primary_message_id: row.primary_message_id as string,
    primary_issue_message_id: optionalString(row.primary_issue_message_id),
    strongest_answer_message_id: optionalString(row.strongest_answer_message_id),
    trace_fingerprint: row.trace_fingerprint as string,
    trace_kind: row.trace_kind as TraceKind,
    trace_state: row.trace_state as TraceState,
    trace_category: row.trace_category as string,
    urgency: row.urgency as Urgency,
    confidence: row.confidence as TraceStateConfidence,
    reason_tags: optionalString(row.reason_tags),
    analysis_version: row.analysis_version as string,
    source: row.source as "scan" | "chat",
    source_item_id: typeof row.source_item_id === "number" ? row.source_item_id : null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  };
}

function rowToTraceMessage(row: Record<string, unknown>): TraceMessageRow {
  return {
    id: row.id as number,
    trace_id: row.trace_id as number,
    guild_id: row.guild_id as string,
    channel_id: row.channel_id as string,
    message_id: row.message_id as string,
    reference_message_id: optionalString(row.reference_message_id),
    author_id: row.author_id as string,
    author_name: row.author_name as string,
    content_preview: optionalString(row.content_preview),
    message_role: row.message_role as ItemMessageRole,
    position_index: row.position_index as number,
    source_message_created_at: optionalString(row.source_message_created_at),
    created_at: row.created_at as string
  };
}

function rowToTraceAnalysisCache(row: Record<string, unknown>): TraceAnalysisCacheRow {
  return {
    id: row.id as number,
    guild_id: row.guild_id as string,
    trace_fingerprint: row.trace_fingerprint as string,
    analysis_version: row.analysis_version as string,
    trace_kind: row.trace_kind as TraceKind,
    trace_state: row.trace_state as TraceState,
    category: row.category as string,
    urgency: row.urgency as Urgency,
    confidence: row.confidence as TraceStateConfidence,
    primary_issue_message_id: optionalString(row.primary_issue_message_id),
    strongest_answer_message_id: optionalString(row.strongest_answer_message_id),
    reason_tags: optionalString(row.reason_tags),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  };
}

function rowToValidatedTraceMemory(row: Record<string, unknown>): ValidatedTraceMemoryRow {
  return {
    id: row.id as number,
    guild_id: row.guild_id as string,
    trace_id: typeof row.trace_id === "number" ? row.trace_id : null,
    item_id: typeof row.item_id === "number" ? row.item_id : null,
    outcome_label: row.outcome_label as TraceOutcomeLabel,
    trace_state: row.trace_state as TraceState,
    category: row.category as string,
    primary_issue_text: row.primary_issue_text as string,
    strongest_answer_text: optionalString(row.strongest_answer_text),
    context_text: optionalString(row.context_text),
    confidence: row.confidence as TraceStateConfidence,
    weight: row.weight as number,
    reinforcement_count: row.reinforcement_count as number,
    memory_fingerprint: row.memory_fingerprint as string,
    source_message_id: optionalString(row.source_message_id),
    related_message_id: optionalString(row.related_message_id),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  };
}

export function computeTraceFingerprint(messages: Array<Pick<FetchedMessage, "channelId" | "messageId" | "authorId" | "content"> & { role?: ItemMessageRole | null }>): string {
  const ordered = messages
    .slice()
    .sort((left, right) => left.messageId.localeCompare(right.messageId))
    .map((message) => `${message.channelId}:${message.messageId}:${message.authorId}:${message.role ?? "unknown"}:${contentFingerprint(message.content)}`)
    .join("\n");
  return contentFingerprint(ordered);
}

export function getCachedTraceAnalysis(args: CacheArgs): TraceAnalysisCacheRow | null {
  const row = db.query(
    `SELECT *
       FROM trace_analysis_cache
      WHERE guild_id = ? AND trace_fingerprint = ? AND analysis_version = ?
      LIMIT 1`
  ).get(args.guildId, args.traceFingerprint, args.analysisVersion ?? TRACE_ANALYSIS_VERSION) as Record<string, unknown> | null;
  return row ? rowToTraceAnalysisCache(row) : null;
}

export function upsertTraceAnalysisCache(args: {
  guildId: string;
  traceFingerprint: string;
  analysisVersion?: string;
  traceKind: TraceKind;
  traceState: TraceState;
  category: string;
  urgency: Urgency;
  confidence: TraceStateConfidence;
  primaryIssueMessageId?: string | null;
  strongestAnswerMessageId?: string | null;
  reasonTags?: string[] | null;
}): void {
  db.query(
    `INSERT INTO trace_analysis_cache (
      guild_id,
      trace_fingerprint,
      analysis_version,
      trace_kind,
      trace_state,
      category,
      urgency,
      confidence,
      primary_issue_message_id,
      strongest_answer_message_id,
      reason_tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, trace_fingerprint, analysis_version) DO UPDATE SET
      trace_kind = excluded.trace_kind,
      trace_state = excluded.trace_state,
      category = excluded.category,
      urgency = excluded.urgency,
      confidence = excluded.confidence,
      primary_issue_message_id = excluded.primary_issue_message_id,
      strongest_answer_message_id = excluded.strongest_answer_message_id,
      reason_tags = excluded.reason_tags,
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    args.guildId,
    args.traceFingerprint,
    args.analysisVersion ?? TRACE_ANALYSIS_VERSION,
    args.traceKind,
    args.traceState,
    args.category,
    args.urgency,
    args.confidence,
    args.primaryIssueMessageId ?? null,
    args.strongestAnswerMessageId ?? null,
    args.reasonTags && args.reasonTags.length > 0 ? args.reasonTags.join(",") : null
  );
}

export function upsertConversationTrace(args: UpsertTraceArgs, messages: TraceMessageInput[]): number {
  db.query(
    `INSERT INTO conversation_traces (
      guild_id,
      primary_channel_id,
      primary_message_id,
      primary_issue_message_id,
      strongest_answer_message_id,
      trace_fingerprint,
      trace_kind,
      trace_state,
      trace_category,
      urgency,
      confidence,
      reason_tags,
      analysis_version,
      source,
      source_item_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, trace_fingerprint, analysis_version) DO UPDATE SET
      primary_channel_id = excluded.primary_channel_id,
      primary_message_id = excluded.primary_message_id,
      primary_issue_message_id = excluded.primary_issue_message_id,
      strongest_answer_message_id = excluded.strongest_answer_message_id,
      trace_kind = excluded.trace_kind,
      trace_state = excluded.trace_state,
      trace_category = excluded.trace_category,
      urgency = excluded.urgency,
      confidence = excluded.confidence,
      reason_tags = excluded.reason_tags,
      source = excluded.source,
      source_item_id = COALESCE(excluded.source_item_id, conversation_traces.source_item_id),
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    args.guildId,
    args.primaryChannelId,
    args.primaryMessageId,
    args.primaryIssueMessageId ?? null,
    args.strongestAnswerMessageId ?? null,
    args.traceFingerprint,
    args.traceKind,
    args.traceState,
    args.traceCategory,
    args.urgency,
    args.confidence,
    args.reasonTags && args.reasonTags.length > 0 ? args.reasonTags.join(",") : null,
    args.analysisVersion ?? TRACE_ANALYSIS_VERSION,
    args.source ?? "scan",
    args.sourceItemId ?? null
  );

  const row = db.query(
    `SELECT *
       FROM conversation_traces
      WHERE guild_id = ? AND trace_fingerprint = ? AND analysis_version = ?
      LIMIT 1`
  ).get(args.guildId, args.traceFingerprint, args.analysisVersion ?? TRACE_ANALYSIS_VERSION) as Record<string, unknown> | null;
  if (!row) {
    throw new Error("failed to upsert conversation trace");
  }
  const trace = rowToConversationTrace(row);

  const insertMessage = db.query(
    `INSERT OR IGNORE INTO trace_messages (
      trace_id,
      guild_id,
      channel_id,
      message_id,
      reference_message_id,
      author_id,
      author_name,
      content_preview,
      message_role,
      position_index,
      source_message_created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateMessage = db.query(
    `UPDATE trace_messages
        SET reference_message_id = COALESCE(?, reference_message_id),
            author_name = ?,
            content_preview = ?,
            message_role = ?,
            position_index = ?,
            source_message_created_at = COALESCE(?, source_message_created_at)
      WHERE trace_id = ? AND message_id = ?`
  );
  for (const message of messages) {
    const content = preview(message.content, 1_000);
    insertMessage.run(
      trace.id,
      message.guildId,
      message.channelId,
      message.messageId,
      message.referenceMessageId ?? null,
      message.authorId,
      message.authorName,
      content,
      message.role,
      message.positionIndex,
      message.createdAt
    );
    updateMessage.run(
      message.referenceMessageId ?? null,
      message.authorName,
      content,
      message.role,
      message.positionIndex,
      message.createdAt,
      trace.id,
      message.messageId
    );
  }

  return trace.id;
}

export function getConversationTrace(traceId: number, guildId: string): ConversationTraceRow | null {
  const row = db.query(`SELECT * FROM conversation_traces WHERE id = ? AND guild_id = ? LIMIT 1`).get(traceId, guildId) as Record<string, unknown> | null;
  return row ? rowToConversationTrace(row) : null;
}

export function linkTraceToItem(traceId: number, guildId: string, itemId: number): void {
  db.query(
    `UPDATE conversation_traces
        SET source_item_id = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(itemId, traceId, guildId);
}

export function getTraceMessages(traceId: number): TraceMessageRow[] {
  return (db.query(
    `SELECT *
       FROM trace_messages
      WHERE trace_id = ?
      ORDER BY position_index ASC, COALESCE(source_message_created_at, created_at) ASC, id ASC`
  ).all(traceId) as Record<string, unknown>[]).map(rowToTraceMessage);
}

export function recordValidatedTraceOutcome(input: RecordValidatedTraceOutcomeInput): number {
  const memoryFingerprint = contentFingerprint([
    input.guildId,
    input.traceId ?? "no-trace",
    input.outcomeLabel,
    input.category,
    input.primaryIssueText,
    input.strongestAnswerText ?? "",
    input.sourceMessageId ?? "",
    input.relatedMessageId ?? ""
  ].join("\n"));

  db.query(
    `INSERT INTO validated_trace_memory (
      guild_id,
      trace_id,
      item_id,
      outcome_label,
      trace_state,
      category,
      primary_issue_text,
      strongest_answer_text,
      context_text,
      confidence,
      weight,
      reinforcement_count,
      memory_fingerprint,
      source_message_id,
      related_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(guild_id, memory_fingerprint) DO UPDATE SET
      trace_id = COALESCE(excluded.trace_id, validated_trace_memory.trace_id),
      item_id = COALESCE(excluded.item_id, validated_trace_memory.item_id),
      trace_state = excluded.trace_state,
      context_text = COALESCE(excluded.context_text, validated_trace_memory.context_text),
      confidence = excluded.confidence,
      weight = MAX(validated_trace_memory.weight, excluded.weight),
      reinforcement_count = validated_trace_memory.reinforcement_count + 1,
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    input.guildId,
    input.traceId ?? null,
    input.itemId ?? null,
    input.outcomeLabel,
    input.traceState,
    input.category,
    preview(input.primaryIssueText, 1_000),
    input.strongestAnswerText ? preview(input.strongestAnswerText, 1_000) : null,
    input.contextText ? preview(input.contextText, 1_500) : null,
    input.confidence,
    Math.max(0, input.weight),
    memoryFingerprint,
    input.sourceMessageId ?? null,
    input.relatedMessageId ?? null
  );

  const row = db.query(
    `SELECT *
       FROM validated_trace_memory
      WHERE guild_id = ? AND memory_fingerprint = ?
      LIMIT 1`
  ).get(input.guildId, memoryFingerprint) as Record<string, unknown> | null;
  if (!row) {
    throw new Error("failed to record validated trace outcome");
  }
  return rowToValidatedTraceMemory(row).id;
}

export function findValidatedTraceMatches(args: {
  guildId: string;
  query: string;
  category?: string | null;
  limit?: number;
}): TrustedValidatedAnswerMatch[] {
  const rows = db.query(
    `SELECT *
       FROM validated_trace_memory
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT 500`
  ).all(args.guildId) as Record<string, unknown>[];
  const parsed = rows.map(rowToValidatedTraceMemory);

  return parsed
    .filter((row) => (row.outcome_label === "resolved" || row.outcome_label === "already_handled") && row.strongest_answer_text && row.strongest_answer_text.trim().length > 0)
    .map((row) => {
      const confirmationCount = parsed.filter((candidate) =>
        (candidate.outcome_label === "resolved" || candidate.outcome_label === "already_handled")
        && candidate.strongest_answer_text
        && row.strongest_answer_text
        && sharedTokenCount(row.strongest_answer_text, candidate.strongest_answer_text) >= 2
        && (
          sharedTokenCount(row.primary_issue_text, candidate.primary_issue_text) >= 2
          || (row.context_text && candidate.context_text && sharedTokenCount(row.context_text, candidate.context_text) >= 2)
        )
      ).length;
      const correctionCount = parsed.filter((candidate) =>
        (candidate.outcome_label === "reopened" || candidate.outcome_label === "false_positive")
        && candidate.strongest_answer_text
        && row.strongest_answer_text
        && sharedTokenCount(row.strongest_answer_text, candidate.strongest_answer_text) >= 2
        && (
          sharedTokenCount(row.primary_issue_text, candidate.primary_issue_text) >= 2
          || (row.context_text && candidate.context_text && sharedTokenCount(row.context_text, candidate.context_text) >= 2)
        )
      ).length;
      let score = sharedTokenCount(args.query, row.primary_issue_text) * 4;
      if (row.strongest_answer_text) {
        score += sharedTokenCount(args.query, row.strongest_answer_text) * 3;
      }
      if (row.context_text) {
        score += sharedTokenCount(args.query, row.context_text) * 2;
      }
      if (args.category && row.category === args.category) {
        score += 3;
      }
      score += row.weight;
      score += Math.min(confirmationCount * 3, 12);
      score -= correctionCount * 5;
      return {
        id: row.id,
        traceId: row.trace_id,
        domain: "validated_trace" as const,
        inputText: row.primary_issue_text,
        contextText: row.context_text,
        answerText: row.strongest_answer_text ?? "",
        feedbackKind: "validated" as const,
        weight: row.weight,
        reinforcementCount: row.reinforcement_count,
        confirmationCount,
        correctionCount,
        score
      };
    })
    .filter((entry) => entry.confirmationCount >= 2 && entry.correctionCount < entry.confirmationCount && entry.score >= 8)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, args.limit ?? 3));
}
