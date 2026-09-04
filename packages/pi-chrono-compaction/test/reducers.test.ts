import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCandidateUnits } from "../src/candidates.js";
import { resolveCompactorConfig } from "../src/compactor.js";
import { getActiveBranch, readSessionJsonl } from "../src/jsonl.js";
import { mergeOldCompletedEpisodes, mergeRoutineActivitySegments } from "../src/episodes.js";
import { addRepeatedObservationCandidates } from "../src/repeated-observations.js";
import type { CandidateUnit, HistoricalBlock, SessionEntryLike } from "../src/types.js";
import { pruneUnsafeCandidates } from "../src/validate.js";

const fixture = resolve("test/fixtures/session.jsonl");

test("test and file-read reducers retain decisive evidence and report omissions", async () => {
  const session = await readSessionJsonl(fixture);
  const blocks = parseHistoricalBlocks(getActiveBranch(session));
  const config = resolveCompactorConfig({ targetTokens: 2_500, semanticMaxTokens: 180 });
  const units = await buildCandidateUnits(blocks, config);

  const failure = units.find((unit) => unit.id.startsWith("e124:tool_result"));
  assert.ok(failure);
  const testReduction = failure.candidates.find((candidate) => candidate.reducer === "test-output");
  assert.ok(testReduction);
  assert.match(testReduction.text, /Command: npm test -- timeout\.test\.ts/);
  assert.match(testReduction.text, /Exit code: 1/);
  assert.match(testReduction.text, /8 passed, 1 failed, 9 total/);
  assert.match(testReduction.text, /expected activeRequests=1/);
  assert.match(testReduction.text, /received activeRequests=3/);
  assert.ok(testReduction.omissions.length > 0);

  const fileRead = units.find((unit) => unit.id.startsWith("e122:tool_result"));
  assert.ok(fileRead);
  const fileReduction = fileRead.candidates.find((candidate) => candidate.reducer === "file-read");
  assert.ok(fileReduction);
  assert.match(fileReduction.text, /File: src\/server\/request-handler\.ts/);
  assert.match(fileReduction.text, /retryRequest/);
  assert.match(fileReduction.text, /prior attempt is not awaited or cancelled/);
  assert.match(fileReduction.text, /historical read; the current repository file may have changed/i);
  assert.ok(fileReduction.omissions.some((notice) => (notice.omittedLines ?? 0) > 500));
});

