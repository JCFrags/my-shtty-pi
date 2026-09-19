import assert from "node:assert/strict";
import test from "node:test";
import type { ContextCollection } from "@context-kit/protocol/collect";
import { captureContextBudget, chargeCompactionSummary } from "../src/context-budget.js";
import { compileContext, freezeContextInput, type FrozenContextInput } from "../src/context-compiler.js";
import { previewContext } from "../src/composition-preview.js";

test("V4 fits whole records, freezes exact captures and charges the complete public request", () => {
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
  const input: FrozenContextInput = { scope: native.scope, sourceCutEntryId: "prefix-cut", firstKeptEntryId: "tail-start",
    native, memoryOwner: "context-kit", budget, rawTail: { tokens: 400, messages: 3, toolPairSafe: true },
    history: { kind: "stored", input: { regularPiSummary: "", combinedCeilingTokens: 4800,
      cut: { sourceCutEntryId: "prefix-cut", sourceCutSeq: 10, firstKeptEntryId: "tail-start", firstKeptSeq: 11, rawTailTokens: 400, toolPairSafe: true },
      memory: { generation: "1", representedStartSeq: 0, representedEndSeq: 10, committed: true },
      mandatoryCoverage: { protectedComplete: true, openWorkComplete: true },
      selected: { protected: [{ id: "condition", text: condition, startSeq: 1, endSeq: 1, recovery: "opaque:exact-condition",
        kind: "restriction", authority: "exact", sourceAuthority: "user", status: "current", importance: 1 }], openWork: [], older: [],
        recent: [{ id: "large-history", text: "Optional whole history representation. ".repeat(360), startSeq: 5, endSeq: 5,
          recovery: "opaque:exact-large-history", kind: "episode", authority: "derived", status: "uncertain", importance: 0.1 }] },
      delta: { records: [], completeThroughCut: true } } },
  };
  const frozen = freezeContextInput(input);
  const preview = previewContext(frozen), compiled = compileContext(frozen);
  assert.equal(preview.activeContextChanged, false);
  assert.equal(preview.summary, compiled.summary);
  assert.deepEqual(preview.receipt, compiled.receipt);
  assert.ok(Object.isFrozen(compiled.receipt.native.providers[0]!.page!.cards[0]!));
  assert.equal(compiled.receipt.scope.leafId, "full-native-leaf");
  assert.equal(compiled.receipt.sourceCutEntryId, "prefix-cut");
  assert.ok(compiled.receipt.omittedNative.length > 0);
  assert.ok(compiled.receipt.unresolvedRelations.some(link => link.id === "T1"));
  assert.ok(!compiled.receipt.omittedNative.some(card => card.id === "T1"), "pre-collection omissions cannot invent identities");
  assert.match(compiled.summary, /missing relation target never means that a dependency is satisfied/);
  for (const selected of compiled.receipt.selectedNative) {
    const card = native.providers.find(provider => provider.providerId === selected.providerId)!.page!.cards[selected.cardIndex]!;
    assert.ok(compiled.summary.includes(JSON.stringify({ providerId: selected.providerId, ...card })));
  }
  assert.equal(compiled.receipt.history.kind, "stored");
  if (compiled.receipt.history.kind !== "stored") throw new Error("Expected stored history");
  assert.ok(compiled.summary.includes(condition), "long admitted conditions are not token-truncated");
  assert.ok(compiled.receipt.history.artifact.omittedRows.some(row => row.recovery === "opaque:exact-large-history"));
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
});
