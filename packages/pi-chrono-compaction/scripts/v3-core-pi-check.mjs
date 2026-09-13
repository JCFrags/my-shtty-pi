#!/usr/bin/env node
// @ts-nocheck
// Focused offline Pi check. The lifecycle boundary and provider states are
// synthetic. Command dispatch, replacement, persistence and restart use real Pi.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, root] = process.argv.slice(2);
if (!isAbsolute(runtime ?? "") || !isAbsolute(root ?? "")) throw Error("Usage: node scripts/v3-core-pi-check.mjs <built-extension.js> <new-private-root>");
await stat(runtime);
await mkdir(root, { mode: 0o700 });
const agent = join(root, "agent"), sessions = join(root, "sessions"), scheduler = join(root, "scheduler");
for (const path of [agent, sessions, scheduler]) { await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700); }
const write = (path, text) => writeFile(path, text, { mode: 0o600, flag: "wx" });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const source = join(sessions, "source.jsonl");
await write(source, [
  { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root },
  { type: "custom", id: "padding", parentId: null, customType: "synthetic-padding", data: "x".repeat(1024 * 1024) },
  { type: "message", id: "request", parentId: "padding", message: { role: "user", content: "Goal: retain the exact source and unfinished work.", timestamp: Date.now() } },
  { type: "message", id: "answer", parentId: "request", message: { role: "assistant", content: [{ type: "text", text: "Ready at a safe idle boundary." }],
    api: "offline-fixture", provider: "fixture", model: "none", usage, stopReason: "stop", timestamp: Date.now() } },
].map(value => JSON.stringify(value)).join("\n") + "\n");
const bridge = join(agent, "core-check.mjs");
await write(bridge, `import chrono from ${JSON.stringify(pathToFileURL(runtime).href)};
export default function coreCheck(pi) {
  const hooks = new Map(), tools = new Map();
  chrono(new Proxy(pi, { get(target, key) {
    if (key === "on") return (name, hook) => { hooks.set(name, hook); target.on(name, hook); };
    if (key === "registerTool") return tool => { tools.set(tool.name, tool); target.registerTool(tool); };
    if (key === "registerCommand") return (name, command) => target.registerCommand(name, { ...command,
      handler: async (...args) => { try { return await command.handler(...args); } catch (error) { throw Error(error.stack ?? String(error)); } } });
    return Reflect.get(target, key);
  } }), { schedulerDirectory: ${JSON.stringify(scheduler)} });
  let busy = true, states = {}, restored = 0;
  for (const name of ["notes", "todo", "workplan", "process"]) pi.registerTool({ name, label: name, description: "Offline fixture provider",
    parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "fixture" }] }) });
  pi.events.on("grounded:session-transition-readiness:v1", request => request.accept({ protocolVersion: 1, runningProcesses: busy ? 1 : 0, openSessions: 0 }));
  pi.on("session_start", (_event, ctx) => {
    states = {}; restored = 0;
    if (!ctx.sessionManager.getHeader()?.parentSession) for (const provider of ["notes", "todo", "workplan"])
      states[provider] = { marker: "active-" + provider, body: provider[0].repeat(3 * 1024 * 1024) };
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === "grounded-state-checkpoint-v1") {
      states[entry.data.provider] = entry.data.state; restored++;
    }
  });
  pi.events.on("grounded-state:checkpoint-request-v1", request => {
    for (const provider of ["notes", "todo", "workplan"]) pi.events.emit("grounded-state:checkpoint-response-v1", {
      version: 1, requestId: request.requestId, provider, ok: true,
      entry: { customType: "grounded-state-checkpoint-v1", data: { version: 1, provider, sourceSessionId: request.sourceSessionId,
        sourceLeafId: request.sourceLeafId, state: states[provider] } }
    });
  });
  pi.registerCommand("core-check", { handler: async (args, ctx) => {
    if (args === "settle-busy" || args === "settle-ready") { busy = args === "settle-busy"; await hooks.get("agent_settled")({}, ctx); }
    const status = (await tools.get("history_status").execute("fixture", {}, undefined, undefined, ctx)).details;
    ctx.ui.notify("CORE_CHECK:" + JSON.stringify({ status, restored, markers: Object.values(states).map(value => value.marker),
      lengths: Object.values(states).map(value => value.body.length), sessionFile: ctx.sessionManager.getSessionFile() }), "info");
  } });
  pi.registerCommand("core-check-quit", { handler: async (_args, ctx) => ctx.shutdown() });
}
`);
await write(join(agent, "settings.json"), JSON.stringify({ extensions: [bridge] }) + "\n");
await write(join(agent, "chrono.json"), JSON.stringify({ rolloverSourceBytes: 1024 * 1024 }) + "\n");

