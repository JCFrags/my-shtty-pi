import assert from "node:assert/strict";
import toolControlsExtension from "../dist/extensions/tool-controls.js";

const states = [
  { toolCallId: "call-a", toolName: "read", turnIndex: 2, status: "success", expanded: false },
  { toolCallId: "call-b", toolName: "bash", turnIndex: 2, status: "running", expanded: true },
];
const currentTurnIds = new Set(states.map((state) => state.toolCallId));
const handlers = new Map();
const commands = new Map();
const widgetCalls = [];
const groupCalls = [];
let subscriptionActive = false;

const tui = {
  mode: "fullscreen",
  terminal: { rows: 24, columns: 100 },
  requestRender() {},
};
const theme = {
  fg(_role, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};
const keybindings = { matches: () => false };

const ui = {
  supportsComponentMouse: true,
  capabilities: { componentHandleMouse: true },
  setWidget(key, content, options) {
    widgetCalls.push({ key, content, options });
  },
  notify() {},
  getToolsExpanded: () => false,
  setToolsExpanded() {},
  getToolExpansionStates(selector) {
    const source = selector?.scope === "currentTurn"
      ? states.filter((state) => currentTurnIds.has(state.toolCallId))
      : states;
    return source.map((state) => ({ ...state }));
  },
  async setToolExpanded(toolCallId, expanded) {
    const state = states.find((candidate) => candidate.toolCallId === toolCallId);
    if (!state) throw new Error(`unknown tool ${toolCallId}`);
    state.expanded = expanded;
  },
  async setToolGroupExpanded(selector, expanded) {
    assert.deepEqual(selector, { scope: "currentTurn" });
    groupCalls.push({ selector, expanded });
    for (const state of states) {
      if (currentTurnIds.has(state.toolCallId)) state.expanded = expanded;
    }
  },
  onToolExpansionChange() {
    subscriptionActive = true;
    return () => {
      subscriptionActive = false;
    };
  },
  async custom(factory, options) {
    assert.equal(options.overlay, true);
    return await new Promise(async (resolve) => {
      const component = await factory(tui, theme, keybindings, resolve);
      const lines = component.render(100);
      assert.ok(lines.some((line) => line.includes("Current turn")));
      resolve(undefined);
    });
  },
};

const api = {
  on(event, handler) {
    const listeners = handlers.get(event) ?? [];
    listeners.push(handler);
    handlers.set(event, listeners);
  },
  registerCommand(name, options) {
    commands.set(name, options);
  },
};

async function emit(event, payload, context) {
  for (const handler of handlers.get(event) ?? []) await handler(payload, context);
}

toolControlsExtension(api);
const context = { ui, mode: "tui" };
await emit("session_start", { reason: "startup" }, context);
assert.equal(subscriptionActive, true);
assert.equal(widgetCalls[0].options.placement, "belowEditor");

const widgetFactory = widgetCalls[0].content;
assert.equal(typeof widgetFactory, "function");
const widget = widgetFactory(tui, theme);
assert.equal(widget.render(80)[0], "[Tools 1/2] [Expand turn] [Collapse turn] [More…]");
const expand = widget.currentLayout().regions.find((region) => region.id === "expand-turn");
assert.ok(expand);
widget.handleMouse({ kind: "press", button: "left", row: 0, col: expand.colStart });
widget.handleMouse({ kind: "release", button: "left", row: 0, col: expand.colStart });
await widget.whenIdle();
assert.equal(groupCalls.length, 1);
assert.equal(states.every((state) => state.expanded), true);

await commands.get("tool-controls").handler("", context);
await emit("session_shutdown", { reason: "reload" }, context);
assert.equal(subscriptionActive, false);
assert.equal(widgetCalls.at(-1).content, undefined);

console.log("pi-tool-controls smoke test passed: widget, mouse action, overlay, and cleanup");
