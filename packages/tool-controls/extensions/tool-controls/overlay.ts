import type {
  ComponentLike,
  ComponentMouseEvent,
  KeybindingsLike,
  ThemeLike,
  ToolExpansionState,
  ToolGroup,
  TuiLike,
} from "./contracts.js";
import type { ToolStateController } from "./controller.js";
import {
  containsPoint,
  normalizeMouseEvent,
  PressReleaseTracker,
  type HitRegion,
} from "./mouse.js";
import {
  abbreviateToolCallId,
  emphasize,
  fitLine,
  padRight,
  paint,
  textWidth,
  truncateText,
} from "./text.js";

interface OverlayOptions {
  controller: ToolStateController;
  tui: TuiLike;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  close(): void;
  onFatal(error: unknown): void;
}

type ButtonId =
  | `group:${ToolGroup}:expand`
  | `group:${ToolGroup}:collapse`
  | "selected:expand"
  | "selected:collapse";

type FocusTarget =
  | { kind: "button"; id: ButtonId }
  | { kind: "row"; toolCallId: string };

interface RenderedButton {
  id: ButtonId;
  label: string;
  enabled: boolean;
}

interface VisibleRange {
  start: number;
  end: number;
}

const GROUPS: Array<{ id: ToolGroup; label: string }> = [
  { id: "currentTurn", label: "Current turn" },
  { id: "failed", label: "Failed tools" },
  { id: "running", label: "Running tools" },
  { id: "session", label: "Entire session" },
];

function keyMatches(
  keybindings: KeybindingsLike,
  data: string,
  ids: readonly string[],
): boolean {
  if (typeof keybindings.matches !== "function") return false;
  for (const id of ids) {
    try {
      if (keybindings.matches(data, id)) return true;
    } catch {
      // Raw-key fallbacks below remain available.
    }
  }
  return false;
}

function isUp(data: string, keybindings: KeybindingsLike): boolean {
  return (
    data === "\x1b[A" ||
    data === "up" ||
    keyMatches(keybindings, data, ["tui.select.up", "tui.editor.cursorUp"])
  );
}

function isDown(data: string, keybindings: KeybindingsLike): boolean {
  return (
    data === "\x1b[B" ||
    data === "down" ||
    keyMatches(keybindings, data, ["tui.select.down", "tui.editor.cursorDown"])
  );
}

function isPageUp(data: string, keybindings: KeybindingsLike): boolean {
  return (
    data === "\x1b[5~" ||
    data === "pageUp" ||
    keyMatches(keybindings, data, [
      "tui.select.pageUp",
      "tui.editor.pageUp",
      "tui.altScreen.pageUp",
    ])
  );
}

function isPageDown(data: string, keybindings: KeybindingsLike): boolean {
  return (
    data === "\x1b[6~" ||
    data === "pageDown" ||
    keyMatches(keybindings, data, [
      "tui.select.pageDown",
      "tui.editor.pageDown",
      "tui.altScreen.pageDown",
    ])
  );
}

function isEnter(data: string, keybindings: KeybindingsLike): boolean {
  return (
    data === "\r" ||
    data === "\n" ||
    data === "enter" ||
    keyMatches(keybindings, data, ["tui.select.confirm", "tui.input.submit"])
  );
}

function formatGroupSummary(states: readonly ToolExpansionState[]): string {
  if (states.length === 0) return "No matching tools";
  const expanded = states.filter((state) => state.expanded).length;
  return `${expanded}/${states.length} expanded`;
}

function formatToolRow(
  state: ToolExpansionState,
  selected: boolean,
  focused: boolean,
  width: number,
): string {
  const focus = focused ? ">" : " ";
  const caret = state.expanded ? "▾" : "▸";
  const id = abbreviateToolCallId(state.toolCallId, 10);
  const turn = state.turnIndex >= 0 ? `turn ${state.turnIndex}` : "turn ?";
  const checkbox = selected ? "[x]" : "[ ]";
  const fixed = `${focus} ${caret}  ${id}  ${turn}  ${state.status}  ${checkbox}`;
  const availableName = Math.max(4, width - textWidth(fixed) - 2);
  const nameWidth = Math.min(18, availableName);
  const name = padRight(truncateText(state.toolName, nameWidth), nameWidth);
  return fitLine(
    `${focus} ${caret} ${name}  ${id}  ${turn}  ${state.status}  ${checkbox}`,
    width,
  );
}

