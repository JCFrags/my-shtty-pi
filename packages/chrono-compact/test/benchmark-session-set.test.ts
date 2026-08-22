import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Executable benchmark module has no declarations.
import { aggregateRows, benchmarkSnapshot, distribution, loadExplicitManifest, lossySourceCoverage, mapFailure, memoryGate, parseSessionSetArguments, protectedVisibility, runSessionSet, selectSessionFiles } from "../../scripts/benchmark-session-set.mjs";
// @ts-expect-error Public synthetic generator has no declarations.
import { syntheticEntries } from "../../scripts/benchmark-v2.mjs";

async function temporary(t: test.TestContext) { const path = await mkdtemp(join(tmpdir(), "session-set-test-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function options(manifest: string, output: string) { return { mode: "run", manifest, output, minimumBytes: 1, minimumCount: 1, maximumFiles: 10, maximumMinutes: 1, perSessionTimeoutSeconds: 10 }; }

test("strict arguments accept explicit run and reject unsafe values", () => {
  const parsed = parseSessionSetArguments(["run", "--manifest", "m", "--output", "o"]);
  assert.equal(parsed.maximumFiles, 100);
  for (const args of [[], ["scan"], ["run", "--manifest"], ["run", "--manifest", "m", "--output", "o", "--unknown", "1"],
    ["run", "--manifest", "m", "--output", "o", "--maximum-files", "0"], ["run", "--manifest", "m", "--output", "o", "--maximum-files", "251"],
    ["run", "--manifest", "m", "--output", "o", "--maximum-minutes", "361"], ["run", "--manifest", "m", "--output", "o", "--per-session-timeout-seconds", "3601"]]) assert.throws(() => parseSessionSetArguments(args));
});

test("manifest accepts regular files and rejects schema, links, sources links, and duplicates", async (t) => {
  const directory = await temporary(t); const source = join(directory, "a.jsonl"); await writeFile(source, '{"type":"session","version":3}\n');
  const manifest = join(directory, "manifest.json"); await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sessions: [source] }));
  assert.equal((await loadExplicitManifest(manifest)).length, 1);
  await writeFile(manifest, JSON.stringify({ sessions: [source] })); await assert.rejects(loadExplicitManifest(manifest), /invalid-manifest/);
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sessions: [source, source] })); await assert.rejects(loadExplicitManifest(manifest), /duplicate-source/);
  const linkedSource = join(directory, "linked.jsonl"); await symlink(source, linkedSource);
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sessions: [linkedSource] })); await assert.rejects(loadExplicitManifest(manifest), /invalid-source/);
  const linkedManifest = join(directory, "linked-manifest.json"); await symlink(manifest, linkedManifest); await assert.rejects(loadExplicitManifest(linkedManifest), /invalid-manifest/);
});

test("selection applies threshold, fallback, limit, and anonymous stable IDs", () => {
  const files = [{ path: "/private/z.jsonl", size: 30 }, { path: "/private/a.jsonl", size: 10 }, { path: "/private/b.jsonl", size: 20 }];
  const selected = selectSessionFiles(files, { minimumBytes: 25, minimumCount: 2, maximumFiles: 2 });
  assert.deepEqual(selected.map((item: any) => [item.fixtureId, item.size]), [["fixture-001", 30], ["fixture-002", 20]]);
  assert.doesNotMatch(selected.map((item: any) => item.fixtureId).join(), /[a-f0-9]{8}/);
});

test("numeric distributions and aggregate quality are deterministic", () => {
  assert.deepEqual(distribution([1, 2, 3, 4]), { minimum: 1, p50: 3, p90: 4, maximum: 4 });
  const report = aggregateRows([{ fixtureId: "fixture-001", sourceBytes: 10, status: "ok", activeSourceTokens: 5, validationErrors: 0, exactRecoverySamples: 2, exactRecoverySuccesses: 2, ledgerIntegrityOk: true }]);
  assert.equal(report.fullBenchmarkCount, 1); assert.equal(report.quality.exactRecoverySuccesses, 2); assert.equal(report.fixtures[0].fixtureId, "fixture-001");
});

