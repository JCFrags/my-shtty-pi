import type {
  ComponentLike,
  ComponentMouseEvent,
  KeybindingsLike,
  ThemeLike,
  TuiLike,
} from "./contracts.js";
import type { ToolStateController } from "./controller.js";
import { normalizeMouseEvent, PressReleaseTracker, type HitRegion } from "./mouse.js";
import { emphasize, fitLine, paint, textWidth } from "./text.js";

interface LegacyOverlayOptions {
  controller: ToolStateController;
  tui: TuiLike;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  close(): void;
  onFatal(error: unknown): void;
}

type LegacyButton = "legacy:expand" | "legacy:collapse";

function matches(
  keybindings: KeybindingsLike,
  data: string,
  ids: readonly string[],
): boolean {
  if (typeof keybindings.matches !== "function") return false;
  return ids.some((id) => {
    try {
      return Boolean(keybindings.matches?.(data, id));
    } catch {
      return false;
    }
  });
}

export class LegacyToolControlsOverlay implements ComponentLike {
  private focus: LegacyButton = "legacy:expand";
  private regions: HitRegion[] = [];
  private readonly tracker = new PressReleaseTracker();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private pendingAction: Promise<void> = Promise.resolve();

  constructor(private readonly options: LegacyOverlayOptions) {
    this.unsubscribe = options.controller.onChange(() => options.tui.requestRender());
  }

  render(width: number): string[] {
    try {
      if (this.disposed) return [];
      const snapshot = this.options.controller.snapshot();
      const expanded = snapshot.legacyExpanded;
      const prefix = "Global tool output  ";
      const expandLabel = "[Expand all]";
      const collapseLabel = "[Collapse all]";
      const expandStart = textWidth(prefix);
      const expandEnd = expandStart + textWidth(expandLabel);
      const collapseStart = expandEnd + 1;
      const collapseEnd = collapseStart + textWidth(collapseLabel);
      const expandEnabled = snapshot.mode === "legacy" && !snapshot.busy && !expanded;
      const collapseEnabled = snapshot.mode === "legacy" && !snapshot.busy && expanded;

      this.regions = [
        {
          id: "legacy:expand",
          role: "button",
          rowStart: 3,
          rowEnd: 4,
          colStart: expandStart,
          colEnd: expandEnd,
          enabled: expandEnabled,
        },
        {
          id: "legacy:collapse",
          role: "button",
          rowStart: 3,
          rowEnd: 4,
          colStart: collapseStart,
          colEnd: collapseEnd,
          enabled: collapseEnabled,
        },
      ];

      const style = (id: LegacyButton, label: string, enabled: boolean): string => {
        if (!enabled) return paint(this.options.theme, "dim", label);
        if (this.focus === id || this.tracker.pressedRegionId === id) {
          return paint(this.options.theme, "accent", label);
        }
        return label;
      };

      return [
        emphasize(this.options.theme, fitLine("Tool controls — compatibility mode", width)),
        paint(
          this.options.theme,
          "warning",
          fitLine(this.options.controller.missingCapabilityMessage(), width),
        ),
        fitLine("Per-card state and mouse controls require the patched Pi API.", width),
        fitLine(
          `${prefix}${style("legacy:expand", expandLabel, expandEnabled)} ${style(
            "legacy:collapse",
            collapseLabel,
            collapseEnabled,
          )}`,
          width,
        ),
        paint(this.options.theme, "dim", fitLine("↑/↓ focus  Enter activate  Esc close", width)),
      ];
    } catch (error) {
      this.options.onFatal(error);
      return [];
    }
  }

  handleInput(data: string): void {
    try {
      if (this.disposed) return;
      if (data === "\x1b" || data === "escape" || data === "\x03") {
        this.options.close();
        return;
      }
      if (
        data === "\x1b[A" ||
        data === "\x1b[B" ||
        data === "up" ||
        data === "down" ||
        matches(this.options.keybindings, data, ["tui.select.up", "tui.select.down"])
      ) {
        this.focus = this.focus === "legacy:expand" ? "legacy:collapse" : "legacy:expand";
        this.options.tui.requestRender();
        return;
      }
      if (
        data === "\r" ||
        data === "\n" ||
        data === "enter" ||
        matches(this.options.keybindings, data, ["tui.select.confirm", "tui.input.submit"])
      ) {
        this.queueAction(this.focus);
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
      if (event.phase === "press") {
        if (this.tracker.press(event, this.regions)) this.options.tui.requestRender();
        return;
      }
      if (event.phase === "move") {
        if (this.tracker.move(event)) this.options.tui.requestRender();
        return;
      }
      if (event.phase === "release") {
        const id = this.tracker.release(event, this.regions) as LegacyButton | undefined;
        this.options.tui.requestRender();
        if (id) {
          this.focus = id;
          this.queueAction(id);
        }
      }
    } catch (error) {
      this.options.onFatal(error);
    }
  }

  private queueAction(id: LegacyButton): void {
    this.pendingAction = this.pendingAction
      .then(() => this.options.controller.setLegacyExpanded(id === "legacy:expand"))
      .catch((error) => this.options.onFatal(error));
  }

  invalidate(): void {
    this.regions = [];
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

  currentHitRegions(): readonly HitRegion[] {
    return this.regions.map((region) => ({ ...region }));
  }

  currentFocus(): LegacyButton {
    return this.focus;
  }

  async whenIdle(): Promise<void> {
    await this.pendingAction;
  }
}
