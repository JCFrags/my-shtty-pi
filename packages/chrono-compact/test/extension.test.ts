import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { resolveExtensionSettings } from "../src/pi-extension.js";
import { getActiveBranch, readSessionJsonl } from "../src/jsonl.js";
import { candidateSegmentStorePath } from "../src/candidate-segment-store.js";
import { sourceLedgerPath, updateSourceLedger } from "../src/source-ledger.js";
import { rollupShadowSidecarPath } from "../src/history-rollup-shadow.js";

type Hook = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: Record<string, unknown>) => unknown | Promise<unknown>;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function setUniqueHook(hooks: Map<string, Hook>, name: string, handler: Hook): void {
  if (hooks.has(name)) throw new Error(`Test hook mock refused duplicate handler for ${name}.`);
  hooks.set(name, handler);
}

test("experimental high-impact features default off and environment overrides have precedence", () => {
  const previous = {
    editor: process.env.PI_CHRONO_HISTORY_EDITOR,
    incremental: process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE,
    projection: process.env.PI_CHRONO_TOOL_RESULT_PROJECTION,
    worker: process.env.PI_CHRONO_ISOLATED_WORKER,
    shadow: process.env.PI_CHRONO_ROLLUP_SHADOW,
  };
  try {
    delete process.env.PI_CHRONO_HISTORY_EDITOR;
    delete process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE;
    delete process.env.PI_CHRONO_TOOL_RESULT_PROJECTION;
    delete process.env.PI_CHRONO_ISOLATED_WORKER;
    delete process.env.PI_CHRONO_ROLLUP_SHADOW;
    assert.equal(resolveExtensionSettings().historyEditorEnabled, false);
    assert.equal(resolveExtensionSettings().incrementalPrecomputeEnabled, false);
    assert.equal(resolveExtensionSettings().toolResultProjectionMode, "off");
    assert.equal(resolveExtensionSettings().isolatedWorkerEnabled, false);
    assert.equal(resolveExtensionSettings().rollupShadowEnabled, false);
    assert.equal(resolveExtensionSettings().hostWorkerSlots, 1);
    assert.equal(resolveExtensionSettings().workerNiceLevel, 10);
    assert.equal(resolveExtensionSettings({ historyEditorEnabled: true }).historyEditorEnabled, false);
    assert.equal(resolveExtensionSettings({ historyEditorEnabled: true }).legacyHistoryEditorEnabled, true);
    assert.equal(resolveExtensionSettings().valueWorker.mode, "off");
    assert.equal(resolveExtensionSettings({ incrementalPrecomputeEnabled: true }).incrementalPrecomputeEnabled, true);
    assert.equal(resolveExtensionSettings({ toolResultProjectionMode: "safe" }).toolResultProjectionMode, "safe");
    const separateSettings = resolveExtensionSettings({ hybridSummaryEnabled: true, historyEditorEnabled: false });
    assert.equal(separateSettings.hybridSummaryEnabled, true);
    assert.equal(separateSettings.historyEditorEnabled, false);
    process.env.PI_CHRONO_HISTORY_EDITOR = "false";
    assert.equal(resolveExtensionSettings({ historyEditorEnabled: true }).historyEditorEnabled, false);
    process.env.PI_CHRONO_HISTORY_EDITOR = "true";
    assert.equal(resolveExtensionSettings({ historyEditorEnabled: false }).historyEditorEnabled, false);
    assert.equal(resolveExtensionSettings({ historyEditorEnabled: false }).legacyHistoryEditorEnabled, true);
    process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE = "false";
    assert.equal(resolveExtensionSettings({ incrementalPrecomputeEnabled: true }).incrementalPrecomputeEnabled, false);
    process.env.PI_CHRONO_ISOLATED_WORKER = "true";
    assert.equal(resolveExtensionSettings({ isolatedWorkerEnabled: false }).isolatedWorkerEnabled, true);
    process.env.PI_CHRONO_ROLLUP_SHADOW = "true";
    assert.equal(resolveExtensionSettings({ rollupShadowEnabled: false }).rollupShadowEnabled, true);
    process.env.PI_CHRONO_TOOL_RESULT_PROJECTION = "aggressive";
    assert.equal(resolveExtensionSettings({ toolResultProjectionMode: "off" }).toolResultProjectionMode, "aggressive");
  } finally {
    if (previous.editor === undefined) delete process.env.PI_CHRONO_HISTORY_EDITOR;
    else process.env.PI_CHRONO_HISTORY_EDITOR = previous.editor;
    if (previous.incremental === undefined) delete process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE;
    else process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE = previous.incremental;
    if (previous.worker === undefined) delete process.env.PI_CHRONO_ISOLATED_WORKER;
    else process.env.PI_CHRONO_ISOLATED_WORKER = previous.worker;
    if (previous.shadow === undefined) delete process.env.PI_CHRONO_ROLLUP_SHADOW;
    else process.env.PI_CHRONO_ROLLUP_SHADOW = previous.shadow;
    if (previous.projection === undefined) delete process.env.PI_CHRONO_TOOL_RESULT_PROJECTION;
    else process.env.PI_CHRONO_TOOL_RESULT_PROJECTION = previous.projection;
  }
});

