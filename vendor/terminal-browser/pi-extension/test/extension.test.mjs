import assert from "node:assert/strict";
import test from "node:test";

import extension, { observationResult } from "../dist/extension.js";
import { BrowserStartupError } from "../dist/client.js";
import menu from "../dist/menu.js";
import { AUTO_TYPE, PiBrowserBridge, CompanionClient } from "../dist/bridge.js";
import { ASSOCIATION_TYPE, readAssociation } from "../dist/owner-binding.js";
import { writeFile } from "node:fs/promises";

function fixtureContext() {
  const data = { schemaVersion: 1, piSessionId: "session-a", piSessionFile: "/tmp/pi-session-a.jsonl",
    owner: { kind: "native", sessionId: "browser-task", projectDir: "/tmp/project" } };
  const branch = [{ type: "custom", customType: ASSOCIATION_TYPE, id: "association", data }];
  return { cwd: "/tmp/project", hasUI: true, mode: "tui", model: { input: ["text", "image"] }, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getSessionId: () => "session-a", getSessionFile: () => "/tmp/pi-session-a.jsonl", getSessionDir: () => "/tmp", getBranch: () => branch } };
}

async function registeredTools(client = undefined) {
  const tools = [];
  const events = [];
  await extension({ registerTool(tool) { tools.push(tool); }, on(event, handler) { assert.equal(typeof handler, "function"); events.push(event); } }, client);
  assert.deepEqual(events, [], "tools resource does not own lifecycle or receipts");
  return tools;
}

test("registered browser_open exposes complete structured startup diagnostics in the normal error message", async () => {
  const report = {
    version: 1, attempt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "failed",
    code: "PROFILE_OWNERSHIP_UNCERTAIN", message: "original ownership refusal", pane: "w1:p8",
    exitCode: 1, signal: null, doctorCommand: "terminal-browser doctor --json",
    cleanup: { status: "exited", nextStep: "Run terminal-browser doctor --json before explicit recovery." },
  };
  const tools = await registeredTools({ open: async () => { throw new BrowserStartupError(report); } });
  const open = tools.find((tool) => tool.name === "browser_open");
  const ctx = fixtureContext();
  await assert.rejects(open.execute("call", {}, undefined, undefined, ctx), (error) => {
    assert.deepEqual(JSON.parse(error.message), report);
    return true;
  });
});

test("visual tool results emit native image content without image data in text or details", () => {
  const imageData = Buffer.from("image bytes").toString("base64");
  const value = observationResult({
    url: "https://example.test/",
    visual: { width: 10, height: 8, bytes: 11 },
    image: { data: imageData, mimeType: "image/png" },
  });
  assert.deepEqual(value.content[1], { type: "image", data: imageData, mimeType: "image/png" });
  assert.equal(value.content[0].text.includes(imageData), false);
  assert.equal(JSON.stringify(value.details).includes(imageData), false);
});

test("extension registers only the five compact browser tools with sequential cache access", async () => {
  const tools = await registeredTools();
  assert(tools.every(tool => tool.executionMode === "sequential"));
  assert.deepEqual(tools.map((tool) => tool.name), [
    "browser_open",
    "browser_tabs",
    "browser_observe",
    "browser_act",
    "browser_control",
  ]);
  const handlers = new Map();
  let command;
  menu({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => { assert.equal(name, "browser"); command = value; } },
    { status: () => { throw new Error("factory must not call CLI"); } });
  assert(handlers.has("session_start") && handlers.has("session_shutdown"));
  const ctx = fixtureContext();
  ctx.ui.select = async () => undefined;
  await command.handler("", ctx); // Cancel requires no editor method and no browser side effect.
  const otherSession = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "forked" } };
  assert.equal(readAssociation(otherSession), null);
  assert.equal(readAssociation({ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => "/tmp/copied.jsonl" } }), null);
});

