import assert from "node:assert/strict";
import test from "node:test";
import {
  composeShadowContext,
  composeStoredSelection,
  SHADOW_COMPOSER_LIMITS,
  type ComposerSelectionRow,
  type ShadowComposerInput,
} from "../src/context-composer.js";
import type { ScopedBodySourceRef } from "../src/capsule-contract.js";
import type { EpisodeStateSelection, EpisodeStateSelectionItem } from "../src/episode-state-contract.js";

function row(
  id: string,
  text: string,
  startSeq: number,
  importance: number,
  kind: ComposerSelectionRow["kind"] = "capsule",
  authority: ComposerSelectionRow["authority"] = "derived",
  status: ComposerSelectionRow["status"] = "resolved",
): ComposerSelectionRow {
  return {
    id,
    text,
    startSeq,
    endSeq: startSeq,
    recovery: `opaque:${id}`,
    kind,
    authority,
    status,
    importance,
  };
}

const regularPiSummary = "  PI SUMMARY BYTES MUST STAY EXACT\nincluding this final line.  \n";
const fixture: ShadowComposerInput = {
  regularPiSummary,
  combinedCeilingTokens: 2_500,
  cut: {
    sourceCutEntryId: "prefix-end",
    sourceCutSeq: 40,
    firstKeptEntryId: "raw-tail-start",
    firstKeptSeq: 41,
    rawTailTokens: 400,
    toolPairSafe: true,
  },
  memory: {
    generation: "memory-7",
    representedStartSeq: 1,
    representedEndSeq: 40,
    committed: true,
  },
  rollups: {
    generation: "rollup-3",
    representedStartSeq: 1,
    representedEndSeq: 40,
    complete: true,
  },
  mandatoryCoverage: { protectedComplete: true, openWorkComplete: true },
  selected: {
    protected: [row("restriction", "Never publish this preview.", 4, 1, "restriction", "exact", "current")],
    openWork: [row("open", "Composer integration remains open.", 32, 1, "open-work", "derived", "unresolved")],
    recent: [
      row("recent-high", "Later high-importance event.", 30, 1),
      row("recent-low", "Earlier low-importance event.", 20, 0.05),
    ],
    older: [row("older", "Older rollup detail.", 8, 0.8, "rollup")],
  },
  delta: { records: [], completeThroughCut: true },
};

test("bounded shadow composition preserves Pi bytes and source order, keeps historical rollup lag separate from current-state coverage", () => {
  const composed = composeShadowContext(fixture);
  assert.equal(composed.status, "composed");
  assert.equal(composed.degradation, "committed-plus-delta");
  assert.equal(composed.firstKeptEntryId, "raw-tail-start");
  const summaryAt = composed.text.indexOf(regularPiSummary);
  assert.notEqual(summaryAt, -1);
  assert.equal(composed.text.slice(summaryAt, summaryAt + regularPiSummary.length), regularPiSummary);
  assert.ok(composed.text.indexOf("Older rollup detail.") < composed.text.indexOf("Earlier low-importance event."));
  assert.ok(composed.text.indexOf("Earlier low-importance event.") < composed.text.indexOf("Later high-importance event."));
  assert.ok(composed.envelope.combinedTokens <= fixture.combinedCeilingTokens);
  assert.equal(composed.envelope.memoryLag, 0);
  assert.deepEqual(composed.envelope.rollupRepresentedRange, [1, 40]);
  assert.equal("selectedRows" in composed.envelope, false, "the Pi envelope must not contain detailed selection arrays");

  const lagged = composeShadowContext({
    ...fixture,
    rollups: { ...fixture.rollups!, representedEndSeq: 12 },
  });
  assert.equal(lagged.degradation, "committed-plus-delta");
  assert.equal(lagged.envelope.rollupLag, 28);
  assert.match(lagged.text, /source-cut lag 28/);
  assert.match(lagged.text, /Older rollup detail/);
  assert.equal(lagged.envelope.validation.protectedCoverageComplete, true);
  assert.ok(lagged.envelope.combinedTokens <= fixture.combinedCeilingTokens);

  const historical = composeShadowContext({ ...fixture,
    mandatoryCoverage: { protectedComplete: false, openWorkComplete: false } });
  assert.equal(historical.degradation, "last-good-state-and-recent");
  assert.match(historical.text, /Never publish this preview/);
  assert.match(historical.text, /KNOWN PROTECTED ITEMS \(INCOMPLETE COVERAGE\)/);
  assert.equal(historical.envelope.validation.protectedCoverageComplete, false);
  const obligation = "Keep this condition intact. ".repeat(80) + "Do not proceed unless approved.";
  const exactObligation = composeShadowContext({ ...fixture, combinedCeilingTokens: 5000,
    selected: { ...fixture.selected, protected: [row("long-obligation", obligation, 4, 0, "restriction", "exact", "current")] } });
  assert.ok(exactObligation.text.includes(obligation), "mandatory prose must not lose a trailing condition to detail truncation");
  const refused = composeShadowContext({ ...fixture, combinedCeilingTokens: 512,
    selected: { ...fixture.selected, protected: [row("long-obligation", obligation, 4, 0, "restriction", "exact", "current")] } });
  assert.equal(refused.envelope.validation.protectedCoverageComplete, false);
  assert.ok(refused.artifact.omittedRowIds.includes("long-obligation"));
  assert.throws(
    () => composeShadowContext({
      ...fixture,
      selected: {
        ...fixture.selected,
        recent: [row("too-large", "x".repeat(SHADOW_COMPOSER_LIMITS.maxRowBytes + 1), 20, 0.5)],
      },
    }),
    /text exceeds its byte cap/,
  );
});

