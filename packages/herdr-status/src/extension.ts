import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ActivityController } from "./activity.ts";
import { systemClock, type Clock, type TimerHandle } from "./clock.ts";
import {
  HerdrCli,
  resolveActivation,
  type ActivationState,
  type ExecutableCheck,
  type MetadataTransport,
} from "./herdr-client.ts";
import type { PiExtensionApi, PiExtensionContext, PiUi } from "./pi-types.ts";
import { MetadataReporter } from "./reporter.ts";
import { readSettings } from "./settings.ts";
import { runSidebarSettings } from "./settings-menu.ts";
import { renderHerdrStatus } from "./status.ts";

export interface ExtensionDependencies {
  environment?: NodeJS.ProcessEnv;
  executableCheck?: ExecutableCheck;
  clock?: Clock;
  agentDir?: string;
  transportFactory?: (activation: Required<Pick<ActivationState, "paneId" | "binaryPath">>) => MetadataTransport;
}

export interface HerdrStatusRuntime {
  activation: ActivationState;
  reporter?: MetadataReporter;
  controller: ActivityController;
}

function loadedIdentity(): string {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const hash = createHash("sha256");
    for (const directory of ["extensions", "src"]) {
      for (const name of readdirSync(join(root, directory)).filter((name) => name.endsWith(".ts")).sort()) {
        hash.update(`${directory}/${name}\0`).update(readFileSync(join(root, directory, name))).update("\0");
      }
    }
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
    return `Loaded: ${version}, PID ${process.pid}\nSource SHA-256: ${hash.digest("hex")}`;
  } catch {
    return `Loaded: PID ${process.pid}; source identity unavailable`;
  }
}

export function registerHerdrStatusExtension(
  pi: PiExtensionApi,
  dependencies: ExtensionDependencies = {},
): HerdrStatusRuntime {
  const environment = dependencies.environment ?? process.env;
  const activation = resolveActivation(environment, dependencies.executableCheck);
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const clock = dependencies.clock ?? systemClock;
  let selected = readSettings(agentDir);
  let lastUi: PiUi | undefined;
  let lastContext: PiExtensionContext | undefined;
  let settingsTimer: TimerHandle | undefined;
  let lastWarning: string | undefined;
  let reporter: MetadataReporter | undefined;
  const identity = loadedIdentity();

  if (activation.active && activation.paneId && activation.binaryPath) {
    const activeTarget = { paneId: activation.paneId, binaryPath: activation.binaryPath };
    const transport = dependencies.transportFactory
      ? dependencies.transportFactory(activeTarget)
      : new HerdrCli({ ...activeTarget, environment });
    reporter = new MetadataReporter(transport, {
      clock,
      notifyPaused: (message) => {
        try {
          lastUi?.notify(message, "warning");
        } catch {
          // UI failures must not interrupt metadata reporting.
        }
      },
    });
  }
  const controller = new ActivityController(reporter, {
    clock,
    settings: selected.settings,
    inHerdr: environment.HERDR_ENV === "1",
    getSessionName: () => pi.getSessionName?.(),
  });
  const capture = (ctx: PiExtensionContext): void => {
    lastUi = ctx.ui;
    lastContext = ctx;
  };
  const refreshSettings = (): void => {
    try {
      const next = readSettings(agentDir);
      if (next.warning && next.warning !== lastWarning) lastUi?.notify(next.warning, "warning");
      lastWarning = next.warning;
      if (next.revision !== selected.revision) {
        selected = next;
        if (lastContext) controller.onSettingsChanged(next.settings, lastContext);
      }
    } catch (error) {
      const warning = `Could not refresh sidebar settings: ${error instanceof Error ? error.message : String(error)}`;
      if (warning !== lastWarning) lastUi?.notify(warning, "warning");
      lastWarning = warning;
    }
  };

  pi.registerCommand("herdr-sidebar-settings", {
    description: "Configure the Herdr sidebar, title animation, and display diagnostics",
    handler: async (args, ctx) => {
      capture(ctx);
      await runSidebarSettings(args, ctx, {
        agentDir,
        ...(activation.active && activation.binaryPath ? { herdr: { binaryPath: activation.binaryPath, environment } } : {}),
        apply: (settings) => {
          selected = readSettings(agentDir);
          controller.onSettingsChanged(settings, ctx);
        },
        diagnostics: () => [
          identity,
          renderHerdrStatus(activation, reporter?.getStatus()),
          "Native Herdr fields: agent, state icon/text, machine, workspace, tab, pane, terminal title.",
          "Added here: model/context, optional observed edit count/turn, and title animation.",
          "Git branch/status belong to Herdr's workspace list, not agent rows.",
          `Animation: ${selected.settings.animation}; model names: ${selected.settings.modelName}.`,
          "Only /herdr-sidebar-settings is registered by this presentation package.",
        ].join("\n"),
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    capture(ctx);
    refreshSettings();
    controller.onSessionStart(ctx);
    if (settingsTimer !== undefined) clock.clearInterval(settingsTimer);
    settingsTimer = clock.setInterval(refreshSettings, 5_000);
    settingsTimer.unref?.();
  });
  pi.on("before_agent_start", (_event, ctx) => { capture(ctx); controller.onAgentStart(ctx); });
  pi.on("agent_start", (_event, ctx) => { capture(ctx); controller.onAgentStart(ctx); });
  pi.on("turn_start", (event, ctx) => { capture(ctx); controller.onTurnStart(event, ctx); });
  pi.on("message_update", (event, ctx) => { capture(ctx); controller.onMessageUpdate(event, ctx); });
  pi.on("tool_execution_start", (event, ctx) => { capture(ctx); controller.onToolExecutionStart(event, ctx); });
  pi.on("tool_execution_update", (event, ctx) => { capture(ctx); controller.onToolExecutionUpdate(event, ctx); });
  pi.on("tool_execution_end", (event, ctx) => { capture(ctx); controller.onToolExecutionEnd(event, ctx); });
  pi.on("model_select", (event, ctx) => { capture(ctx); controller.onModelSelect(event, ctx); });
  pi.on("thinking_level_select", (event, ctx) => { capture(ctx); controller.onThinkingLevelSelect(event, ctx); });
  pi.on("session_info_changed", (_event, ctx) => { capture(ctx); controller.onSessionInfoChanged(ctx); });
  pi.on("session_before_compact", (event, ctx) => { capture(ctx); controller.onBeforeCompact(ctx, event.signal); });
  pi.on("session_compact", (event, ctx) => { capture(ctx); controller.onCompact(ctx, event.willRetry); });
  pi.on("session_compact_failed", (event, ctx) => { capture(ctx); controller.onCompactFailed(ctx, event.willRetry); });
  pi.on("agent_settled", (_event, ctx) => { capture(ctx); controller.onAgentSettled(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (settingsTimer !== undefined) clock.clearInterval(settingsTimer);
    settingsTimer = undefined;
    lastContext = undefined;
    await controller.onSessionShutdown(ctx);
  });
  return { activation, ...(reporter ? { reporter } : {}), controller };
}
