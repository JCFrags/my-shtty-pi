#!/usr/bin/env node
// @ts-nocheck
import { constants, createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, lstat, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, freemem, totalmem } from "node:os";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const DEFAULTS = { minimumBytes: 1_048_576, minimumCount: 12, maximumFiles: 100, maximumMinutes: 120, perSessionTimeoutSeconds: 900 };
const MAXIMUMS = { maximumFiles: 250, maximumMinutes: 360, perSessionTimeoutSeconds: 3600 };
const SAFE_FAILURES = new Set(["invalid-session", "invalid-json", "unsupported-format", "source-changed", "memory-gate", "timeout", "compaction-failed", "ledger-failed", "search-index-failed", "exact-recovery-failed", "unknown-failure"]);
const HELP = "Explicit manifest only; this tool never discovers sessions. Source files stay read-only. Output uses anonymous fixture IDs and excludes paths and source text. Timing and memory are advisory.";
let chrono;
async function runtime() { return chrono ??= await import("../dist/src/index.js"); }

function integer(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`invalid-${name}`);
  const number = Number(value); if (number < 1 || number > maximum) throw new Error(`invalid-${name}`); return number;
}
export function parseSessionSetArguments(argv) {
  const mode = argv[0];
  if (["--help", "-h", "help"].includes(mode)) return { mode: "help" };
  if (mode !== "run" && mode !== "child") throw new Error("unknown-mode");
  const allowed = mode === "run" ? new Set(["manifest", "output", "minimum-bytes", "minimum-count", "maximum-files", "maximum-minutes", "per-session-timeout-seconds", "diagnostic"])
    : new Set(["snapshot", "fixture-id", "full"]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const arg = argv[index]; if (!arg?.startsWith("--") || !allowed.has(arg.slice(2))) throw new Error("unknown-argument");
    const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error("missing-value");
    if (Object.hasOwn(values, arg.slice(2))) throw new Error("duplicate-argument"); values[arg.slice(2)] = value;
  }
  for (const required of mode === "run" ? ["manifest", "output"] : ["snapshot", "fixture-id", "full"]) if (!values[required]) throw new Error("missing-value");
  if (mode === "child") {
    if (!/^fixture-\d{3}$/.test(values["fixture-id"]) || !["yes", "no"].includes(values.full)) throw new Error("invalid-child");
    return { mode, snapshot: values.snapshot, fixtureId: values["fixture-id"], full: values.full === "yes" };
  }
  return { mode, manifest: values.manifest, output: values.output, diagnostic: values.diagnostic,
    minimumBytes: integer("minimum-bytes", values["minimum-bytes"] ?? String(DEFAULTS.minimumBytes)),
    minimumCount: integer("minimum-count", values["minimum-count"] ?? String(DEFAULTS.minimumCount), 250),
    maximumFiles: integer("maximum-files", values["maximum-files"] ?? String(DEFAULTS.maximumFiles), MAXIMUMS.maximumFiles),
    maximumMinutes: integer("maximum-minutes", values["maximum-minutes"] ?? String(DEFAULTS.maximumMinutes), MAXIMUMS.maximumMinutes),
    perSessionTimeoutSeconds: integer("per-session-timeout-seconds", values["per-session-timeout-seconds"] ?? String(DEFAULTS.perSessionTimeoutSeconds), MAXIMUMS.perSessionTimeoutSeconds) };
}

async function regularNoSymlink(path, label) {
  const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`invalid-${label}`); return metadata;
}
export async function loadExplicitManifest(path) {
  await regularNoSymlink(path, "manifest");
  let data; try { data = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("invalid-manifest"); }
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.sessions) || data.sessions.some((item) => typeof item !== "string" || item.length === 0)) throw new Error("invalid-manifest");
  const canonical = data.sessions.map((item) => resolve(item));
  if (new Set(canonical).size !== canonical.length) throw new Error("duplicate-source");
  const files = [];
  for (const path of canonical) { const metadata = await regularNoSymlink(path, "source"); files.push({ path, size: metadata.size }); }
  return files;
}
export function selectSessionFiles(files, options) {
  const sorted = [...files].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const above = sorted.filter((item) => item.size >= options.minimumBytes);
  const selected = [...above];
  for (const item of sorted) { if (selected.length >= options.minimumCount) break; if (!selected.includes(item)) selected.push(item); }
  return selected.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, options.maximumFiles)
    .map((item, index) => ({ ...item, fixtureId: `fixture-${String(index + 1).padStart(3, "0")}` }));
}

