import { config } from "../config";
import { logDebug, logError } from "../utils/logger";

interface ChatCompletionChoice {
  message?: { content?: string | null };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) {
    return null;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

async function completeRaw(system: string, user: string, options?: { responseFormat?: { type: "json_object" } }): Promise<string> {
  const maxAttempts = Math.max(1, config.llmRetryCount);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), config.llmTimeoutMs);
    try {
      logDebug("llm.request.start", {
        model: config.llmModel,
        timeoutMs: config.llmTimeoutMs,
        systemChars: system.length,
        userChars: user.length,
        attempt,
        maxAttempts
      });
      const response = await fetch(`${config.llmApiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llmApiKey}`
        },
        body: JSON.stringify({
          model: config.llmModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.1,
          ...(options?.responseFormat ? { response_format: options.responseFormat } : {})
        }),
        signal: controller.signal
      }).catch((error) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`llm request timed out after ${config.llmTimeoutMs}ms`);
        }
        throw error;
      });

      if (!response.ok) {
        if (response.status === 429 && attempt < maxAttempts) {
          const retryAfterMs = parseRetryAfterMs(response) ?? config.llmRetryBaseDelayMs * attempt;
          logDebug("llm.request.rate_limited", {
            model: config.llmModel,
            attempt,
            maxAttempts,
            retryAfterMs,
            status: response.status
          });
          clearTimeout(timeout);
          await sleep(retryAfterMs);
          continue;
        }
        throw new Error(`llm request failed: ${response.status}`);
      }

      const raw = await response.text().catch((error) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`llm request timed out after ${config.llmTimeoutMs}ms`);
        }
        throw error;
      });
      logDebug("llm.response.received", {
        model: config.llmModel,
        status: response.status,
        bodyChars: raw.length,
        attempt,
        maxAttempts
      });

      let payload: ChatCompletionResponse;
      try {
        payload = JSON.parse(raw) as ChatCompletionResponse;
      } catch {
        throw new Error("llm response was not valid json");
      }

      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error("llm response did not include message content");
      }
      return content;
    } catch (error) {
      logError("llm.request.failed", error, {
        model: config.llmModel,
        timeoutMs: config.llmTimeoutMs,
        attempt,
        maxAttempts
      });
      if (attempt >= maxAttempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("429") && !message.includes("rate") && !message.includes("timed out") && !message.includes("timeout")) {
        throw error;
      }
      const retryAfterMs = config.llmRetryBaseDelayMs * attempt;
      logDebug("llm.request.retrying", {
        model: config.llmModel,
        attempt,
        maxAttempts,
        retryAfterMs
      });
      await sleep(retryAfterMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("llm request failed after retries");
}

export async function completeJson(system: string, user: string): Promise<unknown> {
  const content = await completeRaw(system, user, { responseFormat: { type: "json_object" } });
  return JSON.parse(content);
}

export async function completeText(system: string, user: string): Promise<string> {
  return completeRaw(system, user);
}
