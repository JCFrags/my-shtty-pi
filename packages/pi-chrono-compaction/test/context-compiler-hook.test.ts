import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, DEFAULT_COMPACTION_SETTINGS, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextProvider } from "@context-kit/protocol";
import extension, { captureIntervalRuntimeBudget, capturePreparedV4Context, SESSION_AGENT_BOUNDARY_CUSTOM_TYPE,
  type SessionAgentPreviewCapture } from "../src/pi-extension.js";
import { captureContextCompilation, previewContext } from "../src/composition-preview.js";
import { validateMemoryOwner } from "../src/user-config.js";
import { createSessionAgentSummaryRequest, consumeSessionAgentSummaryRequest, acceptSessionAgentSummary, settleSessionAgentSummary,
  parseSessionAgentSummarySubmission, renderSessionAgentSummaryRequest, SESSION_AGENT_SUMMARY_LIMITS,
  type SessionAgentSummaryReady } from "../src/session-agent-summary.js";
import type { SessionEntryLike } from "../src/types.js";
import { captureIntervalSource, type IntervalSourceSnapshot } from "../src/interval-source.js";
import { classifyPressure, deriveIntervalBudget } from "../src/interval-policy.js";
import { INTERVAL_CONTINUATION_MESSAGE, INTERVAL_CONTINUATION_RECORD } from "../src/interval-runtime.js";

