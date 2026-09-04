import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentChannel } from "../src/v2/child-tool.js";
import { registerOrchestrateV2 } from "../src/v2/tool.js";

/** M04 canary: recoverable root lifecycle or an assignment-bound child channel. */
export default function piHerdrOrchestratorV2(api: ExtensionAPI): void {
  if (process.env.PI_HERDR_AGENT_ID) registerSubagentChannel(api);
  else registerOrchestrateV2(api, fileURLToPath(import.meta.url));
}
