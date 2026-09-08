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
import { ProjectGlanceClient, probeProjectGlanceRelay } from "../dist/protocol/client.js";
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
  model.toggleExpanded("card");
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
  assert.equal(view.feed.selectedRow, 2, "focus includes the clickable top border");
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
  assert.equal(model.isExpanded("three"), false);
  model.toggleExpanded("three");
  model.selectRelative(-1);
  assert.equal(model.selectedId, "one");
  assert.equal(model.isExpanded("three"), true);

  assert.equal(model.applySnapshot(snapshot(sessionKey, 2, {
    feed: [item("one"), item("three"), item("four")],
    uiState: { dismissedIds: [], readIds: ["one"] },
  })), "applied");
  assert.equal(model.selectedId, "one");
  assert.equal(model.isExpanded("three"), true);
  assert.equal(model.isExpanded("four"), false);
  model.toggleExpanded("three");
  assert.equal(model.isExpanded("three"), false);

  assert.equal(model.applySnapshot(snapshot(sessionKey, 3, {
    feed: [item("three"), item("four")], uiState: { dismissedIds: [], readIds: [] },
  })), "applied");
  assert.equal(model.selectedId, "three", "removed selection falls back to oldest unread");
});

test("focusSerial uses a passive connection baseline and requests focus only for live increases", () => {
  const sessionKey = deriveSessionKey("pane-focus");
  const model = new ProjectGlancePaneModel(sessionKey);
  model.applySnapshot(snapshot(sessionKey, 1, { focusSerial: 1, uiState: { dismissedIds: [], readIds: ["one"] } }));
  assert.equal(model.consumeFocusRequest(), false);
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
    false,
    "a new relay generation must not replay old focus",
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
      assert.deepEqual(current.feed.map((item) => item.id), ["one"]);
      assert.equal(state.branches.A.at(-1).data.action, "dismiss");
      assert.equal(unreadCounts.at(-1), 0);

      peer.socket.write(encodeFrame(action(descriptor, current.revision, "focus", { type: "focus" })));
      await nextFrame(peer, (f) => f.type === "action_result" && f.actionId === "focus");
      current = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.deepEqual(current.uiState.readIds, ["one"]);

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

test("repeated focus/read/dismiss are idempotent and dismissal backfills across restart", async () => {
  await withRuntime(async ({ environment }) => {
    const state = { leaf: "A", branches: { A: Array.from({ length: 70 }, (_, i) => message(`m${i}`)) } };
    const appended = [];
    const runtime = new ProjectGlanceRelayRuntime(environment, undefined, (data) => { appended.push(data); state.branches.A.push(custom(data)); });
    try {
      await runtime.ensureForContext(context(state));
      const descriptor = await readConnectionDescriptor(runtime.descriptorPath);
      const peer = connectFrames(descriptor);
      peer.socket.write(encodeFrame(hello(descriptor)));
      await nextFrame(peer, (f) => f.type === "snapshot");
      let sequence = 0;
      const send = async (value) => {
        const current = await probeProjectGlanceRelay(runtime.descriptorPath);
        const id = `idempotent-${sequence++}`;
        peer.socket.write(encodeFrame(action(descriptor, current.revision, id, value)));
        return nextFrame(peer, (f) => f.actionId === id || f.requestId === `request-${id}`);
      };
      assert.equal((await send({ type: "focus" })).accepted, true);
      assert.equal(appended.length, 50);
      for (let i = 0; i < 20; i++) assert.equal((await send({ type: "focus" })).accepted, true);
      await send({ type: "mark_read", itemId: "m69" });
      assert.equal(appended.length, 50);
      await send({ type: "dismiss", itemId: "m69" });
      await send({ type: "dismiss", itemId: "m69" });
      assert.equal(appended.length, 51);
      assert.equal(runtime.feed.length, 50);
      assert.equal(runtime.feed[0].id, "m19");
      assert.equal(runtime.feed.at(-1).id, "m68");
      peer.socket.destroy();
      await runtime.restart();
      assert.equal(runtime.feed[0].id, "m19");
      const restored = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.equal(restored.uiState.readIds.length, 49);
      assert.equal(appended.length, 51);
    } finally { await runtime.stop(); }
  });
});

test("rapid client actions serialize and never broaden stale focus to unseen arrivals", async () => {
  await withRuntime(async ({ environment }) => {
    const state = { leaf: "A", branches: { A: [message("one"), message("two"), message("three")] } };
    const appended = [];
    const counts = [];
    const runtime = new ProjectGlanceRelayRuntime(environment, undefined, (data) => { appended.push(data); state.branches[state.leaf].push(custom(data)); }, (n) => counts.push(n));
    let latest;
    let client;
    try {
      await runtime.ensureForContext(context(state));
      client = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath, onSnapshot: (s) => { latest = s; } });
      client.start();
      await waitFor(() => latest !== undefined);
      const original = latest;
      client.sendAction("A", original.revision, { type: "mark_read", itemId: "one" });
      client.sendAction("A", original.revision, { type: "dismiss", itemId: "two" });
      client.sendAction("A", original.revision, { type: "mark_read", itemId: "three" });
      client.sendAction("A", original.revision, { type: "focus" });
      await waitFor(() => appended.length === 3);
      await waitFor(() => latest.uiState.readIds.includes("three"));
      assert.deepEqual(appended.map((x) => [x.action, x.itemId]), [["mark_read", "one"], ["dismiss", "two"], ["mark_read", "three"]]);
      state.branches.A.push(message("arrival"));
      await runtime.syncFeed(context(state));
      client.sendAction("A", original.revision, { type: "focus" });
      await waitFor(() => latest.feed.some((i) => i.id === "arrival"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(appended.length, 3);
      assert.equal(counts.at(-1), 1);
    } finally { client?.stop(); await runtime.stop(); }
    assert.equal(counts.at(-1), 0, "runtime disposal clears compact attention status");
  });
});

test("reconnect and branch snapshots never replay focus or discard a retained reading anchor", () => {
  const sessionKey = deriveSessionKey("reading-anchor");
  const identity = { sessionKey, generation: "a".repeat(32) };
  const model = new ProjectGlancePaneModel();
  model.setExpectedRelay(identity);
  const feed = Array.from({ length: 50 }, (_, i) => item(`m${i}`));
  model.applySnapshot(snapshot(sessionKey, 1, { feed, focusSerial: 8 }), identity);
  assert.equal(model.consumeFocusRequest(), false);
  const view = new ProjectGlancePaneView(model);
  const width = 40;
  const layout = () => view.scrollView.updateLayout(view.feed.render(width).length, 8, () => {});
  layout();
  view.scrollView.scrollTo(view.feed.rowForItem("m20") + 2);
  const anchor = view.feed.anchorAt(view.scrollView.scrollTop);
  view.preserveReadingPosition();
  model.setExpectedRelay(identity);
  model.applySnapshot(snapshot(sessionKey, 2, { feed: [...feed.slice(1), item("m50")], focusSerial: 9 }), identity);
  layout();
  assert.equal(model.consumeFocusRequest(), false, "missed focus while disconnected is not a live action");
  assert.deepEqual(view.feed.anchorAt(view.scrollView.scrollTop), anchor);
  model.applySnapshot(snapshot(sessionKey, 3, { feed, focusSerial: 10 }), identity);
  assert.equal(model.consumeFocusRequest(), true);
  model.applySnapshot(snapshot(sessionKey, 4, { branchId: "B", feed: [item("other")], focusSerial: 10 }), identity);
  assert.equal(model.consumeFocusRequest(), false);
  assert.equal(model.selectedId, "other");
});

test("an explicit open focus waits for the passive baseline and cannot survive a branch transition", async () => {
  await withRuntime(async ({ environment }) => {
    const state = { leaf: "A", branches: { A: [message("one")], B: [] } };
    const runtime = new ProjectGlanceRelayRuntime(environment, undefined, (data) => state.branches[state.leaf].push(custom(data)));
    const model = new ProjectGlancePaneModel();
    let client;
    let liveFocus = 0;
    try {
      await runtime.ensureForContext(context(state));
      const focused = runtime.capturePaneFocus();
      const pending = focused();
      client = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath,
        onDescriptor: (d) => model.setExpectedRelay(d),
        onSnapshot: (s, identity) => { model.applySnapshot(s, identity); if (model.consumeFocusRequest()) liveFocus++; },
      });
      client.start();
      await pending;
      await waitFor(() => liveFocus === 1);
      const staleFocus = runtime.capturePaneFocus();
      state.leaf = "B";
      await runtime.onSessionTree(context(state));
      await staleFocus();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(liveFocus, 1);
      assert.equal(state.branches.A.length, 1, "focus delivery alone is not a read acknowledgement");
      assert.equal(state.branches.B.length, 0);
    } finally { client?.stop(); await runtime.stop(); }
  });
});

