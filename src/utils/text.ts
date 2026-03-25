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

export function isLowSignalHelpMessage(text: string): boolean {
  if (extractGithubUrl(text) || extractDefillamaEntityUrl(text) || extractProjectName(text)) {
    return false;
  }

  const normalized = normalizeHelpText(text);
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
    "check this",
    "where can i get support",
    "how do i get support",
    "what email should i use",
    "what support email should i use"
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