test("incremental lifecycle schedules, validates, falls back when stale, cancels, and resets", async () => {
  const names = [
    "PI_CHRONO_CONFIG_PATH",
    "PI_CHRONO_INCREMENTAL_PRECOMPUTE",
    "PI_CHRONO_TOOL_RESULT_PROJECTION",
    "PI_CHRONO_PI_SUMMARY",
    "PI_CHRONO_HISTORY_EDITOR",
    "PI_CHRONO_CACHE",
    "PI_CHRONO_RAW_TAIL",
    "PI_CHRONO_TRIGGER_TOKENS",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const directory = mkdtempSync(join(tmpdir(), "chrono-incremental-extension-"));
  const configPath = join(directory, "config.json");
  const sessionPath = join(directory, "session.jsonl");
  const incrementalPath = join(candidateSegmentStorePath(sessionPath), "manifest.json");
  const sourceSessionBytes = readFileSync(resolve("test/fixtures/session.jsonl"));
  writeFileSync(sessionPath, sourceSessionBytes, { mode: 0o600 });
  writeFileSync(configPath, `${JSON.stringify({ incrementalPrecomputeEnabled: true })}\n`, { mode: 0o600 });
  process.env.PI_CHRONO_CONFIG_PATH = configPath;
  delete process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE;
  process.env.PI_CHRONO_TOOL_RESULT_PROJECTION = "off";
  process.env.PI_CHRONO_PI_SUMMARY = "false";
  process.env.PI_CHRONO_HISTORY_EDITOR = "false";
  process.env.PI_CHRONO_CACHE = "false";
  delete process.env.PI_CHRONO_RAW_TAIL;
  process.env.PI_CHRONO_TRIGGER_TOKENS = "10000";

  try {
    const hooks = new Map<string, Hook[]>();
    const pi = {
      registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
      on(name: string, handler: Hook) {
        const handlers = hooks.get(name) ?? [];
        handlers.push(handler);
        hooks.set(name, handlers);
      },
    };
    extension(pi as unknown as ExtensionAPI);
    const invokeHooks = async (name: string, event: Record<string, unknown>, hookContext: Record<string, unknown>): Promise<unknown> => {
      let returned: unknown;
      for (const handler of hooks.get(name) ?? []) {
        const value = await handler(event, hookContext);
        if (value !== undefined) returned = value;
      }
      return returned;
    };
    const session = await readSessionJsonl(resolve("test/fixtures/session.jsonl"));
    const branch = getActiveBranch(session);
    const notifications: string[] = [];
    let compactCount = 0;
    const context = {
      hasUI: true,
      getContextUsage: () => ({ tokens: 12_000, contextWindow: 300_000, percent: 4 }),
      compact(options: { onComplete?: (result: unknown) => void }) {
        compactCount += 1;
        options.onComplete?.({});
      },
      sessionManager: {
        getSessionFile: () => sessionPath,
        getEntries: () => branch,
        getBranch: () => branch,
      },
      ui: { notify(message: string) { notifications.push(message); } },
      modelRegistry: {},
    };
    assert.ok((hooks.get("agent_settled")?.length ?? 0) > 0);
    assert.ok((hooks.get("session_before_compact")?.length ?? 0) > 0);
    assert.ok((hooks.get("session_before_switch")?.length ?? 0) > 0);
    assert.ok((hooks.get("session_start")?.length ?? 0) > 0);
    assert.ok((hooks.get("session_shutdown")?.length ?? 0) > 0);

    await invokeHooks("agent_settled", {}, context);
    await waitFor(() => existsSync(incrementalPath));
    const checkpoint = JSON.parse(readFileSync(incrementalPath, "utf8")) as { segments: unknown[] };
    assert.ok(checkpoint);
    assert.ok(checkpoint.segments.length > 0);
    assert.equal(statSync(incrementalPath).mode & 0o777, 0o600);
    assert.equal(compactCount, 1, "the merged agent_settled hook must schedule incremental work and run trigger duty");

    const compact = async (branchEntries: Array<Record<string, unknown>>) => invokeHooks("session_before_compact", {
      branchEntries,
      preparation: { firstKeptEntryId: "e133", tokensBefore: 16_000 },
      customInstructions: "Preserve the public API restriction and activeRequests assertion.",
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    }, context) as Promise<{
      compaction?: { details?: { incrementalPrecompute?: { state?: string; reason?: string; cachedCandidates?: number; background?: { state?: string } } } };
    }>;

    const warm = await compact(branch as Array<Record<string, unknown>>);
    assert.ok(warm.compaction, notifications.join("\n"));
    assert.equal(warm.compaction.details?.incrementalPrecompute?.state, "validated-hit", JSON.stringify(warm.compaction.details?.incrementalPrecompute));
    assert.ok((warm.compaction.details?.incrementalPrecompute?.cachedCandidates ?? 0) > 0);
    assert.equal(warm.compaction.details?.incrementalPrecompute?.background?.state, "ready");

    const staleBranch = JSON.parse(JSON.stringify(branch)) as Array<Record<string, unknown>>;
    const firstMessage = staleBranch[0]?.message as Record<string, unknown> | undefined;
    assert.ok(firstMessage);
    staleBranch[0] = { ...staleBranch[0], message: { ...firstMessage, content: "Adversarial source rewrite with the same entry ID." } };
    const stale = await compact(staleBranch);
    assert.ok(stale.compaction, notifications.join("\n"));
    assert.equal(stale.compaction.details?.incrementalPrecompute?.state, "validated-hit", "record integrity is checked against each changed block during compaction");

    await invokeHooks("agent_settled", {}, context);
    await invokeHooks("session_before_switch", {}, context);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    assert.equal(existsSync(incrementalPath), true, "session replacement must preserve the last complete immutable store");

    await invokeHooks("session_start", {}, context);
    await waitFor(() => existsSync(incrementalPath));
    assert.ok(JSON.parse(readFileSync(incrementalPath, "utf8")), "session start must schedule or reuse a complete segmented store");
    await invokeHooks("session_shutdown", {}, context);
    process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE = "false";
    rmSync(candidateSegmentStorePath(sessionPath), { recursive: true, force: true }); rmSync(sourceLedgerPath(sessionPath), { force: true });
    await invokeHooks("agent_settled", {}, context); await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    assert.equal(existsSync(candidateSegmentStorePath(sessionPath)), false, "feature-off must not create a candidate store");
    assert.equal(existsSync(sourceLedgerPath(sessionPath)), false, "feature-off must not create a source ledger");
    assert.deepEqual(readFileSync(sessionPath), sourceSessionBytes, "incremental work must not rewrite the authoritative session");
    assert.ok(notifications.some((message) => /ChronoCompact 2\.0\.0 candidate/.test(message)));
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("request-local projection integrates with the context hook and fails closed on binding mismatch", async () => {
  const names = ["PI_CHRONO_CONFIG_PATH", "PI_CHRONO_TOOL_RESULT_PROJECTION"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const directory = mkdtempSync(join(tmpdir(), "chrono-projection-extension-"));
  const configPath = join(directory, "config.json");
  process.env.PI_CHRONO_CONFIG_PATH = configPath;
  process.env.PI_CHRONO_TOOL_RESULT_PROJECTION = "safe";
  try {
    const hooks = new Map<string, Hook>();
    const pi = {
      registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
      on(name: string, handler: Hook) { setUniqueHook(hooks, name, handler); },
    };
    extension(pi as unknown as ExtensionAPI);
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "Inspect the result set." }];
    for (let index = 0; index < 5; index += 1) {
      const callId = `projection-call-${index}`;
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "grep", arguments: { pattern: "stable", path: "src" } }],
      });
      messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: "grep",
        isError: false,
        details: { matchCount: 180 },
        content: [{
          type: "text",
          text: Array.from({ length: 180 }, (_, line) => `src/file-${index}-${line}.ts:${line + 1}: stable match`).join("\n"),
        }],
      });
    }
    const branch = messages.map((message, index) => ({
      type: "message",
      id: `projection-entry-${index}`,
      parentId: index === 0 ? null : `projection-entry-${index - 1}`,
      message,
    }));
    const hook = hooks.get("context");
    assert.ok(hook);
    const context = { sessionManager: { getBranch: () => branch } };
    const first = await hook({ messages }, context);
    assert.equal(first, undefined, "first model consumption must remain exact");
    const second = await hook({ messages }, context) as { messages?: Array<Record<string, unknown>> } | undefined;
    assert.ok(second?.messages);
    assert.notEqual(second.messages, messages);
    assert.equal(JSON.stringify(second.messages).includes("request-local tool-result projection"), true);

    const mismatched = structuredClone(messages);
    const firstResult = mismatched.find((message) => message.role === "toolResult");
    assert.ok(firstResult);
    firstResult.details = { matchCount: 0 };
    assert.equal(await hook({ messages: mismatched }, context), undefined, "binding uncertainty must keep all messages unchanged");
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi extension hook returns a validated deterministic replay through the normal test suite", async () => {
  const hooks = new Map<string, Hook>();
  const toolNames: string[] = [];
  const commandNames: string[] = [];
  const commandHandlers = new Map<string, CommandHandler>();
  const sentMessages: Array<{ customType: string; content: string; triggerTurn?: boolean }> = [];
  const configPath = join(tmpdir(), `chrono-extension-${process.pid}.json`);
  const previousConfigPath = process.env.PI_CHRONO_CONFIG_PATH;
  process.env.PI_CHRONO_CONFIG_PATH = configPath;
  const pi = {
    registerTool(tool: { name: string }) {
      toolNames.push(tool.name);
    },
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      commandNames.push(name);
      commandHandlers.set(name, definition.handler);
    },
    on(name: string, handler: Hook) {
      setUniqueHook(hooks, name, handler);
    },
    appendEntry() {},
    sendMessage(message: { customType: string; content: string }, options?: { triggerTurn?: boolean }) {
      sentMessages.push({ ...message, triggerTurn: options?.triggerTurn });
    },
  };
  extension(pi as unknown as ExtensionAPI);
  if (previousConfigPath === undefined) delete process.env.PI_CHRONO_CONFIG_PATH;
  else process.env.PI_CHRONO_CONFIG_PATH = previousConfigPath;

  assert.deepEqual(toolNames, [
    "history_get",
    "history_search",
    "history_recall",
    "history_range",
    "memory_remember",
    "memory_update",
    "memory_forget",
    "memory_promote",
    "memory_list",
    "memory_get",
    "memory_search",
    "history_retention_hint",
    "request_compaction",
  ]);
  assert.deepEqual(commandNames, ["chrono-rollup-shadow-status", "chrono-value-worker-status", "chrono-value-worker-reset", "chrono-compact-settings"]);
  assert.ok(hooks.has("context"));
  assert.ok(hooks.has("session_start"));
  assert.ok(hooks.has("session_shutdown"));
  assert.ok(hooks.has("turn_end"));
  assert.ok(hooks.has("agent_settled"));
  assert.ok(hooks.has("session_before_compact"));
  assert.ok(hooks.has("session_compact"));

  const session = await readSessionJsonl(resolve("test/fixtures/session.jsonl"));
  const branch = getActiveBranch(session);
  const notifications: Array<{ message: string; level: string }> = [];
  let currentContextTokens = 100_000;
  let abortCount = 0;
  let compactCount = 0;
  const context = {
    hasUI: true,
    model: { contextWindow: 272_000 },
    getContextUsage: () => ({ tokens: currentContextTokens, contextWindow: 272_000, percent: (currentContextTokens / 272_000) * 100 }),
    isIdle: () => false,
    abort: () => {
      abortCount += 1;
    },
    compact: (options?: { onComplete?: (result: unknown) => void }) => {
      compactCount += 1;
      options?.onComplete?.({});
    },
    sessionManager: {
      getSessionFile: () => undefined,
      getEntries: () => branch,
      getBranch: () => branch,
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async select(title: string, choices: string[]) {
        if (title === "ChronoCompact settings") {
          return choices.find((choice) => choice.startsWith("Raw history retained")) ?? "Save and close";
        }
        if (title === "How much recent history should remain raw?") return "Short · 8,000 tokens";
        return undefined;
      },
    },
    modelRegistry: {},
  };
  const turnEnd = hooks.get("turn_end");
  assert.ok(turnEnd);
  currentContextTokens = 210_000;
  await turnEnd({ message: { role: "assistant", usage: { totalTokens: currentContextTokens } } }, context);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]?.content ?? "", /natural checkpoint/);

  currentContextTokens = 260_000;
  await turnEnd({ message: { role: "assistant", usage: { totalTokens: currentContextTokens } } }, context);
  assert.equal(abortCount, 1);
  const settled = hooks.get("agent_settled");
  assert.ok(settled);
  await settled({}, context);
  assert.equal(compactCount, 1);

  const hook = hooks.get("session_before_compact");
  assert.ok(hook);
  const rawResult = await hook(
    {
      branchEntries: branch,
      preparation: { firstKeptEntryId: "e133", tokensBefore: 16_000 },
      customInstructions: "Preserve the public API restriction and activeRequests assertion.",
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    context,
  );
  const result = rawResult as {
    compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: Record<string, unknown> };
  };
  assert.ok(result.compaction);
  assert.equal(result.compaction.firstKeptEntryId, "e123", "dynamic V1.1 tail selection replaces Pi's larger default tail");
  assert.equal(result.compaction.tokensBefore, 16_000);
  assert.match(result.compaction.summary, /without changing the public API/);
  const retainedTail = JSON.stringify(branch.slice(branch.findIndex((entry) => entry.id === result.compaction?.firstKeptEntryId)));
  assert.doesNotMatch(result.compaction.summary, /expected activeRequests=1/, "the replay stops before the exact raw tail");
  assert.match(retainedTail, /expected activeRequests=1/);
  assert.match(retainedTail, /received activeRequests=3/);
  assert.doesNotMatch(result.compaction.summary, /FABRICATED_SUMMARY_SHOULD_NEVER_BE_RECOMPACTED/);
  assert.ok(notifications.some((notification) => /ChronoCompact/.test(notification.message)));

  let settingsMenuVisits = 0;
  (context.ui as { input?: () => Promise<string | undefined> }).input = async () => undefined;
  context.ui.select = async (title: string, choices: string[]) => {
    if (title === "ChronoCompact settings") {
      settingsMenuVisits += 1;
      if (settingsMenuVisits === 1) return choices.find((choice) => choice.startsWith("Background value worker"));
      if (settingsMenuVisits === 2) return choices.find((choice) => choice.startsWith("Hierarchical rollup shadow evaluation"));
      if (settingsMenuVisits === 3) return choices.find((choice) => choice.startsWith("Raw history retained"));
      return "Save and close";
    }
    if (title === "Background value-worker mode") return "shadow";
    if (title === "Value-model thinking level") return "inherit";
    if (title === "Hierarchical rollup shadow evaluation") return "Enabled";
    if (title === "How much recent history should remain raw?") return "Short · 8,000 tokens";
    return undefined;
  };
  const configure = commandHandlers.get("chrono-compact-settings");
  assert.ok(configure);
  await configure("", context);
  const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.rawTail, "short");
  assert.equal(persisted.valueWorkerMode, "shadow");
  assert.equal(persisted.rollupShadowEnabled, true);
  assert.ok(notifications.some((notification) => /Background value worker: shadow/.test(notification.message)));
  rmSync(configPath, { force: true });
});

