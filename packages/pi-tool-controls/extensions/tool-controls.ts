import type { ExtensionApiLike, ExtensionContextLike } from "./tool-controls/contracts.js";
import { ToolControlsRuntime } from "./tool-controls/runtime.js";

let runtime: ToolControlsRuntime | undefined;

function replaceRuntime(ctx: ExtensionContextLike): ToolControlsRuntime {
  runtime?.cleanup();
  runtime = new ToolControlsRuntime(ctx);
  return runtime;
}

function ensureRuntime(ctx: ExtensionContextLike): ToolControlsRuntime {
  if (!runtime || runtime.context.ui !== ctx.ui) return replaceRuntime(ctx);
  return runtime;
}

export default function toolControlsExtension(pi: ExtensionApiLike): void {
  pi.registerCommand("tool-controls", {
    description: "Open bulk controls for Pi tool output expansion",
    handler: async (_args, ctx) => {
      const active = ensureRuntime(ctx);
      await active.start();
      await active.openOverlay();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const active = replaceRuntime(ctx);
    await active.start();
  });

  for (const event of ["turn_start", "tool_execution_start", "tool_execution_end"] as const) {
    pi.on(event, () => {
      runtime?.requestRefresh();
    });
  }

  pi.on("session_shutdown", () => {
    runtime?.cleanup();
    runtime = undefined;
  });
}