function completedEpisodeEntries(): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  let parentId: string | null = null;
  for (let turn = 0; turn < 6; turn += 1) {
    const userId = `u${turn}`;
    entries.push({
      type: "message",
      id: userId,
      parentId,
      message: { role: "user", content: [{ type: "text", text: `Investigate component ${turn} and report the result.` }] },
    });
    parentId = userId;
    const assistantId = `a${turn}`;
    entries.push({
      type: "message",
      id: assistantId,
      parentId,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Completed component ${turn}. The implementation was inspected, the focused check passed, and the result was recorded. `.repeat(18),
          },
        ],
      },
    });
    parentId = assistantId;
  }
  return entries;
}

test("older completed turns can merge into a chronological task episode", async () => {
  const blocks = parseHistoricalBlocks(completedEpisodeEntries());
  const config = resolveCompactorConfig({
    targetTokens: 900,
    mergeEpisodes: true,
    mergeBeforeFraction: 0.8,
    minEpisodeRawTokens: 200,
    maxEpisodeTokens: 180,
  });
  const units = await buildCandidateUnits(blocks, config);
  const merged = mergeOldCompletedEpisodes(units, blocks, config);
  assert.ok(merged.length < units.length);
  assert.ok(merged.some((unit) => unit.kind === "episode"));
  const episode = merged.find((unit) => unit.kind === "episode");
  assert.ok(episode);
  assert.ok(episode.sourceRefs.length >= 6);
  assert.ok(episode.candidates.every((candidate) => candidate.lossy && candidate.omissions.length > 0));
});


test("long unfinished routine activity collapses without merging protected evidence", () => {
  const blocks: HistoricalBlock[] = [];
  const units: CandidateUnit[] = [];
  for (let index = 0; index < 180; index += 1) {
    const entryId = `routine-${index}`;
    blocks.push({
      id: `${entryId}:assistant_reasoning:0`,
      entryId,
      entryIndex: index,
      blockIndex: 0,
      kind: "assistant_reasoning",
      label: "ASSISTANT REASONING",
      exactText: index === 20 ? "Command failed with exit code 2." : `Inspect routine component ${index}.`,
      rawTokens: 8,
      sourceRefs: [{ entryId, blockIndex: 0 }],
      protectedExact: false,
      reproducible: true,
      unresolved: false,
      exactIdentifiers: [],
      attributes: {},
      ...(index === 20 ? { isError: true } : {}),
    });
    units.push({
      id: `${entryId}:assistant_reasoning:0`,
      kind: "assistant_reasoning",
      label: "ASSISTANT REASONING",
      startEntryIndex: index,
      endEntryIndex: index,
      sourceRefs: [{ entryId, blockIndex: 0 }],
      rawTokens: 8,
      importance: 60,
      importanceReasons: [],
      protectedExact: index === 70,
      candidates: [{
        id: `${entryId}:raw`,
        level: "raw",
        text: index === 20 ? "Command failed with exit code 2." : `Inspect routine component ${index}.`,
        tokens: 8,
        rawTokens: 8,
        utility: 1,
        lossy: false,
        omissions: [],
        sourceRefs: [{ entryId, blockIndex: 0 }],
        metadata: {},
      }],
      toolCallIds: [],
    });
  }
  const config = resolveCompactorConfig({ targetTokens: 2_000, maxIndividualUnits: 60, maxEpisodeTokens: 140 });
  const segmented = mergeRoutineActivitySegments(units, blocks, config, 2_000);
  assert.ok(segmented.length < 80);
  assert.ok(segmented.some((unit) => unit.label === "ACTIVITY SEGMENT"));
  assert.ok(segmented.some((unit) => unit.id === "routine-70:assistant_reasoning:0"));
  const activity = segmented.filter((unit) => unit.label === "ACTIVITY SEGMENT");
  assert.ok(activity.every((unit) => unit.sourceRefs.length >= 2));
  assert.ok(activity.some((unit) => unit.candidates.some((candidate) => /routine-20: Command failed/.test(candidate.text))));
});

test("large tool calls have a small source-aware marker candidate", async () => {
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "tool-user",
      parentId: null,
      message: { role: "user", content: "Inspect the environment." },
    },
    {
      type: "message",
      id: "tool-assistant",
      parentId: "tool-user",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-large",
            name: "bash",
            arguments: { command: `printf start; ${"echo routine; ".repeat(200)}` },
          },
        ],
      },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 500 }));
  const toolCall = units.find((unit) => unit.kind === "tool_call");
  assert.ok(toolCall);
  const marker = toolCall.candidates.find((candidate) => candidate.reducer === "tool-call-marker");
  assert.ok(marker);
  assert.equal(marker.level, "marker");
  assert.match(marker.text, /Historical bash call/);
  assert.match(marker.text, /Detailed arguments omitted/);
  assert.ok(marker.tokens < toolCall.rawTokens);
});

test("failure words inside a file read do not become execution-failure evidence", async () => {
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "source-call",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "src/errors.ts" } }],
      },
    },
    {
      type: "message",
      id: "source-result",
      parentId: "source-call",
      message: {
        role: "toolResult",
        toolCallId: "read-source",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "export function fail() { throw new Error(\"expected failure\"); }" }],
      },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 500 }));
  const fileResult = units.find((unit) => unit.id.startsWith("source-result:tool_result"));
  assert.ok(fileResult);
  assert.ok(fileResult.importance < 100, `file-read importance was ${fileResult.importance}`);
});

test("failure words in successful generated terminal output do not become failure evidence", async () => {
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "map-call",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "search-maps", name: "bash", arguments: { command: "rg error dist/*.map" } }],
      },
    },
    {
      type: "message",
      id: "map-result",
      parentId: "map-call",
      message: {
        role: "toolResult",
        toolCallId: "search-maps",
        toolName: "bash",
        isError: false,
        details: { exitCode: 0 },
        content: [{ type: "text", text: "source.map: throw new Error('historical source string'); TODO: remaining unknown branch" }],
      },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 500 }));
  const terminalResult = units.find((unit) => unit.id.startsWith("map-result:tool_result"));
  assert.ok(terminalResult);
  assert.ok(terminalResult.importance < 100, `terminal importance was ${terminalResult.importance}`);
  const marker = terminalResult.candidates.find((candidate) => candidate.level === "marker");
  assert.ok(marker);
  assert.match(marker.text, /output appears machine-generated/);
  assert.doesNotMatch(marker.text, /throw new Error/);
});

test("generic retention policy words do not over-promote matching historical output", async () => {
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "hint-call",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "hint-read", name: "read", arguments: { path: "/tmp/critical.ts" } }],
      },
    },
    {
      type: "message",
      id: "hint-result",
      parentId: "hint-call",
      message: {
        role: "toolResult",
        toolCallId: "hint-read",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "Manual compaction must preserve unresolved failures in /tmp/critical.ts." }],
      },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const config = resolveCompactorConfig({ targetTokens: 500 });
  const baseline = await buildCandidateUnits(blocks, config);
  const generic = await buildCandidateUnits(blocks, config, undefined, undefined, "Preserve restrictions, failures, and unresolved work.");
  const specific = await buildCandidateUnits(blocks, config, undefined, undefined, "Preserve /tmp/critical.ts.");
  const baselineResult = baseline.find((unit) => unit.id.startsWith("hint-result:tool_result"));
  const genericResult = generic.find((unit) => unit.id.startsWith("hint-result:tool_result"));
  const specificResult = specific.find((unit) => unit.id.startsWith("hint-result:tool_result"));
  assert.ok(baselineResult && genericResult && specificResult);
  assert.equal(genericResult.importance, baselineResult.importance);
  assert.ok(specificResult.importance > baselineResult.importance);
});

test("restriction detection separates long quoted reference text from direct user instructions", async () => {
  const quotedRestriction = `Reference report: \"${"The implementation must preserve every record. ".repeat(20)}\" What do you think?`;
  const directRestriction = `${quotedRestriction} Do not change the public API.`;
  const quotedBlock = parseHistoricalBlocks([
    { type: "message", id: "quoted", parentId: null, message: { role: "user", content: quotedRestriction } },
  ])[0];
  const directBlock = parseHistoricalBlocks([
    { type: "message", id: "direct", parentId: null, message: { role: "user", content: directRestriction } },
  ])[0];
  assert.ok(quotedBlock && directBlock);
  assert.equal(quotedBlock.protectedExact, false);
  assert.equal(directBlock.protectedExact, true);

  const units = await buildCandidateUnits([directBlock], resolveCompactorConfig({ targetTokens: 500 }));
  const segmented = units[0]?.candidates.find((candidate) => candidate.reducer === "user-reference-segmentation");
  assert.ok(segmented);
  assert.match(segmented.text, /Do not change the public API\./);
  assert.doesNotMatch(segmented.text, /The implementation must preserve every record/);
  assert.equal(segmented.metadata.protectedDirectText, true);

  const directQuotedSpecification = `Use this exact required value and do not shorten it: \"${"required-setting=true;".repeat(30)}\"`;
  const specificationBlock = parseHistoricalBlocks([
    { type: "message", id: "specification", parentId: null, message: { role: "user", content: directQuotedSpecification } },
  ])[0];
  assert.ok(specificationBlock?.protectedExact);
  const specificationUnits = await buildCandidateUnits(
    [specificationBlock],
    resolveCompactorConfig({ targetTokens: 500 }),
  );
  assert.equal(
    specificationUnits[0]?.candidates.some((candidate) => candidate.reducer === "user-reference-segmentation"),
    false,
    "a direct quoted specification must remain raw",
  );
});

test("opaque image payloads are never mislabeled as fully exact text", async () => {
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "img-user",
      parentId: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot." },
          { type: "image", data: "ZmFrZS1pbWFnZS1ieXRlcw==", mimeType: "image/png" },
        ],
      },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const config = resolveCompactorConfig({ targetTokens: 600 });
  const units = await buildCandidateUnits(blocks, config);
  const raw = units[0]?.candidates.find((candidate) => candidate.level === "raw");
  assert.ok(raw);
  assert.equal(raw.lossy, true);
  assert.equal(raw.reducer, "opaque-image-reference");
  assert.ok(raw.omissions.some((notice) => /image bytes are not embedded/i.test(notice.description)));
  assert.match(raw.text, /\[IMAGE mimeType=image\/png/);
});

