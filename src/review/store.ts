import { db } from "../db/client";
import { findKnowledgeMatches } from "../knowledge/store";
import { completeJson } from "../llm/client";
import type {
  BenchmarkCaseRow,
  BenchmarkOutcomeType,
  BenchmarkRunResultRow,
  BenchmarkRunRow,
  BenchmarkSource,
  BenchmarkStatus,
  LearningFeedbackDomain,
  LearningFeedbackKind,
  ReviewPromotionStatus,
  ReviewedPrecedentMatch,
  TrustedValidatedAnswerMatch,
  ReviewQueueRow,
  ReviewStatus
} from "../types";
import { contentFingerprint, preview, sharedTokenCount } from "../utils/text";

interface UpsertReviewQueueFromFeedbackInput {
  guildId: string;
  sourceDomain: LearningFeedbackDomain;
  sourceId: number;
  itemId?: number | null;
  sourceMessageId?: string | null;
  relatedMessageId?: string | null;
  rawInput: string;
  rawContext?: string | null;
  rawInitialOutput?: string | null;
  rawCorrectedOutput: string;
  feedbackKind: LearningFeedbackKind;
  weight: number;
  reinforcementCount: number;
}

interface CreateManualReviewQueueInput {
  guildId: string;
  sourceDomain: LearningFeedbackDomain;
  rawInput: string;
  rawContext?: string | null;
  rawInitialOutput?: string | null;
  rawCorrectedOutput: string;
  feedbackKind: LearningFeedbackKind;
  weight?: number;
  notes?: string | null;
}

interface CreateBenchmarkCaseInput {
  guildId: string;
  family: string;
  outcomeType: BenchmarkOutcomeType;
  canonicalInput: string;
  canonicalContext?: string | null;
  targetOutput: string;
  notes?: string | null;
  source?: BenchmarkSource;
  sourceReviewId?: number | null;
}

function rowToReviewQueue(row: Record<string, unknown>): ReviewQueueRow {
  const requiredString = (key: keyof ReviewQueueRow): string => {
    const value = row[key as string];
    if (typeof value !== "string") {
      throw new Error(`invalid review queue row: ${String(key)}`);
    }
    return value;
  };
  const optionalString = (key: keyof ReviewQueueRow): string | null => {
    const value = row[key as string];
    return typeof value === "string" ? value : null;
  };
  const requiredNumber = (key: keyof ReviewQueueRow): number => {
    const value = row[key as string];
    if (typeof value !== "number") {
      throw new Error(`invalid review queue row: ${String(key)}`);
    }
    return value;
  };

  return {
    id: requiredNumber("id"),
    guild_id: requiredString("guild_id"),
    source_domain: requiredString("source_domain") as LearningFeedbackDomain,
    source_id: typeof row.source_id === "number" ? row.source_id : null,
    item_id: typeof row.item_id === "number" ? row.item_id : null,
    source_message_id: optionalString("source_message_id"),
    related_message_id: optionalString("related_message_id"),
    raw_input: requiredString("raw_input"),
    raw_context: optionalString("raw_context"),
    raw_initial_output: optionalString("raw_initial_output"),
    raw_corrected_output: requiredString("raw_corrected_output"),
    feedback_kind: requiredString("feedback_kind") as LearningFeedbackKind,
    weight: requiredNumber("weight"),
    reinforcement_count: requiredNumber("reinforcement_count"),
    priority: requiredNumber("priority"),
    review_status: requiredString("review_status") as ReviewStatus,
    promotion_status: requiredString("promotion_status") as ReviewPromotionStatus,
    notes: optionalString("notes"),
    last_reviewed_at: optionalString("last_reviewed_at"),
    created_at: requiredString("created_at"),
    updated_at: requiredString("updated_at")
  };
}

