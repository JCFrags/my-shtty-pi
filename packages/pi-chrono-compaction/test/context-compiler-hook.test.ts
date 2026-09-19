import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextProvider } from "@context-kit/protocol";
import extension, { capturePreparedV4Context, resolveExtensionSettings } from "../src/pi-extension.js";
import { previewContext } from "../src/composition-preview.js";
import { validateMemoryOwner } from "../src/user-config.js";
import type { SessionEntryLike } from "../src/types.js";

test("V4 hook matches preview, correlates commit and refuses stale inputs while independent Memory owns every front door", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-v4-hook-"));
  const environment = { PI_CHRONO_CONFIG_PATH: join(directory, "config.json"), PI_CHRONO_CONTEXT_COMPILER: "v4",
    PI_CHRONO_MEMORY_OWNER: "context-kit", PI_CHRONO_SEARCH_INDEX: "false", PI_CHRONO_MEMORY_ENGINE: "false",
    PI_CHRONO_AUTOMATIC_ROLLOVER: "false", PI_CHRONO_PI_SUMMARY: "true", PI_CHRONO_VALUE_WORKER_MODE: "off",
    PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false", PI_CHRONO_TOOL_RESULT_PROJECTION: "off", PI_CHRONO_RAW_TAIL_MIN: "1000", PI_CHRONO_RAW_TAIL_MAX: "2000" };
  const old = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  writeFileSync(environment.PI_CHRONO_CONFIG_PATH, "{}", { mode: 0o600 });
  const source = join(directory, "synthetic.jsonl");
  writeFileSync(source, "synthetic source for bounded mock transport\n", { mode: 0o600 });
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, any>();
  const events = createEventBus();
  const mirrors: unknown[] = [], requests: any[] = [];
  let schemaDescription = "Independent task state", mutateDuringCollect = false;
  const remove = registerContextProvider(events, "todo", () => {
    if (mutateDuringCollect) { schemaDescription = "Changed active schema"; mutateDuringCollect = false; }
    return { readiness: "ready", coverage: { scanned: 1, matched: 1, excluded: 0, scanComplete: true }, cards: [
      { id: "T2", revision: "2", status: "blocked", category: "task", title: "Atomic replacement", text: "Verify T1 first.",
        omittedFields: [], recovery: { tool: "todo", args: { action: "list" } }, relations: [{ type: "blocked_by", providerId: "todo", id: "T1" }] },
    ] };
  });
  const pi = {
    events, getActiveTools: () => ["todo", "memory_get"],
    getAllTools: () => [{ name: "todo", description: schemaDescription, parameters: { type: "object" } },
      { name: "memory_get", description: "Independent memory", parameters: { type: "object" } }],
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerFlag() {},
    on(name: string, handler: any) { assert.ok(!hooks.has(name)); hooks.set(name, handler); },
    appendEntry(type: string, data: unknown) { mirrors.push({ type, data }); }, sendMessage() {},
  };
  const sm = SessionManager.inMemory(directory);
  for (let index = 0; index < 16; index++) sm.appendMessage({ role: "user", content: `History ${index}. ${"Preserve the original. ".repeat(90)}`, timestamp: index });
  sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "pair", name: "read", arguments: { path: "fixture" } }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 20,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  sm.appendMessage({ role: "toolResult", toolCallId: "pair", toolName: "read", content: [{ type: "text", text: "checksum fixture" }], isError: false, timestamp: 21 });
  const ctx = { sessionManager: { getSessionId: () => sm.getSessionId(), getSessionFile: () => source,
      getLeafId: () => sm.getLeafId(), getEntry: (id: string) => sm.getEntry(id), getBranch: () => sm.getBranch() },
    hasUI: false, ui: { notify() {} }, isIdle: () => true, hasPendingMessages: () => false,
    model: { provider: "fixture", id: "fixture", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 }, thinkingLevel: "off",
    getSystemPrompt: () => "Synthetic system prompt", getContextUsage: () => ({ contextWindow: 32000, tokens: 12000 }),
    modelRegistry: { getApiKeyAndHeaders() { throw new Error("V4 must not request summary auth"); } },
  } as unknown as ExtensionContext;
  try {
    assert.throws(() => validateMemoryOwner("other"), /memoryOwner/);
    extension(pi as unknown as ExtensionAPI, { schedulerDirectory: directory,
      historyTransport: { isolation: "os-bounded-child-v1", async run(wire) {
        requests.push(JSON.parse(wire));
        return JSON.stringify({ status: "ok", text: "Source-known synthetic recall", details: {} });
      } } });
    assert.ok(![...tools.keys()].some(name => name.startsWith("memory_")), "Chrono registers no independent-owner Memory tools");
    const branchEntries = sm.getBranch() as unknown as SessionEntryLike[];
    const preparation = { firstKeptEntryId: branchEntries[8]!.id!, tokensBefore: 12000, messagesToSummarize: [], turnPrefixMessages: [],
      previousSummary: undefined, settings: { enabled: false, keepRecentTokens: 6000, reserveTokens: 2000 }, isSplitTurn: false,
    } as unknown as Parameters<typeof capturePreparedV4Context>[2]["preparation"];
    const event = { branchEntries, preparation, reason: "manual", willRetry: false, signal: new AbortController().signal };
    const captured = await capturePreparedV4Context(pi as unknown as ExtensionAPI, ctx, event, { settings: () => resolveExtensionSettings(), memoryOwner: "context-kit", epoch: () => 0 });
    const preview = previewContext(captured.input);
    const result = await hooks.get("session_before_compact")!(event, ctx);
    assert.ok(result.compaction);
    assert.equal(result.compaction.summary, preview.summary);
    assert.equal(result.compaction.details.contextReceipt.inputHash, preview.receipt.inputHash);
    assert.equal(result.compaction.details.contextReceipt.native.providers.find((p: any) => p.providerId === "memory").status, "missing_or_timeout");
    const before = sm.getLeafId();
    const id = sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true);
    assert.equal(sm.getEntry(id)!.parentId, before);
    await hooks.get("session_compact")!({ compactionEntry: sm.getEntry(id), fromExtension: true, reason: "manual", willRetry: false }, ctx);
    const status = (await tools.get("history_status").execute()).details.composition;
    assert.equal(status.terminal.state, "committed");
    assert.equal(status.committedReceipt.compactionEntryId, id);
    assert.deepEqual(status.committedReceipt.recovery.args, { entryId: id });
    // A settings change cannot reactivate the old writer without a reload.
    process.env.PI_CHRONO_MEMORY_OWNER = "chrono";
    await tools.get("history_recall").execute("recall-fixture", { query: "checksum" }, undefined, undefined, ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation.promotion, undefined);
    assert.equal(mirrors.length, 0);
    assert.equal((await tools.get("history_status").execute()).details.composition.memoryOwner.reloadRequired, true);
    // The source remains the original cut for this bounded stale-input attempt.
    sm.branch(before!);
    mutateDuringCollect = true;
    assert.deepEqual(await hooks.get("session_before_compact")!(event, ctx), { cancel: true });
    assert.equal((await tools.get("history_status").execute()).details.composition.lastFailure.code, "context-v4-input-changed");
    assert.equal(sm.getLeafId(), before);
  } finally {
    remove();
    await hooks.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
