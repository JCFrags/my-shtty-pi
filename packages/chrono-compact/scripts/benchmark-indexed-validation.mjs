#!/usr/bin/env node
// @ts-nocheck
// Public synthetic validation benchmark. It does not measure complete compaction or use a model or network.
import { performance } from "node:perf_hooks";
import { buildValidationIndex, validatePlan } from "../dist/src/validate.js";

function block(entryId, entryIndex, blockIndex, kind = "assistant_text", toolCallId) {
  return {
    id: `${entryId}:${blockIndex}`, entryId, entryIndex, blockIndex, kind, label: kind,
    exactText: `synthetic ${kind} ${entryIndex}`, rawTokens: 4, sourceRefs: [{ entryId, blockIndex }],
    protectedExact: false, reproducible: false, unresolved: false, toolCallId, exactIdentifiers: [], attributes: {},
  };
}

function unit(id, startEntryIndex, sourceRefs, kind = "assistant_text") {
  const selected = {
    id: `${id}:raw`, level: "raw", text: `selected ${id}`, tokens: 4, rawTokens: 4, utility: 1,
    lossy: false, omissions: [], sourceRefs, metadata: {},
  };
  return {
    id, kind, label: id, startEntryIndex, endEntryIndex: startEntryIndex, sourceRefs,
    rawTokens: 4, importance: 1, importanceReasons: [], protectedExact: false,
    candidates: [selected], toolCallIds: [], selected,
  };
}

function plan(units) {
  return { targetTokens: 100_000, estimatedTokens: units.length * 4, rawTokens: units.length * 4, units, warnings: [] };
}

function trackedBlocks(values) {
  let indexedReads = 0;
  const blocks = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { blocks, reset: () => { indexedReads = 0; }, indexedReads: () => indexedReads };
}

function runEntryExpansion() {
  const history = [];
  for (let entry = 0; entry < 50_000; entry += 1) {
    history.push(block(`entry-${entry}`, entry, 0), block(`entry-${entry}`, entry, 1));
  }
  const units = [];
  for (let selected = 0; selected < 600; selected += 1) {
    const entry = selected * 80;
    const refs = selected % 2 === 0
      ? [{ entryId: `entry-${entry}` }]
      : [{ entryId: `entry-${entry}`, blockIndex: 0 }];
    units.push(unit(`selected-${selected}`, entry, refs));
  }
  const tracked = trackedBlocks(history);
  const indexStarted = performance.now();
  const index = buildValidationIndex(tracked.blocks);
  const indexBuildMs = performance.now() - indexStarted;
  tracked.reset();
  const lookupStats = { entryLookups: 0, exactLookups: 0 };
  const validationStarted = performance.now();
  const report = validatePlan(plan(units), tracked.blocks, 100_000, { validationIndex: index, lookupStats });
  const validationMs = performance.now() - validationStarted;
  return {
    historicalBlocks: history.length, planUnits: units.length,
    sourceReferences: units.reduce((sum, value) => sum + value.sourceRefs.length, 0),
    indexBuildMs, validationMs, indexedEntryLookups: lookupStats.entryLookups,
    indexedExactLookups: lookupStats.exactLookups, fullBlockScans: tracked.indexedReads(),
    validationErrors: report.issues.filter((issue) => issue.severity === "error").length,
    integrity: report.ok && tracked.indexedReads() === 0,
  };
}

function runToolPairs() {
  const pairCount = 20_000;
  const selectedStart = pairCount - 300;
  const history = [];
  const units = [];
  for (let pair = 0; pair < pairCount; pair += 1) {
    const callIndex = pair * 2;
    const resultIndex = callIndex + 1;
    history.push(
      block(`call-${pair}`, callIndex, 0, "tool_call", `tool-${pair}`),
      block(`result-${pair}`, resultIndex, 0, "tool_result", `tool-${pair}`),
    );
    if (pair >= selectedStart) {
      const callRef = pair % 2 === 0 ? { entryId: `call-${pair}` } : { entryId: `call-${pair}`, blockIndex: 0 };
      const resultRef = pair % 2 === 0 ? { entryId: `result-${pair}`, blockIndex: 0 } : { entryId: `result-${pair}` };
      units.push(unit(`selected-call-${pair}`, callIndex, [callRef], "tool_call"));
      units.push(unit(`selected-result-${pair}`, resultIndex, [resultRef], "tool_result"));
    }
  }
  const tracked = trackedBlocks(history);
  const index = buildValidationIndex(tracked.blocks);
  tracked.reset();
  const lookupStats = { entryLookups: 0, exactLookups: 0 };
  const validationStarted = performance.now();
  const report = validatePlan(plan(units), tracked.blocks, 100_000, { validationIndex: index, lookupStats, allowOmittedPrefix: true });
  const validationMs = performance.now() - validationStarted;
  const represented = new Set(units.flatMap((value) => value.sourceRefs.map((ref) => ref.entryId)));
  let representedCompletePairs = 0;
  let fullyOmittedPairs = 0;
  let partialPairs = 0;
  for (let pair = 0; pair < pairCount; pair += 1) {
    const sides = Number(represented.has(`call-${pair}`)) + Number(represented.has(`result-${pair}`));
    if (sides === 2) representedCompletePairs += 1;
    else if (sides === 0) fullyOmittedPairs += 1;
    else partialPairs += 1;
  }
  return {
    pairCount, representedCompletePairs, fullyOmittedPairs, partialPairs, validationMs,
    indexedEntryLookups: lookupStats.entryLookups, indexedExactLookups: lookupStats.exactLookups,
    fullBlockScans: tracked.indexedReads(),
    validationErrors: report.issues.filter((issue) => issue.severity === "error").length,
    integrity: report.ok && partialPairs === 0 && tracked.indexedReads() === 0,
  };
}

const entryExpansion = runEntryExpansion();
const toolPairCoverage = runToolPairs();
const result = {
  schemaVersion: 1,
  benchmark: "indexed-final-validation",
  scope: "synthetic final validation only; not complete compaction",
  entryExpansion,
  toolPairCoverage,
  peakRssBytes: process.memoryUsage().rss,
  modelCalls: 0,
  networkCalls: 0,
};
console.log(JSON.stringify(result, null, 2));
if (!entryExpansion.integrity || !toolPairCoverage.integrity || toolPairCoverage.partialPairs !== 0) process.exitCode = 1;
