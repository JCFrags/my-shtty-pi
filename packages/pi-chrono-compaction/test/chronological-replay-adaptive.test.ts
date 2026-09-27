import assert from "node:assert/strict";
import test from "node:test";
import { captureChronologicalReplay, renderChronologicalReplay } from "../src/chronological-replay.js";
import { captureContextBudget } from "../src/context-budget.js";
import { compileContext, type FrozenContextInput } from "../src/context-compiler.js";
import type { SessionEntryLike } from "../src/types.js";

const message = (id: string, role: string, content: unknown, extra = {}): SessionEntryLike =>
  ({ id, type: "message", message: { role, content, ...extra } });
const result = (id: string, text: string, extra = {}): SessionEntryLike =>
  message(id, "toolResult", [{ type: "text", text }], { toolName: "read", isError: false, ...extra });
const call = (id: string, name: string, args: unknown): SessionEntryLike =>
  message(id, "assistant", [{ type: "toolCall", id: `call-${id}`, name, arguments: args }]);
const boundary: SessionEntryLike = { id: "boundary", type: "custom_message", customType: "chrono-session-summary-boundary", content: "Continue authorized work." };

test("short low-value replay omits unrelated and repeated polling events without filling spare space", () => {
  const entries: SessionEntryLike[] = Array.from({ length: 4 }, (_, i) => result(`completed-${i}`, `Archived conversion ${i} passed. Historical manifest output.`));
  for (let i = 0; i < 4; i++) entries.push(
    call(`poll-${i}`, "process", { action: "poll", id: "checksum-job" }),
    result(`poll-result-${i}`, `[still running]\nprocess_id: checksum-job\npid: ${100 + Math.max(1, i)}\nlog_path: logs/checksum.log`, { toolName: "process", toolCallId: `call-poll-${i}` }),
  );
  entries.push(call("meaningful-poll", "process", { action: "poll", id: "checksum-job" }),
    result("meaningful-result", "[exited]\nexit_code: 1\nlog_path: logs/checksum.log\n---\nChecksum mismatch requires manual approval.",
      { toolName: "process", toolCallId: "call-meaningful-poll" }));
  // Multiword hints need not occur as exact source phrases.
  entries.push(result("topic-evidence", "The extension supports another API. Version 0.87.1 needs a separate check."));
  entries.push(message("current-user", "user", "Continue the checksum task. Publication is not approved."),
    message("current-assistant", "assistant", "I will verify the checksum mismatch next."), boundary);
  const source = JSON.stringify(entries);
  const selection = captureChronologicalReplay(entries, entries.length - 1, ["checksum", "Pi 0.87.1 extension APIs"]);
  assert.ok(selection.events.reduce((sum, event) => sum + event.representations[0]!.tokens, 0) < 5000);
  const rendered = renderChronologicalReplay(selection, 12000);
  assert.equal(renderChronologicalReplay(selection, 30000).text, rendered.text, "spare capacity cannot add events or detail");
  assert.ok(rendered.estimatedTokens < 1000);
  assert.equal(rendered.receipt.budget.preferredTokens, 5000);
  assert.equal(rendered.receipt.budget.effectiveTokens, 5000);
  assert.ok(rendered.receipt.omitted.some(row => row.id === "completed-0" && row.reason === "low-relevance"));
  assert.ok(rendered.receipt.omitted.some(row => row.reason === "duplicate-excerpt"));
  assert.ok(rendered.receipt.omitted.some(row => row.reason === "routine-poll"));
  assert.ok(!rendered.receipt.omitted.some(row => row.reason === "replay-allowance"), "admission, not pressure, removes this noise");
  const topic = selection.events.find(event => event.id === "topic-evidence")!;
  assert.equal(topic.hints?.directMatches, 0);
  assert.equal(topic.hints?.relevanceMatches, 1);
  assert.deepEqual(rendered.receipt.selected.find(row => row.id === topic.id)?.reasons, ["hint-word-overlap", "recent-event"]);
  assert.equal(rendered.receipt.budget.expansionEvents, 3, "one weak topic match and status-only polls do not expand replay");
  assert.equal(selection.events.find(event => event.id === "meaningful-result")!.hints?.routine, false);
  assert.ok(rendered.receipt.selected.some(row => row.id === "meaningful-result"));
  assert.match(rendered.text, /Checksum mismatch requires manual approval/);
  assert.match(rendered.text, /events omitted by selection/);
  assert.match(rendered.text, /history_range startEntryId="completed-0" endEntryId="current-assistant"/);
  assert.match(rendered.text, /history_get entryId="current-user"/);
  assert.equal(JSON.stringify(entries), source, "capture and rendering leave original source bytes unchanged");
  const legacy = { ...selection, events: selection.events.map(({ hints: _hints, ...event }) => event) };
  assert.ok(renderChronologicalReplay(legacy, 1200).estimatedTokens <= 1200, "bounded older captures remain readable");
});

