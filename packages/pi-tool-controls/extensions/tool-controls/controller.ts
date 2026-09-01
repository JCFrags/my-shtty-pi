import {
  REQUIRED_PATCHED_CAPABILITIES,
  type ExtensionUIContextLike,
  type ToolExpansionChangeUnsubscribe,
  type ToolExpansionSelector,
  type ToolExpansionState,
  type ToolGroup,
} from "./contracts.js";

export type ControllerMode = "full" | "legacy" | "unavailable";

export interface CapabilityDetection {
  mode: ControllerMode;
  missing: string[];
  mouseCapabilityAdvertised: boolean | undefined;
}

export interface ControllerSnapshot {
  mode: ControllerMode;
  states: readonly ToolExpansionState[];
  currentTurnStates: readonly ToolExpansionState[];
  expandedCount: number;
  totalCount: number;
  legacyExpanded: boolean;
  busy: boolean;
  missingCapabilities: readonly string[];
}

export interface ControllerNotice {
  message: string;
  type: "info" | "warning" | "error";
}

export type ControllerListener = (snapshot: ControllerSnapshot) => void;

const FULL_METHODS = [
  "getToolExpansionStates",
  "setToolExpanded",
  "setToolGroupExpanded",
  "onToolExpansionChange",
] as const;

function hasFunction(object: object, key: string): boolean {
  return typeof (object as Record<string, unknown>)[key] === "function";
}

