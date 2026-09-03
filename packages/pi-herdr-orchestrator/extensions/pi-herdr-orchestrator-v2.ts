import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestrateV2 } from "../src/v2/tool.js";

/** M01 canary: direct control of visible Herdr agent panes, beside legacy orchestrate. */
export default function piHerdrOrchestratorV2(api: ExtensionAPI): void {
  registerOrchestrateV2(api);
}
