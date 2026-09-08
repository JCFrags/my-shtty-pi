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

function trackedBlocks(values: readonly HistoricalBlock[]): {
  readonly blocks: readonly HistoricalBlock[];
  readonly reset: () => void;
  readonly indexedReads: () => number;
} {
  let reads = 0;
  const blocks = new Proxy([...values], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { blocks, reset: () => { reads = 0; }, indexedReads: () => reads };
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

test("entry-level overlap expansion does not scan historical blocks per reference", () => {
  const history = Array.from({ length: 1_000 }, (_, index) => block({
    id: `entry-${index}:0`, entryId: `entry-${index}`, entryIndex: index, blockIndex: 0,
    kind: "assistant_text", exactText: `source ${index}`,
  }));
  const tracked = trackedBlocks(history);
  const index = buildValidationIndex(tracked.blocks);
  const units = Array.from({ length: 100 }, (_, value) => unit(candidate([{ entryId: `entry-${value * 10}` }]), {
    id: `unit-${value}`, startEntryIndex: value * 10, endEntryIndex: value * 10,
  }));
  tracked.reset();
  const report = validatePlan(plan(units), tracked.blocks, 1_000, { validationIndex: index });
  assert.equal(report.ok, true);
  assert.equal(tracked.indexedReads(), 0);
});

test("block-level validation uses exact lookup without scanning historical blocks", () => {
  const history = Array.from({ length: 1_000 }, (_, index) => block({
    id: `entry-${index}:0`, entryId: `entry-${index}`, entryIndex: index, blockIndex: 0,
    kind: "assistant_text", exactText: `source ${index}`,
  }));
  const tracked = trackedBlocks(history);
  const index = buildValidationIndex(tracked.blocks);
  const selected = candidate([{ entryId: "entry-500", blockIndex: 0 }]);
  tracked.reset();
  assert.equal(validatePlan(plan([unit(selected, { startEntryIndex: 500, endEntryIndex: 500 })]), tracked.blocks, 1_000, { validationIndex: index }).ok, true);
  assert.equal(tracked.indexedReads(), 0);
});

test("tool-pair coverage does not scan historical blocks per entry reference", () => {
  const history: HistoricalBlock[] = [];
  const units: ReturnType<typeof unit>[] = [];
  for (let pair = 0; pair < 200; pair += 1) {
    const callIndex = pair * 2;
    const resultIndex = callIndex + 1;
    history.push(
      block({ id: `call-${pair}:0`, entryId: `call-${pair}`, entryIndex: callIndex, blockIndex: 0, kind: "tool_call", exactText: "call", toolCallId: `tool-${pair}` }),
      block({ id: `result-${pair}:0`, entryId: `result-${pair}`, entryIndex: resultIndex, blockIndex: 0, kind: "tool_result", exactText: "result", toolCallId: `tool-${pair}` }),
    );
    if (pair >= 100) {
      const selected = candidate([{ entryId: `call-${pair}` }, { entryId: `result-${pair}` }]);
      units.push(unit(selected, { id: `pair-${pair}`, kind: "tool_result", startEntryIndex: callIndex, endEntryIndex: resultIndex }));
    }
  }
  const tracked = trackedBlocks(history);
  const index = buildValidationIndex(tracked.blocks);
  tracked.reset();
  const report = validatePlan(plan(units), tracked.blocks, 1_000, { validationIndex: index, allowOmittedPrefix: true });
  assert.equal(report.ok, true);
  assert.equal(tracked.indexedReads(), 0);
});

test("one validation index serves several large-reference plans without scans or mutation", () => {
  const history = Array.from({ length: 2_000 }, (_, index) => block({
    id: `entry-${index}:0`, entryId: `entry-${index}`, entryIndex: index, blockIndex: 0,
    kind: "assistant_text", exactText: `source ${index}`,
  }));
  const tracked = trackedBlocks(history);
  const index = buildValidationIndex(tracked.blocks);
  const before = [index.exactBlockByRef.size, index.firstBlockByEntry.size, index.validEntryIds.size, index.validExactSourceRefs.size];
  for (let pass = 0; pass < 3; pass += 1) {
    const units = Array.from({ length: 150 }, (_, value) => {
      const entryIndex = value * 10 + pass;
      return unit(candidate([{ entryId: `entry-${entryIndex}` }]), { id: `pass-${pass}-${value}`, startEntryIndex: entryIndex, endEntryIndex: entryIndex });
    });
    tracked.reset();
    assert.equal(validatePlan(plan(units), tracked.blocks, 1_000, { validationIndex: index }).ok, true);
    assert.equal(tracked.indexedReads(), 0);
  }
  assert.deepEqual([index.exactBlockByRef.size, index.firstBlockByEntry.size, index.validEntryIds.size, index.validExactSourceRefs.size], before);
});

test("indexed expansion preserves overlap and tool-pair validation semantics", () => {
  const call = block({ id: "call:0", entryId: "call", entryIndex: 0, blockIndex: 0, kind: "tool_call", exactText: "call", toolCallId: "pair" });
  const result = block({ id: "result:0", entryId: "result", entryIndex: 1, blockIndex: 0, kind: "tool_result", exactText: "result", toolCallId: "pair" });
  const multi = [
    block({ id: "multi:0", entryId: "multi", entryIndex: 2, blockIndex: 0, kind: "assistant_reasoning", exactText: "reason" }),
    block({ id: "multi:1", entryId: "multi", entryIndex: 2, blockIndex: 1, kind: "assistant_text", exactText: "answer" }),
  ];
  const blocks = [call, result, ...multi];
  const makeUnit = (id: string, refs: readonly SourceRef[], startEntryIndex: number, endEntryIndex = startEntryIndex) =>
    unit(candidate(refs), { id, startEntryIndex, endEntryIndex });

  const completePair = validatePlan(plan([
    makeUnit("call", [{ entryId: "call" }], 0),
    makeUnit("result", [{ entryId: "result", blockIndex: 0 }], 1),
  ]), blocks);
  assert.equal(completePair.ok, true);

  for (const refs of [[{ entryId: "call" }], [{ entryId: "result" }]] as const) {
    assert.ok(validatePlan(plan([makeUnit("partial", refs, refs[0].entryId === "call" ? 0 : 1)]), blocks)
      .issues.some((issue) => issue.code === "tool-pair-partial"));
  }

  const omittedPair = validatePlan(plan([makeUnit("multi", [{ entryId: "multi" }], 2)]), blocks, 1_000, { allowOmittedPrefix: true });
  assert.equal(omittedPair.ok, true);

  const sameEntryBlocks = validatePlan(plan([
    makeUnit("multi-0", [{ entryId: "multi", blockIndex: 0 }], 2),
    makeUnit("multi-1", [{ entryId: "multi", blockIndex: 1 }], 2),
  ]), blocks, 1_000, { allowOmittedPrefix: true });
  assert.equal(sameEntryBlocks.issues.some((issue) => issue.code === "source-overlap"), false);

  const merged = validatePlan(plan([makeUnit("merged", [
    { entryId: "multi", blockIndex: 0 }, { entryId: "multi", blockIndex: 1 },
  ], 2)]), blocks, 1_000, { allowOmittedPrefix: true });
  assert.equal(merged.ok, true);

  for (const overlapUnits of [
    [makeUnit("entry", [{ entryId: "multi" }], 2), makeUnit("block", [{ entryId: "multi", blockIndex: 1 }], 2)],
    [makeUnit("block", [{ entryId: "multi", blockIndex: 1 }], 2), makeUnit("entry", [{ entryId: "multi" }], 2)],
    [makeUnit("duplicate-1", [{ entryId: "multi", blockIndex: 0 }], 2), makeUnit("duplicate-2", [{ entryId: "multi", blockIndex: 0 }], 2)],
  ]) {
    assert.ok(validatePlan(plan(overlapUnits), blocks, 1_000, { allowOmittedPrefix: true })
      .issues.some((issue) => issue.code === "source-overlap"));
  }

  const nested = validatePlan(plan([
    makeUnit("outer", [{ entryId: "call" }], 0, 3),
    makeUnit("inner", [{ entryId: "multi", blockIndex: 0 }], 2),
  ]), blocks);
  assert.ok(nested.issues.some((issue) => issue.code === "chronology"));
  const partial = validatePlan(plan([
    makeUnit("left", [{ entryId: "call" }], 0, 2),
    makeUnit("right", [{ entryId: "result" }], 1, 3),
  ]), blocks);
  assert.ok(partial.issues.some((issue) => issue.code === "chronology"));
});

test("indexed and default validation reports match for plan structure failures", () => {
  const call = block({ id: "call", entryId: "call", entryIndex: 0, kind: "tool_call", exactText: "read file", toolCallId: "tool-1" });
  const result = block({ id: "result", entryId: "result", entryIndex: 1, kind: "tool_result", exactText: "file text", toolCallId: "tool-1" });
  const selected = candidate([{ entryId: "call" }]);
  assertEquivalent([call, result], plan([unit(selected)]), "tool-pair-partial");

  const first = unit(candidate([{ entryId: "result" }]), { id: "late", startEntryIndex: 1, endEntryIndex: 1 });
  const second = unit(candidate([{ entryId: "call" }]), { id: "early", startEntryIndex: 0, endEntryIndex: 0 });
  assertEquivalent([call, result], plan([first, second]), "chronology");

  const invalid = unit(candidate([{ entryId: "missing", blockIndex: 2 }]));
  assertEquivalent([call, result], plan([invalid]), "invalid-source-ref");
});