function rowToBenchmarkCase(row: Record<string, unknown>): BenchmarkCaseRow {
  const requiredString = (key: keyof BenchmarkCaseRow): string => {
    const value = row[key as string];
    if (typeof value !== "string") {
      throw new Error(`invalid benchmark case row: ${String(key)}`);
    }
    return value;
  };
  const optionalString = (key: keyof BenchmarkCaseRow): string | null => {
    const value = row[key as string];
    return typeof value === "string" ? value : null;
  };
  const requiredNumber = (key: keyof BenchmarkCaseRow): number => {
    const value = row[key as string];
    if (typeof value !== "number") {
      throw new Error(`invalid benchmark case row: ${String(key)}`);
    }
    return value;
  };

  return {
    id: requiredNumber("id"),
    guild_id: requiredString("guild_id"),
    source_review_id: typeof row.source_review_id === "number" ? row.source_review_id : null,
    source: requiredString("source") as BenchmarkSource,
    family: requiredString("family"),
    outcome_type: requiredString("outcome_type") as BenchmarkOutcomeType,
    canonical_input: requiredString("canonical_input"),
    canonical_context: optionalString("canonical_context"),
    target_output: requiredString("target_output"),
    status: requiredString("status") as BenchmarkStatus,
    notes: optionalString("notes"),
    replaced_by_case_id: typeof row.replaced_by_case_id === "number" ? row.replaced_by_case_id : null,
    last_reviewed_at: optionalString("last_reviewed_at"),
    created_at: requiredString("created_at"),
    updated_at: requiredString("updated_at")
  };
}

function rowToBenchmarkRun(row: Record<string, unknown>): BenchmarkRunRow {
  return {
    id: row.id as number,
    guild_id: row.guild_id as string,
    triggered_by: row.triggered_by as string,
    notes: typeof row.notes === "string" ? row.notes : null,
    status: row.status as BenchmarkRunRow["status"],
    active_case_count: row.active_case_count as number,
    passed_count: row.passed_count as number,
    failed_count: row.failed_count as number,
    started_at: row.started_at as string,
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null
  };
}

function rowToBenchmarkRunResult(row: Record<string, unknown>): BenchmarkRunResultRow {
  return {
    id: row.id as number,
    run_id: row.run_id as number,
    case_id: row.case_id as number,
    family: row.family as string,
    passed: row.passed as number,
    actual_output: typeof row.actual_output === "string" ? row.actual_output : null,
    score: row.score as number,
    notes: typeof row.notes === "string" ? row.notes : null,
    created_at: row.created_at as string
  };
}

function normalizeReviewPriority(args: {
  sourceDomain: LearningFeedbackDomain;
  feedbackKind: LearningFeedbackKind;
  weight: number;
  reinforcementCount: number;
}): number {
  if (args.feedbackKind === "corrected") {
    return 95;
  }
  if (args.sourceDomain === "scan_category") {
    return 85;
  }
  if (args.sourceDomain === "scan_resolution") {
    return 80;
  }
  if (args.reinforcementCount >= 3) {
    return 70;
  }
  if ((args.feedbackKind === "confirmed" || args.feedbackKind === "refined") && args.weight >= 6) {
    return 60;
  }
  return 30;
}