test("blocking options use browser_control and reject implicit or unrelated site changes", async () => {
  let received;
  const control = (await registeredTools({ blocking: async (_context, request) => { received = request; return { enabled: true }; } })).find(tool => tool.name === "browser_control");
  const ctx = fixtureContext();
  await control.execute("call", { action: "blocking", blocking_action: "allow-site", site: "example.test", context_id: 7 }, undefined, undefined, ctx);
  assert.deepEqual(received, { action: "allow-site", site: "example.test", contextId: 7 });
  await assert.rejects(control.execute("call", { action: "blocking", blocking_action: "allow-site" }, undefined, undefined, ctx), /site is required/);
  await assert.rejects(control.execute("call", { action: "blocking", blocking_action: "status", site: "example.test" }, undefined, undefined, ctx), /site is required only/);
  await assert.rejects(control.execute("call", { action: "resume", context_id: 7 }, undefined, undefined, ctx), /require action blocking/);
});

test("tool schemas keep browser keys, sockets, observation ids, and control epochs internal", async () => {
  const tools = await registeredTools();
  const text = JSON.stringify(tools.map((tool) => tool.parameters));
  for (const hidden of ["browser_key", "socket", "observation_id", "control_epoch", "controlEpoch"]) {
    assert.equal(text.includes(hidden), false);
  }
  const act = tools.find((tool) => tool.name === "browser_act");
  assert.deepEqual(act.parameters.properties.action.enum, [
    "upload", "click", "hover", "drag", "type", "press_key", "scroll", "navigate", "get_url", "wait_for", "dialog",
  ]);
  const observe = tools.find((tool) => tool.name === "browser_observe");
  assert.deepEqual(observe.parameters.properties.view.enum, ["semantic", "visual", "both"]);
  assert.deepEqual(observe.parameters.properties.scope.enum, ["viewport", "element"]);
});

test("dialog action requires an ID and explicit decision without a model-supplied epoch", async () => {
  const act = (await registeredTools()).find(tool => tool.name === "browser_act");
  const ctx = fixtureContext();
  for (const params of [{ action: "dialog", accept: true }, { action: "dialog", dialog_id: "pending" }]) {
    await assert.rejects(act.execute("call", params, undefined, undefined, ctx), /dialog requires dialog_id and accept/);
  }
  assert.equal(act.parameters.additionalProperties, false);
  assert.equal("control_epoch" in act.parameters.properties, false);
  assert.equal(act.description.includes("control_epoch"), false);
});

test('native locator schemas are bounded and keep all five tool names', async () => {
  const tools = await registeredTools();
  assert.equal(tools.length, 5);
  const properties = tools.find(tool => tool.name === 'browser_act').parameters.properties;
  for (const field of ['locator', 'from_locator', 'to_locator']) {
    assert.equal(properties[field].minItems, 1);
    assert.equal(properties[field].maxItems, 16);
  }
  assert(properties.condition.enum.includes('actionable'));
  assert.equal(tools.find(tool => tool.name === 'browser_observe').parameters.properties.filter.maxItems, 16);
  const act = tools.find(tool => tool.name === 'browser_act');
  for (const target of [{ ref: "e1" }, { locator: [{ kind: "css", value: "div" }] }, { x: 2, y: 3 }]) {
    await assert.rejects(act.execute("call", { action: "scroll", dy: 20, ...target }, undefined, undefined, fixtureContext()), /scroll does not accept target fields/);
  }
  const control = tools.find(tool => tool.name === 'browser_control');
  assert.deepEqual(control.parameters.properties.mode.enum, ['agent', 'human', 'shared']);
});

test("frame selection stays concise without backend frame or session identifiers", async () => {
  const tools = await registeredTools();
  for (const name of ["browser_observe", "browser_act"]) {
    const properties = tools.find(tool => tool.name === name).parameters.properties;
    assert.equal(properties.frame.pattern, "^(main|f[1-9][0-9]{0,8})$");
    for (const hidden of ["frameId", "sessionId", "executionContextId", "uniqueContextId", "loaderId"]) assert.equal(hidden in properties, false);
  }
});

