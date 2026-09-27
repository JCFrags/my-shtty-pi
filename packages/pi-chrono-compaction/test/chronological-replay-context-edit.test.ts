import assert from "node:assert/strict";
import test from "node:test";
import { captureChronologicalReplay, CHRONOLOGICAL_REPLAY_LIMITS } from "../src/chronological-replay.js";
import { captureContextBudget } from "../src/context-budget.js";
import { compileContext } from "../src/context-compiler.js";
import { getActiveBranch, parseSessionJsonl, rawRecordForEntry } from "../src/jsonl.js";
import type { SessionEntryLike } from "../src/types.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const branch = (entries: SessionEntryLike[]): SessionEntryLike[] => entries.map((entry, index) => ({
  timestamp, parentId: index ? entries[index - 1]!.id : null, ...entry,
}));
const replayText = (entries: readonly SessionEntryLike[], cutIndex = entries.length - 1): string =>
  captureChronologicalReplay(entries, cutIndex).events.flatMap(event => event.representations.map(value => value.text)).join("\n");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("context edits omit or replace replay content without changing roles, metadata, source IDs or raw entries", () => {
  const entries = branch([
    { id: "user", type: "message", message: { role: "user", content: "ORIGINAL_USER" } },
    { id: "attempt", type: "message", message: { role: "assistant", content: [{ type: "text", text: "OMITTED_ATTEMPT" }], stopReason: "error" } },
    { id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL_ASSISTANT" }], provider: "fixture", model: "fixture" } },
    { id: "tool", type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "call", isError: true,
      content: [{ type: "text", text: "ORIGINAL_TOOL" }], details: { preserved: true } } },
    { id: "custom", type: "custom_message", customType: "fixture", content: "ORIGINAL_CUSTOM", display: false, details: { preserved: true } },
    { id: "omit", type: "context_edit", targetId: "attempt", replacement: null },
    { id: "edit-user", type: "context_edit", targetId: "user", replacement: { content: "REPLACED_USER" } },
    { id: "edit-assistant", type: "context_edit", targetId: "assistant", replacement: { content: "REPLACED_ASSISTANT" } },
    { id: "edit-tool", type: "context_edit", targetId: "tool", replacement: { content: "REPLACED_TOOL", role: "user", toolName: "other", isError: false } },
    { id: "edit-custom", type: "context_edit", targetId: "custom", replacement: { content: [{ type: "text", text: "REPLACED_CUSTOM" }] } },
    { id: "boundary", type: "custom_message", customType: "chrono-session-summary-boundary", content: "Continue." },
  ]);
  const original = JSON.stringify(entries);
  freeze(entries);
  const selection = captureChronologicalReplay(entries, entries.length - 1);
  assert.deepEqual(selection.events.map(({ id, index, role }) => ({ id, index, role })), [
    { id: "user", index: 0, role: "User" },
    { id: "assistant", index: 2, role: "Assistant" },
    { id: "tool", index: 3, role: "Tool result: read" },
    { id: "custom", index: 4, role: "Extension message" },
  ]);
  const scope = { sessionId: "fixture-session", leafId: "boundary" };
  const budget = captureContextBudget({ model: { provider: "fixture", id: "fixture", api: "fixture", contextWindow: 32000, maxTokens: 2000, thinkingLevel: "off" },
    configuredTokens: 4000, responseReserveTokens: 2000, systemPrompt: "", activeTools: [], allTools: [], framingTokens: 512 });
  const compiled = compileContext({ scope, sourceCutEntryId: "edit-custom", firstKeptEntryId: "boundary", memoryOwner: "context-kit",
    native: { version: 2, requestId: "fixture-transport", scope, semantics: "Current state is data.", query: "", categories: [], complete: true,
      limits: { records: 16, scan: 128, providerBytes: 16384, maxBytes: 32768, waitMs: 150 }, providers: [] },
    history: { kind: "events", selection }, budget, rawTail: { tokens: 48, messages: 1, toolPairSafe: true },
    sessionSummary: { text: "Continue the synthetic task.", requestId: "fixture-request", requestLeafId: "edit-custom", consumedBoundaryLeafId: "edit-custom",
      submissionEntryId: "fixture-submission", submissionToolCallId: "fixture-call", relevanceHints: [] },
  });
  for (const text of [replayText(entries), compiled.summary]) {
    assert.doesNotMatch(text, /ORIGINAL_|OMITTED_ATTEMPT/);
    for (const role of ["USER", "ASSISTANT", "TOOL", "CUSTOM"]) assert.ok(text.includes(`REPLACED_${role}`));
    assert.match(text, /Tool error: true/);
    assert.match(text, /history_get entryId="tool"/);
  }
  assert.equal(selection.sourceCutEntryId, "edit-custom");
  assert.equal(selection.firstKeptEntryId, "boundary");
  assert.equal(JSON.stringify(entries), original);
  const session = parseSessionJsonl([{ type: "session", version: 3, id: "fixture-session" }, ...entries].map(value => JSON.stringify(value)).join("\n"));
  assert.match(rawRecordForEntry(session, "tool")!, /ORIGINAL_TOOL/);
  assert.match(rawRecordForEntry(session, "attempt")!, /OMITTED_ATTEMPT/);
});

