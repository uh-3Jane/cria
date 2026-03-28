import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "../db/schema";
import { upsertKnowledgeDocument } from "./store";
import { isLowSignalKnowledgeReply, preview } from "../utils/text";

interface ExportAuthor {
  id: string;
  name: string;
  nickname?: string | null;
  isBot: boolean;
  roles?: Array<string | { name?: string | null }>;
}

interface ExportMessage {
  id: string;
  timestamp: string;
  content: string;
  author: ExportAuthor;
}

interface ExportChannel {
  channel: string;
  messages: ExportMessage[];
}

interface DiscordExportPayload {
  guild: string;
  channels: ExportChannel[];
}

const LLAMA_ROLE_NAME = "llama";
const MAX_LOOKBACK_MESSAGES = 8;
const MAX_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function isLlamaAuthor(author: ExportAuthor): boolean {
  return (author.roles ?? []).some((role) => {
    const name = typeof role === "string" ? role : role?.name;
    return typeof name === "string" && name.toLowerCase() === LLAMA_ROLE_NAME;
  });
}

function parseExport(filePath: string): DiscordExportPayload {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as DiscordExportPayload;
}

function isUsableMessage(message: ExportMessage): boolean {
  return !message.author.isBot && message.content.trim().length >= 5;
}

function contextFor(messages: ExportMessage[], questionIndex: number): string | null {
  const start = Math.max(0, questionIndex - 2);
  const lines = messages
    .slice(start, questionIndex)
    .filter((message) => isUsableMessage(message))
    .map((message) => `${message.author.nickname || message.author.name}: ${preview(message.content, 220)}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

function findQuestion(messages: ExportMessage[], answerIndex: number): { message: ExportMessage; index: number } | null {
  const answer = messages[answerIndex];
  const answerTs = Date.parse(answer.timestamp);

  for (let offset = 1; offset <= MAX_LOOKBACK_MESSAGES; offset += 1) {
    const index = answerIndex - offset;
    if (index < 0) {
      break;
    }
    const candidate = messages[index];
    if (!isUsableMessage(candidate) || isLlamaAuthor(candidate.author)) {
      continue;
    }
    const candidateTs = Date.parse(candidate.timestamp);
    if (Number.isFinite(answerTs) && Number.isFinite(candidateTs) && (answerTs - candidateTs) > MAX_LOOKBACK_MS) {
      break;
    }
    return { message: candidate, index };
  }

  return null;
}

function main(): void {
  const filePath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(process.cwd(), "defillama-discord-export.json");

  migrate();
  const payload = parseExport(filePath);
  let inserted = 0;

  for (const channel of payload.channels) {
    const messages = [...channel.messages]
      .filter((message) => isUsableMessage(message))
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

    for (const [index, message] of messages.entries()) {
      if (!isLlamaAuthor(message.author) || isLowSignalKnowledgeReply(message.content)) {
        continue;
      }

      const question = findQuestion(messages, index);
      if (!question) {
        continue;
      }

      upsertKnowledgeDocument({
        guildId: payload.guild,
        channelId: channel.channel,
        conversationKey: question.message.id,
        questionMessageId: question.message.id,
        answerMessageId: message.id,
        questionAuthorId: question.message.author.id,
        questionAuthorName: question.message.author.nickname || question.message.author.name,
        answerAuthorId: message.author.id,
        answerAuthorName: message.author.nickname || message.author.name,
        questionText: question.message.content,
        contextText: contextFor(messages, question.index),
        answerText: message.content,
        source: "backfill"
      });
      inserted += 1;
    }
  }

  console.log(JSON.stringify({
    event: "knowledge.backfill.complete",
    guild: payload.guild,
    inserted
  }));
}

main();
