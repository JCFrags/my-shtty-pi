import assert from "node:assert/strict";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCausalMemory } from "../src/causal-memory.js";
import { compactEntries } from "../src/compactor.js";
import { createMemoryEvent, materializeMemoryEvents, type MemoryEvent } from "../src/memory-store.js";
import { applyRetentionGradient, assignRetentionGradient } from "../src/retention-gradient.js";
import { reduceStructuredJson } from "../src/reducers/json.js";
import { reduceTerminalOutput } from "../src/reducers/terminal.js";
import { buildLocalSearchIndex, searchLocalHistory } from "../src/search-index.js";
import { buildDeterministicSummaryRebase, decideRegularSummaryRebase } from "../src/summary-rebase.js";
import { emptyRetrievalFeedback, recordRetrievalFeedback, retentionSignalsFromFeedback } from "../src/telemetry.js";
import type { CandidateUnit, HistoricalBlock, SessionEntryLike } from "../src/types.js";
import { estimateTokensFromText } from "../src/utils.js";

function block(id: string, text: string, rawTokens = estimateTokensFromText(text), protectedExact = false): HistoricalBlock {
  return {
    id,
    entryId: id,
    entryIndex: Number(id.replace(/\D/g, "")) || 0,
    kind: "tool_result",
    label: "TOOL RESULT",
    exactText: text,
    rawTokens,
    sourceRefs: [{ entryId: id }],
    toolName: "unknown",
    isError: false,
    protectedExact,
    reproducible: true,
    unresolved: false,
    exactIdentifiers: [],
    attributes: {},
  };
}

function unit(source: HistoricalBlock): CandidateUnit {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    startEntryIndex: source.entryIndex,
    endEntryIndex: source.entryIndex,
    sourceRefs: source.sourceRefs,
    rawTokens: source.rawTokens,
    importance: 10,
    importanceReasons: [],
    protectedExact: source.protectedExact,
    candidates: [{
      id: `${source.id}:raw`,
      level: "raw",
      text: source.exactText,
      tokens: source.rawTokens,
      rawTokens: source.rawTokens,
      utility: 1,
      lossy: false,
      omissions: [],
      sourceRefs: source.sourceRefs,
      metadata: {},
    }],
    toolCallIds: [],
  };
}

test("retention gradient assigns approximately 10k hot and 75k warm source tokens with protected override", () => {
  const blocks = Array.from({ length: 100 }, (_, index) => block(`b${index}`, `routine ${index}`, 1_000, index === 0));
  const assignments = assignRetentionGradient(blocks);
  assert.equal([...assignments.values()].filter((assignment) => assignment.band === "hot").length, 10);
  assert.equal([...assignments.values()].filter((assignment) => assignment.band === "warm").length, 76, "75 age-band blocks plus one protected cold override");
  assert.equal([...assignments.values()].filter((assignment) => assignment.band === "cold").length, 14);
  assert.equal(assignments.get("b0")?.band, "warm");
  assert.equal(assignments.get("b0")?.ageOverridden, true);

  const applied = applyRetentionGradient(blocks.map(unit), blocks);
  const cold = applied.units.find((candidate) => candidate.id === "b1");
  assert.ok(cold?.candidates.some((candidate) => candidate.reducer === "cold-cue"));
  assert.ok(!applied.units.find((candidate) => candidate.id === "b0")?.candidates.some((candidate) => candidate.reducer === "cold-cue"));
});

