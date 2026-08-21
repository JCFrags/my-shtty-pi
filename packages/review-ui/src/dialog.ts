import type {
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { QueuePosition, QueueRunContext } from "./queue.js";
import { formatBytes, type ReviewPreview } from "./preview.js";
import { renderControlCharacters } from "./text-safety.js";

export type ReviewDialogDecision = "approve" | "approve-turn" | "reject" | "abort";
export type RiskDialogDecision = "confirm" | "reject" | "abort";
export type RiskKind = "outside-cwd" | "oversized";

export interface FirstClassMouseEvent {
  kind?: string;
  type?: string;
  action?: string;
  button?: string | number;
  row?: number;
  col?: number;
  localRow?: number;
  localCol?: number;
  column?: number;
  x?: number;
  y?: number;
  deltaY?: number;
  direction?: number | string;
  dragged?: boolean;
}

interface Action<TResult extends string> {
  id: TResult;
  label: string;
  tone: "approve" | "reject" | "neutral";
}

interface HitRegion<TResult extends string> {
  action: TResult;
  row: number;
  startCol: number;
  endCol: number;
}

interface DialogModel<TResult extends string> {
  title: string;
  body: string;
  warnings: string[];
  actions: Action<TResult>[];
  defaultAction: TResult;
  approveHotkeyResult: TResult;
  rejectResult: TResult;
  keyboardHint: string;
  queuePosition?: QueuePosition;
}

interface PointerPress<TResult extends string> {
  action: TResult | undefined;
  row: number;
  col: number;
  dragged: boolean;
}

export class ReviewDialogComponent<TResult extends string> implements Component {
  private scrollOffset = 0;
  private viewportHeight = 5;
  private focusedActionIndex: number;
  private hitRegions: HitRegion<TResult>[] = [];
  private pointerPress: PointerPress<TResult> | undefined;
  private finished = false;
  private disposed = false;
  private abortListener: (() => void) | undefined;
  private queuePosition: QueuePosition | undefined;
  private removePositionListener: (() => void) | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly model: DialogModel<TResult>,
    private readonly done: (result: TResult | "abort") => void,
    signal: AbortSignal,
    queueContext?: QueueRunContext,
  ) {
    const defaultIndex = model.actions.findIndex((action) => action.id === model.defaultAction);
    this.focusedActionIndex = defaultIndex >= 0 ? defaultIndex : 0;
    this.queuePosition = model.queuePosition ?? queueContext?.getPosition();

    const abort = (): void => this.finish("abort");
    if (signal.aborted) {
      queueMicrotask(abort);
    } else {
      signal.addEventListener("abort", abort, { once: true });
      this.abortListener = () => signal.removeEventListener("abort", abort);
    }

    if (queueContext) {
      this.removePositionListener = queueContext.onPositionChange((position) => {
        this.queuePosition = position;
        this.tui.requestRender();
      });
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (safeWidth < 8) {
      return [truncateToWidth(renderControlCharacters(this.model.title), safeWidth)];
    }
    const innerWidth = safeWidth - 4;
    const lines: string[] = [];
    const border = (text: string): string => this.theme.fg("border", text);

    lines.push(border(`┌${"─".repeat(safeWidth - 2)}┐`));

    const queueSuffix = this.queuePosition
      ? `  [${this.queuePosition.current}/${this.queuePosition.total}]`
      : "";
    lines.push(
      this.frameLine(
        this.theme.bold(renderControlCharacters(`${this.model.title}${queueSuffix}`)),
        innerWidth,
        border,
      ),
    );

    const warningLines = this.renderWarnings(innerWidth);
    lines.push(...warningLines.map((line) => this.frameLine(line, innerWidth, border)));
    lines.push(border(`├${"─".repeat(safeWidth - 2)}┤`));

    const renderedBody = this.renderBody(innerWidth);
    const availableRows = Math.max(10, Math.floor((this.tui.terminal?.rows ?? 30) * 0.84));
    const actionRowCount = this.estimateActionRowCount(innerWidth);
    const fixedRows = 7 + warningLines.length + actionRowCount;
    this.viewportHeight = Math.max(3, Math.min(22, availableRows - fixedRows));
    const maxOffset = Math.max(0, renderedBody.length - this.viewportHeight);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);

    const visibleBody = renderedBody.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
    for (let index = 0; index < this.viewportHeight; index += 1) {
      const line = visibleBody[index] ?? "";
      lines.push(this.frameLine(line, innerWidth, border));
    }

    const rangeStart = renderedBody.length === 0 ? 0 : this.scrollOffset + 1;
    const rangeEnd = Math.min(renderedBody.length, this.scrollOffset + this.viewportHeight);
    const positionText = this.theme.fg(
      "muted",
      ` ${rangeStart}-${rangeEnd} of ${renderedBody.length} ${maxOffset > 0 ? "(scroll)" : ""}`,
    );
    lines.push(this.frameLine(positionText, innerWidth, border));
    lines.push(border(`├${"─".repeat(safeWidth - 2)}┤`));

    const actionRows = this.renderActionRows(innerWidth, lines.length);
    for (const actionLine of actionRows) {
      lines.push(this.frameLine(actionLine, innerWidth, border));
    }
    lines.push(this.frameLine(this.theme.fg("dim", this.model.keyboardHint), innerWidth, border));
    lines.push(border(`└${"─".repeat(safeWidth - 2)}┘`));

    return lines;
  }

  handleInput(data: string): void {
    if (this.finished || isKeyRelease(data)) return;

    if (matchesKey(data, "up")) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(-Math.max(1, this.viewportHeight - 1));
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollBy(Math.max(1, this.viewportHeight - 1));
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.moveFocus(-1);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.moveFocus(1);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const action = this.model.actions[this.focusedActionIndex];
      if (action) this.finish(action.id);
      return;
    }
    if (matchesKey(data, "y")) {
      this.finish(this.model.approveHotkeyResult);
      return;
    }
    if (matchesKey(data, "n") || matchesKey(data, "escape") || matchesKey(data, "esc")) {
      this.finish(this.model.rejectResult);
      return;
    }

    // Space is deliberately inert. It may move focus in future versions, but
    // it never approves a tool call.
    if (matchesKey(data, "space")) return;
  }

  /**
   * First-class component mouse hook. Stock Pi 0.83 ignores this method; Pi
   * versions that dispatch local component mouse events can call it directly.
   * No raw terminal mouse mode is enabled by this package.
   */
  handleMouse(event: FirstClassMouseEvent): boolean {
    if (this.finished) return true;
    const normalized = normalizeMouseEvent(event);
    if (!normalized) return true;

    if (normalized.kind === "wheel") {
      this.scrollBy(normalized.direction * 3);
      return true;
    }

    if (normalized.kind === "press") {
      if (normalized.button !== "left") return true;
      this.pointerPress = {
        action: this.actionAt(normalized.row, normalized.col),
        row: normalized.row,
        col: normalized.col,
        dragged: false,
      };
      return true;
    }

    if (normalized.kind === "move") {
      if (this.pointerPress) {
        if (
          normalized.row !== this.pointerPress.row ||
          normalized.col !== this.pointerPress.col ||
          event.dragged === true
        ) {
          this.pointerPress.dragged = true;
        }
      }
      return true;
    }

    if (normalized.kind === "release") {
      const press = this.pointerPress;
      this.pointerPress = undefined;
      if (!press || press.dragged || event.dragged === true || normalized.button !== "left") return true;
      const releaseAction = this.actionAt(normalized.row, normalized.col);
      if (press.action !== undefined && releaseAction === press.action) {
        this.finish(press.action);
      }
      return true;
    }

    return true;
  }

  invalidate(): void {
    // Rendering is calculated from current state on every frame.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortListener?.();
    this.abortListener = undefined;
    this.removePositionListener?.();
    this.removePositionListener = undefined;
    this.hitRegions = [];
    this.pointerPress = undefined;
  }

  private renderWarnings(innerWidth: number): string[] {
    if (this.model.warnings.length === 0) {
      return [this.theme.fg("muted", "No additional path/content warnings")];
    }

    // Keep one bounded banner row per warning so long or adversarial paths
    // cannot push the pinned actions beyond the overlay's height.
    return this.model.warnings.map((warning) =>
      this.theme.fg(
        "warning",
        truncateToWidth(renderControlCharacters(`! ${warning}`), innerWidth, "…"),
      ),
    );
  }

  private renderBody(innerWidth: number): string[] {
    const sourceLines = this.model.body.replaceAll("\r", "␍").split("\n");
    const rendered: string[] = [];
    for (const sourceLine of sourceLines) {
      const plain = renderControlCharacters(sourceLine.replaceAll("\t", "    "));
      const styled = this.styleBodyLine(plain);
      const wrapped = wrapTextWithAnsi(styled, innerWidth);
      if (wrapped.length === 0) rendered.push("");
      else rendered.push(...wrapped);
    }
    return rendered;
  }

  private styleBodyLine(line: string): string {
    let color: ThemeColor = "toolDiffContext";
    if (line.startsWith("+") && !line.startsWith("+++")) color = "toolDiffAdded";
    else if (line.startsWith("-") && !line.startsWith("---")) color = "toolDiffRemoved";
    else if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) color = "accent";
    return this.theme.fg(color, line);
  }

  private estimateActionRowCount(innerWidth: number): number {
    let rows = 1;
    let used = 0;
    for (const action of this.model.actions) {
      const width = visibleWidth(`[ ${action.label} ]`);
      const required = used === 0 ? width : width + 2;
      if (used > 0 && used + required > innerWidth) {
        rows += 1;
        used = width;
      } else {
        used += required;
      }
    }
    return rows;
  }

  private renderActionRows(innerWidth: number, startRow: number): string[] {
    this.hitRegions = [];
    const rows: string[] = [];
    let output = "";
    let visibleWidthUsed = 0;
    let rowIndex = startRow;

    const flush = (): void => {
      rows.push(output);
      output = "";
      visibleWidthUsed = 0;
      rowIndex += 1;
    };

    this.model.actions.forEach((action, index) => {
      const label = `[ ${action.label} ]`;
      const labelWidth = visibleWidth(label);
      const separatorWidth = visibleWidthUsed === 0 ? 0 : 2;
      if (visibleWidthUsed > 0 && visibleWidthUsed + separatorWidth + labelWidth > innerWidth) {
        flush();
      }
      if (visibleWidthUsed > 0) {
        output += "  ";
        visibleWidthUsed += 2;
      }

      const focused = index === this.focusedActionIndex;
      const styled = focused
        ? this.theme.bg("selectedBg", this.theme.bold(label))
        : this.theme.fg(action.tone === "approve" ? "success" : action.tone === "reject" ? "error" : "text", label);
      const startCol = 2 + visibleWidthUsed;
      this.hitRegions.push({
        action: action.id,
        row: rowIndex,
        startCol,
        endCol: startCol + Math.min(labelWidth, innerWidth - visibleWidthUsed) - 1,
      });
      output += truncateToWidth(styled, Math.max(0, innerWidth - visibleWidthUsed));
      visibleWidthUsed += Math.min(labelWidth, innerWidth - visibleWidthUsed);
    });

    flush();
    return rows;
  }

  private frameLine(content: string, innerWidth: number, border: (text: string) => string): string {
    const clipped = truncateToWidth(content, innerWidth);
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return `${border("│")} ${clipped}${padding} ${border("│")}`;
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.tui.requestRender();
  }

  private moveFocus(delta: number): void {
    const count = this.model.actions.length;
    if (count === 0) return;
    this.focusedActionIndex = (this.focusedActionIndex + delta + count) % count;
    this.tui.requestRender();
  }

  private actionAt(row: number, col: number): TResult | undefined {
    return this.hitRegions.find(
      (region) => region.row === row && col >= region.startCol && col <= region.endCol,
    )?.action;
  }

  private finish(result: TResult | "abort"): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(result);
  }
}

