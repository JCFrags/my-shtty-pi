import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCompactionWorker } from "../src/compaction-worker-client.js";
import type { RollupShadowWorkerRequest, WorkerSourceExpectation } from "../src/compaction-worker-protocol.js";
import {
  appendRollupShadowRecord,
  getRollupShadowStatus,
  MAX_ROLLUP_SHADOW_BYTES,
  MAX_ROLLUP_SHADOW_RECORDS,
  readRollupShadowRecords,
  rollupShadowSidecarPath,
  runRollupShadowEvaluation,
  type RollupShadowPayload,
} from "../src/history-rollup-shadow.js";
import { applyConfigCommand, validateUserConfig } from "../src/user-config.js";

function sourceEntries(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  let parent: string | null = null;
  for (let index = 1; index <= 8; index += 1) {
    const id = `entry-${index}`;
    entries.push({
      type: "message",
      id,
      parentId: parent,
      message: {
        role: index % 2 ? "user" : "assistant",
        content: index === 1
          ? "Keep the current replay authoritative. Release remains blocked until approval."
          : `Task ${index} remains open for resource module-${index}.ts.`,
      },
    });
    parent = id;
  }
  return entries;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chrono-shadow-test-"));
  const sessionPath = join(directory, "session.jsonl");
  const entries = sourceEntries();
  await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "fixture" })}\n${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  return { directory, sessionPath };
}

function payload(generation: number): RollupShadowPayload {
  const quality = {
    restrictionCueCoverage: 1,
    blockerCoverage: 1,
    unresolvedFailureCoverage: 1,
    currentResourceCoverage: 1,
    invalidReferences: 0,
    invalidRanges: 0,
    cutLines: 0,
    falseCompletions: 0,
    unsupportedIdentifiers: 0,
    unsupportedQuotations: 0,
    unsupportedNumbers: 0,
    missingRecoveryRoutes: 0,
  };
  return {
    schemaVersion: 2,
    generation,
    sourceTokenCount: 10,
    currentReplayTokenCount: 5,
    rollupTokenCount: 6,
    currentQuality: quality,
    rollupQuality: quality,
    updateTimeMs: 1,
    renderTimeMs: 1,
    sourceBytesRead: 10,
    nodeBytesRead: 10,
    queryNodes: 1,
    workerTimerDelayMs: 0,
    validationIssueCounts: {},
    currentReplayHash: "a".repeat(64),
    rollupOutputHash: "b".repeat(64),
    safeStatus: "ok",
    modelCalls: 0,
    networkCalls: 0,
  };
}

test("rollup shadow setting defaults off and accepts persistent commands", () => {
  assert.equal(validateUserConfig({}).rollupShadowEnabled, undefined);
  assert.equal(applyConfigCommand({}, "rollup-shadow on").config.rollupShadowEnabled, true);
  assert.equal(applyConfigCommand({ rollupShadowEnabled: true }, "rollup-shadow off").config.rollupShadowEnabled, false);
});

