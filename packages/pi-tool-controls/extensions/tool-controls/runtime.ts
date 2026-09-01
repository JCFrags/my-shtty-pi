import type {
  ComponentLike,
  ExtensionContextLike,
  KeybindingsLike,
  OverlayOptionsLike,
  ThemeLike,
  TuiLike,
} from "./contracts.js";
import { ToolStateController } from "./controller.js";
import { CompactToolStrip } from "./compact-strip.js";
import { LegacyToolControlsOverlay } from "./legacy-overlay.js";
import { ToolControlsOverlay } from "./overlay.js";

const WIDGET_KEY = "pi-tool-controls";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ToolControlsRuntime {
  readonly controller: ToolStateController;

  private widget: ComponentLike | undefined;
  private overlay: ComponentLike | undefined;
  private overlayDone: (() => void) | undefined;
  private overlayTui: TuiLike | undefined;
  private overlayOpen = false;
  private started = false;
  private cleaned = false;
  private failed = false;
  private missingNoticeShown = false;

  constructor(readonly context: ExtensionContextLike) {
    this.controller = new ToolStateController(context.ui, (notice) => {
      try {
        context.ui.notify(notice.message, notice.type);
      } catch {
        // Notifications are advisory and must not destabilize Pi.
      }
    });
  }

  async start(): Promise<void> {
    if (this.cleaned || this.failed || this.started) return;
    this.started = true;

    try {
      this.context.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          if (tui.mode === "fullscreen") tui.setMouseCapture?.(false);
          const widget = new CompactToolStrip({
            controller: this.controller,
            tui,
            theme,
            openOverlay: () => {
              void this.openOverlay();
            },
            isOverlayOpen: () => this.overlayOpen,
            onFatal: (error) => this.fail(error),
          });
          this.widget = widget;
          return widget;
        },
        { placement: "belowEditor" },
      );
    } catch (error) {
      this.started = false;
      this.fail(error);
      return;
    }

    this.controller.subscribeToExpansionChanges();
    await this.controller.refresh();
    this.showMissingCapabilityNotice();
  }

  requestRefresh(): void {
    if (this.cleaned || this.failed) return;
    void this.controller.refresh();
  }

  async openOverlay(): Promise<void> {
    if (this.cleaned || this.failed || this.overlayOpen) return;
    this.overlayOpen = true;
    this.widget?.invalidate();

    try {
      await this.context.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let closed = false;
          const close = (): void => {
            if (closed) return;
            closed = true;
            done(undefined);
          };
          this.overlayDone = close;
          this.overlayTui = tui;
          if (tui.mode === "fullscreen") tui.setMouseCapture?.(true);
          const component = this.createOverlayComponent(tui, theme, keybindings, close);
          this.overlay = component;
          return component;
        },
        {
          overlay: true,
          overlayOptions: (): OverlayOptionsLike => ({
            width: "96%",
            maxHeight: "94%",
            anchor: "center",
            margin: 1,
          }),
        },
      );
    } catch (error) {
      if (!this.failed) {
        try {
          this.context.ui.notify(
            `pi-tool-controls could not open the overlay: ${messageOf(error)}`,
            "error",
          );
        } catch {
          // A broken notification path is non-fatal.
        }
      }
    } finally {
      this.overlay?.dispose?.();
      this.overlay = undefined;
      this.overlayDone = undefined;
      if (this.overlayTui?.mode === "fullscreen") this.overlayTui.setMouseCapture?.(false);
      this.overlayTui = undefined;
      this.overlayOpen = false;
      this.widget?.invalidate();
    }
  }

  private createOverlayComponent(
    tui: TuiLike,
    theme: ThemeLike,
    keybindings: KeybindingsLike,
    close: () => void,
  ): ComponentLike {
    if (this.controller.capabilities.mode === "full") {
      return new ToolControlsOverlay({
        controller: this.controller,
        tui,
        theme,
        keybindings,
        close,
        onFatal: (error) => {
          close();
          this.fail(error);
        },
      });
    }

    return new LegacyToolControlsOverlay({
      controller: this.controller,
      tui,
      theme,
      keybindings,
      close,
      onFatal: (error) => {
        close();
        this.fail(error);
      },
    });
  }

  closeOverlay(): void {
    try {
      this.overlayDone?.();
    } catch {
      // Cleanup remains best-effort.
    }
  }

  private showMissingCapabilityNotice(): void {
    if (this.missingNoticeShown || this.controller.capabilities.mode === "full") return;
    this.missingNoticeShown = true;
    const suffix =
      this.controller.capabilities.mode === "legacy"
        ? " Use /tool-controls for keyboard-accessible global expand/collapse."
        : " This Pi build also lacks getToolsExpanded()/setToolsExpanded(), so no compatibility action is available.";
    try {
      this.context.ui.notify(`${this.controller.missingCapabilityMessage()}.${suffix}`, "warning");
    } catch {
      // Notification failure is non-fatal.
    }
  }

  fail(error: unknown): void {
    if (this.failed || this.cleaned) return;
    this.failed = true;
    this.closeOverlay();
    this.controller.dispose();
    try {
      this.widget?.dispose?.();
      this.context.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
    } catch {
      // The package is already disabled; suppress cleanup failures.
    }
    this.widget = undefined;
    try {
      this.context.ui.notify(
        `pi-tool-controls was removed after a UI render/event error: ${messageOf(error)}`,
        "error",
      );
    } catch {
      // Notify once when possible; never rethrow into Pi.
    }
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.closeOverlay();
    this.controller.dispose();
    try {
      this.widget?.dispose?.();
      this.context.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
    } catch {
      // Session shutdown and reload cleanup must not throw.
    }
    this.widget = undefined;
  }

  isOverlayOpen(): boolean {
    return this.overlayOpen;
  }
}