test("quality helpers count protected visibility and lossy source links without returning text", () => {
  const blocks = [{ protectedExact: true, exactText: "SENTINEL", id: "b" }];
  assert.deepEqual(protectedVisibility(blocks, "SENTINEL", (value: string) => value), { protectedSourceBlocks: 1, protectedVisibleBlocks: 1, protectedVisibilityRate: 1 });
  const coverage = lossySourceCoverage({ units: [{ selected: { level: "summary" }, sourceRefs: [{}] }, { selected: { level: "marker" }, sourceRefs: [] }, { selected: { level: "raw" }, sourceRefs: [] }] });
  assert.deepEqual(coverage, { lossySelectedUnits: 2, lossyUnitsWithSourceRefs: 1, lossyUnitsWithoutSourceRefs: 1 });
});

test("failure and memory gates map to bounded categories", () => {
  assert.equal(mapFailure(new Error("private path and text")), "unknown-failure"); assert.equal(mapFailure({}, true), "timeout");
  assert.equal(memoryGate(2 * 1024 ** 3, 100 * 1024 ** 3, 100 * 1024 ** 3).allowed, false);
});

test("full synthetic snapshot reports numeric quality and no private content", async (t) => {
  const directory = await temporary(t); const session = join(directory, "PRIVATE-NAME.jsonl");
  const entries = syntheticEntries(10); await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "PRIVATE-SESSION-ID" })}\n${entries.map(JSON.stringify).join("\n")}\n`);
  const row = await benchmarkSnapshot(session, "fixture-001", true); const output = JSON.stringify(row);
  assert.equal(row.fixtureId, "fixture-001"); assert.ok(["ok", "failed"].includes(row.status));
  assert.doesNotMatch(output, /PRIVATE-NAME|PRIVATE-SESSION-ID|Never publish private evidence|year-run|toolCallId|sourceContentHash/);
  if (row.status === "ok") { assert.equal(row.currentStateRefsChecked, row.currentStateRefsValid); assert.equal(row.exactRecoverySamples, row.exactRecoverySuccesses); assert.equal(row.lossyUnitsWithoutSourceRefs, 0); }
});

test("parent output is redacted, owner-only, cleans snapshots, and continues after failure", async (t) => {
  const directory = await temporary(t); const first = join(directory, "PRIVATE-FIRST.jsonl"); const second = join(directory, "PRIVATE-SECOND.jsonl");
  await writeFile(first, "one"); await writeFile(second, "two"); const manifest = join(directory, "manifest.json"); const output = join(directory, "report.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sessions: [first, second] }), { mode: 0o600 });
  let calls = 0;
  const report = await runSessionSet({ ...options(manifest, output), minimumCount: 2 }, {
    snapshot: async (source: string, target: string) => { await writeFile(target, await readFile(source)); return { ok: true, size: 3 }; },
    child: async (_snapshot: string, fixtureId: string) => (++calls === 1 ? { error: new Error("PRIVATE-FIRST") } : { row: { fixtureId, sourceBytes: 3, status: "ledger-only", failureCategory: "memory-gate", ledgerIntegrityOk: true } }),
  });
  assert.equal(report.fixtures.length, 2); assert.equal(report.failureCount, 1); assert.equal(report.ledgerOnlyCount, 1);
  const text = await readFile(output, "utf8"); assert.doesNotMatch(text, /PRIVATE-FIRST|PRIVATE-SECOND|\.jsonl|sourceContentHash/);
  assert.equal((await lstat(output)).mode & 0o077, 0);
});

test("total time stop prevents new child work", async (t) => {
  const directory = await temporary(t); const source = join(directory, "source.jsonl"); const manifest = join(directory, "manifest.json"); const output = join(directory, "report.json");
  await writeFile(source, "x"); await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sessions: [source] })); let childCalled = false; let calls = 0;
  const report = await runSessionSet(options(manifest, output), { now: () => calls++ === 0 ? 0 : 61_000, child: async () => { childCalled = true; } });
  assert.equal(report.fixtures[0].status, "skipped"); assert.equal(childCalled, false);
});

test("source change seam is skipped without starting a child", async (t) => {
  const directory = await temporary(t); const source = join(directory, "source.jsonl"); const manifest = join(directory, "manifest.json"); const output = join(directory, "report.json");
  await writeFile(source, "x"); await writeFile(manifest, JSON.stringify({ schemaVersion: 1, sessions: [source] })); let childCalled = false;
  const report = await runSessionSet(options(manifest, output), { snapshot: async () => ({ ok: false, size: 0 }), child: async () => { childCalled = true; } });
  assert.equal(report.fixtures[0].failureCategory, "source-changed"); assert.equal(childCalled, false);
});
