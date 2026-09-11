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
import { ProjectGlanceClient } from "../dist/protocol/client.js";
import { encodeFrame, ProjectGlanceFrameDecoder } from "../dist/protocol/framing.js";
import { PROJECT_GLANCE_PROTOCOL_VERSION } from "../dist/protocol/model.js";
import { readConnectionDescriptor } from "../dist/runtime/connection-file.js";
import { deriveSessionKey } from "../dist/runtime/paths.js";

const AT = "2026-09-03T00:00:00.000Z";
const item = (id) => ({ id, type: "assistant_update", text: `update ${id}`, createdAt: AT });
const snapshot = (sessionKey, revision, overrides = {}) => ({
  protocolVersion: 1, sessionKey, revision, generatedAt: AT, branchId: "A",
  current: {}, feed: [item("one"), item("two"), item("three")],
  uiState: { dismissedIds: [], readIds: [] }, ...overrides,
});
const message = (id) => ({
  type: "message", id, parentId: null, timestamp: AT,
  message: {
    role: "assistant", api: "openai-responses", provider: "synthetic", model: "synthetic",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.parse(AT), content: [{
      type: "text", text: `update ${id}`,
      textSignature: JSON.stringify({ v: 1, id: `sig-${id}`, phase: "commentary" }),
    }],
  },
});
async function waitFor(predicate, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-interactions-"));
  const environment = {
    ...process.env,
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
  };
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

test("Inbox navigation keeps item anchors without acknowledging attention", () => {
  const sessionKey = deriveSessionKey("pane-inbox-anchor");
  const model = new ProjectGlancePaneModel(sessionKey);
  model.applySnapshot(snapshot(sessionKey, 1, {
    feed: [],
    archive: { inboxCount: 40, historyCount: 0, commitSeq: 1, state: "ready" },
  }));
  model.archive.receivePage("inbox", undefined, {
    branchId: "A", view: "inbox", snapshotSeq: 1,
    items: Array.from({ length: 25 }, (_, index) => ({ itemId: `i${index}`, type: "assistant_update", preview: `Inbox ${index}`, createdAt: AT, bodyBytes: 20 })),
    nextCursor: "older-25",
  }, true);
  model.reconcileSelection();
  const view = new ProjectGlancePaneView(model);
  const width = 32;
  const layout = () => view.scrollView.updateLayout(view.feed.render(width).length, 8, () => {});
  layout();
  view.scrollView.scrollTo(view.feed.rowForItem("i12") + 1);
  const anchor = view.feed.anchorAt(view.scrollView.scrollTop);
  view.preserveReadingPosition();
  model.archive.receivePage("inbox", "older-25", {
    branchId: "A", view: "inbox", snapshotSeq: 1,
    items: Array.from({ length: 15 }, (_, index) => ({ itemId: `i${index + 25}`, type: "assistant_update", preview: `Inbox ${index + 25}`, createdAt: AT, bodyBytes: 20 })),
    previousCursor: "newer-25",
  }, false);
  layout();
  assert.deepEqual(view.feed.anchorAt(view.scrollView.scrollTop), anchor);
  assert.equal(model.archive.summary.inboxCount, 40);
  assert.deepEqual(model.snapshot.uiState?.readIds, []);
});

test("durable pages retain every card and dismissal moves one card to permanent History", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  await withRuntime(async ({ root, environment }) => {
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Synthetic durable inbox", timestamp: Date.parse(AT) });
    Array.from({ length: 70 }, (_, index) => manager.appendMessage(message(`m${index}`).message));
    const runtime = new ProjectGlanceRelayRuntime(environment);
    let client;
    let latest;
    try {
      await runtime.ensureForContext({ sessionManager: manager });
      client = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath, onSnapshot: (value) => { latest = value; } });
      client.start();
      await waitFor(() => latest?.archive?.inboxCount === 70);
      assert.deepEqual(latest.feed, [], "archive-backed snapshots do not duplicate the first page");
      const first = await client.requestPage(runtime.branchId, "inbox");
      assert.equal(first.items.length, 25);
      assert.deepEqual(first.items.map((value) => value.preview), Array.from({ length: 25 }, (_, index) => `update m${index}`), "Inbox is oldest first");
      const second = await client.requestPage(runtime.branchId, "inbox", first.nextCursor);
      assert.deepEqual(second.items.map((value) => value.preview), Array.from({ length: 25 }, (_, index) => `update m${index + 25}`));
      const third = await client.requestPage(runtime.branchId, "inbox", second.nextCursor);
      assert.deepEqual(third.items.map((value) => value.preview), Array.from({ length: 20 }, (_, index) => `update m${index + 50}`));
      const itemIds = [...first.items, ...second.items, ...third.items].map((value) => value.itemId);
      assert.equal(new Set(itemIds).size, 70, "pagination retains every durable card exactly once");
      const dismissedId = first.items[0].itemId;
      const revision = latest.revision;
      await client.sendFeedAction(runtime.branchId, revision, { type: "dismiss", itemId: dismissedId });
      await waitFor(() => latest?.archive?.inboxCount === 69 && latest?.archive?.historyCount === 1);
      const inbox = await client.requestPage(runtime.branchId, "inbox");
      const history = await client.requestPage(runtime.branchId, "history");
      assert.equal(inbox.items.some((value) => value.itemId === dismissedId), false);
      assert.deepEqual(history.items.map((value) => value.itemId), [dismissedId]);
      assert.equal(history.items[0].archivedAt !== undefined, true);
      assert.deepEqual(latest.uiState?.readIds ?? [], [], "dismissal does not create read acknowledgements");
      client.stop();
      client = undefined;
      await runtime.restart("2026-09-03T00:00:01.000Z");
      let restartedSnapshot;
      client = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath, onSnapshot: (value) => { restartedSnapshot = value; } });
      client.start();
      await waitFor(() => restartedSnapshot?.archive?.historyCount === 1);
      assert.equal((await client.requestPage(runtime.branchId, "history")).items[0].itemId, dismissedId, "History survives relay restart");
    } finally { client?.stop(); await runtime.stop(); }
  });
});

