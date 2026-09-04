import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  boundRecentFeed,
  compareFeedItems,
  extractAssistantFeedItems,
  extractAssistantEntryItems,
  extractWorkplanEntryItem,
  parseTextSignature,
  parseWorkplanActivity,
  rebuildProgressFeed,
} from "../dist/feed/index.js";
import { ProjectGlanceRelayRuntime } from "../dist/pi/lifecycle.js";
import { deriveSessionKey } from "../dist/runtime/paths.js";
import { probeProjectGlanceRelay } from "../dist/protocol/client.js";

const AT = "2026-09-03T00:00:00.000Z";
const COMMENTARY = JSON.stringify({ v: 1, id: "text-1", phase: "commentary" });
const FINAL_ANSWER = JSON.stringify({ v: 1, id: "text-final", phase: "final_answer" });

function assistant(content, stopReason = "stop", timestamp = Date.parse(AT)) {
  return {
    role: "assistant",
    content,
    stopReason,
    api: "test",
    provider: "test",
    model: "test",
    usage: {},
    timestamp,
  };
}

function entry(id, timestamp, message) {
  return { type: "message", id, parentId: null, timestamp, message };
}

function signed(text, signature = COMMENTARY) {
  return { type: "text", text, textSignature: signature };
}

function workplanActivity(overrides = {}) {
  return {
    version: 1,
    id: "workplan:WP1:3:checkpoint_recorded",
    type: "checkpoint_recorded",
    planId: "WP1",
    title: "Plan",
    summary: "Checkpoint saved",
    currentFocus: "Focus",
    nextActions: ["Verify"],
    at: AT,
    ...overrides,
  };
}

function workplanEntry(activity, id = "entry-workplan") {
  return entry(id, activity.at, {
    role: "toolResult",
    toolName: "workplan",
    content: [{ type: "text", text: "saved" }],
    details: {
      protocol: "grounded-state-result/v1",
      action: "checkpoint",
      activity,
      result: "saved",
    },
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class EventBus {
  #listeners = new Map();

  on(channel, handler) {
    const listeners = this.#listeners.get(channel) ?? new Set();
    listeners.add(handler);
    this.#listeners.set(channel, listeners);
    return () => listeners.delete(handler);
  }

  emit(channel, value) {
    for (const handler of [...(this.#listeners.get(channel) ?? [])]) handler(value);
  }
}

test("TextSignatureV1 preserves Pi's optional phase and rejects malformed signatures", () => {
  assert.deepEqual(parseTextSignature(COMMENTARY), { id: "text-1", phase: "commentary" });
  assert.deepEqual(parseTextSignature(JSON.stringify({ v: 1, id: "unscoped" })), { id: "unscoped" });
  assert.deepEqual(parseTextSignature(FINAL_ANSWER), { id: "text-final", phase: "final_answer" });
  for (const value of [
    "plain-signature",
    JSON.stringify({ v: 2, id: "wrong-version", phase: "commentary" }),
    JSON.stringify({ v: 1, id: "unknown-phase", phase: "system" }),
    JSON.stringify({ v: 1, id: "extra", phase: "commentary", extra: true }),
    "{malformed",
  ]) assert.equal(parseTextSignature(value), undefined);
});

test("assistant extraction keeps signed commentary and excludes thinking, final answers, malformed signatures, and unsafe text", () => {
  const home = homedir().replace(/\/+$/u, "");
  const message = assistant([
    { type: "thinking", thinking: "secret reasoning" },
    signed(`Inspect ${home}/project/file.ts`),
    signed("final answer", FINAL_ANSWER),
    signed("unknown signature", "legacy-signature"),
    signed("malformed signature", "{bad"),
    { type: "text", text: "/private/secret", textSignature: COMMENTARY },
  ]);
  const items = extractAssistantFeedItems(message, "entry-1", AT);
  assert.deepEqual(items, [{
    id: "entry-1:text-2",
    type: "assistant_update",
    text: "Inspect $HOME/project/file.ts",
    createdAt: AT,
  }]);
  assert.equal(JSON.stringify(items).includes(home), false);
});

test("explicit progress markers are safe narrow annotations while unscoped final text remains excluded", () => {
  const marker = "PROJECT GLANCE FEED CHECKPOINT: the live feed build is ready for validation.";
  const liveMarker = "PROJECT GLANCE LIVE UPDATE: this card should appear without reopening the pane.";
  const markerMessage = assistant([{ type: "text", text: marker, textSignature: JSON.stringify({ v: 1, id: "marker" }) }]);
  assert.deepEqual(extractAssistantFeedItems(markerMessage, "entry-marker", AT).map((item) => item.text), [marker]);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: marker, textSignature: JSON.stringify({ v: 1, id: "final-marker", phase: "final_answer" }) }]), "entry-final-marker", AT).map((item) => item.text), [marker]);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: liveMarker, textSignature: "provider-specific-signature" }]), "entry-malformed-marker", AT).map((item) => item.text), [liveMarker]);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: liveMarker, textSignature: JSON.stringify({ v: 2, id: "unknown-version" }) }]), "entry-unknown-marker", AT).map((item) => item.text), [liveMarker]);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: liveMarker }]), "entry-live-marker", AT).map((item) => item.text), [liveMarker]);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: "ordinary unscoped final", textSignature: JSON.stringify({ v: 1, id: "ordinary" }) }]), "entry-ordinary", AT), []);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: marker }]), "entry-unsigned-marker", AT).map((item) => item.text), [marker]);
});

