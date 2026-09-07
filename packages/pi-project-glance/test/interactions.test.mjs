import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ProjectGlanceFeedRegion, ProjectGlancePaneView } from "../dist/pane/main.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";
import { ProjectGlanceRelayRuntime } from "../dist/pi/lifecycle.js";
import { probeProjectGlanceRelay } from "../dist/protocol/client.js";
import { encodeFrame, ProjectGlanceFrameDecoder } from "../dist/protocol/framing.js";
import { PROJECT_GLANCE_CUSTOM_ENTRY_PREFIX, PROJECT_GLANCE_PROTOCOL_VERSION } from "../dist/protocol/model.js";
import { readConnectionDescriptor } from "../dist/runtime/connection-file.js";
import { deriveSessionKey } from "../dist/runtime/paths.js";

const AT = "2026-09-03T00:00:00.000Z";
const UI_TYPE = `${PROJECT_GLANCE_CUSTOM_ENTRY_PREFIX}ui-state-v1`;
const item = (id) => ({ id, type: "assistant_update", text: `update ${id}`, createdAt: AT });
const snapshot = (sessionKey, revision, overrides = {}) => ({
  protocolVersion: 1, sessionKey, revision, generatedAt: AT, branchId: "A",
  current: {}, feed: [item("one"), item("two"), item("three")],
  uiState: { dismissedIds: [], readIds: [] }, ...overrides,
});
const message = (id) => ({
  type: "message", id, parentId: null, timestamp: AT,
  message: { role: "assistant", stopReason: "stop", timestamp: Date.parse(AT), content: [{
    type: "text", text: `update ${id}`,
    textSignature: JSON.stringify({ v: 1, id: `sig-${id}`, phase: "commentary" }),
  }] },
});
const custom = (data) => ({ type: "custom", customType: UI_TYPE, data });

