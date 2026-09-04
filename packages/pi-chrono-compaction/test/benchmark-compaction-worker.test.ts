import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error benchmark script is a checked JavaScript entry point
import { parseWorkerBenchmarkArgs, runWorkerBenchmark } from "../../scripts/benchmark-compaction-worker.mjs";

test("worker benchmark validates bounded public synthetic arguments",()=>{assert.deepEqual(parseWorkerBenchmarkArgs(["--mode","queue","--tasks","10","--slots","4","--jobs","5"]),{mode:"queue",tasks:10,slots:4,jobs:5,generations:5});for(const args of [["--tasks","0"],["--tasks","5001"],["--slots","5"],["--jobs","21"],["--mode","private"],["--fixture","x"]])assert.throws(()=>parseWorkerBenchmarkArgs(args));});
test("small worker compare and queue modes report exactness and host limits",async()=>{const compare=await runWorkerBenchmark(parseWorkerBenchmarkArgs(["--mode","compare","--tasks","2"]));assert.equal(compare.outputEquivalent,true);assert.equal(compare.modelCalls,0);assert.equal(compare.networkCalls,0);assert.ok(compare.responseBytes<8*1024*1024);const queue=await runWorkerBenchmark(parseWorkerBenchmarkArgs(["--mode","queue","--slots","2","--jobs","5"]));assert.equal(queue.maximumActiveWorkers,2);assert.deepEqual(queue.artifacts,{tickets:0,slots:0});});
