import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RepositoryTree } from "../../src/filesystem.ts";
import { PreviewService } from "../../src/preview.ts";
import type { BrowserSessionState } from "../../src/types.ts";
import { FilesBrowserComponent, type BrowserTuiLike } from "../../src/ui/files-browser.ts";
import { sanitizeTerminalText } from "../../src/ui/text.ts";

function createSessionState(): BrowserSessionState {
  return {
    selectedPaths: new Set<string>(),
    showHidden: false,
    expandedPaths: new Set<string>(),
  };
}

export default function filesExtension(pi: ExtensionAPI): void {
  let state = createSessionState();
  let active: FilesBrowserComponent | undefined;

  pi.on("session_start", () => {
    if (!active) state = createSessionState();
  });

  pi.on("session_shutdown", () => {
    active?.close();
    active = undefined;
    state = createSessionState();
  });

  pi.registerCommand("files", {
    description: "Browse repository files and paste selected paths or bounded contents into the editor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || ctx.hasUI === false) {
        ctx.ui.notify("/files requires Pi's interactive TUI", "error");
        return;
      }
      if (active && !active.isDisposed) {
        ctx.ui.notify("The files browser is already open", "warning");
        return;
      }

      const tree = new RepositoryTree(ctx.cwd);
      try {
        await tree.initialize();
      } catch (error) {
        tree.dispose();
        ctx.ui.notify(
          `Could not open ${sanitizeTerminalText(ctx.cwd)}: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
          "error",
        );
        return;
      }
      const preview = new PreviewService(tree);

      let component: FilesBrowserComponent | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, _theme, _keybindings, done) => {
            component = new FilesBrowserComponent({
              tree,
              preview,
              tui: tui as BrowserTuiLike,
              ui: ctx.ui,
              done: () => done(undefined),
              state,
              onDispose: () => {
                if (active === component) active = undefined;
              },
            });
            active = component;
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "100%",
              maxHeight: "100%",
              row: 0,
              col: 0,
              margin: 0,
              anchor: "top-left",
            },
          },
        );
      } catch (error) {
        ctx.ui.notify(
          `The files browser closed with an error: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
          "error",
        );
      } finally {
        component?.dispose();
        if (!component) tree.dispose();
        if (active === component) active = undefined;
      }
    },
  });
}