function context(state, sessionId = "interaction-session") {
  return { sessionManager: {
    getSessionId: () => sessionId,
    getLeafId: () => state.leaf,
    getBranch: () => state.branches[state.leaf] ?? [],
  } };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-interactions-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  try { await run({ root, environment }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function connectFrames(descriptor) {
  const socket = createConnection(descriptor.socketPath);
  const decoder = new ProjectGlanceFrameDecoder();
  const frames = [];
  socket.on("data", (chunk) => frames.push(...decoder.push(chunk)));
  return { socket, frames };
}

async function nextFrame(peer, predicate, timeoutMs = 2_000) {
  await waitFor(() => peer.frames.some(predicate), timeoutMs);
  const index = peer.frames.findIndex(predicate);
  return peer.frames.splice(index, 1)[0];
}

function hello(descriptor, requestId = "hello") {
  return { version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "hello", requestId,
    sessionKey: descriptor.sessionKey, token: descriptor.token, generation: descriptor.generation };
}

function action(descriptor, baseRevision, actionId, value, overrides = {}) {
  return { version: 1, type: "action", requestId: `request-${actionId}`, actionId,
    sessionKey: descriptor.sessionKey, generation: descriptor.generation,
    branchId: "A", baseRevision, action: value, ...overrides };
}

test("mouse click on the visible dismissal control activates its exact item URL", () => {
  const sessionKey = deriveSessionKey("pane-mouse-dismiss");
  const model = new ProjectGlancePaneModel(sessionKey);
  model.applySnapshot(snapshot(sessionKey, 1));
  const activated = [];
  const feed = new ProjectGlanceFeedRegion(model, (url) => activated.push(url));
  const width = 50;
  const lines = feed.render(width);
  const y = lines.findIndex((line) => line.includes("×"));
  const x = y >= 0 ? stripTerminalSequences(lines[y]).indexOf("×") : -1;
  assert.ok(x >= 0 && y >= 0, "rendered feed must expose a dismissal hit target");
  assert.ok(lines.every((line) => !line.includes("\u001b]8;")), "live controls must not depend on OSC links");
  assert.deepEqual(feed.handleMouse({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  }), { handled: true, render: true });
  assert.deepEqual(activated, ["project-glance://dismiss/one"]);
});

test("progress items render as width-bounded background cards with paragraph wrapping", () => {
  const sessionKey = deriveSessionKey("pane-card-layout");
  const model = new ProjectGlancePaneModel(sessionKey);
  model.applySnapshot(snapshot(sessionKey, 1, {
    feed: [{
      ...item("card"),
      text: "First paragraph has enough words to wrap safely.\n\nSecond paragraph stays separate and bounded.",
    }],
  }));
  const width = 24;
  const lines = new ProjectGlanceFeedRegion(model).render(width);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  const plain = lines.map(stripTerminalSequences);
  const top = plain.findIndex((line) => line.startsWith("┌"));
  const bottom = plain.findIndex((line) => line.startsWith("└"));
  assert.ok(top >= 0 && bottom > top, "one bordered card must surround the item");
  const cardStyle = "\u001b[48;5;236m\u001b[38;5;255m";
  for (const line of lines.slice(top, bottom + 1)) {
    assert.ok(line.startsWith(cardStyle));
    for (let offset = line.indexOf("\u001b[0m"); offset >= 0; offset = line.indexOf("\u001b[0m", offset + 4)) {
      const afterReset = offset + 4;
      if (afterReset < line.length) assert.ok(line.startsWith(cardStyle, afterReset));
    }
  }
  assert.ok(plain.slice(top, bottom + 1).some((line) => line.includes("First paragraph")));
  assert.ok(plain.slice(top, bottom + 1).some((line) => line.includes("Second paragraph")));
  assert.ok(plain.slice(top, bottom + 1).some((line) => /^│\s+│$/u.test(line)));
  for (const narrowWidth of [4, 8, 12]) {
    assert.ok(
      new ProjectGlanceFeedRegion(model).render(narrowWidth)
        .every((line) => visibleWidth(line) <= narrowWidth),
      `every feed row must fit width ${narrowWidth}`,
    );
  }
});

test("the complete CURRENT section uses one distinct width-bounded card", () => {
  const sessionKey = deriveSessionKey("pane-current-card");
  const model = new ProjectGlancePaneModel(sessionKey);
  model.applySnapshot(snapshot(sessionKey, 1, {
    current: {
      step: "Verify the current card at narrow width.",
      toward: "Complete Project Glance interactions.",
      focus: "Keep CURRENT pinned above the feed.",
    },
  }));
  const width = 30;
  const lines = new ProjectGlancePaneView(model).pinned.render(width);
  const plain = lines.map(stripTerminalSequences);
  const top = plain.findIndex((line) => line.startsWith("┌"));
  const bottom = plain.findIndex((line) => line.startsWith("└"));
  assert.equal(top, 0);
  assert.ok(bottom > top);
  assert.ok(plain.every((line) => line !== "Project Glance"));
  assert.ok(lines.slice(top, bottom + 1).every((line) => line.startsWith("\u001b[48;5;24m")));
  assert.ok(plain.slice(top, bottom + 1).some((line) => line.includes("CURRENT")));
  assert.ok(plain.slice(top, bottom + 1).some((line) => line.includes("Step:")));
  assert.ok(plain.slice(top, bottom + 1).some((line) => line.includes("Toward:")));
  assert.ok(plain.slice(top, bottom + 1).some((line) => line.includes("Focus:")));
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  for (const narrowWidth of [4, 8, 12]) {
    assert.ok(
      new ProjectGlancePaneView(model).pinned.render(narrowWidth)
        .every((line) => visibleWidth(line) <= narrowWidth),
    );
  }
});

test("oldest-unread focus scroll uses component row metadata after links are stripped", () => {
  const sessionKey = deriveSessionKey("pane-focus-scroll");
  const model = new ProjectGlancePaneModel(sessionKey);
  const feed = Array.from({ length: 20 }, (_, index) => item(`opaque-id-${index}`));
  model.applySnapshot(snapshot(sessionKey, 1, { feed }));
  const view = new ProjectGlancePaneView(model);
  const width = 32;
  const contentHeight = view.feed.render(view.scrollView.getContentWidth(width)).length;
  view.scrollView.updateLayout(contentHeight, 8, () => {});
  view.scrollView.scrollToEnd();
  const oldScrollTop = view.scrollView.scrollTop;
  assert.ok(oldScrollTop > 0);
  model.selectRelative(19);
  assert.equal(model.focusOldestUnread(), "opaque-id-0");
  view.scrollToSelected(width);
  assert.ok(view.scrollView.scrollTop < oldScrollTop, "selected oldest unread must be brought back into view");
  assert.equal(view.feed.selectedRow, 3);
});

test("pane interaction state calculates unread, hides dismissed, and preserves selection and expansion", () => {
  const sessionKey = deriveSessionKey("pane-interactions");
  const model = new ProjectGlancePaneModel(sessionKey);
  assert.equal(model.applySnapshot(snapshot(sessionKey, 1, {
    uiState: { dismissedIds: ["two"], readIds: ["one"] },
  })), "applied");
  assert.deepEqual(model.visibleFeed.map(({ id }) => id), ["one", "three"]);
  assert.equal(model.unreadCount, 1);
  assert.equal(model.selectedId, "three");
  assert.equal(model.isExpanded("three"), true);
  model.toggleExpanded("three");
  model.selectRelative(-1);
  assert.equal(model.selectedId, "one");
  assert.equal(model.isExpanded("three"), false);

  assert.equal(model.applySnapshot(snapshot(sessionKey, 2, {
    feed: [item("one"), item("three"), item("four")],
    uiState: { dismissedIds: [], readIds: ["one"] },
  })), "applied");
  assert.equal(model.selectedId, "one");
  assert.equal(model.isExpanded("three"), false);
  model.toggleExpanded("three");
  assert.equal(model.isExpanded("three"), true);

  assert.equal(model.applySnapshot(snapshot(sessionKey, 3, {
    feed: [item("three"), item("four")], uiState: { dismissedIds: [], readIds: [] },
  })), "applied");
  assert.equal(model.selectedId, "three", "removed selection falls back to oldest unread");
});

test("focusSerial requests oldest unread exactly once per increase", () => {
  const sessionKey = deriveSessionKey("pane-focus");
  const model = new ProjectGlancePaneModel(sessionKey);
  model.applySnapshot(snapshot(sessionKey, 1, { focusSerial: 1, uiState: { dismissedIds: [], readIds: ["one"] } }));
  assert.equal(model.consumeFocusRequest(), true);
  assert.equal(model.focusOldestUnread(), "two");
  assert.equal(model.consumeFocusRequest(), false);
  model.applySnapshot(snapshot(sessionKey, 2, { focusSerial: 1, uiState: { dismissedIds: [], readIds: ["one"] } }));
  assert.equal(model.consumeFocusRequest(), false);
  model.applySnapshot(snapshot(sessionKey, 3, { focusSerial: 2, uiState: { dismissedIds: [], readIds: ["one"] } }));
  assert.equal(model.consumeFocusRequest(), true);
  assert.equal(model.consumeFocusRequest(), false);

  model.setExpectedRelay({ sessionKey, generation: "b".repeat(32) });
  model.applySnapshot(snapshot(sessionKey, 1, { focusSerial: 1 }), {
    sessionKey,
    generation: "b".repeat(32),
  });
  assert.equal(
    model.consumeFocusRequest(),
    true,
    "a new relay generation must establish its own focus serial epoch",
  );
});

test("action server requires authentication and rejects stale identity, revision, and replay", async () => {
  await withRuntime(async ({ environment }) => {
    const state = { leaf: "A", branches: { A: [message("one"), message("two")] } };
    const ctx = context(state);
    const unreadCounts = [];
    const runtime = new ProjectGlanceRelayRuntime(
      environment,
      undefined,
      (data) => state.branches.A.push(custom(data)),
      (count) => unreadCounts.push(count),
    );
    try {
      await runtime.ensureForContext(ctx);
      const descriptor = await readConnectionDescriptor(runtime.descriptorPath);

      const unauthenticated = connectFrames(descriptor);
      unauthenticated.socket.write(encodeFrame(action(descriptor, 2, "unauth", { type: "mark_read", itemId: "one" })));
      assert.equal((await nextFrame(unauthenticated, (f) => f.type === "error")).code, "authentication_required");
      unauthenticated.socket.destroy();

      const peer = connectFrames(descriptor);
      peer.socket.write(encodeFrame(hello(descriptor)));
      await nextFrame(peer, (f) => f.type === "hello");
      const initial = (await nextFrame(peer, (f) => f.type === "snapshot")).snapshot;
      assert.equal(unreadCounts.at(-1), 2);

      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "bad-generation", { type: "mark_read", itemId: "one" }, { generation: "f".repeat(32) })));
      assert.equal((await nextFrame(peer, (f) => f.requestId === "request-bad-generation")).code, "authentication_failed");
      peer.socket.write(encodeFrame(action(descriptor, initial.revision - 1, "stale", { type: "mark_read", itemId: "one" })));
      assert.equal((await nextFrame(peer, (f) => f.requestId === "request-stale")).code, "stale_action");

      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "read", { type: "mark_read", itemId: "one" })));
      const readResult = await nextFrame(peer, (f) => f.type === "action_result" && f.actionId === "read");
      assert.ok(Number.isSafeInteger(readResult.revision) && readResult.revision > initial.revision);
      let current = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.deepEqual(current.uiState.readIds, ["one"]);
      assert.equal(unreadCounts.at(-1), 1);

      peer.socket.write(encodeFrame(action(descriptor, current.revision, "dismiss", { type: "dismiss", itemId: "two" })));
      await nextFrame(peer, (f) => f.type === "action_result" && f.actionId === "dismiss");
      current = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.deepEqual(current.uiState.dismissedIds, ["two"]);
      assert.equal(unreadCounts.at(-1), 0);

      peer.socket.write(encodeFrame(action(descriptor, current.revision, "focus", { type: "focus" })));
      await nextFrame(peer, (f) => f.type === "action_result" && f.actionId === "focus");
      current = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.deepEqual(current.uiState.readIds, ["one", "two"]);

      peer.socket.write(encodeFrame(action(descriptor, current.revision, "focus", { type: "focus" })));
      assert.equal((await nextFrame(peer, (f) => f.requestId === "request-focus")).code, "replayed_action");
      peer.socket.destroy();
    } finally { await runtime.stop(); }
  });
});

