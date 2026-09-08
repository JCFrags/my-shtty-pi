// Synthetic-only M04 containment and incremental-I/O benchmark. No archive inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, openSync, closeSync, writeSync, appendFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createSyntheticSession } from "./synthetic-session.mjs";
const self = fileURLToPath(import.meta.url);
const digestIds = ids => { const h = createHash("sha256"); for (const id of ids) h.update(JSON.stringify(id)).update("\n"); return h.digest("hex"); };
if (process.argv[2] === "--generate") {
  const small = process.argv[4] === "small";
  const session = createSyntheticSession({ profile: "medium", eventCount: small ? 80 : 1024, toolResultBytes: 0, giantRecordBytes: 0, giantRecordIndex: small ? 78 : 1022, forkEvery: small ? 20 : 128, compactionCount: 4 });
  const fd = openSync(process.argv[3], "wx", 0o600);
  const h = createHash("sha256");
  try {
    for (const record of [session.header, ...session.entries]) {
      // Keep the M02 metadata/fork fixture, but materialize one body at a time.
      // Retaining all medium fixture bodies exhausted the generator's 512MiB heap.
      let emitted = record;
      if (record.message?.role === "toolResult") {
        const giantId = `syn-e-${String(small ? 79 : 1023).padStart(6, "0")}`;
        const size = record.id === giantId ? (small ? 9 : 16) * 1024 * 1024 : small ? 4096 : 1024 * 1024;
        const unit = "Synthetic M04 deterministic body 0123456789\\n";
        const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        emitted = { ...record, message: { ...record.message, content: [{ type: "text", text }] } };
      }
      const bytes = Buffer.from(JSON.stringify(emitted) + "\n");
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
      h.update(bytes);
    }
  } finally { closeSync(fd); }
  const byId = new Map(session.entries.map(entry => [entry.id, entry]));
  const ids = []; let entry = session.entries.at(-1);
  const leaf = entry.id;
  while (entry) { ids.push(entry.id); entry = byId.get(entry.parentId); }
  ids.reverse();
  console.log(JSON.stringify({ hash: h.digest("hex"), leaf, timelineCount: ids.length, timelineHash: digestIds(ids), records: session.entries.length + 1 }));
} else {
  assert.ok(process.argv.slice(2).every(arg => arg === "--small"), "only --small is supported; no external source paths");
  const { runCatalogWorker } = await import("../dist/src/catalog-worker-client.js");
  const root = mkdtempSync(join(tmpdir(), "chrono-m04-benchmark-"));
  const sourcePath = join(root, "synthetic.jsonl");
  const schedulerDirectory = join(root, "scheduler");
  const base = { v: 1, catalogDirectory: join(root, "catalog"), sessionKey: "synthetic-medium" };
  const ingest = { op: "ingestStep", shardKey: "one", branchKey: "timeline", shardOrdinal: 0, sourcePath };
  const metrics = { jobs: 0, workerSourceBytes: 0, maxJobSourceBytes: 0, maxResponseBytes: 0, maxProcessRssBytes: 0, maxCgroupMemoryBytes: 0, processReadChars: 0, processWrittenChars: 0, storageReadBytes: 0, storageWrittenBytes: 0 };
  async function call(request) {
    const response = await runCatalogWorker({ ...base, ...request }, { schedulerDirectory });
    assert.equal(response.ok, true, response.code);
    assert.equal(response.result.error, undefined, response.result.error);
    assert.ok(response.sourceBytes <= 8 * 1024 * 1024);
    metrics.jobs++; metrics.workerSourceBytes += response.sourceBytes;
    metrics.maxJobSourceBytes = Math.max(metrics.maxJobSourceBytes, response.sourceBytes);
    metrics.maxResponseBytes = Math.max(metrics.maxResponseBytes, Buffer.byteLength(JSON.stringify(response)));
    const observation = response.result.workerObservation;
    assert.ok(observation, "contained worker observation required");
    assert.equal(observation.cgroupMemoryLimitBytes, 256 * 1024 * 1024, "actual per-job containment limit");
    metrics.maxProcessRssBytes = Math.max(metrics.maxProcessRssBytes, observation.processPeakRssBytes);
    metrics.maxCgroupMemoryBytes = Math.max(metrics.maxCgroupMemoryBytes, observation.cgroupMemoryPeakBytes ?? 0);
    if (observation.processIo) {
      metrics.processReadChars += observation.processIo.readChars;
      metrics.processWrittenChars += observation.processIo.writtenChars;
      metrics.storageReadBytes += observation.processIo.storageReadBytes;
      metrics.storageWrittenBytes += observation.processIo.storageWrittenBytes;
    }
    return response;
  }
  async function ingestAll() {
    for (let jobs = 0; jobs < 4096; jobs++) {
      const response = await call(ingest);
      if (response.result.caughtUp) return;
      assert.equal(response.result.incompleteTail, false, "complete generated input cannot require append");
    }
    throw new Error("catalog-benchmark-step-limit");
  }
  async function timeline(view) {
    let after = 0, count = 0;
    const h = createHash("sha256");
    for (let pages = 0; pages < 256; pages++) {
      const response = await call({ op: "page", view, after, limit: 16 });
      if (!response.result.events.length) return { count, hash: h.digest("hex") };
      for (const event of response.result.events) {
        assert.ok(event.seq > after); after = event.seq; count++;
        h.update(JSON.stringify(event.metadata.id)).update("\n");
      }
    }
    throw new Error("catalog-benchmark-page-limit");
  }
  const started = performance.now();
  let completed = false;
  try {
    const generated = spawnSync(process.execPath, ["--max-old-space-size=512", self, "--generate", sourcePath, process.argv.includes("--small") ? "small" : "medium"], { encoding: "utf8", maxBuffer: 65536, timeout: 120000 });
    assert.equal(generated.status, 0, generated.stderr);
    const expected = JSON.parse(generated.stdout);
    const sourceBytes = statSync(sourcePath).size;
    if (!process.argv.includes("--small")) assert.ok(sourceBytes >= 250 * 1024 * 1024 && sourceBytes <= 500 * 1024 * 1024);
    await ingestAll();
    const initial = { jobs: metrics.jobs, sourceBytes: metrics.workerSourceBytes };
    assert.ok(initial.sourceBytes <= sourceBytes + initial.jobs * 65536, "initial delta plus fixed anchor overhead");
    const noop = await call(ingest); assert.ok(noop.sourceBytes <= 32768);
    const pinned = (await call({ op: "pin", branchKey: "timeline", leaf: { shardKey: "one", eventId: expected.leaf } })).result.view;
    assert.deepEqual(await timeline(pinned), { count: expected.timelineCount, hash: expected.timelineHash });
    // Independent verifier read, NOT part of catalog's reported source-read budget.
    const h = createHash("sha256");
    for await (const bytes of createReadStream(sourcePath, { highWaterMark: 65536 })) h.update(bytes);
    assert.equal(h.digest("hex"), expected.hash, "catalog never rewrites source");
    const appended = JSON.stringify({ type: "message", id: "appended", parentId: expected.leaf, message: { role: "user", content: "Synthetic append remains after the immutable cut." } }) + "\n";
    appendFileSync(sourcePath, appended);
    const append = await call(ingest); assert.equal(append.result.caughtUp, true);
    assert.ok(append.sourceBytes <= Buffer.byteLength(appended) + 65536);
    assert.deepEqual(await timeline(pinned), { count: expected.timelineCount, hash: expected.timelineHash }, "old view remains immutable after append");
    completed = true;
    console.log(JSON.stringify({ passed: true, profile: process.argv.includes("--small") ? "small" : "medium", sourceBytes, sourceRecords: expected.records, timelineEvents: expected.timelineCount, initial, noopSourceBytes: noop.sourceBytes, appendSourceBytes: append.sourceBytes, ...metrics, wallMs: Math.round(performance.now() - started), ioMeaning: "Worker process totals include native SQLite, JS, startup and measurement reads; storage counters exclude cache hits. Independent source verification is excluded." }));
  } finally {
    // Failed/unconfirmed jobs retain their namespace, never lose admission records.
    if (completed) rmSync(root, { recursive: true, force: true });
  }
}
