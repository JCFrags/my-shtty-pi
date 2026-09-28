#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = await mkdtemp(join(tmpdir(), "pi-herdr-m10-"));
process.env.XDG_STATE_HOME = state;
try {
  const { ChannelStore } = await import("../dist/src/orchestrator/channel-store.js");
  const domainId = "d-0123456789abcdef01234567";
  const runId = "r-01234567-89ab-cdef-0123-456789abcdef";
  const channel = new ChannelStore(domainId);
  const base = {
    version: 2,
    kind: "progress",
    domainId,
    agentId: "a-01234567-89ab-cdef-0123-456789abcdef",
    runId,
    agentGeneration: 1,
    assignmentGeneration: 1,
    target: "parent",
    summary: "race check",
    createdAt: new Date().toISOString(),
  };
  const allocated = [];
  let acknowledged = 0;
  for (let index = 0; index < 40; index += 1) {
    const [event] = await Promise.all([
      channel.appendEvent(base, acknowledged),
      channel.acknowledge(runId, acknowledged),
    ]);
    allocated.push(event.sequence);
    acknowledged = event.sequence;
  }
  assert.deepEqual(allocated, Array.from({ length: 40 }, (_, index) => index + 1));
  await channel.acknowledge(runId, acknowledged);
  assert.equal((await channel.appendEvent(base, acknowledged)).sequence, 41);

  const mixedRunId = "r-11234567-89ab-cdef-0123-456789abcdef";
  const legacyName = "1700000000000-21234567-89ab-cdef-0123-456789abcdef.json";
  await channel.ensure();
  await writeFile(join(channel.eventsDirectory, legacyName), `${JSON.stringify({
    version: 1,
    domainId,
    agentId: base.agentId,
    runId: mixedRunId,
    agentGeneration: 1,
    assignmentGeneration: 1,
    kind: "progress",
    target: "parent",
    summary: "legacy unread",
    createdAt: new Date().toISOString(),
  })}\n`);
  const native = await channel.appendEvent({ ...base, runId: mixedRunId }, 0);
  assert.equal(native.sequence, 2);
  assert.deepEqual(
    (await channel.events([mixedRunId])).map((event) => event.sequence).sort((a, b) => a - b),
    [1, 2],
    "pre-existing legacy event must retain ordering before a later native append",
  );

  const legacyBatchRunId = "r-21234567-89ab-cdef-0123-456789abcdef";
  for (let index = 0; index < 30; index += 1) {
    const id = `170000000${String(index).padStart(4, "0")}-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
    await writeFile(join(channel.eventsDirectory, `${id}.json`), `${JSON.stringify({
      version: 1,
      domainId,
      agentId: base.agentId,
      runId: legacyBatchRunId,
      agentGeneration: 1,
      assignmentGeneration: 1,
      kind: "progress",
      target: "parent",
      summary: `legacy ${index}`,
      createdAt: new Date().toISOString(),
    })}\n`);
  }
  const firstLegacyBatch = (await channel.events(
    [legacyBatchRunId],
    new Map([[legacyBatchRunId, 0]]),
  )).slice(0, 24);
  assert.equal(firstLegacyBatch.length, 24);
  await channel.acknowledge(legacyBatchRunId, firstLegacyBatch.at(-1).sequence);
  const remainingLegacy = await channel.events(
    [legacyBatchRunId],
    new Map([[legacyBatchRunId, firstLegacyBatch.at(-1).sequence]]),
  );
  assert.deepEqual(
    remainingLegacy.map((event) => event.summary),
    Array.from({ length: 6 }, (_, index) => `legacy ${index + 24}`),
    "legacy survivors after a 24-event delivery must be delivered exactly once",
  );
  await channel.acknowledge(legacyBatchRunId, remainingLegacy.at(-1).sequence);
  assert.equal(
    (await channel.events(
      [legacyBatchRunId],
      new Map([[legacyBatchRunId, remainingLegacy.at(-1).sequence]]),
    )).length,
    0,
  );

  const abortRunId = "r-31234567-89ab-cdef-0123-456789abcdef";
  const controller = new AbortController();
  const started = Date.now();
  const waiting = channel.waitForChange([abortRunId], 10_000, controller.signal);
  setTimeout(() => controller.abort(new Error("check abort")), 20);
  await assert.rejects(waiting, /check abort/u);
  assert.ok(Date.now() - started < 500, "wait watcher must abort promptly");

  const { RegistryStore } = await import("../dist/src/orchestrator/store.js");
  const parent = { workspaceId: "w-check", tabId: "t-check", paneId: "p-check" };
  const registry = new RegistryStore(state, parent);
  const createdAt = new Date().toISOString();
  const pendingRun = {
    runId: abortRunId,
    assignmentGeneration: 1,
    phase: "running",
    latestProgress: null,
    terminal: null,
    deliveredSequence: 0,
    terminalDelivered: false,
    notifiedSequence: 0,
    terminalNotified: false,
    cancelRequestedAt: null,
    assignmentState: "pending-prompt",
    pendingTask: "persist me",
    legacyDeliveredEventIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  await registry.addAgent({
    domainId: registry.domainId,
    agentId: base.agentId,
    runId: abortRunId,
    herdrAgentName: "agent-check",
    agentGeneration: 1,
    assignmentGeneration: 1,
    topology: "managed-subagents-tab-v2",
    workspaceId: parent.workspaceId,
    tabId: parent.tabId,
    paneId: "child-pane",
    cwd: state,
    label: "check",
    processState: "live",
    runPhase: "running",
    herdrAttention: "working",
    latestProgress: null,
    terminal: null,
    runs: [pendingRun],
    createdAt,
    updatedAt: createdAt,
  });
  await registry.updateRun(base.agentId, abortRunId, {
    phase: "cancel_requested",
    cancelRequestedAt: new Date().toISOString(),
  });
  const reloaded = await new RegistryStore(state, parent).getRun(abortRunId);
  assert.equal(reloaded?.run.assignmentState, "pending-prompt");
  assert.equal(reloaded?.run.pendingTask, "persist me");
  assert.equal(reloaded?.run.phase, "cancel_requested");

  const tool = await readFile(new URL("../src/orchestrator/tool.ts", import.meta.url), "utf8");
  const pending = tool.indexOf('assignmentState: "pending-prompt"');
  const prompt = tool.indexOf("await current.cli.agentPrompt(", pending);
  const delivered = tool.indexOf('assignmentState: "delivered"', prompt);
  assert.ok(pending >= 0 && prompt > pending && delivered > prompt,
    "spawn must persist pending assignment before prompt and delivery state after it");
  assert.match(tool, /assignment\.phase === "cancel_requested"[\s\S]*dispatchCancellation/u,
    "recover must redispatch current cancellation");
  assert.match(tool, /assignment\.phase !== "cancel_requested"[\s\S]*assignment\.assignmentState === "pending-prompt"/u,
    "recover must not resend an original assignment after cancellation dispatch");
  assert.match(tool, /identity\(current\.cli, latest\.agent\)[\s\S]*agentInterrupt[\s\S]*identity\(current\.cli, latest\.agent\)[\s\S]*agentPrompt/u,
    "cancellation must revalidate exact identity before both name-targeted operations");
  assert.match(tool, /drainNotificationsUnlocked[\s\S]*migrateLegacy: false[\s\S]*migrateLegacy: false/u,
    "periodic notification reconciliation and reads must both disable legacy-root scans");
  assert.match(tool, /exact\.kind === "absent"[\s\S]*settleCancelled/u,
    "absent exact child must settle cancellation");
  await boundedWaitCheck(state, parent, registry, pendingRun, base.agentId);
  console.log("M10 reliability checks passed: sequence/legacy races, abort cleanup, persisted recovery, and bounded waits");
} finally {
  await rm(state, { recursive: true, force: true });
}

// One interleaved regression. No live coordinates, socket, provider, or model.
async function boundedWaitCheck(state, parent, registry, previousRun, previousAgentId) {
  const { registerOrchestrate } = await import("../dist/src/orchestrator/tool.js");
  const { ChannelStore } = await import("../dist/src/orchestrator/channel-store.js");
  const { RegistryStore } = await import("../dist/src/orchestrator/store.js");
  const { WaitScope, POLL_WORK_MS } = await import("../dist/src/orchestrator/wait-scope.js");
  const watchdog = setTimeout(() => { throw new Error("bounded wait regression exceeded 15 seconds"); }, 15_000);
  const originalArm = ChannelStore.prototype.armChangeWait;
  const originalResult = ChannelStore.prototype.result;
  const originalEvents = ChannelStore.prototype.events;
  const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const pidPath = join(state, "helper-pid");
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: "/usr/local/bin:/usr/bin:/bin", HOME: join(state, "home"),
    XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(state, "config"),
    XDG_RUNTIME_DIR: join(state, "runtime"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
    HERDR_ENV: "1", HERDR_SOCKET_PATH: join(state, "unused.sock"),
    HERDR_WORKSPACE_ID: parent.workspaceId, HERDR_TAB_ID: parent.tabId,
    HERDR_PANE_ID: parent.paneId, FIXTURE_HELPER_PID: pidPath,
  });
  for (const path of [process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_RUNTIME_DIR])
    await mkdir(path, { recursive: true });
  const binary = join(state, "herdr-read-fixture.mjs");
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.slice(2).join(' ') !== 'pane current --current') throw new Error('FIXTURE_COMMAND_REFUSED');
writeFileSync(process.env.FIXTURE_HELPER_PID, String(process.pid));
setTimeout(() => console.log(JSON.stringify({ result: { pane: {
  workspace_id: process.env.HERDR_WORKSPACE_ID, tab_id: process.env.HERDR_TAB_ID,
  pane_id: process.env.HERDR_PANE_ID
} } })), Number(process.env.FIXTURE_HELPER_DELAY || 0));
`, { mode: 0o700 });
  process.env.HERDR_BIN_PATH = binary;
  const runId = "r-41234567-89ab-cdef-0123-456789abcdef";
  const agentId = "a-41234567-89ab-cdef-0123-456789abcdef";
  const run = { ...previousRun, runId, phase: "running", cancelRequestedAt: null,
    assignmentState: "delivered", pendingTask: null };
  await registry.addAgent({ domainId: registry.domainId, agentId, runId,
    herdrAgentName: "wait-fixture", agentGeneration: 1, assignmentGeneration: 1,
    topology: "managed-subagents-tab-v2", workspaceId: parent.workspaceId,
    tabId: "child-tab", paneId: "wait-child", cwd: state, label: "wait fixture",
    processState: "live", runPhase: "running", herdrAttention: "working",
    latestProgress: null, terminal: null, runs: [run],
    createdAt: run.createdAt, updatedAt: run.updatedAt });
  const channel = new ChannelStore(registry.domainId);
  const event = { version: 2, domainId: registry.domainId, agentId, runId,
    agentGeneration: 1, assignmentGeneration: 1, kind: "progress",
    target: "parent", createdAt: run.createdAt, summary: "bounded fixture" };
  const result = { version: 2, domainId: registry.domainId, agentId, runId,
    agentGeneration: 1, assignmentGeneration: 1, status: "completed",
    summary: "fixture completed", finalResult: "explicit collection only" };
  const notices = [], hooks = new Map();
  let tool, arms = 0, onSleep = () => {};
  const context = { cwd: state, hasUI: true, ui: { notify: text => notices.push(JSON.parse(text)) } };
  registerOrchestrate({ registerTool: value => { tool = value; }, on: (name, fn) => hooks.set(name, fn) });
  const call = async (params, signal) => (await tool.execute("m10-wait", params, signal, undefined, context)).details;
  const wait = (timeoutMs, signal) => call({ action: "wait", runIds: [runId], timeoutMs }, signal);
  const fresh = async () => (await new RegistryStore(state, parent).getRun(runId)).run;
  ChannelStore.prototype.armChangeWait = async function (...args) {
    arms++;
    const handle = await originalArm.apply(this, args);
    return { get changed() { onSleep(); return handle.changed; }, close: () => handle.close() };
  };
  try {
    assert.equal(tool.parameters.oneOf.find(x => x.properties.action.const === "wait").properties.timeoutMs.maximum, 600_000);
    await assert.rejects(wait(600_001), /INVALID_TIMEOUT/);
    const pollStart = performance.now(), pollScope = new WaitScope(pollStart, 0);
    assert.equal(pollScope.deadline, pollStart + POLL_WORK_MS);
    pollScope.dispose();
    for (let index = 0; index < 25; index++)
      await channel.appendEvent({ ...event, summary: "x".repeat(2200) }, 0);
    const batch = await wait(0);
    assert.deepEqual(batch.events.map(x => x.eventSequence), Array.from({ length: 24 }, (_, i) => i + 1));
    assert(batch.events.every(x => x.summary.length === 2048));
    assert.equal(batch.timedOut, false);
    assert.equal(arms, 0, "zero poll must not arm watchers");
    assert.equal(notices.filter(x => x.runId === runId).length, 24);
    assert.equal((await wait(0)).events[0].eventSequence, 25);
    assert.equal((await channel.events([runId])).length, 0);
    await assert.rejects(call({ action: "collect", runId }), /RESULT_NOT_READY/);

    // A real read helper must close, not outlive a setup deadline or select a fallback root.
    process.env.FIXTURE_HELPER_DELAY = "2000";
    const setupStart = performance.now();
    await assert.rejects(wait(400), /WAIT_DEADLINE_EXCEEDED/);
    const helperPid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(helperPid, 0), { code: "ESRCH" });
    assert(performance.now() - setupStart < 1500, "setup must consume the overall budget");
    delete process.env.FIXTURE_HELPER_DELAY;

    // Another tool changes the registry while the wait is asleep. The later save must retain it.
    let asleep;
    const sleeping = new Promise(resolve => { asleep = resolve; });
    onSleep = asleep;
    const waiting = wait(120_001);
    await sleeping;
    await channel.complete({ ...result, runId: previousRun.runId, agentId: previousAgentId });
    const sibling = await call({ action: "collect", runId: previousRun.runId });
    assert.equal(sibling.status, "completed", "collect must not queue behind watcher sleep");
    await channel.appendEvent({ ...event, summary: "wake after sibling save" }, 25);
    assert.equal((await waiting).events[0].eventSequence, 26);
    assert.equal((await new RegistryStore(state, parent).getRun(previousRun.runId)).run.terminal.status, "completed");

    // Queue admission is in the budget. Its aborted gate must never run later.
    let release, held;
    const gate = new Promise(resolve => { release = resolve; });
    const holding = new Promise(resolve => { held = resolve; });
    let holdOnce = true;
    ChannelStore.prototype.result = async function (id, ...args) {
      if (id === previousRun.runId && holdOnce) { holdOnce = false; held(); await gate; }
      return originalResult.call(this, id, ...args);
    };
    const holder = call({ action: "collect", runId: previousRun.runId });
    await holding;
    try { await assert.rejects(wait(200), /WAIT_DEADLINE_EXCEEDED/); }
    finally { release(); await holder; ChannelStore.prototype.result = originalResult; }
    assert.equal((await wait(0)).timedOut, true);

    // Host abort joins watcher cleanup. It never cancels the run or consumes future data.
    const controller = new AbortController();
    let abortAsleep;
    const abortSleeping = new Promise(resolve => { abortAsleep = resolve; });
    onSleep = abortAsleep;
    const aborted = assert.rejects(wait(600_000, controller.signal), /ORCHESTRATION_OPERATION_FAILED/);
    await abortSleeping;
    controller.abort();
    await aborted;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal((await fresh()).phase, "running");
    const afterAbort = await readFile(registry.path, "utf8");
    await pause(30);
    assert.equal(await readFile(registry.path, "utf8"), afterAbort, "no wait-owned writes after abort return");

    // Abort on an actual record read, before delivery admission. Keep the event unread.
    const beforeDelivery = new AbortController();
    await channel.appendEvent({ ...event, summary: "abort before delivery" }, 26);
    ChannelStore.prototype.events = async function (...args) {
      const rows = await originalEvents.apply(this, args);
      if (rows.some(row => row.summary === "abort before delivery")) beforeDelivery.abort();
      return rows;
    };
    await assert.rejects(wait(1000, beforeDelivery.signal), /ORCHESTRATION_OPERATION_FAILED/);
    ChannelStore.prototype.events = originalEvents;
    assert.equal((await fresh()).deliveredSequence, 26);
    assert.equal((await wait(0)).events[0].eventSequence, 27);

    // Publish in the old empty-read/arm gap. The armed recheck must find the result.
    ChannelStore.prototype.armChangeWait = async function (...args) {
      await this.complete(result);
      return originalArm.apply(this, args);
    };
    const gapStart = performance.now();
    const terminal = await wait(2000);
    assert(performance.now() - gapStart < 1000, "arm-gap result must not wait for the deadline");
    assert.equal(terminal.results[0].resultAvailable, true);
    assert.equal(terminal.results[0].finalResult, undefined);
    assert.equal((await call({ action: "collect", runId })).finalResult, result.finalResult);
    console.log("Bounded wait check passed: entry budget, zero poll, lock release/freshness, queue abort, watcher abort, arm-gap recheck, caps and collect");
  } finally {
    clearTimeout(watchdog);
    ChannelStore.prototype.armChangeWait = originalArm;
    ChannelStore.prototype.result = originalResult;
    ChannelStore.prototype.events = originalEvents;
    await hooks.get("session_shutdown")();
  }
}
