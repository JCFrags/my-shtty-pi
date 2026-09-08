import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ASK_USER_DEFERRED_TERMINAL_TIMEOUT_MS,
  ASK_USER_PARAMETERS_V1,
  registerAskUserFacadeV1,
} from "../ask-user-facade.ts";
import { registerGroundedDialog } from "../index.ts";
import {
  ASK_USER_BLOCKING_REQUEST_EVENT_V1 as blockingRequest,
  ASK_USER_BLOCKING_RESPONSE_EVENT_V1 as blockingResponse,
  ASK_USER_DEFERRED_REQUEST_EVENT_V1 as deferredRequest,
  ASK_USER_DEFERRED_RESPONSE_EVENT_V1 as deferredResponse,
  ASK_USER_CORRELATION_PATTERN_V1,
  ASK_USER_PROVIDER_ACCEPT_TIMEOUT_MS_V1,
  isDeferredProviderRequestV1,
} from "../../core/src/ask-user-v1.ts";

class Bus {
  listeners = new Map();
  on(name, callback) {
    const callbacks = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, callbacks);
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  }
  emit(name, value) {
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback(value);
  }
  count(name) { return this.listeners.get(name)?.size ?? 0; }
}

function host() {
  return {
    events: new Bus(), tools: [], hooks: new Map(),
    registerTool(tool) { this.tools.push(tool); },
    on(name, callback) { this.hooks.set(name, [...(this.hooks.get(name) ?? []), callback]); },
    async lifecycle(name, event, ctx) {
      for (const callback of this.hooks.get(name) ?? []) await callback(event, ctx);
    },
  };
}
const context = (id = "session-a") => ({ sessionManager: { getSessionId: () => id } });
const ask = () => ({
  operation: "ask", mode: "deferred", question: "Which color?", reason: "Independent tests can continue.",
  class: "preference", response: { kind: "text" },
});
const blockingAsk = () => ({
  operation: "ask", mode: "blocking", question: "Approve this action?",
  response: { kind: "single_or_text", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  timeoutMs: 60_000,
});
const reply = (request, state, extra = {}) => ({ schemaVersion: 1, correlationId: request.correlationId, mode: request.mode, state, ...extra });
const receipt = (request) => reply(request, request.operation === "ask" ? "queued" : "cancelled", {
  operation: request.operation, questionId: "qst_11111111-1111-4111-8111-111111111111", displayId: "Q-1", revision: request.operation === "ask" ? 1 : 2,
});
function facade(pi = host()) {
  registerAskUserFacadeV1(pi);
  const tool = pi.tools.find((tool) => tool.name === "ask_user");
  return { pi, tool, execute: (input = ask(), id = "call-a", ctx = context(), signal) => tool.execute(id, input, signal, undefined, ctx) };
}
function queuedProvider(pi, seen = []) {
  pi.events.on(deferredRequest, (request) => {
    assert.ok(isDeferredProviderRequestV1(request));
    seen.push(request);
    pi.events.emit(deferredResponse, reply(request, "accepted"));
    pi.events.emit(deferredResponse, receipt(request));
  });
  return seen;
}

test("V1 enablement registers exactly one question tool and keeps blocking provider; disabled retains legacy", () => {
  const enabled = host();
  registerGroundedDialog(enabled, { askUserV1Enabled: true });
  assert.deepEqual(enabled.tools.map((tool) => tool.name), ["ask_user"]);
  assert.equal(enabled.events.count(blockingRequest), 1);
  const disabled = host();
  registerGroundedDialog(disabled, { askUserV1Enabled: false });
  assert.deepEqual(disabled.tools.map((tool) => tool.name), ["ask_user_question"]);
  assert.equal(disabled.events.count(blockingRequest), 1);
});

test("deferred correlation is stable across recreation, separated by session/call and independent of content", async () => {
  const first = facade();
  const seen = queuedProvider(first.pi);
  await first.execute();
  await first.execute();
  assert.equal(seen[0].correlationId, seen[1].correlationId);
  assert.match(seen[0].correlationId, ASK_USER_CORRELATION_PATTERN_V1);
  assert.ok(!seen[0].correlationId.includes("session-a"));
  const reloaded = facade();
  const reloadedSeen = queuedProvider(reloaded.pi);
  await reloaded.execute();
  assert.equal(seen[0].correlationId, reloadedSeen[0].correlationId);
  await reloaded.execute(ask(), "call-a", context("session-b"));
  await reloaded.execute(ask(), "call-b");
  assert.notEqual(seen[0].correlationId, reloadedSeen[1].correlationId);
  assert.notEqual(seen[0].correlationId, reloadedSeen[2].correlationId);
  await assert.rejects(first.execute({ ...ask(), question: "Changed?" }), /ASK_USER_CORRELATION_CONFLICT/);
  const changed = facade();
  let changedRequest;
  changed.pi.events.on(deferredRequest, (request) => {
    changedRequest = request;
    changed.pi.events.emit(deferredResponse, reply(request, "rejected", { error: {
      code: "ASK_USER_CORRELATION_CONFLICT", message: "Durable content mismatch.", retryable: false,
    } }));
  });
  await assert.rejects(changed.execute({ ...ask(), question: "Changed?" }), /Durable content mismatch/);
  assert.equal(changedRequest.correlationId, seen[0].correlationId);
});

test("deferred requires stable session context without dispatch", async () => {
  const f = facade();
  let calls = 0;
  f.pi.events.on(deferredRequest, () => calls++);
  for (const ctx of [{}, context(""), { sessionManager: { getSessionId: () => undefined } }]) {
    await assert.rejects(f.execute(ask(), "call-a", ctx), /requires a stable Pi session ID/);
  }
  await assert.rejects(f.execute(ask(), "", context()), /requires a stable Pi session ID/);
  assert.equal(calls, 0);
});

test("neutral public schema rejects deferred authorization with actionable execution guidance", async () => {
  const f = facade();
  assert.doesNotMatch(f.tool.description, /Signals/);
  assert.match(f.tool.promptGuidelines.join("\n"), /mode=blocking for authorization|mode=blocking instead/);
  assert.match(f.tool.promptGuidelines.join("\n"), /elapsed time or agent settlement/);
  const forbidden = { ...ask(), class: "authorization" };
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, forbidden), false);
  await assert.rejects(f.execute(forbidden), /Use ask_user with mode=blocking for authorization/);
  // The shared provider wire contract remains unchanged.
  assert.equal(isDeferredProviderRequestV1({ ...forbidden, schemaVersion: 1,
    correlationId: "ask_11111111-1111-4111-8111-111111111111", recommendedOptionIds: [],
    affectedWork: [], continuingWork: [], attachments: [],
  }), true);
});

