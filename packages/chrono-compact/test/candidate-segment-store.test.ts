import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateDependency, persistentCandidateKey, precomputeCandidateRepresentations } from "../src/candidates.js";
import { candidateStoreBytes, cleanupOrphanCandidateSegments, createCandidateSegmentStore, loadCandidateRecordsForBranch, loadCandidateSegmentManifest, updateCandidateSegmentStore } from "../src/candidate-segment-store.js";
import { compactEntries, resolveCompactorConfig } from "../src/compactor.js";
import { reduceBlock } from "../src/reducers/index.js";
import { getActiveBranch, parseSessionJsonl } from "../src/jsonl.js";
import { parseHistoricalBlocks } from "../src/blocks.js";

function header() { return { type: "session", version: 1, id: "synthetic-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/synthetic" }; }
function user(id: string, parentId: string | null, text: string) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text, timestamp: 1 } }; }
function assistant(id: string, parentId: string, text: string) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } }; }
function call(id: string, parentId: string, callId: string) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "synthetic.txt" } }], timestamp: 3 } }; }
function result(id: string, parentId: string, callId: string, text: string) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:04Z", message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 4 } }; }
async function writeSession(path: string, entries: object[]) { await writeFile(path, [header(), ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 }); }
const config = resolveCompactorConfig({ targetTokens: 2_500, enableSemanticCompression: false });

async function setup(entries: object[], options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "candidate-segments-test-")); const source = join(dir, "session.jsonl"); await writeSession(source, entries);
  const store = createCandidateSegmentStore(source, { storePath: join(dir, "store"), ledgerPath: join(dir, "ledger.jsonl"), ...options });
  return { dir, source, store };
}

test("candidate dependencies separate source-local, pairing, and future-sensitive keys", async () => {
  const entries = [user("u1", null, "Keep this synthetic request."), call("c1", "u1", "tool-1"), result("r1", "c1", "tool-1", "alpha\nbeta\ngamma"), assistant("a1", "r1", "Use gamma later")];
  const blocks = parseHistoricalBlocks(entries as any); const tool = blocks.find((block) => block.entryId === "r1")!;
  const localKey = persistentCandidateKey(tool, config); const appended = parseHistoricalBlocks([...entries, assistant("a2", "a1", "Unrelated later text")] as any).find((block) => block.entryId === "r1")!;
  assert.equal(localKey, persistentCandidateKey(appended, config)); assert.equal(candidateDependency(tool), "pairing-dependent");
  const first = await precomputeCandidateRepresentations(blocks, config); const second = await precomputeCandidateRepresentations(parseHistoricalBlocks([...entries, assistant("a2", "a1", "Unrelated later text")] as any), config, first.records);
  assert.ok(second.reused > 0); for (const record of second.records.values()) for (const candidate of record.candidates) {
    assert.notEqual(candidate.level, "raw"); assert.notEqual(candidate.level, "normalized"); assert.notEqual(candidate.level, "semantic"); assert.notEqual(candidate.reducer, "llm-semantic");
    assert.notEqual(candidate.reducer, "file-read"); assert.notEqual(candidate.reducer, "search-results");
  }
  const longRead = parseHistoricalBlocks([call("fc", "u1", "file-call"), result("fr", "fc", "file-call", Array.from({ length: 100 }, (_, index) => index === 20 ? "plain targetAlpha.ts evidence" : index === 80 ? "plain targetOmega.ts evidence" : `plain content ${index}`).join("\n"))] as any).find((block) => block.entryId === "fr")!;
  assert.notEqual(reduceBlock({ block: longRead, maxTokens: 300, laterText: "Use targetAlpha.ts" }).text,
    reduceBlock({ block: longRead, maxTokens: 300, laterText: "Use targetOmega.ts" }).text, "future-sensitive reductions must use current later history");
});

