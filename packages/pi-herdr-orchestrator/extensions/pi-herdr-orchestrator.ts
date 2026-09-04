import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openPiHerd } from "../src/herdr/pi-herd-command.js";
import { registerSubagentChannel } from "../src/orchestrator/child-tool.js";
import { registerOrchestrate } from "../src/orchestrator/tool.js";

type CommandContext = {
  ui?: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
};

function registerBoardCommands(api: ExtensionAPI): void {
  const openBoard = async (
    _args: string,
    rawContext: unknown,
  ): Promise<void> => {
    const context = rawContext as CommandContext;
    try {
      context.ui?.notify(await openPiHerd(), "info");
    } catch (error) {
      context.ui?.notify(
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    }
  };

  api.registerCommand("agent-board", {
    description: "Open and focus Agent Board beside this Pi pane",
    handler: openBoard,
  });
  api.registerCommand("pi-herd", {
    description: "Open Agent Board (Pi Herd compatibility alias)",
    handler: openBoard,
  });
}

/** Direct-Herdr root orchestration or exact managed-child channel. */
export default function piHerdrOrchestrator(api: ExtensionAPI): void {
  if (process.env.PI_HERDR_AGENT_ID) {
    registerSubagentChannel(api);
    return;
  }
  registerOrchestrate(api);
  registerBoardCommands(api);
}
