import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ASK_USER_BLOCKING_REQUEST_EVENT_V1,
  ASK_USER_BLOCKING_RESPONSE_EVENT_V1,
  ASK_USER_DEFERRED_REQUEST_EVENT_V1,
  ASK_USER_DEFERRED_RESPONSE_EVENT_V1,
  type AskUserBlockingProviderRequestV1,
} from "../packages/core/src/ask-user-v1.ts";
import { ASK_USER_PARAMETERS_V1, loadAskUserV1Enabled, registerAskUserFacadeV1 } from "../packages/dialog/ask-user-facade.ts";
import { registerBlockingProviderV1 } from "../packages/dialog/blocking-provider.ts";
import { registerGroundedDialog } from "../packages/dialog/index.ts";

class Bus {
  readonly emitted: Array<{ name: string; value: unknown }> = [];
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  emit(name: string, value: unknown): void {
    this.emitted.push({ name, value });
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(value);
  }

  on(name: string, listener: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  count(name: string): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly hasUI?: boolean;
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly select?: (...args: any[]) => any;
  readonly input?: (...args: any[]) => any;
}

function harness(options: HarnessOptions = {}) {
  const bus = new Bus();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let active = ["read", "ask_user_question", "ask_user"];
  const pi = {
    events: bus,
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: (event: any, ctx: any) => any) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    getActiveTools() { return [...active]; },
    setActiveTools(next: string[]) { active = [...next]; },
  } as any;
  registerGroundedDialog(pi, { askUserV1Enabled: options.enabled === true });
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    ui: {
      select: options.select ?? (async (_title: string, values: string[]) => values[0]),
      input: options.input ?? (async () => undefined),
    },
  };
  const dispatch = async (name: string, event: any = { reason: "startup" }) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { bus, tools, handlers, pi, ctx, dispatch, active: () => active };
}

const blockingInput = {
  operation: "ask",
  mode: "blocking",
  question: "Choose a storage format",
  explanation: "This changes the local file layout.",
  response: {
    kind: "single_or_text",
    options: [
      { id: "json", label: "JSON", description: "Readable", preview: "{\"v\":1}" },
      { id: "sqlite", label: "SQLite", description: "Queryable" },
    ],
  },
  timeoutMs: 10_000,
} as const;

const deferredInput = {
  operation: "ask",
  mode: "deferred",
  question: "Choose the durable format",
  reason: "Independent tests can continue.",
  class: "reversible",
  response: {
    kind: "single_or_text",
    options: [
      { id: "json", label: "JSON" },
      { id: "sqlite", label: "SQLite" },
    ],
  },
  recommendation: "Use JSON.",
  recommendedOptionIds: ["json"],
  temporaryDefault: { optionIds: ["json"], disclosure: "Keep JSON while waiting." },
  priority: "normal",
  escalationPolicy: "when_agent_settles",
  deliveryMode: "steer",
  affectedWork: ["Final persistence implementation"],
  continuingWork: ["Parser tests"],
  attachments: [{ kind: "note", label: "Evidence", text: "JSON is already in use." }],
  expiresAt: "2030-01-01T00:00:00.000Z",
} as const;

