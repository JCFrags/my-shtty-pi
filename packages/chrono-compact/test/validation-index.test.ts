import assert from "node:assert/strict";
import test from "node:test";
import type {
  CandidateUnit,
  CompressionPlan,
  HistoricalBlock,
  RepresentationCandidate,
  SourceRef,
} from "../src/types.js";
import {
  buildValidationIndex,
  sourceTextForCandidate,
  validatePlan,
} from "../src/validate.js";

function block(overrides: Partial<HistoricalBlock> & Pick<HistoricalBlock, "id" | "entryId" | "entryIndex" | "kind" | "exactText">): HistoricalBlock {
  return {
    label: overrides.kind,
    rawTokens: Math.max(1, Math.ceil(overrides.exactText.length / 4)),
    sourceRefs: [{ entryId: overrides.entryId, ...(overrides.blockIndex === undefined ? {} : { blockIndex: overrides.blockIndex }) }],
    protectedExact: false,
    reproducible: false,
    unresolved: false,
    exactIdentifiers: [],
    attributes: {},
    ...overrides,
  };
}

function candidate(sourceRefs: readonly SourceRef[], overrides: Partial<RepresentationCandidate> = {}): RepresentationCandidate {
  return {
    id: "candidate",
    level: "raw",
    text: "source text",
    tokens: 3,
    rawTokens: 3,
    utility: 1,
    lossy: false,
    omissions: [],
    sourceRefs,
    metadata: {},
    ...overrides,
  };
}

function unit(selected: RepresentationCandidate, overrides: Partial<CandidateUnit> = {}): CandidateUnit & { selected: RepresentationCandidate } {
  return {
    id: "unit",
    kind: "assistant_text",
    label: "unit",
    startEntryIndex: 0,
    endEntryIndex: 0,
    sourceRefs: selected.sourceRefs,
    rawTokens: selected.rawTokens,
    importance: 1,
    importanceReasons: [],
    protectedExact: false,
    candidates: [selected],
    toolCallIds: [],
    selected,
    ...overrides,
  };
}

function plan(units: readonly ReturnType<typeof unit>[]): CompressionPlan {
  return { targetTokens: 1_000, estimatedTokens: 10, rawTokens: 20, units, warnings: [] };
}

function reports(blocks: readonly HistoricalBlock[], value: CompressionPlan) {
  const index = buildValidationIndex(blocks);
  return {
    defaultReport: validatePlan(value, blocks),
    indexedReport: validatePlan(value, blocks, value.targetTokens, { validationIndex: index }),
    reusedReport: validatePlan(value, blocks, value.targetTokens, { validationIndex: index }),
  };
}

function assertEquivalent(blocks: readonly HistoricalBlock[], value: CompressionPlan, expectedCode?: string): void {
  const result = reports(blocks, value);
  assert.deepEqual(result.indexedReport, result.defaultReport);
  assert.deepEqual(result.reusedReport, result.defaultReport);
  if (expectedCode) assert.ok(result.defaultReport.issues.some((issue) => issue.code === expectedCode));
}

const multiBlocks = [
  block({ id: "assistant:0", entryId: "assistant", entryIndex: 0, blockIndex: 0, kind: "assistant_reasoning", exactText: "first assistant block" }),
  block({ id: "assistant:1", entryId: "assistant", entryIndex: 0, blockIndex: 1, kind: "assistant_text", exactText: "second assistant block" }),
  block({ id: "later:0", entryId: "later", entryIndex: 1, blockIndex: 0, kind: "assistant_text", exactText: "later block" }),
];

test("validation index preserves exact, entry-level, multi-reference, repeated, and source-reference order behavior", () => {
  const index = buildValidationIndex(multiBlocks);
  assert.equal(sourceTextForCandidate(candidate([{ entryId: "assistant", blockIndex: 1 }]), index), "second assistant block");
  assert.equal(sourceTextForCandidate(candidate([{ entryId: "assistant" }]), index), "first assistant block");
  assert.equal(
    sourceTextForCandidate(candidate([
      { entryId: "later", blockIndex: 0 },
      { entryId: "assistant", blockIndex: 1 },
      { entryId: "later", blockIndex: 0 },
    ]), index),
    "later block\nsecond assistant block\nlater block",
  );
  const merged = candidate([{ entryId: "assistant", blockIndex: 0 }, { entryId: "later", blockIndex: 0 }]);
  assertEquivalent(multiBlocks, plan([unit(merged, { endEntryIndex: 1 })]));
});

test("indexed and default validation reports match for protected and semantic failures", () => {
  const protectedBlock = block({ id: "protected", entryId: "protected", entryIndex: 0, kind: "user", exactText: "Never publish evidence.", protectedExact: true });
  const protectedCandidate = candidate([{ entryId: "protected" }], { level: "semantic", text: "Do not publish.", lossy: true, omissions: [{ description: "shortened" }] });
  assertEquivalent([protectedBlock], plan([unit(protectedCandidate, { protectedExact: true })]), "protected-exact");

  const semanticBlock = block({ id: "semantic", entryId: "semantic", entryIndex: 0, kind: "assistant_text", exactText: "Use Existing.value with 12 files and the phrase known source quote." });
  for (const [text, code] of [
    ["Use Invented.value.", "unsupported-identifier"],
    ["Use Existing.value and \"invented source quote\".", "unsupported-quote"],
    ["Use Existing.value with 99 files.", "unsupported-number"],
  ] as const) {
    const selected = candidate([{ entryId: "semantic" }], { level: "semantic", reducer: "llm-semantic", text, lossy: true, omissions: [{ description: "compressed" }] });
    assertEquivalent([semanticBlock], plan([unit(selected)]), code);
  }
});

test("indexed and default validation reports match for unresolved and failed source state", () => {
  const unresolved = block({ id: "open", entryId: "open", entryIndex: 0, kind: "assistant_text", exactText: "Work remains unresolved.", unresolved: true });
  const completed = candidate([{ entryId: "open" }], { level: "semantic", text: "Work completed successfully.", lossy: true, omissions: [{ description: "compressed" }] });
  assertEquivalent([unresolved], plan([unit(completed)]), "unresolved-became-complete");

  const failure = block({ id: "failed", entryId: "failed", entryIndex: 0, kind: "tool_result", exactText: "ERROR operation failed", isError: true });
  const success = candidate([{ entryId: "failed" }], { level: "semantic", text: "Operation completed successfully.", lossy: true, omissions: [{ description: "compressed" }] });
  assertEquivalent([failure], plan([unit(success)]), "failure-became-success");
});

test("indexed and default validation reports match for plan structure failures", () => {
  const call = block({ id: "call", entryId: "call", entryIndex: 0, kind: "tool_call", exactText: "read file", toolCallId: "tool-1" });
  const result = block({ id: "result", entryId: "result", entryIndex: 1, kind: "tool_result", exactText: "file text", toolCallId: "tool-1" });
  const selected = candidate([{ entryId: "call" }]);
  assertEquivalent([call, result], plan([unit(selected)]), "tool-pair-missing");

  const first = unit(candidate([{ entryId: "result" }]), { id: "late", startEntryIndex: 1, endEntryIndex: 1 });
  const second = unit(candidate([{ entryId: "call" }]), { id: "early", startEntryIndex: 0, endEntryIndex: 0 });
  assertEquivalent([call, result], plan([first, second]), "chronology");

  const invalid = unit(candidate([{ entryId: "missing", blockIndex: 2 }]));
  assertEquivalent([call, result], plan([invalid]), "invalid-source-ref");
});
