#!/usr/bin/env node
// @ts-nocheck
// Reproducible synthetic-only M05 campaign. Run the package build first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const KiB = 1024, MiB = 1024 * KiB;
const id = n => `capsule-${String(n).padStart(8, "0")}`;
const suffix = "late-unicode: λ 😀 \n CRLF\r\n lone=\ud800 exact-end";
const smallBody = n => `synthetic body ${n}; not completed; pending approval; λ 😀`;
const ordinaryLine = (n, parent = n > 1 ? id(n - 1) : null, body = smallBody(n)) => JSON.stringify({
  type: "message", id: id(n), parentId: parent,
  timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: body }] },
}) + "\n";
const cleanEnv = () => Object.fromEntries(["PATH", "HOME", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));

function writeAll(fd, value, hash) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash?.update(bytes);
  for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
}
function generate(path, records, giantMiB) {
  const targetUnits = giantMiB * MiB;
  assert.ok(targetUnits >= suffix.length);
  const fd = openSync(path, "wx", 0o600), hash = createHash("sha256");
  const prefix = Buffer.alloc(32 * KiB, 0x47);
  try {
    for (let n = 1; n < records; n++) writeAll(fd, ordinaryLine(n), hash);
    const n = records, parent = n > 1 ? id(n - 1) : null;
    writeAll(fd, `{"type":"message","id":${JSON.stringify(id(n))},"parentId":${JSON.stringify(parent)},"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"`, hash);
    let remaining = targetUnits - suffix.length;
    while (remaining > 0) { const take = Math.min(remaining, prefix.length); writeAll(fd, prefix.subarray(0, take), hash); remaining -= take; }
    writeAll(fd, JSON.stringify(suffix).slice(1, -1), hash);
    writeAll(fd, `"}]}}\n`, hash);
  } finally { closeSync(fd); }
  return { records, giantDecodedUnits: targetUnits, sourceBytes: statSync(path).size, sourceSha256: hash.digest("hex"), generatorPeakRssBytes: process.resourceUsage().maxRSS * KiB };
}
async function hashFile(path, appended = "") { const hash = createHash("sha256"); for await (const bytes of createReadStream(path, { highWaterMark: 64 * KiB })) hash.update(bytes); hash.update(appended); return hash.digest("hex"); }
function parseCli(args) {
  let records = 3, giantMiB = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--records") records = Number(args[++i]);
    else if (args[i] === "--giant-mib") giantMiB = Number(args[++i]);
    else throw new Error(`unknown-option:${args[i]}`);
  }
  assert.ok(Number.isSafeInteger(records) && records >= 2 && records <= 50_000, "--records must be an integer in [2,50000]");
  assert.ok(Number.isSafeInteger(giantMiB) && giantMiB >= 1 && giantMiB <= 512, "--giant-mib must be an integer in [1,512]");
  return { records, giantMiB, profile: records <= 16 && giantMiB <= 4 ? "small" : records >= 10_000 ? "high-cardinality" : "giant" };
}
function parentMemory() {
  const result = { processPeakRssBytes: process.resourceUsage().maxRSS * KiB, osContainedByThisScript: false };
  try {
    const relative = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::/"))?.slice(3);
    const number = name => { const text = readFileSync(join("/sys/fs/cgroup", relative, name), "utf8").trim(); return /^\d+$/.test(text) ? Number(text) : null; };
    if (relative) { result.observedCgroupPeakBytes = number("memory.peak"); result.observedCgroupLimitBytes = number("memory.max"); }
  } catch { /* observation is optional */ }
  return result;
}
function newMetrics() {
  return { calls: 0, sourceBytes: 0, maxSourceBytes: 0, maxResponseBytes: 0, maxWorkerRssBytes: 0, maxWorkerCgroupPeakBytes: 0,
    processReadChars: 0, processWrittenChars: 0, storageReadBytes: 0, storageWrittenBytes: 0, userCpuMicros: 0, systemCpuMicros: 0,
    totalWallMs: 0, maxWallMs: 0, catalogCalls: 0, capsuleCalls: 0 };
}
function observe(metrics, kind, response, wallMs) {
  const bytes = Buffer.byteLength(JSON.stringify(response));
  assert.ok(bytes <= 256 * KiB, "bounded worker response");
  assert.ok(response.sourceBytes <= 8 * MiB, "bounded per-job source read");
  const observation = response.result?.workerObservation;
  assert.ok(observation?.processIo, "kernel worker observation required");
  assert.equal(observation.cgroupMemoryLimitBytes, 256 * MiB, "actual worker cgroup limit");
  assert.ok(observation.processPeakRssBytes <= 256 * MiB && observation.cgroupMemoryPeakBytes <= 256 * MiB, "worker memory ceiling");
  metrics.calls++; metrics[`${kind}Calls`]++; metrics.sourceBytes += response.sourceBytes;
  metrics.maxSourceBytes = Math.max(metrics.maxSourceBytes, response.sourceBytes); metrics.maxResponseBytes = Math.max(metrics.maxResponseBytes, bytes);
  metrics.maxWorkerRssBytes = Math.max(metrics.maxWorkerRssBytes, observation.processPeakRssBytes);
  metrics.maxWorkerCgroupPeakBytes = Math.max(metrics.maxWorkerCgroupPeakBytes, observation.cgroupMemoryPeakBytes);
  metrics.totalWallMs += wallMs; metrics.maxWallMs = Math.max(metrics.maxWallMs, wallMs);
  for (const key of ["readChars", "writtenChars", "storageReadBytes", "storageWrittenBytes"]) metrics[key === "readChars" ? "processReadChars" : key === "writtenChars" ? "processWrittenChars" : key] += observation.processIo[key];
  metrics.userCpuMicros += observation.userCpuMicros; metrics.systemCpuMicros += observation.systemCpuMicros;
}

