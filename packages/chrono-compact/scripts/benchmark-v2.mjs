#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FIXTURE_BYTES = 16 * 1024 * 1024;
const FIXED_QUERIES = ["error", "failure", "tool", "user"];

let chrono;

async function loadRuntime() {
  chrono ??= await import(pathToFileURL(resolve(ROOT, "dist/src/index.js")));
  return chrono;
}

export function syntheticEntries(taskCount = 250) {
  const entries = [{
    type: "message",
    id: "syn-root",
    parentId: null,
    message: { role: "user", content: "Maintain the year-run service. Never publish private evidence. Keep immutable JSONL. The migration remains unresolved until approval." },
  }];
  let parentId = "syn-root";
  for (let task = 1; task <= taskCount; task += 1) {
    const userId = `syn-u-${task}`;
    const callEntryId = `syn-a-${task}`;
    const resultId = `syn-r-${task}`;
    const answerId = `syn-f-${task}`;
    const callId = `syn-call-${task}`;
    if ((task - 1) % 10 === 0) {
      entries.push({
        type: "message", id: userId, parentId,
        message: { role: "user", content: `Inspect year-run revisions for tasks ${task} through ${Math.min(taskCount, task + 9)} and report state changes.` },
      });
      parentId = userId;
    }
    entries.push({
      type: "message", id: callEntryId, parentId,
      message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "/repo/src/year-run.ts", revision: `r${task}`, offset: 1, limit: 80 } }], stopReason: "toolUse" },
    });
    const middle = Array.from({ length: 70 }, (_, line) => `export const stable${line} = ${line};`).join("\n");
    const failure = task === 173 ? "\nERROR migration guard expected=pending received=complete" : "";
    entries.push({
      type: "message", id: resultId, parentId: callEntryId,
      message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: `export const revision = \"r${task}\";\n${middle}${failure}` }], isError: task === 173, details: { exitCode: task === 173 ? 1 : 0 } },
    });
    entries.push({
      type: "message", id: answerId, parentId: resultId,
      message: { role: "assistant", content: [{ type: "text", text: task === taskCount
        ? `Revision r${taskCount} is current. Migration remains unresolved. Next action: obtain approval before release.`
        : `Observed revision r${task}; later work may supersede it.` }], stopReason: "stop" },
    });
    parentId = answerId;
  }
  return entries;
}

export function parseArgs(argv) {
  const args = { fixture: undefined, syntheticTasks: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fixture") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("fixture-option");
      args.fixture = value;
      index += 1;
    } else if (argument === "--synthetic-tasks") {
      const value = argv[index + 1];
      const count = Number(value);
      if (!value || !Number.isSafeInteger(count) || count < 1 || count > 5_000) throw new Error("synthetic-tasks");
      args.syntheticTasks = count;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      args.help = true;
    } else {
      throw new Error("argument");
    }
  }
  if (args.fixture !== undefined && args.syntheticTasks !== undefined) throw new Error("input-options");
  return args;
}

