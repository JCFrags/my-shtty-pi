import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextProvider } from "@context-kit/protocol";
import extension, { capturePreparedV4Context, resolveExtensionSettings, SESSION_AGENT_BOUNDARY_CUSTOM_TYPE } from "../src/pi-extension.js";
import { previewContext } from "../src/composition-preview.js";
import { validateMemoryOwner } from "../src/user-config.js";
import { createSessionAgentSummaryRequest, consumeSessionAgentSummaryRequest, acceptSessionAgentSummary, settleSessionAgentSummary,
  type SessionAgentSummaryReady } from "../src/session-agent-summary.js";
import type { SessionEntryLike } from "../src/types.js";

test("model-free V4 registered summary lifecycle preserves source, matches preview, defers native compaction and refuses stale capture", async () => {
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
  const hooks = new Map<string, (event: any, ctx: any) => any>(), tools = new Map<string, any>();
  const events = createEventBus(), sm = SessionManager.inMemory(directory);
  const mirrors: unknown[] = [], requests: any[] = [], sent: any[] = [];
  let schemaDescription = "Independent task state", mutateDuringCollect = false, idle = true;
  let compactionTask: Promise<void> | undefined, returned: any, committedId: string | undefined, referenceReady: SessionAgentSummaryReady | undefined;
  let checkPreview = true, aborts = 0;
  const run = new AbortController();
  const remove = registerContextProvider(events, "todo", () => {
    if (mutateDuringCollect) { schemaDescription = "Changed active schema"; mutateDuringCollect = false; }
    return { readiness: "ready", coverage: { scanned: 1, matched: 1, excluded: 0, scanComplete: true }, cards: [
      { id: "T2", revision: "2", status: "blocked", category: "task", title: "Atomic replacement", text: "Verify T1 first.",
        omittedFields: [], recovery: { tool: "todo", args: { action: "list" } }, relations: [{ type: "blocked_by", providerId: "todo", id: "T1" }] },
    ] };
  });
  const pi = {
    events, getActiveTools: () => ["todo", "memory_get", "request_compaction"],
    getAllTools: () => [{ name: "todo", description: schemaDescription, parameters: { type: "object" } },
      { name: "memory_get", description: "Independent memory", parameters: { type: "object" } }, tools.get("request_compaction")],
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerFlag() {},
    on(name: string, handler: any) { assert.ok(!hooks.has(name)); hooks.set(name, handler); },
    appendEntry(type: string, data: unknown) { mirrors.push({ type, data }); },
    sendMessage(message: any, options: any) {
      assert.equal(idle, true, "fixture sends occur only after the native hook/run unwinds");
      assert.equal(options.deliverAs, undefined, "nextTurn would only queue the boundary");
      sent.push({ message, options });
      sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (id: string, name: string, args: any) => ({ role: "assistant" as const,
    content: [{ type: "toolCall" as const, id, name, arguments: args }], api: "openai-completions" as const,
    provider: "fixture", model: "fixture", stopReason: "toolUse" as const, timestamp: Date.now(), usage });
  for (let index = 0; index < 16; index++) sm.appendMessage({ role: "user", content: `History ${index}. ${"Preserve the original. ".repeat(90)}`, timestamp: index });
  sm.appendMessage(assistant("pair", "read", { path: "fixture" }));
  sm.appendMessage({ role: "toolResult", toolCallId: "pair", toolName: "read", content: [{ type: "text", text: "checksum fixture" }], isError: false, timestamp: 21 });
  const preparation = { firstKeptEntryId: sm.getBranch()[8]!.id, tokensBefore: 12000, messagesToSummarize: [], turnPrefixMessages: [],
    previousSummary: undefined, settings: { enabled: false, keepRecentTokens: 6000, reserveTokens: 2000 }, isSplitTurn: false,
  } as unknown as Parameters<typeof capturePreparedV4Context>[2]["preparation"];
  const event = (reason = "manual") => ({ branchEntries: sm.getBranch() as unknown as SessionEntryLike[], preparation, reason, willRetry: reason === "overflow", signal: new AbortController().signal });
  const ctx = { sessionManager: { getSessionId: () => sm.getSessionId(), getSessionFile: () => source,
      getLeafId: () => sm.getLeafId(), getEntry: (id: string) => sm.getEntry(id), getBranch: () => sm.getBranch() },
    hasUI: false, ui: { notify() {} }, isIdle: () => idle, hasPendingMessages: () => false,
    get signal() { return idle ? undefined : run.signal; }, abort() { aborts++; },
    model: { provider: "fixture", id: "fixture", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 }, thinkingLevel: "off",
    getSystemPrompt: () => "Synthetic system prompt", getContextUsage: () => ({ contextWindow: 32000, tokens: 12000 }),
    modelRegistry: { getApiKeyAndHeaders() { throw new Error("V4 must not request summary auth"); } },
    compact(options: any) {
      assert.equal(idle, true, "ctx.compact starts only at safe idle");
      idle = false;
      compactionTask = (async () => {
        const inputEvent = event();
        let preview: ReturnType<typeof previewContext> | undefined;
        if (checkPreview) {
          assert.ok(referenceReady);
          const captured = await capturePreparedV4Context(pi as unknown as ExtensionAPI, ctx, inputEvent, {
            settings: () => resolveExtensionSettings(), memoryOwner: "context-kit", epoch: () => 0,
            boundary: { ready: referenceReady, entryId: sm.getLeafId()! },
          });
          preview = previewContext(captured.input);
        }
        returned = await hooks.get("session_before_compact")!(inputEvent, ctx);
        if (!returned.compaction) {
          await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
          idle = true;
          options.onError(new Error("Compaction cancelled"));
          return;
        }
        assert.equal(returned.compaction.summary, preview?.summary);
        assert.equal(returned.compaction.details.contextReceipt.inputHash, preview?.receipt.inputHash);
        const before = sm.getLeafId();
        committedId = sm.appendCompaction(returned.compaction.summary, returned.compaction.firstKeptEntryId, returned.compaction.tokensBefore, returned.compaction.details, true);
        assert.equal(sm.getEntry(committedId)!.parentId, before);
        await hooks.get("session_compact")!({ compactionEntry: sm.getEntry(committedId), fromExtension: true, reason: "manual", willRetry: false }, ctx);
        idle = true;
        options.onComplete();
      })();
    },
  } as unknown as ExtensionContext;
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  const status = async () => (await tools.get("history_status").execute()).details.composition;
  const summaryText = "Synthetic fixture summary: continue the isolated implementation. Publication and activation are not approved. The checksum read passed.";
  const submit = async (suffix: string, reference = false) => {
    idle = false;
    const requestCallId = `request-${suffix}`, submitCallId = `submit-${suffix}`;
    const requestLeafId = sm.appendMessage(assistant(requestCallId, "request_compaction", {}));
    const requestResult = await tools.get("request_compaction").execute(requestCallId, {}, run.signal, undefined, ctx);
    assert.equal(requestResult.terminate, undefined);
    const request = createSessionAgentSummaryRequest({ requestId: requestResult.details.requestId, reason: "tool", now: Date.now(),
      targetTokens: Math.min(4096, resolveExtensionSettings().hybridSummaryTargetTokens), requestToolCallId: requestCallId, scope: { sessionId: sm.getSessionId(), sessionFile: source, leafId: requestLeafId, epoch: 0,
        model: { provider: "fixture", id: "fixture", api: "openai-completions", thinkingLevel: "off" } } });
    sm.appendMessage({ role: "toolResult", toolCallId: requestCallId, toolName: "request_compaction", content: requestResult.content, details: requestResult.details, isError: false, timestamp: Date.now() });
    const view = () => ({ scope: { ...request.scope, leafId: sm.getLeafId()! }, now: Date.now(), getEntry: (id: string) => sm.getEntry(id) as SessionEntryLike | undefined });
    const messages = sm.buildSessionContext().messages;
    await hooks.get("context")!({ messages }, ctx);
    assert.equal((await status()).sessionSummary.state, "consumed");
    const consumed = reference ? consumeSessionAgentSummaryRequest(request, view(), messages) : undefined;
    const args = { requestId: request.requestId, summary: summaryText, relevanceHints: ["checksum", "isolated implementation"] };
    const message = assistant(submitCallId, "request_compaction", args);
    const submissionEntryId = sm.appendMessage(message);
    const result = await tools.get("request_compaction").execute(submitCallId, args, run.signal, undefined, ctx);
    assert.equal(result.terminate, true, "only a source-validated sole submission terminates");
    const accepted = consumed ? acceptSessionAgentSummary(consumed, args, { ...view(), toolCallId: submitCallId }) : undefined;
    const resultId = sm.appendMessage({ role: "toolResult", toolCallId: submitCallId, toolName: "request_compaction", content: result.content,
      details: result.details, isError: false, timestamp: Date.now() });
    if (accepted) referenceReady = settleSessionAgentSummary(accepted, view());
    await hooks.get("turn_end")!({ message }, ctx);
    return { requestLeafId, submissionEntryId, resultId };
  };
  try {
    assert.throws(() => validateMemoryOwner("other"), /memoryOwner/);
    extension(pi as unknown as ExtensionAPI, { schedulerDirectory: directory,
      historyTransport: { isolation: "os-bounded-child-v1", async run(wire) {
        requests.push(JSON.parse(wire));
        return JSON.stringify({ status: "ok", text: "Source-known synthetic recall", details: {} });
      } } });
    assert.ok(![...tools.keys()].some(name => name.startsWith("memory_")), "Chrono registers no independent-owner Memory tools");
    const schema = JSON.stringify(tools.get("request_compaction").parameters);
    const submitted = await submit("first", true);
    const unchanged = sm.getBranch().map(entry => [entry.id, JSON.stringify(entry)] as const);
    assert.deepEqual(await hooks.get("session_before_compact")!(event("threshold"), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "threshold", aborted: true, willRetry: false }, ctx);
    assert.equal((await status()).sessionSummary.state, "accepted", "intentional threshold cancellation preserves the accepted request");
    await tick();
    assert.equal(sent.length, 0, "no boundary is appended while the run is busy");
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.ok(compactionTask);
    await compactionTask;
    await tick();
    assert.ok(returned.compaction);
    assert.equal(aborts, 0);
    assert.equal(schema, JSON.stringify(tools.get("request_compaction").parameters));
    assert.equal(sent.length, 2, "one pre-commit boundary and one later resume message");
    assert.equal(sent[0].message.customType, SESSION_AGENT_BOUNDARY_CUSTOM_TYPE);
    assert.deepEqual(sent[0].options, { triggerTurn: false });
    assert.deepEqual(sent[1].options, { triggerTurn: true });
    const receipt = returned.compaction.details.contextReceipt;
    assert.equal(receipt.budget.rawTailMessages, 1);
    assert.ok(receipt.budget.rawTailTokens < 1000, "no old minimum-tail reservation");
    assert.equal(receipt.sourceCutEntryId, submitted.resultId);
    assert.equal(receipt.sessionSummary.requestLeafId, submitted.requestLeafId);
    assert.equal(receipt.sessionSummary.submissionEntryId, submitted.submissionEntryId);
    assert.equal(returned.compaction.summary.split(summaryText).length, 2, "the submission is not duplicated in replay");
    assert.ok(returned.compaction.summary.indexOf("# Continuation summary") < returned.compaction.summary.indexOf("## Compressed chronology"));
    assert.equal(returned.compaction.summary.includes("Atomic replacement"), false, "native state remains receipt-only");
    for (const [id, bytes] of unchanged) assert.equal(JSON.stringify(sm.getEntry(id)), bytes);
    assert.equal((await status()).terminal.state, "committed");
    assert.equal((await status()).committedReceipt.compactionEntryId, committedId);
    assert.deepEqual((await status()).committedReceipt.recovery.args, { entryId: committedId });
    process.env.PI_CHRONO_MEMORY_OWNER = "chrono";
    await tools.get("history_recall").execute("recall-fixture", { query: "checksum" }, undefined, undefined, ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation.promotion, undefined);
    assert.equal(mirrors.length, 0);
    assert.equal((await status()).memoryOwner.reloadRequired, true);

    // Retry only after explicit new input. The real hook catches schema changes
    // during collection instead of substituting old fallback context.
    await hooks.get("input")!({ text: "Continue the fixture", source: "interactive" }, ctx);
    sm.appendMessage({ role: "user", content: "Continue the isolated fixture.", timestamp: Date.now() });
    checkPreview = false;
    await submit("stale");
    mutateDuringCollect = true;
    idle = true;
    compactionTask = undefined;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.ok(compactionTask);
    await compactionTask;
    assert.deepEqual(returned, { cancel: true });
    assert.equal((await status()).lastFailure.code, "context-v4-input-changed");
    assert.equal(sm.getBranch().filter(entry => entry.type === "compaction").length, 1);

    await hooks.get("input")!({ text: "Manual retry", source: "interactive" }, ctx);
    const beforeSend = sent.length;
    idle = false;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
    await tick();
    assert.equal(sent.length, beforeSend, "native manual compaction cannot start a nested summary run");
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeSend + 1);
    assert.equal(sent.at(-1).message.customType, "chrono-session-agent-summary-request");
    await hooks.get("input")!({ text: "Cancel the summary", source: "interactive" }, ctx);
    assert.equal((await status()).sessionSummary.state, "idle");
    const leaf = sm.getLeafId();
    assert.deepEqual(await hooks.get("session_before_compact")!(event("overflow"), ctx), { cancel: true });
    assert.equal((await status()).lastFailure.code, "session-agent-summary-overflow-unavailable");
    assert.equal(sm.getLeafId(), leaf);
    assert.equal(sent.length, beforeSend + 1, "overflow did not start another model request");
  } finally {
    remove();
    await hooks.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
