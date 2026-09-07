#!/usr/bin/env node
// @ts-nocheck
// Synthetic-only M03 replay equality soak. Fault/pressure coverage is separate.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticEntries } from "./synthetic-session.mjs";

const SELF = fileURLToPath(import.meta.url);
const CLIENTS = 6;
const REPEATS = 3;
const JOB_MS = 60_000;
const CLIENT_MS = 6 * JOB_MS;
const MAX_RSS_KIB = 512 * 1024;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function childEnvironment() {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
    .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}
async function client(input) {
  const { runCompactionWorker } = await import(pathToFileURL(join(input.packageRoot, "dist/src/compaction-worker-client.js")));
  const { resolveCompactorConfig } = await import(pathToFileURL(join(input.packageRoot, "dist/src/compactor.js")));
  const prefix = `client-${input.ordinal}-`;
  const entries = syntheticEntries(40).map((entry) => ({ ...entry, id: prefix + entry.id,
    parentId: entry.parentId == null ? null : prefix + entry.parentId }));
  const sessionPath = join(input.directory, `source-${input.ordinal}.jsonl`);
  await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: prefix })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  const metadata = await stat(sessionPath);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("disconnect", abort);
  process.on("message", (message) => { if (message?.action === "abort") abort(); });
  const rows = [];
  try {
    for (let repeat = 0; repeat < REPEATS && !controller.signal.aborted; repeat++) {
      const request = { schemaVersion: 1, jobId: `${prefix}${repeat}`, jobType: "replay-compaction", sessionPath,
        expectedSource: { deviceId: String(metadata.dev), inodeId: String(metadata.ino), size: metadata.size, mtimeMs: metadata.mtimeMs },
        deadlineMs: Date.now() + JOB_MS, niceLevel: 10, branchLeafId: entries.at(-1).id, firstKeptEntryId: entries.at(-1).id,
        config: resolveCompactorConfig({ targetTokens: 4_000, enableSemanticCompression: false }), hardOutputTokens: 25_000,
        retentionHints: "", pinnedMemoryText: "", candidateStoreEnabled: false, cacheEnabled: false };
      const { response } = await runCompactionWorker(request, { slots: input.slots, schedulerDirectory: input.schedulerDirectory,
        workerTimeoutMs: JOB_MS, schedulerTimeoutMs: JOB_MS * 3, signal: controller.signal });
      const ok = response.status === "ok";
      rows.push({ code: ok ? "ok" : response.failureCode,
        hash: ok ? digest(response.replay.planSources) : null,
        leakage: ok && response.replay.planSources.some((unit) => unit.sourceRefs.some((ref) => !ref.entryId.startsWith(prefix))) });
    }
    return { rows, peakRssKiB: process.resourceUsage().maxRSS };
  } finally { process.removeListener("disconnect", abort); }
}
function startClient(input) {
  const child = fork(SELF, ["--child"], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: childEnvironment(),
    execArgv: ["--max-old-space-size=512"] });
  let result;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; if (child.connected) child.send({ action: "abort" }); }, CLIENT_MS);
  // Actual worker deadlines remain enforced by the runtime even if a client dies.
  const hardTimer = setTimeout(() => child.kill("SIGKILL"), CLIENT_MS + JOB_MS + 10_000);
  child.on("message", (value) => { if (value?.kind === "result") result = value.result; });
  const settled = new Promise((done) => {
    child.once("error", () => { /* close is the process-lifecycle boundary */ });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(hardTimer);
      done({ status: code === 0 && !signal && !timedOut && result ? "ok" : "failed", ...result });
    });
  });
  child.send(input);
  return { settled, abort() { if (child.connected) child.send({ action: "abort" }); } };
}
export async function runIndependentClientSoak(packageRoot, expectedVersion) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.version !== expectedVersion) throw new Error("soak-version-mismatch");
  const { acquireHostWorkerSlot, schedulerArtifactCounts } = await import(pathToFileURL(join(packageRoot, "dist/src/host-worker-scheduler.js")));
  const directory = await mkdtemp(join(tmpdir(), "chrono-independent-soak-"));
  const cases = [];
  const active = [];
  let monitor;
  try {
    for (const slots of [1, 2, 4]) {
      const schedulerDirectory = join(directory, `scheduler-${slots}`);
      // Reproduce F001 before independent clients reuse this exact namespace.
      const fault = join(schedulerDirectory, "turns.json");
      await mkdir(fault, { recursive: true, mode: 0o700 });
      let refused = false;
      try { await acquireHostWorkerSlot({ directory: schedulerDirectory, slots, priority: "high", jobType: "replay-compaction", timeoutMs: 2000 }); }
      catch (error) { refused = error.code === "EISDIR"; }
      const afterFault = await schedulerArtifactCounts(schedulerDirectory);
      await rm(fault, { recursive: true }); // Remove only the injected directory.
      const admissionRecovered = refused && afterFault.slots === 0 && afterFault.tickets === 0;
      if (!admissionRecovered) throw new Error("soak-admission-recovery-failed");
      let maximumSlots = 0;
      let sampleFailed = false;
      let sampling = Promise.resolve();
      monitor = setInterval(() => {
        sampling = sampling.then(async () => {
          try { const counts = await schedulerArtifactCounts(schedulerDirectory); maximumSlots = Math.max(maximumSlots, counts.slots); }
          catch { sampleFailed = true; }
        });
      }, 10);
      const clients = Array.from({ length: CLIENTS }, (_, ordinal) => startClient({ packageRoot, directory, schedulerDirectory, slots, ordinal: ordinal + 1 }));
      active.push(...clients);
      const results = await Promise.all(clients.map((item) => item.settled));
      clearInterval(monitor); monitor = undefined;
      await sampling;
      const residue = await schedulerArtifactCounts(schedulerDirectory);
      const rows = results.flatMap((item) => item.rows ?? []);
      const successful = results.every((item) => item.status === "ok" && item.rows?.length === REPEATS && item.rows.every((row) => row.code === "ok"));
      const equality = successful && results.every((item) => new Set(item.rows.map((row) => row.hash)).size === 1);
      const leakage = rows.some((row) => row.leakage);
      const memoryBounded = results.every((item) => Number.isFinite(item.peakRssKiB) && item.peakRssKiB <= MAX_RSS_KIB);
      cases.push({ slots, admissionRecovered, clients: CLIENTS, repeats: REPEATS, jobs: rows.length, successful, equality, leakage, memoryBounded,
        maximumObservedSlots: maximumSlots, sampleFailed, residue,
        codes: rows.map((row) => row.code),
        status: successful && equality && !leakage && memoryBounded && !sampleFailed && maximumSlots > 0 && maximumSlots <= slots && residue.slots === 0 && residue.tickets === 0 ? "passed" : "failed" });
    }
    return { schemaVersion: 1, kind: "chrono-m03-independent-client-replay-soak", version: manifest.version,
      status: cases.every((item) => item.status === "passed") ? "passed" : "failed", cases,
      limitations: ["Scheduler samples are advisory occupancy, not proof of kernel capacity; runtime fault tests must establish that boundary separately."] };
  } finally {
    if (monitor) clearInterval(monitor);
    active.forEach((item) => item.abort());
    await Promise.all(active.map((item) => item.settled));
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[2] === "--child") {
  process.once("message", async (input) => {
    try { const result = await client(input); process.send({ kind: "result", result }, () => process.disconnect()); }
    catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--package-root" || args[2] !== "--expected-version" || !/^\d+\.\d+\.\d+$/.test(args[3])) {
    console.log(JSON.stringify({ status: "failed", code: "soak-options" })); process.exitCode = 1;
  } else {
    runIndependentClientSoak(resolve(args[1]), args[3]).then((report) => {
      console.log(JSON.stringify(report)); if (report.status !== "passed") process.exitCode = 1;
    }).catch(() => { console.log(JSON.stringify({ status: "failed", code: "soak-failed" })); process.exitCode = 1; });
  }
}