test("custom entries persist across branch ancestry and runtime close-reopen; passive snapshots append nothing", async () => {
  await withRuntime(async ({ environment }) => {
    const state = { leaf: "A", branches: { A: [message("one"), message("two")] } };
    const appended = [];
    const append = (data) => { const entry = custom(data); appended.push(entry); state.branches[state.leaf].push(entry); };
    const ctx = context(state, "persistence-session");
    let runtime = new ProjectGlanceRelayRuntime(environment, undefined, append);
    try {
      await runtime.ensureForContext(ctx);
      const beforeProbe = appended.length;
      await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.equal(appended.length, beforeProbe, "unattended snapshot must not generate state");

      const descriptor = await readConnectionDescriptor(runtime.descriptorPath);
      const peer = connectFrames(descriptor);
      peer.socket.write(encodeFrame(hello(descriptor)));
      await nextFrame(peer, (f) => f.type === "hello");
      const initial = (await nextFrame(peer, (f) => f.type === "snapshot")).snapshot;
      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "persist-read", { type: "mark_read", itemId: "one" })));
      await nextFrame(peer, (f) => f.type === "action_result");
      peer.socket.destroy();

      state.branches.B = [];
      state.leaf = "B";
      await runtime.onSessionTree(ctx);
      const branchB = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.deepEqual(branchB.feed, [], "an empty destination must clear old branch cards");
      assert.deepEqual(
        branchB.uiState.readIds,
        [],
        "a sibling branch must not inherit UI state recorded after divergence",
      );
      state.leaf = "A";
      await runtime.onSessionTree(ctx);
      assert.deepEqual((await probeProjectGlanceRelay(runtime.descriptorPath)).uiState.readIds, ["one"]);

      await runtime.restart("2026-09-03T00:00:01.000Z");
      assert.deepEqual((await probeProjectGlanceRelay(runtime.descriptorPath)).uiState.readIds, ["one"]);
      await runtime.stop();
      runtime = new ProjectGlanceRelayRuntime(environment, undefined, append);
      await runtime.ensureForContext(ctx);
      assert.deepEqual((await probeProjectGlanceRelay(runtime.descriptorPath)).uiState.readIds, ["one"]);
    } finally { await runtime.stop(); }
  });
});
