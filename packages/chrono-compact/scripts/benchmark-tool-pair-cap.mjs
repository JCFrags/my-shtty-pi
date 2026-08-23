#!/usr/bin/env node
// @ts-nocheck
// Public synthetic benchmark. It does not read a Pi session or use a model or network.
import { capPlanToRecentSuffix } from "../dist/src/compactor.js";
import { validatePlan } from "../dist/src/validate.js";

const pairs = 500;
const units = [];
const blocks = [];
for (let index = 0; index < pairs; index += 1) {
  for (const side of ["call", "result"]) {
    const entryIndex = index * 2 + (side === "result" ? 1 : 0);
    const entryId = `${side}-${index}`;
    const toolCallId = `pair-${index}`;
    const text = `${side} ${index} ` + "synthetic payload ".repeat(30);
    const selected = { id: `${entryId}:raw`, level: "raw", text, tokens: 92, rawTokens: 92, utility: 1, lossy: false, omissions: [], sourceRefs: [{ entryId }], metadata: {} };
    units.push({ id: entryId, kind: side === "call" ? "tool_call" : "tool_result", label: entryId, startEntryIndex: entryIndex, endEntryIndex: entryIndex,
      sourceRefs: selected.sourceRefs, rawTokens: 92, importance: 1, importanceReasons: [], protectedExact: false, candidates: [selected], toolCallIds: [toolCallId], selected });
    blocks.push({ id: entryId, entryId, entryIndex, kind: side === "call" ? "tool_call" : "tool_result", label: entryId, exactText: text, rawTokens: 92,
      sourceRefs: [{ entryId }], protectedExact: false, reproducible: false, unresolved: false, toolCallId, exactIdentifiers: [], attributes: {} });
  }
}
const plan = { targetTokens: 5_000, estimatedTokens: units.length * 92, rawTokens: units.length * 92, units, warnings: [] };
const capped = capPlanToRecentSuffix(plan, "public-tool-pair-pressure", false, 5_000);
const represented = new Set(capped.plan.units.flatMap(unit => unit.sourceRefs.map(ref => ref.entryId)));
let complete = 0; let omitted = 0; let partial = 0;
for (let index = 0; index < pairs; index += 1) {
  const sides = Number(represented.has(`call-${index}`)) + Number(represented.has(`result-${index}`));
  if (sides === 2) complete += 1;
  else if (sides === 0) omitted += 1;
  else partial += 1;
}
const validation = validatePlan(capped.plan, blocks, capped.plan.targetTokens, { allowOmittedPrefix: true });
console.log(JSON.stringify({ schemaVersion: 1, benchmark: "tool-pair-cap-pressure", sourcePairs: pairs, representedCompletePairs: complete,
  fullyOmittedPairs: omitted, partialPairs: partial, outputTokens: capped.rendered.tokens,
  validationErrors: validation.issues.filter(issue => issue.severity === "error").length, modelCalls: 0, networkCalls: 0 }, null, 2));
if (partial !== 0 || !validation.ok || capped.rendered.tokens > 5_000) process.exitCode = 1;
