import assert from "node:assert/strict";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCandidateUnits } from "../src/candidates.js";
import { resolveCompactorConfig } from "../src/compactor.js";
import { analyzeBlockHistory, classifyActivityPhase } from "../src/history-analysis.js";
import type { SessionEntryLike } from "../src/types.js";

function toolCall(entryId: string, callId: string, name: string, argumentsValue: Record<string, unknown>): SessionEntryLike {
  return {
    type: "message",
    id: entryId,
    parentId: null,
    message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: argumentsValue }] },
  };
}

function toolResult(entryId: string, callId: string, name: string, text: string): SessionEntryLike {
  return {
    type: "message",
    id: entryId,
    parentId: null,
    message: { role: "toolResult", toolCallId: callId, toolName: name, isError: false, content: [{ type: "text", text }] },
  };
}

test("repeated file reads lower old routine evidence but retain cited dependencies", () => {
  const entries: SessionEntryLike[] = [
    toolCall("call-old", "read-old", "read", { path: "src/service.ts" }),
    toolResult("result-old", "read-old", "read", "export const oldFunction.result = 1;\nRoutine old source."),
    {
      type: "message",
      id: "cite-old",
      parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "The decision depends on oldFunction.result." }] },
    },
    toolCall("call-new", "read-new", "read", { path: "src/service.ts" }),
    toolResult("result-new", "read-new", "read", "export const newFunction.result = 2;\nCurrent source."),
    toolCall("call-dist", "read-dist", "read", { path: "dist/service.js.map" }),
    toolResult("result-dist", "read-dist", "read", "generated source map payload"),
  ];
  const blocks = parseHistoricalBlocks(entries);
  const analysis = analyzeBlockHistory(blocks);
  const oldResult = blocks.find((block) => block.entryId === "result-old");
  const newResult = blocks.find((block) => block.entryId === "result-new");
  const distResult = blocks.find((block) => block.entryId === "result-dist");
  assert.ok(oldResult && newResult && distResult);

  const oldState = analysis.get(oldResult.id);
  const newState = analysis.get(newResult.id);
  const distState = analysis.get(distResult.id);
  assert.ok(oldState && newState && distState);
  assert.equal(oldState.occurrence, 1);
  assert.equal(newState.occurrence, 2);
  assert.ok(oldState.reasons.some((reason) => /older of 2 repeated file interactions/.test(reason)));
  assert.ok(oldState.reasons.some((reason) => /evidence cited before the next resource occurrence/.test(reason)));
  assert.ok(newState.importanceAdjustment > oldState.importanceAdjustment);
  assert.ok(distState.reasons.some((reason) => /generated source-map artifact/.test(reason)));
});

test("activity phase analysis conservatively reduces discovery detail after execution begins", async () => {
  assert.equal(classifyActivityPhase("Analyze the package and tell me what you think."), "research");
  assert.equal(classifyActivityPhase("Continue your work and implement the changes."), "implementation");
  assert.equal(classifyActivityPhase("Discuss the vision and how we should test the tradeoffs."), "planning");
  assert.equal(classifyActivityPhase("Would you be able to run the tests?"), undefined);

  const entries: SessionEntryLike[] = [
    { type: "message", id: "research-user", parentId: null, message: { role: "user", content: "Analyze the package and report risks." } },
    toolCall("research-call", "research-read", "read", { path: "src/old.ts" }),
    toolResult("research-result", "research-read", "read", "export const oldEvidence = true;"),
    {
      type: "message",
      id: "research-final",
      parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "The analysis found one relevant risk." }] },
    },
    { type: "message", id: "implement-user", parentId: null, message: { role: "user", content: "Continue your work and implement the fix." } },
    toolCall("implement-call", "implement-edit", "edit", { path: "src/new.ts" }),
    toolResult("implement-result", "implement-edit", "edit", "Updated src/new.ts"),
  ];
  const blocks = parseHistoricalBlocks(entries);
  const analysis = analyzeBlockHistory(blocks);
  const oldResult = blocks.find((block) => block.entryId === "research-result");
  const boundaryResult = blocks.find((block) => block.entryId === "research-final");
  const implementationResult = blocks.find((block) => block.entryId === "implement-result");
  assert.ok(oldResult && boundaryResult && implementationResult);
  assert.ok(analysis.get(oldResult.id)?.reasons.some((reason) => /older research phase before execution/.test(reason)));
  assert.ok(analysis.get(boundaryResult.id)?.reasons.some((reason) => /discovery-to-execution boundary/.test(reason)));
  assert.ok(analysis.get(implementationResult.id)?.reasons.some((reason) => /current execution phase/.test(reason)));

  const sourceBlocks = parseHistoricalBlocks(entries.slice(0, 4));
  const sourceUnits = await buildCandidateUnits(
    sourceBlocks,
    resolveCompactorConfig({ targetTokens: 1_000 }),
    undefined,
    undefined,
    "",
    blocks,
  );
  const historicalRead = sourceUnits.find((unit) => unit.id.startsWith("research-result:tool_result"));
  assert.ok(historicalRead?.importanceReasons.some((reason) => /older research phase before execution/.test(reason)));
});

test("repeated command analysis protects a failure-to-success transition", () => {
  const entries: SessionEntryLike[] = [
    toolCall("command-1", "run-1", "bash", { command: "npm test" }),
    toolResult("outcome-1", "run-1", "bash", "Exit code: 1\nOne test failed."),
    toolCall("command-2", "run-2", "bash", { command: "npm test" }),
    toolResult("outcome-2", "run-2", "bash", "Exit code: 1\nOne test failed again."),
    toolCall("command-3", "run-3", "bash", { command: "npm test" }),
    toolResult("outcome-3", "run-3", "bash", "Exit code: 0\nAll tests passed."),
  ];
  const blocks = parseHistoricalBlocks(entries);
  const analysis = analyzeBlockHistory(blocks);
  const beforeTransition = blocks.find((block) => block.entryId === "outcome-2");
  const transition = blocks.find((block) => block.entryId === "outcome-3");
  assert.ok(beforeTransition && transition);

  assert.ok(analysis.get(beforeTransition.id)?.reasons.some((reason) => /immediately before an outcome transition/.test(reason)));
  assert.ok(analysis.get(transition.id)?.reasons.some((reason) => /outcome changed from failure to success/.test(reason)));
  assert.ok((analysis.get(transition.id)?.importanceAdjustment ?? 0) > 0);
});
