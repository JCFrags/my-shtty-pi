#!/usr/bin/env node
// @ts-nocheck
// Synthetic-only M11 qualification campaign. This script never discovers sessions,
// reads provider configuration, or uses a production scheduler namespace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  appendFile, chmod, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const SCHEMA_VERSION = 1;
const FULL = Object.freeze({
  sessions: 16,
  sessionCounts: [4, 8, 16],
  slots: [1, 2, 4],
  totalDecodedUnits: 4_000_000_000,
  largestSessionDecodedUnits: 800_000_000,
  bodyUnits: MiB,
  shardDecodedUnits: 64 * MiB,
  compositionGenerations: 128,
  diskLimitBytes: 48 * GiB,
  wallLimitMs: 36 * 60 * 60_000,
});
const SMOKE = Object.freeze({
  sessions: 4,
  sessionCounts: [4],
  slots: [1],
  totalDecodedUnits: 4 * MiB,
  largestSessionDecodedUnits: MiB,
  bodyUnits: 256 * 1024,
  shardDecodedUnits: 512 * 1024,
  compositionGenerations: 4,
  diskLimitBytes: 512 * MiB,
  wallLimitMs: 10 * 60_000,
});
const HELP = `Usage:
  node scripts/m11-scale-campaign.mjs plan --profile full --candidate-sha <40-hex>
  node scripts/m11-scale-campaign.mjs run --profile smoke|full --candidate-sha <40-hex> --campaign-root <absolute-new-directory> --output <absolute-json>
  node scripts/m11-scale-campaign.mjs resume --candidate-sha <40-hex> [--prepared-candidate-sha <40-hex>] --campaign-root <absolute-existing-directory> --output <absolute-json>

Full run safety: launch only after the parent confirms the final integrated candidate and exclusive M11 campaign ownership.`;

