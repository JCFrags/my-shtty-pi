import { ProjectGlanceQuestionService } from "../questions/service.js";
import { QUESTION_ENTRY_TYPE } from "../questions/model.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_GLANCE_COMMAND,
  PROJECT_GLANCE_CUSTOM_ENTRY_PREFIX,
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

  let activeContext: ExtensionContext | undefined;
  const questions = new ProjectGlanceQuestionService({
    events: pi.events,
    getContext: () => activeContext && typeof activeContext.isIdle === "function" && typeof activeContext.sessionManager.getEntries === "function" && typeof activeContext.sessionManager.getSessionFile === "function" ? activeContext : undefined,
    appendEntry: (data) => pi.appendEntry(QUESTION_ENTRY_TYPE, data),
    sendMessage: (message) => pi.sendMessage(message, { triggerTurn: false }),
    onChange: () => { void runtime.refreshQuestions().catch(() => undefined); },
  });
  const runtime = new ProjectGlanceRelayRuntime(
    process.env,
    pi.events,
    (data) => pi.appendEntry(`${PROJECT_GLANCE_CUSTOM_ENTRY_PREFIX}ui-state-v1`, data),
    (count, pending, storageError) => activeContext?.ui.setStatus(PROJECT_GLANCE_COMMAND, count + pending > 0 || storageError ? `Glance ${count}${pending ? ` · ${pending} question${pending === 1 ? "" : "s"}` : ""}${storageError ? " · storage error" : ""}` : undefined),
    {
      questions: () => questions.questions,
      hiddenAttention: () => questions.hiddenAttention,
      applyAction: (action, actionId) => questions.applyAction(action, actionId),
      setEditing: (owner, value) => questions.setEditing(owner, value),
      releaseEditing: (owner) => questions.releaseEditing(owner),
    },
  );
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    questions.stop();
    activeContext?.ui.setStatus(PROJECT_GLANCE_COMMAND, undefined);
    activeContext = undefined;
    await runtime.stop();
    if (globalRuntime()[RUNTIME_SLOT]?.runtime === runtime) {
      delete globalRuntime()[RUNTIME_SLOT];
    }
  };
  globalRuntime()[RUNTIME_SLOT] = { runtime, dispose };
  questions.start();

  pi.registerCommand(PROJECT_GLANCE_COMMAND, {
    description: "Open the Project Glance side pane.",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      questions.sync();
      await handleProjectGlanceCommand(pi, ctx, runtime);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    questions.start();
    activeContext = ctx;
    questions.sync();
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
    activeContext = ctx;
    questions.sessionTree(ctx);
    questions.sync();
    await runtime.onSessionTree(ctx);
  });
  pi.on("message_end", (_event, ctx) => {
    runtime.onMessageEnd(ctx);
  });
  // message_end runs before persistence and later handlers can await work.
  // These ordered boundaries run after preceding messages have been saved.
  pi.on("agent_start", (_event, ctx) => {
    activeContext = ctx;
    questions.agentStart(ctx);
  });
  pi.on("ui_prompt_start", (_event, ctx) => questions.uiPromptStart(ctx));
  pi.on("ui_prompt_end", (_event, ctx) => questions.uiPromptEnd(ctx));
  pi.on("tool_execution_end", (event, ctx) => questions.toolEnd(event, ctx));
  pi.on("tool_execution_start", async (event, ctx) => {
    activeContext = ctx;
    questions.toolStart(event, ctx);
    questions.sync();
    await runtime.syncFeed(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    await runtime.syncFeed(ctx);
  });
  pi.on("agent_end", async (event, ctx) => {
    questions.agentEnd(event, ctx);
    await runtime.syncFeed(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    activeContext = ctx;
    questions.agentSettled(ctx);
    await runtime.syncFeed(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    questions.stop();
    ctx.ui.setStatus(PROJECT_GLANCE_COMMAND, undefined);
    activeContext = undefined;
    await runtime.stop();
  });
}
