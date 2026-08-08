import test from "node:test";
import assert from "node:assert/strict";
import { ToolControlsOverlay } from "../dist/extensions/tool-controls/overlay.js";
import { ToolStateController } from "../dist/extensions/tool-controls/controller.js";
import {
  click,
  createKeybindings,
  createTheme,
  createTui,
  MockUI,
  mouse,
  state,
} from "./helpers.mjs";

async function setup(options = {}) {
  const ui = new MockUI({
    states: options.states ?? [
      state("a", { expanded: false, status: "success", turnIndex: 3 }),
      state("b", { expanded: true, status: "error", turnIndex: 3 }),
      state("c", { expanded: false, status: "running", turnIndex: 1 }),
    ],
    currentTurnIds: options.currentTurnIds ?? ["a", "b"],
  });
  const notices = [];
  const controller = new ToolStateController(ui, (notice) => notices.push(notice));
  await controller.refresh();
  const tui = createTui(options.rows ?? 14);
  const closed = { count: 0 };
  const fatal = [];
  const overlay = new ToolControlsOverlay({
    controller,
    tui,
    theme: createTheme(),
    keybindings: options.keybindings ?? createKeybindings(),
    close: () => {
      closed.count += 1;
    },
    onFatal: (error) => fatal.push(error),
  });
  const lines = overlay.render(options.width ?? 100);
  return { ui, controller, overlay, tui, lines, notices, closed, fatal };
}

function hit(overlay, id) {
  const region = overlay.currentHitRegions().find((candidate) => candidate.id === id);
  assert.ok(region, `missing hit region ${id}`);
  return region;
}

test("no-tool state renders No matching tools for every group and the list", async () => {
  const { lines, overlay } = await setup({ states: [], currentTurnIds: [] });
  assert.ok(lines.filter((line) => line.includes("No matching tools")).length >= 5);
  assert.deepEqual(overlay.visibleToolIds(), []);
  assert.deepEqual(overlay.selectedToolIds(), []);
});

test("row selection is UI-local until an explicit selected action", async () => {
  const { ui, overlay } = await setup();
  click(overlay, hit(overlay, "row:a"));
  assert.deepEqual(overlay.selectedToolIds(), ["a"]);
  assert.deepEqual(ui.setToolCalls, []);

  overlay.render(100);
  click(overlay, hit(overlay, "selected:expand"));
  await overlay.whenIdle();
  assert.deepEqual(ui.setToolCalls, [{ toolCallId: "a", expanded: true }]);
});

test("multi-selection applies expansion only to selected tools", async () => {
  const { ui, overlay } = await setup({
    states: [
      state("a", { expanded: false }),
      state("b", { expanded: false }),
      state("c", { expanded: false }),
    ],
    currentTurnIds: ["a"],
  });
  click(overlay, hit(overlay, "row:a"));
  click(overlay, hit(overlay, "row:c"));
  assert.deepEqual(new Set(overlay.selectedToolIds()), new Set(["a", "c"]));

  overlay.render(100);
  click(overlay, hit(overlay, "selected:expand"));
  await overlay.whenIdle();
  assert.deepEqual(ui.setToolCalls, [
    { toolCallId: "a", expanded: true },
    { toolCallId: "c", expanded: true },
  ]);
});

test("keyboard focus, Enter, Space, a, n, and Escape have parity", async () => {
  const first = await setup();
  assert.deepEqual(first.overlay.currentFocus(), {
    kind: "button",
    id: "group:currentTurn:expand",
  });
  first.overlay.handleInput("down");
  assert.deepEqual(first.overlay.currentFocus(), {
    kind: "button",
    id: "group:currentTurn:collapse",
  });
  first.overlay.handleInput("enter");
  await first.overlay.whenIdle();
  assert.deepEqual(first.ui.setGroupCalls, [
    { selector: { scope: "currentTurn" }, expanded: false },
  ]);

  const second = await setup();
  for (let index = 0; index < 8; index += 1) second.overlay.handleInput("down");
  assert.deepEqual(second.overlay.currentFocus(), { kind: "row", toolCallId: "a" });
  second.overlay.handleInput(" ");
  assert.deepEqual(second.overlay.selectedToolIds(), ["a"]);

  second.overlay.handleInput("a");
  assert.deepEqual(
    new Set(second.overlay.selectedToolIds()),
    new Set(second.overlay.visibleToolIds()),
  );
  second.overlay.handleInput("n");
  assert.deepEqual(second.overlay.selectedToolIds(), []);
  second.overlay.handleInput("escape");
  assert.equal(second.closed.count, 1);
});

test("PageUp/PageDown and configured shared scroll keys scroll the list", async () => {
  const states = Array.from({ length: 12 }, (_, index) =>
    state(`id-${index}`, { turnIndex: Math.floor(index / 3), expanded: index % 2 === 0 }),
  );
  const keybindings = createKeybindings({
    "tui.altScreen.pageDown": "shared-down",
    "tui.altScreen.pageUp": "shared-up",
  });
  const { overlay } = await setup({ states, currentTurnIds: ["id-10", "id-11"], keybindings });
  assert.equal(overlay.visibleToolIds().length, 4);

  overlay.handleInput("shared-down");
  assert.equal(overlay.currentScrollOffset(), 4);
  overlay.handleInput("shared-up");
  assert.equal(overlay.currentScrollOffset(), 0);
  overlay.handleInput("pageDown");
  assert.equal(overlay.currentScrollOffset(), 4);
  overlay.handleInput("pageUp");
  assert.equal(overlay.currentScrollOffset(), 0);
});

test("mouse wheel scrolls only while over the list viewport", async () => {
  const states = Array.from({ length: 12 }, (_, index) => state(`id-${index}`));
  const { overlay } = await setup({ states, currentTurnIds: [] });

  overlay.handleMouse(mouse("wheel", "none", 0, 0, { deltaY: 1 }));
  assert.equal(overlay.currentScrollOffset(), 0);

  const list = overlay.currentListRegion();
  assert.ok(list);
  overlay.handleMouse(
    mouse("wheel", "none", list.rowStart, list.colStart, { deltaY: 1 }),
  );
  assert.equal(overlay.currentScrollOffset(), 3);
});

test("row drag, right click, middle click, and outside click do not operate controls", async () => {
  const { ui, overlay } = await setup();
  const row = hit(overlay, "row:a");

  overlay.handleMouse(mouse("press", "left", row.rowStart, row.colStart));
  overlay.handleMouse(mouse("move", "left", row.rowStart, row.colStart + 1));
  overlay.handleMouse(mouse("release", "left", row.rowStart, row.colStart + 1));
  click(overlay, row, "right");
  click(overlay, row, "middle");
  overlay.handleMouse(mouse("press", "left", 999, 999));
  overlay.handleMouse(mouse("release", "left", 999, 999));

  await overlay.whenIdle();
  assert.deepEqual(overlay.selectedToolIds(), []);
  assert.deepEqual(ui.setToolCalls, []);
  assert.deepEqual(ui.setGroupCalls, []);
});

test("rendering remains bounded by the fullscreen-compatible height", async () => {
  const states = Array.from({ length: 100 }, (_, index) => state(`id-${index}`));
  const { overlay } = await setup({ states, currentTurnIds: [], rows: 16 });
  const lines = overlay.render(80);
  assert.ok(lines.length <= 14);
  assert.ok(overlay.visibleToolIds().length < states.length);
});
