#!/usr/bin/env node
// @ts-nocheck
// Synthetic-only high-cardinality campaign. Run npm run build before this script.
// No archive paths, providers, native SQL imports, or production scheduler namespace.
import assert from "node:assert/strict";
import { spawnSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const SELF = fileURLToPath(import.meta.url), MiB = 1024 * 1024;
const id = n => `many-${String(n).padStart(8, "0")}`;
const record = (n, parent = n > 1 ? id(n - 1) : null) => ({ type: "message", id: id(n), parentId: parent,
  timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: `Unique synthetic record ${n}: λ \\n ${createHash("sha256").update(String(n)).digest("hex")}` }] } });
const line = (n, parent) => JSON.stringify(record(n, parent)) + "\n";
function memory() {
  const cg = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(x => x.startsWith("0::/")).slice(3);
  const value = name => Number(readFileSync(join("/sys/fs/cgroup", cg, name), "utf8").trim());
  return { processPeakRssBytes: process.resourceUsage().maxRSS * 1024, cgroupMemoryPeakBytes: value("memory.peak"), cgroupMemoryLimitBytes: value("memory.max") };
}
async function hashFile(path) { const h = createHash("sha256"); for await (const b of createReadStream(path, { highWaterMark: 65536 })) h.update(b); return h.digest("hex"); }
function generate(path, count) {
  const fd = openSync(path, "wx", 0o600), h = createHash("sha256");
  try { for (let n = 1; n <= count; n++) { const b = Buffer.from(line(n)); h.update(b); for (let at = 0; at < b.length;) at += writeSync(fd, b, at, b.length - at); } }
  finally { closeSync(fd); }
  return { count, hash: h.digest("hex"), bytes: statSync(path).size, memory: memory() };
}
const cleanEnv = () => Object.fromEntries(["PATH", "HOME", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
function metrics() { return { jobs: 0, sourceBytes: 0, maxSourceBytes: 0, maxResponseBytes: 0, maxWorkerRssBytes: 0, maxWorkerCgroupBytes: 0, readChars: 0, writtenChars: 0, storageReadBytes: 0, storageWrittenBytes: 0, userCpuMicros: 0, systemCpuMicros: 0, maxWallMs: 0 }; }
async function caller(base, schedulerDirectory, slots, m) {
  const { runCatalogWorker, CATALOG_WORKER_CAPS } = await import("../dist/src/catalog-worker-client.js");
  assert.equal(CATALOG_WORKER_CAPS.memoryBytes, 256 * MiB); assert.equal(CATALOG_WORKER_CAPS.heapMiB, 128);
  return async request => {
    const start = performance.now(), response = await runCatalogWorker({ ...base, ...request }, { schedulerDirectory, slots });
    const wallMs = performance.now() - start;
    assert.equal(response.ok, true, `${request.op}: ${response.code}`); assert.equal(response.result.error, undefined);
    const o = response.result.workerObservation;
    assert.ok(o && o.processIo, "kernel worker observations required"); assert.equal(o.cgroupMemoryLimitBytes, 256 * MiB);
    assert.ok(o.processPeakRssBytes <= 256 * MiB && o.cgroupMemoryPeakBytes <= 256 * MiB);
    assert.ok(response.sourceBytes <= 8 * MiB);
    const bytes = Buffer.byteLength(JSON.stringify(response)); assert.ok(bytes <= 256 * 1024);
    m.jobs++; m.sourceBytes += response.sourceBytes; m.maxSourceBytes = Math.max(m.maxSourceBytes, response.sourceBytes);
    m.maxResponseBytes = Math.max(m.maxResponseBytes, bytes); m.maxWallMs = Math.max(m.maxWallMs, wallMs);
    m.maxWorkerRssBytes = Math.max(m.maxWorkerRssBytes, o.processPeakRssBytes); m.maxWorkerCgroupBytes = Math.max(m.maxWorkerCgroupBytes, o.cgroupMemoryPeakBytes);
    for (const k of ["readChars", "writtenChars", "storageReadBytes", "storageWrittenBytes"]) m[k] += o.processIo[k];
    m.userCpuMicros += o.userCpuMicros; m.systemCpuMicros += o.systemCpuMicros;
    return response;
  };
}
async function window(call, view, after, end, pages = 3) {
  let count = 0;
  for (let page = 0; page < pages; page++) {
    const r = await call({ op: "page", view, after, limit: 16 }); assert.equal(r.sourceBytes, 0, "metadata query must not read source");
    const expected = Math.min(16, Math.max(0, end - after)); assert.equal(r.result.events.length, expected);
    for (const e of r.result.events) { assert.equal(e.seq, ++after); assert.equal(e.metadata.id, id(after)); count++; }
  }
  return { after, count };
}
async function independent(input) {
  const m = metrics(), call = await caller(input.base, input.schedulerDirectory, input.slots, m);
  // Each process has a distinct cursor, so coalescing cannot turn this into one job.
  for (let repeat = 0; repeat < 3; repeat++) await window(call, input.view, input.count - 160 + input.ordinal * 16, input.count, 2);
  return { pid: process.pid, metrics: m, memory: memory() };
}
function startClient(input) {
  return new Promise((resolve, reject) => {
    const child = fork(SELF, ["--client"], { execArgv: ["--max-old-space-size=128"], env: cleanEnv(), stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let result; child.on("message", x => { result = x; }); child.once("error", reject);
    child.once("close", (code, signal) => code === 0 && !signal && result?.passed ? resolve(result) : reject(new Error(`independent-client-failed: ${JSON.stringify(result)}`)));
    child.send(input);
  });
}
async function campaign(small) {
  const count = small ? 1024 : 50000, root = mkdtempSync(join(tmpdir(), "chrono-many-records-"));
  const sourcePath = join(root, "synthetic.jsonl"), schedulerDirectory = join(root, "scheduler");
  const base = { v: 1, catalogDirectory: join(root, "catalog"), sessionKey: "synthetic-many" };
  const ingest = { op: "ingestStep", sourcePath, shardKey: "one", branchKey: "main", shardOrdinal: 0 };
  const report = { passed: false, profile: small ? "development" : "50000", root, runtime: { node: process.version, abi: process.versions.modules }, phases: {}, independent: [] };
  const started = performance.now();
  const { schedulerArtifactCounts } = await import("../dist/src/host-worker-scheduler.js");
  const { runtimeUnitName, runtimeUnitState } = await import("../dist/src/worker-runtime-systemd.js");
  async function settlement(slots, namespace = schedulerDirectory) {
    const counts = await schedulerArtifactCounts(namespace);
    assert.deepEqual(counts, { tickets: 0, slots: 0 });
    const units = await Promise.all(Array.from({ length: slots }, (_, i) => runtimeUnitState(runtimeUnitName(namespace, i))));
    assert.ok(units.every(x => x === "inactive" || x === "failed"), JSON.stringify(units));
    const names = readdirSync(namespace);
    const rendezvous = join(`/run/user/${process.getuid()}/chrono-rendezvous`, createHash("sha256").update(namespace).digest("hex").slice(0, 24));
    const rendezvousEntries = readdirSync(rendezvous);
    assert.ok(rendezvousEntries.every(x => x === "lock"), "no live task sockets after client settlement");
    return { ...counts, units, namespaceEntries: names.length, rendezvousEntries, rendezvous };
  }
  try {
    assert.equal(memory().cgroupMemoryLimitBytes, 256 * MiB, "launch through script's contained parent");
    const gen = spawnSync(process.execPath, ["--max-old-space-size=128", SELF, "--generate", sourcePath, String(count)], { encoding: "utf8", maxBuffer: 65536, timeout: 120000, env: cleanEnv() });
    assert.equal(gen.status, 0, gen.stderr); report.generated = JSON.parse(gen.stdout); assert.equal(report.generated.count, count);
    assert.ok(report.generated.memory.processPeakRssBytes <= 128 * MiB);
    const initialIdentity = statSync(sourcePath);
    let m = metrics(), call = await caller(base, schedulerDirectory, 1, m);
    report.phases.initial = m;
    let caught = false;
    for (let jobs = 0; jobs < count; jobs++) { const r = await call(ingest); if (r.result.caughtUp) { caught = true; break; } assert.equal(r.result.incompleteTail, false); }
    assert.ok(caught); assert.ok(m.sourceBytes <= report.generated.bytes + m.jobs * 131072, "delta plus <=64KiB discarded read-ahead and <=64KiB anchors per job");
    const status = await call({ op: "status", shardKey: "one" }); assert.equal(status.result.records, count); assert.equal(status.result.committed, report.generated.bytes);
    assert.equal(await hashFile(sourcePath), report.generated.hash, "initial source unchanged before fixture appends");
    m = metrics(); call = await caller(base, schedulerDirectory, 1, m);
    const view = (await call({ op: "pin", branchKey: "main", leaf: { shardKey: "one", eventId: id(count) } })).result.view;
    report.phases.pin = m;
    report.phases.pinnedQueries = [];
    for (const after of [0, Math.floor(count / 2), count - 32]) {
      const queryMetrics = metrics(), query = await caller(base, schedulerDirectory, 1, queryMetrics);
      const observed = await window(query, view, after, count);
      report.phases.pinnedQueries.push({ cursor: after, ...observed, metrics: queryMetrics });
    }
    m = metrics(); call = await caller(base, schedulerDirectory, 1, m);
    for (let round = 1; round <= 3; round++) {
      for (let noop = 0; noop < 2; noop++) assert.ok((await call(ingest)).sourceBytes <= 32768);
      const n = count + round; const bytes = line(n); appendFileSync(sourcePath, bytes);
      const r = await call(ingest); assert.equal(r.result.caughtUp, true); assert.ok(r.sourceBytes <= Buffer.byteLength(bytes) + 65536);
      await window(call, view, count - 20, count, 3);
    }
    // Two branches fork from an earlier main event. They are physically interleaved in the same shard.
    const forkParent = Math.floor(count / 2), forkA = count + 4, forkB = count + 5;
    appendFileSync(sourcePath, line(forkA, id(forkParent)) + line(forkB, id(forkParent)));
    assert.equal((await call(ingest)).result.caughtUp, true);
    for (const leaf of [forkA, forkB]) {
      const forkView = (await call({ op: "pin", branchKey: "main", leaf: { shardKey: "one", eventId: id(leaf) } })).result.view;
      const r = await call({ op: "page", view: forkView, after: forkParent - 2, limit: 16 });
      assert.deepEqual(r.result.events.map(e => e.metadata.id), [id(forkParent - 1), id(forkParent), id(leaf)]);
      const e = r.result.events.at(-1), raw = await call({ op: "raw", view: forkView, eventSeq: e.seq, offset: e.rawStart, length: e.endByte - e.rawStart });
      assert.equal(Buffer.from(raw.result.data, "base64").toString(), line(leaf, id(forkParent)), "exact fork raw recovery");
    }
    await window(call, view, count - 20, count, 3); // Neither later continuation nor sibling forks leak into the old cut.
    for (const seq of [1, Math.floor(count / 2), count]) {
      const e = (await call({ op: "page", view, after: seq - 1, limit: 1 })).result.events[0];
      const raw = await call({ op: "raw", view, eventSeq: e.seq, offset: e.rawStart, length: e.endByte - e.rawStart });
      assert.equal(Buffer.from(raw.result.data, "base64").toString(), line(seq), "exact original raw recovery after appends");
    }
    report.phases.appendForkRaw = m;
    for (const slots of [1, 2]) {
      // M03 pins admission policy per namespace. Never change slots on an existing namespace.
      const clientScheduler = join(root, `scheduler-clients-${slots}`);
      let maximumObservedSlots = 0, sampling = Promise.resolve();
      const timer = setInterval(() => { sampling = sampling.then(async () => { const x = await schedulerArtifactCounts(clientScheduler); maximumObservedSlots = Math.max(maximumObservedSlots, x.slots); }); }, 25);
      let settled;
      try { settled = await Promise.allSettled([0, 1].map(ordinal => startClient({ base, schedulerDirectory: clientScheduler, slots, ordinal, count, view }))); }
      finally { clearInterval(timer); await sampling; }
      const results = settled.map(x => x.status === "fulfilled" ? x.value : { passed: false, error: String(x.reason) });
      report.independent.push({ slots, maximumObservedSlots, results, settlement: await settlement(slots, clientScheduler) });
      assert.ok(results.every(x => x.passed)); assert.equal(new Set(results.map(x => x.pid)).size, 2);
      assert.ok(maximumObservedSlots > 0 && maximumObservedSlots <= slots, "advisory occupancy sample");
    }
    // Recompute expected bytes without retaining the catalog, then independently stream the actual source.
    const expected = createHash("sha256"); for (let n = 1; n <= count + 3; n++) expected.update(line(n));
    expected.update(line(forkA, id(forkParent))).update(line(forkB, id(forkParent)));
    assert.equal(await hashFile(sourcePath), expected.digest("hex"));
    const finalIdentity = statSync(sourcePath); assert.equal(finalIdentity.dev, initialIdentity.dev); assert.equal(finalIdentity.ino, initialIdentity.ino);
    report.sourceImmutability = { passed: true, meaning: "Full deterministic final hash and original device/inode; only the five explicit fixture appends are permitted." };
    report.settlement = await settlement(2); report.memory = memory(); assert.ok(report.memory.cgroupMemoryPeakBytes <= 256 * MiB);
    report.passed = true;
  } catch (error) { report.failure = { message: error.message, stack: error.stack }; try { report.settlement = await settlement(2); } catch (e) { report.cleanupFailure = e.message; } }
  report.memory ??= memory();
  report.wallMs = Math.round(performance.now() - started);
  report.limitations = ["Sampled cursor windows cover first, middle and late pages, not a full 50k page walk; status proves ingested cardinality.", "Worker RSS includes V8 and native memory; cgroup peak also includes bridge and kernel-accounted memory. Native SQLite allocation is not separately measured.", "Kernel process I/O includes native SQLite, JS, startup and measurement reads; sourceBytes is only the source-reader counter, not native I/O.", "Latency and CPU are observations, not EXPLAIN plans or a proof of SQL complexity. Scheduler samples are advisory; settled unit states and admissions are checked separately.", "Parent and both independent clients share one 256MiB OS cgroup; each has 128MiB V8. Generator has 128MiB V8 and measured RSS <=128MiB, within the parent cgroup."];
  if (report.passed) { for (const lane of report.independent) rmSync(lane.settlement.rendezvous, { recursive: true, force: true }); rmSync(report.settlement.rendezvous, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); report.namespaceRemoved = true; } // Retain every failed namespace for diagnosis.
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
}
if (process.argv[2] === "--generate") console.log(JSON.stringify(generate(process.argv[3], Number(process.argv[4]))));
else if (process.argv[2] === "--client") process.once("message", async input => {
  let result; try { result = { passed: true, ...await independent(input) }; } catch (e) { result = { passed: false, error: e.message }; process.exitCode = 1; }
  process.send(result, () => process.disconnect());
});
else if (process.argv[2] === "--contained") await campaign(process.argv[3] === "--small");
else {
  assert.ok(process.argv.slice(2).every(x => x === "--small"), "only --small supported");
  const run = spawnSync("/usr/bin/systemd-run", ["--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=chrono-many-parent-${randomUUID()}`, "--property=MemoryMax=268435456", "--property=MemorySwapMax=0", "--property=KillMode=control-group", "--property=OOMPolicy=kill", "--property=TasksMax=128", "--property=RuntimeMaxSec=1800", process.execPath, "--max-old-space-size=128", SELF, "--contained", ...process.argv.slice(2)], { stdio: "inherit", env: cleanEnv() });
  process.exitCode = run.status ?? 1;
}
