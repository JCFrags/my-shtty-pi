import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerOrchestrate } from "../dist/src/orchestrator/tool.js";
import { RegistryStore } from "../dist/src/orchestrator/store.js";
import { ChannelStore } from "../dist/src/orchestrator/channel-store.js";
import { capacitySettingsPath } from "../dist/src/orchestrator/capacity.js";

test("owned capacity spans tabs and preserves workers across settings changes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-capacity-pool-"));
  // Disposable process and fake coordinates only. No model or live Herdr access.
  for (const key of Object.keys(process.env)) delete process.env[key];
  const parent = { workspaceId: "w1", tabId: "t1", paneId: "p1" };
  const statePath = join(root, "herdr.json");
  Object.assign(process.env, {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"), PI_CODING_AGENT_DIR: join(root, "agent"),
    HERDR_ENV: "1", HERDR_SOCKET_PATH: join(root, "unused.sock"),
    HERDR_WORKSPACE_ID: parent.workspaceId, HERDR_TAB_ID: parent.tabId, HERDR_PANE_ID: parent.paneId,
    ORCHESTRATOR_FIXTURE_STATE: statePath, PI_OFFLINE: "1", PI_TELEMETRY: "0",
  });
  const coords = (tab, pane) => ({ workspace_id: parent.workspaceId, tab_id: tab, pane_id: pane });
  const state = { next: 1, tabs: { t1: { workspace_id: "w1", tab_id: "t1" } },
    panes: { p1: coords("t1", "p1"), legacy: coords("t1", "legacy") },
    agents: { legacy: { ...coords("t1", "legacy"), name: "legacy", agent_status: "idle" } }, commands: [] };
  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  const saveState = value => writeFile(statePath, JSON.stringify(value));
  const hooks = new Map();
  let tool;
  try {
    for (const dir of [process.env.HOME, process.env.XDG_STATE_HOME, process.env.PI_CODING_AGENT_DIR])
      await mkdir(dir, { recursive: true });
    const fakeHerdr = join(root, "herdr.mjs");
    await writeFile(fakeHerdr, `#!${process.execPath}
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const path = process.env.ORCHESTRATOR_FIXTURE_STATE;
const s = JSON.parse(readFileSync(path, 'utf8')), a = process.argv.slice(2);
const arg = name => a[a.indexOf(name) + 1];
// Identity and version reads can overlap. Publish only complete JSON snapshots.
const save = () => {
  const temporary = path + '.' + process.pid;
  writeFileSync(temporary, JSON.stringify(s));
  renameSync(temporary, path);
};
const fail = code => { save(); console.error(JSON.stringify({ code })); process.exit(1); };
let value;
s.commands.push(a);
if (a[0] === '--version') { save(); console.log('fixture 1'); process.exit(0); }
if (a[0] === 'status') value = {};
else if (a[0] === 'tab' && a[1] === 'create') {
  if (!a.includes('--no-focus')) fail('FIXTURE_FOCUS_REFUSED');
  const tab_id = 't' + (++s.next), pane_id = 'p' + s.next, workspace_id = arg('--workspace');
  s.tabs[tab_id] = { tab_id, workspace_id };
  s.panes[pane_id] = { pane_id, tab_id, workspace_id };
  value = { tab: s.tabs[tab_id], root_pane: s.panes[pane_id] };
} else if (a[0] === 'tab' && a[1] === 'get') value = s.tabs[a[2]] && { tab: s.tabs[a[2]] };
else if (a[0] === 'pane' && a[1] === 'current') value = { pane: s.panes[process.env.HERDR_PANE_ID] };
else if (a[0] === 'pane' && a[1] === 'get') value = s.panes[a[2]] && { pane: s.panes[a[2]] };
else if (a[0] === 'pane' && a[1] === 'list') value = { panes: Object.values(s.panes) };
else if (a[0] === 'pane' && a[1] === 'layout') value = { layout: {} };
else if (a[0] === 'pane' && a[1] === 'split') {
  if (!a.includes('--no-focus')) fail('FIXTURE_FOCUS_REFUSED');
  const source = s.panes[arg('--pane')];
  if (!source) fail('PANE_NOT_FOUND');
  const pane_id = 'p' + (++s.next);
  s.panes[pane_id] = { ...source, pane_id };
  delete s.panes[pane_id].name;
  value = { pane: s.panes[pane_id] };
} else if (a[0] === 'pane' && a[1] === 'close') {
  delete s.panes[a[2]];
  for (const [key, agent] of Object.entries(s.agents)) if (agent.pane_id === a[2]) delete s.agents[key];
  value = {};
} else if (a[0] === 'agent' && a[1] === 'start') {
  const pane = s.panes[arg('--pane')];
  if (!pane) fail('PANE_NOT_FOUND');
  pane.name = a[2];
  s.agents[a[2]] = { ...pane, name: a[2], agent_status: 'idle' };
  if (s.failStart) fail('START_UNCERTAIN');
  value = { agent: s.agents[a[2]] };
} else if (a[0] === 'agent' && a[1] === 'get') value = s.agents[a[2]] && { agent: s.agents[a[2]] };
else if (a[0] === 'agent' && a[1] === 'prompt') value = s.agents[a[2]] && {};
else if (a[0] === 'agent' && a[1] === 'read') { save(); console.log('fixture output'); process.exit(0); }
else fail('FIXTURE_COMMAND_REFUSED');
if (!value) fail('NOT_FOUND');
save(); console.log(JSON.stringify({ result: value }));
`, { mode: 0o700 });
    process.env.HERDR_BIN_PATH = fakeHerdr;
    process.env.PI_BIN_PATH = fakeHerdr;
    await saveState(state);
    const configure = (total, perTab) => writeFile(capacitySettingsPath(), JSON.stringify({ version: 1, total, perTab }));
    await configure(4, 2);
    const store = new RegistryStore(root, parent), channel = new ChannelStore(store.domainId);
    const timestamp = new Date().toISOString(), agentId = `a-${randomUUID()}`, runId = `r-${randomUUID()}`;
    const { result } = await channel.complete({ version: 2, domainId: store.domainId, agentId, runId,
      agentGeneration: 1, assignmentGeneration: 1, status: "completed", summary: "retained legacy result", finalResult: "saved" });
    const terminal = { status: result.status, summary: result.summary, completedAt: result.completedAt, resultFile: `results/${runId}.json` };
    const run = { runId, assignmentGeneration: 1, phase: "completed", latestProgress: null, terminal,
      deliveredSequence: 0, terminalDelivered: false, notifiedSequence: 0, terminalNotified: false,
      cancelRequestedAt: null, assignmentState: "delivered", pendingTask: null, legacyDeliveredEventIds: [],
      createdAt: timestamp, updatedAt: timestamp };
    const legacy = { domainId: store.domainId, agentId, runId, herdrAgentName: "legacy", agentGeneration: 1,
      assignmentGeneration: 1, topology: "parent-split-v1", workspaceId: "w1", tabId: "t1", paneId: "legacy",
      cwd: root, label: "legacy", processState: "live", runPhase: "completed", herdrAttention: "idle",
      latestProgress: null, terminal, runs: [run], createdAt: timestamp, updatedAt: timestamp };
    await store.addAgent(legacy);
    // Newer closed history must not hide an older occupied retained worker.
    for (let index = 0; index < 35; index++) {
      const id = `r-${randomUUID()}`;
      await store.addAgent({ ...legacy, agentId: `a-${randomUUID()}`, runId: id, processState: "closed",
        runs: [{ ...run, runId: id }], updatedAt: "2099-01-01T00:00:00.000Z" });
    }
    registerOrchestrate({ registerTool: value => { tool = value; }, on: (event, handler) => hooks.set(event, handler) });
    const call = async params => (await tool.execute("capacity-fixture", params, undefined, undefined, { cwd: root })).details;
    const workers = [];
    for (let index = 0; index < 3; index++) workers.push(await call({ action: "spawn", task: "fixture assignment" }));
    assert.equal(workers[0].tabId, workers[1].tabId);
    assert.notEqual(workers[1].tabId, workers[2].tabId);
    await assert.rejects(call({ action: "spawn", task: "over total" }), /SUBAGENT_CAPACITY_REACHED/);
    const health = await call({ action: "health" });
    assert.equal(health.registryVersion, 6);
    assert.equal(health.occupiedWorkerCount, 4);
    assert.equal(health.completedRetainedWorkerCount, 1);
    assert.equal(health.unfinishedWorkerCount, 3);
    assert.deepEqual(health.managedTabs.map(tab => tab.occupiedWorkerCount).sort(), [1, 2]);
    const listed = await call({ action: "list" });
    assert.equal(listed.returnedAgentCount, 32);
    assert.equal(listed.truncated, true);
    assert(listed.agents.some(agent => agent.agentId === legacy.agentId));
    for (const worker of workers) assert(listed.agents.some(agent => agent.agentId === worker.agentId));
    await configure(5, 1);
    const extra = await call({ action: "spawn", task: "new tab after lower per-tab limit" });
    assert(!workers.some(worker => worker.tabId === extra.tabId));
    const before = (await readState()).panes;
    await configure(1, 1);
    await assert.rejects(call({ action: "spawn", task: "lowered total" }), /SUBAGENT_CAPACITY_REACHED/);
    const reused = await call({ action: "reuse", agentId: legacy.agentId, task: "reuse is not new occupancy" });
    assert.equal(reused.assignmentGeneration, 2);
    assert.deepEqual((await readState()).panes, before, "reductions must not close or move workers");
    await writeFile(capacitySettingsPath(), "{malformed");
    await assert.rejects(call({ action: "spawn", task: "invalid config" }), /CAPACITY_SETTINGS_INVALID/);
    assert.equal((await call({ action: "health" })).capacitySettingsError, "CAPACITY_SETTINGS_INVALID");
    assert.equal((await call({ action: "list" })).occupiedWorkerCount, 5);
    const recovered = await call({ action: "recover" });
    assert.equal(recovered.occupiedWorkerCount, 5);
    assert(recovered.agents.some(agent => agent.agentId === legacy.agentId));
    assert.equal((await call({ action: "collect", runId: legacy.runId })).finalResult, "saved");
    assert.equal((await call({ action: "send", agentId: extra.agentId, message: "fixture" })).ok, true);
    assert.equal((await call({ action: "close", agentId: extra.agentId })).processState, "closed");
    await configure(8, 2);
    const changed = await readState();
    changed.agents[workers[0].agentName].name = "different-owner";
    await saveState(changed);
    assert.equal((await call({ action: "health" })).unknownWorkerCount, 1);
    await assert.rejects(call({ action: "spawn", task: "identity uncertainty" }), /IDENTITY_MISMATCH/);
    changed.agents[workers[0].agentName].name = workers[0].agentName;
    changed.failStart = true;
    await saveState(changed);
    await assert.rejects(call({ action: "spawn", task: "uncertain start" }), /START_UNCERTAIN/);
    const uncertain = (await new RegistryStore(root, parent).list()).at(-1);
    assert.equal(uncertain.processState, "starting");
    assert.equal(uncertain.runs[0].assignmentState, "pending-prompt");
    assert((await readState()).panes[uncertain.paneId], "uncertain start must not close the exact owned pane");
  } finally {
    await hooks.get("session_shutdown")?.();
    await rm(root, { recursive: true, force: true });
  }
});