test("fallback requires a tool call and captures only unsigned text before the first tool call", () => {
  const beforeTool = assistant([
    { type: "text", text: "Preparing the change" },
    { type: "thinking", thinking: "hidden" },
    { type: "toolCall", id: "tool-1", name: "edit", arguments: {} },
    { type: "text", text: "This is after the tool and must not appear" },
  ], "toolUse");
  const items = extractAssistantFeedItems(beforeTool, "entry-tool", AT);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "Preparing the change");

  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: "unsigned final" }]), "entry-final", AT), []);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: "partial" }, { type: "toolCall" }], "length"), "entry-length", AT), []);
  assert.deepEqual(extractAssistantFeedItems(assistant([{ type: "text", text: "error" }, { type: "toolCall" }], "error"), "entry-error", AT), []);
});

test("assistant IDs prefer persisted entry IDs and use deterministic hashes only when needed", () => {
  const message = assistant([signed("one")]);
  const withEntry = extractAssistantFeedItems(message, "persisted-entry", AT);
  assert.equal(withEntry[0].id, "persisted-entry");
  const withoutEntryA = extractAssistantFeedItems(message, undefined, AT);
  const withoutEntryB = extractAssistantFeedItems(structuredClone(message), undefined, AT);
  assert.equal(withoutEntryA[0].id, withoutEntryB[0].id);
  assert.match(withoutEntryA[0].id, /^feed:[0-9a-f]{64}$/u);
  assert.equal(withoutEntryA[0].id.includes("one"), false);
});

test("persisted Workplan activities are strict, private-safe, and map to feed items", () => {
  const checkpoint = workplanActivity();
  assert.deepEqual(parseWorkplanActivity(checkpoint), checkpoint);
  assert.deepEqual(extractWorkplanEntryItem(workplanEntry(checkpoint)), {
    id: checkpoint.id,
    type: "checkpoint",
    text: "Checkpoint: Checkpoint saved",
    createdAt: AT,
  });
  assert.deepEqual(extractWorkplanEntryItem(workplanEntry({
    ...checkpoint,
    id: "workplan:WP1:5:milestone_completed",
    type: "milestone_completed",
    title: "Milestone done",
    summary: undefined,
    currentFocus: undefined,
    nextActions: undefined,
  })), {
    id: "workplan:WP1:5:milestone_completed",
    type: "milestone_completed",
    text: "Milestone completed: Milestone done",
    createdAt: AT,
  });
  assert.deepEqual(extractWorkplanEntryItem(workplanEntry({
    ...checkpoint,
    id: "workplan:WP1:7:plan_completed",
    type: "plan_completed",
    title: "Plan done",
    summary: undefined,
    currentFocus: undefined,
    nextActions: undefined,
  })), {
    id: "workplan:WP1:7:plan_completed",
    type: "plan_completed",
    text: "Plan completed: Plan done",
    createdAt: AT,
  });
  assert.equal(parseWorkplanActivity({ ...checkpoint, summary: "/private/summary" }), undefined);
  assert.equal(extractWorkplanEntryItem({ ...workplanEntry(checkpoint), message: { role: "toolResult", toolName: "other", details: workplanEntry(checkpoint).message.details } }), undefined);
});