export function distribution(values) {
  if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.ceil((sorted.length - 1) * fraction)];
  return { minimum: sorted[0], p50: at(0.5), p90: at(0.9), maximum: sorted.at(-1) };
}
export function mapFailure(error, timedOut = false) {
  if (timedOut) return "timeout";
  const code = error?.safeCategory; return SAFE_FAILURES.has(code) ? code : "unknown-failure";
}
export function memoryGate(sourceBytes, available = freemem(), total = totalmem()) {
  const estimatedWorkingSetBytes = Math.max(1024 ** 3, sourceBytes * 12);
  const allowed = sourceBytes <= 1024 ** 3 && estimatedWorkingSetBytes <= available * 0.65 && estimatedWorkingSetBytes <= total * 0.60;
  return { allowed, estimatedWorkingSetBytes };
}

async function stableSnapshot(source, destination) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(source, { bigint: true });
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const output = await open(destination, "w", 0o600);
    try { await pipeline(input.createReadStream(), output.createWriteStream()); } finally { await input.close().catch(() => {}); await output.close().catch(() => {}); }
    const after = await stat(source, { bigint: true });
    if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs) return { ok: true, size: Number(after.size) };
    await rm(destination, { force: true });
  }
  return { ok: false, size: 0 };
}
function roleCount(entries, role) { return entries.filter((entry) => entry.message?.role === role).length; }
function refKey(ref) { return `${ref.entryId}:${ref.blockIndex ?? ""}`; }
function exactRecoverySamples(blocks) {
  const candidates = [blocks[0], blocks[Math.floor(blocks.length / 2)], blocks.at(-1), blocks.find((block) => block.isError), blocks.find((block) => block.protectedExact)].filter(Boolean);
  return [...new Map(candidates.map((block) => [block.id, block])).values()];
}

export function protectedVisibility(blocks, summary, directInstructionText) {
  const protectedBlocks = blocks.filter((block) => block.protectedExact); let visible = 0;
  for (const block of protectedBlocks) { const direct = directInstructionText(block.exactText); if (direct && summary.includes(direct)) visible += 1; }
  return { protectedSourceBlocks: protectedBlocks.length, protectedVisibleBlocks: visible,
    protectedVisibilityRate: protectedBlocks.length ? visible / protectedBlocks.length : 1 };
}
export function lossySourceCoverage(plan) {
  const lossy = plan.units.filter((unit) => unit.selected.level !== "raw");
  const withRefs = lossy.filter((unit) => unit.sourceRefs.length > 0).length;
  return { lossySelectedUnits: lossy.length, lossyUnitsWithSourceRefs: withRefs, lossyUnitsWithoutSourceRefs: lossy.length - withRefs };
}

async function ledgerMetrics(snapshot, fixtureId) {
  const api = await runtime(); const sidecar = join(resolve(snapshot, ".."), `${fixtureId}.ledger.jsonl`);
  let started = performance.now(); let ledger = await api.updateSourceLedger(snapshot, undefined, { sidecarPath: sidecar }); const ledgerBuildMs = performance.now() - started;
  const build = ledger.metrics; started = performance.now(); ledger = await api.updateSourceLedger(snapshot, ledger, { sidecarPath: sidecar }); const ledgerExactHitMs = performance.now() - started;
  const exact = ledger.metrics; started = performance.now(); const cold = await api.loadSourceLedger(snapshot, sidecar); const ledgerColdLoadMs = performance.now() - started;
  const sample = [ledger.sourceOrder[0], ledger.sourceOrder[Math.floor(ledger.sourceOrder.length / 2)], ledger.sourceOrder.at(-1)].filter(Boolean);
  let successes = 0; let bytes = 0;
  for (const item of sample) { try { const value = await api.readExactSourceEntry(snapshot, ledger, item.entryId); successes += 1; bytes += value.bytesRead; } catch {} }
  const sidecarBytes = (await stat(sidecar)).size;
  await rm(sidecar, { force: true }); await rm(`${sidecar}.lock`, { force: true });
  return { ledgerBuildMs, ledgerExactHitMs, ledgerColdLoadMs, ledgerEntries: ledger.sourceOrder.length, ledgerSidecarBytes: sidecarBytes,
    ledgerBuildSourceBytesRead: build.sourceBytesRead, ledgerExactHitAnchorBytesRead: exact.tailAnchorBytesRead,
    ledgerExactRetrievalSamples: sample.length, ledgerExactRetrievalSuccesses: successes, ledgerExactRetrievalBytesRead: bytes,
    ledgerIntegrityOk: cold.integrityChainState === ledger.integrityChainState };
}

