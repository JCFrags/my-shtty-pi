import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brokerRequest } from "../cli/client.js";
import { resolveHerdrPaths } from "../shared/paths.js";
import { openAgentSettings, type AgentSettingsClient } from "./agent-settings.js";
import type { PiContextLike } from "./types.js";

/** Settings use authenticated short-lived requests, not an agent lifecycle adapter. */
export async function settingsClient(): Promise<AgentSettingsClient> {
  const { paths } = await resolveHerdrPaths();
  return {
    connected: true,
    request: (method, params) => brokerRequest(
      paths.socket, paths.secret, method, { ...params }, paths.sessionKey,
      { timeoutMs: 60_000 },
    ),
  };
}

export function registerAgentSettings(api: ExtensionAPI): void {
  api.registerCommand("agent-settings", {
    description: "Choose agent models and per-model thinking levels",
    handler: async (_args, raw) => {
      const context = raw as PiContextLike;
      if (context.mode !== "tui") {
        context.ui.notify?.("Agent settings require TUI mode.", "warning");
        return;
      }
      try {
        await openAgentSettings(await settingsClient(), context);
      } catch {
        context.ui.notify?.("Agent settings are unavailable. Check broker startup and authentication.", "warning");
      }
    },
  });
}
