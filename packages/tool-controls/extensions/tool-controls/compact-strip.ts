import type {
  ComponentLike,
  ComponentMouseEvent,
  ThemeLike,
  TuiLike,
} from "./contracts.js";
import { createCompactLayout, type CompactAction, type CompactLayout } from "./compact-layout.js";
import { normalizeMouseEvent, PressReleaseTracker } from "./mouse.js";
import { fitLine, paint } from "./text.js";
import type { ToolStateController } from "./controller.js";

export interface CompactStripOptions {
  controller: ToolStateController;
  tui: TuiLike;
  theme: ThemeLike;
  openOverlay(): void;
  isOverlayOpen(): boolean;
  onFatal(error: unknown): void;
}

export class CompactToolStrip implements ComponentLike {
  private layout: CompactLayout | undefined;
  private readonly tracker = new PressReleaseTracker();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private pendingAction: Promise<void> = Promise.resolve();

  constructor(private readonly options: CompactStripOptions) {
    this.unsubscribe = options.controller.onChange(() => {
      this.options.tui.requestRender();
    });
  }

  render(width: number): string[] {
    try {
      if (this.disposed) return [];
      const snapshot = this.options.controller.snapshot();
      if (snapshot.mode !== "full") {
        const message =
          snapshot.mode === "legacy"
            ? "pi-tool-controls: patched per-tool UI unavailable; run /tool-controls for legacy global controls"
            : "pi-tool-controls: required Pi capabilities unavailable; run /tool-controls for details";
        return [paint(this.options.theme, "warning", fitLine(message, width))];
      }

      this.layout = createCompactLayout(width, {
        expanded: snapshot.expandedCount,
        total: snapshot.totalCount,
        canExpandTurn: this.options.controller.canSetGroupExpanded("currentTurn", true),
        canCollapseTurn: this.options.controller.canSetGroupExpanded("currentTurn", false),
        busy: snapshot.busy,
      });

      const pressedId = this.tracker.pressedRegionId;
      const segments = this.layout.controls.map((control) => {
        if (!control.enabled) return paint(this.options.theme, "dim", control.label);
        if (control.id === pressedId) return paint(this.options.theme, "accent", control.label);
        return paint(this.options.theme, "text", control.label);
      });
      return [segments.join(" ")];
    } catch (error) {
      this.options.onFatal(error);
      return [];
    }
  }

  handleMouse(rawEvent: ComponentMouseEvent): void {
    try {
      if (this.disposed || this.options.isOverlayOpen() || !this.layout) return;
      const event = normalizeMouseEvent(rawEvent);
      if (!event) return;
      if (event.button === "middle" || event.button === "right") {
        this.tracker.reset();
        return;
      }

      if (event.phase === "press") {
        if (this.tracker.press(event, this.layout.regions)) {
          this.options.tui.requestRender();
        }
        return;
      }

      if (event.phase === "move") {
        if (this.tracker.move(event)) this.options.tui.requestRender();
        return;
      }

      if (event.phase === "release") {
        const action = this.tracker.release(event, this.layout.regions) as
          | CompactAction
          | undefined;
        this.options.tui.requestRender();
        if (action) {
          this.pendingAction = this.pendingAction
            .then(() => this.activate(action))
            .catch((error) => this.options.onFatal(error));
        }
      }
    } catch (error) {
      this.options.onFatal(error);
    }
  }

  private async activate(action: CompactAction): Promise<void> {
    if (action === "open" || action === "more") {
      this.options.openOverlay();
      return;
    }
    if (action === "expand-turn") {
      await this.options.controller.setGroupExpanded("currentTurn", true);
      return;
    }
    await this.options.controller.setGroupExpanded("currentTurn", false);
  }

  invalidate(): void {
    this.layout = undefined;
    this.tracker.reset();
    this.options.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.tracker.reset();
  }

  currentLayout(): CompactLayout | undefined {
    return this.layout;
  }

  async whenIdle(): Promise<void> {
    await this.pendingAction;
  }
}
