import assert from "node:assert/strict";
import test from "node:test";
import { decideCompactionTrigger } from "../src/trigger.js";

test("extension trigger remains disabled when Pi controls the threshold", () => {
  const decision = decideCompactionTrigger({ currentTokens: 100_000, minimumGrowthTokens: 4_000, pending: false });
  assert.equal(decision.trigger, false);
  assert.match(decision.reason, /Pi controls/);
});

test("extension trigger fires at the configured threshold", () => {
  const decision = decideCompactionTrigger({
    currentTokens: 40_000,
    thresholdTokens: 40_000,
    minimumGrowthTokens: 4_000,
    pending: false,
  });
  assert.equal(decision.trigger, true);
  assert.match(decision.reason, /reached extension threshold/);
});

test("extension trigger uses pending and token-growth cooldown safeguards", () => {
  assert.equal(
    decideCompactionTrigger({
      currentTokens: 50_000,
      thresholdTokens: 40_000,
      minimumGrowthTokens: 4_000,
      pending: true,
    }).trigger,
    false,
  );
  const cooldown = decideCompactionTrigger({
    currentTokens: 52_500,
    thresholdTokens: 40_000,
    minimumGrowthTokens: 4_000,
    lastAttemptTokens: 50_000,
    pending: false,
  });
  assert.equal(cooldown.trigger, false);
  assert.match(cooldown.reason, /grew by 2500 token/);
  assert.equal(
    decideCompactionTrigger({
      currentTokens: 54_000,
      thresholdTokens: 40_000,
      minimumGrowthTokens: 4_000,
      lastAttemptTokens: 50_000,
      pending: false,
    }).trigger,
    true,
  );
});