test("exact repeated observations keep one canonical body and add a source-aware marker", async () => {
  const repeated = `${Array.from({ length: 60 }, (_, index) => `result ${index}: stable`).join("\n")}\n`;
  const entries: SessionEntryLike[] = [
    {
      type: "message",
      id: "repeat-call-1",
      parentId: null,
      message: { role: "assistant", content: [{ type: "toolCall", id: "repeat-1", name: "read", arguments: { path: "src/repeat.ts" } }] },
    },
    {
      type: "message",
      id: "repeat-result-1",
      parentId: "repeat-call-1",
      message: { role: "toolResult", toolCallId: "repeat-1", toolName: "read", isError: false, content: repeated },
    },
    {
      type: "message",
      id: "repeat-call-2",
      parentId: "repeat-result-1",
      message: { role: "assistant", content: [{ type: "toolCall", id: "repeat-2", name: "read", arguments: { path: "src/repeat.ts" } }] },
    },
    {
      type: "message",
      id: "repeat-result-2",
      parentId: "repeat-call-2",
      message: { role: "toolResult", toolCallId: "repeat-2", toolName: "read", isError: false, content: repeated },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const units = addRepeatedObservationCandidates(built, blocks);
  const first = units.find((unit) => unit.id.startsWith("repeat-result-1:tool_result"));
  const second = units.find((unit) => unit.id.startsWith("repeat-result-2:tool_result"));
  assert.ok(first && second);
  assert.equal(first.candidates.some((candidate) => candidate.level === "marker"), false);
  const marker = second.candidates.find((candidate) => candidate.reducer === "exact-repeat");
  assert.ok(marker);
  assert.match(marker.text, /Canonical selected copy: history_get\("repeat-result-1"/);
  assert.ok(marker.tokens < second.rawTokens / 2);
  assert.equal(marker.metadata.canonicalEntryId, "repeat-result-1");
});

function repeatedTerminalEntries(
  prefix: string,
  options: { isError?: boolean; details?: Record<string, unknown> },
): SessionEntryLike[] {
  const content = Array.from({ length: 70 }, (_, index) => `result ${index}: repeated terminal evidence`).join("\n");
  return [1, 2].flatMap((occurrence): SessionEntryLike[] => [
    {
      type: "message",
      id: `${prefix}-call-${occurrence}`,
      parentId: null,
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: `${prefix}-${occurrence}`,
          name: "bash",
          arguments: { command: "npm test -- repeated-observation.test.ts" },
        }],
      },
    },
    {
      type: "message",
      id: `${prefix}-result-${occurrence}`,
      parentId: `${prefix}-call-${occurrence}`,
      message: {
        role: "toolResult",
        toolCallId: `${prefix}-${occurrence}`,
        toolName: "bash",
        ...(options.isError === undefined ? {} : { isError: options.isError }),
        details: options.details,
        content,
      },
    },
  ]);
}

