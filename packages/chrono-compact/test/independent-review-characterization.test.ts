import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { capPlanToRecentSuffix } from "../src/compactor.js";
import { resolveExtensionSettings } from "../src/pi-extension.js";
import type { CandidateUnit, CompressionPlan, HistoricalBlock, RepresentationCandidate } from "../src/types.js";
import { validatePlan } from "../src/validate.js";


function rawCandidate(entryId: string): RepresentationCandidate {
  return { id: `${entryId}:raw`, level: "raw", text: entryId, tokens: 1, rawTokens: 1, utility: 1, lossy: false, omissions: [], sourceRefs: [{ entryId }], metadata: {} };
}
function planned(entryId: string, start: number, end: number): CandidateUnit & { selected: RepresentationCandidate } {
  const selected = rawCandidate(entryId);
  return { id: entryId, kind: "assistant_text", label: entryId, startEntryIndex: start, endEntryIndex: end, sourceRefs: selected.sourceRefs, rawTokens: 1, importance: 1, importanceReasons: [], protectedExact: false, candidates: [selected], toolCallIds: [], selected };
}
function sourceBlock(entryId: string, entryIndex: number): HistoricalBlock {
  return { id: entryId, entryId, entryIndex, kind: "assistant_text", label: entryId, exactText: entryId, rawTokens: 1, sourceRefs: [{ entryId }], protectedExact: false, reproducible: false, unresolved: false, exactIdentifiers: [], attributes: {} };
}

// These tests encode the required behavior. They intentionally fail at the review baseline.
test("hard replay cap never retains only one side of a tool interaction", () => {
  const call = { ...planned("call", 0, 0), toolCallIds: ["pair"], selected: { ...rawCandidate("call"), text: "call ".repeat(2_000), tokens: 2_500 } };
  const result = { ...planned("result", 1, 1), toolCallIds: ["pair"], selected: { ...rawCandidate("result"), text: "small result", tokens: 3 } };
  const after = { ...planned("after", 2, 2), selected: { ...rawCandidate("after"), text: "continue", tokens: 2 } };
  const original: CompressionPlan = { targetTokens: 500, estimatedTokens: 2_505, rawTokens: 2_505, units: [call, result, after], warnings: [] };
  const capped = capPlanToRecentSuffix(original, "generation", false, 200).plan;
  const refs = new Set(capped.units.flatMap((unit) => unit.sourceRefs.map((ref) => ref.entryId)));
  assert.equal(refs.has("call"), refs.has("result"), "the cap must keep both tool sides or omit both");
});

test("plan validation rejects nested source ranges but allows distinct blocks in one entry", () => {
  const blocks = Array.from({ length: 6 }, (_, index) => sourceBlock(`e${index}`, index));
  const nested: CompressionPlan = { targetTokens: 100, estimatedTokens: 2, rawTokens: 2, units: [planned("e0", 0, 5), planned("e3", 3, 4)], warnings: [] };
  assert.ok(validatePlan(nested, blocks).issues.some((issue) => issue.code === "chronology"));
  const sameEntry: CompressionPlan = { targetTokens: 100, estimatedTokens: 2, rawTokens: 2, units: [planned("e0", 0, 0), planned("e0", 0, 0)], warnings: [] };
  assert.equal(validatePlan(sameEntry, blocks).issues.some((issue) => issue.code === "chronology"), false);
});

test("legacy false regular-summary input cannot disable the required Pi summary", () => {
  assert.equal(resolveExtensionSettings({ hybridSummaryEnabled: false }).hybridSummaryEnabled, true);
});

test("compaction closes the value-worker gate before any summary or replay work", async () => {
  const source = await readFile(resolve("src/pi-extension.ts"), "utf8");
  const start = source.indexOf('pi.on("session_before_compact"');
  const body = source.slice(start, start + 500);
  assert.match(body, /valueWorkerCompactionGate\s*=\s*true/);
  assert.ok(body.indexOf("cancelValueWorker()") >= 0 && body.indexOf("cancelValueWorker()") < body.indexOf("cancelIncrementalWork"));
});

test("rollup-shadow benchmark compares a cloned extension response across the integration boundary", async () => {
  const benchmark = await readFile(resolve("scripts/benchmark-rollup-shadow.mjs"), "utf8");
  assert.doesNotMatch(benchmark, /hash\(current\.summary\)\s*===\s*before|hash\(current\.summary\)\s*===\s*currentHash/);
  assert.match(benchmark, /authoritativeResponseUnchanged/);
  assert.match(benchmark, /malicious/i);
});
