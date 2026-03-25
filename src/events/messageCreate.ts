import { ChannelType, type Client, type Message } from "discord.js";
import { isChatEnabled, listChatChannels } from "../issues/store";
import { completeText } from "../llm/client";
import { logDebug, logError } from "../utils/logger";
import { extractDefillamaEntityUrl, extractGithubUrl, extractProjectName, preview } from "../utils/text";

const SUPPORT_EMAIL = "support@defillama.com";
const LISTING_DOCS_URL = "https://docs.llama.fi/list-your-project/submit-a-project";
const CHAT_CONTEXT_LIMIT = 6;
const CHAT_CONTEXT_CACHE_MS = 15_000;
const CHAT_COOLDOWN_MS = 5_000;

const contextCache = new Map<string, { expiresAt: number; lines: string[] }>();
const cooldowns = new Map<string, number>();

function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@!?${botUserId}>`, "g"), " ").replace(/\s+/g, " ").trim();
}

function isAllowedChannel(message: Message, allowedChannelIds: Set<string>): boolean {
  if (allowedChannelIds.has(message.channelId)) {
    return true;
  }
  return message.channel.isThread() && Boolean(message.channel.parentId && allowedChannelIds.has(message.channel.parentId));
}

function hasSupportContactQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("how do i get support") ||
    lower.includes("where do i get support") ||
    (lower.includes("support") && (lower.includes("email") || lower.includes("contact") || lower.includes("reach"))) ||
    lower.includes("where can i get support") ||
    lower.includes("what is the support email") ||
    lower.includes("whats the support email") ||
    lower.includes("how do i contact") ||
    lower.includes("what email should i use") ||
    lower.includes("which email should i use")
  );
}

function hasLogoQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("logo") && (lower.includes("update") || lower.includes("change") || lower.includes("legacy"));
}

function hasUpdateCadenceQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes("how often") && lower.includes("update")) ||
    lower.includes("how long till update is reflected") ||
    lower.includes("when will") && lower.includes("reflect") ||
    lower.includes("refresh cadence") ||
    lower.includes("how often data updates")
  );
}

function hasListingQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("how do i list") ||
    lower.includes("how to list") ||
    lower.includes("list a project") ||
    lower.includes("submit a project") ||
    lower.includes("list my project")
  );
}

function isRepoReviewRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "repo",
    "pr",
    "pull request",
    "review",
    "check this",
    "check the pr",
    "have a look",
    "please review",
    "get this merged",
    "merge this"
  ].some((phrase) => lower.includes(phrase));
}

function isLikelySupportScope(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "project",
    "listing",
    "list",
    "submit",
    "tvl",
    "yield",
    "apy",
    "fee",
    "volume",
    "api",
    "adapter",
    "pool",
    "update",
    "logo",
    "support",
    "email",
    "contact",
    "repo",
    "pr",
    "merge",
    "index",
    "bridge",
    "swap",
    "incentive",
    "protocol",
    "missing data",
    "tracking",
    "reflected"
  ].some((phrase) => lower.includes(phrase));
}

function missingProjectResponse(): string {
  return `please first tell me the project name, we'll try to get back to you within 12 hours. there is always ${SUPPORT_EMAIL} if you need more support.`;
}

async function referencedMessage(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId) {
    return null;
  }
  try {
    const referenced = await message.fetchReference();
    return referenced.author.bot ? null : referenced;
  } catch {
    return null;
  }
}

async function recentContext(message: Message): Promise<string[]> {
  const cacheKey = `${message.guildId}:${message.channelId}`;
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.lines;
  }
  if (!("messages" in message.channel)) {
    return [];
  }
  try {
    const recent = await message.channel.messages.fetch({ limit: CHAT_CONTEXT_LIMIT + 1, before: message.id });
    const lines = [...recent.values()]
      .filter((candidate) => !candidate.author.bot)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .slice(-CHAT_CONTEXT_LIMIT)
      .map((candidate) => `${candidate.author.username}: ${candidate.content}`);
    contextCache.set(cacheKey, {
      expiresAt: Date.now() + CHAT_CONTEXT_CACHE_MS,
      lines
    });
    return lines;
  } catch {
    return [];
  }
}