test("default-off and explicitly disabled classifier paths make zero classifier provider calls", async () => {
  const previous = {
    config: process.env.PI_CHRONO_CONFIG_PATH,
    hybrid: process.env.PI_CHRONO_PI_SUMMARY,
    editor: process.env.PI_CHRONO_HISTORY_EDITOR,
    cache: process.env.PI_CHRONO_CACHE,
  };
  const session = await readSessionJsonl(resolve("test/fixtures/session.jsonl"));
  const branch = getActiveBranch(session);
  try {
    process.env.PI_CHRONO_PI_SUMMARY = "false";
    process.env.PI_CHRONO_CACHE = "false";
    for (const mode of ["default", "persistent-disabled", "environment-disabled"] as const) {
      const configPath = join(tmpdir(), `chrono-zero-editor-${mode}-${process.pid}.json`);
      process.env.PI_CHRONO_CONFIG_PATH = configPath;
      rmSync(configPath, { force: true });
      if (mode === "default") {
        delete process.env.PI_CHRONO_HISTORY_EDITOR;
      } else if (mode === "persistent-disabled") {
        delete process.env.PI_CHRONO_HISTORY_EDITOR;
        writeFileSync(configPath, `${JSON.stringify({ historyEditorEnabled: false })}\n`, { mode: 0o600 });
      } else {
        writeFileSync(configPath, `${JSON.stringify({ historyEditorEnabled: true })}\n`, { mode: 0o600 });
        process.env.PI_CHRONO_HISTORY_EDITOR = "false";
      }
      const hooks = new Map<string, Hook>();
      const pi = {
        registerTool() {},
        registerCommand() {},
        on(name: string, handler: Hook) { setUniqueHook(hooks, name, handler); },
        appendEntry() {},
        sendMessage() {},
      };
      extension(pi as unknown as ExtensionAPI);
      let providerAuthCalls = 0;
      const hook = hooks.get("session_before_compact");
      assert.ok(hook);
      const raw = await hook(
        {
          branchEntries: branch,
          preparation: { firstKeptEntryId: "e133", tokensBefore: 16_000 },
          reason: "manual",
          willRetry: false,
          signal: new AbortController().signal,
        },
        {
          hasUI: true,
          model: { provider: "test", id: "test", contextWindow: 100_000 },
          modelRegistry: {
            async getApiKeyAndHeaders() {
              providerAuthCalls += 1;
              return { ok: true, apiKey: "not-used" };
            },
          },
          sessionManager: { getSessionFile: () => undefined },
          ui: { notify() {} },
        },
      ) as { compaction?: { details?: { historyEditor?: { status?: string; calls?: number }; hybrid?: { enabled?: boolean } } } };
      assert.ok(raw.compaction, `${mode} deterministic replay was not produced`);
      assert.equal(raw.compaction.details?.historyEditor?.status, "disabled");
      assert.equal(raw.compaction.details?.historyEditor?.calls, 0);
      assert.equal(raw.compaction.details?.hybrid?.enabled, false);
      assert.equal(providerAuthCalls, 0, `${mode} classifier path requested provider authentication`);
      rmSync(configPath, { force: true });
    }
  } finally {
    const names = {
      config: "PI_CHRONO_CONFIG_PATH",
      hybrid: "PI_CHRONO_PI_SUMMARY",
      editor: "PI_CHRONO_HISTORY_EDITOR",
      cache: "PI_CHRONO_CACHE",
    } as const;
    for (const key of Object.keys(names) as Array<keyof typeof names>) {
      const value = previous[key];
      if (value === undefined) delete process.env[names[key]];
      else process.env[names[key]] = value;
    }
  }
});