export async function showReviewDialog(
  ui: ExtensionUIContext,
  preview: ReviewPreview,
  allowApproveAllForTurn: boolean,
  queueContext: QueueRunContext,
): Promise<ReviewDialogDecision> {
  const actions: Action<Exclude<ReviewDialogDecision, "abort">>[] = [
    { id: "approve", label: "Approve once", tone: "approve" },
    { id: "reject", label: "Reject", tone: "reject" },
  ];
  if (allowApproveAllForTurn) {
    actions.push({ id: "approve-turn", label: "Approve all edit/write calls for this turn", tone: "neutral" });
  }

  return ui.custom<ReviewDialogDecision>(
    (tui, theme, _keybindings, done) =>
      new ReviewDialogComponent(
        tui,
        theme,
        {
          title: `Review ${preview.tool.toUpperCase()} ${preview.path.displayPath}`,
          body: preview.previewText,
          warnings: preview.warnings.map((warning) => warning.message),
          actions,
          defaultAction: "reject",
          approveHotkeyResult: "approve",
          rejectResult: "reject",
          keyboardHint:
            "↑/↓ PgUp/PgDn scroll · Tab/Shift+Tab focus · Enter activate · y approve · n/Esc reject",
        },
        done,
        queueContext.signal,
        queueContext,
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        minWidth: 52,
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
        nonCapturing: false,
      },
    },
  );
}

