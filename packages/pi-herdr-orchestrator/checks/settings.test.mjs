import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the real Pi component and runtime without sending model prompts.
const require = createRequire(import.meta.url);
let tuiPath;
try {
  tuiPath = require.resolve("@earendil-works/pi-tui");
} catch {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim();
  tuiPath = createRequire(join(globalRoot, "@earendil-works/pi-coding-agent/package.json"))
    .resolve("@earendil-works/pi-tui");
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@earendil-works/pi-tui"
      ? { url: pathToFileURL(tuiPath).href, shortCircuit: true }
      : next(specifier, context);
  },
});
const { default: extension } = await import("../dist/extensions/pi-herdr-orchestrator.js");
const { openAgentSettings } = await import("../dist/src/pi/agent-settings.js");
hooks.deregister();

test("managed child lifecycle restores exact channel and explicit collection", { timeout: 30_000 }, async () => {
  const sdkRoot = process.env.ORCHESTRATOR_TEST_SDK_ROOT;
  const root = await mkdtemp(join(tmpdir(), "orch-child-binding-"));
  const sessions = new Set();
  // This Node test process is disposable. Never restore live Herdr or credential
  // variables while an existing root notification drain might still settle.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
  });
  const sdk = await import(sdkRoot ? pathToFileURL(join(sdkRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent");
  const { RegistryStore } = await import("../dist/src/orchestrator/store.js");
  const { ChannelStore } = await import("../dist/src/orchestrator/channel-store.js");
  const { CHILD_BINDING_ENTRY } = await import("../dist/src/orchestrator/child-binding.js");
  const cwd = join(root, "cwd"), agentDir = join(root, "agent"), statePath = join(root, "herdr.json");
  const parent = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
  const child = { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" };
  const name = `agent-${"a".repeat(26)}`, agentId = `a-${randomUUID()}`, runId = `r-${randomUUID()}`;
  const coords = identity => ({ workspace_id: identity.workspaceId, tab_id: identity.tabId, pane_id: identity.paneId });
  const state = {
    panes: { [parent.paneId]: coords(parent), [child.paneId]: coords(child) },
    agents: {
      "fixture-root": { ...coords(parent), name: "fixture-root", agent_status: "idle" },
      [name]: { ...coords(child), name, agent_status: "idle" },
    },
  };
  const saveState = () => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  const native = sm => ({ source: "herdr:pi", agent: "pi", kind: "path", value: sm.getSessionFile() });
  const publish = async sm => {
    state.panes[child.paneId].agent_session = native(sm);
    state.agents[name].agent_session = native(sm);
    await saveState();
  };
  const setPane = identity => Object.assign(process.env, {
    HERDR_WORKSPACE_ID: identity.workspaceId, HERDR_TAB_ID: identity.tabId, HERDR_PANE_ID: identity.paneId,
  });
  const clearChildEnvironment = () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_HERDR_")) delete process.env[key];
  };
  const shutdown = async session => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    sessions.delete(session);
  };
  try {
    for (const directory of [cwd, agentDir, process.env.HOME, process.env.XDG_STATE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_RUNTIME_DIR])
      await mkdir(directory, { recursive: true, mode: 0o700 });
    const tools = [], commands = [];
    extension({ registerTool: tool => tools.push(tool.name), registerCommand: command => commands.push(command), on() {} });
    assert.deepEqual(tools, ["orchestrate"]);
    assert.deepEqual(commands, ["agent-settings"]);

    const fakeHerdr = join(root, "herdr");
    await writeFile(fakeHerdr, `#!${process.execPath}\nimport { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.ORCHESTRATOR_FIXTURE_STATE, 'utf8'));
const a = process.argv.slice(2);
let value, kind;
if (a[0] === 'pane' && a[1] === 'current') { kind = 'pane'; value = state.panes[process.env.HERDR_PANE_ID]; }
else if (a[0] === 'pane' && a[1] === 'get') { kind = 'pane'; value = state.panes[a[2]]; }
else if (a[0] === 'agent' && a[1] === 'get') { kind = 'agent'; value = state.agents[a[2]] ?? Object.values(state.agents).find(x => x.pane_id === a[2]); }
if (!value) { console.error(JSON.stringify({ code: 'FIXTURE_COMMAND_REFUSED' })); process.exit(1); }
console.log(JSON.stringify({ result: { [kind]: value } }));\n`, { mode: 0o700 });
    await saveState();
    Object.assign(process.env, {
      HERDR_ENV: "1", HERDR_SOCKET_PATH: join(root, "unused.sock"), HERDR_BIN_PATH: fakeHerdr,
      ORCHESTRATOR_FIXTURE_STATE: statePath,
    });
    setPane(child);
    const store = new RegistryStore(cwd, parent);
    const timestamp = new Date().toISOString();
    const makeRun = (id, generation) => ({
      runId: id, assignmentGeneration: generation, phase: "running", latestProgress: null,
      terminal: null, deliveredSequence: 0, terminalDelivered: false, notifiedSequence: 0,
      terminalNotified: false, cancelRequestedAt: null, assignmentState: "delivered",
      pendingTask: null, legacyDeliveredEventIds: [], createdAt: timestamp, updatedAt: timestamp,
    });
    await store.addAgent({
      domainId: store.domainId, agentId, runId, herdrAgentName: name, agentGeneration: 1,
      assignmentGeneration: 1, topology: "managed-subagents-tab-v2", ...child, cwd, label: "fixture",
      processState: "live", runPhase: "running", herdrAttention: "idle", latestProgress: null,
      terminal: null, runs: [makeRun(runId, 1)], createdAt: timestamp, updatedAt: timestamp,
    });
    Object.assign(process.env, { PI_HERDR_DOMAIN_ID: store.domainId, PI_HERDR_AGENT_ID: agentId, PI_HERDR_AGENT_GENERATION: "1" });
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
    });
    const notifications = [], errors = [];
    const create = async (sm, lateReport = false) => {
      const settingsManager = sdk.SettingsManager.inMemory();
      const loader = new sdk.DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [
          fileURLToPath(new URL("../../pi-progressive-tools/extensions/index.ts", import.meta.url)),
          fileURLToPath(new URL("../dist/extensions/pi-herdr-orchestrator.js", import.meta.url)),
        ],
        extensionFactories: lateReport ? [api => api.on("session_start", () => publish(sm))] : [],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await sdk.createAgentSession({
        cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime,
        sessionManager: sm, noTools: "builtin",
      });
      sessions.add(session);
      await session.bindExtensions({ mode: "rpc", uiContext: { notify: message => notifications.push(message) }, onError: error => errors.push(error) });
      return session;
    };
    const call = async (session, toolName, params) => {
      const tool = session.agent.state.tools.find(item => item.name === toolName);
      assert(tool, `${toolName} must be executable, not just registered in an extension map`);
      return (await tool.execute("fixture-call", params)).details;
    };
    const childOnly = async session => {
      const names = (await call(session, "list_tools", {})).tools.map(tool => tool.name);
      assert(names.includes("subagent_channel"));
      assert(!names.includes("orchestrate"));
      assert.equal(session.extensionRunner.getCommand("agent-settings"), undefined);
    };
    const sm = sdk.SessionManager.create(cwd, join(root, "sessions"));
    const fresh = await create(sm, true);
    await childOnly(fresh);
    assert.equal(sm.getBranch().filter(entry => entry.customType === CHILD_BINDING_ENTRY).length, 0);
    assert(notifications.some(message => message.includes("binding is unavailable")));
    const progress = { action: "progress", runId, assignmentGeneration: 1, summary: "fixture progress" };
    assert.equal((await call(fresh, "subagent_channel", progress)).ok, true);
    const locator = sm.getBranch().find(entry => entry.customType === CHILD_BINDING_ENTRY).data;
    assert.deepEqual(Object.keys(locator).sort(), ["agentGeneration", "agentId", "domainId", "sessionFile", "sessionId", "version"]);
    assert.equal(existsSync(sm.getSessionFile()), false, "appendEntry is not a disk persistence receipt");
    // A synthetic assistant entry exercises Pi's own persistence boundary. It is
    // not a model response or a completion signal and is never parsed as one.
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixture persistence boundary" }],
      api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const savedFile = sm.getSessionFile();
    assert.equal((await readFile(savedFile, "utf8")).split("\n").filter(line => line && JSON.parse(line).customType === CHILD_BINDING_ENTRY).length, 1);
    await shutdown(fresh);

    const nextRun = `r-${randomUUID()}`;
    await store.startAssignment(agentId, makeRun(nextRun, 2));
    clearChildEnvironment();
    const restoredManager = sdk.SessionManager.open(savedFile);
    const restored = await create(restoredManager);
    await childOnly(restored);
    await assert.rejects(call(restored, "subagent_channel", progress), /STALE_ASSIGNMENT/);
    const current = { ...progress, runId: nextRun, assignmentGeneration: 2 };
    state.agents[name].agent_session = { ...native(restoredManager), value: join(root, "wrong-session.jsonl") };
    await saveState();
    await assert.rejects(call(restored, "subagent_channel", current), /CHILD_NATIVE_SESSION_MISMATCH/);
    await publish(restoredManager);
    const leaf = restoredManager.getLeafId();
    restoredManager.appendCustomEntry(CHILD_BINDING_ENTRY, { version: 1 });
    await assert.rejects(call(restored, "subagent_channel", current), /CHILD_BINDING_MALFORMED/);
    restoredManager.branch(leaf);
    process.env.PI_HERDR_AGENT_ID = agentId;
    await assert.rejects(call(restored, "subagent_channel", current), /CHILD_CONTEXT_INCOMPLETE/);
    clearChildEnvironment();
    assert.equal(await new ChannelStore(store.domainId).result(nextRun), undefined);
    assert.equal((await call(restored, "subagent_channel", { ...current, action: "complete", status: "completed", summary: "explicit fixture completion", finalResult: "collectible fixture result" })).ok, true);
    await shutdown(restored);

    setPane(parent);
    const rootSession = await create(sdk.SessionManager.inMemory(cwd));
    const catalog = await call(rootSession, "list_tools", {});
    assert(catalog.tools.some(tool => tool.name === "orchestrate"));
    assert(!catalog.tools.some(tool => tool.name === "subagent_channel"));
    assert(rootSession.extensionRunner.getCommand("agent-settings"));
    await rootSession.prompt("/agent-settings");
    assert(notifications.some(message => message.includes("TUI mode")));
    await call(rootSession, "tool_help", { names: ["orchestrate"] });
    const collected = await call(rootSession, "orchestrate", { action: "collect", runId: nextRun });
    assert.equal(collected.status, "completed");
    assert.equal(collected.finalResult, "collectible fixture result");
    assert.deepEqual(errors, []);
    await shutdown(rootSession);
  } finally {
    for (const session of sessions) await shutdown(session);
    await rm(root, { recursive: true, force: true });
  }
});