test("Pi-prepared tail mode moves the cut after an orphan function output", async () => {
  const names = ["PI_CHRONO_CONFIG_PATH", "PI_CHRONO_RAW_TAIL", "PI_CHRONO_PI_SUMMARY", "PI_CHRONO_HISTORY_EDITOR", "PI_CHRONO_CACHE"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const configPath = join(tmpdir(), `chrono-orphan-tail-${process.pid}.json`);
  try {
    process.env.PI_CHRONO_CONFIG_PATH = configPath;
    process.env.PI_CHRONO_RAW_TAIL = "pi";
    process.env.PI_CHRONO_PI_SUMMARY = "false";
    process.env.PI_CHRONO_HISTORY_EDITOR = "false";
    process.env.PI_CHRONO_CACHE = "false";
    const hooks = new Map<string, Hook>();
    const pi = {
      registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
      on(name: string, handler: Hook) { setUniqueHook(hooks, name, handler); },
    };
    extension(pi as unknown as ExtensionAPI);
    const branch: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 12; index += 1) {
      branch.push({
        type: "message",
        id: `orphan-old-${index}`,
        parentId: index === 0 ? null : `orphan-old-${index - 1}`,
        message: { role: "assistant", content: [{ type: "text", text: `Routine historical observation ${index}. ${"repeatable detail. ".repeat(180)}` }], stopReason: "stop" },
      });
    }
    branch.push({ type: "message", id: "orphan-prepared", parentId: "orphan-old-11", message: { role: "assistant", content: [{ type: "text", text: "Prepared tail start." }], stopReason: "stop" } });
    branch.push({ type: "message", id: "orphan-output", parentId: "orphan-prepared", message: { role: "toolResult", toolCallId: "missing-function-call", toolName: "bash", content: [{ type: "text", text: "Late tool output after the call was lost." }] } });
    branch.push({ type: "custom_message", id: "orphan-safe", parentId: "orphan-output", customType: "resume", content: "Continue after compaction." });
    branch.push({ type: "message", id: "orphan-user", parentId: "orphan-safe", message: { role: "user", content: [{ type: "text", text: "Continue the current task." }] } });
    const hook = hooks.get("session_before_compact");
    assert.ok(hook);
    const raw = await hook({
      branchEntries: branch,
      preparation: { firstKeptEntryId: "orphan-prepared", tokensBefore: 20_000 },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    }, {
      hasUI: true,
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify() {} },
      modelRegistry: {},
    }) as { compaction?: { firstKeptEntryId?: string; details?: { retainedTail?: { reason?: string } } } };
    assert.ok(raw.compaction);
    assert.equal(raw.compaction.firstKeptEntryId, "orphan-safe");
    assert.match(raw.compaction.details?.retainedTail?.reason ?? "", /moved the cut after an orphan function output/);
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(configPath, { force: true });
  }
});