function pendingSelect(_title: string, _values: string[], options?: { signal?: AbortSignal }): Promise<undefined> {
  return new Promise((resolve) => {
    if (options?.signal?.aborted) resolve(undefined);
    else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

async function executeBlocking(runtime: ReturnType<typeof harness>, signal?: AbortSignal) {
  await runtime.dispatch("session_start");
  return runtime.tools.get("ask_user").execute("tool-1", blockingInput, signal, undefined, runtime.ctx);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected state was not reached.");
}

function blockingTerminalCount(bus: Bus): number {
  return bus.emitted.filter((event) =>
    event.name === ASK_USER_BLOCKING_RESPONSE_EVENT_V1
    && ["answered", "cancelled", "timed_out"].includes((event.value as { state?: string }).state ?? "")
  ).length;
}

function herdrStates(bus: Bus): boolean[] {
  return bus.emitted
    .filter((event) => event.name === "herdr:blocked")
    .map((event) => (event.value as { active: boolean }).active);
}

test("version-1 schema is a strict explicit-mode union", () => {
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, blockingInput), true);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, deferredInput), true);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { operation: "cancel", mode: "deferred", id: "Q-1", expectedRevision: 1, reason: "No longer needed." }), true);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, mode: undefined }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, unknown: true }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, timeoutMs: 9_999 }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, timeoutMs: 86_400_001 }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, response: { ...blockingInput.response, options: [blockingInput.response.options[0]] } }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, response: { ...blockingInput.response, options: [...blockingInput.response.options, { id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] } }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...blockingInput, response: { ...blockingInput.response, options: [{ id: "bad id", label: "A" }, { id: "b", label: "B" }] } }), false);
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, { ...deferredInput, response: { ...deferredInput.response, options: [{ id: "UPPER", label: "A" }, { id: "ok", label: "B" }] } }), false);
});

test("ask_user registers only through the exact opt-in and old/new tools coexist", () => {
  const disabled = harness();
  assert.deepEqual([...disabled.tools.keys()], ["ask_user_question"]);
  const enabled = harness({ enabled: true });
  assert.deepEqual([...enabled.tools.keys()], ["ask_user", "ask_user_question"]);
});

test("grounded-dialog settings require literal askUserV1 true", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grounded-dialog-settings-"));
  const path = join(directory, "settings.json");
  assert.equal(loadAskUserV1Enabled(path), false);
  await writeFile(path, "{\"askUserV1\":false}\n");
  assert.equal(loadAskUserV1Enabled(path), false);
  await writeFile(path, "{\"askUserV1\":true}\n");
  assert.equal(loadAskUserV1Enabled(path), true);
});

test("blocking mode routes only to blocking channels and returns a normalized answer", async () => {
  const runtime = harness({ enabled: true, select: async (_title, values) => values[1] });
  const result = await executeBlocking(runtime);
  assert.equal(result.details.status, "answered");
  assert.deepEqual(result.details.answer, { kind: "option", optionId: "sqlite" });
  assert.match(result.details.correlationId, /^ask_/u);
  assert.equal(runtime.bus.emitted.some((event) => event.name === ASK_USER_BLOCKING_REQUEST_EVENT_V1), true);
  assert.equal(runtime.bus.emitted.some((event) => event.name === ASK_USER_DEFERRED_REQUEST_EVENT_V1), false);
  assert.deepEqual(herdrStates(runtime.bus), [true, false]);
  assert.equal(blockingTerminalCount(runtime.bus), 1);
  assert.equal(runtime.bus.count(ASK_USER_BLOCKING_RESPONSE_EVENT_V1), 0);
});

test("free-form blocking answers are normalized", async () => {
  const runtime = harness({
    enabled: true,
    select: async (_title, values) => values.at(-1),
    input: async () => "  an exact custom answer  ",
  });
  const result = await executeBlocking(runtime);
  assert.deepEqual(result.details.answer, { kind: "text", text: "an exact custom answer" });
  assert.deepEqual(herdrStates(runtime.bus), [true, false]);
  assert.equal(blockingTerminalCount(runtime.bus), 1);
});

test("over-limit UI text follows one legal provider_failure terminal without truncation", async () => {
  const runtime = harness({
    enabled: true,
    select: async (_title, values) => values.at(-1),
    input: async () => "x".repeat(4001),
  });
  const result = await executeBlocking(runtime);
  assert.equal(result.details.status, "cancelled");
  assert.equal(result.details.reason, "provider_failure");
  assert.equal(runtime.bus.emitted.some((event) =>
    event.name === ASK_USER_BLOCKING_RESPONSE_EVENT_V1
    && (event.value as { state?: string }).state === "answered"
  ), false);
  assert.equal(blockingTerminalCount(runtime.bus), 1);
  assert.deepEqual(herdrStates(runtime.bus), [true, false]);
});