test("active-branch rebuild is chronological, capped, deduplicated, and ignores non-feed entries", () => {
  const items = [];
  for (let index = 0; index < 52; index += 1) {
    const at = new Date(Date.parse(AT) + index * 1_000).toISOString();
    items.push(entry(`entry-${index}`, at, assistant([signed(`update-${index}`)], "stop", Date.parse(at))));
  }
  items.push({ type: "thinking_level_change", id: "not-a-message", timestamp: AT });
  const feed = rebuildProgressFeed(items);
  assert.equal(feed.length, 50);
  assert.equal(feed[0].text, "update-2");
  assert.equal(feed.at(-1).text, "update-51");
  assert.equal(compareFeedItems(feed, rebuildProgressFeed(items)), true);
  assert.equal(boundRecentFeed([...feed, feed.at(-1)]).length, 50);
});

test("runtime rebuilds only the active getBranch after persistence and publishes feed without current regressions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-feed-runtime-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  const sessionId = "feed-runtime-session";
  const sessionKey = deriveSessionKey(sessionId);
  let branch = [entry("historical-entry", AT, assistant([signed("Historical commentary")] ))];
  let leafId = "leaf-a";
  let getBranchCalls = 0;
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getBranch: () => { getBranchCalls += 1; return branch; },
      getEntries: () => { throw new Error("DO_NOT_READ_ALL_ENTRIES"); },
    },
  };
  const runtime = new ProjectGlanceRelayRuntime(environment, new EventBus());
  try {
    await runtime.ensureForContext(ctx);
    await waitFor(() => runtime.feed.some((item) => item.text === "Historical commentary"));
    assert.equal(runtime.feed[0].id, "historical-entry");
    const firstRevision = (await probeProjectGlanceRelay(runtime.descriptorPath)).revision;

    branch = [entry("active-entry", "2026-09-03T00:00:01.000Z", assistant([signed("Live commentary")]))];
    runtime.onMessageEnd(ctx);
    await waitFor(() => runtime.feed.some((item) => item.text === "Live commentary"));
    const live = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.ok(live.revision > firstRevision);
    assert.deepEqual(live.feed.map((item) => item.text), ["Live commentary"]);

    branch = [entry("active-entry-2", "2026-09-03T00:00:02.000Z", assistant([signed("Live commentary 2")]))];
    leafId = "active-entry-2";
    runtime.onMessageEnd(ctx);
    await waitFor(() => runtime.feed.some((item) => item.text === "Live commentary 2"));
    const secondLive = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.deepEqual(secondLive.feed.map((item) => item.text), ["Live commentary 2"]);
    assert.ok(getBranchCalls >= 3);

    branch = [entry("stale-entry", "2026-09-03T00:00:03.000Z", assistant([signed("Stale branch commentary")]))];
    leafId = "stale-entry";
    runtime.onMessageEnd(ctx);
    const previousBranch = branch;
    branch = [workplanEntry(workplanActivity({
      id: "workplan:WP1:7:plan_completed",
      type: "plan_completed",
      title: "Finished plan",
      summary: undefined,
      currentFocus: undefined,
      nextActions: undefined,
      at: "2026-09-03T00:00:04.000Z",
    }), "active-workplan")];
    leafId = "leaf-b";
    const callsBeforeTreeTransition = getBranchCalls;
    await runtime.onSessionTree(ctx);
    await waitFor(() => runtime.feed.some((item) => item.text === "Plan completed: Finished plan"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getBranchCalls, callsBeforeTreeTransition + 1);
    assert.deepEqual(runtime.feed.map((item) => item.text), ["Plan completed: Finished plan"]);
    assert.equal(runtime.feed.some((item) => item.text === "Stale branch commentary"), false);
    assert.notEqual(branch, previousBranch);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