function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function integer(value) { return /^\d+$/.test(value ?? "") ? Number(value) : NaN; }
function parseArgs(argv) {
  if (["help", "--help", "-h"].includes(argv[0])) return { mode: "help" };
  const mode = argv[0];
  if (!["plan", "run", "resume"].includes(mode)) throw new Error("m11-mode");
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key.slice(2))) throw new Error("m11-option");
    values[key.slice(2)] = value;
  }
  const allowed = new Set(["profile", "candidate-sha", "prepared-candidate-sha", "campaign-root", "output"]);
  if (Object.keys(values).some(key => !allowed.has(key))) throw new Error("m11-option");
  const profile = values.profile ?? (mode === "resume" ? undefined : "full");
  if (profile !== undefined && !["smoke", "full"].includes(profile)) throw new Error("m11-profile");
  if (!/^[a-f0-9]{40}$/.test(values["candidate-sha"] ?? "")) throw new Error("m11-candidate-sha");
  if (values["prepared-candidate-sha"] !== undefined && (mode !== "resume" || !/^[a-f0-9]{40}$/.test(values["prepared-candidate-sha"]))) throw new Error("m11-prepared-candidate-sha");
  if (mode !== "plan") {
    for (const key of ["campaign-root", "output"]) if (!isAbsolute(values[key] ?? "")) throw new Error(`m11-${key}`);
    if (resolve(values["output"]).startsWith(`${resolve(values["campaign-root"])}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("m11-output-inside-campaign");
  }
  return { mode, profile, candidateSha: values["candidate-sha"], campaignRoot: values["campaign-root"], output: values.output,
    ...(values["prepared-candidate-sha"] ? { preparedCandidateSha: values["prepared-candidate-sha"] } : {}) };
}
function currentSha() { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
function config(profile) { return profile === "smoke" ? SMOKE : FULL; }
function sessionTargets(c) {
  if (c.sessions === 4) return Array(c.sessions).fill(c.largestSessionDecodedUnits);
  const remaining = c.totalDecodedUnits - c.largestSessionDecodedUnits, count = c.sessions - 1;
  const base = Math.floor(remaining / count), extra = remaining % count;
  return [c.largestSessionDecodedUnits, ...Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0))];
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * p)];
}
function maximum(values, initial = -Infinity) {
  for (const value of values) initial = Math.max(initial, value);
  return initial;
}
function distribution(values, includeP99 = true) {
  return { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), ...(includeP99 ? { p99: percentile(values, .99) } : {}), maximum: values.length ? maximum(values) : null };
}
function safeObservation(response) {
  const observation = response?.result?.workerObservation;
  return observation ? { processPeakRssBytes: observation.processPeakRssBytes ?? null, cgroupMemoryPeakBytes: observation.cgroupMemoryPeakBytes ?? null,
    cgroupMemoryLimitBytes: observation.cgroupMemoryLimitBytes ?? null, processIo: observation.processIo ?? null } : null;
}
function processMemory() {
  const result = { processPeakRssBytes: process.resourceUsage().maxRSS * 1024, processRssBytes: process.memoryUsage().rss };
  try {
    const relative = execFileSync("cat", ["/proc/self/cgroup"], { encoding: "utf8" }).split("\n").find(line => line.startsWith("0::/"))?.slice(3);
    if (relative) {
      const read = name => { const text = execFileSync("cat", [join("/sys/fs/cgroup", relative, name)], { encoding: "utf8" }).trim(); return /^\d+$/.test(text) ? Number(text) : null; };
      result.cgroupMemoryCurrentBytes = read("memory.current"); result.cgroupMemoryPeakBytes = read("memory.peak"); result.cgroupMemoryLimitBytes = read("memory.max");
    }
  } catch {}
  return result;
}
async function workstationRss() {
  let rssBytes = 0, processes = 0;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { const match = (await readFile(`/proc/${name}/status`, "utf8")).match(/^VmRSS:\s+(\d+)\s+kB$/m); if (match) { rssBytes += Number(match[1]) * 1024; processes++; } } catch {}
  }
  return { rssBytes, processes, meaning: "Sum of readable process VmRSS values for the whole workstation; includes unrelated processes and double-counted shared pages." };
}
async function hashFile(path) {
  const handle = await open(path, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
  try { for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; } }
  finally { await handle.close(); }
  return hash.digest("hex");
}
async function hashRange(path, offset, length) {
  const handle = await open(path, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(64 * 1024, length)); let position = offset, remaining = length;
  try { while (remaining) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position); assert.ok(bytesRead > 0, "prepared source anchor truncated"); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; remaining -= bytesRead; } }
  finally { await handle.close(); }
  return hash.digest("hex");
}
const PREPARATION_PATHS = Object.freeze([
  ":(top,glob)packages/pi-chrono-compaction/src/catalog-*.ts", ":(top,glob)packages/pi-chrono-compaction/src/capsule-*.ts",
  ":(top,glob)packages/pi-chrono-compaction/src/search-v3-*.ts", ":(top,glob)packages/pi-chrono-compaction/src/worker-runtime*.ts",
  ":(top,literal)packages/pi-chrono-compaction/src/host-worker-scheduler.ts", ":(top,glob)packages/pi-chrono-compaction/dist/src/catalog-*.js",
  ":(top,glob)packages/pi-chrono-compaction/dist/src/capsule-*.js", ":(top,glob)packages/pi-chrono-compaction/dist/src/search-v3-*.js",
  ":(top,glob)packages/pi-chrono-compaction/dist/src/worker-runtime*.js", ":(top,literal)packages/pi-chrono-compaction/dist/src/host-worker-scheduler.js",
]);
const PREPARATION_DIFF_ALLOWLIST = new Set([
  "packages/pi-chrono-compaction/src/search-v3-store.ts", "packages/pi-chrono-compaction/dist/src/search-v3-store.js",
]);
function validatePreparationRevision(preparedCandidateSha, candidateSha) {
  if (preparedCandidateSha === candidateSha) return;
  execFileSync("git", ["merge-base", "--is-ancestor", preparedCandidateSha, candidateSha]);
  const changed = execFileSync("git", ["diff", "--name-only", `${preparedCandidateSha}..${candidateSha}`, "--", ...PREPARATION_PATHS], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  assert.deepEqual(changed.filter(path => !PREPARATION_DIFF_ALLOWLIST.has(path)), [], "prepared-store producer paths changed");
}
async function directoryBytes(root) {
  let total = 0;
  async function walk(path) { for (const name of await readdir(path)) { const child = join(path, name), meta = await lstat(child); if (meta.isDirectory()) await walk(child); else if (meta.isFile()) total += meta.size; } }
  await walk(root); return total;
}
function body(session, event, units) {
  const marker = `m11-marker-session-${session}-event-${event}; deterministic generated scale payload; `;
  const fill = `S${session}E${event}:0123456789abcdefghijklmnopqrstuvwxyz\n`;
  let text = marker;
  while (text.length < units) text += fill.slice(0, Math.min(fill.length, units - text.length));
  return text;
}
function line(id, parentId, text) {
  return `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-09-10T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}
function compactionLine(session, ordinal, parentId) {
  return `${JSON.stringify({ type: "compaction", id: `m11-s${session}-c${ordinal}`, parentId, timestamp: "2026-09-10T00:00:00.000Z",
    summary: `Synthetic generation ${ordinal}; open work remains unresolved.`, tokensBefore: ordinal * 1024 })}\n`;
}
async function writeAll(handle, bytes) { let at = 0; while (at < bytes.length) { const { bytesWritten } = await handle.write(bytes, at, bytes.length - at); at += bytesWritten; } }
async function generateSession(root, session, targetUnits, c) {
  const sessionRoot = join(root, `session-${String(session).padStart(2, "0")}`); await mkdir(sessionRoot, { mode: 0o700 });
  const shards = []; let decodedUnits = 0, sourceBytes = 0, events = 0, compactions = 0, parentId = null, shardOrdinal = 0;
  const generationTarget = Math.floor(c.compositionGenerations / c.sessions) + (session <= c.compositionGenerations % c.sessions ? 1 : 0);
  while (decodedUnits < targetUnits) {
    const path = join(sessionRoot, `shard-${String(shardOrdinal).padStart(4, "0")}.jsonl`), handle = await open(path, "wx", 0o600);
    const shardFirstParent = parentId; let shardUnits = 0, shardBytes = 0, shardEvents = 0, firstEventId, firstPayloadEvent;
    try {
      if (shardOrdinal === 0) {
        const text = `m11-marker-session-${session}-event-1. Never modify exact source. Open work remains pending until qualification completes.`;
        const eventId = `m11-s${session}-e${String(events + 1).padStart(8, "0")}`, bytes = Buffer.from(line(eventId, parentId, text));
        await writeAll(handle, bytes); firstEventId = eventId; parentId = eventId; events++; shardEvents++; decodedUnits += text.length; shardUnits += text.length; sourceBytes += bytes.length; shardBytes += bytes.length;
      }
      while (decodedUnits < targetUnits && shardUnits < c.shardDecodedUnits) {
        const units = Math.min(c.bodyUnits, targetUnits - decodedUnits, c.shardDecodedUnits - shardUnits);
        const eventOrdinal = events + 1, eventId = `m11-s${session}-e${String(eventOrdinal).padStart(8, "0")}`;
        const bytes = Buffer.from(line(eventId, parentId, body(session, eventOrdinal, units))); firstPayloadEvent ??= eventOrdinal;
        await writeAll(handle, bytes); firstEventId ??= eventId; parentId = eventId; events++; shardEvents++; decodedUnits += units; shardUnits += units; sourceBytes += bytes.length; shardBytes += bytes.length;
        const due = Math.floor(events * generationTarget / Math.ceil(targetUnits / c.bodyUnits));
        if (compactions < due) { compactions++; const compact = Buffer.from(compactionLine(session, compactions, parentId)); await writeAll(handle, compact); parentId = `m11-s${session}-c${compactions}`; sourceBytes += compact.length; shardBytes += compact.length; }
      }
    } finally { await handle.close(); }
    shards.push({ ordinal: shardOrdinal, path, sourceBytes: shardBytes, decodedUnits: shardUnits, events: shardEvents, firstParentId: shardFirstParent, firstEventId, firstPayloadEvent, leafId: parentId }); shardOrdinal++;
  }
  return { session, sessionRoot, decodedUnits, estimatedTokens: Math.max(1, Math.ceil(decodedUnits / 4)), sourceBytes, events, compactions, shards, leafId: parentId };
}
async function generate(root, c) {
  const sessions = []; const targets = sessionTargets(c);
  for (let index = 0; index < c.sessions; index++) sessions.push(await generateSession(root, index + 1, targets[index], c));
  const totals = sessions.reduce((out, item) => { for (const key of ["decodedUnits", "estimatedTokens", "sourceBytes", "events", "compactions"]) out[key] += item[key]; out.shards += item.shards.length; return out; }, { decodedUnits: 0, estimatedTokens: 0, sourceBytes: 0, events: 0, compactions: 0, shards: 0 });
  return { sessions, totals };
}
async function runtimeModules(packageRoot) {
  const base = packageRoot ? pathToFileURL(`${join(packageRoot, "dist", "src")}/`) : new URL("../dist/src/", import.meta.url);
  return Promise.all([
    import(new URL("catalog-worker-client.js", base)), import(new URL("capsule-worker-client.js", base)), import(new URL("search-v3-worker-client.js", base)),
    import(new URL("capsule-contract.js", base)), import(new URL("context-composer.js", base)), import(new URL("host-worker-scheduler.js", base)),
    import(new URL("episode-state-contract.js", base)),
  ]).then(([catalog, capsule, search, contract, composer, scheduler, stateContract]) => ({ catalog, capsule, search, contract, composer, scheduler, stateContract }));
}
function metrics() { return { calls: 0, failures: {}, latencies: { ingestion: [], appendIngestionLag: [], search: [], recall: [], exact: [], composition: [], fault: [], recovery: [], request: [] }, sourceBytes: {}, workerPeaks: [], processIoByOperation: {} }; }
function stateMaterializationGuard(session, limits) {
  const progressUnits = limits.wholeBodyUtf16Units - limits.largeBodyOverlapUnits;
  assert.ok(progressUnits > 0, "state materialization progress must be positive");
  const records = session.events + session.compactions;
  // Every large-body step advances by at least progressUnits after its first
  // chunk. Per-record and metadata terms cover ceiling loss and final pages.
  return Math.ceil(session.decodedUnits / progressUnits) + records * 2 + Math.ceil(records / limits.materializeCapsules) + 128;
}
function observe(m, kind, started, response) {
  const elapsed = performance.now() - started; m.calls++; m.latencies.request.push(elapsed); (m.latencies[kind] ??= []).push(elapsed);
  const code = response?.ok === false ? response.code : response?.response?.status === "failed" ? response.response.failureCode : null;
  if (code) m.failures[code] = (m.failures[code] ?? 0) + 1;
  const source = Number(response?.sourceBytes ?? 0); (m.sourceBytes[kind] ??= []).push(source);
  const observation = safeObservation(response); if (observation) {
    m.workerPeaks.push(observation); const io = (m.processIoByOperation[kind] ??= { readChars: [], writtenChars: [], storageReadBytes: [], storageWrittenBytes: [] });
    for (const key of Object.keys(io)) io[key].push(Number(observation.processIo?.[key] ?? 0));
  }
  return elapsed;
}
async function pool(items, concurrency, worker, settleOnFailure = false) {
  let next = 0; const results = Array(items.length);
  const jobs = Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; results[index] = await worker(items[index], index); } });
  if (settleOnFailure) { const settled = await Promise.allSettled(jobs), failed = settled.find(item => item.status === "rejected"); if (failed) throw failed.reason; }
  else await Promise.all(jobs);
  return results;
}
async function prepareStores(root, generated, modules, m) {
  const slots = 4, schedulerDirectory = join(root, "scheduler-prepare"); await mkdir(schedulerDirectory, { mode: 0o700 });
  const states = await pool(generated.sessions, generated.sessions.length, async session => {
    const stateRoot = join(root, "prepared", `session-${String(session.session).padStart(2, "0")}`);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const catalogDirectory = join(stateRoot, "catalog"), derivedDirectory = join(stateRoot, "derived"), searchDirectory = join(stateRoot, "search");
    const sessionKey = sha(`m11-session-${session.session}`).slice(0, 64), catalogBase = { v: 1, catalogDirectory, sessionKey };
    const catalogCall = async request => { const started = performance.now(); const response = await modules.catalog.runCatalogWorker({ ...catalogBase, ...request }, { schedulerDirectory, slots }); observe(m, "ingestion", started, response); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
    for (const shard of session.shards) {
      const request = { op: "ingestStep", sourcePath: shard.path, shardKey: `shard-${shard.ordinal}`, branchKey: "main", shardOrdinal: shard.ordinal,
        ...(shard.ordinal ? { parent: { shardKey: `shard-${shard.ordinal - 1}`, eventId: shard.firstParentId } } : {}) };
      let caughtUp = false;
      for (let guard = 0; guard < Math.ceil(shard.sourceBytes / (7 * MiB)) + shard.events + 32; guard++) if ((await catalogCall(request)).caughtUp) { caughtUp = true; break; }
      assert.equal(caughtUp, true, `catalog did not catch up shard ${shard.ordinal}`);
    }
    const view = (await catalogCall({ op: "pin", branchKey: "main", leaf: { shardKey: `shard-${session.shards.length - 1}`, eventId: session.leafId } })).view;
    const identity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: view.storeKey, catalogGeneration: view.generation,
      derivedSchemaVersion: modules.contract.DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: modules.contract.CAPSULE_SCHEMA_VERSION,
      chunkSchemaVersion: modules.contract.CHUNK_SCHEMA_VERSION, reducerSetVersion: modules.contract.CAPSULE_REDUCER_PIPELINE_VERSION, configHash: sha("m11-capsules-v1") };
    const capsuleCall = async request => { const started = performance.now(); const response = await modules.capsule.runCapsuleWorker({ v: 1, catalogDirectory, derivedDirectory, identity, ...request }, { schedulerDirectory, slots }); observe(m, "ingestion", started, response); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
    let cursor, capsulesComplete = false; for (let guard = 0; guard < Math.ceil(session.decodedUnits / 32768) * 2 + session.events * 4 + 128; guard++) { const result = await capsuleCall({ op: "derivePage", view, ...(cursor ? { cursor } : {}) }); cursor = result.cursor; if (result.complete) { capsulesComplete = true; break; } }
    assert.equal(capsulesComplete, true, "capsule derivation did not complete");
    const searchIdentity = { storeKey: randomUUID(), capsule: identity, schemaVersion: 1, configHash: sha("m11-search-v1") };
    const searchCall = async (kind, request) => { const started = performance.now(); const response = await modules.search.runSearchV3Worker({ v: 1, searchDirectory, capsuleDirectory: derivedDirectory, catalogDirectory, identity: searchIdentity, ...request }, { schedulerDirectory, slots }); observe(m, kind, started, response); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
    let searchComplete = false;
    for (let guard = 0; guard < Math.ceil(session.decodedUnits / 32768) * 2 + 128; guard++) if ((await searchCall("ingestion", { op: "ingestPage", view, maxSources: 4, maxChunks: 8 })).complete) { searchComplete = true; break; }
    assert.equal(searchComplete, true, "search ingestion did not complete");
    let verifiedShards = 0;
    for (const shard of session.shards) {
      const found = await searchCall("search", { op: "query", view, query: `m11-marker-session-${session.session}-event-${shard.firstPayloadEvent}`, mode: "literal", limit: 1 });
      assert.ok(found.hits?.length === 1, `shard ${shard.ordinal} marker must be searchable`);
      const recalled = await searchCall("recall", { op: "recall", view, handle: found.hits[0].handle });
      assert.match(recalled.text, new RegExp(`m11-marker-session-${session.session}-event-${shard.firstPayloadEvent}`)); verifiedShards++;
    }
    let stateComplete = false;
    for (let guard = 0; guard < stateMaterializationGuard(session, modules.stateContract.EPISODE_STATE_LIMITS); guard++) if ((await searchCall("ingestion", { op: "materializeState", view, limit: 8 })).complete) { stateComplete = true; break; }
    assert.equal(stateComplete, true, "state materialization did not complete");
    const selection = await searchCall("composition", { op: "composeStateSelection", view });
    return { session, view, identity, searchIdentity, selection, sessionKey, verifiedShards, directories: { catalogDirectory, derivedDirectory, searchDirectory } };
  });
  const residue = await modules.scheduler.schedulerArtifactCounts(schedulerDirectory); assert.deepEqual(residue, { tickets: 0, slots: 0 });
  return states;
}
async function recoverPreparedStores(root, generated, modules, m) {
  const { default: Database } = await import("better-sqlite3");
  const schedulerDirectory = join(root, "scheduler-prepare"); await mkdir(schedulerDirectory, { recursive: true, mode: 0o700 });
  const states = await pool(generated.sessions, generated.sessions.length, async session => {
    const stateRoot = join(root, "prepared", `session-${String(session.session).padStart(2, "0")}`);
    const catalogDirectory = join(stateRoot, "catalog"), derivedDirectory = join(stateRoot, "derived"), searchDirectory = join(stateRoot, "search");
    const active = JSON.parse(await readFile(join(catalogDirectory, "active.json"), "utf8"));
    const storeRoots = await readdir(join(catalogDirectory, "stores")); assert.equal(storeRoots.length, 1, "prepared catalog store count");
    const storeFiles = (await readdir(join(catalogDirectory, "stores", storeRoots[0]))).filter(name => name.endsWith(".sqlite"));
    assert.equal(storeFiles.length, 1, "prepared catalog database count");
    const catalog = new Database(join(catalogDirectory, "stores", storeRoots[0], storeFiles[0]), { readonly: true, fileMustExist: true });
    let catalogMeta, catalogShards, catalogEvents, lastId;
    try {
      catalogMeta = catalog.prepare("SELECT version,session,store FROM meta WHERE singleton=1").get();
      catalogShards = catalog.prepare("SELECT shard,branch,ordinal,path,snapshot,observed,committed,caught FROM shards WHERE g=1 ORDER BY ordinal").all();
      catalogEvents = catalog.prepare("SELECT count(*) AS count FROM events WHERE g=1").get().count;
      lastId = catalog.prepare("SELECT id FROM events WHERE g=1 ORDER BY seq DESC LIMIT 1").pluck().get();
    } finally { catalog.close(); }
    const sessionKey = sha(`m11-session-${session.session}`).slice(0, 64), expectedRecords = session.events + session.compactions;
    assert.deepEqual(catalogMeta, { version: 1, session: sessionKey, store: active.storeKey });
    assert.equal(active.v, 1); assert.equal(active.sessionKey, sessionKey); assert.equal(catalogEvents, expectedRecords); assert.equal(JSON.parse(lastId), session.leafId);
    assert.equal(catalogShards.length, session.shards.length);
    for (const [index, row] of catalogShards.entries()) {
      const shard = session.shards[index], snapshot = JSON.parse(row.snapshot), source = await stat(shard.path);
      assert.equal(row.shard, `shard-${shard.ordinal}`); assert.equal(row.branch, "main"); assert.equal(row.ordinal, shard.ordinal); assert.equal(row.path, shard.path);
      assert.equal(row.observed, shard.sourceBytes); assert.equal(row.committed, shard.sourceBytes); assert.equal(row.caught, 1);
      assert.equal(source.size, shard.sourceBytes); assert.equal(String(source.dev), snapshot.identity.device); assert.equal(String(source.ino), snapshot.identity.inode); assert.equal(snapshot.size, shard.sourceBytes);
      for (const anchor of snapshot.anchors) assert.equal(await hashRange(shard.path, anchor.offset, anchor.length), anchor.sha256, "prepared source anchor changed");
    }
    const derived = new Database(join(derivedDirectory, "derived.sqlite"), { readonly: true, fileMustExist: true });
    let derivedMeta, derivedHead, derivedReadiness;
    try {
      derivedMeta = derived.prepare("SELECT version,identity,derivedRoute,catalogRoute FROM meta WHERE singleton=1").get();
      derivedHead = derived.prepare("SELECT view,cursor FROM heads").get(); derivedReadiness = derived.prepare("SELECT * FROM readiness").get();
    } finally { derived.close(); }
    const identity = JSON.parse(derivedMeta.identity), view = JSON.parse(derivedHead.view), derivedCursor = JSON.parse(derivedHead.cursor);
    assert.equal(derivedMeta.version, modules.contract.DERIVED_SCHEMA_VERSION); assert.equal(derivedMeta.derivedRoute, derivedDirectory); assert.equal(derivedMeta.catalogRoute, catalogDirectory);
    assert.equal(identity.sessionKey, sessionKey); assert.equal(identity.catalogStoreKey, active.storeKey); assert.equal(identity.catalogGeneration, view.generation);
    assert.deepEqual(derivedCursor.identity, identity); assert.deepEqual(derivedCursor.view, view); assert.equal(view.eventCut, expectedRecords); assert.equal(view.branchKey, "main");
    assert.equal(derivedReadiness.capsuleEligible, session.events * 2 + session.compactions); assert.equal(derivedReadiness.capsuleReady, expectedRecords);
    assert.equal(derivedReadiness.capsuleUnsupported, session.events); assert.equal(derivedReadiness.capsuleFailed, 0);
    assert.equal(derivedReadiness.chunkEligible, expectedRecords); assert.equal(derivedReadiness.chunkReady, expectedRecords); assert.equal(derivedReadiness.chunkFailed, 0); assert.equal(derivedReadiness.chunkExcluded, session.events);
    const search = new Database(join(searchDirectory, "search.sqlite"), { readonly: true, fileMustExist: true });
    let searchMeta, searchHead, searchCounts;
    try {
      searchMeta = search.prepare("SELECT version,identity,searchRoute,capsuleRoute,catalogRoute,generation FROM meta WHERE singleton=1").get();
      searchHead = search.prepare("SELECT view,afterEventSeq,afterDescriptor,active,generation,cueReady,rawReady,excluded,complete FROM heads").get();
      searchCounts = search.prepare("SELECT (SELECT count(*) FROM documents) documents,(SELECT count(*) FROM chunks) chunks,(SELECT count(*) FROM membership) membership").get();
    } finally { search.close(); }
    const searchIdentity = JSON.parse(searchMeta.identity);
    assert.equal(searchMeta.version, 1); assert.equal(searchMeta.searchRoute, searchDirectory); assert.equal(searchMeta.capsuleRoute, derivedDirectory); assert.equal(searchMeta.catalogRoute, catalogDirectory);
    assert.deepEqual(searchIdentity.capsule, identity); assert.deepEqual(JSON.parse(searchHead.view), view); assert.equal(searchHead.complete, 1); assert.equal(searchHead.active, null);
    assert.equal(searchHead.afterEventSeq, expectedRecords); assert.equal(searchHead.afterDescriptor, 0); assert.equal(searchHead.generation, expectedRecords); assert.equal(searchMeta.generation, expectedRecords);
    assert.equal(searchHead.cueReady, expectedRecords); assert.equal(searchHead.rawReady, session.events); assert.equal(searchHead.excluded, session.compactions);
    assert.equal(searchCounts.documents, expectedRecords); assert.equal(searchCounts.membership, expectedRecords); assert.ok(searchCounts.chunks >= session.events);
    const catalogStatus = await modules.catalog.runCatalogWorker({ v: 1, catalogDirectory, sessionKey, op: "status" }, { schedulerDirectory, slots: 4 });
    assert.equal(catalogStatus.ok, true, JSON.stringify(catalogStatus));
    const pinned = await modules.catalog.runCatalogWorker({ v: 1, catalogDirectory, sessionKey, op: "pin", branchKey: "main",
      leaf: { shardKey: `shard-${session.shards.length - 1}`, eventId: session.leafId } }, { schedulerDirectory, slots: 4 });
    assert.equal(pinned.ok, true, JSON.stringify(pinned)); if (pinned.ok) assert.deepEqual(pinned.result.view, view);
    const capsuleStatus = await modules.capsule.runCapsuleWorker({ v: 1, catalogDirectory, derivedDirectory, identity, op: "status", view }, { schedulerDirectory, slots: 4 });
    assert.equal(capsuleStatus.ok, true, JSON.stringify(capsuleStatus));
    const searchCall = async (kind, request) => { const started = performance.now(); const response = await modules.search.runSearchV3Worker({ v: 1, searchDirectory, capsuleDirectory: derivedDirectory, catalogDirectory, identity: searchIdentity, ...request }, { schedulerDirectory, slots: 4 }); observe(m, kind, started, response); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; };
    const searchStatus = await searchCall("ingestion", { op: "status", view }); assert.equal(searchStatus.readiness.raw, "ready");
    let verifiedShards = 0;
    for (const shard of session.shards) {
      const marker = `m11-marker-session-${session.session}-event-${shard.firstPayloadEvent}`;
      const found = await searchCall("search", { op: "query", view, query: marker, mode: "literal", limit: 1 });
      assert.equal(found.hits?.length, 1, `shard ${shard.ordinal} marker must be searchable`);
      const recalled = await searchCall("recall", { op: "recall", view, handle: found.hits[0].handle }); assert.match(recalled.text, new RegExp(marker)); verifiedShards++;
    }
    let stateComplete = false;
    for (let guard = 0; guard < stateMaterializationGuard(session, modules.stateContract.EPISODE_STATE_LIMITS); guard++) if ((await searchCall("ingestion", { op: "materializeState", view, limit: 8 })).complete) { stateComplete = true; break; }
    assert.equal(stateComplete, true, "state materialization did not complete");
    const selection = await searchCall("composition", { op: "composeStateSelection", view });
    return { session, view, identity, searchIdentity, selection, sessionKey, verifiedShards, directories: { catalogDirectory, derivedDirectory, searchDirectory } };
  });
  const residue = await modules.scheduler.schedulerArtifactCounts(schedulerDirectory); assert.deepEqual(residue, { tickets: 0, slots: 0 });
  return states;
}
async function measureQueue(schedulerDirectory, slots, modules, settleOnFailure = false) {
  const waits = [];
  await pool(Array.from({ length: slots + 2 }, (_, index) => index), slots + 2, async index => {
    const lease = await modules.scheduler.acquireHostWorkerSlot({ slots, directory: schedulerDirectory, priority: index % 2 ? "low" : "high", jobType: "rollup-shadow", sessionKey: sha(`m11-queue-${index}`) });
    waits.push({ queueWaitMs: lease.queueWaitMs, queuePosition: lease.queuePosition });
    await new Promise(resolve => setTimeout(resolve, 40)); await lease.release();
  }, settleOnFailure);
  return { waitMs: distribution(waits.map(item => item.queueWaitMs)), maximumPosition: Math.max(...waits.map(item => item.queuePosition)) };
}
async function exerciseLane(root, states, sessionCount, slots, modules, m, recovery = {}) {
  const schedulerDirectory = join(root, `scheduler-lane-${sessionCount}-${slots}`); await mkdir(schedulerDirectory, { recursive: true, mode: 0o700 });
  const selected = states.slice(0, sessionCount), queue = await measureQueue(schedulerDirectory, slots, modules, recovery.settleOnFailure === true);
  await pool(selected, selected.length, async state => {
    const searchRequest = extra => modules.search.runSearchV3Worker({ v: 1, searchDirectory: state.directories.searchDirectory, capsuleDirectory: state.directories.derivedDirectory, catalogDirectory: state.directories.catalogDirectory, identity: state.searchIdentity, view: state.view, ...extra }, { schedulerDirectory, slots });
    const queryStarted = performance.now(), queryPromise = searchRequest({ op: "query", query: `m11-marker-session-${state.session.session}-event-2`, mode: "literal", limit: 2 });
    const shard = state.session.shards.at(-1), currentSourceBytes = (await stat(shard.path)).size;
    const appendedId = `m11-s${state.session.session}-append-${sessionCount}-${slots}-${currentSourceBytes}`, appendStarted = performance.now();
    await appendFile(shard.path, line(appendedId, state.session.leafId, `m11 append session ${state.session.session}, lane ${sessionCount}x${slots}`));
    const ingestStarted = performance.now(), ingestPromise = modules.catalog.runCatalogWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory, sessionKey: state.sessionKey, op: "ingestStep", sourcePath: shard.path, shardKey: `shard-${shard.ordinal}`, branchKey: "main", shardOrdinal: shard.ordinal, ...(shard.ordinal ? { parent: { shardKey: `shard-${shard.ordinal - 1}`, eventId: shard.firstParentId } } : {}) }, { schedulerDirectory, slots });
    const [foundResponse, ingest] = await Promise.all([queryPromise, ingestPromise]);
    observe(m, "search", queryStarted, foundResponse); observe(m, "ingestion", ingestStarted, ingest); assert.equal(foundResponse.ok, true, JSON.stringify(foundResponse)); assert.equal(ingest.ok, true, JSON.stringify(ingest));
    m.latencies.appendIngestionLag.push(performance.now() - appendStarted);
    const found = foundResponse.result; assert.ok(found.hits?.length > 0, "search must find generated source");
    const recallStarted = performance.now(), recalled = await searchRequest({ op: "recall", handle: found.hits[0].handle }); observe(m, "recall", recallStarted, recalled); assert.equal(recalled.ok, true, JSON.stringify(recalled)); assert.match(recalled.result.text, new RegExp(`m11-marker-session-${state.session.session}`));
    const chunkStarted = performance.now(), chunk = await modules.capsule.runCapsuleWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory, derivedDirectory: state.directories.derivedDirectory, identity: state.identity, op: "chunkRange", view: state.view, source: found.hits[0].handle.source, decodedStart: 0, decodedLength: 32768, limit: 2 }, { schedulerDirectory, slots }); observe(m, "exact", chunkStarted, chunk); assert.equal(chunk.ok, true, JSON.stringify(chunk));
    const pageStarted = performance.now(), old = await modules.catalog.runCatalogWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory, sessionKey: state.sessionKey, op: "page", view: state.view, after: Math.max(0, state.view.eventCut - 1), limit: 2 }, { schedulerDirectory, slots }); observe(m, "exact", pageStarted, old); assert.equal(old.ok, true, JSON.stringify(old)); assert.equal(old.result.events.at(-1).metadata.id, state.session.leafId, "pinned view excludes concurrent append");
    const rawEvent = old.result.events.at(-1), exactStarted = performance.now(), exact = await modules.catalog.runCatalogWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory, sessionKey: state.sessionKey, op: "raw", view: state.view, eventSeq: rawEvent.seq, offset: rawEvent.rawStart, length: Math.min(8192, rawEvent.endByte - rawEvent.rawStart) }, { schedulerDirectory, slots }); observe(m, "exact", exactStarted, exact); assert.equal(exact.ok, true, JSON.stringify(exact));
  }, recovery.settleOnFailure === true);
  const residue = await modules.scheduler.schedulerArtifactCounts(schedulerDirectory); assert.deepEqual(residue, { tickets: 0, slots: 0 });
  return { slots, sessions: sessionCount, queue, schedulerResidue: residue };
}
async function faultCampaign(root, state, modules, m, recovery = {}) {
  const schedulerDirectory = join(root, "scheduler-faults"); await mkdir(schedulerDirectory, { recursive: true, mode: 0o700 });
  const sourceHash = recovery.sourceHash ?? hashFile;
  const sourceBefore = await Promise.all(state.session.shards.map(shard => sourceHash(shard.path)));
  const staleStarted = performance.now(), stale = await modules.search.runSearchV3Worker({ v: 1, searchDirectory: state.directories.searchDirectory, capsuleDirectory: state.directories.derivedDirectory, catalogDirectory: state.directories.catalogDirectory, identity: { ...state.searchIdentity, configHash: sha("m11-stale-search-generation") }, op: "status", view: state.view }, { schedulerDirectory, slots: 1 }); observe(m, "search", staleStarted, stale); assert.equal(stale.ok, false, "stale schema must refuse");
  const Database = recovery.Database ?? (await import("better-sqlite3")).default;
  const database = new Database(join(state.directories.derivedDirectory, "derived.sqlite"), { readonly: true, fileMustExist: true });
  let name; try { name = database.prepare("SELECT segmentHash FROM artifacts WHERE layer='capsules' ORDER BY eventSeq,descriptor LIMIT 1").pluck().get(); } finally { database.close(); }
  assert.match(name ?? "", /^[a-f0-9]{64}$/, "capsule segment required for corruption fault");
  const path = join(state.directories.derivedDirectory, "segments", "capsules", name), original = await readFile(path), corrupted = Buffer.from(original);
  await recovery.beforeCorruption?.(path, original, name);
  corrupted[Math.floor(corrupted.length / 2)] ^= 1;
  const request = { v: 1, catalogDirectory: state.directories.catalogDirectory, derivedDirectory: state.directories.derivedDirectory, identity: state.identity, op: "capsulePage", view: state.view, limit: 1 };
  const corruptStarted = performance.now(); let refused;
  try { await writeFile(path, corrupted, { mode: 0o600 }); refused = await modules.capsule.runCapsuleWorker(request, { schedulerDirectory, slots: 1 }); observe(m, "fault", corruptStarted, refused); }
  finally { await writeFile(path, original, { mode: 0o600 }); }
  assert.equal(refused.ok, false, "corrupt segment must refuse");
  const repairStarted = performance.now(), recovered = await modules.capsule.runCapsuleWorker(request, { schedulerDirectory, slots: 1 }); observe(m, "recovery", repairStarted, recovered); assert.equal(recovered.ok, true, JSON.stringify(recovered));
  const sourceAfter = await Promise.all(state.session.shards.map(shard => sourceHash(shard.path))); assert.deepEqual(sourceAfter, sourceBefore, "fault and repair must not change source");
  return { staleSchemaCode: stale.code, corruptSegmentCode: refused.code, repairRecoveryMs: performance.now() - repairStarted, sourceUnchanged: true };
}
async function runCampaign(args) {
  assert.equal(currentSha(), args.candidateSha, "candidate SHA must equal checkout HEAD");
  const startedAt = Date.now(), started = performance.now();
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let rootCreated = false, report, preparedCandidateSha = args.preparedCandidateSha ?? args.candidateSha;
  try {
    if (args.mode === "run") { await mkdir(args.campaignRoot, { mode: 0o700 }); rootCreated = true; }
    const meta = await lstat(args.campaignRoot); assert.ok(meta.isDirectory() && !meta.isSymbolicLink() && (meta.mode & 0o077) === 0, "campaign root must be owner-only");
    const manifestPath = join(args.campaignRoot, "campaign-manifest.json");
    let profile, generated;
    if (args.mode === "resume") {
      const saved = JSON.parse(await readFile(manifestPath, "utf8")); assert.equal(saved.schemaVersion, SCHEMA_VERSION); assert.equal(saved.candidateSha, preparedCandidateSha); profile = saved.profile; generated = saved.generated;
      validatePreparationRevision(preparedCandidateSha, args.candidateSha);
      for (const session of generated.sessions) for (const shard of session.shards) assert.ok((await stat(shard.path)).size >= shard.sourceBytes, "resume source was truncated");
    } else {
      profile = args.profile; const c = config(profile); generated = await generate(args.campaignRoot, c);
      await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, candidateSha: args.candidateSha, profile, generated })}\n`, { mode: 0o600 });
    }
    const c = config(profile); assert.ok(generated.totals.sourceBytes <= c.diskLimitBytes); const modules = await runtimeModules(); const m = metrics();
    const baseline = processMemory(), workstationBaseline = await workstationRss(), statePath = join(args.campaignRoot, "prepared-state.json");
    const savedState = args.mode === "resume" ? await readFile(statePath, "utf8").then(JSON.parse).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error)) : undefined;
    if (savedState) { assert.equal(savedState.schemaVersion, 1); assert.equal(savedState.candidateSha, args.candidateSha); }
    const reusedPreparedStores = args.mode === "resume";
    const states = savedState ? savedState.states : reusedPreparedStores ? await recoverPreparedStores(args.campaignRoot, generated, modules, m) : await prepareStores(args.campaignRoot, generated, modules, m);
    if (!savedState) await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, candidateSha: args.candidateSha, preparedCandidateSha, reusedPreparedStores, states })}\n`, { mode: 0o600 });
    const lanes = [], faults = await faultCampaign(args.campaignRoot, states[0], modules, m);
    for (const count of c.sessionCounts) for (const slots of c.slots) lanes.push(await exerciseLane(args.campaignRoot, states, count, slots, modules, m));
    const compositionHashes = [], coverage = [], compositionStart = performance.now();
    for (let ordinal = 1; ordinal <= c.compositionGenerations; ordinal++) {
      const state = states[(ordinal - 1) % states.length], one = performance.now();
      const input = { regularPiSummary: `Deterministic Pi summary for session ${state.session.session}, generation ${ordinal}.`, combinedCeilingTokens: 30_000,
        cut: { sourceCutEntryId: state.session.leafId, sourceCutSeq: state.view.eventCut, firstKeptEntryId: `m11-tail-${state.session.session}-${ordinal}`, firstKeptSeq: state.view.eventCut + 1, rawTailTokens: 64, toolPairSafe: true } };
      const recovery = source => `opaque:m11:${state.session.session}:${source.eventSeq}:${source.descriptor}`;
      const first = modules.composer.composeStoredSelection(input, state.selection, recovery), second = modules.composer.composeStoredSelection(input, state.selection, recovery);
      m.latencies.composition.push(performance.now() - one); assert.equal(first.envelope.payloadHash, second.envelope.payloadHash); compositionHashes.push(first.envelope.payloadHash);
      coverage.push(first.envelope.validation);
    }
    const diskBytes = await directoryBytes(args.campaignRoot); assert.ok(diskBytes <= c.diskLimitBytes, "campaign disk ceiling");
    const largest = Math.max(...generated.sessions.map(item => item.estimatedTokens));
    if (profile === "full") { assert.ok(largest >= 200_000_000); assert.ok(generated.totals.estimatedTokens >= 1_000_000_000); assert.ok(generated.totals.compactions >= 100); assert.ok(Math.max(...generated.sessions.map(item => item.shards.length)) >= 10); }
    delay.disable();
    report = { schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-scale-campaign", status: "completed", qualificationStatus: "partial-core-evidence", profile, candidateSha: args.candidateSha,
      generated: { totals: generated.totals, sessions: generated.sessions.map(item => ({ session: item.session, decodedUnits: item.decodedUnits, estimatedTokens: item.estimatedTokens,
        sourceBytes: item.sourceBytes, events: item.events, physicalShards: item.shards.length, compositionRecords: item.compactions })) }, lanes,
      measurements: { mainProcess: { baseline, final: processMemory() }, worker: { peakRssBytes: maximum(m.workerPeaks.map(item => item.processPeakRssBytes ?? 0), 0), peakCgroupBytes: maximum(m.workerPeaks.map(item => item.cgroupMemoryPeakBytes ?? 0), 0) },
        workstationProcessRss: { baseline: workstationBaseline, final: await workstationRss() },
        eventLoopDelayMs: { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, p99: delay.percentile(99) / 1e6, maximum: delay.max / 1e6 },
        appendIngestionLagMs: distribution(m.latencies.appendIngestionLag), searchMs: distribution(m.latencies.search), recallMs: distribution(m.latencies.recall, false), exactMs: distribution(m.latencies.exact),
        compositionMs: { ...distribution(m.latencies.composition), total: performance.now() - compositionStart, excludesPiModelSummary: true },
        sourceBytesReadPerOperation: Object.fromEntries(Object.entries(m.sourceBytes).map(([key, values]) => [key, distribution(values)])),
        processReaderCountersByOperation: Object.fromEntries(Object.entries(m.processIoByOperation).map(([kind, counters]) => [kind, Object.fromEntries(Object.entries(counters).map(([key, values]) => [key, distribution(values)]))])),
        segmentBytesRead: "unavailable separately: public worker observations expose whole-process read characters/storage bytes, reported above, but not per-segment reads",
        queueWaitByLane: lanes.map(lane => ({ sessions: lane.sessions, slots: lane.slots, ...lane.queue })),
        requestWallMs: distribution(m.latencies.request), failures: m.failures, recoveryTime: { corruptSegmentMs: faults.repairRecoveryMs, processRestart: "requires separate resume invocation", systemRestart: "requires operator reboot evidence" },
        exactReferenceValidation: { sampledSessions: generated.sessions.length, passed: true, perShardCatalogSearchRecall: states.reduce((sum, state) => sum + state.verifiedShards, 0), allPhysicalShardsVerified: states.every(state => state.verifiedShards === state.session.shards.length) }, contextCoverage: { source: "actual materializeState -> composeStateSelection -> composeStoredSelection", deterministicGenerations: compositionHashes.length,
          protectedComplete: coverage.filter(item => item.protectedCoverageComplete).length, openWorkComplete: coverage.filter(item => item.openWorkCoverageComplete).length, safeTail: coverage.filter(item => item.safeTail).length,
          withinCombinedCeiling: coverage.filter(item => item.withinCombinedCeiling).length }, faults },
      preparation: { candidateSha: preparedCandidateSha, finalCandidateSha: args.candidateSha, reusedPreparedStores,
        initialPreparationMetrics: reusedPreparedStores ? "unavailable: the retained failed process did not persist successful preparation measurements" : "included in this report" },
      diskBytes, wallMs: performance.now() - started, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      faultCoverage: { sourceAppendDuringPinnedSnapshot: "passed", staleSchemaGeneration: faults.staleSchemaCode, workerCrashAndTransactionKill: "reuse revision-bound unchanged M04 worker/runtime paths", corruptedDerivedSegment: faults.corruptSegmentCode,
        corruptedSegmentRepair: "passed", sourceUnchangedAfterFaults: faults.sourceUnchanged, processRestart: args.mode === "resume" ? "process resumed" : "pending resume invocation", systemRestart: "requires operator reboot between run and resume; not inferred" },
      remainingQualificationGates: ["actual Pi-process baseline and overhead", "actual Pi rollover/switch/rollback", "operator system restart", "model continuation quality is excluded because providers are forbidden"],
      limitations: ["Completed means the bounded synthetic core campaign finished. It is not an M11 pass or full product qualification.", "Generated estimated tokens equal ceil(actual decoded UTF-16 units / 4), the runtime estimator. Source bytes and event counts are measured from real writes.",
        "Composition uses actual deterministic state production and stored selection. It is core composer evidence, not a Pi hook, provider summary, continuation-quality result, or authoritative activation.",
        "Whole-workstation RSS is a sampled sum of readable VmRSS fields and includes unrelated processes and shared-page double counting. Segment-only reads and system restart remain unavailable without narrower runtime counters or an operator reboot.",
        ...(reusedPreparedStores ? ["Catalog, capsule, and search stores were validated and reused from the recorded preparation candidate. Initial preparation latency, request, I/O, and worker-peak measurements were not persisted by the failed process and remain unavailable; resumed measurements do not replace them."] : [])] };
  } catch (error) {
    delay.disable(); report = { schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-scale-campaign", status: "failed", candidateSha: args.candidateSha, preparedCandidateSha,
      failureCode: /^[A-Za-z0-9_-]{1,80}$/.test(error?.code ?? "") ? error.code : "m11-campaign-failed", failureMessage: String(error?.message ?? "failure").replaceAll(args.campaignRoot ?? "", "<campaign-root>"),
      retainedCampaignRoot: rootCreated || args.mode === "resume", wallMs: performance.now() - started };
  }
  await writeReport(args.output, report);
}
async function writeReport(output, report) {
  await mkdir(resolve(output, ".."), { recursive: true, mode: 0o700 }); await writeFile(output, `${JSON.stringify(report)}\n`, { mode: 0o600 }); await chmod(output, 0o600);
  console.log(JSON.stringify({ status: report.status, profile: report.profile, output: basename(output), wallMs: report.wallMs }));
  process.exitCode = report.status === "completed" ? 0 : 1;
}
export { FULL, SMOKE, config, distribution, exerciseLane, faultCampaign, maximum, metrics, parseArgs, runtimeModules, sessionTargets, writeReport };
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv); if (args.mode === "help") return console.log(HELP);
  assert.equal(currentSha(), args.candidateSha, "candidate SHA must equal checkout HEAD");
  if (args.mode === "plan") { const c = config(args.profile); console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-plan", profile: args.profile, candidateSha: args.candidateSha,
    sessions: c.sessions, sessionMatrix: c.sessionCounts, workerSlotMatrix: c.slots, concurrencyMatrix: c.sessionCounts.flatMap(sessions => c.slots.map(slots => ({ sessions, slots }))), actualDecodedUnits: c.totalDecodedUnits, minimumEstimatedTokens: Math.ceil(c.totalDecodedUnits / 4),
    largestSessionEstimatedTokens: Math.ceil(c.largestSessionDecodedUnits / 4), compositionGenerations: c.compositionGenerations, diskLimitBytes: c.diskLimitBytes, wallLimitMs: c.wallLimitMs,
    requiresExclusiveParentConfirmation: args.profile === "full" })); return; }
  await runCampaign(args);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
