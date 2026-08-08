import test from "node:test";
import assert from "node:assert/strict";
import { CompactToolStrip } from "../dist/extensions/tool-controls/compact-strip.js";
import { ToolStateController } from "../dist/extensions/tool-controls/controller.js";
import { createTheme, createTui, MockUI, mouse, state } from "./helpers.mjs";

async function setup() {
  const ui = new MockUI({
    states: [
      state("a", { expanded: false, turnIndex: 4 }),
      state("b", { expanded: true, turnIndex: 4 }),
      state("c", { expanded: false, turnIndex: 1 }),
    ],
    currentTurnIds: ["a", "b"],
  });
  const notices = [];
  const controller = new ToolStateController(ui, (notice) => notices.push(notice));
  await controller.refresh();
  const tui = createTui();
  let openCount = 0;
  let overlayOpen = false;
  const fatal = [];
  const strip = new CompactToolStrip({
    controller,
    tui,
    theme: createTheme(),
    openOverlay: () => {
      openCount += 1;
    },
    isOverlayOpen: () => overlayOpen,
    onFatal: (error) => fatal.push(error),
  });
  strip.render(80);
  return {
    ui,
    controller,
    strip,
    fatal,
    getOpenCount: () => openCount,
    setOverlayOpen: (value) => {
      overlayOpen = value;
    },
  };
}

function region(strip, id) {
  const value = strip.currentLayout()?.regions.find((candidate) => candidate.id === id);
  assert.ok(value, `missing ${id} region`);
  return value;
}

function click(strip, target, button = "left") {
  strip.handleMouse(mouse("press", button, target.rowStart, target.colStart));
  strip.handleMouse(mouse("release", button, target.rowStart, target.colStart));
}

test("Tools and More open the same overlay action", async () => {
  const { strip, getOpenCount } = await setup();
  click(strip, region(strip, "open"));
  await strip.whenIdle();
  assert.equal(getOpenCount(), 1);

  strip.render(80);
  click(strip, region(strip, "more"));
  await strip.whenIdle();
  assert.equal(getOpenCount(), 2);
});

test("compact buttons call current-turn expand and collapse", async () => {
  const { strip, ui } = await setup();
  click(strip, region(strip, "expand-turn"));
  await strip.whenIdle();
  assert.deepEqual(ui.setGroupCalls[0], {
    selector: { scope: "currentTurn" },
    expanded: true,
  });

  strip.render(80);
  click(strip, region(strip, "collapse-turn"));
  await strip.whenIdle();
  assert.deepEqual(ui.setGroupCalls[1], {
    selector: { scope: "currentTurn" },
    expanded: false,
  });
});

test("dragging across a button cancels activation", async () => {
  const { strip, ui } = await setup();
  const target = region(strip, "expand-turn");
  strip.handleMouse(mouse("press", "left", target.rowStart, target.colStart));
  strip.handleMouse(mouse("move", "left", target.rowStart, target.colStart + 1));
  strip.handleMouse(mouse("release", "left", target.rowStart, target.colStart + 1));
  await strip.whenIdle();
  assert.deepEqual(ui.setGroupCalls, []);
});

test("right and middle clicks do nothing", async () => {
  const { strip, ui, getOpenCount } = await setup();
  for (const button of ["right", "middle"]) {
    click(strip, region(strip, "open"), button);
    click(strip, region(strip, "expand-turn"), button);
  }
  await strip.whenIdle();
  assert.equal(getOpenCount(), 0);
  assert.deepEqual(ui.setGroupCalls, []);
});

test("compact controls are inert while the modal overlay is open", async () => {
  const { strip, ui, getOpenCount, setOverlayOpen } = await setup();
  setOverlayOpen(true);
  click(strip, region(strip, "open"));
  click(strip, region(strip, "expand-turn"));
  await strip.whenIdle();
  assert.equal(getOpenCount(), 0);
  assert.deepEqual(ui.setGroupCalls, []);
});

test("disabled current-turn operations cannot be activated", async () => {
  const ui = new MockUI({
    states: [state("a", { expanded: true })],
    currentTurnIds: ["a"],
  });
  const controller = new ToolStateController(ui, () => {});
  await controller.refresh();
  const strip = new CompactToolStrip({
    controller,
    tui: createTui(),
    theme: createTheme(),
    openOverlay() {},
    isOverlayOpen: () => false,
    onFatal(error) {
      throw error;
    },
  });
  strip.render(80);
  const expand = strip.currentLayout()?.regions.find((candidate) => candidate.id === "expand-turn");
  assert.ok(expand);
  assert.equal(expand.enabled, false);
  click(strip, expand);
  await strip.whenIdle();
  assert.deepEqual(ui.setGroupCalls, []);
});