export async function benchmarkSnapshot(snapshot, fixtureId, full) {
  const api = await runtime(); const sourceBytes = (await stat(snapshot)).size;
  let ledger; try { ledger = await ledgerMetrics(snapshot, fixtureId); } catch { return { fixtureId, sourceBytes, status: "failed", failureCategory: "ledger-failed" }; }
  if (!full) return { fixtureId, sourceBytes, ...ledger, status: "ledger-only", failureCategory: "memory-gate" };
  let text, session, branch, blocks;
  try { text = await readFile(snapshot, "utf8"); session = api.parseSessionJsonl(text); branch = api.getActiveBranch(session); blocks = api.parseHistoricalBlocks(branch); }
  catch { return { fixtureId, sourceBytes, ...ledger, status: "failed", failureCategory: "invalid-session" }; }
  try {
    const scheduled = performance.now(); let timerAt; const timer = new Promise((resolveTimer) => setTimeout(() => { timerAt = performance.now(); resolveTimer(); }, 0));
    const started = performance.now(); const result = await api.compactEntries(branch, { config: { targetTokens: 20_000, enableSemanticCompression: false }, hardOutputTokens: 25_000 }); const compactionMs = performance.now() - started; await timer;
    const indexStarted = performance.now(); const index = api.buildLocalSearchIndex(blocks); const searchIndexMs = performance.now() - indexStarted;
    const safeSearchHitCount = ["error", "failed", "unresolved", "todo"].reduce((sum, query) => sum + api.searchLocalHistory(index, query, { limit: 10, tokenBudget: 800 }).hits.length, 0);
    const model = api.buildCausalMemory(blocks, api.buildResourceLineage(blocks)); const state = api.selectCurrentStateItems(model, 80);
    const refs = new Set(blocks.map((block) => refKey({ entryId: block.entryId, blockIndex: block.blockIndex })));
    const currentStateRefsValid = state.filter((item) => refs.has(refKey(item.source))).length;
    const recovery = exactRecoverySamples(blocks); let recoverySuccess = 0; let recoveryBytes = 0;
    for (const block of recovery) { try { const value = api.historyGet(session, block.entryId, block.blockIndex === undefined ? {} : { blockIndex: block.blockIndex, maxChars: 20_000 }); recoverySuccess += 1; recoveryBytes += Buffer.byteLength(JSON.stringify(value)); } catch {} }
    const visibility = protectedVisibility(blocks, result.summary, api.directInstructionText); const loss = lossySourceCoverage(result.plan);
    const records = session.records.length; const maxEntry = Math.max(0, ...session.records.slice(1).map((record) => Buffer.byteLength(record.rawLine)));
    const toolRecords = session.records.slice(1).filter((record) => record.data?.message?.role === "toolResult");
    return { fixtureId, sourceBytes, sourceRecords: records, activeBranchEntries: branch.length,
      existingCompactionEntries: session.entries.filter((entry) => /compaction|branch_summary/.test(entry.type)).length,
      activeBranchUserMessages: roleCount(branch, "user"), activeBranchAssistantMessages: roleCount(branch, "assistant"), activeBranchToolResults: roleCount(branch, "toolResult"),
      activeSourceTokens: result.rawTokens, renderedTokens: result.renderedTokens, reductionRatio: result.rawTokens ? 1 - result.renderedTokens / result.rawTokens : 0,
      compactionMs, searchIndexMs, maximumTimerDelayMs: Math.max(0, timerAt - scheduled), peakRssKiB: process.resourceUsage().maxRSS,
      validationWarnings: result.validation.issues.filter((issue) => issue.severity === "warning").length,
      validationErrors: result.validation.issues.filter((issue) => issue.severity === "error").length,
      ...visibility, unresolvedBlocks: blocks.filter((block) => block.unresolved).length, failedBlocks: blocks.filter((block) => block.isError).length,
      currentStateItems: state.length, currentStateRefsChecked: state.length, currentStateRefsValid,
      exactRecoverySamples: recovery.length, exactRecoverySuccesses: recoverySuccess, exactRecoveryBytesRead: recoveryBytes,
      ...loss, maximumSourceEntryBytes: maxEntry,
      maximumToolResultEntryBytes: Math.max(0, ...toolRecords.map((record) => Buffer.byteLength(record.rawLine))), safeSearchHitCount,
      ...ledger, status: "ok", failureCategory: null };
  } catch { return { fixtureId, sourceBytes, ...ledger, status: "failed", failureCategory: "compaction-failed" }; }
}

