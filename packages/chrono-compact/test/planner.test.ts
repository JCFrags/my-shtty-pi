import assert from "node:assert/strict";
import test from "node:test";
import { resolveCompactorConfig } from "../src/compactor.js";
import { planCompression } from "../src/planner.js";
import type { CandidateUnit, RepresentationCandidate } from "../src/types.js";

function representation(id: string, level: RepresentationCandidate["level"], tokens: number, utility: number): RepresentationCandidate {
  return {
    id: `${id}:${level}`,
    level,
    text: `${level} representation`,
    tokens,
    rawTokens: 1_000,
    utility,
    lossy: level !== "raw",
    omissions: level === "raw" ? [] : [{ description: "Detail omitted for planner test" }],
    sourceRefs: [{ entryId: id }],
    metadata: {},
  };
}

function unit(id: string, importance: number): CandidateUnit {
  return {
    id,
    kind: "tool_result",
    label: "TOOL RESULT",
    startEntryIndex: 0,
    endEntryIndex: 0,
    sourceRefs: [{ entryId: id }],
    rawTokens: 1_000,
    importance,
    importanceReasons: importance >= 100 ? ["decisive dependency test"] : ["routine repeated evidence test"],
    protectedExact: false,
    candidates: [
      representation(id, "marker", 40, 0.3),
      representation(id, "reduced", 540, 0.5),
    ],
    toolCallIds: [],
  };
}

test("planner leaves budget unused when the remaining upgrade has weak marginal value", () => {
  const config = resolveCompactorConfig({ targetTokens: 4_000, minMarginalUtilityPerToken: 0.06 });
  const plan = planCompression([unit("routine", 20)], 4_000, config);

  assert.equal(plan.units[0]?.selected.level, "marker");
  assert.ok(plan.estimatedTokens < plan.targetTokens / 10);
  assert.ok(plan.warnings.some((warning) => /below the minimum marginal-value threshold/i.test(warning)));
});

test("planner can spend tokens on the same upgrade when evidence importance is high", () => {
  const config = resolveCompactorConfig({ targetTokens: 4_000, minMarginalUtilityPerToken: 0.06 });
  const plan = planCompression([unit("decisive", 200)], 4_000, config);

  assert.equal(plan.units[0]?.selected.level, "reduced");
  assert.ok(plan.estimatedTokens < plan.targetTokens);
});
