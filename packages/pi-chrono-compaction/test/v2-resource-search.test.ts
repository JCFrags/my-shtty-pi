import assert from "node:assert/strict";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCandidateUnits } from "../src/candidates.js";
import { compactEntries, resolveCompactorConfig } from "../src/compactor.js";
import { recallHistory, renderRecall } from "../src/recall.js";
import {
  addNearDuplicateFactoringCandidates,
  applyResourceEvolutionCandidates,
  buildResourceLineage,
  factorNearDuplicateTemplate,
} from "../src/resource-lineage.js";
import { buildCausalMemory } from "../src/causal-memory.js";
import { addRepeatedObservationCandidates } from "../src/repeated-observations.js";
import { buildLocalSearchIndex, renderRankedSearch, searchLocalHistory } from "../src/search-index.js";
import { estimateTokensFromText } from "../src/utils.js";
import { pruneUnsafeCandidates } from "../src/validate.js";
import type { SessionEntryLike } from "../src/types.js";

function assistantCall(id: string, parentId: string | null, callId: string, path: string, revision: string | undefined, offset: number, limit: number): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-02T00:${id.slice(-2).padStart(2, "0")}:00.000Z`,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read", arguments: { path, ...(revision === undefined ? {} : { revision }), offset, limit } }],
      stopReason: "toolUse",
    },
  };
}

function toolResult(id: string, parentId: string, callId: string, text: string, isError = false): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-08-02T01:${id.slice(-2).padStart(2, "0")}:00.000Z`,
    message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text }], isError, details: { exitCode: isError ? 1 : 0 } },
  };
}

function sourceLines(start: number, end: number, version = "v1"): string {
  return Array.from({ length: end - start + 1 }, (_, index) => `export const line${start + index} = "${version}-${start + index}";`).join("\n");
}

function resourceEntries(): SessionEntryLike[] {
  return [
    { type: "message", id: "u00", parentId: null, timestamp: "2026-08-02T00:00:00.000Z", message: { role: "user", content: "Inspect /repo/src/resource-controller.ts. Do not publish anything." } },
    assistantCall("a01", "u00", "read-1", "/repo/src/resource-controller.ts", "r1", 1, 10),
    toolResult("r02", "a01", "read-1", sourceLines(1, 10)),
    assistantCall("a03", "r02", "read-2", "/repo/src/resource-controller.ts", "r1", 1, 20),
    toolResult("r04", "a03", "read-2", sourceLines(1, 20)),
    assistantCall("a05", "r04", "read-3", "/repo/src/resource-controller.ts", "r2", 1, 20),
    toolResult("r06", "a05", "read-3", `${sourceLines(1, 9)}\nexport const line10 = "v2-corrected";\n${sourceLines(11, 20, "v2")}`),
    { type: "message", id: "u07", parentId: "r06", timestamp: "2026-08-02T02:07:00.000Z", message: { role: "user", content: "The correction is current. Keep the old revision only for rollback evidence." } },
    assistantCall("a08", "u07", "read-error", "/repo/src/missing-resource.ts", "r1", 1, 10),
    toolResult("r09", "a08", "read-error", "Error: file not found", true),
  ];
}

test("resource lineage unions overlapping reads and removes obsolete full snapshots", async () => {
  const blocks = parseHistoricalBlocks(resourceEntries());
  const lineage = buildResourceLineage(blocks);
  const resource = [...lineage.resources.values()].find((candidate) => candidate.displayName === "/repo/src/resource-controller.ts");
  assert.ok(resource);
  assert.equal(resource.versions.length, 2);
  assert.equal(resource.versions[0]?.unionRanges[0]?.start, 1);
  assert.equal(resource.versions[0]?.unionRanges[0]?.end, 20);
  assert.equal(resource.versions[0]?.superseded, true);
  assert.equal(resource.versions[1]?.superseded, false);

  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_500 }));
  const evolved = applyResourceEvolutionCandidates(units, blocks, lineage);
  const firstRead = evolved.find((unit) => unit.id.startsWith("r02:tool_result"));
  const coveringRead = evolved.find((unit) => unit.id.startsWith("r04:tool_result"));
  const latestRead = evolved.find((unit) => unit.id.startsWith("r06:tool_result"));
  assert.ok(firstRead && coveringRead && latestRead);
  assert.deepEqual(firstRead.candidates.map((candidate) => candidate.reducer), ["superseded-resource-version"]);
  assert.ok((firstRead.candidates[0]?.utility ?? 0) > 0.74);
  assert.deepEqual(coveringRead.candidates.map((candidate) => candidate.reducer), ["superseded-resource-version"]);
  assert.ok(latestRead.candidates.some((candidate) => candidate.level === "raw"));
  assert.ok(!firstRead.candidates.some((candidate) => candidate.text.includes(sourceLines(1, 10))));
});