export async function showRiskDialog(
  ui: ExtensionUIContext,
  preview: ReviewPreview,
  kind: RiskKind,
  signal: AbortSignal,
  queueContext?: QueueRunContext,
): Promise<RiskDialogDecision> {
  const outside = kind === "outside-cwd";
  const body = outside
    ? [
        "The approved tool call targets a path outside ctx.cwd.",
        "",
        `ctx.cwd:          ${renderControlCharacters(preview.path.cwdPath)}`,
        `requested target: ${renderControlCharacters(preview.path.lexicalPath)}`,
        `effective target: ${renderControlCharacters(preview.path.effectivePath)}`,
        "",
        "This confirmation is separate from the diff approval.",
      ].join("\n")
    : [
        "The full diff was not rendered because the preview limit was exceeded.",
        "",
        `current:  ${formatBytes(preview.current.bytes)}`,
        `proposed: ${formatBytes(preview.proposed.bytes)}`,
        "",
        "Confirm only if the bounded summary is sufficient for this call.",
      ].join("\n");

  return ui.custom<RiskDialogDecision>(
    (tui, theme, _keybindings, done) =>
      new ReviewDialogComponent(
        tui,
        theme,
        {
          title: outside ? "Outside-cwd confirmation" : "Oversized-preview confirmation",
          body,
          warnings: [
            outside
              ? "The original Pi tool will run with the user's OS permissions outside the project directory."
              : "A complete line-by-line diff was not displayed.",
          ],
          actions: [
            { id: "confirm", label: outside ? "Continue outside cwd" : "Continue without full diff", tone: "approve" },
            { id: "reject", label: "Reject", tone: "reject" },
          ],
          defaultAction: "reject",
          approveHotkeyResult: "confirm",
          rejectResult: "reject",
          keyboardHint: "Tab/Shift+Tab focus · Enter activate · y continue · n/Esc reject · Space is inert",
        },
        done,
        signal,
        queueContext,
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "84%",
        minWidth: 52,
        maxHeight: "80%",
        anchor: "center",
        margin: 2,
        nonCapturing: false,
      },
    },
  );
}