class Rpc {
  constructor(path) {
    const env = Object.fromEntries(["PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    // Select installed model metadata for the context ceiling, with no auth.
    this.child = spawn("pi", ["--mode", "rpc", "--offline", "--provider", "anthropic", "--model", "claude-opus-4-8",
      "--no-builtin-tools", "--session", path, "--session-dir", sessions,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], { cwd: root, stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, HOME: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PI_CHRONO_CONFIG_PATH: join(agent, "chrono.json"), PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false", PI_CHRONO_CATALOG_SHADOW: "false",
        PI_CHRONO_ROLLUP_SHADOW: "false", PI_CHRONO_VALUE_WORKER_MODE: "off" } });
    this.sequence = 0; this.pending = new Map(); this.notices = []; this.errors = []; this.buffer = ""; this.stderr = "";
    this.closed = new Promise(resolve => this.child.once("close", resolve));
    this.child.stderr.on("data", bytes => { this.stderr = (this.stderr + bytes).slice(-8192); });
    this.child.stdout.on("data", bytes => {
      this.buffer += bytes;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "extension_error") this.errors.push(event);
        if (event.type === "extension_ui_request" && event.method === "notify") this.notices.push(event.message);
        const call = this.pending.get(event.id);
        if (event.type === "response" && call) { this.pending.delete(event.id); clearTimeout(call.timer);
          event.success ? call.resolve(event.data) : call.reject(Error(event.error)); }
      }
    });
  }
  send(type, extra = {}, timeoutMs = 90_000) {
    return new Promise((resolve, reject) => {
      const id = String(++this.sequence), timer = setTimeout(() => { this.pending.delete(id); reject(Error("RPC timeout: " + this.stderr)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
  }
  async probe(action = "status") {
    await this.send("prompt", { message: "/core-check " + action });
    const line = this.notices.filter(value => value.startsWith("CORE_CHECK:")).at(-1);
    assert.ok(line, this.stderr); assert.deepEqual(this.errors, []); return JSON.parse(line.slice("CORE_CHECK:".length));
  }
  async stop() {
    try { await this.send("prompt", { message: "/core-check-quit" }, 5000); } catch {}
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 5000);
    await this.closed; clearTimeout(timer);
    for (const value of this.pending.values()) clearTimeout(value.timer);
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let rpc = new Rpc(source);
try {
  const first = await rpc.probe();
  assert.equal(first.status.composition.mode, "v3");
  assert.ok(first.status.logical, "normal startup must adopt without a canary or manual enable command");
  await rpc.probe("settle-busy"); await sleep(50);
  const guarded = await rpc.probe();
  assert.equal(guarded.sessionFile, source);
  assert.ok(guarded.status.automaticRollover.blockers.includes("grounded-process-active"));
  await rpc.probe("settle-ready");
  let current, deadline = Date.now() + 80_000;
  do {
    await sleep(250); current = await rpc.send("get_state");
    if (current.sessionFile !== source) break;
    const refusal = rpc.notices.find(value => value.startsWith("Logical session command refused:"));
    if (refusal) throw Error(refusal);
    if (Date.now() > deadline) throw Error("Automatic rollover timed out: " + JSON.stringify((await rpc.probe()).status));
  } while (true);
  // Do not create a command context while withSession is activating and reloading.
  await sleep(1000);
  const switched = await rpc.probe();
  assert.equal(switched.restored, 3);
  assert.deepEqual(switched.markers.sort(), ["active-notes", "active-todo", "active-workplan"]);
  assert.deepEqual(switched.lengths, [3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]);
  const replacement = switched.sessionFile, replacementBytes = (await stat(replacement)).size;
  assert.ok(replacementBytes > 8 * 1024 * 1024, "large checkpoint bootstrap must exercise the growth threshold");
  const records = (await readFile(replacement, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records[0].parentSession, source);
  assert.equal(records.filter(entry => entry.customType === "grounded-state-checkpoint-v1").length, 3);
  assert.equal(records.filter(entry => entry.customType === "chrono-logical-continuation").length, 1);
  assert.ok(records.length - 1 <= 8);
  assert.ok(!records.some(entry => entry.message?.role === "user"), "automatic command text must never enter the model context");
  await rpc.probe("settle-ready"); await sleep(250);
  assert.equal((await rpc.probe()).sessionFile, replacement, "bootstrap bytes must not immediately trigger another rollover");
  const baseline = (await rpc.probe()).status.automaticRollover.bootstrapBytes;
  await rpc.stop(); rpc = new Rpc(replacement);
  const reopened = await rpc.probe("settle-ready"); await sleep(250);
  assert.equal(reopened.restored, 3);
  assert.equal((await rpc.probe()).sessionFile, replacement);
  assert.equal(reopened.status.automaticRollover.bootstrapBytes, baseline, "restart must preserve the bootstrap growth baseline");
  console.log(JSON.stringify({ status: "passed", boundary: "synthetic agent_settled with real command context", defaultV3: true,
    providerCalls: 0, processGuardDeferral: true, registeredCommandDispatch: true, physicalFileChanged: true,
    sourceRetained: (await stat(source)).isFile(), bootstrapEntries: records.length - 1, checkpointBytes: 9 * 1024 * 1024,
    fixtureProviderStatesPreserved: 3, checkpointRestartVerified: true, bootstrapGrowthThresholdVerified: true,
    ownerProviderRestore: "requires integrated Grounded tools check" }));
} finally { await rpc.stop(); }