function repeatedReducers(units: readonly CandidateUnit[]): string[] {
  return units.flatMap((unit) => unit.candidates.flatMap((candidate) =>
    candidate.reducer === "exact-repeat" || candidate.reducer === "observation-delta" ? [candidate.reducer] : []));
}

test("failed tool-result repeats never offer exact-repeat or observation-delta candidates", async () => {
  const blocks = parseHistoricalBlocks(repeatedTerminalEntries("failed", { isError: true }));
  const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const repeated = addRepeatedObservationCandidates(built, blocks);
  assert.deepEqual(repeatedReducers(repeated), []);
});

test("structured nonzero exit codes exclude nominally non-error terminal repeats", async () => {
  const blocks = parseHistoricalBlocks(repeatedTerminalEntries("exit-two", {
    isError: false,
    details: { exitCode: 2 },
  }));
  const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const repeated = addRepeatedObservationCandidates(built, blocks);
  assert.deepEqual(repeatedReducers(repeated), []);
});

test("terminal repeats require a positive exit fact", async () => {
  for (const [prefix, options, expectedIsError] of [
    ["unknown-absent", {}, undefined],
    ["unknown-explicit-false", { isError: false }, false],
  ] as const) {
    const blocks = parseHistoricalBlocks(repeatedTerminalEntries(prefix, options));
    const terminalBlocks = blocks.filter((block) => block.kind === "tool_result");
    assert.equal(terminalBlocks.length, 2);
    assert.ok(terminalBlocks.every((block) => block.isError === expectedIsError));
    const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
    const repeated = addRepeatedObservationCandidates(built, blocks);
    assert.deepEqual(repeatedReducers(repeated), [], `${prefix} observation received a repeat reducer`);
  }

  const successfulBlocks = parseHistoricalBlocks(repeatedTerminalEntries("known-success", {
    isError: false,
    details: { exitCode: 0 },
  }));
  const successfulBuilt = await buildCandidateUnits(successfulBlocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const successfulRepeated = addRepeatedObservationCandidates(successfulBuilt, successfulBlocks);
  assert.equal(repeatedReducers(successfulRepeated).filter((reducer) => reducer === "exact-repeat").length, 1);
});

test("cancelled and aborted observations never enter repeat or delta processing", async () => {
  for (const [prefix, details] of [
    ["cancelled", { cancelled: true }],
    ["aborted", { state: "aborted" }],
  ] as const) {
    const blocks = parseHistoricalBlocks(repeatedTerminalEntries(prefix, { isError: false, details }));
    const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
    const repeated = addRepeatedObservationCandidates(built, blocks);
    assert.deepEqual(repeatedReducers(repeated), [], `${prefix} observation received a repeat reducer`);
  }
});

test("unsafe-candidate pruning receives no failed repeat candidate to preserve", async () => {
  const blocks = parseHistoricalBlocks(repeatedTerminalEntries("pruned-failure", { isError: true }));
  const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const offered = addRepeatedObservationCandidates(built, blocks);
  const pruned = pruneUnsafeCandidates(offered, blocks);
  assert.deepEqual(repeatedReducers(offered), []);
  assert.deepEqual(repeatedReducers(pruned.units), []);
});

test("repeated file observations can retain a small exact changed-region delta", async () => {
  const stableHead = Array.from({ length: 12 }, (_, index) => `head ${index}: stable repeated source line`).join("\n");
  const stableTail = Array.from({ length: 12 }, (_, index) => `tail ${index}: stable repeated source line`).join("\n");
  const previous = `${stableHead}\nconst state = "old";\n${stableTail}`;
  const current = `${stableHead}\nconst state = "new decisive value";\n${stableTail}`;
  const entries: SessionEntryLike[] = [
    {
      type: "message", id: "delta-call-1", parentId: null,
      message: { role: "assistant", content: [{ type: "toolCall", id: "delta-1", name: "read", arguments: { path: "src/state.ts" } }] },
    },
    {
      type: "message", id: "delta-result-1", parentId: "delta-call-1",
      message: { role: "toolResult", toolCallId: "delta-1", toolName: "read", isError: false, content: previous },
    },
    {
      type: "message", id: "delta-call-2", parentId: "delta-result-1",
      message: { role: "assistant", content: [{ type: "toolCall", id: "delta-2", name: "read", arguments: { path: "src/state.ts" } }] },
    },
    {
      type: "message", id: "delta-result-2", parentId: "delta-call-2",
      message: { role: "toolResult", toolCallId: "delta-2", toolName: "read", isError: false, content: current },
    },
  ];
  const blocks = parseHistoricalBlocks(entries);
  const built = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 1_000 }));
  const units = addRepeatedObservationCandidates(built, blocks);
  const currentUnit = units.find((unit) => unit.id.startsWith("delta-result-2:tool_result"));
  assert.ok(currentUnit);
  const delta = currentUnit.candidates.find((candidate) => candidate.reducer === "observation-delta");
  assert.ok(delta);
  assert.match(delta.text, /const state = "new decisive value";/);
  assert.doesNotMatch(delta.text, /const state = "old";/);
  assert.equal(delta.metadata.stablePrefixLines, 12);
  assert.equal(delta.metadata.stableSuffixLines, 12);
  assert.ok(delta.tokens < currentUnit.rawTokens);
});
