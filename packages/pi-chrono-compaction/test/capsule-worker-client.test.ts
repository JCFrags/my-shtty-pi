import assert from "node:assert/strict";
import test from "node:test";
import { CAPSULE_LIMITS, type CapsuleWorkerRequest } from "../src/capsule-contract.js";
import { CAPSULE_WORKER_CAPS, runCapsuleWorker, validateCapsuleResponse } from "../src/capsule-worker-client.js";

const success = { v: 1, ok: true, result: {}, sourceBytes: 0, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes };
const failure = { v: 1, ok: false, code: "capsule-missing-segment", sourceBytes: 1, sqliteNativeLimitBytes: CAPSULE_LIMITS.nativeSqliteBytes, resumable: true };

test("capsule wire validation separates bounded source work and configured native allowance", () => {
  assert.deepEqual(validateCapsuleResponse(success), success);
  assert.deepEqual(validateCapsuleResponse(failure), failure);
  for (const sourceBytes of [-1, 0.5, NaN, CAPSULE_LIMITS.sourceBytesPerJob + 1]) {
    assert.throws(() => validateCapsuleResponse({ ...success, sourceBytes }));
  }
  assert.doesNotThrow(() => validateCapsuleResponse({ ...success, sourceBytes: CAPSULE_LIMITS.sourceBytesPerJob }));
  for (const value of [null, [], { ...success, sqliteNativeLimitBytes: 0 }, { ...success, result: [] },
    { ...success, extra: "not-wire" }, { ...failure, resumable: undefined }, { ...failure, code: "/private/error" },
    { ...success, result: { text: "x".repeat(CAPSULE_LIMITS.responseBytes) } }]) {
    assert.throws(() => validateCapsuleResponse(value));
  }
  assert.equal(CAPSULE_WORKER_CAPS.heapMiB, 128);
  assert.equal(CAPSULE_WORKER_CAPS.memoryBytes, 256 * 1024 * 1024);
  assert.equal(CAPSULE_WORKER_CAPS.timeoutMs, 30_000);
  assert.equal(CAPSULE_WORKER_CAPS.sourceBytes, 16 * 1024 * 1024);
});

test("invalid capsule requests fail before worker admission and do not expose inputs", async () => {
  const result = await runCapsuleWorker({ op: "invalid", catalogDirectory: "sensitive-input" } as unknown as CapsuleWorkerRequest);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("sensitive-input"), false);
  assert.equal(result.sourceBytes, 0);
  assert.equal(result.sqliteNativeLimitBytes, CAPSULE_LIMITS.nativeSqliteBytes);
  if (!result.ok) assert.equal(result.code, "capsule-worker-failed");
});
