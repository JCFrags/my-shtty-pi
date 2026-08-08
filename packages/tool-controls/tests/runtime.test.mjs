import test from "node:test";
import assert from "node:assert/strict";
import toolControlsExtension from "../dist/extensions/tool-controls.js";
import { LegacyToolControlsOverlay } from "../dist/extensions/tool-controls/legacy-overlay.js";
import { ToolStateController } from "../dist/extensions/tool-controls/controller.js";
import { ToolControlsRuntime } from "../dist/extensions/tool-controls/runtime.js";
import {
  createKeybindings,
  createLegacyUI,
  createTheme,
  createTui,
  MockUI,
  mockExtensionApi,
  state,
  waitFor,
} from "./helpers.mjs";

test("runtime installs one below-editor widget and cleans widget plus subscription", async () => {
  const ui = new MockUI({
    states: [state("a", { expanded: false })],
    currentTurnIds: ["a"],
  });
  const runtime = new ToolControlsRuntime({ ui, mode: "tui" });
  await runtime.start();
  await runtime.start();

  assert.equal(ui.widgetCalls.length, 1, "start is idempotent");
  assert.equal(ui.widgetCalls[0].key, "pi-tool-controls");
  assert.deepEqual(ui.widgetCalls[0].options, { placement: "belowEditor" });
  assert.equal(ui.subscriptionCount, 1);

  const factory = ui.latestWidgetFactory();
  assert.equal(typeof factory, "function");
  const component = factory(createTui(), createTheme());
  assert.equal(typeof component.handleMouse, "function");
  assert.match(component.render(80)[0], /Tools 0\/1/);

  runtime.cleanup();
  assert.equal(ui.unsubscribeCount, 1);
  const removal = ui.widgetCalls.at(-1);
  assert.equal(removal.key, "pi-tool-controls");
  assert.equal(removal.content, undefined);
  assert.deepEqual(removal.options, { placement: "belowEditor" });
});

test("missing patched capability names are shown and legacy global controls remain keyboard accessible", async () => {
  const ui = createLegacyUI({ globalExpanded: false });
  const runtime = new ToolControlsRuntime({ ui, mode: "tui" });
  await runtime.start();
  assert.ok(
    ui.notifications.some(
      (notice) =>
        /Missing patched Pi capability/.test(notice.message) &&
        /getToolExpansionStates/.test(notice.message) &&
        /keyboard-accessible global/.test(notice.message),
    ),
  );

  const controller = new ToolStateController(ui, () => {});
  await controller.refresh();
  const overlay = new LegacyToolControlsOverlay({
    controller,
    tui: createTui(),
    theme: createTheme(),
    keybindings: createKeybindings(),
    close() {},
    onFatal(error) {
      throw error;
    },
  });
  const lines = overlay.render(80);
  assert.ok(lines.some((line) => line.includes("compatibility mode")));
  assert.ok(lines.some((line) => line.includes("Missing patched Pi capability")));

  overlay.handleInput("enter");
  await overlay.whenIdle();
  assert.deepEqual(ui.setGlobalCalls, [true]);
  overlay.render(80);
  overlay.handleInput("down");
  overlay.handleInput("enter");
  await overlay.whenIdle();
  assert.deepEqual(ui.setGlobalCalls, [true, false]);

  overlay.dispose();
  runtime.cleanup();
});

test("a render error removes the widget and notifies only once", async () => {
  const ui = new MockUI({ states: [state("a")], currentTurnIds: ["a"] });
  const runtime = new ToolControlsRuntime({ ui, mode: "tui" });
  await runtime.start();
  const factory = ui.latestWidgetFactory();
  assert.ok(factory);
  const component = factory(createTui(), createTheme());

  runtime.controller.snapshot = () => {
    throw new Error("render exploded");
  };
  assert.deepEqual(component.render(80), []);
  assert.deepEqual(component.render(80), []);

  const fatalNotices = ui.notifications.filter((notice) =>
    notice.message.includes("removed after a UI render/event error"),
  );
  assert.equal(fatalNotices.length, 1);
  assert.equal(ui.widgetCalls.at(-1).content, undefined);
});

test("extension registers /tool-controls and refreshes on required lifecycle events", async () => {
  const extension = mockExtensionApi();
  toolControlsExtension(extension.api);
  assert.ok(extension.commands.has("tool-controls"));

  const firstUi = new MockUI({ states: [state("a")], currentTurnIds: ["a"] });
  const firstContext = { ui: firstUi, mode: "tui" };
  await extension.emit("session_start", { reason: "startup" }, firstContext);
  assert.equal(firstUi.widgetCalls[0].options.placement, "belowEditor");

  const initialCalls = firstUi.getStateCalls.length;
  await extension.emit("turn_start", { turnIndex: 1 }, firstContext);
  await extension.emit("tool_execution_start", { toolCallId: "a" }, firstContext);
  await extension.emit("tool_execution_end", { toolCallId: "a" }, firstContext);
  await waitFor(
    () => firstUi.getStateCalls.length > initialCalls,
    "lifecycle state refresh",
  );

  await extension.commands.get("tool-controls").handler("", firstContext);
  assert.equal(firstUi.customCalls.length, 1);
  assert.equal(firstUi.overlayOptions.overlay, true);

  const secondUi = new MockUI({ states: [], currentTurnIds: [] });
  const secondContext = { ui: secondUi, mode: "tui" };
  await extension.emit("session_start", { reason: "resume" }, secondContext);
  assert.equal(firstUi.unsubscribeCount, 1, "session replacement cleans old subscription");
  assert.equal(firstUi.widgetCalls.at(-1).content, undefined);
  assert.equal(secondUi.widgetCalls[0].options.placement, "belowEditor");

  await extension.emit("session_shutdown", { reason: "reload" }, secondContext);
  assert.equal(secondUi.unsubscribeCount, 1);
  assert.equal(secondUi.widgetCalls.at(-1).content, undefined);
});