test("real settings component renders and saves only after explicit Save", { timeout: 5000 }, async () => {
  const calls = [];
  const notifications = [];
  const client = {
    connected: true,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "model.capabilities") return {
        models: [{ provider: "fixture", modelId: "synthetic", reasoning: false, thinkingLevels: ["off"] }],
      };
      if (method === "model.policy.get") return { policy: {}, operatorSettings: {} };
      if (method === "model.operator.settings.set") return { persisted: true };
      throw new Error("Unexpected request");
    },
  };
  const context = {
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "synthetic" }] },
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      custom: async factory => {
        let finished = false;
        let result;
        const component = factory({}, { fg: (_color, text) => text, bold: text => text }, {}, value => {
          finished = true; result = value;
        });
        assert.match(component.render(100).join("\n"), /Agent settings/);
        assert.equal(calls.filter(call => call.method.endsWith(".set")).length, 0);
        for (const char of "Save agent settings") component.handleInput(char);
        component.handleInput("\r");
        assert.equal(finished, true);
        return result;
      },
    },
  };
  await openAgentSettings(client, context);
  assert.equal(calls.at(-1).method, "model.operator.settings.set");
  assert.equal(calls.at(-1).params.allowlist, null);
  assert.equal(notifications.at(-1).level, "info");
  calls.length = 0;
  context.ui.custom = async () => undefined;
  await openAgentSettings(client, context);
  assert.deepEqual(calls.map(call => call.method), ["model.capabilities", "model.policy.get"]);
});
