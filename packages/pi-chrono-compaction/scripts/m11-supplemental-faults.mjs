#!/usr/bin/env node
// @ts-nocheck
// Synthetic-only M11 supplemental fault qualification. Every killed process is
// created by this harness and uses the existing production host-wide admission.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MiB = 1024 * 1024;
const SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({
  requestedHostWideSlots: 1,
  repeatedDeaths: 3,
  faultWorkerSourceBytes: 8 * MiB,
  faultWorkerResponseBytes: 256 * 1024,
  faultWorkerMemoryBytes: 256 * MiB,
  faultWorkerHeapMiB: 128,
  faultWorkerDeadlineMs: 30_000,
  postRunDiskAcceptanceBytes: 128 * MiB,
  postRunWallAcceptanceMs: 2 * 60_000,
});
const HELP = `Usage:
  node scripts/m11-supplemental-faults.mjs run --candidate-sha <40-hex> --root <absolute-new-directory> --output <absolute-json>`;

function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function parseArgs(argv) {
  if (["help", "--help", "-h"].includes(argv[0])) return { mode: "help" };
  if (argv[0] !== "run") throw new Error("m11-supplemental-mode");
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, option.slice(2))) throw new Error("m11-supplemental-option");
    values[option.slice(2)] = value;
  }
  if (Object.keys(values).some(key => !["candidate-sha", "root", "output"].includes(key))) throw new Error("m11-supplemental-option");
  if (!/^[a-f0-9]{40}$/.test(values["candidate-sha"] ?? "")) throw new Error("m11-supplemental-candidate-sha");
  for (const key of ["root", "output"]) if (!isAbsolute(values[key] ?? "")) throw new Error(`m11-supplemental-${key}`);
  if (resolve(values.output).startsWith(`${resolve(values.root)}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("m11-supplemental-output-inside-root");
  return { mode: "run", candidateSha: values["candidate-sha"], root: values.root, output: values.output };
}
function currentSha() { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
async function hashFile(path) {
  const handle = await open(path, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024); let offset = 0;
  try { for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; } }
  finally { await handle.close(); }
  return hash.digest("hex");
}
async function directoryBytes(root) {
  let bytes = 0;
  async function walk(path) { for (const name of await readdir(path)) { const child = join(path, name), metadata = await lstat(child); if (metadata.isDirectory()) await walk(child); else if (metadata.isFile()) bytes += metadata.size; } }
  await walk(root); return bytes;
}
function line(id, parentId, text) {
  return `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-09-11T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}
function validateHarnessRequest(value) {
  assert.ok(value && typeof value === "object");
  assert.ok(["kill", "healthy", "transaction-kill"].includes(value.action));
  assert.match(value.id, /^[a-z0-9-]{1,64}$/);
  if (value.action === "transaction-kill") assert.ok(value.catalogRequest && typeof value.catalogRequest === "object");
  return value;
}
function validateHarnessResponse(value) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), ["id", "ok", "pid"]);
  assert.equal(value.ok, true); assert.equal(typeof value.id, "string"); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  return value;
}
async function runtimeModules() {
  const [runtime, catalog, capsule, search, contract] = await Promise.all([
    import("../dist/src/worker-runtime.js"), import("../dist/src/catalog-worker-client.js"), import("../dist/src/capsule-worker-client.js"),
    import("../dist/src/search-v3-worker-client.js"), import("../dist/src/capsule-contract.js"),
  ]);
  return { runtime, catalog, capsule, search, contract };
}
async function writeWorker(root) {
  const sqliteUrl = pathToFileURL(resolve("dist/src/catalog-sqlite.js")).href;
  const engineUrl = pathToFileURL(resolve("dist/src/catalog-engine.js")).href;
  const workerPath = join(root, "fault-worker.mjs");
  const source = `import {CatalogSqlite} from ${JSON.stringify(sqliteUrl)};\nimport {executeCatalogRequest} from ${JSON.stringify(engineUrl)};\nprocess.on("message",request=>{\n  if(request.action==="kill"){process.kill(process.pid,"SIGKILL");return;}\n  if(request.action==="healthy"){process.send({ok:true,id:request.id,pid:process.pid});return;}\n  const original=CatalogSqlite.prototype.prepare;let fired=false;\n  CatalogSqlite.prototype.prepare=function(sql){const statement=original.call(this,sql);if(sql.startsWith("INSERT INTO events")){const run=statement.run;statement.run=(...values)=>{const result=run(...values);if(!fired){fired=true;process.kill(process.pid,"SIGKILL");}return result;};}return statement;};\n  executeCatalogRequest(request.catalogRequest);\n});\n`;
  await writeFile(workerPath, source, { mode: 0o600 });
  return workerPath;
}
function workerOptions(root, modules, workerPath, request) {
  return {
    entryPath: workerPath,
    request,
    identity: { schemaVersion: 1, kind: "synthetic", sessionKey: sha(`m11-supplemental-${request.id}`) },
    caps: { deadlineMs: Date.now() + LIMITS.faultWorkerDeadlineMs, sourceBytes: LIMITS.faultWorkerSourceBytes, responseBytes: LIMITS.faultWorkerResponseBytes, memoryBytes: LIMITS.faultWorkerMemoryBytes, heapMiB: LIMITS.faultWorkerHeapMiB },
    slots: LIMITS.requestedHostWideSlots,
    priority: "low",
    validateRequest: validateHarnessRequest,
    validateResponse: validateHarnessResponse,
  };
}
async function expectCrash(modules, options) {
  try { await modules.runtime.runBoundedWorker(options); assert.fail("worker unexpectedly survived"); }
  catch (error) { assert.equal(error?.code ?? error?.message, "worker-crashed"); return "worker-crashed"; }
}
async function runRepeatedDeaths(root, modules, workerPath) {
  const attempts = [];
  for (let ordinal = 1; ordinal <= LIMITS.repeatedDeaths; ordinal++) {
    const code = await expectCrash(modules, workerOptions(root, modules, workerPath, { action: "kill", id: `death-${ordinal}` }));
    const healthy = await modules.runtime.runBoundedWorker(workerOptions(root, modules, workerPath, { action: "healthy", id: `recovery-${ordinal}` }));
    assert.equal(healthy.value.id, `recovery-${ordinal}`);
    attempts.push({ ordinal, failureCode: code, healthyAdmissionPidObserved: Number.isSafeInteger(healthy.value.pid), queueWaitMs: healthy.metrics.queueWaitMs, admissionReleaseEvidence: "the next task-owned job acquired the same production host-wide one-slot admission" });
  }
  return { passed: true, attempts };
}
async function catalogCall(modules, request) {
  const response = await modules.catalog.runCatalogWorker(request, { slots: LIMITS.requestedHostWideSlots });
  assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
}
async function physicalCatalogDirectory(catalogDirectory) {
  const active = JSON.parse(await readFile(join(catalogDirectory, "active.json"), "utf8"));
  const reference = JSON.parse(await readFile(join(catalogDirectory, "refs", `${active.storeKey}.json`), "utf8"));
  return join(catalogDirectory, "stores", reference.folder);
}
async function runTransactionKill(root, modules, workerPath) {
  const scenarioRoot = join(root, "transaction"), catalogDirectory = join(scenarioRoot, "catalog"), sourcePath = join(scenarioRoot, "source.jsonl");
  await mkdir(scenarioRoot, { mode: 0o700 });
  await writeFile(sourcePath, line("tx-root", null, "synthetic committed root"), { mode: 0o600 });
  const sessionKey = sha("m11-supplemental-transaction"), base = { v: 1, catalogDirectory, sessionKey };
  const ingest = { ...base, op: "ingestStep", sourcePath, shardKey: "shard-0", branchKey: "main", shardOrdinal: 0 };
  assert.equal((await catalogCall(modules, ingest)).records, 1);
  await writeFile(sourcePath, line("tx-root", null, "synthetic committed root") + line("tx-appended", "tx-root", "synthetic transaction kill payload"), { mode: 0o600 });
  const sourceHashBeforeKill = await hashFile(sourcePath), physicalDirectory = await physicalCatalogDirectory(catalogDirectory);
  const catalogRequest = { ...ingest, catalogDirectory: physicalDirectory };
  const failureCode = await expectCrash(modules, workerOptions(root, modules, workerPath, { action: "transaction-kill", id: "transaction-kill", catalogRequest }));
  const sourceHashAfterKill = await hashFile(sourcePath); assert.equal(sourceHashAfterKill, sourceHashBeforeKill);
  const afterKill = await catalogCall(modules, { ...base, op: "status", shardKey: "shard-0" }); assert.equal(afterKill.records, 1);
  const retry = await catalogCall(modules, ingest); assert.equal(retry.records, 1);
  const noop = await catalogCall(modules, ingest); assert.equal(noop.records, 0);
  const sourceHashAfterRetry = await hashFile(sourcePath); assert.equal(sourceHashAfterRetry, sourceHashBeforeKill);
  return { passed: true, failureCode, killedAfterSqlPrefix: "INSERT INTO events", recordsBeforeKill: 1, recordsAfterKill: afterKill.records, recordsOnRetry: retry.records, recordsOnNoop: noop.records,
    sourceSha256: { beforeKill: sourceHashBeforeKill, afterKill: sourceHashAfterKill, afterRetry: sourceHashAfterRetry }, admissionReleaseEvidence: "status and retry acquired production host-wide admission after the killed transaction worker" };
}
async function deriveToEnd(modules, request) {
  let cursor;
  for (let page = 0; page < 32; page++) {
    const response = await modules.capsule.runCapsuleWorker({ ...request, ...(cursor ? { cursor } : {}) }, { slots: LIMITS.requestedHostWideSlots });
    assert.equal(response.ok, true, JSON.stringify(response)); if (response.result.complete) return; cursor = response.result.cursor;
  }
  assert.fail("capsule derivation did not complete");
}
async function searchToEnd(modules, request) {
  for (let page = 0; page < 32; page++) {
    const response = await modules.search.runSearchV3Worker(request, { slots: LIMITS.requestedHostWideSlots });
    assert.equal(response.ok, true, JSON.stringify(response)); if (response.result.complete) return;
  }
  assert.fail("search ingestion did not complete");
}
async function runAbandonedSibling(root, modules) {
  const scenarioRoot = join(root, "fork"), sourcePath = join(scenarioRoot, "source.jsonl"), catalogDirectory = join(scenarioRoot, "catalog"), derivedDirectory = join(scenarioRoot, "derived"), searchDirectory = join(scenarioRoot, "search");
  await mkdir(scenarioRoot, { mode: 0o700 });
  const source = line("fork-root", null, "m11 fork ancestor") + line("fork-abandoned", "fork-root", "m11 abandoned sibling marker") + line("fork-active", "fork-root", "m11 selected active marker");
  await writeFile(sourcePath, source, { mode: 0o600 }); const sourceHashBefore = await hashFile(sourcePath);
  const sessionKey = sha("m11-supplemental-fork"), catalogBase = { v: 1, catalogDirectory, sessionKey };
  await catalogCall(modules, { ...catalogBase, op: "ingestStep", sourcePath, shardKey: "shard-0", branchKey: "main", shardOrdinal: 0 });
  const abandonedView = (await catalogCall(modules, { ...catalogBase, op: "pin", branchKey: "main", leaf: { shardKey: "shard-0", eventId: "fork-abandoned" } })).view;
  const activeView = (await catalogCall(modules, { ...catalogBase, op: "pin", branchKey: "main", leaf: { shardKey: "shard-0", eventId: "fork-active" } })).view;
  const identity = { storeKey: randomUUID(), sessionKey, catalogStoreKey: activeView.storeKey, catalogGeneration: activeView.generation,
    derivedSchemaVersion: modules.contract.DERIVED_SCHEMA_VERSION, capsuleSchemaVersion: modules.contract.CAPSULE_SCHEMA_VERSION, chunkSchemaVersion: modules.contract.CHUNK_SCHEMA_VERSION,
    reducerSetVersion: modules.contract.CAPSULE_REDUCER_PIPELINE_VERSION, configHash: sha("m11-supplemental-capsules") };
  const capsuleBase = { v: 1, catalogDirectory, derivedDirectory, identity, op: "derivePage" };
  await deriveToEnd(modules, { ...capsuleBase, view: abandonedView });
  await deriveToEnd(modules, { ...capsuleBase, view: activeView });
  const abandonedPage = await modules.capsule.runCapsuleWorker({ v: 1, catalogDirectory, derivedDirectory, identity, op: "capsulePage", view: abandonedView, limit: 8 }, { slots: LIMITS.requestedHostWideSlots });
  const activePage = await modules.capsule.runCapsuleWorker({ v: 1, catalogDirectory, derivedDirectory, identity, op: "capsulePage", view: activeView, limit: 8 }, { slots: LIMITS.requestedHostWideSlots });
  assert.equal(abandonedPage.ok, true, JSON.stringify(abandonedPage)); assert.equal(activePage.ok, true, JSON.stringify(activePage));
  const abandonedSeqs = abandonedPage.result.capsules.map(item => item.source.eventSeq), activeSeqs = activePage.result.capsules.map(item => item.source.eventSeq);
  assert.deepEqual(abandonedSeqs, [1, 2]); assert.deepEqual(activeSeqs, [1, 3]);
  const searchIdentity = { storeKey: randomUUID(), capsule: identity, schemaVersion: 1, configHash: sha("m11-supplemental-search") };
  const searchBase = { v: 1, searchDirectory, capsuleDirectory: derivedDirectory, catalogDirectory, identity: searchIdentity, view: activeView };
  await searchToEnd(modules, { ...searchBase, op: "ingestPage", maxSources: 4, maxChunks: 8 });
  const selected = await modules.search.runSearchV3Worker({ ...searchBase, op: "query", query: "m11 selected active marker", mode: "literal", limit: 4 }, { slots: LIMITS.requestedHostWideSlots });
  const excluded = await modules.search.runSearchV3Worker({ ...searchBase, op: "query", query: "m11 abandoned sibling marker", mode: "literal", limit: 4 }, { slots: LIMITS.requestedHostWideSlots });
  assert.equal(selected.ok, true, JSON.stringify(selected)); assert.equal(excluded.ok, true, JSON.stringify(excluded)); assert.ok(selected.result.hits.length > 0); assert.equal(excluded.result.hits.length, 0);
  const activeCatalogPage = await catalogCall(modules, { ...catalogBase, op: "page", view: activeView, limit: 8 });
  const abandonedCatalogPage = await catalogCall(modules, { ...catalogBase, op: "page", view: abandonedView, limit: 8 });
  assert.deepEqual(activeCatalogPage.events.map(event => event.metadata.id), ["fork-root", "fork-active"]);
  assert.deepEqual(abandonedCatalogPage.events.map(event => event.metadata.id), ["fork-root", "fork-abandoned"]);
  const sourceHashAfter = await hashFile(sourcePath); assert.equal(sourceHashAfter, sourceHashBefore);
  return { passed: true, designatedAbandonedLeaf: "fork-abandoned", selectedLeaf: "fork-active", catalogEventIds: { active: activeCatalogPage.events.map(event => event.metadata.id), abandoned: abandonedCatalogPage.events.map(event => event.metadata.id) },
    capsuleEventSeqs: { active: activeSeqs, abandoned: abandonedSeqs }, activeMarkerHits: selected.result.hits.length, abandonedMarkerHitsInActiveView: excluded.result.hits.length, sourceSha256: { before: sourceHashBefore, after: sourceHashAfter } };
}
async function run(args) {
  assert.equal(currentSha(), args.candidateSha, "candidate SHA must equal checkout HEAD");
  const started = Date.now(); let rootCreated = false, passed = false, report;
  try {
    await mkdir(args.root, { mode: 0o700 }); rootCreated = true;
    const metadata = await lstat(args.root); assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0);
    const modules = await runtimeModules(), workerPath = await writeWorker(args.root), harnessPath = fileURLToPath(import.meta.url);
    const repeatedWorkerDeath = await runRepeatedDeaths(args.root, modules, workerPath);
    const transactionKill = await runTransactionKill(args.root, modules, workerPath);
    const abandonedSiblingIsolation = await runAbandonedSibling(args.root, modules);
    const diskBytes = await directoryBytes(args.root); assert.ok(diskBytes <= LIMITS.postRunDiskAcceptanceBytes, "supplemental post-run disk acceptance threshold");
    assert.ok(Date.now() - started <= LIMITS.postRunWallAcceptanceMs, "supplemental post-run wall acceptance threshold");
    passed = true;
    report = { schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-supplemental-faults", status: "completed", qualificationStatus: "bounded-supplemental-evidence", candidateSha: args.candidateSha,
      limits: { ...LIMITS, publicClientCaps: "inherited from each existing catalog, capsule, and search worker client" }, actual: { wallMs: Date.now() - started, diskBytes, requestedHostWideSlots: LIMITS.requestedHostWideSlots }, hashes: { harnessSha256: await hashFile(harnessPath), faultWorkerSha256: await hashFile(workerPath) },
      scenarios: { repeatedWorkerDeath, transactionKill, abandonedSiblingIsolation },
      unavailable: { systemRestart: "not run; process death is not a system reboot", mainPiRss: "unavailable; no Pi process participated", segmentBytesRead: "not measured or inferred", coverage: "this supplemental harness qualifies only the three named fault rows" },
      limitations: ["The abandoned leaf is a synthetic sibling designated abandoned by the harness. The catalog does not store a branch-lifecycle state.", "Source SHA-256 values cover the complete disposable synthetic files before and after each applicable scenario.", "Every contained call omitted schedulerDirectory and requested one slot, so it used the existing production host-wide admission. No independent capacity pool was created.", "Worker failure is classified from the public bounded-worker result. No live agent or provider participated."] };
  } catch (error) {
    report = { schemaVersion: SCHEMA_VERSION, kind: "chrono-m11-supplemental-faults", status: "failed", candidateSha: args.candidateSha, retainedRoot: rootCreated,
      failureCode: /^[A-Za-z0-9_-]{1,80}$/.test(error?.code ?? "") ? error.code : "m11-supplemental-failed", failureMessage: String(error?.message ?? error).replaceAll(args.root, "<supplemental-root>"), wallMs: Date.now() - started };
  }
  await mkdir(dirname(args.output), { recursive: true, mode: 0o700 }); await writeFile(args.output, `${JSON.stringify(report)}\n`, { mode: 0o600 }); await chmod(args.output, 0o600);
  console.log(JSON.stringify({ status: report.status, output: basename(args.output), wallMs: report.actual?.wallMs ?? report.wallMs }));
  if (!passed) process.exitCode = 1;
}
export { LIMITS, parseArgs };
export async function main(argv = process.argv.slice(2)) { const args = parseArgs(argv); if (args.mode === "help") return console.log(HELP); await run(args); }
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
