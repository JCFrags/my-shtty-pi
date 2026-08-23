// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { parseLedgerBranchBenchmarkArgs, runLedgerBranchBenchmark } from "../../scripts/benchmark-ledger-branch.mjs";

test("ledger branch benchmark validates strict bounded arguments",()=>{assert.equal(parseLedgerBranchBenchmarkArgs(["linear","--tasks","5000"]).tasks,5000);assert.equal(parseLedgerBranchBenchmarkArgs(["branched","--active-tasks","1","--abandoned-tasks","0","--branches","16"])["abandoned-tasks"],0);for(const value of [["unknown"],["linear","--tasks","0"],["linear","--tasks","5001"],["retrieval","--samples","1001"],["branched","--unknown","1"],["worker","--active-tasks","x"]])assert.throws(()=>parseLedgerBranchBenchmarkArgs(value));});

test("small ledger branch benchmark modes preserve exact output",async()=>{const linear=await runLedgerBranchBenchmark(parseLedgerBranchBenchmarkArgs(["linear","--tasks","5"]));assert.equal(linear.branchEntriesEqual,true);const branched=await runLedgerBranchBenchmark(parseLedgerBranchBenchmarkArgs(["branched","--active-tasks","5","--abandoned-tasks","10","--branches","2"]));assert.equal(branched.branchJsonEqual,true);const retrieval=await runLedgerBranchBenchmark(parseLedgerBranchBenchmarkArgs(["retrieval","--tasks","5","--samples","5"]));assert.equal(retrieval.outputsEqual,true);});