test("V1 hard ceiling bounds regular summary, Chrono history, and raw tail to 30,000 tokens", async () => {
  const hooks = new Map<string, Hook>();
  const previous = {
    config: process.env.PI_CHRONO_CONFIG_PATH,
    tail: process.env.PI_CHRONO_RAW_TAIL,
    hybrid: process.env.PI_CHRONO_PI_SUMMARY,
    editor: process.env.PI_CHRONO_HISTORY_EDITOR,
  };
  const configPath = join(tmpdir(), `chrono-ceiling-${process.pid}.json`);
  process.env.PI_CHRONO_CONFIG_PATH = configPath;
  process.env.PI_CHRONO_RAW_TAIL = "50000";
  process.env.PI_CHRONO_PI_SUMMARY = "false";
  process.env.PI_CHRONO_HISTORY_EDITOR = "false";
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: Hook) { setUniqueHook(hooks, name, handler); },
    appendEntry() {},
    sendMessage() {},
  };
  extension(pi as unknown as ExtensionAPI);
  const branch = Array.from({ length: 36 }, (_, index) => ({
    type: "message",
    id: `cap-${index}`,
    parentId: index === 0 ? null : `cap-${index - 1}`,
    message: {
      role: "user",
      content: `Synthetic routine history item ${index}. ${"repeatable output line. ".repeat(170)}`,
    },
  }));
  const hook = hooks.get("session_before_compact");
  assert.ok(hook);
  const raw = await hook(
    {
      branchEntries: branch,
      preparation: { firstKeptEntryId: "cap-18", tokensBefore: 36_000 },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    {
      hasUI: true,
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify() {} },
      modelRegistry: {},
    },
  ) as { compaction?: { details?: { layers?: { combinedContextTokens?: number; hardCeilingTokens?: number } } } };
  assert.ok(raw.compaction);
  assert.equal(raw.compaction.details?.layers?.hardCeilingTokens, 30_000);
  assert.ok((raw.compaction.details?.layers?.combinedContextTokens ?? Infinity) <= 30_000);

  for (const [key, value] of Object.entries(previous)) {
    const name = key === "config" ? "PI_CHRONO_CONFIG_PATH" : key === "tail" ? "PI_CHRONO_RAW_TAIL" : key === "hybrid" ? "PI_CHRONO_PI_SUMMARY" : "PI_CHRONO_HISTORY_EDITOR";
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(configPath, { force: true });
});

