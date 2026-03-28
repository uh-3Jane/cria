import { db } from "../db/client";
import type { KnowledgeDocumentRow, KnowledgeMatch } from "../types";
import { contentFingerprint, extractGithubPullKey, extractGithubUrl, preview, sharedTokenCount } from "../utils/text";

interface CreateKnowledgeDocumentInput {
  guildId: string;
  channelId: string;
  conversationKey: string;
  questionMessageId: string;
  answerMessageId: string;
  questionAuthorId: string;
  questionAuthorName: string;
  answerAuthorId: string;
  answerAuthorName: string;
  questionText: string;
  contextText: string | null;
  answerText: string;
  source: "live" | "backfill";
}

function rowToKnowledgeDocument(row: Record<string, unknown>): KnowledgeDocumentRow {
  const requiredString = (key: keyof KnowledgeDocumentRow): string => {
    const value = row[key as string];
    if (typeof value !== "string") {
      throw new Error(`invalid knowledge row: ${String(key)}`);
    }
    return value;
  };
  const optionalString = (key: keyof KnowledgeDocumentRow): string | null => {
    const value = row[key as string];
    return typeof value === "string" ? value : null;
  };
  const requiredNumber = (key: keyof KnowledgeDocumentRow): number => {
    const value = row[key as string];
    if (typeof value !== "number") {
      throw new Error(`invalid knowledge row: ${String(key)}`);
    }
    return value;
  };

  return {
    id: requiredNumber("id"),
    guild_id: requiredString("guild_id"),
    channel_id: requiredString("channel_id"),
    conversation_key: requiredString("conversation_key"),
    question_message_id: requiredString("question_message_id"),
    answer_message_id: requiredString("answer_message_id"),
    question_author_id: requiredString("question_author_id"),
    question_author_name: requiredString("question_author_name"),
    answer_author_id: requiredString("answer_author_id"),
    answer_author_name: requiredString("answer_author_name"),
    question_text: requiredString("question_text"),
    context_text: optionalString("context_text"),
    answer_text: requiredString("answer_text"),
    combined_text: requiredString("combined_text"),
    content_fingerprint: requiredString("content_fingerprint"),
    source: requiredString("source") as KnowledgeDocumentRow["source"],
    created_at: requiredString("created_at"),
    updated_at: requiredString("updated_at")
  };
}

function combinedKnowledgeText(input: {
  questionText: string;
  contextText: string | null;
  answerText: string;
}): string {
  return [
    `Question: ${preview(input.questionText, 500)}`,
    input.contextText ? `Context: ${preview(input.contextText, 700)}` : null,
    `Answer: ${preview(input.answerText, 700)}`
  ].filter(Boolean).join("\n");
}

export function upsertKnowledgeDocument(input: CreateKnowledgeDocumentInput): number {
  const normalizedQuestion = preview(input.questionText, 1_000);
  const normalizedContext = input.contextText ? preview(input.contextText, 1_500) : null;
  const normalizedAnswer = preview(input.answerText, 1_500);
  const combinedText = combinedKnowledgeText({
    questionText: normalizedQuestion,
    contextText: normalizedContext,
    answerText: normalizedAnswer
  });
  const fingerprint = contentFingerprint(`${input.guildId}\n${normalizedQuestion}\n${normalizedAnswer}`);

  db.query(
    `INSERT INTO knowledge_documents (
      guild_id,
      channel_id,
      conversation_key,
      question_message_id,
      answer_message_id,
      question_author_id,
      question_author_name,
      answer_author_id,
      answer_author_name,
      question_text,
      context_text,
      answer_text,
      combined_text,
      content_fingerprint,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, answer_message_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      conversation_key = excluded.conversation_key,
      question_message_id = excluded.question_message_id,
      question_author_id = excluded.question_author_id,
      question_author_name = excluded.question_author_name,
      answer_author_id = excluded.answer_author_id,
      answer_author_name = excluded.answer_author_name,
      question_text = excluded.question_text,
      context_text = excluded.context_text,
      answer_text = excluded.answer_text,
      combined_text = excluded.combined_text,
      content_fingerprint = excluded.content_fingerprint,
      source = excluded.source,
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    input.guildId,
    input.channelId,
    input.conversationKey,
    input.questionMessageId,
    input.answerMessageId,
    input.questionAuthorId,
    input.questionAuthorName,
    input.answerAuthorId,
    input.answerAuthorName,
    normalizedQuestion,
    normalizedContext,
    normalizedAnswer,
    combinedText,
    fingerprint,
    input.source
  );

  const row = db.query(
    `SELECT id
       FROM knowledge_documents
      WHERE guild_id = ? AND answer_message_id = ?
      LIMIT 1`
  ).get(input.guildId, input.answerMessageId) as { id: number } | null;

  if (!row) {
    throw new Error("failed to upsert knowledge document");
  }
  return row.id;
}

export function findKnowledgeMatches(args: {
  guildId: string;
  query: string;
  excludeMessageIds?: string[];
  limit?: number;
}): KnowledgeMatch[] {
  const rows = db.query(
    `SELECT *
       FROM knowledge_documents
      WHERE guild_id = ?
      ORDER BY updated_at DESC
      LIMIT 300`
  ).all(args.guildId) as Record<string, unknown>[];

  const excluded = new Set(args.excludeMessageIds ?? []);
  const githubUrl = extractGithubUrl(args.query);
  const githubPullKey = extractGithubPullKey(args.query);
  const matches = rows
    .map(rowToKnowledgeDocument)
    .filter((row) => !excluded.has(row.question_message_id) && !excluded.has(row.answer_message_id))
    .map((row) => {
      let score = sharedTokenCount(args.query, row.question_text) * 4;
      score += sharedTokenCount(args.query, row.answer_text) * 2;
      if (row.context_text) {
        score += sharedTokenCount(args.query, row.context_text);
      }
      if (githubUrl && row.combined_text.includes(githubUrl)) {
        score += 8;
      }
      if (githubPullKey && extractGithubPullKey(row.combined_text) === githubPullKey) {
        score += 10;
      }
      return { row, score };
    })
    .filter((entry) => entry.score >= 4)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, args.limit ?? 3))
    .map(({ row, score }) => ({
      id: row.id,
      questionText: row.question_text,
      contextText: row.context_text,
      answerText: row.answer_text,
      answerAuthorName: row.answer_author_name,
      score
    }));

  return matches;
}