type NormalizedMouseEvent =
  | { kind: "wheel"; direction: -1 | 1 }
  | { kind: "press" | "release" | "move"; button: "left" | "other"; row: number; col: number };

function normalizeMouseEvent(event: FirstClassMouseEvent): NormalizedMouseEvent | undefined {
  const rawKind = (event.kind ?? event.type ?? event.action ?? "").toLowerCase();
  const row = integerCoordinate(event.localRow ?? event.row ?? event.y);
  const col = integerCoordinate(event.localCol ?? event.col ?? event.column ?? event.x);

  const rawButton = typeof event.button === "string" ? event.button.toLowerCase() : "";
  if (rawKind.includes("wheel") || rawButton.includes("wheel") || event.deltaY !== undefined) {
    const directionValue = (event.deltaY ?? event.direction ?? rawButton) || rawKind;
    const direction =
      typeof directionValue === "number"
        ? directionValue >= 0
          ? 1
          : -1
        : String(directionValue).toLowerCase().includes("up")
          ? -1
          : 1;
    return { kind: "wheel", direction };
  }

  const kind = rawKind.includes("release") || rawKind.includes("mouseup") || rawKind === "up"
    ? "release"
    : rawKind.includes("move") || rawKind.includes("drag")
      ? "move"
      : rawKind.includes("press") || rawKind.includes("mousedown") || rawKind === "down"
        ? "press"
        : undefined;
  if (!kind || row === undefined || col === undefined) return undefined;

  const button =
    event.button === "left" ||
    event.button === "primary" ||
    event.button === "left-button" ||
    event.button === 0 ||
    event.button === 1
      ? "left"
      : "other";
  return { kind, button, row, col };
}
function integerCoordinate(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