test("latest active-branch edit wins even after the replay cut, and earlier or sibling branches keep their own view", () => {
  const entries = branch([
    { id: "user", type: "message", message: { role: "user", content: "ORIGINAL" } },
    { id: "boundary", type: "custom_message", customType: "fixture", content: "Retained tail." },
    { id: "first", type: "context_edit", targetId: "user", replacement: { content: "FIRST" } },
    { id: "omit", type: "context_edit", targetId: "user", replacement: null },
    { id: "restore", type: "context_edit", targetId: "user", replacement: { content: "RESTORED" } },
    { id: "sibling", parentId: "first", type: "context_edit", targetId: "user", replacement: { content: "SIBLING" } },
    { id: "sibling-omit", type: "context_edit", targetId: "user", replacement: null },
  ]);
  const session = parseSessionJsonl([{ type: "session", version: 3, id: "fixture-session" }, ...entries].map(value => JSON.stringify(value)).join("\n"));
  for (const [leaf, expected] of [["boundary", "ORIGINAL"], ["first", "FIRST"], ["omit", null], ["restore", "RESTORED"],
    ["sibling", "SIBLING"], ["sibling-omit", null]] as const) {
    const active = getActiveBranch(session, leaf), selection = captureChronologicalReplay(active, 1);
    assert.equal(selection.sourceCutEntryId, "user");
    assert.equal(selection.firstKeptEntryId, "boundary");
    if (expected === null) assert.deepEqual(selection.events, []);
    else {
      assert.deepEqual(selection.events.map(event => event.id), ["user"]);
      const text = replayText(active, 1);
      for (const word of ["ORIGINAL", "FIRST", "RESTORED", "SIBLING"]) assert.equal(text.includes(word), word === expected, leaf);
    }
  }
});

