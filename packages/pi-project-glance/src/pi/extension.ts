import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_GLANCE_COMMAND,
} from "../protocol/model.js";
import { projectGlanceDiagnostic, projectGlanceError } from "./errors.js";
import { handleProjectGlanceCommand } from "./open-pane.js";
import { ProjectGlanceRelayRuntime } from "./lifecycle.js";

const RUNTIME_SLOT = Symbol.for("pi-project-glance.extension-runtime");

type RuntimeSlot = {
  runtime: ProjectGlanceRelayRuntime;
  dispose(): Promise<void>;
};

type GlobalRuntime = typeof globalThis & {
  [RUNTIME_SLOT]?: RuntimeSlot;
};

function globalRuntime(): GlobalRuntime {
  return globalThis as GlobalRuntime;
}

export default async function projectGlanceExtension(pi: ExtensionAPI): Promise<void> {
  const previous = globalRuntime()[RUNTIME_SLOT];
  if (previous) {
    try {
      await previous.dispose();
    } catch {
      // Keep command registration available on /reload; the next command
      // reports the actionable runtime diagnostic instead of losing the whole
      // extension because an old relay cleanup failed.
    }
  }

  const runtime = new ProjectGlanceRelayRuntime(process.env, pi.events);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await runtime.stop();
    if (globalRuntime()[RUNTIME_SLOT]?.runtime === runtime) {
      delete globalRuntime()[RUNTIME_SLOT];
    }
  };
  globalRuntime()[RUNTIME_SLOT] = { runtime, dispose };

  pi.registerCommand(PROJECT_GLANCE_COMMAND, {
    description: "Open the Project Glance side pane.",
    handler: async (_args, ctx) => {
      await handleProjectGlanceCommand(pi, ctx, runtime);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await runtime.ensureForContext(ctx);
    } catch (error) {
      const diagnostic =
        error instanceof Error && error.name === "ProjectGlanceCommandError"
          ? error
          : projectGlanceError("PROJECT_GLANCE_RUNTIME_START_FAILED");
      ctx.ui.notify(projectGlanceDiagnostic(diagnostic), "warning");
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    await runtime.onSessionTree(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    runtime.onMessageEnd(ctx);
  });
  pi.on("session_shutdown", async (_event, _ctx) => {
    await runtime.stop();
  });
}
