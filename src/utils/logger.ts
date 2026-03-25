import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config";

type LogLevel = "debug" | "info" | "error";

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalizeValue(child)])
    );
  }
  return value;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      errors: error.errors.map((child) => serializeError(child))
    };
  }

  if (error instanceof Error) {
    const extra = error as Error & Record<string, unknown>;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: typeof extra.code === "string" || typeof extra.code === "number" ? extra.code : undefined,
      status: typeof extra.status === "number" ? extra.status : undefined,
      requestBody: extra.requestBody ? normalizeValue(extra.requestBody) : undefined,
      rawError: extra.rawError ? normalizeValue(extra.rawError) : undefined,
      errors: Array.isArray(extra.errors) ? extra.errors.map((child) => serializeError(child)) : undefined
    };
  }

  return { value: normalizeValue(error) };
}

function write(level: LogLevel, event: string, payload: Record<string, unknown>): void {
  if (!config.debugLogs) {
    return;
  }

  const normalizedPayload = normalizeValue(payload) as Record<string, unknown>;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...normalizedPayload
  });
  const logFile = resolve(process.cwd(), "data", "debug.log");

  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // Keep console logging best-effort even if file logging fails.
  }

  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export function logDebug(event: string, payload: Record<string, unknown>): void {
  write("debug", event, payload);
}

export function logInfo(event: string, payload: Record<string, unknown>): void {
  write("info", event, payload);
}

export function logError(event: string, error: unknown, payload: Record<string, unknown> = {}): void {
  write("error", event, {
    ...payload,
    error: serializeError(error)
  });
}
