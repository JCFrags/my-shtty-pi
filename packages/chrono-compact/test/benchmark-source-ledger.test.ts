import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The manual benchmark is an executable JavaScript module without declarations.
import { parseSourceLedgerArguments, runSourceLedgerBenchmark } from "../../scripts/benchmark-source-ledger.mjs";

test("source-ledger benchmark validates bounded arguments", () => {
  assert.deepEqual(parseSourceLedgerArguments(["--final-tasks", "10", "--batches", "3"]), { "final-tasks": 10, batches: 3 });
  for (const args of [[], ["--unknown", "1"], ["--final-tasks"], ["--final-tasks", "x", "--batches", "1"],
    ["--final-tasks", "5001", "--batches", "1"], ["--final-tasks", "1", "--batches", "101"]]) {
    assert.throws(() => parseSourceLedgerArguments(args));
  }
});

test("source-ledger benchmark returns aggregate verified output", async () => {
  const output = await runSourceLedgerBenchmark(3, 2);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.integrityOk, true);
  assert.equal(output.batchesRun, 2);
  assert.ok(output.sourceReadAmplification > 0);
  assert.ok(output.exactHitSourceBytesRead < output.finalSourceBytes);
  assert.ok(output.exactRetrievalBytesRead < output.finalSourceBytes);
  assert.doesNotMatch(JSON.stringify(output), /Never publish private evidence|synthetic-ledger-benchmark|message-/i);
});