test("deferred ask routes exactly, maps escalationPolicy, and normalizes queued", async () => {
  const runtime = harness({ enabled: true });
  let request: any;
  runtime.bus.on(ASK_USER_DEFERRED_REQUEST_EVENT_V1, (value) => {
    request = value;
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: request.correlationId, mode: "deferred", state: "accepted" });
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: request.correlationId, mode: "deferred", state: "queued", operation: "ask", questionId: "qst_00000000-0000-4000-8000-000000000001", displayId: "Q-1", revision: 1 });
  });
  const result = await runtime.tools.get("ask_user").execute("deferred-1", deferredInput, undefined, undefined, runtime.ctx);
  assert.equal(request.blockingPolicy, "when_agent_settles");
  assert.equal("escalationPolicy" in request, false);
  assert.equal(result.details.status, "queued");
  assert.equal(result.details.questionId, "qst_00000000-0000-4000-8000-000000000001");
  assert.equal(runtime.bus.emitted.some((event) => event.name === ASK_USER_BLOCKING_REQUEST_EVENT_V1), false);
  assert.deepEqual(herdrStates(runtime.bus), []);
});

test("deferred cancel routes exactly and returns the new cancelled revision", async () => {
  const runtime = harness({ enabled: true });
  runtime.bus.on(ASK_USER_DEFERRED_REQUEST_EVENT_V1, (value: any) => {
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "accepted" });
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "cancelled", operation: "cancel", questionId: "qst_00000000-0000-4000-8000-000000000001", displayId: "Q-1", revision: 3 });
  });
  const result = await runtime.tools.get("ask_user").execute("deferred-2", { operation: "cancel", mode: "deferred", id: "Q-1", expectedRevision: 2, reason: "Superseded." }, undefined, undefined, runtime.ctx);
  assert.deepEqual(result.details, { schemaVersion: 1, operation: "cancel", mode: "deferred", correlationId: result.details.correlationId, status: "cancelled", questionId: "qst_00000000-0000-4000-8000-000000000001", displayId: "Q-1", revision: 3 });
});

test("facade correlation is stable for an exact tool retry and rejects conflicting reuse", async () => {
  const runtime = harness({ enabled: true });
  const correlations: string[] = [];
  runtime.bus.on(ASK_USER_DEFERRED_REQUEST_EVENT_V1, (value: any) => {
    correlations.push(value.correlationId);
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "accepted" });
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "queued", operation: "ask", questionId: "qst_00000000-0000-4000-8000-000000000001", displayId: "Q-1", revision: 1 });
  });
  await runtime.tools.get("ask_user").execute("retry-id", deferredInput, undefined, undefined, runtime.ctx);
  await runtime.tools.get("ask_user").execute("retry-id", structuredClone(deferredInput), undefined, undefined, runtime.ctx);
  assert.equal(correlations.length, 2);
  assert.equal(correlations[0], correlations[1]);
  await assert.rejects(
    runtime.tools.get("ask_user").execute("retry-id", { ...deferredInput, question: "Different" }, undefined, undefined, runtime.ctx),
    /ASK_USER_CORRELATION_CONFLICT/u,
  );
  assert.equal(correlations.length, 2);
});

