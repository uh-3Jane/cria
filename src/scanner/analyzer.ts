import { config } from "../config";
import { completeJson } from "../llm/client";
import type { FetchedMessage, LlmIssueCandidate } from "../types";
import { logDebug, logError } from "../utils/logger";

const MAX_PROMPT_CHARS = 16_000;

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

Do NOT flag:
- General conversation, greetings, or banter
- Messages that are clearly already answered inside the same local context window by a human team member
- Bot commands or bot output
- Messages that are just reactions, emojis, or very short acknowledgements
- Generic help wrappers like "i need help", "@cria help him", "please assist", "requests help", or support-email asks without a specific issue

Important: If the only reply is from CriaBot, treat the user message as still needing a response.

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
  const batches = chunk(messages, config.batchSize);
  const all: LlmIssueCandidate[] = [];
  let skippedBatches = 0;
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
