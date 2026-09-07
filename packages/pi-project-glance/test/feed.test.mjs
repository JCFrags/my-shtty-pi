import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import {
  boundRecentFeed,
  extractAssistantFeedItems,
  extractWorkplanEntryItem,
  parseTextSignature,
  rebuildProgressFeed,
} from "../dist/feed/index.js";

const AT = "2026-09-03T00:00:00.000Z";
const signature = (id, phase) => JSON.stringify({ v: 1, id, phase });
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason, timestamp: Date.parse(AT) });
const entry = (id, message, timestamp = AT) => ({ type: "message", id, parentId: null, timestamp, message });

test("TextSignatureV1 parsing is strict", () => {
  assert.deepEqual(parseTextSignature(signature("one", "commentary")), { id: "one", phase: "commentary" });
  assert.deepEqual(parseTextSignature(JSON.stringify({ v: 1, id: "one" })), { id: "one" });
  assert.equal(parseTextSignature(JSON.stringify({ v: 2, id: "one", phase: "commentary" })), undefined);
  assert.equal(parseTextSignature(JSON.stringify({ v: 1, id: "one", phase: "other" })), undefined);
});

test("message-level phased extraction emits one paragraph-preserving commentary card", () => {
  const result = extractAssistantFeedItems(assistant([
    { type: "text", text: "First paragraph", textSignature: signature("a", "commentary") },
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Final answer", textSignature: signature("b", "final_answer") },
    { type: "text", text: "Second paragraph", textSignature: signature("c", "commentary") },
  ]), "entry-one", AT);
  assert.deepEqual(result, [{ id: "entry-one", type: "assistant_update", text: "First paragraph\n\nSecond paragraph", createdAt: AT }]);
});

test("malformed structured phase metadata fails closed for the whole message", () => {
  for (const malformed of [
    JSON.stringify({ v: 2, id: "bad", phase: "commentary" }),
    "not-a-text-signature",
  ]) {
    assert.deepEqual(extractAssistantFeedItems(assistant([
      { type: "text", text: "safe", textSignature: signature("a", "commentary") },
      { type: "text", text: "unknown", textSignature: malformed },
    ]), "entry", AT), []);
  }
});

test("fallback is used only without phased metadata and before a successful tool call", () => {
  assert.equal(extractAssistantFeedItems(assistant([
    { type: "text", text: "Preparing" }, { type: "toolCall", id: "t", name: "read", arguments: {} }, { type: "text", text: "after" },
  ], "toolUse"), "entry", AT)[0].text, "Preparing");
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: "plain final" }]), "entry", AT), []);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: "unscoped", textSignature: JSON.stringify({ v: 1, id: "x" }) }]), "entry", AT), []);
});

test("production extraction requires a persisted safe source ID", () => {
  const message = assistant([{ type: "text", text: "update", textSignature: signature("a", "commentary") }]);
  assert.deepEqual(extractAssistantFeedItems(message, undefined, AT), []);
  assert.deepEqual(extractAssistantFeedItems(message, "/private/id", AT), []);
});

test("feed projection strips ANSI, preserves paragraphs, and rejects credentials and private keys", () => {
  assert.equal(extractAssistantFeedItems(assistant([{ type: "text", text: "\u001b[31mRed\u001b[0m\n\nNext", textSignature: signature("a", "commentary") }]), "entry", AT)[0].text, "Red\n\nNext");
  for (const secret of ["api_key=abcdefghijk", "Authorization: bearer-secret-value", ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")]) {
    assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: secret, textSignature: signature("a", "commentary") }]), "entry", AT), []);
  }
  assert.equal(JSON.stringify(extractAssistantFeedItems(assistant([{ type: "text", text: `Inspect ${homedir()}/file`, textSignature: signature("a", "commentary") }]), "entry", AT)).includes(homedir()), false);
});

test("active branch order is preserved regardless of timestamps", () => {
  const make = (id, text, at) => entry(id, assistant([{ type: "text", text, textSignature: signature(id, "commentary") }]), at);
  assert.deepEqual(rebuildProgressFeed([make("a", "A", "2026-09-03T00:00:03Z"), make("b", "B", "2026-09-03T00:00:01Z")]).map((item) => item.id), ["a", "b"]);
});

test("feed deduplicates IDs and adjacent normalized retry text", () => {
  const items = [
    { id: "a", type: "assistant_update", text: "same text", createdAt: AT },
    { id: "b", type: "assistant_update", text: "same   text", createdAt: AT },
    { id: "a", type: "assistant_update", text: "replacement", createdAt: AT },
  ];
  assert.deepEqual(boundRecentFeed(items).map((item) => item.id), ["a"]);
});

test("bounded reverse scan backfills fifty recent cards after retry deduplication", () => {
  const unique = Array.from({ length: 440 }, (_, index) =>
    entry(`e${index}`, assistant([{
      type: "text",
      text: `update ${index}`,
      textSignature: signature(`s${index}`, "commentary"),
    }])),
  );
  const retries = Array.from({ length: 60 }, (_, index) =>
    entry(`retry-${index}`, assistant([{
      type: "text",
      text: "same retry",
      textSignature: signature(`retry-signature-${index}`, "commentary"),
    }])),
  );
  const feed = rebuildProgressFeed([...unique, ...retries]);
  assert.equal(feed.length, 50);
  assert.equal(feed[0].id, "e391");
  assert.equal(feed.at(-1).id, "retry-0");
});

test("Workplan checkpoints include focus and next actions with privacy checks", () => {
  const activity = { version: 1, id: "workplan:1", type: "checkpoint_recorded", planId: "WP1", summary: "Saved", currentFocus: "Focus", nextActions: ["Verify"], at: AT };
  const item = extractWorkplanEntryItem(entry("work", { role: "toolResult", toolName: "workplan", details: { activity } }));
  assert.equal(item.text, "Checkpoint: Saved — Focus — Verify");
});