async function campaign(options) {
  const campaignStarted = performance.now();
  const root = mkdtempSync(join(tmpdir(), "chrono-capsule-benchmark-"));
  const sourcePath = join(root, "main.jsonl"), forkPath = join(root, "fork.jsonl");
  const catalogDirectory = join(root, "catalog"), derivedDirectory = join(root, "derived"), schedulerDirectory = join(root, `scheduler-${randomUUID()}`);
  const report = { schema: 1, passed: false, syntheticOnly: true, userWork: false, profile: options.profile, parameters: { records: options.records, giantMiB: options.giantMiB },
    runtime: { node: process.version, abi: process.versions.modules }, configured: {}, phases: {}, samples: {}, limitations: [
      "This synthetic campaign is evidence, not M05 scale acceptance, production activation, or storage correctness review.",
      "Current derivation reads about one raw 64 KiB page per giant-body job; larger campaigns can cost minutes.",
      "Worker RSS and cgroup peaks include JavaScript, native SQLite, startup, bridge, and kernel-accounted memory; native SQLite allocation is configured but not separately observed.",
      "Source-byte counters exclude independent SHA verification. Process I/O includes native SQLite, JavaScript, startup, and measurement reads; storage counters exclude cache hits.",
      "Only bounded first/late capsule and exact chunk samples are retained; the campaign does not keep lifetime maps of records, capsules, or status responses.",
      "The parent process is measured separately and is not claimed contained because this script does not launch itself in an OS unit.",
    ] };
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort("campaign-deadline"), 30 * 60_000);
  let completed = false;
  try {
    const generated = spawnSync(process.execPath, ["--max-old-space-size=64", SELF, "--generate", sourcePath, String(options.records), String(options.giantMiB)], { encoding: "utf8", maxBuffer: 64 * KiB, timeout: 120_000, env: cleanEnv() });
    assert.equal(generated.status, 0, generated.stderr); report.generated = JSON.parse(generated.stdout);
    assert.ok(report.generated.generatorPeakRssBytes <= 128 * MiB, "bounded streaming generator RSS");
    const initialStat = statSync(sourcePath);
    const { runCatalogWorker, CATALOG_WORKER_CAPS } = await import("../dist/src/catalog-worker-client.js");
    const { runCapsuleWorker, CAPSULE_WORKER_CAPS } = await import("../dist/src/capsule-worker-client.js");
    const { CAPSULE_LIMITS } = await import("../dist/src/capsule-contract.js");
    const { schedulerArtifactCounts } = await import("../dist/src/host-worker-scheduler.js");
    const { runtimeUnitName, runtimeUnitState } = await import("../dist/src/worker-runtime-systemd.js");
    report.configured = { catalog: { v8HeapBytes: CATALOG_WORKER_CAPS.heapMiB * MiB, workerMemoryBytes: CATALOG_WORKER_CAPS.memoryBytes, deadlineMs: CATALOG_WORKER_CAPS.timeoutMs },
      capsule: { v8HeapBytes: CAPSULE_WORKER_CAPS.heapMiB * MiB, workerMemoryBytes: CAPSULE_WORKER_CAPS.memoryBytes, deadlineMs: CAPSULE_WORKER_CAPS.timeoutMs, nativeSqliteBytes: CAPSULE_LIMITS.nativeSqliteBytes },
      campaignDeadlineMs: 30 * 60_000, schedulerSlots: 1 };
    let phase = "catalogInitial"; report.phases[phase] = newMetrics();
    const catalogBase = { v: 1, catalogDirectory, sessionKey: "synthetic-capsule-benchmark" };
    const catalogCall = async request => { const started = performance.now(); const response = await runCatalogWorker({ ...catalogBase, ...request }, { schedulerDirectory, slots: 1, signal: abort.signal });
      assert.equal(response.ok, true, `${request.op}:${response.code}`); observe(report.phases[phase], "catalog", response, performance.now() - started); return response.result; };
    const ingestMain = { op: "ingestStep", sourcePath, shardKey: "main", branchKey: "main", shardOrdinal: 0 };
    const catalogGuard = Math.ceil(report.generated.sourceBytes / (7 * MiB)) + Math.ceil(options.records / 512) + 32;
    let caught = false;
    for (let calls = 0; calls < catalogGuard; calls++) if ((await catalogCall(ingestMain)).caughtUp) { caught = true; break; }
    assert.ok(caught, "catalog campaign count guard");
    const initialStatus = await catalogCall({ op: "status", shardKey: "main" });
    assert.equal(initialStatus.records, options.records); assert.equal(initialStatus.committed, report.generated.sourceBytes);
    assert.equal(await hashFile(sourcePath), report.generated.sourceSha256, "source immutable after catalog ingestion");
    const oldView = (await catalogCall({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: id(options.records) } })).view;
    const identity = { storeKey: randomUUID(), sessionKey: oldView.sessionKey, catalogStoreKey: oldView.storeKey, catalogGeneration: oldView.generation,
      derivedSchemaVersion: 1, capsuleSchemaVersion: 1, chunkSchemaVersion: 1, reducerSetVersion: "benchmark-v1", configHash: createHash("sha256").update("capsule-benchmark-v1").digest("hex") };
    const capsuleBase = { v: 1, catalogDirectory, derivedDirectory, identity };
    const capsuleCall = async request => { const started = performance.now(); const response = await runCapsuleWorker({ ...capsuleBase, ...request }, { schedulerDirectory, slots: 1, signal: abort.signal });
      assert.equal(response.ok, true, `${request.op}:${response.code}`); assert.equal(response.sqliteNativeLimitBytes, 64 * MiB); observe(report.phases[phase], "capsule", response, performance.now() - started); return response.result; };
    const derive = async (view, cursor) => {
      const guard = options.records * 6 + options.giantMiB * 32 + 64;
      for (let calls = 0; calls < guard; calls++) { const result = await capsuleCall({ op: "derivePage", view, ...(cursor ? { cursor } : {}) }); cursor = result.cursor; if (result.complete) return cursor; }
      throw new Error("capsule campaign count guard");
    };
    phase = "deriveInitial"; report.phases[phase] = newMetrics();
    let cursor = await derive(oldView);
    const capsuleStatus = await capsuleCall({ op: "status", view: oldView });
    assert.equal(capsuleStatus.readiness.chunks.ready, options.records);
    const firstPage = await capsuleCall({ op: "capsulePage", view: oldView, limit: 1 });
    const latePage = await capsuleCall({ op: "capsulePage", view: oldView, afterEventSeq: options.records - 1, limit: 2 });
    const firstCapsule = firstPage.capsules[0], giantCapsule = latePage.capsules.find(item => item.source.eventSeq === options.records);
    assert.ok(firstCapsule && giantCapsule, "bounded capsule samples");
    report.samples.capsules = [{ eventSeq: firstCapsule.source.eventSeq, bodyHash: firstCapsule.source.bodyHash }, { eventSeq: giantCapsule.source.eventSeq, bodyHash: giantCapsule.source.bodyHash }];
    phase = "exactChunks"; report.phases[phase] = newMetrics();
    const headLength = Math.min(32_768, giantCapsule.source.decodedUtf16.end);
    const head = await capsuleCall({ op: "chunkRange", view: oldView, source: giantCapsule.source, decodedStart: 0, decodedLength: headLength, limit: 2 });
    assert.equal(Buffer.from(head.data, "base64").toString("utf16le"), "G".repeat(headLength), "exact first chunk");
    const lateStart = report.generated.giantDecodedUnits - suffix.length;
    const late = await capsuleCall({ op: "chunkRange", view: oldView, source: giantCapsule.source, decodedStart: lateStart, decodedLength: suffix.length, limit: 2 });
    assert.equal(Buffer.from(late.data, "base64").toString("utf16le"), suffix, "late Unicode exact range");
    report.samples.exactChunks = [{ start: 0, units: headLength, sha256Utf16le: createHash("sha256").update(Buffer.from("G".repeat(headLength), "utf16le")).digest("hex") },
      { start: lateStart, units: suffix.length, sha256Utf16le: createHash("sha256").update(Buffer.from(suffix, "utf16le")).digest("hex") }];
    phase = "appendNoopBranch"; report.phases[phase] = newMetrics();
    assert.equal((await catalogCall(ingestMain)).committed, report.generated.sourceBytes, "catalog noop");
    const noop = await capsuleCall({ op: "derivePage", view: oldView, cursor }); assert.equal(noop.complete, true, "capsule noop");
    const appendedId = options.records + 1, appendedLine = ordinaryLine(appendedId);
    const expectedFinalSha256 = await hashFile(sourcePath, appendedLine);
    appendFileSync(sourcePath, appendedLine);
    assert.equal((await catalogCall(ingestMain)).caughtUp, true);
    const newView = (await catalogCall({ op: "pin", branchKey: "main", leaf: { shardKey: "main", eventId: id(appendedId) } })).view;
    cursor = await derive(newView, cursor);
    const oldLateAgain = await capsuleCall({ op: "capsulePage", view: oldView, afterEventSeq: options.records - 1, limit: 2 });
    assert.equal(oldLateAgain.capsules.find(item => item.source.eventSeq === options.records)?.source.bodyHash, giantCapsule.source.bodyHash, "old pin immutable after append");
    const forkParent = id(Math.max(1, options.records - 1)), forkId = options.records + 2;
    appendFileSync(forkPath, ordinaryLine(forkId, forkParent, "synthetic fork; pending parent fixed explicitly"), { flag: "wx", mode: 0o600 });
    const forkIngest = { op: "ingestStep", sourcePath: forkPath, shardKey: "fork", branchKey: "fork", shardOrdinal: 1, parent: { shardKey: "main", eventId: forkParent } };
    assert.equal((await catalogCall(forkIngest)).caughtUp, true);
    const forkView = (await catalogCall({ op: "pin", branchKey: "fork", leaf: { shardKey: "fork", eventId: id(forkId) } })).view;
    const forkEvents = await catalogCall({ op: "page", view: forkView, after: Math.max(0, options.records - 2), limit: 4 });
    assert.equal(forkEvents.events.at(-1).metadata.id, id(forkId));
    await derive(forkView);
    const finalStatus = await capsuleCall({ op: "status", view: forkView });
    report.samples.readiness = { catalog: finalStatus.readiness.catalog, capsuleState: finalStatus.readiness.capsules.state, chunkState: finalStatus.readiness.chunks.state,
      eligible: finalStatus.readiness.chunks.eligible, ready: finalStatus.readiness.chunks.ready };
    const finalStat = statSync(sourcePath); assert.equal(finalStat.dev, initialStat.dev); assert.equal(finalStat.ino, initialStat.ino);
    const finalSha256 = await hashFile(sourcePath); assert.equal(finalSha256, expectedFinalSha256, "only the declared append changed the main source");
    report.sourceImmutability = { initialSha256Matched: true, finalSha256, finalExpectedSha256Matched: true, sameDeviceAndInode: true, permittedAppendRecords: 1 };
    clearTimeout(deadline);
    const counts = await schedulerArtifactCounts(schedulerDirectory); assert.deepEqual(counts, { tickets: 0, slots: 0 });
    const unit = await runtimeUnitState(runtimeUnitName(schedulerDirectory, 0)); assert.equal(unit, "inactive");
    report.settlement = { tickets: 0, slots: 0, unitsInactive: 1 };
    report.parentMemory = parentMemory(); report.passed = true; completed = true;
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : "campaign-failed";
    report.failure = { code, receiptRetained: true, diagnostics: "stderr" };
    console.error(error?.stack ?? error);
  } finally {
    clearTimeout(deadline); report.parentMemory ??= parentMemory();
    report.workerWallMs = Math.round(Object.values(report.phases).reduce((sum, item) => sum + item.totalWallMs, 0));
    report.wallMs = Math.round(performance.now() - campaignStarted);
    report.totalCalls = Object.values(report.phases).reduce((sum, item) => sum + item.calls, 0);
    if (completed) { rmSync(root, { recursive: true, force: true }); report.syntheticNamespaceRemoved = true; }
  }
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
}

if (process.argv[2] === "--generate") console.log(JSON.stringify(generate(process.argv[3], Number(process.argv[4]), Number(process.argv[5]))));
else await campaign(parseCli(process.argv.slice(2)));