function buttonLabel(label: string): string {
  return `[${label}]`;
}

export class ToolControlsOverlay implements ComponentLike {
  private selected = new Set<string>();
  private focus: FocusTarget = { kind: "button", id: "group:currentTurn:expand" };
  private scrollOffset = 0;
  private listHeight = 1;
  private visibleRange: VisibleRange = { start: 0, end: 0 };
  private listRegion: HitRegion | undefined;
  private hitRegions: HitRegion[] = [];
  private readonly tracker = new PressReleaseTracker();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private pendingAction: Promise<void> = Promise.resolve();

  constructor(private readonly options: OverlayOptions) {
    this.unsubscribe = options.controller.onChange((snapshot) => {
      const known = new Set(snapshot.states.map((state) => state.toolCallId));
      for (const selected of this.selected) {
        if (!known.has(selected)) this.selected.delete(selected);
      }
      if (this.focus.kind === "row" && !known.has(this.focus.toolCallId)) {
        this.focus = { kind: "button", id: "group:currentTurn:expand" };
      }
      this.clampScroll(snapshot.states.length);
      this.options.tui.requestRender();
    });
  }

  render(width: number): string[] {
    try {
      if (this.disposed) return [];
      const safeWidth = Math.max(1, Math.trunc(width));
      const snapshot = this.options.controller.snapshot();
      const states = snapshot.states;
      const terminalRows = this.options.tui.terminal?.rows ?? 24;
      const maxRows = Math.max(9, Math.trunc(terminalRows) - 2);
      this.listHeight = Math.max(1, maxRows - 8);
      this.clampScroll(states.length);
      this.ensureFocusedRowVisible(states);

      const lines: string[] = [];
      this.hitRegions = [];
      this.listRegion = undefined;

      lines.push(
        emphasize(
          this.options.theme,
          fitLine(
            `Tool controls — ${snapshot.expandedCount}/${snapshot.totalCount} expanded`,
            safeWidth,
          ),
        ),
      );

      for (const group of GROUPS) {
        const groupStates = this.options.controller.groupStates(group.id);
        lines.push(
          this.renderGroupLine(lines.length, safeWidth, group.id, group.label, groupStates),
        );
      }

      lines.push(paint(this.options.theme, "dim", fitLine("Tools", safeWidth)));
      const listStartRow = lines.length;

      if (states.length === 0) {
        lines.push(paint(this.options.theme, "dim", fitLine("  No matching tools", safeWidth)));
        this.visibleRange = { start: 0, end: 0 };
      } else {
        const end = Math.min(states.length, this.scrollOffset + this.listHeight);
        this.visibleRange = { start: this.scrollOffset, end };
        for (let index = this.scrollOffset; index < end; index += 1) {
          const state = states[index];
          if (!state) continue;
          const row = lines.length;
          const focused =
            this.focus.kind === "row" && this.focus.toolCallId === state.toolCallId;
          const line = formatToolRow(
            state,
            this.selected.has(state.toolCallId),
            focused,
            safeWidth,
          );
          lines.push(focused ? paint(this.options.theme, "accent", line) : line);
          this.hitRegions.push({
            id: `row:${state.toolCallId}`,
            role: "row",
            rowStart: row,
            rowEnd: row + 1,
            colStart: 0,
            colEnd: Math.max(1, textWidth(line)),
            enabled: true,
          });
        }
      }

      while (states.length > 0 && lines.length < listStartRow + this.listHeight) {
        lines.push("");
      }

      this.listRegion = {
        id: "list",
        role: "list",
        rowStart: listStartRow,
        rowEnd: lines.length,
        colStart: 0,
        colEnd: safeWidth,
        enabled: true,
      };

      lines.push(this.renderSelectedActions(lines.length, safeWidth));
      lines.push(
        paint(
          this.options.theme,
          "dim",
          fitLine(
            "↑/↓ focus  Space select  a select visible  n clear  PgUp/PgDn scroll  Esc close",
            safeWidth,
          ),
        ),
      );
      return lines.slice(0, maxRows);
    } catch (error) {
      this.options.onFatal(error);
      return [];
    }
  }