test("synthetic persisted Pi session restores UI state without replay or extra records", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  await withRuntime(async ({ root, environment }) => {
    const sm = SessionManager.create(root, join(root, "sessions"));
    sm.appendMessage({ role: "user", content: "Synthetic fixture", timestamp: Date.parse(AT) });
    const id = sm.appendMessage(message("synthetic").message);
    const ctx = { sessionManager: sm };
    let runtime = new ProjectGlanceRelayRuntime(environment, undefined, (data) => sm.appendCustomEntry(UI_TYPE, data));
    try {
      await runtime.ensureForContext(ctx);
      const descriptor = await readConnectionDescriptor(runtime.descriptorPath);
      const peer = connectFrames(descriptor);
      peer.socket.write(encodeFrame(hello(descriptor)));
      const initial = (await nextFrame(peer, (f) => f.type === "snapshot")).snapshot;
      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "disk-read", { type: "mark_read", itemId: id }, { branchId: runtime.branchId })));
      await nextFrame(peer, (f) => f.type === "action_result");
      peer.socket.destroy();
      await runtime.stop();
      const restored = SessionManager.open(sm.getSessionFile());
      const before = restored.getEntries().length;
      runtime = new ProjectGlanceRelayRuntime(environment, undefined, (data) => restored.appendCustomEntry(UI_TYPE, data));
      await runtime.ensureForContext({ sessionManager: restored });
      const current = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.deepEqual(current.uiState.readIds, [id]);
      await runtime.ensureForContext({ sessionManager: restored });
      assert.equal(restored.getEntries().length, before);
    } finally { await runtime.stop(); }
  });
});

