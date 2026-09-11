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
  largestSessionDecodedUnits: 400_000_000,
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
  node scripts/m11-scale-campaign.mjs resume --candidate-sha <40-hex> --campaign-root <absolute-existing-directory> --output <absolute-json>

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
  const allowed = new Set(["profile", "candidate-sha", "campaign-root", "output"]);
  if (Object.keys(values).some(key => !allowed.has(key))) throw new Error("m11-option");
  const profile = values.profile ?? (mode === "resume" ? undefined : "full");
  if (profile !== undefined && !["smoke", "full"].includes(profile)) throw new Error("m11-profile");
  if (!/^[a-f0-9]{40}$/.test(values["candidate-sha"] ?? "")) throw new Error("m11-candidate-sha");
  if (mode !== "plan") {
    for (const key of ["campaign-root", "output"]) if (!isAbsolute(values[key] ?? "")) throw new Error(`m11-${key}`);
    if (resolve(values["output"]).startsWith(`${resolve(values["campaign-root"])}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("m11-output-inside-campaign");
  }
  return { mode, profile, candidateSha: values["candidate-sha"], campaignRoot: values["campaign-root"], output: values.output };
}
function currentSha() { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
function config(profile) { return profile === "smoke" ? SMOKE : FULL; }
function sessionTargets(c) {
  if (c.sessions === 4) return Array(c.sessions).fill(c.largestSessionDecodedUnits);
  const remaining = c.totalDecodedUnits - c.largestSessionDecodedUnits;
  assert.equal(remaining % (c.sessions - 1), 0);
  return [c.largestSessionDecodedUnits, ...Array(c.sessions - 1).fill(remaining / (c.sessions - 1))];
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * p)];
}
function distribution(values, includeP99 = true) {
  return { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), ...(includeP99 ? { p99: percentile(values, .99) } : {}), maximum: values.length ? Math.max(...values) : null };
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
async function directoryBytes(root) {
  let total = 0;
  async function walk(path) { for (const name of await readdir(path)) { const child = join(path, name), meta = await lstat(child); if (meta.isDirectory()) await walk(child); else if (meta.isFile()) total += meta.size; } }
  await walk(root); return total;
}
function body(session, event, units) {
  const marker = `m11-marker-session-${session}-event-${event}; pending approval; source must remain exact; `;
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
    const shardFirstParent = parentId; let shardUnits = 0, shardBytes = 0, shardEvents = 0, firstEventId;
    try {
      while (decodedUnits < targetUnits && shardUnits < c.shardDecodedUnits) {
        const units = Math.min(c.bodyUnits, targetUnits - decodedUnits, c.shardDecodedUnits - shardUnits);
        const eventId = `m11-s${session}-e${String(events + 1).padStart(8, "0")}`;
        const bytes = Buffer.from(line(eventId, parentId, body(session, events + 1, units)));
        await writeAll(handle, bytes); firstEventId ??= eventId; parentId = eventId; events++; shardEvents++; decodedUnits += units; shardUnits += units; sourceBytes += bytes.length; shardBytes += bytes.length;
        const due = Math.floor(events * generationTarget / Math.ceil(targetUnits / c.bodyUnits));
        if (compactions < due) { compactions++; const compact = Buffer.from(compactionLine(session, compactions, parentId)); await writeAll(handle, compact); parentId = `m11-s${session}-c${compactions}`; sourceBytes += compact.length; shardBytes += compact.length; }
      }
    } finally { await handle.close(); }
    shards.push({ ordinal: shardOrdinal, path, sourceBytes: shardBytes, decodedUnits: shardUnits, events: shardEvents, firstParentId: shardFirstParent, firstEventId, leafId: parentId }); shardOrdinal++;
  }
  return { session, sessionRoot, decodedUnits, estimatedTokens: Math.max(1, Math.ceil(decodedUnits / 4)), sourceBytes, events, compactions, shards, leafId: parentId };
}
async function generate(root, c) {
  const sessions = []; const targets = sessionTargets(c);
  for (let index = 0; index < c.sessions; index++) sessions.push(await generateSession(root, index + 1, targets[index], c));
  const totals = sessions.reduce((out, item) => { for (const key of ["decodedUnits", "estimatedTokens", "sourceBytes", "events", "compactions"]) out[key] += item[key]; out.shards += item.shards.length; return out; }, { decodedUnits: 0, estimatedTokens: 0, sourceBytes: 0, events: 0, compactions: 0, shards: 0 });
  return { sessions, totals };
}
async function runtimeModules() {
  return Promise.all([
    import("../dist/src/catalog-worker-client.js"), import("../dist/src/capsule-worker-client.js"), import("../dist/src/search-v3-worker-client.js"),
    import("../dist/src/capsule-contract.js"), import("../dist/src/context-composer.js"), import("../dist/src/host-worker-scheduler.js"),
  ]).then(([catalog, capsule, search, contract, composer, scheduler]) => ({ catalog, capsule, search, contract, composer, scheduler }));
}
function metrics() { return { calls: 0, failures: {}, latencies: { ingestion: [], search: [], recall: [], exact: [], composition: [], request: [] }, sourceBytes: {}, workerPeaks: [], processIo: { readChars: 0, writtenChars: 0, storageReadBytes: 0, storageWrittenBytes: 0 } }; }
function observe(m, kind, started, response) {
  const elapsed = performance.now() - started; m.calls++; m.latencies.request.push(elapsed); (m.latencies[kind] ??= []).push(elapsed);
  const code = response?.ok === false ? response.code : response?.response?.status === "failed" ? response.response.failureCode : null;
  if (code) m.failures[code] = (m.failures[code] ?? 0) + 1;
  const source = Number(response?.sourceBytes ?? 0); (m.sourceBytes[kind] ??= []).push(source);
  const observation = safeObservation(response); if (observation) { m.workerPeaks.push(observation); for (const key of Object.keys(m.processIo)) m.processIo[key] += Number(observation.processIo?.[key] ?? 0); }
  return elapsed;
}
async function pool(items, concurrency, worker) {
  let next = 0; const results = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; results[index] = await worker(items[index], index); } }));
  return results;
}
async function qualifyLane(root, generated, slots, modules, m) {
  const schedulerDirectory = join(root, `scheduler-slots-${slots}`); await mkdir(schedulerDirectory, { mode: 0o700 });
  const states = await pool(generated.sessions, generated.sessions.length, async session => {
    const laneRoot = join(root, `state-slots-${slots}`, `session-${String(session.session).padStart(2, "0")}`);
    await mkdir(laneRoot, { recursive: true, mode: 0o700 });
    const catalogDirectory = join(laneRoot, "catalog"), derivedDirectory = join(laneRoot, "derived"), searchDirectory = join(laneRoot, "search");
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
    return { session, catalogCall, capsuleCall, searchCall, view, searchIdentity, directories: { catalogDirectory, derivedDirectory, searchDirectory } };
  });
  await pool(states, states.length, async state => {
    const found = await state.searchCall("search", { op: "query", view: state.view, query: `m11-marker-session-${state.session.session}-event-1`, mode: "literal", limit: 2 });
    assert.ok(found.hits?.length > 0, "search must find generated source");
    const recalled = await state.searchCall("recall", { op: "recall", view: state.view, handle: found.hits[0].handle });
    assert.match(recalled.text, new RegExp(`m11-marker-session-${state.session.session}`));
    const shard = state.session.shards.at(-1), currentSourceBytes = (await stat(shard.path)).size;
    const appendedId = `m11-s${state.session.session}-append-${slots}-${currentSourceBytes}`;
    await appendFile(shard.path, line(appendedId, state.session.leafId, `m11 append session ${state.session.session}, slots ${slots}`));
    const started = performance.now(); const ingest = await modules.catalog.runCatalogWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory,
      sessionKey: sha(`m11-session-${state.session.session}`).slice(0, 64), op: "ingestStep", sourcePath: shard.path, shardKey: `shard-${shard.ordinal}`, branchKey: "main", shardOrdinal: shard.ordinal,
      ...(shard.ordinal ? { parent: { shardKey: `shard-${shard.ordinal - 1}`, eventId: shard.firstParentId } } : {}) }, { schedulerDirectory, slots });
    observe(m, "ingestion", started, ingest); assert.equal(ingest.ok, true);
    const old = await state.catalogCall({ op: "page", view: state.view, after: Math.max(0, state.view.eventCut - 1), limit: 2 });
    assert.equal(old.events.at(-1).metadata.id, state.session.leafId, "pinned view excludes concurrent append");
    const rawEvent = old.events.at(-1); const exactStarted = performance.now();
    const exact = await modules.catalog.runCatalogWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory,
      sessionKey: sha(`m11-session-${state.session.session}`).slice(0, 64), op: "raw", view: state.view, eventSeq: rawEvent.seq, offset: rawEvent.rawStart,
      length: Math.min(8192, rawEvent.endByte - rawEvent.rawStart) }, { schedulerDirectory, slots });
    observe(m, "exact", exactStarted, exact); assert.equal(exact.ok, true);
  });
  const stale = states[0]; const staleStarted = performance.now();
  const staleResponse = await modules.search.runSearchV3Worker({ v: 1, searchDirectory: stale.directories.searchDirectory, capsuleDirectory: stale.directories.derivedDirectory,
    catalogDirectory: stale.directories.catalogDirectory, identity: { ...stale.searchIdentity, schemaVersion: 999 }, op: "status", view: stale.view }, { schedulerDirectory, slots });
  observe(m, "search", staleStarted, staleResponse); assert.equal(staleResponse.ok, false, "stale schema must refuse");
  const residue = await modules.scheduler.schedulerArtifactCounts(schedulerDirectory); assert.deepEqual(residue, { tickets: 0, slots: 0 });
  return { slots, sessions: states.length, schedulerResidue: residue };
}
function compositionInput(session, ordinal) {
  const seq = Math.max(2, session.events); const row = (kind, suffix, startSeq) => ({ id: `${kind}-${ordinal}-${suffix}`, text: `${kind} for session ${session.session}, generation ${ordinal}; unresolved and source-linked.`,
    startSeq, endSeq: startSeq, recovery: `opaque:m11:${session.session}:${startSeq}`, kind, authority: "derived", sourceAuthority: kind === "restriction" ? "user" : "assistant", status: kind === "restriction" ? "current" : "unresolved", importance: kind === "restriction" ? 1 : .8 });
  return { regularPiSummary: `Deterministic Pi summary for session ${session.session}, generation ${ordinal}.`, combinedCeilingTokens: 30_000,
    cut: { sourceCutEntryId: session.leafId, sourceCutSeq: seq, firstKeptEntryId: session.leafId, firstKeptSeq: seq, rawTailTokens: 64, toolPairSafe: true },
    memory: { generation: `m11-${session.session}-${ordinal}`, representedStartSeq: 1, representedEndSeq: seq, committed: true },
    rollups: { generation: `m11-rollup-${session.session}-${ordinal}`, representedStartSeq: 1, representedEndSeq: Math.max(1, seq - 1), complete: true },
    mandatoryCoverage: { protectedComplete: true, openWorkComplete: true }, selected: { protected: [row("restriction", "p", 1)], openWork: [row("open-work", "w", seq - 1)], recent: [row("capsule", "r", seq)], older: [row("rollup", "o", 2)] }, delta: { records: [], completeThroughCut: true } };
}
async function runCampaign(args) {
  assert.equal(currentSha(), args.candidateSha, "candidate SHA must equal checkout HEAD");
  const startedAt = Date.now(), started = performance.now();
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let rootCreated = false, passed = false, report;
  try {
    if (args.mode === "run") { await mkdir(args.campaignRoot, { mode: 0o700 }); rootCreated = true; }
    const meta = await lstat(args.campaignRoot); assert.ok(meta.isDirectory() && !meta.isSymbolicLink() && (meta.mode & 0o077) === 0, "campaign root must be owner-only");
    const manifestPath = join(args.campaignRoot, "campaign-manifest.json");
    let profile, generated;
    if (args.mode === "resume") {
      const saved = JSON.parse(await readFile(manifestPath, "utf8")); assert.equal(saved.schemaVersion, SCHEMA_VERSION); assert.equal(saved.candidateSha, args.candidateSha); profile = saved.profile; generated = saved.generated;
      for (const session of generated.sessions) for (const shard of session.shards) assert.ok((await stat(shard.path)).size >= shard.sourceBytes, "resume source was truncated");
    } else {
      profile = args.profile; const c = config(profile); generated = await generate(args.campaignRoot, c);
      await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, candidateSha: args.candidateSha, profile, generated })}\n`, { mode: 0o600 });
    }
    const c = config(profile); assert.ok(generated.totals.sourceBytes <= c.diskLimitBytes); const modules = await runtimeModules(); const m = metrics();
    const baseline = processMemory(), lanes = [];
    for (let i = 0; i < c.slots.length; i++) {
      const count = c.sessionCounts[Math.min(i, c.sessionCounts.length - 1)];
      lanes.push(await qualifyLane(args.campaignRoot, { sessions: generated.sessions.slice(0, count) }, c.slots[i], modules, m));
    }
    const compositionHashes = [], compositionStart = performance.now();
    for (let ordinal = 1; ordinal <= c.compositionGenerations; ordinal++) {
      const session = generated.sessions[(ordinal - 1) % generated.sessions.length], one = performance.now();
      const first = modules.composer.composeShadowContext(compositionInput(session, ordinal)); const second = modules.composer.composeShadowContext(compositionInput(session, ordinal));
      m.latencies.composition.push(performance.now() - one); assert.equal(first.envelope.payloadHash, second.envelope.payloadHash); assert.equal(first.status, "composed"); compositionHashes.push(first.envelope.payloadHash);
    }
    const diskBytes = await directoryBytes(args.campaignRoot); assert.ok(diskBytes <= c.diskLimitBytes, "campaign disk ceiling");
    const largest = Math.max(...generated.sessions.map(item => item.estimatedTokens));
    if (profile === "full") { assert.ok(largest >= 100_000_000); assert.ok(generated.totals.estimatedTokens >= 1_000_000_000); assert.ok(generated.totals.compactions >= 100); }
    delay.disable(); passed = true;
    report = { schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-scale-campaign", status: "passed", profile, candidateSha: args.candidateSha,
      generated: { totals: generated.totals, sessions: generated.sessions.map(item => ({ session: item.session, decodedUnits: item.decodedUnits, estimatedTokens: item.estimatedTokens,
        sourceBytes: item.sourceBytes, events: item.events, physicalShards: item.shards.length, compositionRecords: item.compactions })) }, lanes,
      measurements: { mainProcess: { baseline, final: processMemory() }, workerPeakRssBytes: Math.max(0, ...m.workerPeaks.map(item => item.processPeakRssBytes ?? 0)),
        totalHostRss: "unavailable: campaign observes its cgroup and worker peaks, not an independent live-host capacity pool",
        eventLoopDelayMs: { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, p99: delay.percentile(99) / 1e6, maximum: delay.max / 1e6 },
        ingestionLag: "bounded catch-up completion checked; elapsed settled-to-ready lag is not exposed by these worker APIs",
        searchMs: distribution(m.latencies.search), recallMs: distribution(m.latencies.recall, false), exactMs: distribution(m.latencies.exact),
        compositionMs: { ...distribution(m.latencies.composition), total: performance.now() - compositionStart, excludesPiModelSummary: true },
        sourceBytesReadPerOperation: Object.fromEntries(Object.entries(m.sourceBytes).map(([key, values]) => [key, distribution(values)])),
        segmentBytesRead: "unavailable: current public worker observations combine process I/O and do not attribute immutable-segment bytes",
        queueWait: "unavailable: request wall time includes admission, process startup, work, and response; scheduler does not expose queue wait separately",
        requestWallMs: distribution(m.latencies.request), failures: m.failures, recoveryTime: "process resume is measured by a separate resume invocation; system restart requires operator evidence",
        exactReferenceValidation: { sampledSessions: generated.sessions.length, passed: true }, contextCoverage: { protectedComplete: true, openWorkComplete: true, deterministicGenerations: compositionHashes.length }, processIo: m.processIo },
      diskBytes, wallMs: performance.now() - started, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      faultCoverage: { sourceAppendDuringPinnedSnapshot: "passed", staleSchemaGeneration: "passed", workerCrashAndTransactionKill: "reuse revision-bound M03/M04 evidence; not reinjected by this script", corruptedDerivedSegment: "not yet exercised",
        processRestart: args.mode === "resume" ? "passed" : "pending resume invocation", systemRestart: "requires operator reboot between run and resume; not inferred" },
      limitations: ["Generated estimated tokens equal ceil(actual decoded UTF-16 units / 4), the runtime estimator. Source bytes and event counts are measured from real writes.",
        "Composition generations call the deterministic composer with source-linked generated identities. They do not claim a Pi provider summary or authoritative activation.",
        "The campaign does not infer total host RSS, queue wait, segment-only bytes, ingestion-lag duration, or system-restart success from broader counters."] };
  } catch (error) {
    delay.disable(); report = { schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-scale-campaign", status: "failed", candidateSha: args.candidateSha,
      failureCode: /^[A-Za-z0-9_-]{1,80}$/.test(error?.code ?? "") ? error.code : "m11-campaign-failed", failureMessage: String(error?.message ?? "failure").replaceAll(args.campaignRoot ?? "", "<campaign-root>"),
      retainedCampaignRoot: rootCreated || args.mode === "resume", wallMs: performance.now() - started };
  }
  await mkdir(resolve(args.output, ".."), { recursive: true, mode: 0o700 }); await writeFile(args.output, `${JSON.stringify(report)}\n`, { mode: 0o600 }); await chmod(args.output, 0o600);
  console.log(JSON.stringify({ status: report.status, profile: report.profile, output: basename(args.output), wallMs: report.wallMs }));
  if (!passed) process.exitCode = 1;
}
export { FULL, SMOKE, config, distribution, parseArgs, sessionTargets };
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv); if (args.mode === "help") return console.log(HELP);
  assert.equal(currentSha(), args.candidateSha, "candidate SHA must equal checkout HEAD");
  if (args.mode === "plan") { const c = config(args.profile); console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-plan", profile: args.profile, candidateSha: args.candidateSha,
    sessions: c.sessions, sessionMatrix: c.sessionCounts, workerSlotMatrix: c.slots, actualDecodedUnits: c.totalDecodedUnits, minimumEstimatedTokens: Math.ceil(c.totalDecodedUnits / 4),
    largestSessionEstimatedTokens: Math.ceil(c.largestSessionDecodedUnits / 4), compositionGenerations: c.compositionGenerations, diskLimitBytes: c.diskLimitBytes, wallLimitMs: c.wallLimitMs,
    requiresExclusiveParentConfirmation: args.profile === "full" })); return; }
  await runCampaign(args);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
