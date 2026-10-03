// Product-owned assertions for the shared factory-registration checker.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

export function assertOrchestratorCommands(commands) {
  assert(!commands.includes("agent-settings"), "Retired orchestration settings command must be absent");
}

export function assertRootOrchestration({ extensions, commands, tools, candidate }) {
  const owners = extensions.filter((extension) => extension.tools.has("orchestrate"));
  assert.equal(owners.length, 1, "Exactly one root orchestrate registration is required");
  assert(!tools.includes("subagent_channel"), "Factory inventory must not expose a managed-child channel");
  assertOrchestratorCommands(commands);
  if (candidate) assert.equal(resolve(owners[0].resolvedPath), join(resolve(candidate), "packages/pi-herdr-orchestrator/dist/extensions/pi-herdr-orchestrator.js"));
}