test("model-free interval lifecycle verifies public proposals, preserves source, matches preview and refuses stale capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-v4-hook-"));
  const environment = { PI_CHRONO_CONFIG_PATH: join(directory, "config.json"), PI_CHRONO_CONTEXT_COMPILER: "v4",
    PI_CHRONO_MEMORY_OWNER: "context-kit", PI_CHRONO_SEARCH_INDEX: "false", PI_CHRONO_MEMORY_ENGINE: "false",
    PI_CHRONO_AUTOMATIC_ROLLOVER: "false", PI_CHRONO_PI_SUMMARY: "true", PI_CHRONO_VALUE_WORKER_MODE: "off",
    PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false", PI_CHRONO_CATALOG_SHADOW: "false", PI_CHRONO_ROLLUP_SHADOW: "false",
    PI_CHRONO_TOOL_RESULT_PROJECTION: "off", PI_CHRONO_RAW_TAIL_MIN: "1000", PI_CHRONO_RAW_TAIL_MAX: "2000",
    PI_CHRONO_TRIGGER_TOKENS: "200000", PI_CHRONO_TRIGGER_MIN_GROWTH: "4000", PI_CHRONO_CONTEXT_RESERVE: "1500",
    PI_CHRONO_PI_SUMMARY_TOKENS: "10000", PI_CHRONO_SESSION_SUMMARY_TOKENS: "3000" };
  const old = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  writeFileSync(environment.PI_CHRONO_CONFIG_PATH, "{}", { mode: 0o600 });
  const source = join(directory, "synthetic.jsonl");
  writeFileSync(source, "synthetic source for bounded mock transport\n", { mode: 0o600 });
  const hooks = new Map<string, (event: any, ctx: any) => any>(), tools = new Map<string, any>();
  const events = createEventBus(), sm = SessionManager.inMemory(directory);
  const mirrors: { type: string; data: any }[] = [], requests: any[] = [], sent: any[] = [];
  let schemaDescription = "Independent task state", mutateDuringCollect = false, idle = true, summaryToolActive = true;
  let contextTokens: number | null = 12000;
  const model = { provider: "fixture", id: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
    input: ["text" as const], contextWindow: 32000, maxTokens: 2000 };
  let returned: any, committedId: string | undefined, referenceReady: SessionAgentSummaryReady | undefined;
  let referenceInterval: IntervalSourceSnapshot | undefined, referenceRelevance: readonly string[] = [];
  let aborts = 0, previewMode = false, compactCalls = 0, authCalls = 0, commands = 0, flags = 0;
  let nativeReads = 0, actionableResume = false, interruptResume = false;
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
    appendEntry(type: string, data: unknown) { mirrors.push({ type, data }); sm.appendCustomEntry(type, data); },
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
  const assistant = (id: string, name: string, args: any, totalTokens = 0) => ({ role: "assistant" as const,
    content: [{ type: "toolCall" as const, id, name, arguments: args }], api: "openai-completions" as const,
    provider: "fixture", model: "fixture", stopReason: "toolUse" as const, timestamp: Date.now(),
    usage: { ...usage, input: totalTokens, totalTokens } });
  const turnBoundary = (message: any, messageEntryId: string, toolResultEntryIds: string[] = []) => ({
    message, messageEntryId, toolResultEntryIds, toolResults: toolResultEntryIds.map(id => (sm.getEntry(id) as any).message),
    outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], canContinue: true },
  });
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
      buildContextEntries: () => sm.buildContextEntries(), buildSessionProjection: () => sm.buildSessionProjection() },
    hasUI: false, ui: { notify() {} }, isIdle: () => idle, hasPendingMessages: () => false,
    get signal() { return idle ? undefined : run.signal; }, abort() { aborts++; },
    model, thinkingLevel: "off",
    getSystemPrompt: () => "Synthetic system prompt", getContextUsage: () => ({ contextWindow: model.contextWindow, tokens: contextTokens }),
    modelRegistry: { getApiKeyAndHeaders() { authCalls++; throw new Error("V4 must not request summary auth"); } },
    compact() {
      compactCalls++;
      throw new Error("The public accepted-summary proposal must not call ctx.compact");
    },
  } as unknown as ExtensionContext;
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  const status = async () => (await tools.get("history_status").execute()).details.composition;
  const deliverInput = async (text: string) => {
    await hooks.get("input")!({ text, source: "interactive" }, ctx);
    const message = { role: "user" as const, content: text, timestamp: Date.now() };
    // Raw input alone is not a delivered run. Match the observed native events.
    await hooks.get("agent_start")!({}, ctx);
    await hooks.get("message_start")!({ message }, ctx);
    sm.appendMessage(message);
  };
  // A native counter alone cannot calibrate replay after a compaction. Persist
  // the selected prompt/tools and a successful same-model usage observation.
  const recordRequestInputs = () => sm.appendMessage({ role: "system", content: ctx.getSystemPrompt(),
    toolsAdded: pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: Date.now(),
  } as unknown as Parameters<typeof sm.appendMessage>[0]);
  const observeUsage = (tokens: number) => {
    contextTokens = tokens;
    recordRequestInputs();
    sm.appendMessage({ ...assistant("usage-observation", "read", {}, tokens),
      content: [{ type: "text", text: "Bounded source usage observation." }], stopReason: "stop" });
  };
  const summaryText = "Synthetic fixture handoff: continue the isolated implementation. Publication and activation are not approved. The checksum read passed.";
  const continuationText = "Continue the isolated implementation from the verified checksum. Do not publish or activate.";
  const requestLayers = () => {
    const budget = captureIntervalRuntimeBudget(pi as unknown as ExtensionAPI, ctx);
    return deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
      toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens,
      effectiveAvailableTokens: budget.effectiveCeilingTokens });
  };
  const dispatched = () => mirrors.filter(row => row.type === INTERVAL_CONTINUATION_RECORD && row.data.state === "dispatched").length;
  const commitProposal = async (proposal: any) => {
    assert.equal(proposal.entries.length, 1);
    const compaction = proposal.entries[0];
    assert.equal(compaction.type, "compaction");
    assert.equal(compaction.firstKeptEntryId, null, "the public draft requests retain-none");
    assert.equal(compaction.details.kind, "chrono-v4-current-agent");
    const receipt = compaction.details.contextReceipt, operation = compaction.details.summaryOperation;
    assert.equal(operation.operationId, receipt.sessionSummary.requestId);
    assert.equal(operation.retainNoneIntent, `retain-none:${operation.operationId}`);
    assert.equal(operation.sourceSnapshotId, receipt.restart.snapshotId);
    assert.equal(operation.retention, "none");
    assert.equal(operation.authority, "derived");
    assert.deepEqual(receipt.nativeRetention, { kind: "none", operationId: operation.operationId });
    assert.equal(receipt.restart.technicalBoundaryEntryId, undefined);
    assert.equal((await status()).terminal.state, "returned");
    assert.equal((await status()).providerBarrier.state, "recovery-only", "a proposal is not a verified commit");
    const parentId = sm.getLeafId(), beforeDispatch = dispatched();
    // Pi's public boundary persists null retention as the new entry's own ID.
    // It does not emit session_compact or call a native compaction hook.
    committedId = sm.appendCompaction(compaction.summary, null, contextTokens ?? 0, compaction.details, true);
    const committed = sm.getEntry(committedId) as any;
    assert.equal(committed.parentId, parentId);
    assert.equal(committed.firstKeptEntryId, committedId);
    assert.equal(committed.fromHook, true);
    assert.equal((await status()).providerBarrier.state, "recovery-only", "persistence alone cannot release the barrier");
    assert.equal(dispatched(), beforeDispatch, "continuation requires observation of the persisted receipt");
    sm.appendCustomEntry("pi-date-reference:v1", { contextId: committedId });
    sm.appendCustomEntry("fixture-postcommit-metadata", {});
    if (interruptResume) sm.appendCustomMessageEntry("fixture-context-change", "Changed context", false);
    const boundary = { outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], canContinue: true } };
    if (actionableResume || !proposal.continue) {
      const continuation = await hooks.get("agent_before_settle")!(boundary, ctx);
      if (proposal.continue && !interruptResume) {
        assert.equal(continuation.continue, true);
        assert.equal(continuation.entries.length, 1);
        const { type, ...message } = continuation.entries[0];
        assert.equal(type, "custom_message");
        assert.equal(message.customType, "chrono-compact-resume");
        sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      } else assert.equal(continuation, undefined);
      assert.equal(await hooks.get("agent_before_settle")!(boundary, ctx), undefined, "a public boundary cannot dispatch twice");
    } else {
      // A native continue uses the next context observation, not an idle send.
      await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
      const afterObservation = dispatched();
      await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
      assert.equal(dispatched(), afterObservation, "duplicate context observation cannot dispatch twice");
    }
    assert.equal((await status()).terminal.state, "committed");
    assert.equal((await status()).committedReceipt.compactionEntryId, committedId);
    assert.equal(dispatched(), beforeDispatch + (proposal.continue && !interruptResume ? 1 : 0));
    assert.equal(compactCalls, 0);
    idle = true;
  };
  const submit = async (suffix: string, reference = false, staleCapture = false) => {
    idle = false;
    const requestCallId = `request-${suffix}`, submitCallId = `submit-${suffix}`;
    recordRequestInputs();
    const requestLeafId = sm.appendMessage(assistant(requestCallId, "request_compaction", {}, contextTokens ?? 0));
    const requestResult = await tools.get("request_compaction").execute(requestCallId, {}, run.signal, undefined, ctx);
    assert.equal(requestResult.terminate, undefined);
    const layers = requestLayers();
    const request = createSessionAgentSummaryRequest({ requestId: requestResult.details.requestId, reason: "tool", now: Date.now(),
      targetTokens: layers.handoffTokens, handoffTokens: layers.handoffTokens, continuationTokens: layers.continuationTokens,
      requestToolCallId: requestCallId, scope: { sessionId: sm.getSessionId(), sessionFile: source, leafId: requestLeafId, epoch: 0,
        model: { provider: "fixture", id: "fixture", api: "openai-completions", thinkingLevel: "off" } } });
    sm.appendMessage({ role: "toolResult", toolCallId: requestCallId, toolName: "request_compaction", content: requestResult.content, details: requestResult.details, isError: false, timestamp: Date.now() });
    if (reference) referenceInterval = captureIntervalSource({ sessionId: sm.getSessionId(),
      branchEntries: sm.getBranch() as unknown as SessionEntryLike[], endEntryId: requestLeafId });
    // Public Pi 1.1 persists the native prompt/tool loadout before the next request.
    sm.appendMessage({ role: "system", content: "", sections: { tools: "Updated fixture tool definitions" }, timestamp: Date.now() } as unknown as Parameters<typeof sm.appendMessage>[0]);
    const view = () => ({ scope: { ...request.scope, leafId: sm.getLeafId()! }, now: Date.now(), getEntry: (id: string) => sm.getEntry(id) as SessionEntryLike | undefined });
    const messages = sm.buildSessionContext().messages;
    await hooks.get("context")!({ messages }, ctx);
    if (!previewMode) assert.equal((await status()).sessionSummary.state, "consumed");
    const consumed = reference ? consumeSessionAgentSummaryRequest(request, view(), messages) : undefined;
    const args = { requestId: request.requestId, handoff: summaryText, continuation: continuationText,
      relevanceHints: ["checksum", "isolated implementation"] };
    const message = assistant(submitCallId, "request_compaction", args);
    const submissionEntryId = sm.appendMessage(message);
    const result = await tools.get("request_compaction").execute(submitCallId, args, run.signal, undefined, ctx);
    assert.equal(result.terminate, true, "only a source-validated sole submission terminates");
    const accepted = consumed ? acceptSessionAgentSummary(consumed, parseSessionAgentSummarySubmission(args)!,
      { ...view(), toolCallId: submitCallId }) : undefined;
    const resultId = sm.appendMessage({ role: "toolResult", toolCallId: submitCallId, toolName: "request_compaction", content: result.content,
      details: result.details, isError: false, timestamp: Date.now() });
    if (accepted) referenceReady = settleSessionAgentSummary(accepted, view());
    let preview: ReturnType<typeof previewContext> | undefined;
    if (reference) {
      assert.ok(referenceReady);
      assert.ok(referenceInterval);
      const ready = referenceReady, beforeCapture = nativeReads;
      const captured = await captureContextCompilation(pi, {
        scope: { sessionId: sm.getSessionId(), leafId: sm.getLeafId()! }, sourceCutEntryId: referenceInterval.endEntryId,
        firstKeptEntryId: `retain-none:${request.requestId}`, nativeRetention: { kind: "none", operationId: request.requestId },
        memoryOwner: "context-kit", budget: captureIntervalRuntimeBudget(pi as unknown as ExtensionAPI, ctx),
        rawTail: { tokens: 0, messages: 0, toolPairSafe: true }, interval: referenceInterval,
        sessionSummary: { text: ready.submission.handoff, handoff: ready.submission.handoff, continuation: ready.submission.continuation,
          authorship: "current-agent", requestId: request.requestId, requestLeafId: requestLeafId,
          consumedBoundaryLeafId: ready.consumedBoundaryLeafId, submissionEntryId: submissionEntryId,
          submissionToolCallId: submitCallId, relevanceHints: ready.submission.relevanceHints },
      }, { getScope: () => ({ sessionId: sm.getSessionId(), leafId: sm.getLeafId()! }), epoch: () => 0, revalidate() {} });
      assert.equal(nativeReads, beforeCapture + 1, "one collection supplies both hints and the frozen native receipt");
      assert.equal(captured.history.kind, "interval");
      if (captured.history.kind !== "interval") throw new Error("Expected original interval");
      referenceRelevance = captured.history.relevance;
      assert.deepEqual(referenceRelevance.slice(0, 2), ["checksum", "isolated implementation"]);
      preview = previewContext(captured);
    }
    if (staleCapture) mutateDuringCollect = true;
    const beforeActiveCapture = nativeReads, sourceBeforeProposal = JSON.stringify(sm.getEntries());
    returned = await hooks.get("turn_end")!(turnBoundary(message, submissionEntryId, [resultId]), ctx);
    assert.equal(nativeReads, beforeActiveCapture + (previewMode ? 0 : 1), "public active capture must not rescan native state for its receipt");
    assert.equal(JSON.stringify(sm.getEntries()), sourceBeforeProposal, "a returned proposal does not mutate source");
    if (preview) {
      assert.equal(returned.entries[0].summary, preview.summary);
      assert.equal(returned.entries[0].details.contextReceipt.inputHash, preview.receipt.inputHash);
    }
    return { requestLeafId, submissionEntryId, resultId, proposal: returned };
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
    await deliverInput("Continue the isolated fixture within its existing scope.");
    const submitted = await submit("first", true);
    const unchanged = sm.getBranch().map(entry => [entry.id, JSON.stringify(entry)] as const);
    assert.equal(returned, submitted.proposal);
    assert.equal(returned.continue, true, "the original delivered task may continue after a verified commit");
    assert.equal((await status()).terminal.state, "returned");
    assert.equal((await status()).providerBarrier.state, "recovery-only");
    assert.equal(dispatched(), 0, "returning the public proposal cannot dispatch a continuation");
    assert.equal(sent.length, 0, "a public proposal appends no technical boundary or nested request");
    await commitProposal(returned);
    assert.equal(aborts, 0);
    assert.equal(schema, JSON.stringify(tools.get("request_compaction").parameters));
    assert.equal(sent.length, 0, "native continuation needs no idle message send");
    const compaction = returned.entries[0], receipt = compaction.details.contextReceipt;
    assert.equal(receipt.history.kind, "interval");
    assert.equal(compaction.details.summaryOperation.submissionResultEntryId, submitted.resultId);
    assert.equal(receipt.budget.rawTailMessages, receipt.restart.partition.exactMessages);
    assert.equal(receipt.budget.rawTailTokens, receipt.restart.partition.exactTokens);
    assert.equal(receipt.history.receipt.technicalBoundaryTokens, 0, "public retain-none has no technical boundary allowance");
    assert.equal(receipt.sourceCutEntryId, submitted.requestLeafId, "E is frozen before the generated summary exchange");
    assert.ok(!receipt.restart.exactTail.some((row: any) => [submitted.submissionEntryId, submitted.resultId].includes(row.entryId)));
    assert.equal(receipt.sessionSummary.requestLeafId, submitted.requestLeafId);
    assert.equal(receipt.sessionSummary.submissionEntryId, submitted.submissionEntryId);
    assert.equal(compaction.summary.split(summaryText).length, 2, "the submission is not duplicated in replay");
    assert.ok(compaction.summary.indexOf("# Current task handoff") < compaction.summary.indexOf("# Active interval synopsis"));
    assert.ok(compaction.summary.indexOf("# Active interval synopsis") < compaction.summary.indexOf("# Recent compressed history"));
    assert.equal(receipt.restart.continuation.text, continuationText);
    assert.equal(receipt.restart.continuation.authorship, "current-agent");
    assert.equal(compaction.summary.includes(continuationText), false, "the immediate continuation is separate from the stored summary");
    assert.equal(compaction.summary.includes("Atomic replacement"), false, "native state remains receipt-only");
    assert.equal(receipt.budget.nativeRenderedTokens, 0);
    const replayReceipt = receipt.history.receipt;
    assert.ok(referenceRelevance.includes("src/lighthouse.ts"));
    assert.ok(!referenceRelevance.some(term => term.includes("obsoletepipeline")), "closed native cards cannot create implicit hints");
    const rangeIds = [...replayReceipt.activePrefix.sourceEntryIds, ...replayReceipt.compressedHistory.sourceEntryIds,
      ...receipt.restart.exactTail.map((row: any) => row.entryId)];
    assert.deepEqual(rangeIds, referenceInterval!.events.map(row => row.entryId), "A, B and C cover the original interval once in source order");
    for (const id of [...nativeSourceIds, ...obsoleteSourceIds]) assert.ok(rangeIds.includes(id), "native hints do not erase original source coverage");
    for (const id of nativeSourceIds) assert.ok(compaction.summary.includes(`history_get entryId="${id}"`));
    assert.equal(compaction.summary.includes("currentFocus: src/lighthouse.ts"), false, "only source evidence, not a native card dump, enters chronology");
    for (const [id, bytes] of unchanged) assert.equal(JSON.stringify(sm.getEntry(id)), bytes);
    assert.equal((await status()).terminal.state, "committed");
    assert.equal((await status()).committedReceipt.compactionEntryId, committedId);
    assert.deepEqual((await status()).committedReceipt.recovery.args, { entryId: committedId });
    contextTokens = null;
    idle = false;
    const projected = await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    assert.ok(projected.messages.some((message: any) => message.customType === INTERVAL_CONTINUATION_MESSAGE && message.content.includes(continuationText)));
    assert.ok(!projected.messages.some((message: any) => message.customType === SESSION_AGENT_BOUNDARY_CUSTOM_TYPE));
    for (const row of receipt.restart.exactTail) assert.ok(projected.messages.some((message: any) => JSON.stringify(message) === JSON.stringify(row.projectedEntry.message)));
    const providerPayload = { messages: projected.messages, max_tokens: model.maxTokens };
    const boundedPayload = await hooks.get("before_provider_request")!({ payload: providerPayload }, ctx);
    assert.equal(boundedPayload.max_tokens, model.maxTokens);
    assert.equal(boundedPayload.messages, projected.messages);
    assert.equal(aborts, 0, "the first null-usage post-commit request uses the current projection");
    contextTokens = 12000;
    idle = true;

    // A new cycle derives pressure from the model, not the legacy token override.
    process.env.PI_CHRONO_TRIGGER_TOKENS = "12000";
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, 0, "legacy trigger tuning cannot force an interval summary");
    observeUsage(deriveIntervalBudget({ model, growthTokens: Math.ceil(SESSION_AGENT_SUMMARY_LIMITS.promptBytes / 4) }).noticeBoundTokens);
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, 1, "the next cycle can request at its current adaptive notice bound");
    assert.equal(sent.at(-1).message.customType, "chrono-session-agent-summary-request");
    await deliverInput("Cancel the next-cycle fixture");
    contextTokens = 12000;
    process.env.PI_CHRONO_TRIGGER_TOKENS = "200000";
    process.env.PI_CHRONO_MEMORY_OWNER = "chrono";
    await tools.get("history_recall").execute("recall-fixture", { query: "checksum" }, undefined, undefined, ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation.promotion, undefined);
    assert.ok(mirrors.every(row => row.type === INTERVAL_CONTINUATION_RECORD), "only code-owned continuation receipts are persisted");
    assert.equal((await status()).memoryOwner.reloadRequired, true);

    // Retry only after explicit new input. The real hook catches schema changes
    // during collection instead of substituting old fallback context.
    await deliverInput("Continue the isolated fixture.");
    await submit("stale", false, true);
    assert.equal(returned, undefined, "a stale public capture returns no compaction proposal");
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

    await deliverInput("Check summary tool readiness");
    summaryToolActive = false;
    const beforeUnavailable = sent.length;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    assert.equal((await status()).lastFailure.code, "session-agent-summary-tool-unavailable");
    assert.equal(sent.length, beforeUnavailable, "do not send a summary request with no callable submission tool");
    summaryToolActive = true;

    await deliverInput("Manual retry");
    const beforeSend = sent.length;
    idle = false;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
    await tick();
    assert.equal(sent.length, beforeSend, "native manual compaction cannot start a nested summary run");
    assert.equal((await status()).lastFailure.code, "session-agent-summary-active-run-unsupported");
    await deliverInput("Request manual compaction after the busy run stops");
    idle = true;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeSend + 1);
    assert.equal(sent.at(-1).message.customType, "chrono-session-agent-summary-request");
    await deliverInput("Cancel the summary");
    assert.equal((await status()).sessionSummary.state, "idle");
    const leaf = sm.getLeafId(), pausedCode = (await status()).lastFailure.code;
    assert.deepEqual(await hooks.get("session_before_compact")!(event("overflow"), ctx), { cancel: true });
    assert.equal((await status()).lastFailure.code, pausedCode, "a paused overflow preserves the blocker instead of attempting a fallback");
    assert.equal(sm.getLeafId(), leaf);
    assert.equal(sent.length, beforeSend + 1, "overflow did not start another model request");

    // Planning uses Pi's standard reserve, not the full registry output ceiling.
    // A planning threshold cannot refuse the summary-only response.
    await deliverInput("Check bounded summary headroom");
    const smallModel = { ...model };
    Object.assign(model, { contextWindow: 272000, maxTokens: 128000 });
    const modelBefore = JSON.stringify(model), layers = requestLayers();
    assert.equal(layers.reserveTokens, Math.min(model.maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens));
    assert.ok(layers.safetyTokens >= 1024);
    const prompt = renderSessionAgentSummaryRequest(createSessionAgentSummaryRequest({ requestId: "0".repeat(36), reason: "tool", now: Date.now(),
      scope: { sessionId: sm.getSessionId(), sessionFile: source, leafId: sm.getLeafId()!, epoch: 0,
        model: { provider: model.provider, id: model.id, api: model.api, thinkingLevel: "off" } },
      targetTokens: layers.handoffTokens, handoffTokens: layers.handoffTokens, continuationTokens: layers.continuationTokens }));
    const promptTokens = Math.ceil(prompt.length / 4);
    const admissionLimit = layers.requestBoundTokens - promptTokens - 32;
    contextTokens = admissionLimit - 1;
    idle = false;
    recordRequestInputs();
    sm.appendMessage(assistant("bounded-request", "request_compaction", {}, contextTokens));
    const admitted = await tools.get("request_compaction").execute("bounded-request", {}, run.signal, undefined, ctx);
    assert.equal(admitted.details.status, "summary-requested");
    assert.equal(Math.ceil(admitted.content[0].text.length / 4), promptTokens);
    assert.match(admitted.content[0].text, /Include the information needed to continue safely, and no more\./);
    assert.match(admitted.content[0].text, /handoff.*continuation/);
    assert.doesNotMatch(admitted.content[0].text, /Target about|soft length guide|estimated tokens/);
    assert.equal(JSON.stringify(model), modelBefore);
    await deliverInput("Check summary admission above the planning boundary");
    contextTokens = model.contextWindow + 1;
    recordRequestInputs();
    sm.appendMessage(assistant("pressure-request", "request_compaction", {}, contextTokens));
    const beforePressureRequest = sent.length, beforePressureLeaf = sm.getLeafId();
    const pressureRequest = await tools.get("request_compaction").execute("pressure-request", {}, run.signal, undefined, ctx);
    assert.equal(pressureRequest.terminate, undefined);
    assert.equal(pressureRequest.isError, undefined);
    assert.equal(pressureRequest.details.status, "summary-requested");
    assert.equal((await status()).providerBarrier.state, "summary-only");
    assert.equal(sent.length, beforePressureRequest);
    assert.equal(sm.getLeafId(), beforePressureLeaf);

    const recover = async (suffix: string) => {
      await deliverInput("Recover only through a fresh summary");
      const retryPaused = (await status()).providerBarrier.retryPaused;
      contextTokens = 12000;
      const beforeDispatch = dispatched(), sourceBeforeCommit = sm.getBranch().map(entry => [entry.id, JSON.stringify(entry)] as const);
      await submit(suffix);
      if (retryPaused) assert.equal((await status()).providerBarrier.retryPaused, true, "submission does not release the failure latch");
      assert.equal((await status()).providerBarrier.state, "recovery-only");
      assert.equal(dispatched(), beforeDispatch, "an accepted proposal is not a continuation dispatch");
      await commitProposal(returned);
      for (const [id, bytes] of sourceBeforeCommit) assert.equal(JSON.stringify(sm.getEntry(id)), bytes);
      assert.equal((await status()).providerBarrier.state, "open");
    };
    actionableResume = true;
    await recover("actionable-metadata-resume");
    actionableResume = false;
    interruptResume = true;
    const resumesBeforeContextChange = dispatched();
    await recover("context-change-refuses-resume");
    assert.equal(dispatched(), resumesBeforeContextChange, "a context-producing child must invalidate the dispatch intent");
    interruptResume = false;
    await recover("recovery-before-timing");
    const pressureBudget = deriveIntervalBudget({ model, growthTokens: Math.ceil(SESSION_AGENT_SUMMARY_LIMITS.promptBytes / 4) });
    assert.equal(classifyPressure({ model, currentRequestTokens: pressureBudget.noticeBoundTokens - 1,
      growthTokens: pressureBudget.growthTokens }).status, "normal");
    const beforeTiming = sent.length;
    process.env.PI_CHRONO_TRIGGER_TOKENS = "1"; // Legacy tuning cannot force interval compaction.
    observeUsage(pressureBudget.noticeBoundTokens - 1);
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeTiming, "no automatic request below the adaptive notice bound");
    contextTokens = pressureBudget.noticeBoundTokens;
    idle = false;
    const ordinaryTurn = (id: string, totalTokens = contextTokens ?? 0) => {
      recordRequestInputs();
      const message = assistant(id, "read", { path: "fixture" }, totalTokens);
      const messageEntryId = sm.appendMessage(message);
      const resultId = sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", isError: false,
        content: [{ type: "text", text: "Bounded preparation evidence." }], timestamp: Date.now() });
      return turnBoundary(message, messageEntryId, [resultId]);
    };
    const turn = ordinaryTurn("timing");
    assert.equal(await hooks.get("turn_end")!(turn, ctx), undefined);
    assert.equal(sent.length, beforeTiming + 1, "the first boundary supplies one advance notice");
    assert.deepEqual(sent.at(-1).options, { deliverAs: "steer" });
    const freeze = await hooks.get("turn_end")!(ordinaryTurn("preparation-response"), ctx);
    assert.equal(freeze.continue, true);
    assert.equal(freeze.entries.length, 1);
    assert.equal(freeze.entries[0].type, "custom_message");
    assert.equal(freeze.entries[0].customType, "chrono-session-agent-summary-request");
    assert.equal(sent.length, beforeTiming + 1, "public boundary proposals do not send a nested request");
    const requestMessage = freeze.entries[0];
    sm.appendCustomMessageEntry(requestMessage.customType, requestMessage.content, requestMessage.display, requestMessage.details);
    contextTokens = 12000;
    await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    await hooks.get("turn_end")!(ordinaryTurn("missing-submission"), ctx);
    assert.equal((await status()).lastFailure.code, "session-agent-summary-submission-unavailable");
    assert.equal(sent.length, beforeTiming + 1, "an unusable response cannot silently retry");

    // A smaller supported model derives its own idle notice bound.
    await recover("recovery-before-headroom");
    Object.assign(model, { contextWindow: 64000, maxTokens: 2000 });
    const smaller = deriveIntervalBudget({ model, growthTokens: Math.ceil(SESSION_AGENT_SUMMARY_LIMITS.promptBytes / 4) });
    assert.ok(smaller.available);
    const beforeHeadroomTrigger = sent.length;
    observeUsage(smaller.noticeBoundTokens - 1);
    idle = true;
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeHeadroomTrigger);
    observeUsage(smaller.noticeBoundTokens);
    await hooks.get("agent_settled")!({}, ctx);
    await tick();
    assert.equal(sent.length, beforeHeadroomTrigger + 1);
    assert.deepEqual(sent.at(-1).options, { triggerTurn: true });
    await recover("recovery-before-output-exhaustion");
    Object.assign(model, { contextWindow: 2000, maxTokens: 2000 });
    assert.equal(deriveIntervalBudget({ model }).available, false, "a small context still refuses an exhausted planning reserve");
    const beforeOutputRefusal = sent.length, beforeOutputSource = JSON.stringify(sm.getEntries());
    await hooks.get("agent_settled")!({}, ctx);
    assert.equal((await status()).providerBarrier.state, "paused");
    assert.equal(sent.length, beforeOutputRefusal);
    assert.equal(JSON.stringify(sm.getEntries()), beforeOutputSource);
    Object.assign(model, { contextWindow: 64000, maxTokens: 2000 });
    await recover("recovery-before-overshoot");
    const beforeOvershoot = sent.length;
    idle = false;
    contextTokens = 100; // The newer same-model observation must still win.
    const overshoot = ordinaryTurn("overshoot", smaller.freezeBoundTokens + 1);
    const beforeOvershootSource = JSON.stringify(sm.getEntries());
    const summaryProposal = await hooks.get("turn_end")!(overshoot, ctx);
    assert.equal(summaryProposal.continue, true);
    assert.equal(summaryProposal.entries.length, 1);
    assert.equal(summaryProposal.entries[0].customType, "chrono-session-agent-summary-request");
    assert.equal((await status()).providerBarrier.state, "summary-only");
    assert.equal(sent.length, beforeOvershoot, "a pressure boundary proposes the summary without a nested send");
    assert.equal(JSON.stringify(sm.getEntries()), beforeOvershootSource, "a returned summary proposal does not mutate source");
    Object.assign(model, smallModel);
    contextTokens = 12000;

    // An idle manual request after final output may summarize, but its own
    // submission toolUse must not authorize an ordinary continuation.
    await deliverInput("Check idle manual compaction");
    recordRequestInputs();
    sm.appendMessage({ ...assistant("completed", "read", {}, contextTokens), content: [{ type: "text", text: "The authorized fixture work is complete." }], stopReason: "stop" });
    idle = true;
    const resumesBeforeIdleManual = dispatched();
    const commitsBeforeIdleManual = sm.getBranch().filter(entry => entry.type === "compaction").length;
    assert.deepEqual(await hooks.get("session_before_compact")!(event(), ctx), { cancel: true });
    await hooks.get("session_compact_failed")!({ reason: "manual", aborted: true, willRetry: false }, ctx);
    await tick();
    assert.equal(sent.at(-1).message.customType, "chrono-session-agent-summary-request");
    const idleManualRequestId = (await status()).sessionSummary.requestId;
    idle = false;
    await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
    const idleManualArgs = { requestId: idleManualRequestId, handoff: "The authorized fixture work is complete.",
      continuation: "Remain idle. No further task is authorized." };
    const idleManualMessage = assistant("idle-manual-submit", "request_compaction", idleManualArgs);
    const idleManualEntryId = sm.appendMessage(idleManualMessage);
    const idleManualResult = await tools.get("request_compaction").execute("idle-manual-submit", idleManualArgs, run.signal, undefined, ctx);
    assert.equal(idleManualResult.terminate, true);
    const idleManualResultId = sm.appendMessage({ role: "toolResult", toolCallId: "idle-manual-submit", toolName: "request_compaction", content: idleManualResult.content,
      details: idleManualResult.details, isError: false, timestamp: Date.now() });
    const idleManualProposal = await hooks.get("turn_end")!(turnBoundary(idleManualMessage, idleManualEntryId, [idleManualResultId]), ctx);
    assert.equal(idleManualProposal.continue, false, "summary submission does not reopen a completed task");
    await commitProposal(idleManualProposal);
    assert.equal((await status()).terminal.state, "committed");
    assert.equal((await status()).providerBarrier.state, "open");
    assert.equal(sm.getBranch().filter(entry => entry.type === "compaction").length, commitsBeforeIdleManual + 1);
    assert.equal(dispatched(), resumesBeforeIdleManual, "completed idle manual compaction must not resume the original task");

    // Load the private preview option through the same registration. Synthetic
    // assistant entries exercise dispatch, not model-written summary evidence.
    await hooks.get("session_shutdown")!({}, ctx);
    hooks.clear(); tools.clear(); sent.length = 0; requests.length = 0;
    previewMode = true;
    const compactCallsBefore = compactCalls, commandsBefore = commands, flagsBefore = flags;
    const privateFilesBefore = readdirSync(directory, { recursive: true }), privateMirrorsBefore = mirrors.length;
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
          assert.equal(capture.ready.submission.handoff, summaryText);
          assert.equal(capture.ready.submission.continuation, continuationText);
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
      "session_shutdown", "before_agent_start", "turn_end", "agent_before_settle", "agent_settled"]) await hooks.get(hook)!({}, noLifecycleWork);
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
    assert.equal(previewCapture.compiled.receipt.sourceCutEntryId, previewSubmitted.requestLeafId);
    assert.equal(previewCapture.input.memoryOwner, "context-kit");
    assert.equal(previewCapture.input.budget.responseReserveTokens, model.maxTokens);
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
    assert.equal(mirrors.length, privateMirrorsBefore, "private preview persists no continuation or owner records");
    assert.deepEqual(previewErrors, []);
    assert.deepEqual(readdirSync(directory, { recursive: true }), privateFilesBefore, "candidate created no store, runtime or background files");
  } finally {
    remove(); removePlan();
    await hooks.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("interval admission uses native Pi context accounting without reinterpreting provider JSON", async () => {
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
    { name: "opaque-only", native: 100000, opaque: 1020000 },
    { name: "conversation", native: 100000, opaque: 1020000 },
    { name: "instructions", native: 100000, opaque: 1020000 },
    { name: "schemas", native: 100000, opaque: 1020000 },
    { name: "post-commit-null", native: null, opaque: 0 },
    { name: "null-opaque-fallback", native: null, opaque: 1020000 },
    { name: "unknown-api-fallback", native: 100000, opaque: 1020000 },
    { name: "invalid-native", native: 100000, opaque: 0 },
    { name: "malformed-opaque", native: 100000, opaque: 0 },
  ];
  try {
    for (const fixture of cases) {
      const hooks = new Map<string, (event: any, ctx: any) => any>(), tools = new Map<string, any>();
      const sm = SessionManager.inMemory(directory);
      sm.appendMessage({ role: "user", content: "The same small visible conversation.", timestamp: 1 });
      if (fixture.native !== null) sm.appendMessage({ role: "assistant", api: "openai-codex-responses",
        provider: "openai-codex", model: "fixture", stopReason: "stop", timestamp: 2,
        content: [{ type: "text", text: "Bounded source usage observation." }],
        usage: { input: fixture.native, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: fixture.native,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      let aborts = 0;
      const nativeTokens = fixture.name === "invalid-native" ? NaN : fixture.native;
      const pi = { events: createEventBus(), getActiveTools: () => ["request_compaction"], getAllTools: () => [...tools.values()],
        registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerFlag() {},
        on: (name: string, handler: any) => hooks.set(name, handler),
        appendEntry() { throw new Error("Unexpected source write"); }, sendMessage() { throw new Error("Unexpected message send"); } };
      const ctx = { sessionManager: sm,
        model: { provider: "openai-codex", id: "fixture", api: fixture.name === "unknown-api-fallback" ? "unknown-api" : "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api", input: ["text" as const],
          contextWindow: 272000, maxTokens: 128000 }, thinkingLevel: "off", hasUI: false, ui: { notify() {} },
        isIdle: () => false, hasPendingMessages: () => false, abort: () => { aborts++; },
        getSystemPrompt: () => "Offline bounded fixture.", getContextUsage: () => ({ contextWindow: 272000, tokens: nativeTokens }) };
      extension(pi as unknown as ExtensionAPI, { schedulerDirectory: directory });
      try {
        const source = JSON.stringify(sm.getEntries());
        await hooks.get("context")!({ messages: sm.buildSessionContext().messages }, ctx);
        assert.equal(aborts, 0, `${fixture.name}: Pi-owned context admission`);
        const payload = { model: "fixture", instructions: "Offline bounded fixture.",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "The same small visible conversation." }] },
            { type: "reasoning", summary: [], encrypted_content: "A".repeat(fixture.opaque) }], tools: [] } as any;
        if (fixture.native !== null) payload.input.push({ type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Bounded source usage observation." }] });
        if (fixture.name === "conversation") payload.input[0].content[0].text += "V".repeat(320000);
        if (fixture.name === "instructions") payload.instructions += "V".repeat(320000);
        if (fixture.name === "schemas") payload.tools.push({ type: "function", name: "read", description: "V".repeat(320000), parameters: { type: "object" } });
        if (fixture.name === "malformed-opaque") payload.input[1].encrypted_content = { unknown: "transport" };
        const serialized = JSON.stringify(payload), event = { payload };
        assert.equal(await hooks.get("before_provider_request")!(event, ctx), undefined);
        assert.equal(event.payload, payload, "the accounting view never replaces the request");
        assert.equal(JSON.stringify(payload), serialized, "the original opaque replay and visible fields remain unchanged");
        assert.equal(JSON.stringify(sm.getEntries()), source, "admission does not rewrite source");
        const composition = (await tools.get("history_status").execute()).details.composition;
        assert.equal(aborts, 0, `${fixture.name}: the payload hook does not estimate provider JSON`);
        assert.equal(composition.providerBarrier.state, "open", fixture.name);
      } finally { await hooks.get("session_shutdown")!({}, ctx); }
    }
  } finally {
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