test("facade retry identity uses normalized deferred arrays and preserves real conflicts", async () => {
  const runtime = harness({ enabled: true });
  const requests: any[] = [];
  runtime.bus.on(ASK_USER_DEFERRED_REQUEST_EVENT_V1, (value: any) => {
    requests.push(value);
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "accepted" });
    runtime.bus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "queued", operation: "ask", questionId: "qst_00000000-0000-4000-8000-000000000001", displayId: "Q-1", revision: 1 });
  });
  const omittedArrays = {
    operation: "ask",
    mode: "deferred",
    question: "Choose",
    reason: "Continue work.",
    class: "reversible",
    response: { kind: "text" },
  } as const;
  const explicitEmptyArrays = {
    ...omittedArrays,
    response: { kind: "text", options: [] },
    recommendedOptionIds: [],
    affectedWork: [],
    continuingWork: [],
    attachments: [],
  } as const;
  await runtime.tools.get("ask_user").execute("normalized-retry", omittedArrays, undefined, undefined, runtime.ctx);
  await runtime.tools.get("ask_user").execute("normalized-retry", explicitEmptyArrays, undefined, undefined, runtime.ctx);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].correlationId, requests[1].correlationId);
  for (const key of ["recommendedOptionIds", "affectedWork", "continuingWork", "attachments"] as const) {
    assert.deepEqual(requests[0][key], []);
    assert.deepEqual(requests[1][key], []);
  }
  assert.deepEqual(requests[0].response, { kind: "text", options: [] });
  assert.deepEqual(requests[1].response, { kind: "text", options: [] });
  await assert.rejects(
    runtime.tools.get("ask_user").execute("normalized-retry", { ...explicitEmptyArrays, question: "Different" }, undefined, undefined, runtime.ctx),
    /ASK_USER_CORRELATION_CONFLICT/u,
  );
  assert.equal(requests.length, 2);
});

test("selected provider absence and malformed responses fail closed", async () => {
  const absentBus = new Bus();
  let tool: any;
  registerAskUserFacadeV1({ events: absentBus, registerTool(value: any) { tool = value; } } as any);
  await assert.rejects(tool.execute("missing", deferredInput, undefined, undefined, {}), /ASK_USER_PROVIDER_UNAVAILABLE/u);

  const unhealthyBus = new Bus();
  registerAskUserFacadeV1({ events: unhealthyBus, registerTool(value: any) { tool = value; } } as any);
  unhealthyBus.on(ASK_USER_DEFERRED_REQUEST_EVENT_V1, (value: any) => {
    unhealthyBus.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, { schemaVersion: 1, correlationId: value.correlationId, mode: "deferred", state: "queued" });
  });
  await assert.rejects(tool.execute("bad", deferredInput, undefined, undefined, {}), /ASK_USER_PROVIDER_UNHEALTHY/u);
});

test("headless blocking rejects before opening or projecting Herdr", async () => {
  const runtime = harness({ enabled: true, hasUI: false, mode: "print" });
  await runtime.dispatch("session_start");
  await assert.rejects(runtime.tools.get("ask_user").execute("headless", blockingInput, undefined, undefined, runtime.ctx), /ASK_USER_PROVIDER_UNAVAILABLE/u);
  assert.deepEqual(herdrStates(runtime.bus), []);
});

test("Escape produces one cancelled terminal and balanced Herdr events", async () => {
  const runtime = harness({ enabled: true, select: async () => undefined });
  const result = await executeBlocking(runtime);
  assert.equal(result.details.status, "cancelled");
  assert.equal(result.details.reason, "user");
  assert.deepEqual(herdrStates(runtime.bus), [true, false]);
  assert.equal(blockingTerminalCount(runtime.bus), 1);
});

test("timeout produces one timed_out terminal and closes the UI", async () => {
  const bus = new Bus();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  let timeout: (() => void) | undefined;
  const pi = {
    events: bus,
    registerTool(value: any) { tools.set(value.name, value); },
    on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  } as any;
  registerBlockingProviderV1(pi, { scheduleTimeout(callback) { timeout = callback; return () => { timeout = undefined; }; } });
  registerAskUserFacadeV1(pi);
  const ctx = { hasUI: true, mode: "tui", ui: { select: pendingSelect, input: async () => undefined } };
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  const pending = tools.get("ask_user").execute("timeout", blockingInput, undefined, undefined, ctx);
  await Promise.resolve();
  assert.ok(timeout);
  const expire = timeout;
  expire();
  const result = await pending;
  assert.equal(result.details.status, "timed_out");
  assert.deepEqual(herdrStates(bus), [true, false]);
  assert.equal(blockingTerminalCount(bus), 1);
});

