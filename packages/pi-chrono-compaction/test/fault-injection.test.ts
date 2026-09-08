import { test } from "node:test";
import assert from "node:assert/strict";
import { FAULT_SCENARIOS, FaultController, InjectedFault, corruptJson, instrumentOperations, mutateByte, syntheticOwner, truncateBytes } from "./support/fault-injection.js";

test("catalog names every M02 reusable fault class exactly once", () => {
  assert.equal(new Set(FAULT_SCENARIOS).size, FAULT_SCENARIOS.length);
  assert.deepEqual(FAULT_SCENARIOS, [
    "process-death-between-operations", "partial-write", "missing-manifest", "corrupt-manifest", "missing-segment", "corrupt-segment",
    "stale-ownership", "malformed-ownership", "pid-reuse", "worker-crash", "worker-timeout", "worker-resource-termination",
    "concurrent-writers", "source-append", "source-replacement", "source-truncation", "transaction-abort",
  ]);
});

test("operation occurrences deterministically inject EIO, ENOSPC, abort, and process death", () => {
  for (const [action, code] of [["eio", "EIO"], ["enospc", "ENOSPC"], ["abort", "ABORT_ERR"], ["process-death", "SYNTHETIC_PROCESS_DEATH"]] as const) {
    const controller = new FaultController([{ operation: "rename", occurrence: 2, action }]);
    assert.deepEqual(controller.before("rename"), {});
    assert.throws(() => controller.before("rename"), (error: unknown) => error instanceof InjectedFault && error.code === code && error.operation === "rename");
    assert.equal(controller.count("rename"), 2);
    assert.deepEqual(controller.events, [{ operation: "rename", occurrence: 2, action }]);
  }
});

test("instrumented operations model a bounded short write without calling the real writer", () => {
  let writes = 0;
  const controller = new FaultController([{ operation: "write", action: "short-write", shortBytes: 3 }]);
  const operations = instrumentOperations({ write(buffer: Buffer) { writes += 1; return { bytesWritten: buffer.length, buffer }; } }, controller);
  const buffer = Buffer.from("abcdef");
  const result = operations.write(buffer);
  assert.equal(writes, 0);
  assert.equal(result.bytesWritten, 3);
  assert.equal(result.buffer, buffer);
  assert.deepEqual(controller.events, [{ operation: "write", occurrence: 1, action: "short-write" }]);
});

test("manifest, segment, and source mutation helpers are byte-bounded and deterministic", () => {
  const original = "{\"schemaVersion\":1}\n";
  assert.equal(corruptJson(original), corruptJson(original));
  assert.notEqual(corruptJson(original), original);
  assert.equal(Buffer.byteLength(truncateBytes(original, 5)), 5);
  const mutated = mutateByte(original, 2);
  assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
  assert.notEqual(mutated, original);
  assert.throws(() => truncateBytes(original, -1), /fault-truncation-invalid/);
  assert.throws(() => mutateByte(original, Buffer.byteLength(original)), /fault-mutation-invalid/);
});

test("ownership fixtures distinguish stale, malformed, and PID-reuse cases without host inspection", () => {
  assert.deepEqual(syntheticOwner("malformed"), { schemaVersion: 1, pid: "invalid" });
  assert.equal((syntheticOwner("stale") as { pid: number }).pid, 999_999_999);
  assert.equal((syntheticOwner("pid-reuse") as { processStartIdentity: string }).processStartIdentity, "old-start");
  assert.equal((syntheticOwner("live") as { processStartIdentity: string }).processStartIdentity, "current-start");
});

test("invalid plans fail before exercising a target operation", () => {
  assert.throws(() => new FaultController([{ operation: "../write", action: "eio" }]), /fault-operation-invalid/);
  assert.throws(() => new FaultController([{ operation: "write", action: "short-write" }]), /fault-short-write-invalid/);
  assert.throws(() => new FaultController([{ operation: "write", occurrence: 0, action: "eio" }]), /fault-occurrence-invalid/);
});