test("normal Pi reads without synthetic revisions union compatible ranges and detect conflicting overlaps", async () => {
  const entries: SessionEntryLike[] = [
    assistantCall("n01", null, "normal-1", "/repo/src/normal.ts", undefined, 1, 10),
    toolResult("n02", "n01", "normal-1", sourceLines(1, 10)),
    assistantCall("n03", "n02", "normal-2", "/repo/src/normal.ts", undefined, 1, 20),
    toolResult("n04", "n03", "normal-2", sourceLines(1, 20)),
  ];
  const blocks = parseHistoricalBlocks(entries);
  const lineage = buildResourceLineage(blocks);
  const resource = [...lineage.resources.values()].find((candidate) => candidate.displayName === "/repo/src/normal.ts");
  assert.ok(resource);
  assert.equal(resource.versions.length, 1);
  assert.deepEqual(resource.versions[0]?.unionRanges, [{ start: 1, end: 20 }]);
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const evolved = applyResourceEvolutionCandidates(units, blocks, lineage);
  assert.deepEqual(evolved.find((unit) => unit.id.startsWith("n02:tool_result"))?.candidates.map((candidate) => candidate.reducer), ["overlapping-read-union"]);

  const changed = buildResourceLineage(parseHistoricalBlocks([
    ...entries,
    assistantCall("n05", "n04", "normal-3", "/repo/src/normal.ts", undefined, 5, 4),
    toolResult("n06", "n05", "normal-3", sourceLines(5, 8, "changed")),
  ]));
  assert.equal([...changed.resources.values()].find((candidate) => candidate.displayName === "/repo/src/normal.ts")?.versions.length, 2);
});

test("resource lineage recognizes every supported class from structured source evidence", () => {
  const cases: Array<{ name: string; args: Record<string, unknown>; kind: string }> = [
    { name: "read", args: { path: "/repo/source.ts" }, kind: "file" },
    { name: "read", args: { path: "/repo/evidence/report.md" }, kind: "evidence" },
    { name: "web_read", args: { url: "https://example.invalid/reference" }, kind: "url" },
    { name: "bash", args: { command: "printf ok" }, kind: "command" },
    { name: "bash", args: { command: "npm test" }, kind: "test" },
    { name: "bash", args: { command: "systemctl status chrono" }, kind: "service" },
    { name: "bash", args: { command: "git config --get user.name" }, kind: "setting" },
    { name: "bash", args: { command: "npm view pi-chrono-compact version" }, kind: "package" },
    { name: "process_status", args: { name: "build-worker" }, kind: "process" },
    { name: "agent_status", args: { agent: "review-worker" }, kind: "agent" },
  ];
  const entries: SessionEntryLike[] = [];
  cases.forEach((item, index) => {
    const callId = `class-call-${index}`;
    const assistantId = `class-a-${index}`;
    entries.push({
      type: "message",
      id: assistantId,
      parentId: null,
      message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: item.name, arguments: item.args }], stopReason: "toolUse" },
    });
    entries.push({
      type: "message",
      id: `class-r-${index}`,
      parentId: assistantId,
      message: { role: "toolResult", toolCallId: callId, toolName: item.name, content: [{ type: "text", text: `observed ${item.kind}` }], isError: false },
    });
  });
  const lineage = buildResourceLineage(parseHistoricalBlocks(entries));
  assert.deepEqual(new Set([...lineage.resources.values()].map((resource) => resource.kind)), new Set(cases.map((item) => item.kind)));
});