/** Runtime-only structural feature detection; no Pi implementation is imported. */
export function detectCapabilities(ui: ExtensionUIContextLike): CapabilityDetection {
  const missingMethods = FULL_METHODS.filter((name) => !hasFunction(ui, name)).map(
    (name) => `${name}()`,
  );
  const hasFull = missingMethods.length === 0;
  const hasLegacy = hasFunction(ui, "getToolsExpanded") && hasFunction(ui, "setToolsExpanded");

  let mouseCapabilityAdvertised: boolean | undefined;
  if (typeof ui.supportsComponentMouse === "boolean") {
    mouseCapabilityAdvertised = ui.supportsComponentMouse;
  } else if (ui.capabilities && typeof ui.capabilities.componentHandleMouse === "boolean") {
    mouseCapabilityAdvertised = ui.capabilities.componentHandleMouse;
  }

  if (hasFull && mouseCapabilityAdvertised === true) {
    return { mode: "full", missing: [], mouseCapabilityAdvertised };
  }

  const missing = [
    ...(mouseCapabilityAdvertised !== true ? ["Component.handleMouse"] : []),
    ...missingMethods,
  ];
  return {
    mode: hasLegacy ? "legacy" : "unavailable",
    missing: [...new Set(missing)],
    mouseCapabilityAdvertised,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStates(raw: unknown): ToolExpansionState[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.states)
      ? raw.states
      : [];

  const result: ToolExpansionState[] = [];
  const seen = new Set<string>();

  for (const candidate of list) {
    if (!isRecord(candidate)) continue;
    const rawId = candidate.toolCallId ?? candidate.id;
    if (typeof rawId !== "string" || rawId.length === 0 || seen.has(rawId)) continue;

    const rawName = candidate.toolName ?? candidate.name;
    const rawTurn = candidate.turnIndex;
    const rawStatus = candidate.status;
    const rawExpanded = candidate.expanded ?? candidate.isExpanded;
    if (typeof rawExpanded !== "boolean") continue;

    result.push({
      toolCallId: rawId,
      toolName: typeof rawName === "string" && rawName.length > 0 ? rawName : "tool",
      turnIndex:
        typeof rawTurn === "number" && Number.isFinite(rawTurn) ? Math.trunc(rawTurn) : -1,
      status: typeof rawStatus === "string" ? rawStatus : "unknown",
      expanded: rawExpanded,
    });
    seen.add(rawId);
  }

  return result;
}

function normalizeUnsubscribe(
  unsubscribe: ToolExpansionChangeUnsubscribe,
): (() => void) | undefined {
  if (typeof unsubscribe === "function") return unsubscribe;
  if (unsubscribe && typeof unsubscribe === "object") {
    if ("unsubscribe" in unsubscribe && typeof unsubscribe.unsubscribe === "function") {
      return () => unsubscribe.unsubscribe();
    }
    if ("dispose" in unsubscribe && typeof unsubscribe.dispose === "function") {
      return () => unsubscribe.dispose();
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnknownToolError(error: unknown): boolean {
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === "string" && /unknown[_ -]?tool|tool[_ -]?not[_ -]?found/i.test(code)) {
      return true;
    }
  }
  return /unknown\s+tool|unknown\s+tool\s*(?:call)?\s*id|tool\s*(?:call)?\s*id.*not\s+found/i.test(
    errorMessage(error),
  );
}

export class ToolStateController {
  readonly capabilities: CapabilityDetection;

  private states: ToolExpansionState[] = [];
  private currentTurnStates: ToolExpansionState[] = [];
  private legacyExpanded = false;
  private busy = false;
  private disposed = false;
  private listeners = new Set<ControllerListener>();
  private expansionUnsubscribe: (() => void) | undefined;
  private refreshPromise: Promise<void> | undefined;
  private refreshAgain = false;
  private lastRefreshError: string | undefined;

  constructor(
    private readonly ui: ExtensionUIContextLike,
    private readonly notice: (notice: ControllerNotice) => void,
  ) {
    this.capabilities = detectCapabilities(ui);
  }

  snapshot(): ControllerSnapshot {
    return {
      mode: this.capabilities.mode,
      states: this.states.map((state) => ({ ...state })),
      currentTurnStates: this.currentTurnStates.map((state) => ({ ...state })),
      expandedCount: this.states.filter((state) => state.expanded).length,
      totalCount: this.states.length,
      legacyExpanded: this.legacyExpanded,
      busy: this.busy,
      missingCapabilities: [...this.capabilities.missing],
    };
  }

  onChange(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A component's own safety boundary handles its rendering failure.
      }
    }
  }

  groupStates(group: ToolGroup): readonly ToolExpansionState[] {
    if (group === "currentTurn") {
      return this.currentTurnStates.map((state) => ({ ...state }));
    }
    if (group === "failed") {
      return this.states
        .filter((state) => state.status === "error")
        .map((state) => ({ ...state }));
    }
    if (group === "running") {
      return this.states
        .filter((state) => state.status === "pending" || state.status === "running")
        .map((state) => ({ ...state }));
    }
    return this.states.map((state) => ({ ...state }));
  }

  canSetGroupExpanded(group: ToolGroup, expanded: boolean): boolean {
    if (this.busy || this.capabilities.mode !== "full") return false;
    return this.groupStates(group).some((state) => state.expanded !== expanded);
  }

  canSetToolIdsExpanded(toolCallIds: readonly string[], expanded: boolean): boolean {
    if (this.busy || this.capabilities.mode !== "full") return false;
    const selected = new Set(toolCallIds);
    return this.states.some(
      (state) => selected.has(state.toolCallId) && state.expanded !== expanded,
    );
  }

  subscribeToExpansionChanges(): void {
    this.clearExpansionSubscription();
    if (this.disposed || this.capabilities.mode !== "full") return;

    try {
      const subscribe = this.ui.onToolExpansionChange;
      if (typeof subscribe !== "function") return;
      this.expansionUnsubscribe = normalizeUnsubscribe(
        subscribe.call(this.ui, () => {
          void this.refresh();
        }),
      );
    } catch (error) {
      this.notice({
        message: `pi-tool-controls could not subscribe to tool expansion changes: ${errorMessage(error)}`,
        type: "warning",
      });
    }
  }

  private clearExpansionSubscription(): void {
    if (!this.expansionUnsubscribe) return;
    try {
      this.expansionUnsubscribe();
    } catch {
      // Best-effort during extension reload and shutdown.
    }
    this.expansionUnsubscribe = undefined;
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh()
      .catch((error) => {
        const message = errorMessage(error);
        if (message !== this.lastRefreshError) {
          this.lastRefreshError = message;
          this.notice({
            message: `pi-tool-controls could not refresh tool state: ${message}`,
            type: "warning",
          });
        }
      })
      .finally(async () => {
        this.refreshPromise = undefined;
        if (this.refreshAgain && !this.disposed) {
          this.refreshAgain = false;
          await this.refresh();
        }
      });

    return this.refreshPromise;
  }

  private async performRefresh(): Promise<void> {
    if (this.capabilities.mode === "full") {
      const getStates = this.ui.getToolExpansionStates;
      if (typeof getStates !== "function") return;
      const [allRaw, currentRaw] = await Promise.all([
        Promise.resolve(getStates.call(this.ui)),
        Promise.resolve(getStates.call(this.ui, { scope: "currentTurn" })),
      ]);
      this.states = normalizeStates(allRaw);
      this.currentTurnStates = normalizeStates(currentRaw);
      this.lastRefreshError = undefined;
      this.emit();
      return;
    }

    if (this.capabilities.mode === "legacy") {
      const getExpanded = this.ui.getToolsExpanded;
      this.legacyExpanded =
        typeof getExpanded === "function" ? Boolean(getExpanded.call(this.ui)) : false;
      this.states = [];
      this.currentTurnStates = [];
      this.lastRefreshError = undefined;
      this.emit();
    }
  }

  async setGroupExpanded(group: ToolGroup, expanded: boolean): Promise<void> {
    if (!this.canSetGroupExpanded(group, expanded)) return;

    await this.runOperation(async () => {
      if (group === "currentTurn") {
        const setGroup = this.ui.setToolGroupExpanded;
        if (typeof setGroup !== "function") return;
        const selector: ToolExpansionSelector = { scope: "currentTurn" };
        await Promise.resolve(setGroup.call(this.ui, selector, expanded));
        return;
      }

      const ids = this.groupStates(group)
        .filter((state) => state.expanded !== expanded)
        .map((state) => state.toolCallId);
      await this.applyToolIds(ids, expanded);
    });
  }

  async setToolIdsExpanded(toolCallIds: readonly string[], expanded: boolean): Promise<void> {
    if (!this.canSetToolIdsExpanded(toolCallIds, expanded)) return;
    const byId = new Map(this.states.map((state) => [state.toolCallId, state]));
    const ids = [...new Set(toolCallIds)].filter(
      (toolCallId) => byId.get(toolCallId)?.expanded !== expanded,
    );
    await this.runOperation(() => this.applyToolIds(ids, expanded));
  }

  private async applyToolIds(toolCallIds: readonly string[], expanded: boolean): Promise<void> {
    const setTool = this.ui.setToolExpanded;
    if (typeof setTool !== "function") return;

    let unknownReported = false;
    for (const toolCallId of toolCallIds) {
      try {
        await Promise.resolve(setTool.call(this.ui, toolCallId, expanded));
      } catch (error) {
        if (isUnknownToolError(error)) {
          unknownReported = true;
          continue;
        }
        throw error;
      }
    }

    if (unknownReported) {
      this.notice({
        message: "A tool ID was no longer known to Pi. Tool state was refreshed.",
        type: "warning",
      });
    }
  }

  async setLegacyExpanded(expanded: boolean): Promise<void> {
    if (
      this.capabilities.mode !== "legacy" ||
      this.busy ||
      this.legacyExpanded === expanded
    ) {
      return;
    }
    await this.runOperation(async () => {
      const setExpanded = this.ui.setToolsExpanded;
      if (typeof setExpanded === "function") {
        await Promise.resolve(setExpanded.call(this.ui, expanded));
      }
    });
  }

  private async runOperation(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.emit();

    try {
      await operation();
    } catch (error) {
      if (isUnknownToolError(error)) {
        this.notice({
          message: "A tool ID was no longer known to Pi. Tool state was refreshed.",
          type: "warning",
        });
      } else {
        this.notice({
          message: `pi-tool-controls operation failed: ${errorMessage(error)}`,
          type: "error",
        });
      }
    } finally {
      this.busy = false;
      await this.refresh();
      this.emit();
    }
  }

  missingCapabilityMessage(): string {
    const missing = this.capabilities.missing.length
      ? this.capabilities.missing
      : [...REQUIRED_PATCHED_CAPABILITIES];
    return `Missing patched Pi capability: ${missing.join(", ")}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearExpansionSubscription();
    this.listeners.clear();
  }
}