test("paged body transport keeps the full source behind a bounded preview", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  await withRuntime(async ({ root, environment }) => {
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Synthetic long body", timestamp: Date.parse(AT) });
    const long = "界 durable paragraph ".repeat(3_000);
    manager.appendMessage({
      role: "assistant", api: "openai-responses", provider: "synthetic", model: "synthetic",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: Date.parse(AT), content: [
        { type: "text", text: long },
        { type: "toolCall", id: "tool", name: "read", arguments: {} },
      ],
    });
    const runtime = new ProjectGlanceRelayRuntime(environment);
    let client;
    let latest;
    try {
      await runtime.ensureForContext({ sessionManager: manager });
      client = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath, onSnapshot: (value) => { latest = value; } });
      client.start();
      await waitFor(() => latest?.archive?.inboxCount === 1);
      const page = await client.requestPage(runtime.branchId, "inbox");
      assert.equal(page.items.length, 1);
      const card = page.items[0];
      assert.ok(card.bodyBytes > Buffer.byteLength(card.preview, "utf8"));
      const first = await client.requestBody(runtime.branchId, card.itemId, 0);
      assert.ok(Buffer.byteLength(first.text, "utf8") <= 24 * 1024);
      assert.equal(first.previousOffset, undefined);
      const second = await client.requestBody(runtime.branchId, card.itemId, first.nextOffset);
      assert.equal(second.previousOffset, 0);
      assert.equal(second.bodyDigest, first.bodyDigest);
      assert.equal(second.totalBytes, first.totalBytes);
    } finally { client?.stop(); await runtime.stop(); }
  });
});

test("dismiss action requires authentication and rejects stale identity and replay", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  await withRuntime(async ({ root, environment }) => {
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Synthetic action checks", timestamp: Date.parse(AT) });
    manager.appendMessage(message("one").message);
    const runtime = new ProjectGlanceRelayRuntime(environment);
    try {
      await runtime.ensureForContext({ sessionManager: manager });
      let discoverySnapshot;
      const discovery = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath, onSnapshot: (value) => { discoverySnapshot = value; } });
      discovery.start();
      await waitFor(() => discoverySnapshot?.archive?.inboxCount === 1);
      const page = await discovery.requestPage(runtime.branchId, "inbox");
      discovery.stop();
      assert.equal(page.items.length, 1);
      const itemId = page.items[0].itemId;
      const descriptor = await readConnectionDescriptor(runtime.descriptorPath);
      const unauthenticated = connectFrames(descriptor);
      unauthenticated.socket.write(encodeFrame(action(descriptor, 1, "unauth", { type: "dismiss", itemId }, { branchId: runtime.branchId })));
      assert.equal((await nextFrame(unauthenticated, (frame) => frame.type === "error")).code, "authentication_required");
      unauthenticated.socket.destroy();

      const peer = connectFrames(descriptor);
      peer.socket.write(encodeFrame(hello(descriptor)));
      await nextFrame(peer, (frame) => frame.type === "hello");
      const initial = (await nextFrame(peer, (frame) => frame.type === "snapshot")).snapshot;
      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "bad-generation", { type: "dismiss", itemId }, { branchId: runtime.branchId, generation: "f".repeat(32) })));
      assert.equal((await nextFrame(peer, (frame) => frame.requestId === "request-bad-generation")).code, "authentication_failed");
      peer.socket.write(encodeFrame(action(descriptor, initial.revision - 1, "stale", { type: "dismiss", itemId }, { branchId: runtime.branchId })));
      assert.equal((await nextFrame(peer, (frame) => frame.requestId === "request-stale")).code, "stale_action");
      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "durable", { type: "dismiss", itemId }, { branchId: runtime.branchId })));
      await nextFrame(peer, (frame) => frame.type === "action_result" && frame.actionId === "durable");
      peer.socket.write(encodeFrame(action(descriptor, initial.revision, "durable", { type: "dismiss", itemId }, { branchId: runtime.branchId })));
      assert.equal((await nextFrame(peer, (frame) => frame.requestId === "request-durable")).code, "replayed_action");
      peer.socket.destroy();
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
