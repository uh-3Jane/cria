import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./types";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid numeric env var ${name}`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`invalid boolean env var ${name}`);
}

function optionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const config: Config = {
  discordToken: required("DISCORD_TOKEN"),
  applicationId: required("APPLICATION_ID"),
  guildId: process.env.GUILD_ID?.trim() || undefined,
  llmApiBaseUrl: required("LLM_API_BASE_URL"),
  llmApiKey: required("LLM_API_KEY"),
  llmModel: process.env.LLM_MODEL?.trim() || "gpt-4.1-mini",
  githubToken: optionalString("GITHUB_TOKEN"),
  databasePath: process.env.DATABASE_PATH?.trim() || "data/cria.db",
  defaultLookbackHours: optionalInt("DEFAULT_LOOKBACK_HOURS", 24),
  maxLookbackHours: optionalInt("MAX_LOOKBACK_HOURS", 720),
  batchSize: optionalInt("BATCH_SIZE", 20),
  batchDelayMs: optionalInt("BATCH_DELAY_MS", 1_500),
  llmTimeoutMs: optionalInt("LLM_TIMEOUT_MS", 60_000),
  llmRetryCount: optionalInt("LLM_RETRY_COUNT", 3),
  llmRetryBaseDelayMs: optionalInt("LLM_RETRY_BASE_DELAY_MS", 3_000),
  staleScanMinutes: optionalInt("STALE_SCAN_MINUTES", 10),
  debugLogs: optionalBool("DEBUG_LOGS", true),
  botName: process.env.BOT_NAME?.trim() || "cria"
};

mkdirSync(dirname(config.databasePath), { recursive: true });
