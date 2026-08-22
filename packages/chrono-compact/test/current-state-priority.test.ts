import assert from "node:assert/strict";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCausalMemory, renderCurrentStateRegister, renderCurrentStateRegisterWithinTokens, selectCurrentStateItems } from "../src/causal-memory.js";
import { estimateTokensFromText } from "../src/utils.js";
import type { SessionEntryLike } from "../src/types.js";

function routineStateEntries(count: number, parentId: string): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  let parent = parentId;
  for (let index = 0; index < count; index += 1) {
    const id = `routine-${index}`;
    entries.push({
      type: "message",
      id,
      parentId: parent,
      message: { role: "assistant", content: `Status routine-cell-${index}: ready.` },
    });
    parent = id;
  }
  return entries;
}

function model(entries: readonly SessionEntryLike[]) {
  return buildCausalMemory(parseHistoricalBlocks(entries, {
    includeHistoricalCompactions: false,
    includeMetadata: false,
  }));
}

test("older active restrictions precede later routine state within the line limit", () => {
  const root: SessionEntryLike = {
    type: "message",
    id: "restriction-root",
    parentId: null,
    message: { role: "user", content: "Never publish private evidence." },
  };
  const current = model([root, ...routineStateEntries(80, root.id!)]);
  const rendered = renderCurrentStateRegister(current, 8);

  assert.match(rendered, /Never publish private evidence\. \[restriction-root\]/);
  assert.equal(renderCurrentStateRegister(current, 8), rendered);
  assert.ok(selectCurrentStateItems(current, 8).length <= 8);
  assert.ok(rendered.split("\n").filter((line) => line.startsWith("- ")).length <= 8);
});

test("token-bounded state rendering keeps complete source-linked lines in priority order", () => {
  const stateCells = [
    { key: "status", category: "status", state: "active", value: "routine status", source: { entryId: "status-source" } },
    { key: "restriction-long", category: "restriction", state: "active", value: "Never expose " + "private material ".repeat(400), source: { entryId: "restriction-source", blockIndex: 2 } },
    { key: "conflict", category: "restriction", state: "conflict", value: "Conflicting restriction", source: { entryId: "conflict-source" } },
    ...Array.from({ length: 40 }, (_, index) => ({ key: `routine-${index}`, category: "status", state: "active", value: `routine ${index}`, source: { entryId: `routine-source-${index}` } })),
  ];
  const fake = { stateCells, failureFamilies: [{ signature: "open", resolved: false, representative: "unresolved failure cue", sources: [{ entryId: "failure-source" }] }] } as any;
  const rendered = renderCurrentStateRegisterWithinTokens(fake, 80, 240);
  const lines = rendered.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(estimateTokensFromText(rendered) <= 240);
  assert.match(lines[0]!, /^- restriction CONFLICT:/);
  assert.ok(lines.every((line) => /\[[^\]]+\]$/.test(line)));
  assert.match(rendered, /restriction-source:2\]/);
  assert.match(rendered, /value omitted; recover from source/);
  assert.match(rendered, /unresolved failure cue \[failure-source\]/);
  assert.match(rendered, /additional state cells remain searchable/);
  assert.equal(renderCurrentStateRegisterWithinTokens(fake, 80, 240), rendered);
});

test("old unresolved failures retain a bounded source-linked cue before later routine state", () => {
  const root: SessionEntryLike = {
    type: "message",
    id: "failure-root",
    parentId: null,
    message: { role: "user", content: "Inspect the migration guard." },
  };
  const call: SessionEntryLike = {
    type: "message",
    id: "failure-call",
    parentId: root.id,
    message: { role: "assistant", content: [{ type: "toolCall", id: "failure-tool", name: "read", arguments: { path: "migration.log" } }] },
  };
  const failure: SessionEntryLike = {
    type: "message",
    id: "failure-result",
    parentId: call.id,
    message: {
      role: "toolResult",
      toolCallId: "failure-tool",
      toolName: "read",
      content: [{ type: "text", text: `${"routine output\n".repeat(500)}ERROR migration guard expected=pending received=complete` }],
      isError: true,
    },
  };
  const current = model([root, call, failure, ...routineStateEntries(80, failure.id!)]);
  const rendered = renderCurrentStateRegister(current, 8);
  const failureLine = rendered.split("\n").find((line) => line.includes("ERROR migration guard"));

  assert.ok(failureLine);
  assert.match(failureLine, /\[failure-result\]/);
  assert.ok(failureLine.length < 300);
  assert.doesNotMatch(failureLine, /routine output/);
  assert.ok(selectCurrentStateItems(current, 8).length <= 8);
});
