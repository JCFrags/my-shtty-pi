import assert from "node:assert/strict";
import test from "node:test";
import { isSafeCompactionCut, isValidCompactionCut, selectDynamicRawTail, selectRawTail } from "../src/tail-selection.js";
import type { SessionEntryLike } from "../src/types.js";

function message(id: string, role: string, tokens: number): SessionEntryLike {
  return { type: "message", id, parentId: null, message: { role, content: "x".repeat(tokens * 4) }, testTokens: tokens };
}

function estimate(entries: readonly SessionEntryLike[]): number {
  return entries.reduce((sum, entry) => sum + (typeof entry.testTokens === "number" ? entry.testTokens : 0), 0);
}

test("fixed raw-tail selection uses a valid cut and meets the target without filling extra history", () => {
  const entries = [
    message("old-user", "user", 1_000),
    message("old-assistant", "assistant", 1_000),
    message("tool-result", "toolResult", 1_000),
    message("new-assistant", "assistant", 1_000),
    message("new-user", "user", 1_000),
  ];
  const selected = selectRawTail(entries, 1_500, estimate);
  assert.ok(selected);
  assert.equal(selected.firstKeptEntryId, "new-assistant");
  assert.equal(selected.actualTokens, 2_000);
  assert.equal(isValidCompactionCut(entries[2]!), false, "a tool result must not become the cut point");
});

test("raw-tail selection excludes an orphan tool result that arrived after its call was lost", () => {
  const entries: SessionEntryLike[] = [
    message("old-user", "user", 1_000),
    message("old-assistant", "assistant", 1_000),
    {
      type: "message",
      id: "orphan-result",
      parentId: null,
      testTokens: 1_000,
      message: { role: "toolResult", toolCallId: "lost-call", toolName: "bash", content: "completed after compaction" },
    },
    message("safe-assistant", "assistant", 1_000),
    message("safe-user", "user", 1_000),
  ];
  assert.equal(isSafeCompactionCut(entries, 1), false, "the retained suffix would contain an orphan function output");
  assert.equal(isSafeCompactionCut(entries, 3), true, "a cut after the orphan output is structurally safe");
  const selected = selectRawTail(entries, 3_500, estimate);
  assert.ok(selected);
  assert.equal(selected.firstKeptEntryId, "safe-assistant");
  assert.equal(selected.actualTokens, 2_000);
  assert.match(selected.reason, /largest available tail/);
});

test("fixed raw-tail selection uses the largest available valid tail when the session is shorter than the target", () => {
  const entries = [message("history", "user", 500), message("kept", "assistant", 600), message("result", "toolResult", 400)];
  const selected = selectRawTail(entries, 5_000, estimate);
  assert.ok(selected);
  assert.equal(selected.firstKeptEntryId, "kept");
  assert.equal(selected.actualTokens, 1_000);
  assert.match(selected.reason, /largest available tail/);
});

test("dynamic raw-tail selection is bounded and reports its deterministic reason", () => {
  const entries = [
    message("old", "user", 6_000),
    message("old-answer", "assistant", 4_000),
    message("current", "user", 3_000),
    message("current-answer", "assistant", 2_000),
  ];
  const selected = selectDynamicRawTail(entries, 8_000, 10_000, estimate);
  assert.ok(selected);
  assert.equal(selected.mode, "dynamic");
  assert.equal(selected.desiredTokens, 8_000);
  assert.ok(selected.actualTokens >= 8_000);
  assert.match(selected.reason, /5000-token current turn.*1500-token continuity margin.*8000–10000/);
});
