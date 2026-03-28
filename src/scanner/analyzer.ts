import { config } from "../config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findKnowledgeMatches } from "../knowledge/store";
import { completeJson } from "../llm/client";
import type { FetchedMessage, LlmIssueCandidate } from "../types";
import { logDebug, logError } from "../utils/logger";
import { extractDefillamaEntityUrl, extractGithubUrls, extractProjectName, preview, sharedTokenCount } from "../utils/text";

const MAX_PROMPT_CHARS = 16_000;
const MAX_PRECEDENTS = 2;
const TRAINING_DOCS_PATH = resolve(process.cwd(), "docs/chat_training_docs.md");
let faqDocCache: string | null | undefined;

interface ScanCaseFeatures {
  githubUrls: string[];
  hasGithubPull: boolean;
  hasDefillamaUrl: boolean;
  mentionsCria: boolean;
  asksQuestion: boolean;
  unresolvedFollowUp: boolean;
  reviewRequest: boolean;
  waitingComplaint: boolean;
  explicitSupportAsk: boolean;
  projectName: string | null;
  inferredCategory: string | null;
  heuristicSummary: string | null;
}

function trainingDocs(): string | null {
  if (faqDocCache !== undefined) {
    return faqDocCache;
  }
  try {
    faqDocCache = readFileSync(TRAINING_DOCS_PATH, "utf8");
  } catch {
    faqDocCache = null;
  }
  return faqDocCache;
}

