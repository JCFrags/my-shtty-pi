import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestrateV2 } from "../src/v2/tool.js";

/** M02 canary: direct control of visible agents in one managed Herdr tab. */
export default function piHerdrOrchestratorV2(api: ExtensionAPI): void {
  registerOrchestrateV2(api);
}