test("repeat processing keeps marker-only obsolete resources valid", async () => {
  const entries: SessionEntryLike[] = [
    { type: "message", id: "du00", parentId: null, message: { role: "user", content: "Inspect the resource." } },
    assistantCall("da01", "du00", "duplicate-1", "/repo/src/duplicate.ts", "r1", 1, 10),
    toolResult("dr02", "da01", "duplicate-1", sourceLines(1, 10)),
    assistantCall("da03", "dr02", "duplicate-2", "/repo/src/duplicate.ts", "r1", 1, 10),
    toolResult("dr04", "da03", "duplicate-2", sourceLines(1, 10)),
    assistantCall("da05", "dr04", "duplicate-3", "/repo/src/duplicate.ts", "r2", 1, 10),
    toolResult("dr06", "da05", "duplicate-3", sourceLines(1, 10, "v2")),
  ];
  const blocks = parseHistoricalBlocks(entries);
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_500 }));
  const evolved = applyResourceEvolutionCandidates(units, blocks);
  const first = evolved.find((unit) => unit.id.startsWith("dr02:tool_result"));
  assert.ok(first && first.candidates.every((candidate) => candidate.level === "marker"));
  const repeated = addRepeatedObservationCandidates(evolved, blocks);
  assert.ok((repeated.find((unit) => unit.id === first.id)?.candidates.length ?? 0) > 0);
  assert.doesNotThrow(() => pruneUnsafeCandidates(repeated, blocks));
});

test("near-duplicate template factoring is stronger than exact hashes and reconstructs every source", () => {
  const texts = [
    "test worker completed with exit=0 and 42 checks; duration=120ms; all artifacts stable",
    "test worker completed with exit=0 and 42 checks; duration=121ms; all artifacts stable",
    "test worker completed with exit=0 and 42 checks; duration=122ms; all artifacts stable",
  ];
  const factored = factorNearDuplicateTemplate(texts);
  assert.ok(factored);
  assert.ok(factored.similarity >= 0.7);
  assert.deepEqual(factored.substitutions.map((value) => factored.template.replace("{{VALUE}}", value)), texts);
});