  private renderGroupLine(
    row: number,
    width: number,
    group: ToolGroup,
    label: string,
    states: readonly ToolExpansionState[],
  ): string {
    const prefix = `${padRight(label, 15)} `;
    const buttons: RenderedButton[] = [];
    let col = textWidth(prefix);

    const addButton = (id: ButtonId, text: string, enabled: boolean): string => {
      const rendered = buttonLabel(text);
      const start = col;
      const end = start + textWidth(rendered);
      col = end + 1;
      buttons.push({ id, label: rendered, enabled });
      this.hitRegions.push({
        id,
        role: "button",
        rowStart: row,
        rowEnd: row + 1,
        colStart: start,
        colEnd: end,
        enabled,
      });
      return rendered;
    };

    const expandId: ButtonId = `group:${group}:expand`;
    const collapseId: ButtonId = `group:${group}:collapse`;
    const expand = addButton(
      expandId,
      "Expand",
      this.options.controller.canSetGroupExpanded(group, true),
    );
    const collapse = addButton(
      collapseId,
      "Collapse",
      this.options.controller.canSetGroupExpanded(group, false),
    );
    const summary = formatGroupSummary(states);

    const style = (button: RenderedButton): string => {
      if (!button.enabled) return paint(this.options.theme, "dim", button.label);
      if (this.focus.kind === "button" && this.focus.id === button.id) {
        return paint(this.options.theme, "accent", button.label);
      }
      if (this.tracker.pressedRegionId === button.id) {
        return paint(this.options.theme, "accent", button.label);
      }
      return button.label;
    };

    const first = buttons[0] ?? { id: expandId, label: expand, enabled: false };
    const second = buttons[1] ?? { id: collapseId, label: collapse, enabled: false };
    return fitLine(`${prefix}${style(first)} ${style(second)}  ${summary}`, width);
  }

  private renderSelectedActions(row: number, width: number): string {
    const selectedIds = [...this.selected];
    const prefix = `Selected ${selectedIds.length}  `;
    const expandLabel = buttonLabel("Expand selected");
    const collapseLabel = buttonLabel("Collapse selected");
    const expandStart = textWidth(prefix);
    const expandEnd = expandStart + textWidth(expandLabel);
    const collapseStart = expandEnd + 1;
    const collapseEnd = collapseStart + textWidth(collapseLabel);
    const expandEnabled = this.options.controller.canSetToolIdsExpanded(selectedIds, true);
    const collapseEnabled = this.options.controller.canSetToolIdsExpanded(selectedIds, false);

    this.hitRegions.push({
      id: "selected:expand",
      role: "button",
      rowStart: row,
      rowEnd: row + 1,
      colStart: expandStart,
      colEnd: expandEnd,
      enabled: expandEnabled,
    });
    this.hitRegions.push({
      id: "selected:collapse",
      role: "button",
      rowStart: row,
      rowEnd: row + 1,
      colStart: collapseStart,
      colEnd: collapseEnd,
      enabled: collapseEnabled,
    });

    const style = (id: ButtonId, label: string, enabled: boolean): string => {
      if (!enabled) return paint(this.options.theme, "dim", label);
      if (this.focus.kind === "button" && this.focus.id === id) {
        return paint(this.options.theme, "accent", label);
      }
      if (this.tracker.pressedRegionId === id) {
        return paint(this.options.theme, "accent", label);
      }
      return label;
    };

    return fitLine(
      `${prefix}${style("selected:expand", expandLabel, expandEnabled)} ${style(
        "selected:collapse",
        collapseLabel,
        collapseEnabled,
      )}`,
      width,
    );
  }