test("passive receiver coalesces at safe boundaries; only explicit shares request replies", async () => {
  const ctx = fixtureContext();
  const messages = [], users = [], calls = [];
  let pending, ready;
  const nextWait = () => pending ? Promise.resolve(pending) : new Promise(resolve => { ready = resolve; });
  const status = { schemaVersion: 1, browserSessionKey: "browser-1", runtimeInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence: 0, binding: null, receiverOnline: true, pendingShareId: null,
    mode: "shared", controlEpoch: 2, updates: { enabled: true, active: true, description: "Shared screenshots; no reply" } };
  const client = new CompanionClient(async request => {
    calls.push(request);
    const args = request.args;
    const flag = name => args[args.indexOf(name) + 1];
    if (args[2] === "status") return structuredClone(status);
    assert.equal(flag("--browser"), status.browserSessionKey);
    assert.equal(flag("--runtime-instance"), status.runtimeInstanceId);
    if (args[2] === "bind") {
      status.binding = { bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", receiverKind: "pi",
        receiverSessionId: flag("--receiver-session"), receiverGeneration: flag("--receiver-generation") };
      return structuredClone(status);
    }
    if (args[2] === "unbind") return { unbound: true, ...status };
    assert.equal(args[2], "wait");
    return new Promise((resolve, reject) => {
      const abort = () => { if (pending?.request === request) pending = undefined; reject(new Error("cancelled")); };
      request.context.signal.addEventListener("abort", abort, { once: true });
      pending = { request, resolve: value => { request.context.signal.removeEventListener("abort", abort); pending = undefined; resolve(value); } };
      ready?.(pending); ready = undefined;
    });
  });
  const bridge = new PiBrowserBridge({ sendMessage: (value, options) => messages.push({ value, options }), sendUserMessage: (value, options) => users.push({ value, options }) }, client);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZX0AAAAASUVORK5CYII=", "base64");
  const emit = async (sequence, kind = "auto-visual", extra = {}) => {
    const waiter = await nextWait();
    const event = { schemaVersion: 1, changed: true, browserSessionKey: status.browserSessionKey, runtimeInstanceId: status.runtimeInstanceId,
      ...status.binding, sequence, replacedCount: 0, kind, contextId: 7, contextKind: "tab", documentGeneration: 1, viewRevision: sequence,
      reasons: ["visual"], mode: "shared", controlEpoch: 2, capturedAt: Date.now(), settled: true,
      ...(kind === "auto-visual" ? { visual: { mimeType: "image/png", width: 1, height: 1, bytes: png.length } } : {}), ...extra };
    status.mode = event.mode;
    status.controlEpoch = event.controlEpoch;
    status.sequence = sequence;
    status.updates.active = event.mode === "shared" && status.updates.enabled;
    if (event.visual) await writeFile(waiter.request.args[waiter.request.args.indexOf("--image-output") + 1], png, { mode: 0o600, flag: "wx" });
    waiter.resolve(event);
    await nextWait();
  };
  await bridge.connect(ctx);
  await emit(1);
  await emit(2);
  await emit(3);
  assert.equal(messages.filter(item => item.value.customType === AUTO_TYPE).length, 1, "one idle append");
  assert(messages.every(item => item.options.triggerTurn === false));
  assert.equal(users.length, 0);
  const prompt = bridge.beforePrompt(ctx);
  assert.equal(prompt.message.details.sequence, 3, "ordinary request receives newest pending capture");
  ctx.isIdle = () => false;
  await emit(4);
  await emit(5);
  const boundary = bridge.atTurnEnd(ctx);
  assert.equal(boundary.entries[0].details.sequence, 5);
  assert.equal("continue" in boundary, false);
  bridge.suppressAutomatic();
  status.mode = "human";
  status.controlEpoch = 3;
  status.updates.active = false;
  await bridge.refresh(ctx, true); // A completed Human selection must not block a later native Shared choice.
  await emit(6, "control", { mode: "human", controlEpoch: 3, reasons: ["updates-stopped"] });
  assert.equal(bridge.takeAutomatic(ctx), undefined);
  const shareId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await emit(7, "human-share", { mode: "human", controlEpoch: 3, shareId, url: "https://example.test/", title: "/not-a-command" });
  await emit(8, "human-share", { mode: "human", controlEpoch: 3, shareId, url: "https://example.test/", title: "/not-a-command" });
  assert.equal(users.length, 1, "attempt is deduplicated before void sendUserMessage");
  assert.deepEqual(users[0].options, { deliverAs: "followUp", expandPromptTemplates: false });
  assert.match(users[0].value[0].text, /I explicitly shared/);
  assert(!users[0].value[0].text.includes("/not-a-command"));
  assert.equal(bridge.filterContext([{ role: "custom", ...prompt.message }, { role: "user", content: "keep" }], ctx).length, 1);
  ctx.model = { input: ["text"] };
  await emit(9, "auto-visual", { controlEpoch: 4, reasons: ["follow-start"] });
  const notice = bridge.atTurnEnd(ctx).entries[0];
  assert(notice.content.every(part => part.type !== "image"));
  assert(notice.content.some(part => /does not declare image support/.test(part.text)));
  status.updates.enabled = false;
  await emit(10, "control", { controlEpoch: 4, reasons: ["updates-stopped"] });
  assert.equal(bridge.status.updates.enabled, false, "native Off replaces the cached preference");
  assert.equal(bridge.filterContext([{ role: "custom", ...notice }], ctx).length, 0);
  status.updates.enabled = true;
  await emit(11, "auto-visual", { controlEpoch: 4, reasons: ["follow-start"] });
  assert.equal(bridge.atTurnEnd(ctx).entries[0].details.sequence, 11, "native On resumes passive updates, not replies");
  await bridge.disconnect();
  assert.equal(bridge.isConnected(ctx), false);
  assert.equal(users.length, 1);
  assert.equal(calls.at(-1).args[2], "unbind");
  const count = calls.length;
  ctx.sessionManager.getSessionId = () => "new-conversation";
  await bridge.connect(ctx);
  assert.equal(calls.length, count, "inherited association cannot start a receiver for another session");
});

