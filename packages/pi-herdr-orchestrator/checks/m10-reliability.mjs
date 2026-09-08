#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  console.log("M10 reliability checks passed: sequence/legacy races, abort cleanup, and persisted recovery state");
} finally {
  await rm(state, { recursive: true, force: true });
}