function childProcess(snapshot, fixtureId, full, timeoutMs) {
  return new Promise((resolveChild) => {
    const child = execFile(process.execPath, [new URL(import.meta.url).pathname, "child", "--snapshot", snapshot, "--fixture-id", fixtureId, "--full", full ? "yes" : "no"],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return resolveChild({ error, stderr, timedOut: error.killed === true });
        try { resolveChild({ row: JSON.parse(stdout), stderr }); } catch { resolveChild({ error: new Error("child-output"), stderr, timedOut: false }); }
      });
  });
}
export function aggregateRows(rows) {
  const numeric = ["sourceBytes", "activeSourceTokens", "maximumSourceEntryBytes", "maximumToolResultEntryBytes", "compactionMs", "searchIndexMs", "maximumTimerDelayMs", "peakRssKiB", "protectedVisibilityRate", "ledgerBuildMs", "ledgerColdLoadMs"];
  const distributions = Object.fromEntries(numeric.map((key) => [key, distribution(rows.map((row) => row[key]).filter(Number.isFinite))]));
  const sum = (key) => rows.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
  return { schemaVersion: 1, selectedCount: rows.length, fullBenchmarkCount: rows.filter((row) => row.status === "ok").length,
    ledgerOnlyCount: rows.filter((row) => row.status === "ledger-only").length, skippedCount: rows.filter((row) => row.status === "skipped").length,
    failureCount: rows.filter((row) => row.status === "failed").length, totalSourceBytes: sum("sourceBytes"), totalActiveSourceTokens: sum("activeSourceTokens"),
    totalCompactionMs: sum("compactionMs"), totalSearchIndexMs: sum("searchIndexMs"), totalLedgerBuildMs: sum("ledgerBuildMs"),
    quality: { validationErrors: sum("validationErrors"), protectedSourceBlocks: sum("protectedSourceBlocks"), protectedVisibleBlocks: sum("protectedVisibleBlocks"),
      currentStateRefsChecked: sum("currentStateRefsChecked"), currentStateRefsValid: sum("currentStateRefsValid"), exactRecoverySamples: sum("exactRecoverySamples"),
      exactRecoverySuccesses: sum("exactRecoverySuccesses"), lossyUnitsWithoutSourceRefs: sum("lossyUnitsWithoutSourceRefs"), ledgerIntegritySuccesses: rows.filter((row) => row.ledgerIntegrityOk).length },
    distributions, fixtures: rows };
}

export async function runSessionSet(args, seams = {}) {
  const files = await loadExplicitManifest(args.manifest); const selected = selectSessionFiles(files, args);
  const directory = await mkdtemp(join(tmpdir(), "chrono-session-set-")); await chmod(directory, 0o700);
  const diagnostic = args.diagnostic ?? join(directory, "diagnostic.log"); await writeFile(diagnostic, "", { mode: 0o600 });
  const rows = []; const now = seams.now ?? (() => performance.now()); const started = now();
  try {
    for (const fixture of selected) {
      if (now() - started >= args.maximumMinutes * 60_000) { rows.push({ fixtureId: fixture.fixtureId, sourceBytes: fixture.size, status: "skipped", failureCategory: "timeout" }); continue; }
      const snapshot = join(directory, `${fixture.fixtureId}.jsonl`); const copied = seams.snapshot ? await seams.snapshot(fixture.path, snapshot) : await stableSnapshot(fixture.path, snapshot);
      if (!copied.ok) { rows.push({ fixtureId: fixture.fixtureId, sourceBytes: fixture.size, status: "skipped", failureCategory: "source-changed" }); continue; }
      const gate = memoryGate(copied.size); const result = seams.child ? await seams.child(snapshot, fixture.fixtureId, gate.allowed) : await childProcess(snapshot, fixture.fixtureId, gate.allowed, args.perSessionTimeoutSeconds * 1000);
      if (result.stderr) await appendFile(diagnostic, `[${fixture.fixtureId}] child diagnostic omitted from report\n`, { mode: 0o600 });
      rows.push(result.row ?? { fixtureId: fixture.fixtureId, sourceBytes: copied.size, status: "failed", failureCategory: mapFailure(result.error, result.timedOut) });
      await rm(snapshot, { force: true }); await rm(`${snapshot}.chrono-source-ledger-v1.jsonl`, { force: true });
    }
    const report = aggregateRows(rows); await writeFile(args.output, `${JSON.stringify(report)}\n`, { mode: 0o600 }); await chmod(args.output, 0o600); return report;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseSessionSetArguments(argv);
  if (args.mode === "help") { console.log(HELP); return; }
  if (args.mode === "child") { console.log(JSON.stringify(await benchmarkSnapshot(args.snapshot, args.fixtureId, args.full))); return; }
  console.log(JSON.stringify(await runSessionSet(args)));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(() => { console.log(JSON.stringify({ schemaVersion: 1, status: "error", failureCategory: "unknown-failure" })); process.exitCode = 1; });
