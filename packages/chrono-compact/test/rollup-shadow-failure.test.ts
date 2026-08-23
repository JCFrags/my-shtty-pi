import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateWorkerResponse, type WorkerRuntimeMetrics } from "../src/compaction-worker-protocol.js";
import {
  appendRollupShadowFailureRecord,
  getRollupShadowStatus,
  projectedRollupMemoryBytes,
  rollupShadowSidecarPath,
} from "../src/history-rollup-shadow.js";
import {
  classifyRollupShadowFailure,
  ROLLUP_SHADOW_FAILURE_CODES,
  ROLLUP_SHADOW_FAILURE_STAGES,
  safeFailureContext,
} from "../src/rollup-shadow-failure.js";

const metrics: WorkerRuntimeMetrics = {
  workerPid: 0,
  totalWallMs: 0,
  compactionMs: 0,
  cpuUserMicros: 0,
  cpuSystemMicros: 0,
  peakRssKiB: 0,
  priorityApplied: false,
  cacheState: "disabled",
  modelCalls: 0,
  networkCalls: 0,
  secretSentinelPresent: false,
  sourceLedgerTransition: "none",
  ledgerColdLoadMs: 0,
  branchResolveMs: 0,
  branchReadMs: 0,
  branchEntryCount: 0,
  branchSourceBytes: 0,
  sourceRangeCount: 0,
  sourceBytesRead: 0,
  sourceByteAvoidanceRate: 0,
  completeSessionReadAvoided: false,
  candidateLedgerReused: false,
};

test("every shadow failure stage and safe code passes strict protocol validation", () => {
  for (const failureStage of ROLLUP_SHADOW_FAILURE_STAGES) {
    const response = validateWorkerResponse({
      schemaVersion: 1,
      jobId: "safe-job",
      status: "failed",
      jobType: "rollup-shadow",
      failureStage,
      failureCode: "unknown-worker-failure",
      failureContext: { sourceFileBytes: 1, currentMemoryBytes: 2 },
      metrics,
    }, "safe-job");
    assert.equal(response.status, "failed");
  }
  for (const failureCode of ROLLUP_SHADOW_FAILURE_CODES) {
    const response = validateWorkerResponse({
      schemaVersion: 1,
      jobId: "safe-job",
      status: "failed",
      jobType: "rollup-shadow",
      failureStage: "unknown-stage",
      failureCode,
      metrics,
    }, "safe-job");
    assert.equal(response.status, "failed");
  }
});

test("safe failure context drops unknown numeric fields", () => {
  const value = safeFailureContext({ nodeBytes: 42, privateNumericId: 99 } as never);
  assert.deepEqual(value, { nodeBytes: 42 });
});

test("direct internal identities map to a safe stage and code without raw details", () => {
  const cases = [
    ["source-bind", "source-changed", "shadow-source-changed"],
    ["prefix-validation", "invalid-cut", "shadow-invalid-cut"],
    ["source-ledger-update", "source-ledger-corrupt", "shadow-ledger-corrupt"],
    ["rollup-manifest-load", "history-rollup-integrity", "shadow-manifest-corrupt"],
    ["rollup-update", "history-rollup-store-busy", "shadow-store-busy"],
    ["rollup-update", "history-rollup-node-corrupt", "shadow-node-corrupt"],
    ["rollup-update", "history-rollup-node-too-large", "shadow-node-too-large"],
    ["rollup-update", "shadow-memory-gate", "shadow-memory-gate"],
    ["rollup-render", "history-rollup-render-failed", "shadow-render-failed"],
    ["rollup-validation", "history-rollup-validation-failed", "shadow-validation-failed"],
    ["shadow-sidecar-read", "rollup-shadow-sidecar-read-failed", "shadow-sidecar-read-failed"],
    ["shadow-sidecar-write", "rollup-shadow-sidecar-write-failed", "shadow-sidecar-write-failed"],
    ["response-validation", "worker-response-too-large", "shadow-response-too-large"],
    ["response-validation", "worker-protocol-error", "shadow-protocol-error"],
  ] as const;
  for (const [stage, identity, expected] of cases) {
    const result = classifyRollupShadowFailure(stage, Object.assign(new Error("private detail sentinel"), { code: identity }));
    assert.equal(result.code, expected);
    assert.equal(JSON.stringify(result).includes("private detail sentinel"), false);
  }
  const unknown = classifyRollupShadowFailure("unknown-stage", new Error("private stack sentinel"));
  assert.deepEqual(unknown, { stage: "unknown-stage", code: "unknown-worker-failure" });
});

test("measured memory projection gates one oversized entry without using total source size", () => {
  assert.equal(projectedRollupMemoryBytes(128 * 1024 * 1024, 50 * 1024 * 1024), 1528 * 1024 * 1024);
  assert.ok(projectedRollupMemoryBytes(256 * 1024 * 1024, 50 * 1024 * 1024) > 1536 * 1024 * 1024);
  assert.ok(projectedRollupMemoryBytes(256 * 1024 * 1024, 4 * 1024 * 1024) < 1536 * 1024 * 1024);
});

test("failed sidecar records are owner-only, text-free, strict, and aggregated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-shadow-failure-"));
  const sessionPath = join(directory, "fixture.jsonl");
  try {
    await appendRollupShadowFailureRecord(sessionPath, {
      schemaVersion: 2,
      recordType: "failure",
      generation: 3,
      timestampMs: 10,
      safeStatus: "failed",
      failureStage: "rollup-update",
      failureCode: "shadow-memory-gate",
      context: { sourceFileBytes: 100, sourceLedgerEntries: 2, currentMemoryBytes: 50 },
    });
    const text = await readFile(rollupShadowSidecarPath(sessionPath), "utf8");
    assert.equal(text.includes(directory), false);
    assert.equal(text.includes("fixture.jsonl"), false);
    assert.equal(text.includes("entryId"), false);
    assert.equal(text.includes("sourceRefs"), false);
    assert.equal(text.includes("stack"), false);
    const status = await getRollupShadowStatus(sessionPath);
    assert.equal(status.records, 1);
    assert.deepEqual(status.failureStageCounts, { "rollup-update": 1 });
    assert.deepEqual(status.failureCodeCounts, { "shadow-memory-gate": 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
