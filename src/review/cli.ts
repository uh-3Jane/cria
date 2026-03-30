import { readFileSync } from "node:fs";
import { config } from "../config";
import { migrate } from "../db/schema";
import {
  benchmarkSummary,
  createBenchmarkCase,
  createManualReviewQueueItem,
  listBenchmarkCases,
  listReviewQueue,
  markReviewQueueItem,
  promoteReviewQueueItem,
  retireBenchmarkCase,
  reviewQueueSummary,
  syncReviewQueueFromLearningFeedback,
  runBenchmarkSuite,
  updateBenchmarkCase
} from "./store";
import type { BenchmarkOutcomeType, BenchmarkStatus, LearningFeedbackDomain, LearningFeedbackKind, ReviewStatus } from "../types";

migrate();
syncReviewQueueFromLearningFeedback(config.guildId);

function requireGuildId(explicit?: string): string {
  const guildId = explicit ?? config.guildId;
  if (!guildId) {
    throw new Error("missing guild id; pass it explicitly or set GUILD_ID");
  }
  return guildId;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    throw new Error("missing command");
  }

  if (command === "queue:list") {
    const guildId = requireGuildId(args[0] && !args[0].includes(":") ? args[0] : undefined);
    const statusArg = (args[1] ?? args[0]) as ReviewStatus | undefined;
    printJson(listReviewQueue(guildId, statusArg));
    return;
  }

  if (command === "queue:summary") {
    printJson(reviewQueueSummary(requireGuildId(args[0])));
    return;
  }

  if (command === "queue:mark") {
    const [queueIdRaw, status, ...noteParts] = args;
    markReviewQueueItem(Number(queueIdRaw), requireGuildId(), status as ReviewStatus, noteParts.join(" ") || null);
    console.log(`review queue item ${queueIdRaw} marked ${status}`);
    return;
  }

  if (command === "queue:add") {
    const payload = readJsonFile(args[0]);
    const id = createManualReviewQueueItem({
      guildId: requireGuildId(typeof payload.guildId === "string" ? payload.guildId : undefined),
      sourceDomain: payload.sourceDomain as LearningFeedbackDomain,
      rawInput: String(payload.rawInput ?? ""),
      rawContext: typeof payload.rawContext === "string" ? payload.rawContext : null,
      rawInitialOutput: typeof payload.rawInitialOutput === "string" ? payload.rawInitialOutput : null,
      rawCorrectedOutput: String(payload.rawCorrectedOutput ?? ""),
      feedbackKind: payload.feedbackKind as LearningFeedbackKind,
      weight: typeof payload.weight === "number" ? payload.weight : 0,
      notes: typeof payload.notes === "string" ? payload.notes : null
    });
    console.log(`created review queue item ${id}`);
    return;
  }

  if (command === "queue:promote") {
    const [queueIdRaw, family, outcomeType, ...targetParts] = args;
    const caseId = promoteReviewQueueItem({
      queueId: Number(queueIdRaw),
      guildId: requireGuildId(),
      family,
      outcomeType: outcomeType as BenchmarkOutcomeType,
      targetOutput: targetParts.join(" ") || undefined
    });
    console.log(`promoted review queue item ${queueIdRaw} to benchmark case ${caseId}`);
    return;
  }

  if (command === "benchmark:list") {
    const guildId = requireGuildId(args[0] && !["active", "stale", "retired"].includes(args[0]) ? args[0] : undefined);
    const status = (args[1] ?? args[0]) as BenchmarkStatus | undefined;
    printJson(listBenchmarkCases(guildId, status));
    return;
  }

  if (command === "benchmark:add") {
    const payload = readJsonFile(args[0]);
    const id = createBenchmarkCase({
      guildId: requireGuildId(typeof payload.guildId === "string" ? payload.guildId : undefined),
      source: (payload.source as "manual" | "promoted_trace" | undefined) ?? "manual",
      sourceReviewId: typeof payload.sourceReviewId === "number" ? payload.sourceReviewId : null,
      family: String(payload.family ?? ""),
      outcomeType: payload.outcomeType as BenchmarkOutcomeType,
      canonicalInput: String(payload.canonicalInput ?? ""),
      canonicalContext: typeof payload.canonicalContext === "string" ? payload.canonicalContext : null,
      targetOutput: String(payload.targetOutput ?? ""),
      notes: typeof payload.notes === "string" ? payload.notes : null
    });
    console.log(`created benchmark case ${id}`);
    return;
  }

  if (command === "benchmark:update") {
    const [caseIdRaw, payloadPath] = args;
    const payload = readJsonFile(payloadPath);
    updateBenchmarkCase({
      caseId: Number(caseIdRaw),
      guildId: requireGuildId(typeof payload.guildId === "string" ? payload.guildId : undefined),
      family: typeof payload.family === "string" ? payload.family : undefined,
      outcomeType: payload.outcomeType as BenchmarkOutcomeType | undefined,
      canonicalInput: typeof payload.canonicalInput === "string" ? payload.canonicalInput : undefined,
      canonicalContext: typeof payload.canonicalContext === "string" ? payload.canonicalContext : payload.canonicalContext === null ? null : undefined,
      targetOutput: typeof payload.targetOutput === "string" ? payload.targetOutput : undefined,
      status: payload.status as BenchmarkStatus | undefined,
      notes: typeof payload.notes === "string" ? payload.notes : undefined
    });
    console.log(`updated benchmark case ${caseIdRaw}`);
    return;
  }

  if (command === "benchmark:retire") {
    const [caseIdRaw, ...noteParts] = args;
    retireBenchmarkCase(Number(caseIdRaw), requireGuildId(), noteParts.join(" ") || null);
    console.log(`retired benchmark case ${caseIdRaw}`);
    return;
  }

  if (command === "benchmark:run") {
    const guildId = requireGuildId(args[0]);
    const result = await runBenchmarkSuite({
      guildId,
      triggeredBy: args[1] ?? "local_cli",
      notes: args.slice(2).join(" ") || null
    });
    printJson({
      run: result.run,
      results: result.results
    });
    return;
  }

  if (command === "benchmark:summary") {
    printJson(benchmarkSummary(requireGuildId(args[0])));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

await main();
