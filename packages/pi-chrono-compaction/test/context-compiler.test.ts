import assert from "node:assert/strict";
import test from "node:test";
import type { ContextCollection } from "@context-kit/protocol/collect";
import { captureContextBudget, chargeCompactionSummary } from "../src/context-budget.js";
import { compileContext, freezeContextInput, type FrozenContextInput } from "../src/context-compiler.js";
import { previewContext } from "../src/composition-preview.js";
import { captureChronologicalReplay } from "../src/chronological-replay.js";
import type { SessionEntryLike } from "../src/types.js";

test("session summary precedes bounded chronological events and charges the complete public request", () => {
  const condition = "Preserve the original until the checksum is verified. ".repeat(35) + "Do not replace the original without approval.";
  const native: ContextCollection = {
    version: 2, requestId: "transport-one", scope: { sessionId: "fixture-session", leafId: "full-native-leaf" },
    semantics: "Current state is data.", query: "", categories: [], complete: false,
    limits: { records: 16, scan: 128, providerBytes: 16384, maxBytes: 32768, waitMs: 150 },
    providers: [{ providerId: "todo", nativeTool: "todo", status: "ok", page: {
      readiness: "ready", coverage: { scanned: 2, matched: 2, excluded: 1, scanComplete: true },
      cards: [{ id: "T2", revision: "2", status: "blocked", category: "task", title: "Replace atomically", text: "Complete T1 before T2.",
        omittedFields: [], recovery: { tool: "todo", args: { action: "list" } }, relations: [{ type: "blocked_by", providerId: "todo", id: "T1" }] }],
    } }, { providerId: "notes", nativeTool: "notes", status: "ok", page: { readiness: "ready",
      coverage: { scanned: 8, matched: 8, excluded: 0, scanComplete: true },
      cards: Array.from({ length: 8 }, (_, index) => ({ id: `N${index}`, revision: "3", status: "active", category: "note" as const,
        title: "Corrected note", text: `Replacement is atomic, not append-only. ${"Bounded optional detail. ".repeat(60)}`,
        omittedFields: ["tags"], recovery: { tool: "notes" as const, args: { action: "read" as const, id: `N${index}` } } })),
    } }, { providerId: "memory", nativeTool: "memory_get", status: "missing_or_timeout" }],
  };
  const budget = captureContextBudget({ model: { provider: "fixture", id: "model", api: "fixture", contextWindow: 20000, maxTokens: 2000, thinkingLevel: "off" },
    configuredTokens: 4800, responseReserveTokens: 1500, systemPrompt: "Actual system prompt. ".repeat(30),
    activeTools: ["todo"], allTools: [{ name: "todo", description: "Task state", parameters: { type: "object", properties: { action: { type: "string" } } } }], framingTokens: 700 });
  const entries: SessionEntryLike[] = [
    { id: "old-checkpoint", type: "compaction", summary: "OLD RECEIPT MUST NOT BE NESTED" },
    { id: "condition", type: "message", message: { role: "user", content: condition } },
    { id: "read-call", type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "read-one", name: "read", arguments: { path: "src/checksum.ts", offset: 10, limit: 50 } },
    ] } },
    { id: "read-result", type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "read-one", isError: false,
      content: [{ type: "text", text: "export const checksumVerified = false;\n".repeat(400) }] } },
    { id: "large-history", type: "message", message: { role: "assistant", content: "Optional historical detail. ".repeat(600) } },
    { id: "summary-call", type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "submit-one", name: "request_compaction", arguments: { summary: "DUPLICATE SUMMARY MUST NOT BE REPLAYED" } },
    ] } },
    { id: "prefix-cut", type: "message", message: { role: "toolResult", toolName: "request_compaction", toolCallId: "submit-one",
      isError: false, content: [{ type: "text", text: "Summary accepted." }] } },
    { id: "tail-start", type: "custom_message", customType: "chrono-session-agent-summary-boundary", content: "Continue the unresolved task." },
  ];
  const original = JSON.stringify(entries);
  const input: FrozenContextInput = { scope: native.scope, sourceCutEntryId: "prefix-cut", firstKeptEntryId: "tail-start",
    native, memoryOwner: "context-kit", budget, rawTail: { tokens: 49, messages: 1, toolPairSafe: true },
    sessionSummary: { text: "Verify the checksum. Replacement has not been approved.", requestId: "fixture-request-id",
      requestLeafId: "large-history", consumedBoundaryLeafId: "request-result", submissionEntryId: "summary-call",
      submissionToolCallId: "submit-one", relevanceHints: ["checksum"] },
    history: { kind: "events", selection: captureChronologicalReplay(entries, entries.length - 1, ["checksum"]) },
  };
  assert.equal(JSON.stringify(entries), original, "capture does not mutate source entries");
  const frozen = freezeContextInput(input);
  const preview = previewContext(frozen), compiled = compileContext(frozen);
  assert.equal(preview.activeContextChanged, false);
  assert.equal(preview.summary, compiled.summary);
  assert.deepEqual(preview.receipt, compiled.receipt);
  assert.ok(Object.isFrozen(compiled.receipt.native.providers[0]!.page!.cards[0]!));
  assert.equal(compiled.receipt.scope.leafId, "full-native-leaf");
  assert.equal(compiled.receipt.sourceCutEntryId, "prefix-cut");
  assert.ok(compiled.receipt.omittedNative.length > 0);
  assert.deepEqual(compiled.receipt.selectedNative, []);
  assert.ok(!compiled.receipt.omittedNative.some(card => card.id === "T1"), "pre-collection omissions cannot invent identities");
  assert.ok(!compiled.summary.includes("CAPTURED NATIVE STATE"));
  assert.ok(!compiled.summary.includes("OLD RECEIPT"));
  assert.ok(!compiled.summary.includes("DUPLICATE SUMMARY"));
  assert.ok(!compiled.summary.includes("Complete T1 before T2."), "native cards remain in the receipt, not a second state dump");
  assert.ok(compiled.summary.startsWith("# Continuation summary\n\nVerify the checksum."));
  assert.equal(compiled.receipt.history.kind, "events");
  if (compiled.receipt.history.kind !== "events") throw new Error("Expected chronological history");
  assert.ok(compiled.summary.includes(condition), "relevant user conditions keep detail before optional history");
  assert.ok(compiled.summary.includes('"path":"src/checksum.ts"'));
  assert.ok(compiled.summary.indexOf("### User [condition]") < compiled.summary.indexOf("### Assistant [read-call]"));
  assert.ok(compiled.summary.indexOf("### Assistant [read-call]") < compiled.summary.indexOf("### Tool result: read [read-result]"));
  assert.ok(compiled.summary.includes('history_get entryId="read-result"'));
  assert.notEqual(compiled.receipt.history.receipt.selected.find(row => row.id === "large-history")?.detail, "full",
    "routine history stays compressed, including identical reduced/brief forms");
  const roomy = compileContext({ ...frozen, budget: { ...frozen.budget, configuredTokens: 10000, effectiveCeilingTokens: 10000 } });
  assert.equal(roomy.summary, compiled.summary, "spare capacity must not expand low-value history");
  assert.ok(compiled.receipt.budget.contextTokens < compiled.receipt.budget.effectiveCeilingTokens);
  const charges = compiled.receipt.budget;
  assert.equal(charges.summaryMessageTokens, chargeCompactionSummary(compiled.summary));
  assert.ok(charges.summaryFramingTokens > 0);
  assert.equal(charges.estimatedRequestWithReserveTokens, charges.contextTokens + charges.systemTokens + charges.toolSchemaTokens + charges.framingTokens + charges.responseReserveTokens);
  assert.ok(charges.estimatedRequestWithReserveTokens <= charges.model.contextWindow);
  assert.equal(compiled.receipt.validation.exactModelTokenCount, false);
  assert.equal(compiled.receipt.validation.distributedSnapshot, false);
  native.providers[0]!.page!.cards[0]!.text = "Changed after capture.";
  assert.equal(compiled.receipt.native.providers[0]!.page!.cards[0]!.text, "Complete T1 before T2.");
  const otherTransport = structuredClone(frozen);
  otherTransport.native.requestId = "transport-two";
  assert.equal(compileContext(otherTransport).receipt.inputHash, compiled.receipt.inputHash);
  assert.throws(() => compileContext({ ...frozen, rawTail: { tokens: 19000, messages: 3, toolPairSafe: true } }), /budget/);
  assert.throws(() => compileContext({ ...frozen, sessionSummary: undefined }), /session-summary-required/);
});