export function upsertReviewQueueFromLearningFeedback(input: UpsertReviewQueueFromFeedbackInput): number {
  const priority = normalizeReviewPriority({
    sourceDomain: input.sourceDomain,
    feedbackKind: input.feedbackKind,
    weight: input.weight,
    reinforcementCount: input.reinforcementCount
  });

  db.query(
    `INSERT INTO review_queue (
      guild_id,
      source_domain,
      source_id,
      item_id,
      source_message_id,
      related_message_id,
      raw_input,
      raw_context,
      raw_initial_output,
      raw_corrected_output,
      feedback_kind,
      weight,
      reinforcement_count,
      priority,
      review_status,
      promotion_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not_promoted')
    ON CONFLICT(guild_id, source_domain, source_id) DO UPDATE SET
      item_id = COALESCE(excluded.item_id, review_queue.item_id),
      source_message_id = COALESCE(excluded.source_message_id, review_queue.source_message_id),
      related_message_id = COALESCE(excluded.related_message_id, review_queue.related_message_id),
      raw_input = excluded.raw_input,
      raw_context = COALESCE(excluded.raw_context, review_queue.raw_context),
      raw_initial_output = COALESCE(excluded.raw_initial_output, review_queue.raw_initial_output),
      raw_corrected_output = excluded.raw_corrected_output,
      feedback_kind = excluded.feedback_kind,
      weight = MAX(review_queue.weight, excluded.weight),
      reinforcement_count = MAX(review_queue.reinforcement_count, excluded.reinforcement_count),
      priority = MAX(review_queue.priority, excluded.priority),
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    input.guildId,
    input.sourceDomain,
    input.sourceId,
    input.itemId ?? null,
    input.sourceMessageId ?? null,
    input.relatedMessageId ?? null,
    preview(input.rawInput, 1_000),
    input.rawContext ? preview(input.rawContext, 1_500) : null,
    input.rawInitialOutput ? preview(input.rawInitialOutput, 1_000) : null,
    preview(input.rawCorrectedOutput, 1_000),
    input.feedbackKind,
    Math.max(0, input.weight),
    Math.max(1, input.reinforcementCount),
    priority
  );

  const row = db.query(
    `SELECT id
       FROM review_queue
      WHERE guild_id = ? AND source_domain = ? AND source_id = ?
      LIMIT 1`
  ).get(input.guildId, input.sourceDomain, input.sourceId) as { id: number } | null;
  if (!row) {
    throw new Error("failed to upsert review queue item");
  }
  return row.id;
}

export function syncReviewQueueFromLearningFeedback(guildId?: string): number {
  const rows = guildId
    ? db.query(`SELECT * FROM learning_feedback WHERE guild_id = ? ORDER BY updated_at DESC`).all(guildId)
    : db.query(`SELECT * FROM learning_feedback ORDER BY updated_at DESC`).all();
  let synced = 0;
  for (const row of rows as Array<Record<string, unknown>>) {
    upsertReviewQueueFromLearningFeedback({
      guildId: row.guild_id as string,
      sourceDomain: row.domain as LearningFeedbackDomain,
      sourceId: row.id as number,
      itemId: typeof row.item_id === "number" ? row.item_id : null,
      sourceMessageId: typeof row.source_message_id === "string" ? row.source_message_id : null,
      relatedMessageId: typeof row.related_message_id === "string" ? row.related_message_id : null,
      rawInput: row.input_text as string,
      rawContext: typeof row.context_text === "string" ? row.context_text : null,
      rawInitialOutput: typeof row.initial_output === "string" ? row.initial_output : null,
      rawCorrectedOutput: row.corrected_output as string,
      feedbackKind: row.feedback_kind as LearningFeedbackKind,
      weight: row.weight as number,
      reinforcementCount: row.reinforcement_count as number
    });
    synced += 1;
  }
  return synced;
}

export function createManualReviewQueueItem(input: CreateManualReviewQueueInput): number {
  db.query(
    `INSERT INTO review_queue (
      guild_id,
      source_domain,
      source_id,
      raw_input,
      raw_context,
      raw_initial_output,
      raw_corrected_output,
      feedback_kind,
      weight,
      reinforcement_count,
      priority,
      review_status,
      promotion_status,
      notes
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', 'not_promoted', ?)`
  ).run(
    input.guildId,
    input.sourceDomain,
    preview(input.rawInput, 1_000),
    input.rawContext ? preview(input.rawContext, 1_500) : null,
    input.rawInitialOutput ? preview(input.rawInitialOutput, 1_000) : null,
    preview(input.rawCorrectedOutput, 1_000),
    input.feedbackKind,
    Math.max(0, input.weight ?? 0),
    normalizeReviewPriority({
      sourceDomain: input.sourceDomain,
      feedbackKind: input.feedbackKind,
      weight: input.weight ?? 0,
      reinforcementCount: 1
    }),
    input.notes ?? null
  );
  const row = db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return row.id;
}

export function listReviewQueue(guildId: string, status?: ReviewStatus, limit = 30): ReviewQueueRow[] {
  const rows = status
    ? db.query(
      `SELECT *
         FROM review_queue
        WHERE guild_id = ? AND review_status = ?
        ORDER BY priority DESC, updated_at DESC
        LIMIT ?`
    ).all(guildId, status, limit)
    : db.query(
      `SELECT *
         FROM review_queue
        WHERE guild_id = ?
        ORDER BY CASE review_status WHEN 'pending' THEN 0 ELSE 1 END, priority DESC, updated_at DESC
        LIMIT ?`
    ).all(guildId, limit);
  return (rows as Record<string, unknown>[]).map(rowToReviewQueue);
}

export function markReviewQueueItem(queueId: number, guildId: string, status: ReviewStatus, notes?: string | null): void {
  db.query(
    `UPDATE review_queue
        SET review_status = ?,
            notes = COALESCE(?, notes),
            last_reviewed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(status, notes ?? null, queueId, guildId);
}

export function findReviewedPrecedentMatches(args: {
  guildId: string;
  query: string;
  domains?: LearningFeedbackDomain[];
  limit?: number;
}): ReviewedPrecedentMatch[] {
  const rows = db.query(
    `SELECT *
       FROM review_queue
      WHERE guild_id = ?
        AND review_status IN ('reviewed_good', 'reviewed_corrected')
      ORDER BY updated_at DESC
      LIMIT 300`
  ).all(args.guildId) as Record<string, unknown>[];
  const allowed = args.domains ? new Set(args.domains) : null;
  return rows
    .map(rowToReviewQueue)
    .filter((row) => !allowed || allowed.has(row.source_domain))
    .map((row) => {
      let score = sharedTokenCount(args.query, row.raw_input) * 4;
      score += sharedTokenCount(args.query, row.raw_corrected_output) * 2;
      if (row.raw_context) {
        score += sharedTokenCount(args.query, row.raw_context);
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
      domain: row.source_domain,
      inputText: row.raw_input,
      contextText: row.raw_context,
      initialOutput: row.raw_initial_output,
      correctedOutput: row.raw_corrected_output,
      feedbackKind: row.feedback_kind,
      reviewStatus: row.review_status,
      promotionStatus: row.promotion_status,
      weight: row.weight,
      reinforcementCount: row.reinforcement_count,
      score
    }));
}

export function findTrustedValidatedAnswerMatches(args: {
  guildId: string;
  query: string;
  domains?: LearningFeedbackDomain[];
  limit?: number;
}): TrustedValidatedAnswerMatch[] {
  const rows = db.query(
    `SELECT *
       FROM learning_feedback
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT 400`
  ).all(args.guildId) as Record<string, unknown>[];
  const allowed = args.domains ? new Set(args.domains) : null;
  const parsed = rows
    .map((row) => ({
      id: row.id as number,
      domain: row.domain as LearningFeedbackDomain,
      input_text: row.input_text as string,
      context_text: typeof row.context_text === "string" ? row.context_text : null,
      initial_output: typeof row.initial_output === "string" ? row.initial_output : null,
      corrected_output: row.corrected_output as string,
      feedback_kind: row.feedback_kind as LearningFeedbackKind,
      weight: row.weight as number,
      reinforcement_count: row.reinforcement_count as number
    }))
    .filter((row) => !allowed || allowed.has(row.domain));

  return parsed
    .filter((row) =>
      row.domain === "scan_resolution"
      && row.feedback_kind === "confirmed"
      && row.corrected_output.trim().length > 0
      && !row.corrected_output.toLowerCase().startsWith("resolved:")
      && (sharedTokenCount(args.query, row.input_text) >= 2 || (row.context_text ? sharedTokenCount(args.query, row.context_text) >= 2 : false))
    )
    .map((row) => {
      const confirmationCount = parsed.filter((candidate) =>
        candidate.domain === "scan_resolution"
        && candidate.feedback_kind === "confirmed"
        && sharedTokenCount(row.corrected_output, candidate.corrected_output) >= 2
        && (
          sharedTokenCount(row.input_text, candidate.input_text) >= 2
          || (row.context_text && candidate.context_text && sharedTokenCount(row.context_text, candidate.context_text) >= 2)
        )
      ).length;
      const correctionCount = parsed.filter((candidate) =>
        candidate.domain === "scan_resolution"
        && candidate.feedback_kind === "corrected"
        && candidate.initial_output
        && sharedTokenCount(row.corrected_output, candidate.initial_output) >= 2
        && (
          sharedTokenCount(row.input_text, candidate.input_text) >= 2
          || (row.context_text && candidate.context_text && sharedTokenCount(row.context_text, candidate.context_text) >= 2)
        )
      ).length;
      let score = sharedTokenCount(args.query, row.input_text) * 4;
      score += sharedTokenCount(args.query, row.corrected_output) * 3;
      if (row.context_text) {
        score += sharedTokenCount(args.query, row.context_text) * 2;
      }
      score += row.weight;
      score += Math.min(confirmationCount * 3, 12);
      score -= correctionCount * 5;
      return {
        id: row.id,
        domain: row.domain,
        inputText: row.input_text,
        contextText: row.context_text,
        answerText: row.corrected_output,
        feedbackKind: row.feedback_kind,
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

export function createBenchmarkCase(input: CreateBenchmarkCaseInput): number {
  db.query(
    `INSERT INTO benchmark_cases (
      guild_id,
      source_review_id,
      source,
      family,
      outcome_type,
      canonical_input,
      canonical_context,
      target_output,
      status,
      notes,
      last_reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)`
  ).run(
    input.guildId,
    input.sourceReviewId ?? null,
    input.source ?? "manual",
    input.family,
    input.outcomeType,
    preview(input.canonicalInput, 1_000),
    input.canonicalContext ? preview(input.canonicalContext, 1_500) : null,
    preview(input.targetOutput, 1_000),
    input.notes ?? null
  );
  const row = db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return row.id;
}

export function promoteReviewQueueItem(args: {
  queueId: number;
  guildId: string;
  family: string;
  outcomeType: BenchmarkOutcomeType;
  canonicalInput?: string;
  canonicalContext?: string | null;
  targetOutput?: string;
  notes?: string | null;
}): number {
  const row = db.query(`SELECT * FROM review_queue WHERE id = ? AND guild_id = ?`).get(args.queueId, args.guildId) as Record<string, unknown> | null;
  if (!row) {
    throw new Error("review queue item not found");
  }
  const queueItem = rowToReviewQueue(row);
  const caseId = createBenchmarkCase({
    guildId: args.guildId,
    sourceReviewId: queueItem.id,
    source: "promoted_trace",
    family: args.family,
    outcomeType: args.outcomeType,
    canonicalInput: args.canonicalInput ?? queueItem.raw_input,
    canonicalContext: args.canonicalContext ?? queueItem.raw_context,
    targetOutput: args.targetOutput ?? queueItem.raw_corrected_output,
    notes: args.notes ?? queueItem.notes
  });
  db.query(
    `UPDATE review_queue
        SET promotion_status = 'promoted',
            last_reviewed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(queueItem.id, args.guildId);
  return caseId;
}

export function updateBenchmarkCase(args: {
  caseId: number;
  guildId: string;
  family?: string;
  outcomeType?: BenchmarkOutcomeType;
  canonicalInput?: string;
  canonicalContext?: string | null;
  targetOutput?: string;
  status?: BenchmarkStatus;
  notes?: string | null;
}): void {
  db.query(
    `UPDATE benchmark_cases
        SET family = COALESCE(?, family),
            outcome_type = COALESCE(?, outcome_type),
            canonical_input = COALESCE(?, canonical_input),
            canonical_context = COALESCE(?, canonical_context),
            target_output = COALESCE(?, target_output),
            status = COALESCE(?, status),
            notes = COALESCE(?, notes),
            last_reviewed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND guild_id = ?`
  ).run(
    args.family ?? null,
    args.outcomeType ?? null,
    args.canonicalInput ? preview(args.canonicalInput, 1_000) : null,
    args.canonicalContext !== undefined ? (args.canonicalContext ? preview(args.canonicalContext, 1_500) : null) : null,
    args.targetOutput ? preview(args.targetOutput, 1_000) : null,
    args.status ?? null,
    args.notes ?? null,
    args.caseId,
    args.guildId
  );
}

export function retireBenchmarkCase(caseId: number, guildId: string, notes?: string | null): void {
  updateBenchmarkCase({ caseId, guildId, status: "retired", notes: notes ?? null });
}

export function listBenchmarkCases(guildId: string, status?: BenchmarkStatus, limit = 50): BenchmarkCaseRow[] {
  const rows = status
    ? db.query(
      `SELECT *
         FROM benchmark_cases
        WHERE guild_id = ? AND status = ?
        ORDER BY updated_at DESC
        LIMIT ?`
    ).all(guildId, status, limit)
    : db.query(
      `SELECT *
         FROM benchmark_cases
        WHERE guild_id = ?
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT ?`
    ).all(guildId, limit);
  return (rows as Record<string, unknown>[]).map(rowToBenchmarkCase);
}

async function judgeAnswerSufficiency(args: {
  userInput: string;
  candidateAnswer: string;
  targetAnswer: string;
}): Promise<{ passed: boolean; score: number; notes: string }> {
  const system = `You are grading whether a candidate support answer is sufficiently aligned with a benchmark target.
Return JSON only: {"passed": boolean, "score": number, "notes": string}.
Score must be 0-10.
Prefer passing when the candidate is directionally correct and preserves the important facts.
Fail if the candidate misses the key instruction, routing, or factual content.`;
  const user = [
    `User input: ${args.userInput}`,
    `Candidate answer: ${args.candidateAnswer}`,
    `Benchmark target: ${args.targetAnswer}`
  ].join("\n\n");
  const raw = await completeJson(system, user);
  const payload = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const passed = payload.passed === true;
  const score = typeof payload.score === "number" ? Math.max(0, Math.min(10, Math.round(payload.score))) : 0;
  const notes = typeof payload.notes === "string" ? payload.notes : (passed ? "passed" : "failed");
  return { passed, score, notes };
}

async function evaluateBenchmarkCase(caseRow: BenchmarkCaseRow): Promise<{ passed: boolean; actualOutput: string; score: number; notes: string }> {
  const query = [caseRow.canonical_input, caseRow.canonical_context].filter(Boolean).join("\n");
  if (caseRow.outcome_type === "category") {
    const matches = findReviewedPrecedentMatches({ guildId: caseRow.guild_id, query, domains: ["scan_category"], limit: 1 });
    const actual = matches[0]?.correctedOutput ?? "(no reviewed category precedent)";
    const passed = actual.trim().toLowerCase() === caseRow.target_output.trim().toLowerCase();
    return { passed, actualOutput: actual, score: passed ? 10 : 0, notes: passed ? "exact category match" : "top reviewed category precedent mismatched" };
  }
  if (caseRow.outcome_type === "assignment_expectation") {
    const matches = findReviewedPrecedentMatches({ guildId: caseRow.guild_id, query, domains: ["scan_assignment"], limit: 1 });
    const actual = matches[0]?.correctedOutput ?? "(no reviewed assignment precedent)";
    const passed = actual.toLowerCase().includes(caseRow.target_output.trim().toLowerCase());
    return { passed, actualOutput: actual, score: passed ? 8 : 0, notes: passed ? "assignment expectation matched" : "top reviewed assignment precedent mismatched" };
  }
  if (caseRow.outcome_type === "resolution_expectation") {
    const matches = findReviewedPrecedentMatches({ guildId: caseRow.guild_id, query, domains: ["scan_resolution"], limit: 1 });
    const actual = matches[0]?.correctedOutput ?? "(no reviewed resolution precedent)";
    const passed = actual.toLowerCase().includes(caseRow.target_output.trim().toLowerCase());
    return { passed, actualOutput: actual, score: passed ? 8 : 0, notes: passed ? "resolution expectation matched" : "top reviewed resolution precedent mismatched" };
  }
  if (caseRow.outcome_type === "escalate") {
    const reviewed = findReviewedPrecedentMatches({ guildId: caseRow.guild_id, query, limit: 1 });
    const knowledge = findKnowledgeMatches({ guildId: caseRow.guild_id, query, limit: 1 });
    const hasTrustedSupport = reviewed.length > 0 || knowledge.some((match) => match.feedbackKind === "confirmed" || match.feedbackKind === "refined");
    return {
      passed: !hasTrustedSupport,
      actualOutput: hasTrustedSupport ? (reviewed[0]?.correctedOutput ?? knowledge[0]?.answerText ?? "(precedent found)") : "escalate",
      score: hasTrustedSupport ? 0 : 10,
      notes: hasTrustedSupport ? "trusted precedent exists, so benchmark expected escalate failed" : "no trusted precedent found"
    };
  }

  const reviewed = findReviewedPrecedentMatches({
    guildId: caseRow.guild_id,
    query,
    domains: ["chat_answer", "scan_resolution"],
    limit: 2
  });
  const knowledge = findKnowledgeMatches({
    guildId: caseRow.guild_id,
    query,
    limit: 2
  }).filter((match) => match.feedbackKind === "confirmed" || match.feedbackKind === "refined");

  const candidate = reviewed[0]?.correctedOutput ?? knowledge[0]?.answerText ?? "";
  if (!candidate) {
    return { passed: false, actualOutput: "(no trusted answer precedent)", score: 0, notes: "no trusted reviewed precedent or confirmed knowledge match" };
  }
  const judged = await judgeAnswerSufficiency({
    userInput: caseRow.canonical_input,
    candidateAnswer: candidate,
    targetAnswer: caseRow.target_output
  });
  return {
    passed: judged.passed,
    actualOutput: candidate,
    score: judged.score,
    notes: judged.notes
  };
}

export async function runBenchmarkSuite(args: {
  guildId: string;
  triggeredBy: string;
  notes?: string | null;
}): Promise<{ run: BenchmarkRunRow; results: BenchmarkRunResultRow[] }> {
  db.query(
    `INSERT INTO benchmark_runs (guild_id, triggered_by, notes, status)
     VALUES (?, ?, ?, 'running')`
  ).run(args.guildId, args.triggeredBy, args.notes ?? null);
  const inserted = db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  const runId = inserted.id;

  const cases = listBenchmarkCases(args.guildId, "active", 500);
  const results: BenchmarkRunResultRow[] = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const caseRow of cases) {
    const result = await evaluateBenchmarkCase(caseRow);
    if (result.passed) {
      passedCount += 1;
    } else {
      failedCount += 1;
    }
    db.query(
      `INSERT INTO benchmark_run_results (run_id, case_id, family, passed, actual_output, score, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(runId, caseRow.id, caseRow.family, result.passed ? 1 : 0, preview(result.actualOutput, 1_000), result.score, preview(result.notes, 1_000));
  }

  db.query(
    `UPDATE benchmark_runs
        SET status = 'complete',
            active_case_count = ?,
            passed_count = ?,
            failed_count = ?,
            completed_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(cases.length, passedCount, failedCount, runId);

  const runRow = db.query(`SELECT * FROM benchmark_runs WHERE id = ?`).get(runId) as Record<string, unknown>;
  const resultRows = db.query(`SELECT * FROM benchmark_run_results WHERE run_id = ? ORDER BY family ASC, case_id ASC`).all(runId) as Record<string, unknown>[];
  return {
    run: rowToBenchmarkRun(runRow),
    results: resultRows.map(rowToBenchmarkRunResult)
  };
}

export function reviewQueueSummary(guildId: string): {
  byStatus: Array<{ status: string; count: number }>;
  byDomain: Array<{ domain: string; count: number }>;
  repeatedCorrected: ReviewQueueRow[];
  repeatedReinforced: ReviewQueueRow[];
} {
  const byStatus = db.query(
    `SELECT review_status AS status, COUNT(*) AS count
       FROM review_queue
      WHERE guild_id = ?
      GROUP BY review_status
      ORDER BY count DESC`
  ).all(guildId) as Array<{ status: string; count: number }>;
  const byDomain = db.query(
    `SELECT source_domain AS domain, COUNT(*) AS count
       FROM review_queue
      WHERE guild_id = ?
      GROUP BY source_domain
      ORDER BY count DESC`
  ).all(guildId) as Array<{ domain: string; count: number }>;
  const repeatedCorrected = (db.query(
    `SELECT *
       FROM review_queue
      WHERE guild_id = ?
        AND feedback_kind = 'corrected'
      ORDER BY reinforcement_count DESC, updated_at DESC
      LIMIT 10`
  ).all(guildId) as Record<string, unknown>[]).map(rowToReviewQueue);
  const repeatedReinforced = (db.query(
    `SELECT *
       FROM review_queue
      WHERE guild_id = ?
        AND reinforcement_count >= 2
      ORDER BY reinforcement_count DESC, updated_at DESC
      LIMIT 10`
  ).all(guildId) as Record<string, unknown>[]).map(rowToReviewQueue);
  return { byStatus, byDomain, repeatedCorrected, repeatedReinforced };
}

export function benchmarkSummary(guildId: string): {
  casesByStatus: Array<{ status: string; count: number }>;
  weakestFamilies: Array<{ family: string; passRate: number; runCount: number }>;
} {
  const casesByStatus = db.query(
    `SELECT status, COUNT(*) AS count
       FROM benchmark_cases
      WHERE guild_id = ?
      GROUP BY status
      ORDER BY count DESC`
  ).all(guildId) as Array<{ status: string; count: number }>;
  const weakestFamilies = db.query(
    `SELECT benchmark_run_results.family AS family,
            ROUND(100.0 * AVG(benchmark_run_results.passed), 1) AS passRate,
            COUNT(*) AS runCount
       FROM benchmark_run_results
       JOIN benchmark_runs ON benchmark_runs.id = benchmark_run_results.run_id
      WHERE benchmark_runs.guild_id = ?
      GROUP BY benchmark_run_results.family
      ORDER BY passRate ASC, runCount DESC
      LIMIT 10`
  ).all(guildId) as Array<{ family: string; passRate: number; runCount: number }>;
  return { casesByStatus, weakestFamilies };
}