function faqMatchesForQuery(query: string): string[] {
  const raw = trainingDocs();
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => ({
      line: line.slice(2).trim(),
      score: sharedTokenCount(query, line)
    }))
    .filter((entry) => entry.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((entry) => entry.line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function classifyRepoCategory(urls: string[]): string | null {
  const lower = urls.map((url) => url.toLowerCase());
  if (lower.some((url) => url.includes("/dimension-adapters/"))) {
    return "fees_volume";
  }
  if (lower.some((url) => url.includes("/defillama-adapters/"))) {
    return "tvl";
  }
  if (lower.some((url) => url.includes("/yield-server/"))) {
    return "yields";
  }
  if (lower.some((url) => url.includes("/defillama-app/") || url.includes("/defillama-server/"))) {
    return "ui";
  }
  return null;
}

function extractScanCaseFeatures(message: FetchedMessage): ScanCaseFeatures {
  const lower = message.content.toLowerCase();
  const githubUrls = extractGithubUrls(message.content);
  const unresolvedPhrases = [
    "still waiting",
    "still not",
    "still broken",
    "still missing",
    "still incorrect",
    "merged, but",
    "merged but",
    "any update",
    "is someone looking",
    "can someone check",
    "can you check",
    "waiting for",
    "from last",
    "review this",
    "review these",
    "pending review"
  ];
  const reviewPhrases = [
    "review",
    "merged",
    "pr",
    "pull request",
    "look at this",
    "looking at this",
    "waiting for these"
  ];
  const supportAskPhrases = [
    "please check",
    "can someone",
    "can you",
    "help",
    "issue",
    "wrong",
    "stale",
    "broken",
    "missing",
    "outdated"
  ];

  const unresolvedFollowUp = unresolvedPhrases.some((phrase) => lower.includes(phrase));
  const reviewRequest = reviewPhrases.some((phrase) => lower.includes(phrase));
  const waitingComplaint = /(?:\b\d+\s*(?:day|days|hour|hours)\b)/i.test(message.content) || lower.includes("waiting");
  const mentionsCria = /<@!?\d+>/.test(message.content);
  const hasGithubPull = githubUrls.some((url) => /\/pull\/\d+/i.test(url));
  const hasDefillamaUrl = Boolean(extractDefillamaEntityUrl(message.content));
  const projectName = extractProjectName(message.content);
  const explicitSupportAsk = supportAskPhrases.some((phrase) => lower.includes(phrase));
  const asksQuestion = message.content.includes("?") || explicitSupportAsk;
  const inferredCategory = classifyRepoCategory(githubUrls);

  let heuristicSummary: string | null = null;
  if (hasGithubPull && (unresolvedFollowUp || reviewRequest || waitingComplaint)) {
    heuristicSummary = projectName
      ? `${projectName} follow-up is still waiting on linked GitHub PR review or propagation`
      : "User is following up on linked GitHub PRs that are still unresolved or waiting on review";
  } else if (hasDefillamaUrl && (asksQuestion || explicitSupportAsk)) {
    heuristicSummary = projectName
      ? `${projectName} has a DefiLlama data or listing issue that needs review`
      : "User reported a DefiLlama data or listing issue that needs review";
  }

  return {
    githubUrls,
    hasGithubPull,
    hasDefillamaUrl,
    mentionsCria,
    asksQuestion,
    unresolvedFollowUp,
    reviewRequest,
    waitingComplaint,
    explicitSupportAsk,
    projectName,
    inferredCategory,
    heuristicSummary
  };
}

function deterministicCandidate(message: FetchedMessage, categories: string[]): LlmIssueCandidate | null {
  const features = extractScanCaseFeatures(message);
  const faqMatches = faqMatchesForQuery(message.content);
  const knowledgeMatches = findKnowledgeMatches({
    guildId: message.guildId,
    query: message.content,
    excludeMessageIds: [message.messageId],
    limit: MAX_PRECEDENTS
  });
  if (features.hasGithubPull && (features.unresolvedFollowUp || features.reviewRequest || features.waitingComplaint)) {
    const category = features.inferredCategory && categories.includes(features.inferredCategory)
      ? features.inferredCategory
      : "general";
    return {
      message_id: message.messageId,
      related_message_ids: [],
      user_id: message.authorId,
      username: message.authorName,
      summary: features.heuristicSummary ?? "User is asking for follow-up on unresolved GitHub PRs",
      category,
      urgency: features.waitingComplaint || features.unresolvedFollowUp ? "high" : "medium"
    };
  }
  if (features.hasDefillamaUrl && features.asksQuestion && features.explicitSupportAsk) {
    const category = features.inferredCategory && categories.includes(features.inferredCategory)
      ? features.inferredCategory
      : "general";
    return {
      message_id: message.messageId,
      related_message_ids: [],
      user_id: message.authorId,
      username: message.authorName,
      summary: features.heuristicSummary ?? "User reported a DefiLlama page or data issue",
      category,
      urgency: "medium"
    };
  }
  if (features.mentionsCria && features.asksQuestion && faqMatches.length === 0 && knowledgeMatches.length === 0) {
    return {
      message_id: message.messageId,
      related_message_ids: [],
      user_id: message.authorId,
      username: message.authorName,
      summary: features.projectName
        ? `${features.projectName} needs a llama follow-up because the request is not covered by known docs`
        : "User asked a new question that needs llama follow-up",
      category: "general",
      urgency: "medium"
    };
  }
  return null;
}

function featureLines(message: FetchedMessage): string[] {
  const features = extractScanCaseFeatures(message);
  return [
    `github_urls: ${features.githubUrls.length > 0 ? features.githubUrls.join(", ") : "(none)"}`,
    `has_github_pull: ${features.hasGithubPull}`,
    `has_defillama_url: ${features.hasDefillamaUrl}`,
    `mentions_cria: ${features.mentionsCria}`,
    `asks_question: ${features.asksQuestion}`,
    `unresolved_follow_up: ${features.unresolvedFollowUp}`,
    `review_request: ${features.reviewRequest}`,
    `waiting_complaint: ${features.waitingComplaint}`,
    `explicit_support_ask: ${features.explicitSupportAsk}`,
    `project_name: ${features.projectName ?? "(none)"}`,
    `suggested_category: ${features.inferredCategory ?? "general"}`
  ];
}

function precedentLines(message: FetchedMessage): string {
  const matches = findKnowledgeMatches({
    guildId: message.guildId,
    query: message.content,
    excludeMessageIds: [message.messageId],
    limit: MAX_PRECEDENTS
  });
  if (matches.length === 0) {
    return "(none)";
  }
  return matches
    .map((match, index) => [
      `precedent_${index + 1}_question: ${preview(match.questionText, 220)}`,
      `precedent_${index + 1}_answer: ${preview(match.answerText, 260)}`,
      `precedent_${index + 1}_author: ${match.answerAuthorName}`,
      `precedent_${index + 1}_score: ${match.score}`
    ].join("\n"))
    .join("\n");
}

function batchPrompt(messages: FetchedMessage[], compact = false): string {
  const blocks = messages.map((message, index) => {
    const beforeLines = compact ? message.contextBefore.slice(-1) : message.contextBefore;
    const afterLines = compact ? message.contextAfter.slice(0, 1) : message.contextAfter;
    const before = beforeLines.length > 0 ? beforeLines.join("\n") : "(none)";
    const after = afterLines.length > 0 ? afterLines.join("\n") : "(none)";
    const content = compact && message.content.length > 500 ? `${message.content.slice(0, 497)}...` : message.content;
    return [
      `Message ${index + 1}`,
      `message_id: ${message.messageId}`,
      `user_id: ${message.authorId}`,
      `username: ${message.authorName}`,
      `channel: #${message.channelName}`,
      `timestamp: ${message.createdAt}`,
      `content: ${JSON.stringify(content)}`,
      `signals:\n${featureLines(message).join("\n")}`,
      `similar_llama_cases:\n${precedentLines(message)}`,
      `before:\n${before}`,
      `after:\n${after}`
    ].join("\n");
  });
  return `${blocks.join("\n\n---\n\n")}\n\nReturn JSON as {"items":[...]} only.`;
}

function systemPrompt(categories: string[]): string {
  const allowedCategories = Array.from(new Set([...categories, "general"]));
  const categoryList = allowedCategories.map((category) => `"${category}"`).join(" | ");
  return `You are a support triage assistant for DefiLlama, a DeFi analytics platform.
You will receive a batch of Discord messages from a public channel.

Identify messages that contain:
- Questions or requests that need a team member's response
- Bug reports or data issues (wrong TVL, missing protocol, broken page)
- Feature requests or integration asks
- Listing requests from project teams
- Complaints about incorrect or stale data
- Unresolved GitHub PR follow-ups, review waits, or "merged but still broken" escalations

Do NOT flag:
- General conversation, greetings, or banter
- Messages that are clearly already answered inside the same local context window by a human team member
- Bot commands or bot output
- Messages that are just reactions, emojis, or very short acknowledgements
- Generic help wrappers like "i need help", "@cria help him", "please assist", "requests help", or support-email asks without a specific issue

Important: If the only reply is from CriaBot, treat the user message as still needing a response.
You will also receive extracted support signals and similar llama precedents. Use those as evidence.
If a message has linked GitHub PRs plus unresolved follow-up language like "merged but", "still waiting", "any update", or "is someone looking at this?", prefer flagging it as an actionable repo follow-up.

If the same user raises the same topic across multiple messages in this batch,
group them into ONE entry. Use the earliest message_id as the primary,
and list all other related_message_ids.

For each flagged issue return:
{
  "message_id": "...",
  "related_message_ids": ["...", "..."],
  "user_id": "...",
  "username": "...",
  "summary": "One-line summary of what they need",
  "category": ${categoryList},
  "urgency": "high" | "medium" | "low"
}`;
}

export async function analyzeMessages(
  messages: FetchedMessage[],
  categories: string[],
  onBatch?: (current: number, total: number) => Promise<void> | void
): Promise<{ items: LlmIssueCandidate[]; skippedBatches: number }> {
  const deterministic = messages
    .map((message) => deterministicCandidate(message, categories))
    .filter((candidate): candidate is LlmIssueCandidate => Boolean(candidate));
  const deterministicIds = new Set(deterministic.map((candidate) => candidate.message_id));
  const ambiguousMessages = messages.filter((message) => !deterministicIds.has(message.messageId));
  const batches = chunk(ambiguousMessages, config.batchSize);
  const all: LlmIssueCandidate[] = [...deterministic];
  let skippedBatches = 0;
  logDebug("scan.preclassify.complete", {
    totalMessages: messages.length,
    deterministicItems: deterministic.length,
    ambiguousMessages: ambiguousMessages.length
  });
  for (const [index, batch] of batches.entries()) {
    await onBatch?.(index + 1, batches.length);
    let items: LlmIssueCandidate[] = [];
    try {
      items = await analyzeBatchWithFallback({
        batch,
        categories,
        batchCurrent: index + 1,
        batchTotal: batches.length,
        depth: 0
      });
    } catch (error) {
      skippedBatches += 1;
      logError("scan.batch.skipped", error, {
        batchCurrent: index + 1,
        batchTotal: batches.length,
        batchSize: batch.length
      });
    }
    all.push(...items);
    logDebug("scan.batch.analyze.success", {
      batchCurrent: index + 1,
      batchTotal: batches.length,
      batchSize: batch.length,
      itemsReturned: items.length
    });
    if (index < batches.length - 1 && config.batchDelayMs > 0) {
      logDebug("scan.batch.delay", {
        nextBatch: index + 2,
        batchTotal: batches.length,
        delayMs: config.batchDelayMs
      });
      await sleep(config.batchDelayMs);
    }
  }
  return { items: all, skippedBatches };
}

async function analyzeBatchWithFallback(args: {
  batch: FetchedMessage[];
  categories: string[];
  batchCurrent: number;
  batchTotal: number;
  depth: number;
}): Promise<LlmIssueCandidate[]> {
  const { batch, categories, batchCurrent, batchTotal, depth } = args;
  logDebug("scan.batch.analyze.start", {
    batchCurrent,
    batchTotal,
    batchSize: batch.length,
    depth
  });

  try {
    const prompt = batchPrompt(batch);
    if (prompt.length > MAX_PROMPT_CHARS && batch.length > 1) {
      throw new Error("prompt too large");
    }
    const payload = await completeJson(systemPrompt(categories), prompt.length > MAX_PROMPT_CHARS ? batchPrompt(batch, true) : prompt);
    return Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items as LlmIssueCandidate[])
      : Array.isArray(payload)
        ? (payload as LlmIssueCandidate[])
        : [];
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const shouldSplit = batch.length > 1 && (message.includes("timeout") || message.includes("timed out") || message.includes("prompt too large"));
    logError("scan.batch.analyze.failed", error, {
      batchCurrent,
      batchTotal,
      batchSize: batch.length,
      depth,
      shouldSplit
    });

    if (!shouldSplit) {
      throw error;
    }

    const midpoint = Math.ceil(batch.length / 2);
    const left = batch.slice(0, midpoint);
    const right = batch.slice(midpoint);
    logDebug("scan.batch.analyze.split", {
      batchCurrent,
      batchTotal,
      batchSize: batch.length,
      leftSize: left.length,
      rightSize: right.length,
      depth
    });
    const leftItems = await analyzeBatchWithFallback({
      batch: left,
      categories,
      batchCurrent,
      batchTotal,
      depth: depth + 1
    });
    const rightItems = await analyzeBatchWithFallback({
      batch: right,
      categories,
      batchCurrent,
      batchTotal,
      depth: depth + 1
    });
    return [...leftItems, ...rightItems];
  }
}
