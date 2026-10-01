import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyValidationFailure, registerSubagentChannel, startupDiagnostic, type ValidationFailureCode } from "../src/orchestrator/child-tool.js";
import { ChildBinding, hasChildEnvironment, isChildSession, type ChildContext } from "../src/orchestrator/child-binding.js";
import { registerOrchestrate } from "../src/orchestrator/tool.js";

/** Direct-Herdr root orchestration or exact managed-child channel. */
export default function piHerdrOrchestrator(api: ExtensionAPI): void {
  if (!hasChildEnvironment() && !Object.keys(process.env).some((key) => key.startsWith("HERDR_"))) {
    registerOrchestrate(api);
    return;
  }
  const binding = new ChildBinding(api);
  api.on("session_start", async (_event, rawContext) => {
    const context = rawContext as ChildContext & {
      cwd: string;
      ui?: { notify(message: string, level: "warning"): void };
    };
    let child = true;
    let roleFailure: ValidationFailureCode | undefined;
    try {
      child = await isChildSession(context);
    } catch (error) {
      // An unavailable identity is not permission to become a root.
      roleFailure = classifyValidationFailure(error, "role");
    }
    if (!child) {
      registerOrchestrate(api, undefined, context);
      return;
    }
    registerSubagentChannel(api, binding, roleFailure);
    let bindingFailure: ValidationFailureCode | undefined;
    try {
      await binding.resolve(context);
    } catch (error) {
      bindingFailure = classifyValidationFailure(error, "binding");
    }
    const diagnostic = startupDiagnostic(roleFailure, bindingFailure);
    if (diagnostic) context.ui?.notify(diagnostic, "warning");
  });
}
