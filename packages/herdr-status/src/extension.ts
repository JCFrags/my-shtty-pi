import { ActivityController } from "./activity.ts";
import { systemClock, type Clock } from "./clock.ts";
import {
  HerdrCli,
  resolveActivation,
  type ActivationState,
  type ExecutableCheck,
  type MetadataTransport,
} from "./herdr-client.ts";
import type { PiExtensionApi, PiUi } from "./pi-types.ts";
import { MetadataReporter } from "./reporter.ts";
import { renderHerdrStatus } from "./status.ts";

export interface ExtensionDependencies {
  environment?: NodeJS.ProcessEnv;
  executableCheck?: ExecutableCheck;
  clock?: Clock;
  transportFactory?: (activation: Required<Pick<ActivationState, "paneId" | "binaryPath">>) => MetadataTransport;
}

export interface HerdrStatusRuntime {
  activation: ActivationState;
  reporter?: MetadataReporter;
  controller?: ActivityController;
}

export function registerHerdrStatusExtension(
  pi: PiExtensionApi,
  dependencies: ExtensionDependencies = {},
): HerdrStatusRuntime {
  const environment = dependencies.environment ?? process.env;
  const activation = resolveActivation(environment, dependencies.executableCheck);
  let reporter: MetadataReporter | undefined;
  let controller: ActivityController | undefined;
  let lastUi: PiUi | undefined;

  pi.registerCommand("herdr-status", {
    description: "Show display-only Herdr metadata reporting status",
    handler: (_args, ctx) => {
      lastUi = ctx.ui;
      ctx.ui.notify(renderHerdrStatus(activation, reporter?.getStatus()), "info");
    },
  });

  if (!activation.active || !activation.paneId || !activation.binaryPath) {
    return { activation };
  }

  const activeTarget = {
    paneId: activation.paneId,
    binaryPath: activation.binaryPath,
  };
  const transport = dependencies.transportFactory
    ? dependencies.transportFactory(activeTarget)
    : new HerdrCli({
        binaryPath: activeTarget.binaryPath,
        paneId: activeTarget.paneId,
        environment,
      });
  const clock = dependencies.clock ?? systemClock;

  reporter = new MetadataReporter(transport, {
    clock,
    notifyPaused: (message) => {
      try {
        lastUi?.notify(message, "warning");
      } catch {
        // UI notification failures must never affect Pi or metadata reporting.
      }
    },
  });
  controller = new ActivityController(reporter, { clock });

  pi.on("session_start", (_event, ctx) => {
    lastUi = ctx.ui;
    controller?.onSessionStart(ctx);
  });
  pi.on("turn_start", (event, ctx) => {
    lastUi = ctx.ui;
    controller?.onTurnStart(event, ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    lastUi = ctx.ui;
    controller?.onToolExecutionStart(event, ctx);
  });
  pi.on("tool_execution_update", (event, ctx) => {
    lastUi = ctx.ui;
    controller?.onToolExecutionUpdate(event);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    lastUi = ctx.ui;
    controller?.onToolExecutionEnd(event, ctx);
  });
  pi.on("model_select", (event, ctx) => {
    lastUi = ctx.ui;
    controller?.onModelSelect(event, ctx);
  });
  pi.on("thinking_level_select", (event, ctx) => {
    lastUi = ctx.ui;
    controller?.onThinkingLevelSelect(event, ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    lastUi = ctx.ui;
    controller?.onAgentSettled(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    lastUi = ctx.ui;
    await controller?.onSessionShutdown();
  });

  return { activation, reporter, controller };
}