test("new, exact-hit, append, immutable segments, permissions, and cross-segment pairing", async (t) => {
  const env = await setup([user("u1", null, "Never expose the protected sentinel."), call("c1", "u1", "tool-1"), result("r1", "c1", "tool-1", "small file output")], { targetEntries: 1, targetSourceBytes: 128 });
  t.after(() => rm(env.dir, { recursive: true, force: true })); const first = await updateCandidateSegmentStore(env.store, config, { targetEntries: 1, targetSourceBytes: 128 });
  assert.equal(first.transition, "new"); assert.equal(first.entriesParsed, 3); const manifest = env.store.manifest!; assert.ok(manifest.segments.length >= 3);
  const old = new Map<string, string>(); for (const item of manifest.segments) old.set(item.fileName, await readFile(join(env.store.storePath, item.fileName), "utf8"));
  const manifestText = await readFile(join(env.store.storePath, "manifest.json"), "utf8"); const exact = await updateCandidateSegmentStore(env.store, config, { targetEntries: 1, targetSourceBytes: 128 });
  assert.equal(exact.transition, "exact-hit"); assert.equal(await readFile(join(env.store.storePath, "manifest.json"), "utf8"), manifestText);
  await writeSession(env.source, [user("u1", null, "Never expose the protected sentinel."), call("c1", "u1", "tool-1"), result("r1", "c1", "tool-1", "small file output"), assistant("a1", "r1", "done")]);
  const appendMetrics = await updateCandidateSegmentStore(env.store, config, { targetEntries: 1, targetSourceBytes: 128 }); assert.equal(appendMetrics.transition, "append"); assert.equal(appendMetrics.entriesParsed, 1);
  for (const [name, text] of old) assert.equal(await readFile(join(env.store.storePath, name), "utf8"), text);
  assert.equal((await lstat(env.store.storePath)).mode & 0o777, 0o700); assert.equal((await lstat(join(env.store.storePath, "manifest.json"))).mode & 0o777, 0o600);
  for (const name of await readdir(env.store.storePath)) if (name.startsWith("segment-")) assert.equal((await lstat(join(env.store.storePath, name))).mode & 0o777, 0o600);
  const allText = (await Promise.all((await readdir(env.store.storePath)).filter((name) => name.startsWith("segment-")).map((name) => readFile(join(env.store.storePath, name), "utf8")))).join("\n");
  assert.doesNotMatch(allText, /Never expose the protected sentinel/); assert.doesNotMatch(allText, /\"level\":\"raw\"|\"level\":\"normalized\"|llm-semantic/);
});

test("cached and cold compaction are byte-identical after reload and append", async (t) => {
  const entries = [user("u1", null, "Keep the restriction exact."), assistant("a1", "u1", "reasoning ".repeat(600)), call("c1", "a1", "tool-1"), result("r1", "c1", "tool-1", "line\n".repeat(800))];
  const env = await setup(entries); t.after(() => rm(env.dir, { recursive: true, force: true })); await updateCandidateSegmentStore(env.store, config);
  const parsed = parseSessionJsonl(await readFile(env.source, "utf8")); const branch = getActiveBranch(parsed); const cold = await compactEntries(branch, { config });
  const records = await loadCandidateRecordsForBranch(env.store, branch.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : [])); const warm = await compactEntries(branch, { config, precomputedCandidates: records });
  assert.equal(warm.summary, cold.summary); assert.equal(warm.renderedTokens, cold.renderedTokens); assert.deepEqual(warm.plan.units.map((unit) => [unit.id, unit.selected.level, unit.selected.text, unit.sourceRefs]), cold.plan.units.map((unit) => [unit.id, unit.selected.level, unit.selected.text, unit.sourceRefs]));
  assert.equal(warm.details.generationHash, cold.details.generationHash); assert.deepEqual(warm.validation, cold.validation);
  const reloaded = createCandidateSegmentStore(env.source, { storePath: env.store.storePath, ledgerPath: env.store.ledgerPath }); reloaded.ledger = env.store.ledger; await loadCandidateSegmentManifest(reloaded);
  const reloadedRecords = await loadCandidateRecordsForBranch(reloaded, branch.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : [])); const coldStore = await compactEntries(branch, { config, precomputedCandidates: reloadedRecords }); assert.equal(coldStore.summary, cold.summary);
});

test("cancelled construction does not publish an unfinished manifest", async (t) => {
  const env = await setup([user("u1", null, "Synthetic request"), assistant("a1", "u1", "one ".repeat(200)), assistant("a2", "a1", "two ".repeat(200))]);
  t.after(() => rm(env.dir, { recursive: true, force: true })); const controller = new AbortController();
  await assert.rejects(updateCandidateSegmentStore(env.store, config, { targetEntries: 1, signal: controller.signal,
    yieldNow: async () => { controller.abort(new Error("test cancellation")); } }), /test cancellation/);
  assert.equal(await loadCandidateSegmentManifest(env.store), undefined);
});

test("corruption, orphan cleanup, byte cache, config rebuild, and active-reader boundary fail safely", async (t) => {
  const env = await setup([user("u1", null, "Synthetic request"), assistant("a1", "u1", "output ".repeat(400))], { cacheBytes: 1 }); t.after(() => rm(env.dir, { recursive: true, force: true }));
  await updateCandidateSegmentStore(env.store, config); const descriptor = env.store.manifest!.segments[0]!; await writeFile(join(env.store.storePath, descriptor.fileName), "{}\n", { mode: 0o600 });
  const bad = await loadCandidateRecordsForBranch(env.store, ["u1", "a1"]); assert.equal(bad.size, 0); assert.ok(env.store.metrics.candidateIntegrityRejections > 0); assert.equal(env.store.cacheBytes, 0);
  const orphan = join(env.store.storePath, "segment-999999-orphan.json"); await writeFile(orphan, "{}", { mode: 0o600 }); assert.equal(await cleanupOrphanCandidateSegments(env.store), 1);
  const rebuilt = await updateCandidateSegmentStore(env.store, resolveCompactorConfig({ targetTokens: 3_000, emergencyAllowAbsent: false, enableSemanticCompression: false })); assert.equal(rebuilt.transition, "rebuild-config-change"); assert.ok(await candidateStoreBytes(env.store) > 0);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const writer = updateCandidateSegmentStore(env.store, config, { lockAcquired: async () => held }); await new Promise((resolve) => setTimeout(resolve, 5));
  const old = await loadCandidateSegmentManifest(env.store); assert.ok(old);
  for (const segment of old.segments) assert.ok((await stat(join(env.store.storePath, segment.fileName))).isFile(), "old snapshot segments must remain readable while the writer is active");
  await loadCandidateRecordsForBranch(env.store, ["u1", "a1"]);
  release(); await writer;
});
