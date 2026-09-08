import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentChannel } from "../src/orchestrator/child-tool.js";
import { registerOrchestrate } from "../src/orchestrator/tool.js";
import { registerAgentSettings } from "../src/pi/settings-command.js";

/** Direct-Herdr root orchestration or exact managed-child channel. */
export default function piHerdrOrchestrator(api: ExtensionAPI): void {
  if (process.env.PI_HERDR_AGENT_ID) {
    registerSubagentChannel(api);
    return;
  }
  registerOrchestrate(api);
  registerAgentSettings(api);
}