test("retrieval misses, repeated queries, and recalled blocks refresh later retention", async () => {
  const entries: SessionEntryLike[] = Array.from({ length: 24 }, (_, index) => ({
    type: "message",
    id: `feedback-${index}`,
    parentId: index === 0 ? null : `feedback-${index - 1}`,
    message: { role: index % 2 === 0 ? "user" : "assistant", content: `${index === 0 ? "rare-retention-target " : ""}${"deterministic historical content ".repeat(35)}`, stopReason: "stop" },
  }));
  const blocks = parseHistoricalBlocks(entries);
  const target = blocks[0]!;
  let feedback = emptyRetrievalFeedback("generation-one");
  feedback = recordRetrievalFeedback(feedback, { generationHash: "generation-one", query: "missing phrase", resultCount: 0, retrievedTokens: 0 });
  feedback = recordRetrievalFeedback(feedback, { generationHash: "generation-two", query: "missing phrase", resultCount: 1, retrievedTokens: 80, blockIds: [target.id], resourceKeys: ["file:/repo/target.ts"] });
  const signals = retentionSignalsFromFeedback(feedback, blocks.map((candidate) => candidate.id));
  assert.equal(feedback.misses, 1);
  assert.equal(feedback.repeatedQueries, 1);
  assert.equal(signals.reuseByBlockId.get(target.id), 1);
  assert.ok((signals.noveltyByBlockId.get(target.id) ?? 0) > 0.5);

  const result = await compactEntries(entries, { config: { targetTokens: 2_000 }, retrievalFeedback: feedback });
  const targetPlan = result.details.plan.find((item) => item.unitId === target.id);
  assert.ok(targetPlan?.importanceReasons.some((reason) => reason.includes("reused 1 time")));
});

test("terminal and JSON reducers use plain bounded fallbacks while preserving important evidence and recovery counts", () => {
  const terminal = block("terminal1", Array.from({ length: 15 }, (_, index) => `routine-line-${index + 1}`).join("\n"));
  const reduced = reduceTerminalOutput({ block: terminal, maxTokens: 500, laterText: "" });
  assert.match(reduced.text, /routine-line-1/);
  assert.match(reduced.text, /routine-line-5/);
  assert.match(reduced.text, /routine-line-11/);
  assert.match(reduced.text, /routine-line-15/);
  assert.doesNotMatch(reduced.text, /routine-line-6\b/);
  assert.doesNotMatch(reduced.text, /routine-line-10\b/);
  assert.ok(reduced.omissions.some((notice) => (notice.omittedLines ?? 0) > 0));

  const failure = block("terminal2", `${Array.from({ length: 8 }, (_, index) => `poll ${index}`).join("\n")}\nERROR assertion expected=4 received=9\n${Array.from({ length: 8 }, (_, index) => `tail ${index}`).join("\n")}`);
  assert.match(reduceTerminalOutput({ block: failure, maxTokens: 500, laterText: "" }).text, /ERROR assertion expected=4 received=9/);

  const jsonBlock = block("json1", JSON.stringify({ status: "failed", error: "denied", records: Array.from({ length: 20 }, (_, id) => ({ id, value: `v${id}` })) }));
  const json = reduceStructuredJson({ block: jsonBlock, maxTokens: 500, laterText: "" });
  assert.ok(json);
  assert.match(json.text, /status: failed/);
  assert.match(json.text, /error: denied/);
  assert.doesNotMatch(json.text, /^\s*[{[]/);
  assert.ok(json.omissions.length > 0);
});

test("causal episodes create completion certificates and regular-summary rebase uses original history", () => {
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: "Implement the parser. Do not remove exact recovery." },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "npm test", cwd: "/repo", inputs: { revision: "abc" } },
        }],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "Tests: 12 passed, 0 failed" }],
        isError: false,
        details: { exitCode: 0 },
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "r1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Completed the parser. The focused tests passed 12/12 and exact recovery remains." }],
        stopReason: "stop",
      },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const model = buildCausalMemory(blocks);
  assert.equal(model.episodes.length, 1);
  assert.equal(model.episodes[0]?.open, false);
  assert.ok(model.episodes[0]?.certificate);
  assert.equal(model.commandLedger[0]?.state, "success");
  assert.ok(model.activeClosure.has(blocks[0]!.id));

  const compactions = Array.from({ length: 8 }, (_, index) => ({ type: "compaction", id: `c${index}`, parentId: index ? `c${index - 1}` : null, summary: "previous summary carried forward" })) as SessionEntryLike[];
  const decision = decideRegularSummaryRebase([...entries, ...compactions], "previous summary carried forward", { intervalGenerations: 8 });
  assert.equal(decision.rebase, true);
  const rebased = buildDeterministicSummaryRebase(blocks, model, 1_000);
  assert.match(rebased, /Rebuilt from normalized original history/);
  assert.match(rebased, /Do not remove exact recovery/);
  assert.doesNotMatch(rebased, /previous summary carried forward/);
});

