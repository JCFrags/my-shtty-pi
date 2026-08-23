import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Executable benchmark module has no declarations.
import { parseCandidateSegmentArguments, runCompare, runEntries, runSeries } from "../../scripts/benchmark-candidate-segments.mjs";

test("candidate segment benchmark validates strict bounded arguments", () => {
  assert.deepEqual(parseCandidateSegmentArguments(["series","--final-tasks","10","--batches","2"]),{mode:"series","final-tasks":10,batches:2});
  assert.throws(()=>parseCandidateSegmentArguments(["compare","--tasks","0"]));
  assert.throws(()=>parseCandidateSegmentArguments(["entries","--entries","100001"]));
  assert.throws(()=>parseCandidateSegmentArguments(["unknown"]));
});

test("candidate segment benchmark small modes report integrity and exact output equivalence", async () => {
  const series=await runSeries(3,2); assert.equal(series.integrityOk,true); assert.ok(series.sourceBytesRead>=series.finalSourceBytes); assert.ok(series.blockParseAmplification<=1.2);
  const compare=await runCompare(3); assert.equal(compare.summaryEqual,true); assert.equal(compare.planEqual,true); assert.equal(compare.validationEqual,true); assert.equal(compare.generationHashEqual,true);
  const entries=await runEntries(20); assert.equal(entries.acceptedEntryCount,20); assert.equal(entries.integrityOk,true);
});