test("missing deferred provider times out and removes listener and abort subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = facade();
  const controller = new AbortController();
  const pending = assert.rejects(f.execute(ask(), "call-a", context(), controller.signal), /ASK_USER_PROVIDER_UNAVAILABLE/);
  assert.equal(f.pi.events.count(deferredResponse), 1);
  t.mock.timers.tick(ASK_USER_PROVIDER_ACCEPT_TIMEOUT_MS_V1);
  await pending;
  assert.equal(f.pi.events.count(deferredResponse), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("accepted deferred provider has a fixed terminal deadline; repeated acceptance does not extend it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = facade();
  const controller = new AbortController();
  let request;
  f.pi.events.on(deferredRequest, (value) => {
    request = value;
    f.pi.events.emit(deferredResponse, reply(value, "accepted"));
  });
  const pending = assert.rejects(f.execute(ask(), "call-a", context(), controller.signal), /timed out.*outcome is unknown/);
  t.mock.timers.tick(ASK_USER_DEFERRED_TERMINAL_TIMEOUT_MS - 1);
  assert.equal(f.pi.events.count(deferredResponse), 1);
  f.pi.events.emit(deferredResponse, reply(request, "accepted"));
  t.mock.timers.tick(1);
  await pending;
  assert.equal(f.pi.events.count(deferredResponse), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  f.pi.events.emit(deferredResponse, receipt(request)); // Late reply is ignored.
});

test("pre-abort never dispatches; abort before or after acceptance cleans up without issuing cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["pre", "before-accepted", "accepted"]) {
    const f = facade();
    const controller = new AbortController();
    const requests = [];
    f.pi.events.on(deferredRequest, (request) => {
      requests.push(request);
      if (phase === "accepted") f.pi.events.emit(deferredResponse, reply(request, "accepted"));
    });
    if (phase === "pre") controller.abort();
    const pending = assert.rejects(f.execute(ask(), "call-a", context(), controller.signal), /aborted.*outcome is unknown/);
    controller.abort();
    await pending;
    assert.equal(requests.length, phase === "pre" ? 0 : 1);
    assert.ok(requests.every((request) => request.operation === "ask"));
    assert.equal(f.pi.events.count(deferredResponse), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    t.mock.timers.tick(ASK_USER_DEFERRED_TERMINAL_TIMEOUT_MS + 1);
  }
});

test("queued/cancelled replies settle with exact wire normalization and cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = facade();
  const requests = queuedProvider(f.pi);
  const controller = new AbortController();
  const queued = await f.execute({ ...ask(), escalationPolicy: "never" }, "ask", context(), controller.signal);
  assert.equal(queued.details.status, "queued");
  assert.equal(requests[0].blockingPolicy, "never");
  assert.equal("escalationPolicy" in requests[0], false);
  const cancelled = await f.execute({ operation: "cancel", mode: "deferred", id: "Q-1", expectedRevision: 1, reason: "No longer needed." }, "cancel", context(), controller.signal);
  assert.equal(cancelled.details.status, "cancelled");
  assert.equal(f.pi.events.count(deferredResponse), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  t.mock.timers.tick(ASK_USER_DEFERRED_TERMINAL_TIMEOUT_MS + 1);
});

test("invalid, rejected and throwing providers terminate deferred dispatch with cleanup", async () => {
  for (const variant of ["invalid", "rejected", "throw", "out-of-order"]) {
    const f = facade();
    const controller = new AbortController();
    f.pi.events.on(deferredRequest, (request) => {
      if (variant === "throw") throw new Error("provider exception");
      const value = variant === "invalid" ? { correlationId: request.correlationId }
        : variant === "out-of-order" ? receipt(request)
        : reply(request, "rejected", { error: { code: "ASK_USER_PROVIDER_FAILURE", message: "Bounded provider failure.", retryable: true } });
      f.pi.events.emit(deferredResponse, value);
    });
    await assert.rejects(f.execute(ask(), "call-a", context(), controller.signal), /ASK_USER_PROVIDER_(UNHEALTHY|FAILURE)/);
    assert.equal(f.pi.events.count(deferredResponse), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("blocking correlation and lifecycle remain unchanged without session context or deferred deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = facade();
  const requests = [];
  f.pi.events.on(blockingRequest, (request) => {
    requests.push(request);
    f.pi.events.emit(blockingResponse, reply(request, "accepted"));
    f.pi.events.emit(blockingResponse, reply(request, "open"));
  });
  const pending = f.execute(blockingAsk(), "blocking", {});
  t.mock.timers.tick(ASK_USER_DEFERRED_TERMINAL_TIMEOUT_MS * 2);
  assert.equal(f.pi.events.count(blockingResponse), 1);
  f.pi.events.emit(blockingResponse, reply(requests[0], "answered", { answer: { kind: "option", optionId: "yes" } }));
  assert.equal((await pending).details.status, "answered");
  const retry = f.execute(blockingAsk(), "blocking", {});
  assert.equal(requests[0].correlationId, requests[1].correlationId);
  f.pi.events.emit(blockingResponse, reply(requests[1], "timed_out"));
  assert.equal((await retry).details.status, "timed_out");
  assert.equal(f.pi.events.count(blockingResponse), 0);
});

test("enabled Dialog actual blocking provider answers and retains requested user timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pi = host();
  registerGroundedDialog(pi, { askUserV1Enabled: true });
  const ctx = { ...context(), hasUI: true, ui: { select: async (_title, options) => options[0] } };
  await pi.lifecycle("session_start", {}, ctx);
  const answered = await pi.tools[0].execute("answer", blockingAsk(), undefined, undefined, ctx);
  assert.deepEqual(answered.details.answer, { kind: "option", optionId: "yes" });
  ctx.ui.select = () => new Promise(() => {});
  const pending = pi.tools[0].execute("timeout", blockingAsk(), undefined, undefined, ctx);
  t.mock.timers.tick(59_999);
  assert.equal(pi.events.count(blockingResponse), 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).details.status, "timed_out");
  await pi.lifecycle("session_shutdown", { reason: "reload" }, ctx);
  assert.equal(pi.events.count(blockingRequest), 0);
});

test("V1.1 allows only next-natural-turn delivery and no automatic escalation", async () => {
  const f = facade();
  const requests = queuedProvider(f.pi);
  for (const mode of ["steer", "followUp"]) {
    const input = { ...ask(), deliveryMode: mode };
    assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, input), false);
    await assert.rejects(f.execute(input), /Omit deliveryMode or use nextTurn/);
  }
  const escalating = { ...ask(), escalationPolicy: "when_agent_settles" };
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, escalating), false);
  await assert.rejects(f.execute(escalating), /Omit escalationPolicy or use never/);
  assert.equal(requests.length, 0);
  const supported = { ...ask(), deliveryMode: "nextTurn", escalationPolicy: "never" };
  assert.equal(Value.Check(ASK_USER_PARAMETERS_V1, supported), true);
  await f.execute(supported, "explicit-timing");
  await f.execute(ask(), "default-timing");
  assert.equal(requests[0].deliveryMode, "nextTurn");
  assert.equal(requests[0].blockingPolicy, "never");
  assert.equal(requests[1].deliveryMode, undefined);
  assert.equal(requests[1].blockingPolicy, undefined);
  assert.match(f.tool.description, /safe idle for the next natural turn/);
  assert.match(f.tool.promptGuidelines.join("\n"), /no steering or follow-up response is started automatically/);
});
