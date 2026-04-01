import { completeJson } from "../llm/client";
import { findKnowledgeMatches } from "../knowledge/store";
import { findReviewedPrecedentMatches, findTrustedValidatedAnswerMatches } from "../review/store";
import type { Category, FetchedMessage, ItemMessageRole, TraceKind, TraceState, TraceStateConfidence, Urgency } from "../types";
import { logError } from "../utils/logger";
import { preview } from "../utils/text";

export interface TraceTriageMessage {
  message: FetchedMessage;
  role: ItemMessageRole;
}

export interface TraceTriageResult {
  traceKind: TraceKind;
  traceState: TraceState;
  primaryIssueMessageId: string | null;
  strongestAnswerMessageId: string | null;
  category: Category;
  urgency: Urgency;
  confidence: TraceStateConfidence;
  reasonTags: string[];
}

function parseResult(raw: unknown, allowedCategories: string[]): TraceTriageResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const payload = raw as Record<string, unknown>;
  const traceKind = typeof payload.trace_kind === "string" ? payload.trace_kind : null;
  const traceState = typeof payload.trace_state === "string" ? payload.trace_state : null;
  const primaryIssueMessageId = typeof payload.primary_issue_message_id === "string" ? payload.primary_issue_message_id : null;
  const strongestAnswerMessageId = typeof payload.strongest_answer_message_id === "string" ? payload.strongest_answer_message_id : null;
  const category = typeof payload.category === "string" ? payload.category : "general";
  const urgency = typeof payload.urgency === "string" ? payload.urgency : null;
  const confidence = typeof payload.confidence === "string" ? payload.confidence : null;
  const reasonTags = Array.isArray(payload.reason_tags)
    ? payload.reason_tags.filter((value): value is string => typeof value === "string").slice(0, 8)
    : [];
  if (
    (traceKind === "actionable" || traceKind === "non_actionable" || traceKind === "unclear")
    && (traceState === "open" || traceState === "likely_handled" || traceState === "resolved_by_trace" || traceState === "unclear")
    && (urgency === "low" || urgency === "medium" || urgency === "high")
    && (confidence === "low" || confidence === "medium" || confidence === "high")
  ) {
    return {
      traceKind,
      traceState,
      primaryIssueMessageId,
      strongestAnswerMessageId,
      category: allowedCategories.includes(category) ? category : "general",
      urgency,
      confidence,
      reasonTags
    };
  }
  return null;
}

function fallbackResult(messages: TraceTriageMessage[], allowedCategories: string[]): TraceTriageResult {
  const userMessages = messages.filter((entry) => entry.role === "user");
  const answer = [...messages].reverse().find((entry) => entry.role === "llama" || entry.role === "team") ?? null;
  const primary = [...userMessages].reverse().find((entry) => entry.message.content.includes("?")) ?? userMessages[userMessages.length - 1] ?? messages[0] ?? null;
  const category: Category = allowedCategories.includes("general") ? "general" : allowedCategories[0] ?? "general";
  return {
    traceKind: primary ? "actionable" : "unclear",
    traceState: answer ? "likely_handled" : "open",
    primaryIssueMessageId: primary?.message.messageId ?? null,
    strongestAnswerMessageId: answer?.message.messageId ?? null,
    category,
    urgency: "medium",
    confidence: "low",
    reasonTags: answer ? ["fallback_answer_present"] : ["fallback_open"]
  };
}

export async function triageConversationTrace(args: {
  guildId: string;
  messages: TraceTriageMessage[];
  allowedCategories: string[];
}): Promise<TraceTriageResult> {
  const combined = args.messages.map((entry) => entry.message.content).join("\n");
  const reviewedMatches = findReviewedPrecedentMatches({
    guildId: args.guildId,
    query: combined,
    domains: ["scan_category", "scan_resolution", "scan_assignment", "scan_false_positive"],
    limit: 2
  });
  const validatedMatches = findTrustedValidatedAnswerMatches({
    guildId: args.guildId,
    query: combined,
    limit: 2
  });
  const knowledgeMatches = findKnowledgeMatches({
    guildId: args.guildId,
    query: combined,
    excludeMessageIds: args.messages.map((entry) => entry.message.messageId),
    limit: 2
  });

  const system = [
    "You triage a bounded Discord conversation trace for DefiLlama support operations.",
    "Return JSON only with keys: trace_kind, trace_state, primary_issue_message_id, strongest_answer_message_id, category, urgency, confidence, reason_tags.",
    "trace_kind must be one of: actionable, non_actionable, unclear.",
    "trace_state must be one of: open, likely_handled, resolved_by_trace, unclear.",
    "category must be one of the allowed categories when actionable, otherwise use general.",
    "urgency must be low, medium, or high.",
    "confidence must be low, medium, or high.",
    "reason_tags must be a short array of snake_case tags, not prose.",
    "Choose primary_issue_message_id as the latest unresolved user-side problem statement, not a thank-you or acknowledgement.",
    "Choose strongest_answer_message_id as the strongest later llama/team answer when one exists.",
    "If a later authoritative answer appears to handle the issue, prefer likely_handled.",
    "Use resolved_by_trace only when the later answer appears definitive and there is no later contradictory user follow-up.",
    "Use non_actionable when the trace is casual chat, pure acknowledgement, or otherwise should not surface as an issue."
  ].join(" ");

  const user = [
    `Allowed categories: ${args.allowedCategories.join(", ")}`,
    `Trace messages:\n${args.messages.map((entry) => `- ${entry.message.messageId} | ${entry.role} | ${entry.message.authorName} | ${entry.message.createdAt}: ${preview(entry.message.content, 280)}`).join("\n")}`,
    `Reviewed precedents:\n${reviewedMatches.length > 0 ? reviewedMatches.map((match) => `- ${match.domain} | ${preview(match.inputText, 180)} | ${preview(match.correctedOutput, 180)} | ${match.feedbackKind}`).join("\n") : "(none)"}`,
    `Validated trace matches:\n${validatedMatches.length > 0 ? validatedMatches.map((match) => `- ${preview(match.inputText, 180)} | answer: ${preview(match.answerText, 180)} | confirmations: ${match.confirmationCount} | corrections: ${match.correctionCount}`).join("\n") : "(none)"}`,
    `Knowledge matches:\n${knowledgeMatches.length > 0 ? knowledgeMatches.map((match) => `- q: ${preview(match.questionText, 180)} | a: ${preview(match.answerText, 180)}`).join("\n") : "(none)"}`
  ].join("\n\n");

  try {
    const parsed = parseResult(await completeJson(system, user), args.allowedCategories);
    if (parsed) {
      return parsed;
    }
  } catch (error) {
    logError("scan.trace_triage.failed", error, {
      guildId: args.guildId,
      messageIds: args.messages.map((entry) => entry.message.messageId)
    });
  }

  return fallbackResult(args.messages, args.allowedCategories);
}