test("deterministic long-run simulation preserves restrictions, current resources, memory promotion, search, and hundreds of compactions", async () => {
  const entries: SessionEntryLike[] = [
    { type: "message", id: "root-user", parentId: null, message: { role: "user", content: `Run for a year. Never publish private evidence. ${"Keep immutable JSONL and exact recovery. ".repeat(30)}` } },
  ];
  let parentId = "root-user";
  for (let index = 0; index < 36; index += 1) {
    const id = `seed-${index}`;
    entries.push({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "thinking", thinking: `Routine historical analysis ${index}. ${"Repeated low-value observation. ".repeat(30)}` }], stopReason: "toolUse" } });
    parentId = id;
  }
  const memoryEvents: MemoryEvent[] = [];
  let firstSummary: string | undefined;
  for (let generation = 1; generation <= 220; generation += 1) {
    if (generation % 20 === 0) {
      const userId = `task-user-${generation}`;
      entries.push({ type: "message", id: userId, parentId, message: { role: "user", content: `Task ${generation}: inspect /repo/src/year-run.ts revision r${generation}. Preserve the never-publish restriction.` } });
      parentId = userId;
      const callId = `call-${generation}`;
      const callEntry = `task-call-${generation}`;
      entries.push({ type: "message", id: callEntry, parentId, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "/repo/src/year-run.ts", revision: `r${generation}`, offset: 1, limit: 20 } }], stopReason: "toolUse" } });
      parentId = callEntry;
      const resultId = `task-result-${generation}`;
      entries.push({ type: "message", id: resultId, parentId, message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: `export const generation = ${generation};\n${"stable line\n".repeat(18)}` }], isError: false, details: { exitCode: 0 } } });
      parentId = resultId;
      const event = createMemoryEvent(memoryEvents, { action: "remember", timestamp: `2026-08-02T00:${String(generation / 20).padStart(2, "0")}:00.000Z`, turn: generation, sourceRef: `memory-tool:${generation}`, text: `Current year-run revision is r${generation}.`, scope: "year-run" });
      memoryEvents.push(event);
      memoryEvents.push(createMemoryEvent(memoryEvents, { action: "promote", memoryId: event.memoryId, timestamp: `2026-08-02T00:${String(generation / 20).padStart(2, "0")}:30.000Z`, turn: generation, sourceRef: `memory-tool:promote-${generation}` }));
      const blocks = parseHistoricalBlocks(entries);
      const index = buildLocalSearchIndex(blocks);
      const search = searchLocalHistory(index, "year-run current revision", { tokenBudget: 500 });
      assert.ok(search.hits.length > 0);
    }
    const result = await compactEntries(entries, { config: { targetTokens: 12_000, maxIndividualUnits: 80 } });
    firstSummary ??= result.summary;
    assert.match(result.summary, /Never publish private evidence/);
    assert.ok(result.renderedTokens <= 12_000);
    const compactionId = `compaction-${generation}`;
    entries.push({ type: "compaction", id: compactionId, parentId, summary: result.summary, firstKeptEntryId: parentId });
    parentId = compactionId;
  }
  const final = await compactEntries(entries, { config: { targetTokens: 12_000, maxIndividualUnits: 80 } });
  const memories = materializeMemoryEvents(memoryEvents);
  assert.equal(memories.status, "ready");
  assert.equal(memories.memories.filter((memory) => memory.state === "current").length, 11);
  assert.match(final.summary, /Never publish private evidence/);
  assert.doesNotMatch(final.summary, /# CHRONOCOMPACT MEMORY REPLAY[\s\S]*# CHRONOCOMPACT MEMORY REPLAY/, "generated compactions must not recursively dominate replay");
  assert.equal(final.details.generationHash, (await compactEntries(entries, { config: { targetTokens: 12_000, maxIndividualUnits: 80 } })).details.generationHash);
  assert.ok(firstSummary);
});