test("uniform continuation follows unresolved turns across successful compaction triggers", async () => {
  const hooks = new Map<string, Hook>();
  const toolExecutors = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const sentMessages: Array<{ customType: string; content: string; triggerTurn?: boolean }> = [];
  const compactRequests: Array<{ onComplete?: (result: unknown) => void }> = [];
  const configPath = join(tmpdir(), `chrono-continuation-${process.pid}.json`);
  const previousConfigPath = process.env.PI_CHRONO_CONFIG_PATH;
  const previousTriggerTokens = process.env.PI_CHRONO_TRIGGER_TOKENS;
  process.env.PI_CHRONO_CONFIG_PATH = configPath;
  const pi = {
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      toolExecutors.set(tool.name, tool.execute);
    },
    registerCommand() {},
    on(name: string, handler: Hook) {
      setUniqueHook(hooks, name, handler);
    },
    appendEntry() {},
    sendMessage(message: { customType: string; content: string }, options?: { triggerTurn?: boolean }) {
      sentMessages.push({ ...message, triggerTurn: options?.triggerTurn });
    },
  };
  extension(pi as unknown as ExtensionAPI);

  let currentContextTokens = 9_000;
  let abortCount = 0;
  const context = {
    hasUI: true,
    model: { contextWindow: 272_000 },
    getContextUsage: () => ({
      tokens: currentContextTokens,
      contextWindow: 272_000,
      percent: (currentContextTokens / 272_000) * 100,
    }),
    isIdle: () => false,
    abort: () => {
      abortCount += 1;
    },
    compact: (options: { onComplete?: (result: unknown) => void }) => {
      compactRequests.push(options);
    },
    sessionManager: {
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: {
      notify() {},
    },
    modelRegistry: {},
  };
  const incompleteBranch: Array<Record<string, unknown>> = [
    { type: "message", id: "u1", message: { role: "user", content: "Continue the task." } },
    { type: "message", id: "a1", message: { role: "assistant", stopReason: "toolUse", content: [] } },
  ];
  const completeBranch: Array<Record<string, unknown>> = [
    ...incompleteBranch,
    { type: "message", id: "a2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] } },
  ];
  const beforeCompact = hooks.get("session_before_compact");
  const afterCompact = hooks.get("session_compact");
  const settled = hooks.get("agent_settled");
  const turnEnd = hooks.get("turn_end");
  assert.ok(beforeCompact);
  assert.ok(afterCompact);
  assert.ok(settled);
  assert.ok(turnEnd);

  const successfulCompaction = async (
    branchEntries: Array<Record<string, unknown>>,
    reason: "manual" | "threshold" | "overflow",
    willRetry = false,
  ) => {
    await beforeCompact(
      {
        branchEntries,
        preparation: {},
        reason,
        willRetry,
        signal: new AbortController().signal,
      },
      context,
    );
    await afterCompact({ reason, willRetry }, context);
  };

  await successfulCompaction(completeBranch, "manual");
  assert.equal(sentMessages.length, 0, "idle manual compaction must not start a turn");

  await successfulCompaction(incompleteBranch, "manual");
  await successfulCompaction(incompleteBranch, "threshold");
  assert.equal(sentMessages.length, 2, "manual and Pi pressure compactions must continue unresolved work");

  await successfulCompaction(incompleteBranch, "overflow", true);
  assert.equal(sentMessages.length, 2, "Pi overflow retry must not get a duplicate extension continuation");

  await successfulCompaction(completeBranch, "threshold");
  assert.equal(sentMessages.length, 2, "continuation must stop after final output");

  process.env.PI_CHRONO_TRIGGER_TOKENS = "8000";
  await settled({}, context);
  assert.equal(compactRequests.length, 1, "proactive pressure must use Pi's compaction lifecycle");
  await successfulCompaction(incompleteBranch, "manual");
  assert.equal(sentMessages.length, 3, "successful proactive compaction must continue unresolved work");

  const requestCompaction = toolExecutors.get("request_compaction");
  assert.ok(requestCompaction);
  await requestCompaction();
  await turnEnd({ message: { role: "assistant", usage: { totalTokens: currentContextTokens } } }, context);
  await settled({}, context);
  assert.equal(compactRequests.length, 2);
  await successfulCompaction(completeBranch, "manual");
  assert.equal(sentMessages.length, 4, "model-requested compaction must preserve its forced continuation");

  currentContextTokens = 260_000;
  await turnEnd({ message: { role: "assistant", usage: { totalTokens: currentContextTokens } } }, context);
  await settled({}, context);
  assert.equal(compactRequests.length, 3);
  await successfulCompaction(completeBranch, "manual");
  assert.equal(sentMessages.length, 5, "circuit-breaker compaction must preserve its forced continuation");
  assert.equal(abortCount, 2);
  assert.ok(sentMessages.every((message) => message.customType === "chrono-compact-resume" && message.triggerTurn === true));

  if (previousConfigPath === undefined) delete process.env.PI_CHRONO_CONFIG_PATH;
  else process.env.PI_CHRONO_CONFIG_PATH = previousConfigPath;
  if (previousTriggerTokens === undefined) delete process.env.PI_CHRONO_TRIGGER_TOKENS;
  else process.env.PI_CHRONO_TRIGGER_TOKENS = previousTriggerTokens;
  rmSync(configPath, { force: true });
});

test("exact history tools reuse an existing ledger but never create one alone",async()=>{const directory=mkdtempSync(join(tmpdir(),"chrono-extension-retrieval-")),sessionPath=join(directory,"session.jsonl");writeFileSync(sessionPath,readFileSync(resolve("test/fixtures/session.jsonl")),{mode:0o600});const tools=new Map<string,(...args:any[])=>Promise<any>>(),pi={registerTool(tool:{name:string;execute:(...args:any[])=>Promise<any>}){tools.set(tool.name,tool.execute);},registerCommand(){},on(){},appendEntry(){},sendMessage(){}};try{extension(pi as unknown as ExtensionAPI);const session=await readSessionJsonl(sessionPath),entries=session.entries,context={hasUI:false,model:undefined,thinkingLevel:"medium",sessionManager:{getSessionFile:()=>sessionPath,getEntries:()=>entries,getBranch:()=>entries},getContextUsage:()=>undefined,isIdle:()=>true,abort(){},compact(){},ui:{notify(){}},modelRegistry:{}};const get=tools.get("history_get"),range=tools.get("history_range");assert.ok(get&&range);const first=await get("get-no-ledger",{entryId:"e123"},undefined,undefined,context),firstText=first.content[0].text;assert.equal(existsSync(sourceLedgerPath(sessionPath)),false);await range("range-no-ledger",{startEntryId:"e123",endEntryId:"e124"},undefined,undefined,context);assert.equal(existsSync(sourceLedgerPath(sessionPath)),false);await updateSourceLedger(sessionPath);const ledgerText=(await get("get-ledger",{entryId:"e123"},undefined,undefined,context)).content[0].text;assert.equal(ledgerText,firstText);writeFileSync(`${sourceLedgerPath(sessionPath)}.lock`,"busy",{mode:0o600});const busyText=(await get("get-busy",{entryId:"e123"},undefined,undefined,context)).content[0].text;assert.equal(busyText,firstText);}finally{rmSync(directory,{recursive:true,force:true});}});

test("shadow-on extension output equals shadow-off output and completes after return", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-extension-shadow-"));
  const sessionPath = join(directory, "session.jsonl");
  writeFileSync(sessionPath, readFileSync(resolve("test/fixtures/session.jsonl")), { mode: 0o600 });
  const names = ["PI_CHRONO_CONFIG_PATH", "PI_CHRONO_ROLLUP_SHADOW", "PI_CHRONO_CACHE", "PI_CHRONO_PI_SUMMARY"];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  const execute = async (enabled: boolean) => {
    process.env.PI_CHRONO_CONFIG_PATH = join(directory, `config-${enabled}.json`);
    process.env.PI_CHRONO_ROLLUP_SHADOW = String(enabled);
    process.env.PI_CHRONO_CACHE = "false";
    process.env.PI_CHRONO_PI_SUMMARY = "false";
    const hooks = new Map<string, Hook>();
    const pi = { registerTool() {}, registerCommand() {}, on(name: string, handler: Hook) { setUniqueHook(hooks, name, handler); }, appendEntry() {}, sendMessage() {} };
    extension(pi as unknown as ExtensionAPI);
    const session = await readSessionJsonl(sessionPath);
    const branch = getActiveBranch(session);
    const hook = hooks.get("session_before_compact");
    assert.ok(hook);
    return hook({ branchEntries: branch, preparation: { firstKeptEntryId: "e133", tokensBefore: 16_000 }, customInstructions: "Preserve the public API restriction.", reason: "manual", willRetry: false, signal: new AbortController().signal }, { hasUI: true, model: { contextWindow: 272_000 }, sessionManager: { getSessionFile: () => sessionPath, getEntries: () => branch, getBranch: () => branch }, ui: { notify() {} }, modelRegistry: {} }) as Promise<{ compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } }>;
  };
  try {
    const off = await execute(false);
    assert.equal(existsSync(rollupShadowSidecarPath(sessionPath)), false);
    assert.equal(existsSync(`${sessionPath}.chrono-history-rollups-v2`), false);
    const started = performance.now();
    const on = await execute(true);
    const returnMs = performance.now() - started;
    assert.deepEqual(on, off);
    assert.ok(returnMs < 1_000, "the compaction response must not wait for shadow completion");
    await waitFor(() => existsSync(rollupShadowSidecarPath(sessionPath)), 10_000);
    const text = readFileSync(rollupShadowSidecarPath(sessionPath), "utf8");
    assert.doesNotMatch(text, /public API|session\.jsonl|e133|CURRENT WORK|CHRONOCOMPACT/);
    assert.equal(statSync(rollupShadowSidecarPath(sessionPath)).mode & 0o777, 0o600);
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated worker extension path uses persisted source and returns exact bounded replay", async () => {
  const directory=mkdtempSync(join(tmpdir(),"chrono-extension-worker-"));const sessionPath=join(directory,"session.jsonl");writeFileSync(sessionPath,readFileSync(resolve("test/fixtures/session.jsonl")),{mode:0o600});
  const names=["PI_CHRONO_CONFIG_PATH","PI_CHRONO_ISOLATED_WORKER","PI_CHRONO_CACHE"];const previous=new Map(names.map(name=>[name,process.env[name]]));process.env.PI_CHRONO_CONFIG_PATH=join(directory,"config.json");process.env.PI_CHRONO_ISOLATED_WORKER="true";process.env.PI_CHRONO_CACHE="false";
  try{const hooks=new Map<string,Hook>();const pi={registerTool(){},registerCommand(){},on(name:string,handler:Hook){setUniqueHook(hooks,name,handler);},appendEntry(){},sendMessage(){}};extension(pi as unknown as ExtensionAPI);const session=await readSessionJsonl(sessionPath);const branch=getActiveBranch(session);const hook=hooks.get("session_before_compact");assert.ok(hook);const notifications:string[]=[];const raw=await hook({branchEntries:branch,preparation:{firstKeptEntryId:"e133",tokensBefore:16_000},customInstructions:"Preserve the public API restriction.",reason:"manual",willRetry:false,signal:new AbortController().signal},{hasUI:true,model:{contextWindow:272_000},sessionManager:{getSessionFile:()=>sessionPath,getEntries:()=>branch,getBranch:()=>branch},ui:{notify(message:string){notifications.push(message);}},modelRegistry:{}});const result=raw as {compaction?:{summary:string;details?:{isolatedWorker?:{used?:boolean;client?:{mainProcessMaximumTimerDelayMs?:number}}}}};assert.ok(result?.compaction, notifications.join("\n"));assert.equal(result.compaction.details?.isolatedWorker?.used,true);assert.ok((result.compaction.details?.isolatedWorker?.client?.mainProcessMaximumTimerDelayMs??999)<250);assert.match(result.compaction.summary,/public API/);assert.doesNotMatch(notifications.join("\n"),/\/home\/|session\.jsonl/);}finally{for(const name of names){const value=previous.get(name);if(value===undefined)delete process.env[name];else process.env[name]=value;}rmSync(directory,{recursive:true,force:true});}
});