test("shadow evaluation stores aggregate metrics and hashes without private text or references", async () => {
  const value = await fixture();
  const replaySentinel = "PRIVATE_REPLAY_SENTINEL_DO_NOT_STORE";
  try {
    const result = await runRollupShadowEvaluation({
      sessionPath: value.sessionPath,
      branchLeafId: "entry-6",
      firstKeptEntryId: "entry-7",
      currentReplayText: replaySentinel,
      hardTokenBound: 25_000,
      targetTokenBound: 20_000,
      retentionHints: "",
    });
    assert.equal(result.modelCalls, 0);
    assert.equal(result.networkCalls, 0);
    assert.equal(Object.values(result).includes(replaySentinel), false);
    const sidecar = rollupShadowSidecarPath(value.sessionPath);
    const text = await readFile(sidecar, "utf8");
    assert.doesNotMatch(text, /PRIVATE_REPLAY_SENTINEL_DO_NOT_STORE|entry-6|entry-7|session\.jsonl|module-1/);
    assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
    assert.equal((await readRollupShadowRecords(value.sessionPath)).length, 1);
    assert.equal((await getRollupShadowStatus(value.sessionPath)).records, 1);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("shadow worker returns only bounded metrics and hashes", async () => {
  const value = await fixture();
  try {
    const sourceStat = await stat(value.sessionPath);
    const expectedSource: WorkerSourceExpectation = {
      deviceId: String(sourceStat.dev),
      inodeId: String(sourceStat.ino),
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
    };
    const request: RollupShadowWorkerRequest = {
      schemaVersion: 1,
      jobId: "shadow-worker",
      jobType: "rollup-shadow",
      sessionPath: value.sessionPath,
      expectedSource,
      deadlineMs: Date.now() + 60_000,
      niceLevel: 10,
      branchLeafId: "entry-6",
      firstKeptEntryId: "entry-7",
      currentReplayText: "WORKER_REPLAY_SENTINEL",
      hardTokenBound: 25_000,
      targetTokenBound: 20_000,
      retentionHints: "",
    };
    const execution = await runCompactionWorker(request, {
      schedulerDirectory: join(value.directory, "scheduler"),
      workerTimeoutMs: 60_000,
      priority: "low",
    });
    assert.equal(execution.response.status, "ok");
    assert.equal(execution.response.jobType, "rollup-shadow");
    assert.doesNotMatch(JSON.stringify(execution.response), /WORKER_REPLAY_SENTINEL|entry-6|entry-7|session\.jsonl/);
    assert.equal(execution.response.metrics.modelCalls, 0);
    assert.equal(execution.response.metrics.networkCalls, 0);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("shadow worker fails safely for invalid cuts and changed source", async () => {
  const value = await fixture();
  try {
    const sourceStat = await stat(value.sessionPath);
    const request: RollupShadowWorkerRequest = {
      schemaVersion: 1,
      jobId: "shadow-invalid",
      jobType: "rollup-shadow",
      sessionPath: value.sessionPath,
      expectedSource: { deviceId: String(sourceStat.dev), inodeId: String(sourceStat.ino), size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
      deadlineMs: Date.now() + 60_000,
      niceLevel: 10,
      branchLeafId: "entry-5",
      firstKeptEntryId: "entry-7",
      currentReplayText: "replay",
      hardTokenBound: 25_000,
      targetTokenBound: 20_000,
      retentionHints: "",
    };
    const invalid = await runCompactionWorker(request, { schedulerDirectory: join(value.directory, "invalid") });
    assert.equal(invalid.response.status, "failed");
    if (invalid.response.status === "failed") assert.equal(invalid.response.failureCode, "invalid-cut");
    const changed = await runCompactionWorker({ ...request, jobId: "shadow-changed", branchLeafId: "entry-6", expectedSource: { ...request.expectedSource, size: request.expectedSource.size + 1 } }, { schedulerDirectory: join(value.directory, "changed") });
    assert.equal(changed.response.status, "failed");
    if (changed.response.status === "failed") assert.equal(changed.response.failureCode, "source-changed");
    assert.equal(existsSync(rollupShadowSidecarPath(value.sessionPath)), false);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("shadow sidecar rejects unknown fields before atomic rewrite", async () => {
  const value = await fixture();
  try {
    const sidecar = rollupShadowSidecarPath(value.sessionPath);
    await writeFile(sidecar, `${JSON.stringify({ ...payload(1), privateText: "PRIVATE_SIDECAR_SENTINEL" })}\n`, { mode: 0o600 });
    assert.equal((await readRollupShadowRecords(value.sessionPath)).length, 0);
    await appendRollupShadowRecord(value.sessionPath, payload(2));
    assert.doesNotMatch(await readFile(sidecar, "utf8"), /PRIVATE_SIDECAR_SENTINEL|privateText/);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("shadow sidecar keeps the newest 1000 records within four MiB", async () => {
  const value = await fixture();
  try {
    for (let generation = 1; generation <= MAX_ROLLUP_SHADOW_RECORDS + 5; generation += 1) {
      await appendRollupShadowRecord(value.sessionPath, payload(generation));
    }
    const records = await readRollupShadowRecords(value.sessionPath);
    const sidecar = rollupShadowSidecarPath(value.sessionPath);
    assert.equal(records.length, MAX_ROLLUP_SHADOW_RECORDS);
    assert.equal(records[0]?.generation, 6);
    assert.ok((await stat(sidecar)).size <= MAX_ROLLUP_SHADOW_BYTES);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});