  handleInput(data: string): void {
    try {
      if (this.disposed) return;
      if (data === "\x1b" || data === "escape") {
        this.options.close();
        return;
      }
      if (isUp(data, this.options.keybindings)) {
        this.moveFocus(-1);
        return;
      }
      if (isDown(data, this.options.keybindings)) {
        this.moveFocus(1);
        return;
      }
      if (isPageUp(data, this.options.keybindings)) {
        this.pageScroll(-1);
        return;
      }
      if (isPageDown(data, this.options.keybindings)) {
        this.pageScroll(1);
        return;
      }
      if (data === " ") {
        if (this.focus.kind === "row") this.toggleSelection(this.focus.toolCallId);
        return;
      }
      if (data === "a") {
        this.selectVisible();
        return;
      }
      if (data === "n") {
        this.selected.clear();
        this.options.tui.requestRender();
        return;
      }
      if (isEnter(data, this.options.keybindings) && this.focus.kind === "button") {
        const buttonId = this.focus.id;
        this.queueAction(() => this.activateButton(buttonId));
      }
    } catch (error) {
      this.options.onFatal(error);
    }
  }

  handleMouse(rawEvent: ComponentMouseEvent): void {
    try {
      if (this.disposed) return;
      const event = normalizeMouseEvent(rawEvent);
      if (!event) return;
      if (event.button === "right" || event.button === "middle") {
        this.tracker.reset();
        return;
      }

      if (event.phase === "wheel") {
        if (this.listRegion && containsPoint(this.listRegion, event.row, event.col)) {
          this.scrollBy(event.wheelDelta < 0 ? -3 : 3);
        }
        return;
      }

      if (event.phase === "press") {
        if (this.tracker.press(event, this.hitRegions)) {
          this.options.tui.requestRender();
        }
        return;
      }

      if (event.phase === "move") {
        if (this.tracker.move(event)) this.options.tui.requestRender();
        return;
      }

      if (event.phase === "release") {
        const id = this.tracker.release(event, this.hitRegions);
        this.options.tui.requestRender();
        if (!id) return;
        if (id.startsWith("row:")) {
          const toolCallId = id.slice("row:".length);
          this.focus = { kind: "row", toolCallId };
          this.toggleSelection(toolCallId);
          return;
        }
        this.focus = { kind: "button", id: id as ButtonId };
        this.queueAction(() => this.activateButton(id as ButtonId));
      }
    } catch (error) {
      this.options.onFatal(error);
    }
  }

  private queueAction(action: () => Promise<void>): void {
    this.pendingAction = this.pendingAction
      .then(action)
      .catch((error) => this.options.onFatal(error));
  }

  private async activateButton(id: ButtonId): Promise<void> {
    if (id === "selected:expand") {
      await this.options.controller.setToolIdsExpanded([...this.selected], true);
      return;
    }
    if (id === "selected:collapse") {
      await this.options.controller.setToolIdsExpanded([...this.selected], false);
      return;
    }

    const match = id.match(/^group:(currentTurn|failed|running|session):(expand|collapse)$/);
    if (!match) return;
    const group = match[1] as ToolGroup;
    const expanded = match[2] === "expand";
    await this.options.controller.setGroupExpanded(group, expanded);
  }

  private focusTargets(): FocusTarget[] {
    const targets: FocusTarget[] = [];
    for (const group of GROUPS) {
      targets.push({ kind: "button", id: `group:${group.id}:expand` });
      targets.push({ kind: "button", id: `group:${group.id}:collapse` });
    }
    for (const state of this.options.controller.snapshot().states) {
      targets.push({ kind: "row", toolCallId: state.toolCallId });
    }
    targets.push({ kind: "button", id: "selected:expand" });
    targets.push({ kind: "button", id: "selected:collapse" });
    return targets;
  }