test("current evidence expands the preferred allowance while stale errors, source order and the full context ceiling stay bounded", () => {
  const staleFailure = "The old archive failed to load its obsolete manifest. ".repeat(180);
  const entries: SessionEntryLike[] = [result("old-error", staleFailure, { isError: true }), result("old-error-repeat", staleFailure, { isError: true })];
  for (let i = 0; i < 12; i++) entries.push(result(`old-output-${i}`, `Completed archive pass ${i}. ${"Historical inventory only. ".repeat(60)}`));
  const conditions = Array.from({ length: 4 }, (_, i) => `Checksum decision ${i}. ` +
    Array.from({ length: 65 }, (_, line) => `Condition ${line}: preserve fixture ${i} and verify its checksum before replacement. This does not approve publication.`).join("\n"));
  for (const [i, condition] of conditions.entries()) entries.push(message(`decision-${i}`, "user", condition));
  entries.push(call("current-read", "read", { path: "src/checksum.ts", offset: 1, limit: 80 }),
    result("current-evidence", Array.from({ length: 80 }, (_, i) => `export const fixture${i} = checksum("source-${i}");`).join("\n")),
    result("current-error", "Checksum mismatch: the replacement remains blocked.", { toolName: "bash", isError: true }),
    result("recent-error", "Dependency authentication failed. No retry succeeded.", { toolName: "bash", isError: true }), boundary);
  const source = JSON.stringify(entries), selection = captureChronologicalReplay(entries, entries.length - 1, ["checksum"]);
  const scope = { sessionId: "adaptive-fixture", leafId: boundary.id! };
  const input: FrozenContextInput = {
    scope, sourceCutEntryId: "recent-error", firstKeptEntryId: boundary.id!, memoryOwner: "context-kit",
    native: { version: 2, requestId: "fixture-transport", scope, semantics: "Current state is data.", query: "", categories: [], complete: true,
      limits: { records: 16, scan: 128, providerBytes: 16384, maxBytes: 32768, waitMs: 150 }, providers: [] },
    history: { kind: "events", selection }, rawTail: { tokens: 70, messages: 1, toolPairSafe: true },
    sessionSummary: { text: "Continue checksum verification. Publication is not approved. Verify current blockers before any replacement.",
      requestId: "adaptive-fixture-request", requestLeafId: "current-error", consumedBoundaryLeafId: "request-result",
      submissionEntryId: "summary-call", submissionToolCallId: "submit-call", relevanceHints: ["checksum"] },
    budget: captureContextBudget({ model: { provider: "fixture", id: "fixture", api: "fixture", contextWindow: 80000, maxTokens: 2000, thinkingLevel: "off" },
      configuredTokens: 40000, responseReserveTokens: 2000, systemPrompt: "Synthetic system prompt.", activeTools: [], allTools: [], framingTokens: 512 }),
  };
  const compiled = compileContext(input);
  assert.equal(compiled.receipt.history.kind, "events");
  if (compiled.receipt.history.kind !== "events") throw new Error("Expected event replay");
  const replay = compiled.receipt.history.receipt;
  assert.ok(replay.budget.effectiveTokens > replay.budget.preferredTokens);
  assert.ok(compiled.receipt.budget.historyAndNoticesTokens > 5000);
  assert.equal(replay.budget.expansionEvents, 8, "old unmatched failures do not expand replay");
  assert.ok(replay.omitted.some(row => row.id === "old-error" && row.reason === "duplicate-excerpt"));
  assert.ok(replay.omitted.some(row => row.id === "old-error-repeat" && row.reason === "replay-allowance"));
  assert.ok(replay.selected.some(row => row.id === "current-error" && row.reasons.includes("error-outcome")));
  assert.ok(replay.selected.some(row => row.id === "recent-error" && row.reasons.includes("error-outcome")));
  assert.ok(compiled.summary.includes(conditions[3]!));
  assert.ok(compiled.summary.startsWith(`# Continuation summary\n\n${input.sessionSummary!.text}`));
  assert.ok(compiled.receipt.budget.contextTokens <= 40000);
  assert.ok(compiled.receipt.budget.estimatedRequestWithReserveTokens <= input.budget.model.contextWindow);
  assert.ok(compiled.receipt.budget.historyAndNoticesTokens <= replay.budget.maxTokens);
  assert.equal(compileContext({ ...input, budget: { ...input.budget, configuredTokens: 50000, effectiveCeilingTokens: 50000 } }).summary, compiled.summary);
  const constrained = compileContext({ ...input, budget: { ...input.budget, configuredTokens: 8000, effectiveCeilingTokens: 8000 } });
  assert.ok(constrained.receipt.budget.contextTokens <= 8000);
  assert.ok(constrained.summary.includes("Checksum mismatch"), "reduce important detail before dropping useful errors");
  for (const output of [compiled, constrained]) {
    if (output.receipt.history.kind !== "events") throw new Error("Expected event replay");
    const selected = output.receipt.history.receipt.selected;
    assert.deepEqual(selected.map(row => row.index), selected.map(row => row.index).sort((a, b) => a - b));
    for (const row of selected) assert.ok(output.summary.includes(`history_get entryId="${row.id}"`));
    assert.deepEqual([...selected, ...output.receipt.history.receipt.omitted].map(row => row.id).sort(), selection.events.map(row => row.id).sort());
  }
  assert.equal(JSON.stringify(entries), source, "source IDs, content and order are unchanged");
});