test("menu Send pins the confirmed document, and owned Close shows the complete bounded scope", async () => {
  const ctx = fixtureContext();
  let command, choices = ["Send current page", "Viewport screenshot"];
  const confirmations = [], requests = [];
  ctx.ui.select = async () => choices.shift();
  ctx.ui.confirm = async (title, text) => { confirmations.push({ title, text }); return true; };
  const status = { browserSessionKey: "browser-1", runtimeInstanceId: "runtime-1", mode: "human", receiverOnline: true, pendingShareId: null, updates: { enabled: true } };
  const bridge = { status, isConnected: () => true, refresh: async () => status, suppressAutomatic() {},
    bindingFlags: () => ["--binding", "binding-1", "--receiver-generation", "generation-1"],
    command: async (_ctx, args) => {
      requests.push(args);
      if (args[2] === "capture") return { contextId: 7, documentGeneration: 4, url: "https://example.test/", title: "Example" };
      if (args[2] === "share") return { status: "queued", shareId: "share-1" };
      if (args.includes("--preview")) return { revision: "revision-1", contexts: [{ contextId: 7, contextKind: "tab", title: "Example" }, { contextId: 9, contextKind: "popup", title: "Popup" }], transfers: [{ id: "transfer-1", contextId: 9, state: "progressing" }] };
      return { status: "decision-required", remainingContextIds: [7, 9] };
    } };
  menu({ on() {}, registerCommand: (_name, value) => { command = value; } }, {}, bridge);
  await command.handler("", ctx);
  const share = requests.find(args => args[2] === "share");
  assert.deepEqual(share.slice(5, 9), ["--context", "7", "--document-generation", "4"]);
  assert.match(confirmations[0].text, /Your draft is unchanged/);
  choices = ["Close owned browser"];
  await command.handler("", ctx);
  assert.match(confirmations[1].text, /tab 7: "Example"/);
  assert.match(confirmations[1].text, /popup 9: "Popup"/);
  assert.match(confirmations[1].text, /"transfer-1" \(context 9, "progressing"\)/);
  assert.deepEqual(requests.at(-1), ["session", "human", "close", "--confirm", "revision-1"]);
});
