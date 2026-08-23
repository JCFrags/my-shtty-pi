#!/usr/bin/env node
// @ts-nocheck
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { syntheticEntries } from "./benchmark-v2.mjs";

const LIMITS = { "final-tasks": 5000, batches: 100, tokens: 1_000_000 };
const HELP = "Usage: benchmark-source-ledger.mjs --final-tasks N --batches N | large-entry --tokens N";
let runtime;
async function chrono() { return runtime ??= await import("../dist/src/index.js"); }
function integer(name, value) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`--${name} must have an integer value.`);
  const result = Number(value);
  if (result < 1 || result > LIMITS[name]) throw new Error(`--${name} must be from 1 through ${LIMITS[name]}.`);
  return result;
}
export function parseSourceLedgerArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const mode = argv[0] === "large-entry" ? "large-entry" : "tasks";
  const input = mode === "large-entry" ? argv.slice(1) : argv;
  const allowed = mode === "large-entry" ? new Set(["tokens"]) : new Set(["final-tasks", "batches"]);
  const values = {};
  for (let index = 0; index < input.length; index += 2) {
    const argument = input[index];
    if (!argument?.startsWith("--")) throw new Error(`Unknown argument: ${argument ?? "<missing>"}.`);
    const name = argument.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${argument}.`);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate argument: ${argument}.`);
    values[name] = integer(name, input[index + 1]);
  }
  for (const name of allowed) if (!Object.hasOwn(values, name)) throw new Error(`Missing value for --${name}.`);
  return { mode, ...values };
}
function median(values) { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function batchEnds(total, requested) { const count = Math.min(total, requested); return Array.from({ length: count }, (_, index) => Math.floor(((index + 1) * total) / count)); }

export async function runSourceLedgerBenchmark(finalTasks, batchesRequested) {
  const api = await chrono();
  const directory = await mkdtemp(join(tmpdir(), "chrono-ledger-benchmark-"));
  const session = join(directory, "synthetic.jsonl");
  try {
    const entries = syntheticEntries(finalTasks);
    const lines = [JSON.stringify({ type: "session", version: 3, id: "synthetic-ledger-benchmark" }), ...entries.map((entry) => JSON.stringify(entry))];
    const ends = batchEnds(entries.length, batchesRequested);
    let previous = 0;
    const firstText = `${lines[0]}\n${lines.slice(1, ends[0] + 1).join("\n")}\n`;
    await writeFile(session, firstText, { mode: 0o600 }); previous = ends[0];
    let started = performance.now();
    let ledger = await api.updateSourceLedger(session);
    const initialBuildMs = performance.now() - started;
    const initialSourceBytesRead = ledger.metrics.sourceBytesRead;
    const appendTimes = []; let totalAppendSourceBytesRead = 0; let finalAppendMs = 0;
    for (const end of ends.slice(1)) {
      await appendFile(session, `${lines.slice(previous + 1, end + 1).join("\n")}\n`); previous = end;
      started = performance.now(); ledger = await api.updateSourceLedger(session, ledger);
      finalAppendMs = performance.now() - started; appendTimes.push(finalAppendMs);
      totalAppendSourceBytesRead += ledger.metrics.sourceBytesRead;
    }
    started = performance.now(); const exact = await api.updateSourceLedger(session, ledger); const exactHitMs = performance.now() - started;
    started = performance.now(); const cold = await api.loadSourceLedger(session); const coldLedgerLoadMs = performance.now() - started;
    const samples = [entries[0], entries[Math.floor(entries.length / 2)], entries.at(-1)];
    let exactRetrievalBytesRead = 0;
    for (const sample of samples) exactRetrievalBytesRead += (await api.readExactSourceEntry(session, ledger, sample.id)).bytesRead;
    const sourceStats = await stat(session); const sidecarStats = await stat(api.sourceLedgerPath(session));
    const finalText = `${lines.join("\n")}\n`;
    const totalUpdateSourceBytes = initialSourceBytesRead + totalAppendSourceBytesRead;
    return { schemaVersion: 1, finalTasks, batchesRequested, batchesRun: ends.length,
      finalSourceBytes: sourceStats.size, finalSourceTokens: api.estimateTokensFromText(finalText), finalEntries: entries.length,
      sidecarBytes: sidecarStats.size, initialBuildMs, totalAppendMs: appendTimes.reduce((sum, value) => sum + value, 0),
      medianAppendMs: appendTimes.length ? median(appendTimes) : 0, finalAppendMs, exactHitMs, coldLedgerLoadMs,
      initialSourceBytesRead, totalAppendSourceBytesRead, exactHitSourceBytesRead: exact.metrics.sourceBytesRead,
      sourceReadAmplification: totalUpdateSourceBytes / sourceStats.size, coldLedgerBytesRead: cold.metrics.ledgerBytesRead,
      exactRetrievalBytesRead, peakRssKiB: process.resourceUsage().maxRSS,
      integrityOk: cold.checkpoint.indexedEntryCount === entries.length && cold.integrityChainState === ledger.integrityChainState };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runLargeEntryBenchmark(requestedContentTokens) {
  const api = await chrono();
  const directory = await mkdtemp(join(tmpdir(), "chrono-ledger-large-"));
  const session = join(directory, "synthetic-large.jsonl");
  try {
    const header = JSON.stringify({ type: "session", version: 3, id: "synthetic-large-ledger" });
    const large = JSON.stringify({ type: "message", id: "large", parentId: null,
      message: { role: "toolResult", toolCallId: "large-call", toolName: "synthetic", content: [{ type: "text", text: "x".repeat(requestedContentTokens * 4) }] } });
    await writeFile(session, `${header}\n${large}\n`, { mode: 0o600 });
    let started = performance.now(); let ledger = await api.updateSourceLedger(session); const initialBuildMs = performance.now() - started;
    const buildMetrics = ledger.metrics;
    started = performance.now(); ledger = await api.updateSourceLedger(session, ledger); const exactHitMs = performance.now() - started;
    const exactMetrics = ledger.metrics;
    const small = `${JSON.stringify({ type: "message", id: "small", parentId: "large", message: { role: "assistant", content: "done" } })}\n`;
    await appendFile(session, small);
    started = performance.now(); ledger = await api.updateSourceLedger(session, ledger); const smallAppendMs = performance.now() - started;
    const appendMetrics = ledger.metrics;
    started = performance.now(); const retrieved = await api.readExactSourceEntry(session, ledger, "large"); const exactRetrievalMs = performance.now() - started;
    started = performance.now(); const cold = await api.loadSourceLedger(session); const coldLedgerLoadMs = performance.now() - started;
    const source = await stat(session); const sidecar = await stat(api.sourceLedgerPath(session));
    return { schemaVersion: 1, mode: "large-entry", requestedContentTokens, sourceBytes: source.size,
      largeEntryBytes: Buffer.byteLength(large), sidecarBytes: sidecar.size, initialBuildMs, exactHitMs, smallAppendMs,
      coldLedgerLoadMs, exactRetrievalMs, sourceBytesReadForBuild: buildMetrics.sourceBytesRead,
      sourceLineAssemblyBytes: buildMetrics.sourceLineAssemblyBytes, maximumSourceLineBytes: buildMetrics.maximumSourceLineBytes,
      exactHitAnchorBytesRead: exactMetrics.tailAnchorBytesRead, appendAnchorBytesRead: appendMetrics.tailAnchorBytesRead,
      appendNewSourceBytesRead: appendMetrics.appendedSourceBytesRead, exactRetrievalBytesRead: retrieved.bytesRead,
      peakRssKiB: process.resourceUsage().maxRSS, integrityOk: cold.entryById.has("large") && cold.entryById.has("small") };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseSourceLedgerArguments(argv);
  if (args.help) { console.log(HELP); return; }
  const output = args.mode === "large-entry" ? await runLargeEntryBenchmark(args.tokens)
    : await runSourceLedgerBenchmark(args["final-tasks"], args.batches);
  console.log(JSON.stringify(output));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