test("context selection follows the latest compaction without nesting or rewriting saved summaries", () => {
  const entries = branch([
    { id: "old", type: "message", message: { role: "user", content: "COMPACTED_AWAY" } },
    { id: "kept", type: "message", message: { role: "user", content: "OLD_KEPT" } },
    { id: "edit-kept", type: "context_edit", targetId: "kept", replacement: { content: "EARLIER_EDIT" } },
    { id: "boundary", type: "custom_message", customType: "chrono-session-summary-boundary", content: "Continue." },
    { id: "compaction", type: "compaction", firstKeptEntryId: "kept", summary: "SAVED_SUMMARY_OLD_KEPT", tokensBefore: 100 },
    { id: "edit-later", type: "context_edit", targetId: "kept", replacement: { content: "LATEST_EDIT" } },
    { id: "tail", type: "custom_message", customType: "chrono-session-summary-boundary", content: "Continue." },
  ]);
  const original = JSON.stringify(entries);
  freeze(entries);
  const selection = captureChronologicalReplay(entries, 3);
  assert.deepEqual(selection.events.map(event => event.id), ["kept"]);
  assert.match(replayText(entries, 3), /LATEST_EDIT/);
  assert.doesNotMatch(replayText(entries, 3), /COMPACTED_AWAY|OLD_KEPT|EARLIER_EDIT|SAVED_SUMMARY/);
  assert.deepEqual(captureChronologicalReplay(entries, 6).events, [], "normal replay stops at the previous compaction");
  for (const firstKeptEntryId of ["compaction", "missing"]) {
    const retainNone = entries.map(entry => entry.id === "compaction" ? { ...entry, firstKeptEntryId } : entry);
    assert.deepEqual(captureChronologicalReplay(retainNone, 3).events, []);
  }
  assert.equal(JSON.stringify(entries), original, "later edits do not rewrite saved summary prose");
});

test("no-edit capture keeps its bounds and an edit outside the bounded suffix cannot restore raw content", () => {
  const entries = branch([
    { id: "outside", type: "message", message: { role: "user", content: "OUTSIDE_SUFFIX" } },
    ...Array.from({ length: CHRONOLOGICAL_REPLAY_LIMITS.entries }, (_, index) => ({ id: `metadata-${index}`, type: "custom" })),
    { id: "user", type: "message", message: { role: "user", content: "ORIGINAL_USER" } },
    { id: "attempt", type: "message", message: { role: "assistant", content: [{ type: "text", text: "OMITTED_ATTEMPT" }] } },
    { id: "boundary", type: "custom_message", customType: "fixture", content: "Retained tail." },
  ]);
  const cutIndex = entries.length - 1, original = JSON.stringify(entries);
  freeze(entries);
  const noEdit = captureChronologicalReplay(entries, cutIndex);
  assert.deepEqual(noEdit.events.map(event => event.id), ["user", "attempt"]);
  assert.equal(noEdit.inspectedEntries, CHRONOLOGICAL_REPLAY_LIMITS.entries);
  assert.equal(noEdit.earlierPrefixOmitted, true);
  assert.doesNotMatch(replayText(entries), /OUTSIDE_SUFFIX/);
  assert.match(replayText(entries), /ORIGINAL_USER/);
  assert.match(replayText(entries), /OMITTED_ATTEMPT/);
  const edited = branch([...entries,
    ...Array.from({ length: CHRONOLOGICAL_REPLAY_LIMITS.entries + 1 }, (_, index) => ({ id: `tail-metadata-${index}`, type: "custom" })),
    { id: "edit-user", type: "context_edit", targetId: "user", replacement: { content: "REPLACEMENT ".repeat(4000) } },
    { id: "omit", type: "context_edit", targetId: "attempt", replacement: null },
  ]);
  const selected = captureChronologicalReplay(edited, cutIndex);
  assert.deepEqual(selected.events.map(event => event.id), ["user"]);
  assert.equal(selected.events[0]!.sourceLimited, true);
  assert.equal(selected.inspectedEntries, CHRONOLOGICAL_REPLAY_LIMITS.entries);
  assert.equal(selected.sourceCutEntryId, noEdit.sourceCutEntryId);
  assert.equal(selected.firstKeptEntryId, noEdit.firstKeptEntryId);
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < CHRONOLOGICAL_REPLAY_LIMITS.selectionBytes);
  assert.match(replayText(edited, cutIndex), /REPLACEMENT/);
  assert.doesNotMatch(replayText(edited, cutIndex), /ORIGINAL_USER|OMITTED_ATTEMPT|OUTSIDE_SUFFIX/);
  assert.equal(JSON.stringify(entries), original);
});
