import test from "node:test";
import assert from "node:assert/strict";
import {
  detectCapabilities,
  ToolStateController,
} from "../dist/extensions/tool-controls/controller.js";
import {
  createLegacyUI,
  createUnavailableUI,
  MockUI,
  state,
  waitFor,
} from "./helpers.mjs";

function controllerFor(ui) {
  const notices = [];
  return {
    notices,
    controller: new ToolStateController(ui, (notice) => notices.push(notice)),
  };
}

test("refresh uses the currentTurn selector rather than inferring array order", async () => {
  const ui = new MockUI({
    states: [
      state("old", { turnIndex: 9, expanded: false }),
      state("current-a", { turnIndex: 2, expanded: true }),
      state("current-b", { turnIndex: 2, expanded: false }),
    ],
    currentTurnIds: ["current-a", "current-b"],
  });
  const { controller } = controllerFor(ui);
  await controller.refresh();

  assert.deepEqual(ui.getStateCalls, [undefined, { scope: "currentTurn" }]);
  assert.deepEqual(
    controller.snapshot().currentTurnStates.map((item) => item.toolCallId),
    ["current-a", "current-b"],
  );
});

test("current-turn expand and collapse use setToolGroupExpanded with exact scope", async () => {
  const ui = new MockUI({
    states: [state("a", { expanded: false }), state("b", { expanded: true })],
    currentTurnIds: ["a", "b"],
  });
  const { controller } = controllerFor(ui);
  await controller.refresh();

  await controller.setGroupExpanded("currentTurn", true);
  await controller.setGroupExpanded("currentTurn", false);

  assert.deepEqual(ui.setGroupCalls, [
    { selector: { scope: "currentTurn" }, expanded: true },
    { selector: { scope: "currentTurn" }, expanded: false },
  ]);
});

test("failed, running, and session filters follow the required status rules", async () => {
  const ui = new MockUI({
    states: [
      state("error", { status: "error" }),
      state("pending", { status: "pending" }),
      state("running", { status: "running" }),
      state("success", { status: "success" }),
    ],
    currentTurnIds: ["success"],
  });
  const { controller } = controllerFor(ui);
  await controller.refresh();

  assert.deepEqual(controller.groupStates("failed").map((item) => item.toolCallId), ["error"]);
  assert.deepEqual(controller.groupStates("running").map((item) => item.toolCallId), [
    "pending",
    "running",
  ]);
  assert.deepEqual(controller.groupStates("session").map((item) => item.toolCallId), [
    "error",
    "pending",
    "running",
    "success",
  ]);
});

test("selected bulk operations affect only selected tools that need a change", async () => {
  const ui = new MockUI({
    states: [
      state("a", { expanded: false }),
      state("b", { expanded: true }),
      state("c", { expanded: false }),
    ],
    currentTurnIds: [],
  });
  const { controller } = controllerFor(ui);
  await controller.refresh();
  await controller.setToolIdsExpanded(["a", "b", "a"], true);

  assert.deepEqual(ui.setToolCalls, [{ toolCallId: "a", expanded: true }]);
  assert.equal(ui.states.find((item) => item.toolCallId === "c")?.expanded, false);
});

test("expansion-change subscription refreshes state and cleanup unsubscribes", async () => {
  const ui = new MockUI({ states: [state("a", { expanded: false })], currentTurnIds: ["a"] });
  const { controller } = controllerFor(ui);
  controller.subscribeToExpansionChanges();
  await controller.refresh();
  assert.equal(ui.subscriptionCount, 1);

  ui.states[0].expanded = true;
  ui.emitExpansionChange({ toolCallId: "a" });
  await waitFor(() => controller.snapshot().expandedCount === 1, "subscription refresh");

  controller.dispose();
  assert.equal(ui.unsubscribeCount, 1);
  assert.equal(ui.expansionListeners.size, 0);
});

test("unknown tool IDs notify and refresh instead of throwing", async () => {
  const ui = new MockUI({ states: [state("stale", { expanded: false })], currentTurnIds: [] });
  ui.unknownToolIds.add("stale");
  const { controller, notices } = controllerFor(ui);
  await controller.refresh();

  await assert.doesNotReject(controller.setToolIdsExpanded(["stale"], true));
  assert.match(notices.at(-1)?.message ?? "", /no longer known/i);
  assert.ok(ui.getStateCalls.length >= 4, "operation completion performs a refresh");
});

test("legacy fallback is detected structurally and controls global state", async () => {
  const ui = createLegacyUI({ globalExpanded: false });
  const detection = detectCapabilities(ui);
  assert.equal(detection.mode, "legacy");
  assert.ok(detection.missing.includes("Component.handleMouse"));
  assert.ok(detection.missing.includes("getToolExpansionStates()"));

  const { controller } = controllerFor(ui);
  await controller.refresh();
  await controller.setLegacyExpanded(true);
  assert.deepEqual(ui.setGlobalCalls, [true]);
  assert.equal(controller.snapshot().legacyExpanded, true);
});

test("unavailable mode reports missing fallback and handles no tools", async () => {
  const ui = createUnavailableUI();
  const { controller } = controllerFor(ui);
  await controller.refresh();
  assert.equal(controller.snapshot().mode, "unavailable");
  assert.equal(controller.snapshot().totalCount, 0);
  assert.match(controller.missingCapabilityMessage(), /Missing patched Pi capability/);
});
