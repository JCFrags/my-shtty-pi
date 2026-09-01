import { registerHerdrStatusExtension } from "../src/extension.ts";
import type { PiExtensionApi } from "../src/pi-types.ts";

export default function herdrStatusExtension(pi: PiExtensionApi): void {
  registerHerdrStatusExtension(pi);
}