test("stored selection retains source-validated surrounding omissions and separates fidelity, authority, lag, and loss", () => {
  const storeKey = "22222222-2222-4222-8222-222222222222";
  const text = "Do not publish unless the owner explicitly approves.";
  const source = (eventSeq: number, bodyUnits = text.length + 12): ScopedBodySourceRef => ({
    catalogStoreKey: storeKey, sessionKey: "session", catalogGeneration: 1, shardKey: "shard", segment: 1,
    eventSeq, ordinal: eventSeq, descriptor: eventSeq, field: "message.content.0.text", raw: { start: 0, end: 200 },
    coordinateKind: "decoded-body", decodedUtf16: { start: 0, end: bodyUnits },
    bodyHashAlgorithm: "chrono-utf16le-chain-sha256-v1", bodyHash: "a".repeat(64),
  });
  const item = (stableKey: string, eventSeq: number, authority: EpisodeStateSelectionItem["authority"], exactText = text): EpisodeStateSelectionItem => ({
    stableKey, propositionKey: `p-${stableKey}`, spanKey: `s-${stableKey}`, subject: "topic:publish", revision: "unspecified",
    kind: "restriction", authority, confidence: "qualified", status: "current", effectiveAtCut: eventSeq,
    evidence: { source: source(eventSeq, exactText.length + 12), decodedUtf16: { start: 5, end: 5 + exactText.length }, exactText,
      omissions: [{ beforeUtf16: 5, afterUtf16: 7 }], contextComplete: true },
  });
  const selection: EpisodeStateSelection = {
    sourceView: { storeKey, generation: 1, branchKey: "branch", sessionKey: "session", eventCut: 40, segments: [{ segment: 1, cut: 40 }] },
    stateGeneration: 2, branchKey: "branch", requestedCut: 40, processedCut: 30, processedMemoryCut: 30,
    complete: false, partial: true, coverage: { bodyComplete: true, metadataComplete: true, partialMemory: false, qualifiedReducers: true },
    protected: [item("base", 20, "assistant-report")], current: [], recent: [], older: [],
    delta: { verified: false, throughCut: 30, reason: "lag-exceeds-bounded-delta; recent-window-only",
      protected: [item("delta", 30, "user")], current: [], recent: [{ episodeKey: "near-cut", eventSeq: 38, descriptor: 38,
        sourceKey: "near-cut-source", source: source(38), cue: "Near-cut source-linked event.",
        episode: { start: { eventSeq: 38, descriptor: 38 }, end: { eventSeq: 38, descriptor: 38 }, open: true,
          objective: "Near-cut objective", objectiveEvidence: null } }] },
    omissions: { protectedAtLeastOne: false, currentAtLeastOne: false, recentAtLeastOne: true, responseBudgetAtLeastOne: false },
    metrics: { sqliteStatements: 2 },
  };
  const composed = composeStoredSelection({ regularPiSummary, combinedCeilingTokens: 2500,
    cut: { ...fixture.cut, sourceCutSeq: 40 } }, selection, candidate => `opaque:${candidate.eventSeq}`);
  assert.match(composed.text, /Do not publish unless the owner explicitly approves\./);
  assert.match(composed.text, /source authority: assistant-report/);
  assert.match(composed.text, /source authority: user/);
  assert.match(composed.text, /unsupported extraction: qualified reducer output/);
  assert.match(composed.text, /selection loss: recent selection omitted/);
  assert.match(composed.text, /snapshot lag: lag-exceeds-bounded-delta; recent-window-only/);
  assert.match(composed.text, /Near-cut source-linked event\./);
  assert.equal(composed.envelope.validation.protectedCoverageComplete, false);
  assert.equal(composed.artifact.selectedRows.filter(candidate => candidate.section === "protected").length, 2,
    "known exact obligations remain reserved even when total coverage and delta verification are incomplete");

  const withRollup = structuredClone(selection) as EpisodeStateSelection;
  Object.assign(withRollup, { requestedCut: 40, processedCut: 40, processedMemoryCut: 40, delta: undefined,
    coverage: { bodyComplete: true, metadataComplete: true, partialMemory: false, qualifiedReducers: false,
      restrictionsComplete: true, openWorkComplete: true },
    recent: [{ episodeKey: "recent", eventSeq: 38, descriptor: 38, sourceKey: "recent-source", source: source(38),
      cue: "Recent parser evidence.", episode: { start: { eventSeq: 38, descriptor: 38 }, end: { eventSeq: 38, descriptor: 38 },
        open: true, objective: "Recent parser work", objectiveEvidence: null } }],
    omissions: { protectedAtLeastOne: false, openWorkAtLeastOne: false, currentAtLeastOne: false,
      recentAtLeastOne: false, responseBudgetAtLeastOne: false },
    rollups: { handle: { schemaVersion: 1, ruleset: "episode-rollup-exact-v3", branchKey: "branch", eventCut: 30,
      stateGeneration: 2, rollupGeneration: 7, rootNodeId: "b".repeat(64) }, representedStartSeq: 1,
      representedEndSeq: 30, publicationComplete: true, selectionPartial: false, partialReasons: [], items: [{
        nodeId: "c".repeat(64), nodeType: "rollup", path: ["b".repeat(64), "c".repeat(64)],
        range: { start: { eventSeq: 5, descriptor: 1 }, end: { eventSeq: 15, descriptor: 2 } },
        summary: ["Older parser rollup evidence."], recovery: "chrono-v3:opaque-rollup" }] } });
  const rollupComposition = composeStoredSelection({ regularPiSummary, combinedCeilingTokens: 2500,
    cut: { ...fixture.cut, sourceCutSeq: 40 } }, withRollup, candidate => `opaque:${candidate.eventSeq}`);
  assert.match(rollupComposition.text, /Older parser rollup evidence\./);
  const rollupRow = rollupComposition.artifact.selectedRows.find(candidate => candidate.row.kind === "rollup");
  assert.equal(rollupRow?.section, "older");
  assert.equal(rollupRow?.row.recovery, "chrono-v3:opaque-rollup");
  assert.deepEqual(rollupComposition.envelope.rollupRepresentedRange, [1, 30]);
  assert.equal(rollupComposition.envelope.validation.protectedCoverageComplete, true,
    "rollup selection does not override or weaken independently complete mandatory coverage");

  const malformed = structuredClone(selection) as EpisodeStateSelection;
  const malformedEvidence = malformed.protected[0]!.evidence as { decodedUtf16: { start: number; end: number } };
  malformedEvidence.decodedUtf16.end -= 1;
  const rejected = composeStoredSelection({ regularPiSummary, combinedCeilingTokens: 2500,
    cut: { ...fixture.cut, sourceCutSeq: 40 } }, malformed, candidate => `opaque:${candidate.eventSeq}`);
  assert.doesNotMatch(rejected.text, /source authority: assistant-report/);
  assert.match(rejected.text, /protected item\(s\) have unsupported exact evidence/);
});