test("near-duplicate factoring is connected to candidate and compactor paths", async () => {
  const entries: SessionEntryLike[] = [{ type: "message", id: "f00", parentId: null, message: { role: "user", content: "Run the repeated local test. Keep exact recovery." } }];
  let parent = "f00";
  for (let index = 0; index < 3; index += 1) {
    const call = `f-call-${index}`;
    const assistant = `f-a-${index}`;
    const result = `f-r-${index}`;
    entries.push({ type: "message", id: assistant, parentId: parent, message: { role: "assistant", content: [{ type: "toolCall", id: call, name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse" } });
    entries.push({ type: "message", id: result, parentId: assistant, message: { role: "toolResult", toolCallId: call, toolName: "bash", content: [{ type: "text", text: `test worker completed with exit=0 and 42 checks; duration=${120 + index}ms; ${"all artifacts stable and exact recovery remains. ".repeat(30)}` }], isError: false, details: { exitCode: 0 } } });
    parent = result;
  }
  const blocks = parseHistoricalBlocks(entries);
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 500 }));
  const factored = addNearDuplicateFactoringCandidates(units, blocks);
  assert.equal(factored.filter((unit) => unit.candidates.some((candidate) => candidate.reducer === "near-duplicate-template")).length, 3);
  const result = await compactEntries(entries, { config: { targetTokens: 500, recentExactBiasFraction: 0 } });
  assert.ok(result.plan.units.some((unit) => unit.selected.reducer === "near-duplicate-template"));
  assert.match(result.summary, /Factored near-duplicate observation/);
});

test("ranked search covers BM25, exact, regex, fuzzy paths, filters, version state, diversity, and staged recall", () => {
  const blocks = parseHistoricalBlocks(resourceEntries());
  const index = buildLocalSearchIndex(blocks);
  const ranked = searchLocalHistory(index, "correction rollback evidence", { mode: "ranked", tokenBudget: 600 });
  assert.ok(ranked.hits.length > 0);
  assert.equal(ranked.hits[0]?.sourceRef.entryId, "u07");
  assert.ok(ranked.returnedTokens <= 600);

  const exact = searchLocalHistory(index, "Do not publish anything", { mode: "exact" });
  assert.equal(exact.hits[0]?.sourceRef.entryId, "u00");
  const regex = searchLocalHistory(index, "v2-corrected|file not found", { mode: "regex", filters: { error: true } });
  assert.ok(regex.hits.every((hit) => hit.sourceRef.entryId === "r09"));

  const fuzzy = searchLocalHistory(index, "resorce-controller.ts", { mode: "ranked", fuzzyPath: true });
  assert.ok(fuzzy.hits.some((hit) => hit.snippet.includes("resource-controller.ts")));

  const superseded = searchLocalHistory(index, "v1-10", { mode: "ranked", filters: { currentState: "superseded" } });
  assert.ok(superseded.hits.some((hit) => hit.resourceState === "superseded"));
  const currentOnly = searchLocalHistory(index, "v2-corrected", { mode: "ranked", filters: { currentState: "current" } });
  assert.ok(currentOnly.hits.some((hit) => hit.resourceState === "current"));

  const cached = searchLocalHistory(index, "correction rollback evidence", { mode: "ranked", tokenBudget: 600 });
  assert.equal(cached.cacheHit, true);
  const oversized = searchLocalHistory(buildLocalSearchIndex(parseHistoricalBlocks([{
    type: "message",
    id: "budget-user",
    parentId: null,
    message: { role: "user", content: `unique-budget-needle ${"long search result content ".repeat(100)}` },
  }])), "unique-budget-needle", { stage: "snippets", limit: 1, tokenBudget: 120 });
  assert.ok(oversized.hits.length === 1);
  const oversizedRendered = renderRankedSearch(oversized);
  assert.ok(estimateTokensFromText(oversizedRendered) <= 120);
  assert.equal(oversized.returnedTokens, estimateTokensFromText(oversizedRendered));
  const neighborEntries: SessionEntryLike[] = [
    { type: "message", id: "neighbor-1", parentId: null, message: { role: "assistant", content: `before ${"large context ".repeat(80)}`, stopReason: "stop" } },
    { type: "message", id: "neighbor-2", parentId: "neighbor-1", message: { role: "assistant", content: `neighbor-budget-needle ${"large match ".repeat(80)}`, stopReason: "stop" } },
    { type: "message", id: "neighbor-3", parentId: "neighbor-2", message: { role: "assistant", content: `after ${"large context ".repeat(80)}`, stopReason: "stop" } },
  ];
  const withNeighbors = searchLocalHistory(buildLocalSearchIndex(parseHistoricalBlocks(neighborEntries)), "neighbor-budget-needle", {
    stage: "snippets",
    limit: 1,
    tokenBudget: 120,
    includeNeighbors: true,
  });
  const neighborsRendered = renderRankedSearch(withNeighbors);
  assert.ok(estimateTokensFromText(neighborsRendered) <= 120);
  assert.equal(withNeighbors.returnedTokens, estimateTokensFromText(neighborsRendered));
  const model = buildCausalMemory(blocks, index.resourceLineage);
  const cues = recallHistory(index, model, "resource controller", { level: "cue", tokenBudget: 500 });
  const resources = recallHistory(index, model, "resource controller", { level: "resource", tokenBudget: 1_200 });
  assert.ok(cues.items.length > 0);
  assert.ok(resources.items.some((item) => item.level === "resource" && /Versions: 2/.test(item.text)));
  for (const level of ["cue", "episode", "resource", "block"] as const) {
    const boundedRecall = recallHistory(index, model, "resource controller", { level, tokenBudget: 120 });
    const rendered = renderRecall(boundedRecall);
    assert.ok(estimateTokensFromText(rendered) <= 120, `${level} recall exceeded its complete response budget`);
    assert.equal(boundedRecall.renderedTokens, estimateTokensFromText(rendered));
  }
});
