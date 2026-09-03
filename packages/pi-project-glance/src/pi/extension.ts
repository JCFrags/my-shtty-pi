import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_GLANCE_COMMAND,
} from "../protocol/model.js";
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
  if (previous) await previous.dispose();

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
      runtime.refreshCurrent();
      await handleProjectGlanceCommand(pi, ctx, runtime);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await runtime.ensureForContext(ctx);
    } catch {
      ctx.ui.notify("Project Glance relay is unavailable.", "warning");
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    runtime.onSessionTree(ctx);
  });
  pi.on("session_shutdown", async (_event, _ctx) => {
    await runtime.stop();
  });
}