  private sameTarget(left: FocusTarget, right: FocusTarget): boolean {
    if (left.kind !== right.kind) return false;
    return left.kind === "button"
      ? left.id === (right as Extract<FocusTarget, { kind: "button" }>).id
      : left.toolCallId === (right as Extract<FocusTarget, { kind: "row" }>).toolCallId;
  }

  private moveFocus(delta: number): void {
    const targets = this.focusTargets();
    if (targets.length === 0) return;
    const current = targets.findIndex((target) => this.sameTarget(target, this.focus));
    const next = current < 0 ? 0 : (current + delta + targets.length) % targets.length;
    const target = targets[next];
    if (!target) return;
    this.focus = target;
    this.ensureFocusedRowVisible(this.options.controller.snapshot().states);
    this.options.tui.requestRender();
  }

  private ensureFocusedRowVisible(states: readonly ToolExpansionState[]): void {
    if (this.focus.kind !== "row") return;
    const focusedToolCallId = this.focus.toolCallId;
    const index = states.findIndex((state) => state.toolCallId === focusedToolCallId);
    if (index < 0) return;
    if (index < this.scrollOffset) this.scrollOffset = index;
    if (index >= this.scrollOffset + this.listHeight) {
      this.scrollOffset = Math.max(0, index - this.listHeight + 1);
    }
  }

  private pageScroll(direction: -1 | 1): void {
    const states = this.options.controller.snapshot().states;
    const delta = Math.max(1, this.listHeight) * direction;
    if (this.focus.kind === "row") {
      const focusedToolCallId = this.focus.toolCallId;
      const current = states.findIndex((state) => state.toolCallId === focusedToolCallId);
      if (current >= 0) {
        const nextIndex = Math.max(0, Math.min(states.length - 1, current + delta));
        const next = states[nextIndex];
        if (next) this.focus = { kind: "row", toolCallId: next.toolCallId };
      }
    }
    this.scrollBy(delta);
    this.ensureFocusedRowVisible(states);
  }

  private scrollBy(delta: number): void {
    const count = this.options.controller.snapshot().states.length;
    const max = Math.max(0, count - this.listHeight);
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + delta));
    this.options.tui.requestRender();
  }

  private clampScroll(count: number): void {
    const max = Math.max(0, count - this.listHeight);
    this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset));
  }

  private toggleSelection(toolCallId: string): void {
    if (this.selected.has(toolCallId)) this.selected.delete(toolCallId);
    else this.selected.add(toolCallId);
    this.options.tui.requestRender();
  }

  private selectVisible(): void {
    const states = this.options.controller.snapshot().states;
    for (let index = this.visibleRange.start; index < this.visibleRange.end; index += 1) {
      const state = states[index];
      if (state) this.selected.add(state.toolCallId);
    }
    this.options.tui.requestRender();
  }

  invalidate(): void {
    this.hitRegions = [];
    this.listRegion = undefined;
    this.tracker.reset();
    this.options.tui.requestRender();
  }

  close(): void {
    this.options.close();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.tracker.reset();
  }

  selectedToolIds(): string[] {
    return [...this.selected];
  }

  currentScrollOffset(): number {
    return this.scrollOffset;
  }

  currentHitRegions(): readonly HitRegion[] {
    return this.hitRegions.map((region) => ({ ...region }));
  }

  currentListRegion(): HitRegion | undefined {
    return this.listRegion ? { ...this.listRegion } : undefined;
  }

  currentFocus(): FocusTarget {
    return { ...this.focus } as FocusTarget;
  }

  visibleToolIds(): string[] {
    const states = this.options.controller.snapshot().states;
    return states
      .slice(this.visibleRange.start, this.visibleRange.end)
      .map((state) => state.toolCallId);
  }

  async whenIdle(): Promise<void> {
    await this.pendingAction;
  }
}