test("tool abort produces one cancelled terminal and balanced Herdr events", async () => {
  const controller = new AbortController();
  const runtime = harness({ enabled: true, select: pendingSelect });
  const pending = executeBlocking(runtime, controller.signal);
  await waitUntil(() => herdrStates(runtime.bus).includes(true));
  controller.abort();
  const result = await pending;
  assert.equal(result.details.reason, "abort");
  assert.deepEqual(herdrStates(runtime.bus), [true, false]);
  assert.equal(blockingTerminalCount(runtime.bus), 1);
});

test("provider UI failure produces one provider_failure terminal", async () => {
  const runtime = harness({ enabled: true, select: async () => { throw new Error("UI failed"); } });
  const result = await executeBlocking(runtime);
  assert.equal(result.details.reason, "provider_failure");
  assert.deepEqual(herdrStates(runtime.bus), [true, false]);
  assert.equal(blockingTerminalCount(runtime.bus), 1);
});

for (const reason of ["quit", "reload"] as const) {
  test(`${reason} closes the blocking call, balances Herdr, and removes provider listeners`, async () => {
    const runtime = harness({ enabled: true, select: pendingSelect });
    const pending = executeBlocking(runtime);
    await waitUntil(() => herdrStates(runtime.bus).includes(true));
    assert.equal(runtime.bus.count(ASK_USER_BLOCKING_REQUEST_EVENT_V1), 1);
    await runtime.dispatch("session_shutdown", { reason });
    const result = await pending;
    assert.equal(result.details.reason, reason === "reload" ? "reload" : "shutdown");
    assert.deepEqual(herdrStates(runtime.bus), [true, false]);
    assert.equal(blockingTerminalCount(runtime.bus), 1);
    assert.equal(runtime.bus.count(ASK_USER_BLOCKING_REQUEST_EVENT_V1), 0);
    assert.equal(runtime.bus.count(ASK_USER_BLOCKING_RESPONSE_EVENT_V1), 0);
  });
}

test("identical retries join or use cache, conflicts reject, and one UI opens", async () => {
  const bus = new Bus();
  const handlers = new Map<string, Function[]>();
  let selections = 0;
  let answer: ((value: string | undefined) => void) | undefined;
  const pi = {
    events: bus,
    on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  } as any;
  registerBlockingProviderV1(pi);
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      select() { selections += 1; return new Promise<string | undefined>((resolve) => { answer = resolve; }); },
      input: async () => undefined,
    },
  };
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  const request: AskUserBlockingProviderRequestV1 = {
    schemaVersion: 1,
    correlationId: "ask_00000000-0000-4000-8000-000000000001",
    operation: "ask",
    mode: "blocking",
    question: blockingInput.question,
    response: blockingInput.response,
    timeoutMs: blockingInput.timeoutMs,
  };
  bus.emit(ASK_USER_BLOCKING_REQUEST_EVENT_V1, request);
  bus.emit(ASK_USER_BLOCKING_REQUEST_EVENT_V1, request);
  assert.equal(selections, 1);
  bus.emit(ASK_USER_BLOCKING_REQUEST_EVENT_V1, { ...request, question: "Conflicting question" });
  assert.equal(bus.emitted.some((event) => event.name === ASK_USER_BLOCKING_RESPONSE_EVENT_V1 && (event.value as any).error?.code === "ASK_USER_CORRELATION_CONFLICT"), true);
  answer?.("1. JSON — Readable\nPreview:\n{\"v\":1}");
  await Promise.resolve();
  await Promise.resolve();
  const before = selections;
  bus.emit(ASK_USER_BLOCKING_REQUEST_EVENT_V1, request);
  assert.equal(selections, before);
  const terminals = bus.emitted.filter((event) => event.name === ASK_USER_BLOCKING_RESPONSE_EVENT_V1 && (event.value as any).state === "answered");
  assert.equal(terminals.length, 2);
  assert.deepEqual(herdrStates(bus), [true, false]);
});
