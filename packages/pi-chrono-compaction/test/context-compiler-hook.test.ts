import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextProvider } from "@context-kit/protocol";
import extension, { capturePreparedV4Context, resolveExtensionSettings, SESSION_AGENT_BOUNDARY_CUSTOM_TYPE,
  type SessionAgentPreviewCapture } from "../src/pi-extension.js";
import { previewContext } from "../src/composition-preview.js";
import { validateMemoryOwner } from "../src/user-config.js";
import { createSessionAgentSummaryRequest, consumeSessionAgentSummaryRequest, acceptSessionAgentSummary, settleSessionAgentSummary,
  renderSessionAgentSummaryRequest, SESSION_AGENT_SUMMARY_HEADROOM, SESSION_AGENT_SUMMARY_LIMITS,
  type SessionAgentSummaryReady } from "../src/session-agent-summary.js";
import type { SessionEntryLike } from "../src/types.js";

test("model-free V4 registered summary lifecycle preserves source, matches preview, defers native compaction and refuses stale capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-v4-hook-"));
  const environment = { PI_CHRONO_CONFIG_PATH: join(directory, "config.json"), PI_CHRONO_CONTEXT_COMPILER: "v4",
    PI_CHRONO_MEMORY_OWNER: "context-kit", PI_CHRONO_SEARCH_INDEX: "false", PI_CHRONO_MEMORY_ENGINE: "false",
    PI_CHRONO_AUTOMATIC_ROLLOVER: "false", PI_CHRONO_PI_SUMMARY: "true", PI_CHRONO_VALUE_WORKER_MODE: "off",
    PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false", PI_CHRONO_CATALOG_SHADOW: "false", PI_CHRONO_ROLLUP_SHADOW: "false",
    PI_CHRONO_TOOL_RESULT_PROJECTION: "off", PI_CHRONO_RAW_TAIL_MIN: "1000", PI_CHRONO_RAW_TAIL_MAX: "2000",
    PI_CHRONO_TRIGGER_TOKENS: "200000", PI_CHRONO_TRIGGER_MIN_GROWTH: "4000", PI_CHRONO_CONTEXT_RESERVE: "1500",
    PI_CHRONO_PI_SUMMARY_TOKENS: "10000" };
  const old = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  writeFileSync(environment.PI_CHRONO_CONFIG_PATH, "{}", { mode: 0o600 });
  const source = join(directory, "synthetic.jsonl");
  writeFileSync(source, "synthetic source for bounded mock transport\n", { mode: 0o600 });
  const hooks = new Map<string, (event: any, ctx: any) => any>(), tools = new Map<string, any>();
  const events = createEventBus(), sm = SessionManager.inMemory(directory);
  const mirrors: unknown[] = [], requests: any[] = [], sent: any[] = [];
  let schemaDescription = "Independent task state", mutateDuringCollect = false, idle = true, summaryToolActive = true;
  let contextTokens: number | null = 12000;
  const model = { provider: "fixture", id: "fixture", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 };
  let compactionTask: Promise<void> | undefined, returned: any, committedId: string | undefined, referenceReady: SessionAgentSummaryReady | undefined;
  let checkPreview = true, aborts = 0, previewMode = false, compactCalls = 0, authCalls = 0, commands = 0, flags = 0;
  let nativeReads = 0;
  const run = new AbortController();
  const remove = registerContextProvider(events, "todo", () => {
    nativeReads++;
    if (mutateDuringCollect) { schemaDescription = "Changed active schema"; mutateDuringCollect = false; }
    return { readiness: "ready", coverage: { scanned: 1, matched: 1, excluded: 0, scanComplete: true }, cards: [
      { id: "T2", revision: "2", status: "blocked", category: "task", title: "Atomic replacement", text: "Verify T1 first.",
        omittedFields: [], recovery: { tool: "todo", args: { action: "read", id: "T2" } }, relations: [{ type: "blocked_by", providerId: "todo", id: "T1" }] },
    ] };
  });
  const removePlan = registerContextProvider(events, "workplan", () => ({
    readiness: "ready", coverage: { scanned: 3, matched: 3, excluded: 0, scanComplete: true }, cards: [
      { id: "P-current", revision: "4", status: "active", category: "plan", title: "Lighthouse routing",
        text: "currentFocus: src/lighthouse.ts", omittedFields: [], recovery: { tool: "workplan", args: { action: "recover", planId: "P-current" } } },
      ...["completed", "archived"].map(status => ({ id: `P-${status}`, revision: "2", status, category: "plan" as const,
        title: "Obsoletepipeline archive", text: "src/obsoletepipeline.ts", omittedFields: [],
        recovery: { tool: "workplan" as const, args: { action: "recover" as const, planId: `P-${status}` } } })),
    ],
  }));
  const pi = {
    events, getActiveTools: () => ["todo", "workplan", "memory_get", ...(summaryToolActive ? ["request_compaction"] : [])],
    getAllTools: () => [{ name: "todo", description: schemaDescription, parameters: { type: "object" } },
      { name: "workplan", description: "Independent project state", parameters: { type: "object" } },
      { name: "memory_get", description: "Independent memory", parameters: { type: "object" } }, tools.get("request_compaction")],
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() { commands++; }, registerFlag() { flags++; },
    on(name: string, handler: any) { assert.ok(!hooks.has(name)); hooks.set(name, handler); },
    appendEntry(type: string, data: unknown) { mirrors.push({ type, data }); },
    sendMessage(message: any, options: any) {
      if (options.deliverAs === "steer") assert.equal(idle, false, "steering is requested at a completed busy turn");
      else {
        assert.equal(idle, true, "other fixture sends occur only after the native hook/run unwinds");
        assert.equal(options.deliverAs, undefined, "nextTurn would only queue the boundary");
      }
      sent.push({ message, options });
      sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (id: string, name: string, args: any) => ({ role: "assistant" as const,
    content: [{ type: "toolCall" as const, id, name, arguments: args }], api: "openai-completions" as const,
    provider: "fixture", model: "fixture", stopReason: "toolUse" as const, timestamp: Date.now(), usage });
  const nativeSourceIds: string[] = [], obsoleteSourceIds: string[] = [];
  for (const [name, ids] of [["lighthouse", nativeSourceIds], ["obsoletepipeline", obsoleteSourceIds]] as const) {
    ids.push(sm.appendMessage(assistant(`read-${name}`, "read", { path: `src/${name}.ts` })));
    ids.push(sm.appendMessage({ role: "toolResult", toolCallId: `read-${name}`, toolName: "read", isError: false,
      content: [{ type: "text", text: `Source evidence for src/${name}.ts. Native-only routing detail.` }], timestamp: 0 }));
  }
  for (let index = 0; index < 16; index++) sm.appendMessage({ role: "user", content: `History ${index}. ${"Preserve the original. ".repeat(90)}`, timestamp: index });
  sm.appendMessage(assistant("pair", "read", { path: "fixture" }));
  sm.appendMessage({ role: "toolResult", toolCallId: "pair", toolName: "read", content: [{ type: "text", text: "checksum fixture" }], isError: false, timestamp: 21 });
  const preparation = { firstKeptEntryId: sm.getBranch()[8]!.id, tokensBefore: 12000, messagesToSummarize: [], turnPrefixMessages: [],
    previousSummary: undefined, settings: { enabled: false, keepRecentTokens: 6000, reserveTokens: 2000 }, isSplitTurn: false,
  } as unknown as Parameters<typeof capturePreparedV4Context>[2]["preparation"];
  const event = (reason = "manual") => ({ branchEntries: sm.getBranch() as unknown as SessionEntryLike[], preparation, reason, willRetry: reason === "overflow", signal: new AbortController().signal });
  const ctx = { sessionManager: { getSessionId: () => sm.getSessionId(), getSessionFile: () => source,
      getLeafId: () => sm.getLeafId(), getEntry: (id: string) => sm.getEntry(id), getBranch: () => sm.getBranch(),
      buildContextEntries: () => sm.buildContextEntries() },
    hasUI: false, ui: { notify() {} }, isIdle: () => idle, hasPendingMessages: () => false,
    get signal() { return idle ? undefined : run.signal; }, abort() { aborts++; },
    model, thinkingLevel: "off",
    getSystemPrompt: () => "Synthetic system prompt", getContextUsage: () => ({ contextWindow: model.contextWindow, tokens: contextTokens }),
    modelRegistry: { getApiKeyAndHeaders() { authCalls++; throw new Error("V4 must not request summary auth"); } },
    compact(options: any) {
      compactCalls++;
      assert.equal(previewMode, false, "preview must never call ctx.compact");
      assert.equal(idle, true, "ctx.compact starts only at safe idle");
      idle = false;
      compactionTask = (async () => {
        const inputEvent = event();
        let preview: ReturnType<typeof previewContext> | undefined;
        if (checkPreview) {
          assert.ok(referenceReady);
          const beforeCapture = nativeReads;
          const captured = await capturePreparedV4Context(pi as unknown as ExtensionAPI, ctx, inputEvent, {
            settings: () => resolveExtensionSettings(), memoryOwner: "context-kit", epoch: () => 0,
            boundary: { ready: referenceReady, entryId: sm.getLeafId()! },
          });
          assert.equal(nativeReads, beforeCapture + 1, "one collection supplies both hints and the frozen native receipt");
          assert.equal(captured.input.history.kind, "events");
          if (captured.input.history.kind !== "events") throw new Error("Expected event replay");
          assert.deepEqual(captured.input.history.selection.relevanceTerms.slice(0, 2), ["checksum", "isolated implementation"]);
          preview = previewContext(captured.input);
        }
        const beforeActiveCapture = nativeReads;
        returned = await hooks.get("session_before_compact")!(inputEvent, ctx);
        assert.equal(nativeReads, beforeActiveCapture + 1, "active capture must not rescan native state for its receipt");
        if (!returned.compaction) {
          await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
          idle = true;
          options.onError(new Error("Compaction cancelled"));
          return;
        }
        if (preview) {
          assert.equal(returned.compaction.summary, preview.summary);
          assert.equal(returned.compaction.details.contextReceipt.inputHash, preview.receipt.inputHash);
        }
        const before = sm.getLeafId();
        committedId = sm.appendCompaction(returned.compaction.summary, returned.compaction.firstKeptEntryId, returned.compaction.tokensBefore, returned.compaction.details, true);
        assert.equal(sm.getEntry(committedId)!.parentId, before);
        const resumesBeforeCommit = sent.filter(row => row.message.customType === "chrono-compact-resume").length;
        await hooks.get("session_compact")!({ compactionEntry: sm.getEntry(committedId), fromExtension: true, reason: "manual", willRetry: false }, ctx);
        // Match installed Pi: a later awaited session_compact handler can keep
        // isCompacting true beyond Chrono's zero-delay callback. No settled
        // event follows manual compaction. Only onComplete sees cleanup.
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(sent.filter(row => row.message.customType === "chrono-compact-resume").length, resumesBeforeCommit);
        idle = true;
        options.onComplete();
        const resumesAfterComplete = sent.filter(row => row.message.customType === "chrono-compact-resume").length;
        options.onComplete();
        assert.equal(sent.filter(row => row.message.customType === "chrono-compact-resume").length, resumesAfterComplete,
          "duplicate owned completion must not resume twice");
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
      targetTokens: Math.min(2000, resolveExtensionSettings().hybridSummaryTargetTokens), requestToolCallId: requestCallId, scope: { sessionId: sm.getSessionId(), sessionFile: source, leafId: requestLeafId, epoch: 0,
        model: { provider: "fixture", id: "fixture", api: "openai-completions", thinkingLevel: "off" } } });
    sm.appendMessage({ role: "toolResult", toolCallId: requestCallId, toolName: "request_compaction", content: requestResult.content, details: requestResult.details, isError: false, timestamp: Date.now() });
    // Pi 0.87.1 refreshes the native prompt/tool loadout before the next request.
    // The locked 0.85.1 declarations do not yet include this persisted role.
    sm.appendMessage({ role: "system", content: "", sections: { tools: "Updated fixture tool definitions" }, timestamp: Date.now() } as unknown as Parameters<typeof sm.appendMessage>[0]);
    const view = () => ({ scope: { ...request.scope, leafId: sm.getLeafId()! }, now: Date.now(), getEntry: (id: string) => sm.getEntry(id) as SessionEntryLike | undefined });
    const messages = sm.buildSessionContext().messages;
    await hooks.get("context")!({ messages }, ctx);
    if (!previewMode) assert.equal((await status()).sessionSummary.state, "consumed");
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
    assert.equal(receipt.budget.nativeRenderedTokens, 0);
    const replayReceipt = receipt.history.receipt;
    assert.ok(replayReceipt.relevanceTerms.includes("src/lighthouse.ts"));
    assert.ok(!replayReceipt.relevanceTerms.some((term: string) => term.includes("obsoletepipeline")), "closed native cards cannot create implicit hints");
    for (const id of nativeSourceIds) assert.ok(replayReceipt.selected.some((row: any) => row.id === id && row.reasons.includes("relevance-match")));
    for (const id of obsoleteSourceIds) assert.ok(replayReceipt.omitted.some((row: any) => row.id === id && row.reason === "low-relevance"));
    assert.deepEqual(replayReceipt.selected.map((row: any) => row.index), replayReceipt.selected.map((row: any) => row.index).sort((a: number, b: number) => a - b));
    for (const id of nativeSourceIds) assert.ok(returned.compaction.summary.includes(`history_get entryId="${id}"`));
    assert.equal(returned.compaction.summary.includes("currentFocus: src/lighthouse.ts"), false, "only source evidence, not a native card dump, enters chronology");
    for (const [id, bytes] of unchanged) assert.equal(JSON.stringify(sm.getEntry(id)), bytes);
    assert.equal((await status()).terminal.state, "committed");
    assert.equal((await status()).committedReceipt.compactionEntryId, committedId);
    assert.deepEqual((await status()).committedReceipt.recovery.args, { entryId: committedId });
    contextTokens = null;
    idle = false;
    await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    await hooks.get("before_provider_request")!({ payload: { messages: sm.buildSessionContext().messages } }, ctx);
    assert.equal(aborts, 0, "the first null-usage post-commit request uses the current projection");
    contextTokens = 12000;
    idle = true;

    // A new context cycle must not wait for growth above the old pre-commit count.
    process.env.PI_CHRONO_TRIGGER_TOKENS = "12000";
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, 3, "the next cycle requests its summary at the same threshold as the last attempt");
    assert.equal(sent.at(-1).message.customType, "chrono-session-agent-summary-request");
    await hooks.get("input")!({ text: "Cancel the next-cycle fixture", source: "interactive" }, ctx);
    process.env.PI_CHRONO_TRIGGER_TOKENS = "200000";
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
    assert.equal((await status()).providerBarrier.state, "paused");
    await hooks.get("before_agent_start")!({}, ctx);
    const beforePausedAbort = aborts;
    idle = false;
    await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    assert.equal(aborts, beforePausedAbort + 1, "a new agent run cannot release the failed barrier");
    assert.equal((await status()).lastFailure.code, "context-v4-input-changed");
    idle = true;
    const beforeUncorrelated = sent.length;
    await hooks.get("session_compact")!({ compactionEntry: sm.getEntry(committedId!), fromExtension: true,
      reason: "manual", willRetry: false }, ctx);
    assert.equal((await status()).providerBarrier.state, "paused", "a V4 event without a pending receipt cannot release the barrier");
    assert.equal((await status()).lastFailure.code, "session-agent-summary-commit-uncorrelated");
    await tick();
    assert.equal(sent.length, beforeUncorrelated);

    await hooks.get("input")!({ text: "Check summary tool readiness", source: "interactive" }, ctx);
    summaryToolActive = false;
    const beforeUnavailable = sent.length;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    assert.equal((await status()).lastFailure.code, "session-agent-summary-tool-unavailable");
    assert.equal(sent.length, beforeUnavailable, "do not send a summary request with no callable submission tool");
    summaryToolActive = true;

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
    assert.equal((await status()).lastFailure.code, "session-agent-summary-tool-unavailable", "a paused overflow preserves the blocker instead of attempting a fallback");
    assert.equal(sm.getLeafId(), leaf);
    assert.equal(sent.length, beforeSend + 1, "overflow did not start another model request");

    // Exercise the approved planning allowance with Codex-sized metadata. No
    // provider request is made, and the model metadata and prompt stay unchanged.
    await hooks.get("input")!({ text: "Check bounded summary headroom", source: "interactive" }, ctx);
    const smallModel = { ...model };
    Object.assign(model, { contextWindow: 272000, maxTokens: 128000 });
    const modelBefore = JSON.stringify(model);
    assert.deepEqual(SESSION_AGENT_SUMMARY_HEADROOM, { planningTokens: 16384, safetyTokens: 1024, proactiveMarginTokens: 4096 });
    const prompt = renderSessionAgentSummaryRequest(createSessionAgentSummaryRequest({ requestId: "0".repeat(36), reason: "tool", now: Date.now(),
      scope: { sessionId: sm.getSessionId(), sessionFile: source, leafId: sm.getLeafId()!, epoch: 0,
        model: { provider: model.provider, id: model.id, api: model.api, thinkingLevel: "off" } }, targetTokens: 2000 }));
    const promptTokens = Math.ceil(prompt.length / 4);
    const admissionLimit = model.contextWindow - promptTokens - 16384 - 1500 - 1024;
    contextTokens = admissionLimit - 1;
    idle = false;
    const admitted = await tools.get("request_compaction").execute("bounded-request", {}, run.signal, undefined, ctx);
    assert.equal(admitted.details.status, "summary-requested");
    assert.equal(Math.ceil(admitted.content[0].text.length / 4), promptTokens);
    assert.match(admitted.content[0].text, /Target about 2000 tokens and stay below 8000 characters/);
    assert.equal(JSON.stringify(model), modelBefore);
    await hooks.get("input")!({ text: "Check strict admission boundary", source: "interactive" }, ctx);
    contextTokens = admissionLimit;
    const beforeHeadroomRefusal = sent.length, beforeRefusalLeaf = sm.getLeafId();
    const refused = await tools.get("request_compaction").execute("refused-request", {}, run.signal, undefined, ctx);
    assert.equal(refused.terminate, true);
    assert.equal(refused.isError, true);
    assert.equal(refused.details.code, "session-agent-summary-headroom-unavailable");
    assert.equal((await status()).providerBarrier.state, "paused");
    assert.equal(sent.length, beforeHeadroomRefusal);
    assert.equal(sm.getLeafId(), beforeRefusalLeaf);

    const recover = async (suffix: string) => {
      await hooks.get("input")!({ text: "Recover only through a fresh summary", source: "interactive" }, ctx);
      contextTokens = 12000;
      await submit(suffix);
      assert.equal((await status()).providerBarrier.retryPaused, true, "submission does not release the failure latch");
      idle = true;
      compactionTask = undefined;
      await hooks.get("agent_settled")!({}, ctx);
      await tick();
      assert.ok(compactionTask);
      await compactionTask;
      await tick();
      assert.equal((await status()).providerBarrier.state, "open");
    };
    await recover("recovery-before-timing");
    const beforeTiming = sent.length;
    contextTokens = 199999;
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeTiming, "no proactive request below the configured threshold");
    contextTokens = 200000;
    idle = false;
    const turn = { message: assistant("timing", "read", {}) };
    await hooks.get("turn_end")!(turn, ctx);
    assert.equal(sent.length, beforeTiming, "no ticket is delivered to the run that is being aborted");
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeTiming + 1);
    assert.deepEqual(sent.at(-1).options, { triggerTurn: true });
    assert.ok(contextTokens < admissionLimit);
    idle = false;
    await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    await hooks.get("turn_end")!(turn, ctx);
    assert.equal((await status()).lastFailure.code, "session-agent-summary-submission-unavailable");
    assert.equal(sent.length, beforeTiming + 1, "an unusable response cannot silently retry");

    // A smaller window must trigger from headroom, not the later 75% warning or
    // configured threshold. The idle path uses the same admission calculation.
    await recover("recovery-before-headroom");
    Object.assign(model, { contextWindow: 64000, maxTokens: 64000 });
    const headroomThreshold = 64000 - Math.ceil(SESSION_AGENT_SUMMARY_LIMITS.promptBytes / 4) - 16384 - 1500 - 1024 - 4096;
    assert.equal(headroomThreshold, 37924);
    const beforeHeadroomTrigger = sent.length;
    contextTokens = headroomThreshold - 1;
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeHeadroomTrigger);
    contextTokens = headroomThreshold;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeHeadroomTrigger + 1);
    assert.deepEqual(sent.at(-1).options, { triggerTurn: true });
    await recover("recovery-before-overshoot");
    const beforeOvershoot = sent.length, beforeOvershootAbort = aborts;
    idle = false;
    contextTokens = 100; // The assistant's newer observation must still win.
    await hooks.get("turn_end")!({ message: { ...turn.message, usage: { ...usage,
      totalTokens: model.contextWindow - promptTokens - 16384 - 1500 - 1024 } } }, ctx);
    assert.equal((await status()).lastFailure.code, "session-agent-summary-headroom-unavailable");
    assert.equal(sent.length, beforeOvershoot, "an overshoot refuses without sending another request");
    assert.equal(aborts, beforeOvershootAbort + 1);
    Object.assign(model, smallModel);
    contextTokens = 12000;

    // An idle manual request after final output may summarize, but its own
    // submission toolUse must not authorize an ordinary continuation.
    await hooks.get("input")!({ text: "Check idle manual compaction", source: "interactive" }, ctx);
    sm.appendMessage({ ...assistant("completed", "read", {}), content: [{ type: "text", text: "The authorized fixture work is complete." }], stopReason: "stop" });
    idle = true;
    const resumesBeforeIdleManual = sent.filter(row => row.message.customType === "chrono-compact-resume").length;
    const commitsBeforeIdleManual = sm.getBranch().filter(entry => entry.type === "compaction").length;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
    await tick();
    assert.equal(sent.at(-1).message.customType, "chrono-session-agent-summary-request");
    const idleManualRequestId = (await status()).sessionSummary.requestId;
    idle = false;
    await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    const idleManualArgs = { requestId: idleManualRequestId, summary: "The authorized fixture work is complete. Remain idle." };
    const idleManualMessage = assistant("idle-manual-submit", "request_compaction", idleManualArgs);
    sm.appendMessage(idleManualMessage);
    const idleManualResult = await tools.get("request_compaction").execute("idle-manual-submit", idleManualArgs, run.signal, undefined, ctx);
    assert.equal(idleManualResult.terminate, true);
    sm.appendMessage({ role: "toolResult", toolCallId: "idle-manual-submit", toolName: "request_compaction", content: idleManualResult.content,
      details: idleManualResult.details, isError: false, timestamp: Date.now() });
    await hooks.get("turn_end")!({ message: idleManualMessage }, ctx);
    idle = true;
    compactionTask = undefined;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.ok(compactionTask);
    await compactionTask;
    await tick();
    assert.equal((await status()).terminal.state, "committed");
    assert.equal((await status()).providerBarrier.state, "open");
    assert.equal(sm.getBranch().filter(entry => entry.type === "compaction").length, commitsBeforeIdleManual + 1);
    assert.equal(sent.filter(row => row.message.customType === "chrono-compact-resume").length, resumesBeforeIdleManual,
      "completed idle manual compaction must not resume the original task");

    // Load the private preview option through the same registration. Synthetic
    // assistant entries exercise dispatch, not model-written summary evidence.
    await hooks.get("session_shutdown")!({}, ctx);
    hooks.clear(); tools.clear(); sent.length = 0; requests.length = 0;
    previewMode = true;
    const compactCallsBefore = compactCalls, commandsBefore = commands, flagsBefore = flags;
    const privateFilesBefore = readdirSync(directory, { recursive: true });
    let previewCapture: SessionAgentPreviewCapture | undefined, previewCalls = 0, backgroundCalls = 0;
    const previewErrors: string[] = [];
    let resolveCapture!: () => void;
    const delivered = new Promise<void>(resolve => { resolveCapture = resolve; });
    Object.assign(process.env, { PI_CHRONO_CONTEXT_COMPILER: "v4", PI_CHRONO_MEMORY_OWNER: "context-kit",
      PI_CHRONO_SEARCH_INDEX: "true", PI_CHRONO_AUTOMATIC_ROLLOVER: "true", PI_CHRONO_VALUE_WORKER_MODE: "advisory",
      PI_CHRONO_INCREMENTAL_PRECOMPUTE: "true", PI_CHRONO_CATALOG_SHADOW: "true", PI_CHRONO_ROLLUP_SHADOW: "true",
      PI_CHRONO_TOOL_RESULT_PROJECTION: "aggressive" });
    extension(pi as unknown as ExtensionAPI, { schedulerDirectory: directory,
      capsuleShadowTarget() { backgroundCalls++; throw new Error("Preview scheduled capsule work"); },
      readOnlyStartupVerifier: async () => { backgroundCalls++; return true; },
      sessionAgentPreview: { sessionId: sm.getSessionId(), sessionFile: source, reserveTokens: 2000,
        async onReady(capture) {
          previewCalls++;
          capture.revalidate();
          await tick(); // Private artifact writers may be asynchronous.
          capture.revalidate();
          assert.equal(capture.compiled.summary, previewContext(capture.input).summary);
          assert.equal(capture.ready.submission.summary, summaryText);
          previewCapture = capture;
          resolveCapture();
        },
        onError: code => { previewErrors.push(code); },
      } });
    assert.deepEqual([...tools.keys()], ["request_compaction"]);
    assert.equal(JSON.stringify(tools.get("request_compaction").parameters), schema);
    assert.equal(commands, commandsBefore);
    assert.equal(flags, flagsBefore);
    // Restoring a retained loader's environment cannot change candidate settings.
    process.env.PI_CHRONO_CONTEXT_COMPILER = "v3";
    process.env.PI_CHRONO_MEMORY_OWNER = "chrono";
    const noLifecycleWork = new Proxy({}, { get(_target, key) { throw new Error(`Unexpected preview lifecycle access: ${String(key)}`); } });
    for (const hook of ["session_start", "session_before_tree", "session_tree", "session_before_switch", "session_before_fork",
      "session_shutdown", "before_agent_start", "turn_end", "agent_settled"]) await hooks.get(hook)!({}, noLifecycleWork);
    for (const reason of ["manual", "threshold", "overflow"]) {
      assert.deepEqual(await hooks.get("session_before_compact")!({ reason }, noLifecycleWork), { cancel: true });
      await hooks.get("session_compact_failed")!({ reason, aborted: true }, noLifecycleWork);
    }
    await assert.rejects(tools.get("request_compaction").execute("wrong-target", {}, run.signal, undefined,
      { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "another-session" } }), /preview-target-mismatch/);
    sm.appendMessage({ role: "user", content: "Exercise the private preview only.", timestamp: Date.now() });
    const previewSubmitted = await submit("private-preview");
    const beforeCapture = sm.getBranch().map(entry => [entry.id, JSON.stringify(entry)] as const);
    await hooks.get("agent_settled")!({}, ctx); // Deliberately still busy.
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(previewCalls, 0);
    assert.deepEqual(await hooks.get("session_before_compact")!(event("threshold"), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "threshold", aborted: true }, ctx);
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    const timeout = setTimeout(() => resolveCapture(), 2000);
    try { await delivered; } finally { clearTimeout(timeout); }
    assert.ok(previewCapture, `preview callback did not succeed: ${previewErrors.join(", ")}`);
    assert.equal(previewCalls, 1);
    assert.equal(previewCapture.ready.submissionAssistantLeafId, previewSubmitted.submissionEntryId);
    assert.equal(previewCapture.ready.submissionResultLeafId, previewSubmitted.resultId);
    assert.equal(previewCapture.compiled.receipt.sourceCutEntryId, previewSubmitted.resultId);
    assert.equal(previewCapture.input.memoryOwner, "context-kit");
    assert.equal(previewCapture.input.budget.responseReserveTokens, 2000);
    assert.equal(previewCapture.exactTail.length, 1);
    assert.deepEqual(previewCapture.exactTail, [sm.getEntry(previewCapture.boundary.entryId)]);
    assert.equal(previewCapture.tail.firstKeptEntryId, previewCapture.boundary.entryId);
    assert.equal(sent.length, 1, "only the verified boundary is appended, not a resume or summary request");
    assert.deepEqual(sent[0].options, { triggerTurn: false });
    for (const [id, bytes] of beforeCapture) assert.equal(JSON.stringify(sm.getEntry(id)), bytes);
    for (const reason of ["manual", "threshold", "overflow"]) {
      assert.deepEqual(await hooks.get("session_before_compact")!({ reason }, noLifecycleWork), { cancel: true });
    }
    await hooks.get("agent_settled")!({}, noLifecycleWork);
    await tick();
    assert.equal(previewCalls, 1, "a settled event cannot redeliver or compact a consumed preview");
    assert.equal(compactCalls, compactCallsBefore);
    assert.equal(authCalls, 0);
    assert.equal(backgroundCalls, 0);
    assert.equal(requests.length, 0);
    assert.equal(mirrors.length, 0);
    assert.deepEqual(previewErrors, []);
    assert.deepEqual(readdirSync(directory, { recursive: true }), privateFilesBefore, "candidate created no store, runtime or background files");
  } finally {
    remove(); removePlan();
    await hooks.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("late V4 admission keeps the native floor, charges visible growth and handles Codex opaque replay explicitly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-v4-admission-"));
  const environment = { PI_CHRONO_CONFIG_PATH: join(directory, "config.json"), PI_CHRONO_CONTEXT_COMPILER: "v4",
    PI_CHRONO_MEMORY_OWNER: "context-kit", PI_CHRONO_SEARCH_INDEX: "false", PI_CHRONO_MEMORY_ENGINE: "false",
    PI_CHRONO_AUTOMATIC_ROLLOVER: "false", PI_CHRONO_VALUE_WORKER_MODE: "off", PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false",
    PI_CHRONO_CATALOG_SHADOW: "false", PI_CHRONO_ROLLUP_SHADOW: "false", PI_CHRONO_TOOL_RESULT_PROJECTION: "off",
    PI_CHRONO_TRIGGER_TOKENS: "200000", PI_CHRONO_TRIGGER_MIN_GROWTH: "4000", PI_CHRONO_CONTEXT_RESERVE: "1500" };
  const old = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  writeFileSync(environment.PI_CHRONO_CONFIG_PATH, "{}", { mode: 0o600 });
  const cases = [
    { name: "opaque-only", native: 184068, opaque: 1020000, refused: false },
    { name: "conversation", native: 184068, opaque: 1020000, refused: true },
    { name: "instructions", native: 184068, opaque: 1020000, refused: true },
    { name: "schemas", native: 184068, opaque: 1020000, refused: true },
    { name: "post-commit-null", native: null, opaque: 0, refused: false },
    { name: "null-opaque-fallback", native: null, opaque: 1020000, refused: true },
    { name: "unknown-api-fallback", native: 184068, opaque: 1020000, refused: true },
    { name: "invalid-native", native: 184068, opaque: 0, refused: true },
    { name: "malformed-opaque", native: 184068, opaque: 0, refused: true },
  ];
  try {
    for (const fixture of cases) {
      const hooks = new Map<string, (event: any, ctx: any) => any>(), tools = new Map<string, any>();
      const sm = SessionManager.inMemory(directory);
      sm.appendMessage({ role: "user", content: "The same small visible conversation.", timestamp: 1 });
      let aborts = 0, nativeTokens: number | null = fixture.native;
      const pi = { events: createEventBus(), getActiveTools: () => ["request_compaction"], getAllTools: () => [...tools.values()],
        registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerFlag() {},
        on: (name: string, handler: any) => hooks.set(name, handler),
        appendEntry() { throw new Error("Unexpected source write"); }, sendMessage() { throw new Error("Unexpected message send"); } };
      const ctx = { sessionManager: sm,
        model: { provider: "openai-codex", id: "fixture", api: fixture.name === "unknown-api-fallback" ? "unknown-api" : "openai-codex-responses",
          contextWindow: 272000, maxTokens: 128000 }, thinkingLevel: "off", hasUI: false, ui: { notify() {} },
        isIdle: () => false, hasPendingMessages: () => false, abort: () => { aborts++; },
        getSystemPrompt: () => "Offline bounded fixture.", getContextUsage: () => ({ contextWindow: 272000, tokens: nativeTokens }) };
      extension(pi as unknown as ExtensionAPI, { schedulerDirectory: directory });
      try {
        const source = JSON.stringify(sm.getEntries());
        await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
        assert.equal(aborts, 0, `${fixture.name}: early admission`);
        const payload = { model: "fixture", instructions: "Offline bounded fixture.",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "The same small visible conversation." }] },
            { type: "reasoning", summary: [], encrypted_content: "A".repeat(fixture.opaque) }], tools: [] } as any;
        if (fixture.name === "conversation") payload.input[0].content[0].text += "V".repeat(320000);
        if (fixture.name === "instructions") payload.instructions += "V".repeat(320000);
        if (fixture.name === "schemas") payload.tools.push({ type: "function", name: "read", description: "V".repeat(320000), parameters: { type: "object" } });
        if (fixture.name === "invalid-native") nativeTokens = NaN;
        if (fixture.name === "malformed-opaque") payload.input[1].encrypted_content = { unknown: "transport" };
        const serialized = JSON.stringify(payload), event = { payload };
        assert.equal(await hooks.get("before_provider_request")!(event, ctx), undefined);
        assert.equal(event.payload, payload, "the accounting view never replaces the request");
        assert.equal(JSON.stringify(payload), serialized, "the original opaque replay and visible fields remain unchanged");
        assert.equal(JSON.stringify(sm.getEntries()), source, "admission does not rewrite source");
        const composition = (await tools.get("history_status").execute()).details.composition;
        assert.equal(aborts, fixture.refused ? 1 : 0, fixture.name);
        assert.equal(composition.providerBarrier.state, fixture.refused ? "paused" : "open", fixture.name);
        if (fixture.refused) assert.equal(composition.lastFailure.code, "session-agent-summary-headroom-unavailable", fixture.name);
      } finally { await hooks.get("session_shutdown")!({}, ctx); }
    }
  } finally {
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