test("old branch actions and delayed open completion cannot write into a destination or restarted runtime", async () => {
  await withRuntime(async ({ environment }) => {
    const state = { leaf: "A", branches: { A: [message("one")], B: [message("destination")] } };
    const appended = [];
    const runtime = new ProjectGlanceRelayRuntime(environment, undefined, (data) => { appended.push(data); state.branches[state.leaf].push(custom(data)); });
    try {
      await runtime.ensureForContext(context(state));
      const descriptor = await readConnectionDescriptor(runtime.descriptorPath);
      const peer = connectFrames(descriptor);
      peer.socket.write(encodeFrame(hello(descriptor)));
      const initial = (await nextFrame(peer, (f) => f.type === "snapshot")).snapshot;
      const delayed = runtime.capturePaneFocus();
      state.leaf = "B";
      const transition = runtime.onSessionTree(context(state));
      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "old-branch", { type: "focus" })));
      await transition;
      const rejected = await nextFrame(peer, (f) => f.requestId === "request-old-branch");
      assert.equal(rejected.type, "error");
      assert.equal(appended.length, 0);
      await runtime.restart();
      await delayed();
      const restarted = await probeProjectGlanceRelay(runtime.descriptorPath);
      assert.equal(restarted.focusSerial, undefined);
      assert.deepEqual(restarted.uiState.readIds, []);
      assert.deepEqual(restarted.feed.map((i) => i.id), ["destination"]);
      peer.socket.destroy();
    } finally { await runtime.stop(); }
  });
});

test("UI restoration scans long ancestry without resurrecting old dismissals or unread state", async () => {
  await withRuntime(async ({ environment }) => {
    const branch = Array.from({ length: 70 }, (_, i) => message(`m${i}`));
    branch.push(custom({ version: 1, action: "mark_read", itemId: "m20" }));
    branch.push(custom({ version: 1, action: "dismiss", itemId: "m69" }));
    branch.push(...Array.from({ length: 1500 }, (_, i) => custom({ version: 1, action: "mark_read", itemId: `irrelevant-${i}` })));
    const state = { leaf: "A", branches: { A: branch } };
    const runtime = new ProjectGlanceRelayRuntime(environment);
    try {
      await runtime.ensureForContext(context(state));
      for (let i = 0; i < 2; i++) {
        const s = await probeProjectGlanceRelay(runtime.descriptorPath);
        assert.equal(s.feed.length, 50);
        assert.equal(s.feed[0].id, "m19");
        assert.equal(s.feed.some((x) => x.id === "m69"), false);
        assert.deepEqual(s.uiState.readIds, ["m20"]);
        await runtime.restart();
      }
    } finally { await runtime.stop(); }
  });
});