export async function readValidatedFixture(fixturePath) {
  if (typeof fixturePath !== "string" || fixturePath.length === 0) throw new Error("fixture-option");
  if (!fixturePath.toLowerCase().endsWith(".jsonl")) throw new Error("fixture-format");
  let before;
  try {
    before = await lstat(fixturePath);
  } catch {
    throw new Error("fixture-unreadable");
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("fixture-boundary");
  if (before.size > MAX_FIXTURE_BYTES) throw new Error("fixture-size");

  let handle;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(fixturePath, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    const sameIdentity = opened.dev === before.dev && opened.ino === before.ino;
    if (!sameIdentity || !opened.isFile() || opened.size !== before.size || opened.size > MAX_FIXTURE_BYTES) {
      throw new Error("fixture-boundary");
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof Error && error.message === "fixture-boundary") throw error;
    throw new Error("fixture-unreadable");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function scoreSearch(index, queries) {
  const hits = queries.map((query) => chrono.searchLocalHistory(index, query, { tokenBudget: 800, limit: 10 }).hits.length);
  return {
    queryCount: queries.length,
    queriesWithHits: hits.filter((count) => count > 0).length,
    averageHits: hits.reduce((sum, count) => sum + count, 0) / Math.max(1, hits.length),
  };
}

function sourceCategories(blocks) {
  const categories = {};
  for (const block of blocks) {
    const category = block.kind === "user" || block.kind === "custom_message"
      ? "authority"
      : block.kind.startsWith("assistant") || block.kind === "branch_summary"
        ? "assistant"
        : block.kind === "tool_call"
          ? "tool-call"
          : /test/i.test(block.toolName ?? "")
            ? "test"
            : block.kind === "tool_result" || block.kind === "bash_execution"
              ? "terminal"
              : "other";
    categories[category] = (categories[category] ?? 0) + block.rawTokens;
  }
  return Object.entries(categories).sort(([left], [right]) => left.localeCompare(right)).map(([category, sourceTokens]) => ({ category, sourceTokens }));
}

function exactRecoveryRate(session, blocks) {
  const sample = blocks.slice(0, 10);
  let recovered = 0;
  for (const block of sample) {
    try {
      chrono.historyGet(session, block.entryId, block.blockIndex === undefined ? {} : { blockIndex: block.blockIndex, maxChars: 20_000 });
      recovered += 1;
    } catch {
      // The aggregate reports recovery success without exposing source details.
    }
  }
  return recovered / Math.max(1, sample.length);
}

function protectedFactRate(summary, facts) {
  return facts.length === 0 ? null : facts.filter((fact) => summary.includes(fact)).length / facts.length;
}

export async function runBenchmark(entries, session, inputKind) {
  const runtime = await loadRuntime();
  const blocks = runtime.parseHistoricalBlocks(entries);
  const started = performance.now();
  const result = await runtime.compactEntries(entries, { config: { targetTokens: inputKind === "synthetic" ? 12_000 : 20_000 } });
  const compactionMs = performance.now() - started;
  const indexStarted = performance.now();
  const index = runtime.buildLocalSearchIndex(blocks);
  const indexBuildMs = performance.now() - indexStarted;
  const search = scoreSearch(index, FIXED_QUERIES);
  const rawTokens = result.rawTokens;
  const renderedTokens = result.renderedTokens;
  const facts = inputKind === "synthetic" ? [
    "Never publish private evidence.",
    "Keep immutable JSONL.",
    "The migration remains unresolved until approval.",
    "ERROR migration guard expected=pending received=complete",
  ] : [];
  return {
    schemaVersion: 2,
    benchmark: "chrono-v2-public-manual",
    inputKind,
    records: entries.length,
    blocks: blocks.length,
    sourceTokens: rawTokens,
    renderedTokens,
    reductionRatio: rawTokens === 0 ? 0 : 1 - renderedTokens / rawTokens,
    protectedFactRate: protectedFactRate(result.summary, facts),
    falseCompletion: result.summary.includes("Migration is complete.") ? 1 : 0,
    exactRecoveryRate: exactRecoveryRate(session, blocks),
    categories: sourceCategories(blocks),
    search,
    validationWarnings: result.validation.issues.filter((issue) => issue.severity === "warning").length,
    timing: { advisory: true, compactionMs, indexBuildMs },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node scripts/benchmark-v2.mjs [--synthetic-tasks COUNT | --fixture FILE.jsonl]");
    return;
  }
  if (args.fixture === undefined) {
    const entries = syntheticEntries(args.syntheticTasks);
    const runtime = await loadRuntime();
    const session = runtime.parseBranchEntries(entries);
    console.log(JSON.stringify(await runBenchmark(entries, session, "synthetic"), null, 2));
    return;
  }
  const text = await readValidatedFixture(args.fixture);
  const runtime = await loadRuntime();
  const session = runtime.parseSessionJsonl(text);
  const entries = runtime.getActiveBranch(session);
  console.log(JSON.stringify(await runBenchmark(entries, session, "fixture"), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch {
    console.log(JSON.stringify({ schemaVersion: 2, benchmark: "chrono-v2-public-manual", status: "error", error: "benchmark-input-rejected" }));
    process.exitCode = 1;
  }
}
