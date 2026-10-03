import assert from "node:assert/strict";
import test from "node:test";
import { assertOrchestratorCommands, assertRootOrchestration } from "./activation.mjs";

const extension = { tools: new Map([["orchestrate", {}]]), resolvedPath: "/fixture/packages/pi-herdr-orchestrator/dist/extensions/pi-herdr-orchestrator.js" };
const inventory = { extensions: [extension], commands: [], tools: ["orchestrate"], candidate: "/fixture" };

test("product-owned activation assertions preserve exact root and candidate checks", () => {
  assert.doesNotThrow(() => assertRootOrchestration(inventory));
  assert.throws(() => assertRootOrchestration({ ...inventory, extensions: [] }), /Exactly one/);
  assert.throws(() => assertRootOrchestration({ ...inventory, extensions: [extension, extension] }), /Exactly one/);
  assert.throws(() => assertRootOrchestration({ ...inventory, tools: ["orchestrate", "subagent_channel"] }), /managed-child channel/);
  assert.throws(() => assertRootOrchestration({ ...inventory, candidate: "/other" }));
  assert.throws(() => assertOrchestratorCommands(["agent-settings"]), /Retired orchestration settings/);
});