test("cards start with two preview lines and visible mouse expand/collapse controls", () => {
  const key = deriveSessionKey("two-line-preview");
  const model = new ProjectGlancePaneModel(key);
  model.applySnapshot(snapshot(key, 1, { feed: [{ ...item("preview"), text: "First preview line\nSecond preview line\nThird expanded line" }] }));
  const feed = new ProjectGlanceFeedRegion(model, (url) => {
    const target = new URL(url);
    if (target.hostname === "toggle") model.toggleExpanded(decodeURIComponent(target.pathname.slice(1)));
  });
  const width = 40;
  const plain = () => feed.render(width).map(stripTerminalSequences);
  const click = (label) => {
    const rows = plain(); const y = rows.findIndex((line) => line.includes(label));
    assert(y >= 0); const x = rows[y].indexOf(label);
    assert.equal(feed.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: rows.length, shift: false, alt: false, ctrl: false, clickCount: 1 }).handled, true);
  };
  assert.equal(model.isExpanded("preview"), false);
  const initial = plain();
  assert(initial.some((line) => line.includes("First preview line")));
  assert(initial.some((line) => line.includes("Second preview line")));
  assert(!initial.some((line) => line.includes("Third expanded line")));
  assert.equal(initial.findIndex((line) => line.startsWith("└")) - initial.findIndex((line) => line.startsWith("┌")), 4);
  click("▸"); assert.equal(model.isExpanded("preview"), true);
  assert(plain().some((line) => line.includes("Third expanded line")));
  click("▾"); assert.equal(model.isExpanded("preview"), false);
  assert(!plain().some((line) => line.includes("Third expanded line")));
  for (const narrow of [20, 24, 28]) {
    const rows = feed.render(narrow);
    assert(rows.every((line) => visibleWidth(line) <= narrow));
    assert(rows.some((line) => line.includes("×")));
    assert(rows.some((line) => line.includes("▸")));
  }
});

test("collapsed previews mark only hidden content with a width-bounded ellipsis", () => {
  const key = deriveSessionKey("preview-ellipsis");
  for (const text of ["One line", "One line\nTwo lines", "One line\nTwo lines\nHidden third line", "界".repeat(90)]) {
    const model = new ProjectGlancePaneModel(key);
    model.applySnapshot(snapshot(key, 1, { feed: [{ ...item("preview"), text }] }));
    const feed = new ProjectGlanceFeedRegion(model);
    for (const width of [8, 20, 40]) {
      const collapsed = feed.render(width).map(stripTerminalSequences);
      const body = collapsed.filter((line) => line.startsWith("│  "));
      assert(body.length <= 2);
      assert(collapsed.every((line) => visibleWidth(line) <= width));
      model.toggleExpanded("preview");
      const expanded = feed.render(width).map(stripTerminalSequences);
      const fullBody = expanded.filter((line) => line.startsWith("│  "));
      assert.equal(body.some((line) => line.includes("…")), fullBody.length > 2);
      assert(fullBody.every((line) => !line.includes("…")));
      model.toggleExpanded("preview");
    }
  }
});

test("every card cell toggles except the top-right dismissal; gaps stay inert", () => {
  const key = deriveSessionKey("whole-card-click");
  const model = new ProjectGlancePaneModel(key);
  model.applySnapshot(snapshot(key, 1, { feed: [{ ...item("card"), text: "First line\nSecond line\nMore text" }] }));
  const activated = [];
  const feed = new ProjectGlanceFeedRegion(model, (url) => activated.push(url));
  for (const width of [1, 2, 3, 4, 20, 40]) {
    for (const expanded of [false, true]) {
      if (model.isExpanded("card") !== expanded) model.toggleExpanded("card");
      const rows = feed.render(width).map(stripTerminalSequences);
      const top = 2;
      const bottom = rows.length - 2;
      const dismissY = top + (width >= 4 ? 1 : 0);
      const closeLabel = width >= 5 || width === 3 ? "[×]" : "×";
      const dismissX = rows[dismissY].indexOf(closeLabel);
      assert(dismissX >= 0);
      if (width >= 4) assert.equal(rows[top], `┌${"─".repeat(width - 2)}┐`);
      if (width >= 20) {
        assert(rows[dismissY].endsWith("[×] │"));
        assert(rows[dismissY].includes(expanded ? "▾" : "▸"));
        assert(!/Expand|Collapse/u.test(rows[dismissY]));
      }
      assert(rows.every((row) => visibleWidth(row) <= width));
      for (let y = top; y <= bottom + 1; y++) {
        for (let x = 0; x < width; x++) {
          const before = activated.length;
          feed.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y,
            width, height: rows.length, shift: false, alt: false, ctrl: false, clickCount: 1 });
          if (y > bottom) assert.equal(activated.length, before, "inter-card gap is inert");
          else {
            assert.equal(activated.length, before + 1);
            assert.equal(activated.at(-1), `project-glance://${y === dismissY && x >= dismissX && x < dismissX + closeLabel.length ? "dismiss" : "toggle"}/card`);
          }
        }
      }
    }
  }
});