function buildChatPrompt(args: {
  anchor: string;
  invocation: string;
  context: string[];
}): { system: string; user: string } {
  const system = [
    "You are Cria, a public-facing DefiLlama support helper in Discord.",
    "Answer only DefiLlama-related support questions, project submission questions, API/docs questions, or issue-routing questions.",
    "Do not mention internal/admin-only commands such as /cria list.",
    "Do not claim you changed issue state or ran scans.",
    "If you are unsure, ask for the project name or direct the user to support@defillama.com.",
    "Keep replies short, useful, and safe for public channels."
  ].join(" ");
  const user = [
    `Primary message: ${args.anchor}`,
    args.invocation ? `Invocation message: ${args.invocation}` : null,
    args.context.length > 0 ? `Recent context:\n${args.context.join("\n")}` : null
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

async function routeChatReply(message: Message, botUserId: string): Promise<string> {
  const invocation = stripBotMention(message.content, botUserId);
  const referenced = await referencedMessage(message);
  const repliedText = referenced?.content.trim() || null;
  const anchor = repliedText ?? invocation;
  const combined = [anchor, invocation].filter(Boolean).join("\n").trim();
  const githubUrl = extractGithubUrl(combined);
  const defillamaUrl = extractDefillamaEntityUrl(combined);
  const replyTarget = referenced && referenced.author.id !== message.author.id ? `<@${referenced.author.id}>` : null;

  if (hasSupportContactQuestion(combined)) {
    return `you can reach the team at ${SUPPORT_EMAIL}`;
  }

  if (hasLogoQuestion(combined)) {
    return "logo updates usually take a few hours.";
  }

  if (hasUpdateCadenceQuestion(combined)) {
    return "data updates are usually hourly.";
  }

  if (hasListingQuestion(combined)) {
    return `to list a project, use the submission guide: ${LISTING_DOCS_URL}`;
  }

  if (githubUrl && isRepoReviewRequest(combined)) {
    return replyTarget
      ? `issue has been catalogued for ${replyTarget}, we'll try to get back within 12 hours.`
      : "issue has been catalogued, we'll try to get back to you within 12 hours.";
  }

  const projectName = extractProjectName(combined);
  if (!githubUrl && !defillamaUrl && !projectName && isLikelySupportScope(combined)) {
    return replyTarget
      ? `please first tell me the project name for ${replyTarget}, we'll try to get back within 12 hours. there is always ${SUPPORT_EMAIL} if you need more support.`
      : missingProjectResponse();
  }

  if (!isLikelySupportScope(combined)) {
    return `i can help with DefiLlama support questions, project submissions, repo/PR follow-ups, and support routing. you can also reach the team at ${SUPPORT_EMAIL}`;
  }

  const context = await recentContext(message);
  const prompt = buildChatPrompt({ anchor, invocation, context });
  const reply = await completeText(prompt.system, prompt.user);
  return preview(reply, 400);
}

export function registerMessageCreateHandler(client: Client): void {
  client.on("messageCreate", async (message) => {
    if (!client.user || !message.guildId || message.author.bot) {
      return;
    }
    if (!message.mentions.has(client.user)) {
      return;
    }
    if (!isChatEnabled(message.guildId)) {
      return;
    }

    const allowedChannelIds = new Set(listChatChannels(message.guildId));
    if (allowedChannelIds.size === 0 || !isAllowedChannel(message, allowedChannelIds)) {
      return;
    }

    const cooldownKey = `${message.guildId}:${message.channelId}:${message.author.id}`;
    const cooldownUntil = cooldowns.get(cooldownKey) ?? 0;
    if (cooldownUntil > Date.now()) {
      return;
    }
    cooldowns.set(cooldownKey, Date.now() + CHAT_COOLDOWN_MS);

    logDebug("chat.message.received", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      messageId: message.id,
      isReply: Boolean(message.reference?.messageId),
      isThread: message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread
    });

    try {
      await message.channel.sendTyping().catch(() => undefined);
      const reply = await routeChatReply(message, client.user.id);
      await message.reply({
        content: reply,
        allowedMentions: { repliedUser: false }
      });
      logDebug("chat.message.replied", {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        messageId: message.id
      });
    } catch (error) {
      logError("chat.message.failed", error, {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        messageId: message.id
      });
      await message.reply({
        content: `i'm a bit slow right now. please tell me the project name, or reach out at ${SUPPORT_EMAIL}.`,
        allowedMentions: { repliedUser: false }
      }).catch(() => undefined);
    }
  });
}
