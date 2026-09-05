#!/usr/bin/env node
// @ts-nocheck
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { syntheticEntries } from "./synthetic-session.mjs";

const SCHEMA_VERSION = 1;
const MAX_PARENT_RSS_KIB = 512 * 1024;

export function parseSoakArguments(argv) {
  const result = { packageRoot: undefined, expectedVersion: undefined, sessions: 6, slots: 2, tasks: 100 };
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("soak-option");
    if (option === "--package-root") result.packageRoot = resolve(value);
    else if (option === "--expected-version" && /^\d+\.\d+\.\d+$/.test(value)) result.expectedVersion = value;
    else if (option === "--sessions" && Number.isSafeInteger(Number(value)) && Number(value) >= 2 && Number(value) <= 12) result.sessions = Number(value);
    else if (option === "--slots" && [1, 2, 3, 4].includes(Number(value))) result.slots = Number(value);
    else if (option === "--tasks" && Number.isSafeInteger(Number(value)) && Number(value) >= 20 && Number(value) <= 500) result.tasks = Number(value);
    else throw new Error("soak-option");
  }
  if (!result.packageRoot || !result.expectedVersion || result.slots > result.sessions) throw new Error("soak-required-option");
  return result;
}

function remapEntries(entries, ordinal) {
  const prefix = `s${ordinal}-`;
  return entries.map((entry) => ({ ...entry, id: `${prefix}${entry.id}`, parentId: entry.parentId === null || entry.parentId === undefined ? null : `${prefix}${entry.parentId}` }));
}

async function source(directory, ordinal, tasks) {
  const entries = remapEntries(syntheticEntries(tasks + ordinal), ordinal);
  const sessionPath = join(directory, `session-${ordinal}.jsonl`);
  await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: `soak-${ordinal}` })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  const value = await stat(sessionPath);
  return { ordinal, entries, sessionPath, expectedSource: { deviceId: String(value.dev), inodeId: String(value.ino), size: value.size, mtimeMs: value.mtimeMs } };
}

function request(runtime, input) {
  return { schemaVersion: 1, jobId: `soak-${input.ordinal}`, jobType: "replay-compaction", sessionPath: input.sessionPath, expectedSource: input.expectedSource,
    deadlineMs: Date.now() + 10 * 60_000, niceLevel: 10, branchLeafId: input.entries.at(-1).id, firstKeptEntryId: input.entries.at(-1).id,
    config: runtime.resolveCompactorConfig({ targetTokens: 4_000, enableSemanticCompression: false }), hardOutputTokens: 25_000,
    retentionHints: "", pinnedMemoryText: "", candidateStoreEnabled: false, cacheEnabled: false };
}

export async function runDeployedWorkerSoak(options) {
  const manifest = JSON.parse(await readFile(join(options.packageRoot, "package.json"), "utf8"));
  if (manifest.version !== options.expectedVersion) throw new Error("soak-version-mismatch");
  const [client, compactor, scheduler] = await Promise.all([
    import(pathToFileURL(join(options.packageRoot, "dist", "src", "compaction-worker-client.js")).href),
    import(pathToFileURL(join(options.packageRoot, "dist", "src", "compactor.js")).href),
    import(pathToFileURL(join(options.packageRoot, "dist", "src", "host-worker-scheduler.js")).href),
  ]);
  const runtime = { ...client, ...compactor, ...scheduler };
  const directory = await mkdtemp(join(tmpdir(), "chrono-deployed-soak-"));
  const schedulerDirectory = join(directory, "scheduler");
  const diagnostics = join(directory, "diagnostics");
  const started = performance.now();
  let monitor, maximumSlots = 0, maximumTickets = 0;
  try {
    const inputs = await Promise.all(Array.from({ length: options.sessions }, (_, index) => source(directory, index + 1, options.tasks)));
    await mkdir(diagnostics, { mode: 0o700 });
    monitor = setInterval(async () => {
      try { const counts = await runtime.schedulerArtifactCounts(schedulerDirectory); maximumSlots = Math.max(maximumSlots, counts.slots); maximumTickets = Math.max(maximumTickets, counts.tickets); } catch {}
    }, 5);
    const results = await Promise.all(inputs.map((input) => runtime.runCompactionWorker(request(runtime, input), { slots: options.slots, schedulerDirectory, workerTimeoutMs: 5 * 60_000, privateDiagnosticPath: join(diagnostics, `worker-${input.ordinal}.json`) })));
    clearInterval(monitor); monitor = undefined;
    const successCodes = results.map((result) => result.response.status === "ok" ? "ok" : result.response.failureCode);
    const crossSessionLeakage = results.some((result, index) => result.response.status === "ok" && result.response.replay.planSources.some((unit) => unit.sourceRefs.some((ref) => !ref.entryId.startsWith(`s${index + 1}-`))));
    const failureInput = inputs[0];
    const controlled = await runtime.runCompactionWorker(request(runtime, { ...failureInput, ordinal: 99 }), { slots: options.slots, schedulerDirectory, entryPath: join(directory, "missing-worker.js"), workerTimeoutMs: 5_000, privateDiagnosticPath: join(diagnostics, "controlled.json") });
    const failureCode = controlled.response.status === "failed" ? controlled.response.failureCode : "unexpected-success";
    const residue = await runtime.schedulerArtifactCounts(schedulerDirectory);
    const diagnosticFiles = await readdir(diagnostics).catch(() => []);
    const diagnosticsSafe = (await Promise.all(diagnosticFiles.map(async (name) => {
      const path = join(diagnostics, name), metadata = await stat(path), text = await readFile(path, "utf8");
      return metadata.isFile() && (metadata.mode & 0o777) === 0o600 && metadata.size <= 32 * 1024 && !text.includes(directory) && !/s[1-9]-syn-/.test(text);
    }))).every(Boolean);
    const parentPeakRssKiB = process.resourceUsage().maxRSS;
    const status = successCodes.every((code) => code === "ok") && failureCode === "worker-entrypoint-unavailable" && maximumSlots <= options.slots && maximumSlots > 0 && !crossSessionLeakage && residue.slots === 0 && residue.tickets === 0 && diagnosticsSafe && diagnosticFiles.length >= 1 && parentPeakRssKiB <= MAX_PARENT_RSS_KIB ? "passed" : "failed";
    return { schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-deployed-worker-soak", status,
      deterministic: { deployedVersion: manifest.version, sessions: options.sessions, slots: options.slots, tasks: options.tasks, successCodes, controlledFailureCode: failureCode, maximumSlots, maximumTickets, crossSessionLeakage, schedulerResidue: residue, diagnosticFileCount: diagnosticFiles.length, diagnosticsSafe, parentRssLimitKiB: MAX_PARENT_RSS_KIB },
      advisory: { wallMs: performance.now() - started, parentPeakRssKiB } };
  } finally {
    if (monitor) clearInterval(monitor);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runDeployedWorkerSoak(parseSoakArguments(argv));
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(() => {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-deployed-worker-soak", status: "failed", failureCode: "soak-input-rejected" }));
  process.exitCode = 1;
});
