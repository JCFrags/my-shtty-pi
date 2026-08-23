import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyConfigCommand,
  loadUserConfig,
  saveUserConfig,
  validateUserConfig,
} from "../src/user-config.js";

test("persistent compactor controls set independent trigger, tail, and target values", () => {
  let config = applyConfigCommand({}, "trigger 48000").config;
  config = applyConfigCommand(config, "raw-tail dynamic").config;
  config = applyConfigCommand(config, "raw-tail-bounds 10000 18000").config;
  config = applyConfigCommand(config, "target-context 36000").config;
  config = applyConfigCommand(config, "replay-target 9000").config;
  config = applyConfigCommand(config, "hybrid-tokens 2200").config;
  config = applyConfigCommand(config, "history-classifier on").config;
  config = applyConfigCommand(config, "incremental-precompute on").config;
  config = applyConfigCommand(config, "isolated-worker on").config;
  config = applyConfigCommand(config, "worker-slots 2").config;
  config = applyConfigCommand(config, "worker-timeout 600").config;
  config = applyConfigCommand(config, "worker-nice 12").config;
  config = applyConfigCommand(config, "tool-result-projection safe").config;
  assert.deepEqual(config, {
    triggerThresholdTokens: 48_000,
    rawTail: "dynamic",
    dynamicRawTailMinTokens: 10_000,
    dynamicRawTailMaxTokens: 18_000,
    targetContextTokens: 36_000,
    replayTargetTokens: 9_000,
    hybridSummaryTargetTokens: 2_200,
    historyEditorEnabled: true,
    incrementalPrecomputeEnabled: true,
    isolatedWorkerEnabled: true,
    hostWorkerSlots: 2,
    workerTimeoutSeconds: 600,
    workerNiceLevel: 12,
    toolResultProjectionMode: "safe",
  });

  config = applyConfigCommand(config, "trigger pi").config;
  config = applyConfigCommand(config, "replay-target auto").config;
  assert.equal(config.triggerThresholdTokens, null);
  assert.equal(config.replayTargetTokens, null);
});

test("persistent compactor controls reject unsafe or contradictory values", () => {
  assert.throws(() => applyConfigCommand({}, "raw-tail 20"), /1,000/);
  assert.throws(() => applyConfigCommand({}, "raw-tail-bounds 30000 20000"), /minimum must not exceed/);
  assert.throws(() => validateUserConfig({ targetContextTokens: "many" }), /targetContextTokens/);
  assert.throws(() => applyConfigCommand({}, "tool-result-projection unsafe"), /off, safe, or aggressive/);
  assert.throws(() => applyConfigCommand({}, "worker-slots 5"), /from 1 to 4/);
  assert.throws(() => applyConfigCommand({}, "worker-timeout 10"), /from 30 to 3,600/);
  assert.throws(() => applyConfigCommand({}, "worker-nice 20"), /from 0 to 19/);
});

test("user configuration is saved atomically and loaded after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "retro-config-"));
  const path = join(directory, "settings.json");
  try {
    saveUserConfig({
      rawTail: "long",
      triggerThresholdTokens: 50_000,
      historyEditorEnabled: false,
      incrementalPrecomputeEnabled: false,
      toolResultProjectionMode: "off",
    }, path);
    assert.deepEqual(loadUserConfig(path).config, {
      rawTail: "long",
      triggerThresholdTokens: 50_000,
      historyEditorEnabled: false,
      incrementalPrecomputeEnabled: false,
      toolResultProjectionMode: "off",
    });
    assert.match(readFileSync(path, "utf8"), /"rawTail": "long"/);
    assert.match(readFileSync(path, "utf8"), /"historyEditorEnabled": false/);
    assert.match(readFileSync(path, "utf8"), /"toolResultProjectionMode": "off"/);
    assert.equal(loadUserConfig(join(directory, "missing.json")).warning, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
