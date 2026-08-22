import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The manual benchmark is an executable JavaScript module without declarations.
import { parseSourceLedgerArguments, runLargeEntryBenchmark, runSourceLedgerBenchmark } from "../../scripts/benchmark-source-ledger.mjs";

test("source-ledger benchmark validates bounded arguments", () => {
  assert.deepEqual(parseSourceLedgerArguments(["--final-tasks", "10", "--batches", "3"]), { mode: "tasks", "final-tasks": 10, batches: 3 });
  assert.deepEqual(parseSourceLedgerArguments(["large-entry", "--tokens", "500000"]), { mode: "large-entry", tokens: 500000 });
  for (const args of [[], ["--unknown", "1"], ["--final-tasks"], ["--final-tasks", "x", "--batches", "1"],
    ["--final-tasks", "5001", "--batches", "1"], ["--final-tasks", "1", "--batches", "101"],
    ["large-entry"], ["large-entry", "--tokens", "0"], ["large-entry", "--tokens", "1000001"], ["large-entry", "--batches", "1"]]) {
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

test("large-entry benchmark reports bounded aggregate metrics", async () => {
  const output = await runLargeEntryBenchmark(1000);
  assert.equal(output.mode, "large-entry");
  assert.equal(output.integrityOk, true);
  assert.ok(output.exactHitAnchorBytesRead <= 1024);
  assert.ok(output.appendAnchorBytesRead <= 1024);
  assert.equal(output.exactRetrievalBytesRead, output.largeEntryBytes);
  assert.ok(output.sourceLineAssemblyBytes <= output.maximumSourceLineBytes + 1024);
});
