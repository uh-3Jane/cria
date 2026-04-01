import { db } from "../db/client";
import { upsertReviewQueueFromLearningFeedback } from "../review/store";
import type {
  LearningFeedbackDomain,
  LearningFeedbackKind,
  LearningFeedbackMatch,
  LearningFeedbackRow
} from "../types";
import { contentFingerprint, preview, sharedTokenCount } from "../utils/text";

interface RecordLearningFeedbackInput {
  guildId: string;
  domain: LearningFeedbackDomain;
  inputText: string;
  contextText?: string | null;
  initialOutput?: string | null;
  correctedOutput: string;
  feedbackKind: LearningFeedbackKind;
  weight?: number;
  itemId?: number | null;
  traceId?: number | null;
  sourceMessageId?: string | null;
  relatedMessageId?: string | null;
}

function rowToLearningFeedback(row: Record<string, unknown>): LearningFeedbackRow {
  const requiredString = (key: keyof LearningFeedbackRow): string => {
    const value = row[key as string];
    if (typeof value !== "string") {
      throw new Error(`invalid learning feedback row: ${String(key)}`);
    }
    return value;
  };
  const optionalString = (key: keyof LearningFeedbackRow): string | null => {
    const value = row[key as string];
    return typeof value === "string" ? value : null;
  };
  const requiredNumber = (key: keyof LearningFeedbackRow): number => {
    const value = row[key as string];
    if (typeof value !== "number") {
      throw new Error(`invalid learning feedback row: ${String(key)}`);
    }
    return value;
  };

  return {
    id: requiredNumber("id"),
    guild_id: requiredString("guild_id"),
    domain: requiredString("domain") as LearningFeedbackDomain,
    input_text: requiredString("input_text"),
    context_text: optionalString("context_text"),
    initial_output: optionalString("initial_output"),
    corrected_output: requiredString("corrected_output"),
    feedback_kind: requiredString("feedback_kind") as LearningFeedbackKind,
    weight: requiredNumber("weight"),
    reinforcement_count: requiredNumber("reinforcement_count"),
    item_id: typeof row.item_id === "number" ? row.item_id : null,
    trace_id: typeof row.trace_id === "number" ? row.trace_id : null,
    source_message_id: optionalString("source_message_id"),
    related_message_id: optionalString("related_message_id"),
    feedback_fingerprint: requiredString("feedback_fingerprint"),
    created_at: requiredString("created_at"),
    updated_at: requiredString("updated_at")
  };
}

export function recordLearningFeedback(input: RecordLearningFeedbackInput): number {
  const normalizedInput = preview(input.inputText, 1_000);
  const normalizedContext = input.contextText ? preview(input.contextText, 1_500) : null;
  const normalizedInitial = input.initialOutput ? preview(input.initialOutput, 1_000) : null;
  const normalizedCorrected = preview(input.correctedOutput, 1_000);
  const fingerprint = contentFingerprint([
    input.guildId,
    input.domain,
    normalizedInput,
    normalizedCorrected
  ].join("\n"));

  db.query(
    `INSERT INTO learning_feedback (
      guild_id,
      domain,
      input_text,
      context_text,
      initial_output,
      corrected_output,
      feedback_kind,
      weight,
      reinforcement_count,
      item_id,
      trace_id,
      source_message_id,
      related_message_id,
      feedback_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, feedback_fingerprint) DO UPDATE SET
      context_text = COALESCE(excluded.context_text, learning_feedback.context_text),
      initial_output = COALESCE(excluded.initial_output, learning_feedback.initial_output),
      corrected_output = excluded.corrected_output,
      feedback_kind = excluded.feedback_kind,
      weight = MAX(learning_feedback.weight, excluded.weight),
      reinforcement_count = learning_feedback.reinforcement_count + 1,
      item_id = COALESCE(excluded.item_id, learning_feedback.item_id),
      trace_id = COALESCE(excluded.trace_id, learning_feedback.trace_id),
      source_message_id = COALESCE(excluded.source_message_id, learning_feedback.source_message_id),
      related_message_id = COALESCE(excluded.related_message_id, learning_feedback.related_message_id),
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    input.guildId,
    input.domain,
    normalizedInput,
    normalizedContext,
    normalizedInitial,
    normalizedCorrected,
    input.feedbackKind,
    Math.max(0, input.weight ?? 0),
    input.itemId ?? null,
    input.traceId ?? null,
    input.sourceMessageId ?? null,
    input.relatedMessageId ?? null,
    fingerprint
  );

  const row = db.query(
    `SELECT id
       FROM learning_feedback
      WHERE guild_id = ? AND feedback_fingerprint = ?
      LIMIT 1`
  ).get(input.guildId, fingerprint) as { id: number } | null;

  if (!row) {
    throw new Error("failed to record learning feedback");
  }
  upsertReviewQueueFromLearningFeedback({
    guildId: input.guildId,
    sourceDomain: input.domain,
    sourceId: row.id,
    itemId: input.itemId ?? null,
    traceId: input.traceId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    relatedMessageId: input.relatedMessageId ?? null,
    rawInput: normalizedInput,
    rawContext: normalizedContext,
    rawInitialOutput: normalizedInitial,
    rawCorrectedOutput: normalizedCorrected,
    feedbackKind: input.feedbackKind,
    weight: Math.max(0, input.weight ?? 0),
    reinforcementCount: (db.query(
      `SELECT reinforcement_count
         FROM learning_feedback
        WHERE id = ?
        LIMIT 1`
    ).get(row.id) as { reinforcement_count: number }).reinforcement_count
  });
  return row.id;
}

export function findLearningFeedbackMatches(args: {
  guildId: string;
  query: string;
  domains?: LearningFeedbackDomain[];
  limit?: number;
}): LearningFeedbackMatch[] {
  const rows = db.query(
    `SELECT *
       FROM learning_feedback
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT 300`
  ).all(args.guildId) as Record<string, unknown>[];

  const allowed = args.domains ? new Set(args.domains) : null;
  return rows
    .map(rowToLearningFeedback)
    .filter((row) => !allowed || allowed.has(row.domain))
    .map((row) => {
      let score = sharedTokenCount(args.query, row.input_text) * 4;
      score += sharedTokenCount(args.query, row.corrected_output) * 2;
      if (row.context_text) {
        score += sharedTokenCount(args.query, row.context_text);
      }
      score += row.weight;
      score += Math.min(row.reinforcement_count * 2, 10);
      return { row, score };
    })
    .filter((entry) => entry.score >= 4)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, args.limit ?? 3))
    .map(({ row, score }) => ({
      id: row.id,
      domain: row.domain,
      inputText: row.input_text,
      contextText: row.context_text,
      initialOutput: row.initial_output,
      correctedOutput: row.corrected_output,
      feedbackKind: row.feedback_kind,
      weight: row.weight,
      reinforcementCount: row.reinforcement_count,
      score
    }));
}
