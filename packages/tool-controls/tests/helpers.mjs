import assert from "node:assert/strict";

export function state(toolCallId, overrides = {}) {
  return {
    toolCallId,
    toolName: overrides.toolName ?? `tool-${toolCallId}`,
    turnIndex: overrides.turnIndex ?? 0,
    status: overrides.status ?? "success",
    expanded: overrides.expanded ?? false,
  };
}

export class MockUI {
  constructor(options = {}) {
    this.states = (options.states ?? []).map((item) => ({ ...item }));
    this.currentTurnIds = new Set(options.currentTurnIds ?? []);
    this.globalExpanded = options.globalExpanded ?? false;
    this.supportsComponentMouse = options.supportsComponentMouse ?? true;
    this.capabilities = { componentHandleMouse: this.supportsComponentMouse };

    this.getStateCalls = [];
    this.setToolCalls = [];
    this.setGroupCalls = [];
    this.setGlobalCalls = [];
    this.notifications = [];
    this.widgetCalls = [];
    this.customCalls = [];
    this.expansionListeners = new Set();
    this.subscriptionCount = 0;
    this.unsubscribeCount = 0;
    this.unknownToolIds = new Set();
    this.overlayComponent = undefined;
    this.overlayOptions = undefined;
    this.overlayDone = undefined;
    this.autoCloseOverlay = options.autoCloseOverlay ?? true;
    this.tui = options.tui ?? createTui();
    this.theme = options.theme ?? createTheme();
    this.keybindings = options.keybindings ?? createKeybindings();
  }

  setWidget(key, content, options) {
    this.widgetCalls.push({ key, content, options });
  }

  async custom(factory, options) {
    this.customCalls.push({ factory, options });
    this.overlayOptions = options;
    return await new Promise(async (resolve, reject) => {
      let resolved = false;
      const done = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      this.overlayDone = done;
      try {
        this.overlayComponent = await factory(
          this.tui,
          this.theme,
          this.keybindings,
          done,
        );
        if (this.autoCloseOverlay) done(undefined);
      } catch (error) {
        reject(error);
      }
    });
  }

  notify(message, type = "info") {
    this.notifications.push({ message, type });
  }

  getToolsExpanded() {
    return this.globalExpanded;
  }

  async setToolsExpanded(expanded) {
    this.setGlobalCalls.push(expanded);
    this.globalExpanded = expanded;
  }

  getToolExpansionStates(selector) {
    this.getStateCalls.push(selector === undefined ? undefined : { ...selector });
    const selected =
      selector?.scope === "currentTurn"
        ? this.states.filter((item) => this.currentTurnIds.has(item.toolCallId))
        : this.states;
    return selected.map((item) => ({ ...item }));
  }

  async setToolExpanded(toolCallId, expanded) {
    this.setToolCalls.push({ toolCallId, expanded });
    if (this.unknownToolIds.has(toolCallId)) {
      const error = new Error(`Unknown tool call ID: ${toolCallId}`);
      error.code = "UNKNOWN_TOOL";
      throw error;
    }
    const existing = this.states.find((item) => item.toolCallId === toolCallId);
    if (!existing) {
      const error = new Error(`Tool call ID ${toolCallId} not found`);
      error.code = "TOOL_NOT_FOUND";
      throw error;
    }
    existing.expanded = expanded;
  }

  async setToolGroupExpanded(selector, expanded) {
    this.setGroupCalls.push({ selector: { ...selector }, expanded });
    if (selector?.scope !== "currentTurn") {
      throw new Error(`Unexpected group selector: ${JSON.stringify(selector)}`);
    }
    for (const item of this.states) {
      if (this.currentTurnIds.has(item.toolCallId)) item.expanded = expanded;
    }
  }

  onToolExpansionChange(listener) {
    this.subscriptionCount += 1;
    this.expansionListeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCount += 1;
      this.expansionListeners.delete(listener);
    };
  }

  emitExpansionChange(change) {
    for (const listener of [...this.expansionListeners]) listener(change);
  }

  latestWidgetFactory() {
    for (let index = this.widgetCalls.length - 1; index >= 0; index -= 1) {
      const content = this.widgetCalls[index]?.content;
      if (typeof content === "function") return content;
    }
    return undefined;
  }
}

export function createLegacyUI(options = {}) {
  const ui = new MockUI(options);
  ui.getToolExpansionStates = undefined;
  ui.setToolExpanded = undefined;
  ui.setToolGroupExpanded = undefined;
  ui.onToolExpansionChange = undefined;
  ui.supportsComponentMouse = false;
  ui.capabilities = { componentHandleMouse: false };
  return ui;
}

export function createUnavailableUI(options = {}) {
  const ui = createLegacyUI(options);
  ui.getToolsExpanded = undefined;
  ui.setToolsExpanded = undefined;
  return ui;
}

export function createTui(rows = 24, columns = 120, mode = "fullscreen") {
  return {
    mode,
    terminal: { rows, columns },
    renderRequests: 0,
    requestRender() {
      this.renderRequests += 1;
    },
  };
}

export function createTheme() {
  return {
    fg(_role, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
}

export function createKeybindings(mapping = {}) {
  return {
    matches(data, keybinding) {
      const allowed = mapping[keybinding];
      if (Array.isArray(allowed)) return allowed.includes(data);
      return allowed === data;
    },
  };
}

export function mouse(kind, button, row, col, extra = {}) {
  return { kind, button, row, col, ...extra };
}

export async function waitFor(predicate, message = "condition", timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

export function click(component, region, button = "left") {
  const row = region.rowStart;
  const col = region.colStart;
  component.handleMouse?.(mouse("press", button, row, col));
  component.handleMouse?.(mouse("release", button, row, col));
}

export function mockExtensionApi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    api: {
      on(event, handler) {
        const current = handlers.get(event) ?? [];
        current.push(handler);
        handlers.set(event, current);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
    },
    async emit(event, payload, context) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, context);
      }
    },
  };
}
