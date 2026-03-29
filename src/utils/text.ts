import { createHash } from "node:crypto";

const stopwords = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "is", "it",
  "this", "that", "we", "i", "my", "our", "your", "can", "could", "please", "have",
  "has", "had", "about", "from", "are", "was", "were", "be", "been", "still", "need"
]);

export function preview(text: string, length = 200): string {
  const collapsed = text
    .replace(/@everyone/g, "@ everyone")
    .replace(/@here/g, "@ here")
    .replace(/<@!?(\d+)>/g, "@user")
    .replace(/<#(\d+)>/g, "#channel")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length <= length ? collapsed : `${collapsed.slice(0, length - 1)}…`;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9#:/._-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

export function sharedTokenCount(left: string, right: string): number {
  const l = new Set(tokenize(left));
  const r = new Set(tokenize(right));
  let count = 0;
  for (const token of l) {
    if (r.has(token)) {
      count += 1;
    }
  }
  return count;
}

export function likelySameTopic(left: string, right: string): boolean {
  const leftRef = extractReference(left);
  const rightRef = extractReference(right);
  if (leftRef && rightRef && leftRef === rightRef) {
    return true;
  }

  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  const overlap = sharedTokenCount(left, right);
  if (overlap >= 4) {
    return true;
  }

  const normalizedLeft = left
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedRight = right
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }

  const smallerSetSize = Math.min(leftTokens.size, rightTokens.size);
  if (smallerSetSize <= 4 && overlap >= Math.max(2, smallerSetSize - 1)) {
    return true;
  }

  return false;
}

export function extractReference(text: string): string | null {
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (url) {
    return url.toLowerCase();
  }
  const pr = text.match(/#\d+/)?.[0];
  if (pr) {
    return pr.toLowerCase();
  }
  const protocol = text.match(/\b[a-z0-9-]{3,}\b/gi)?.find((token) => token.includes("-"));
  return protocol?.toLowerCase() ?? null;
}

export function fingerprint(summary: string): string {
  return tokenize(summary).slice(0, 8).join("|");
}

export function contentFingerprint(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha1").update(normalized).digest("hex");
}

export function extractGithubUrl(text: string): string | null {
  const match = text.match(/https?:\/\/github\.com\/[^\s)]+/i)?.[0];
  return match ?? null;
}

export function extractGithubUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/github\.com\/[^\s)]+/gi) ?? [];
  return Array.from(new Set(matches));
}

export function extractGithubPullKey(text: string): string | null {
  const url = extractGithubUrl(text);
  if (!url) {
    return null;
  }
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) {
    return null;
  }
  const [, owner, repo, pr] = match;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${pr}`;
}

export function extractDefillamaEntityUrl(text: string): string | null {
  const match = text.match(/https?:\/\/(?:www\.)?defillama\.com\/(?:yields\/pool|protocol|dexs|chains|fees|yields)[^\s)]*/i)?.[0];
  return match ?? null;
}

export function extractProjectName(text: string): string | null {
  const patterns = [
    /\bfor\s+([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,3})\b/,
    /\bfrom\s+the\s+([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,3})\s+team\b/i,
    /\bproject:\s*([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,3})\b/i,
    /\b([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,2})\s+(?:farm|pool|vault|protocol)\b/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function normalizeHelpText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isWeakFollowUpText(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/^<@!?\d+>\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  const exactWeakPhrases = new Set([
    "we back",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "got it",
    "sounds good",
    "nice",
    "gm",
    "yep",
    "yes",
    "no"
  ]);

  if (exactWeakPhrases.has(normalized)) {
    return true;
  }

  const tokens = tokenize(normalized);
  if (tokens.length <= 2) {
    return true;
  }

  return false;
}

export function isLowSignalHelpMessage(text: string): boolean {
  if (extractGithubUrl(text) || extractDefillamaEntityUrl(text) || extractProjectName(text)) {
    return false;
  }

  const normalized = normalizeHelpText(text);
  const faqSignals = [
    "support email",
    "support@",
    "what's the support email",
    "whats the support email",
    "logo update",
    "update my logo",
    "data update",
    "data updates",
    "how often data updates",
    "how often data update",
    "hourly"
  ];
  if (faqSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }
  const technicalSignals = [
    "tvl",
    "yield",
    "apy",
    "fee",
    "volume",
    "api",
    "adapter",
    "pool",
    "vault",
    "farm",
    "protocol",
    "listing",
    "logo",
    "merge",
    "repo",
    "pr",
    "support email",
    "support@",
    "hourly",
    "reflected"
  ];
  if (technicalSignals.some((signal) => normalized.includes(signal))) {
    return false;
  }

  const vaguePhrases = [
    "i need help",
    "help please",
    "please help",
    "can someone help",
    "who can help me",
    "please assist",
    "pls help",
    "pls check",
    "help him",
    "requests help",
    "asks to help someone else",
    "can you look at this",
    "check this"
  ];

  if (vaguePhrases.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 4 && tokens.some((token) => token === "help" || token === "assist" || token === "support")) {
    return true;
  }

  return false;
}

export function isLowSignalKnowledgeReply(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  const exactPhrases = new Set([
    "checking",
    "looking",
    "looking now",
    "on it",
    "will check",
    "checking now",
    "fixed",
    "done",
    "resolved",
    "ok",
    "okay",
    "thanks"
  ]);
  if (exactPhrases.has(normalized)) {
    return true;
  }

  const tokens = tokenize(normalized);
  if (tokens.length <= 3) {
    return true;
  }

  return false;
}
