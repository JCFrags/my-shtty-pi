import assert from "node:assert/strict";
import test from "node:test";
import {
  composeShadowContext,
  SHADOW_COMPOSER_LIMITS,
  type ComposerSelectionRow,
  type ShadowComposerInput,
} from "../src/context-composer.js";

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

test("bounded shadow composition preserves Pi bytes and source order, then degrades truthfully for rollup lag", () => {
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
  assert.equal(lagged.degradation, "last-good-state-and-recent");
  assert.equal(lagged.envelope.rollupLag, 28);
  assert.match(lagged.text, /rollups lag committed memory by 28 sequence/);
  assert.doesNotMatch(lagged.text, /Older rollup detail/);
  assert.match(lagged.text, /not presented as current/);
  assert.ok(lagged.envelope.combinedTokens <= fixture.combinedCeilingTokens);

  const historical = composeShadowContext({ ...fixture,
    mandatoryCoverage: { protectedComplete: false, openWorkComplete: false } });
  assert.equal(historical.degradation, "last-good-state-and-recent");
  assert.match(historical.text, /Never publish this preview/);
  assert.match(historical.text, /KNOWN PROTECTED ITEMS AT HISTORICAL CUT/);
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
