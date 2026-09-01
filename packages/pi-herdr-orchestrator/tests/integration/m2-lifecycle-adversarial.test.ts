import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { EventStore } from "../../src/state/event-store.js";

const actor = { principalId: "prn_00000000000000000000000000", kind: "system" };

test("M2 concurrent repeated stop and register have one side effect and stable outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-lifecycle-race-"));
  let stops = 0;
  let running = true;
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-1",
          terminalId: "terminal-1",
          ...(running
            ? {
                occupant: {
                  kind: "pi",
                  agentId: "agent-1",
                  terminalId: "terminal-1",
                  generation: 1,
                },
              }
            : {}),
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    stopAgent: async () => {
      stops++;
      running = false;
    },
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(
      cli,
      join(root, "prompts"),
      () => [],
      true,
    ),
  });
  await store.append({
    type: "herdr.provision.intent",
    actor,
    entityRefs: { agentId: "agent-1" },
    payload: { agentId: "agent-1" },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId: "agent-1" },
    payload: {
      agentId: "agent-1",
      state: "registered",
      paneId: "pane-1",
      generation: 1,
    },
  });
  await Promise.all([
    service.stop({ paneId: "pane-1", generation: 1 }),
    service.stop({ paneId: "pane-1", generation: 1 }),
  ]);
  await service.stop({ paneId: "pane-1", generation: 1 });
  assert.equal(stops, 1);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "stopped");
});

test("M2 stop rejects false success and a stale stopped outcome while the agent remains live", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-stop-postcondition-"));
  let stops = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-live",
          terminalId: "terminal-live",
          workspaceId: "workspace-live",
          tabId: "tab-live",
        },
      ],
      tabs: [{ id: "tab-live", workspaceId: "workspace-live", panes: [] }],
      workspaces: [{ id: "workspace-live", tabs: [] }],
      agents: [
        {
          id: "agent-live",
          kind: "pi",
          paneId: "pane-live",
          terminalId: "terminal-live",
          workspaceId: "workspace-live",
          tabId: "tab-live",
          sessionId: "session-live",
          generation: 1,
        },
      ],
      worktrees: [],
    }),
    stopAgent: async () => void stops++,
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  await store.append({
    type: "herdr.provision.intent",
    actor,
    entityRefs: { agentId: "agent-live" },
    payload: { agentId: "agent-live" },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId: "agent-live" },
    payload: {
      agentId: "agent-live",
      state: "registered",
      paneId: "pane-live",
      terminalId: "terminal-live",
      sessionId: "session-live",
      generation: 1,
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.stop(
      {
        paneId: "pane-live",
        terminalId: "terminal-live",
        sessionId: "session-live",
        generation: 1,
      },
      "agent-live",
    ),
    /HERDR_STOP_NOT_CONFIRMED/,
  );
  assert.equal(stops, 1);
  assert.notEqual(store.state.herdrResources?.["agent-live"]?.state, "stopped");
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId: "agent-live" },
    payload: {
      agentId: "agent-live",
      state: "stopped",
      cleanupOutcome: "stop_succeeded",
    },
  });
  await assert.rejects(
    service.stop(
      {
        paneId: "pane-live",
        terminalId: "terminal-live",
        sessionId: "session-live",
        generation: 2,
      },
      "agent-live",
    ),
    /HERDR_STOP_NOT_CONFIRMED/,
  );
  assert.equal(stops, 1);
});

test("M2 stop rejects when the expected canonical agent moves during the mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-stop-moved-agent-"));
  let moved = false;
  const agentId = "agent-moved";
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: moved ? "pane-new" : "pane-old",
          terminalId: moved ? "terminal-new" : "terminal-old",
          workspaceId: "workspace-1",
          tabId: "tab-1",
        },
      ],
      tabs: [{ id: "tab-1", workspaceId: "workspace-1", panes: [] }],
      workspaces: [{ id: "workspace-1", tabs: [] }],
      agents: [
        {
          id: agentId,
          kind: "pi",
          paneId: moved ? "pane-new" : "pane-old",
          terminalId: moved ? "terminal-new" : "terminal-old",
          workspaceId: "workspace-1",
          tabId: "tab-1",
          sessionId: moved ? "session-new" : "session-old",
          generation: 1,
        },
      ],
      worktrees: [],
    }),
    stopAgent: async () => void (moved = true),
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  await store.append({
    type: "herdr.provision.intent",
    actor,
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "pane-old",
      terminalId: "terminal-old",
      sessionId: "session-old",
      generation: 1,
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.stop(
      {
        paneId: "pane-old",
        terminalId: "terminal-old",
        sessionId: "session-old",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_STOP_NOT_CONFIRMED/,
  );
  assert.equal(moved, true);
  assert.notEqual(store.state.herdrResources?.[agentId]?.state, "stopped");
});

test("M2 concurrent deadline reconcile cleans registration once and revokes generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-deadline-race-"));
  const prompts = join(root, "prompts");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent",
    role: "worker",
    workspaceId: "workspace",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "deadline",
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor,
    entityRefs: { agentId: "agent-1" },
    payload: {
      agentId: "agent-1",
      state: "pending",
      registrationDeadline: new Date(0).toISOString(),
    },
  });
  await Promise.all([
    service.reconcile(),
    service.reconcile(),
    service.reconcile(),
  ]);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "timed_out");
  assert.equal(store.state.herdrResources?.["agent-1"]?.generation, 2);
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 concurrent broker registration attempts produce one transition and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-register-race-"));
  const prompts = join(root, "prompts");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-1",
          terminalId: "terminal-1",
          occupant: {
            kind: "pi",
            agentId: "agent-1",
            terminalId: "terminal-1",
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  const result = await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent",
    role: "worker",
    workspaceId: "workspace",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "register",
  });
  const attempts = await Promise.allSettled([
    service.register(
      "agent-1",
      { paneId: "pane-1", generation: 1 },
      undefined,
      result.token.digest,
    ),
    service.register(
      "agent-1",
      { paneId: "pane-1", generation: 1 },
      undefined,
      result.token.digest,
    ),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "registered");
  assert.equal((await readdir(prompts)).length, 0);
});

test("M2 repeated normal reconcile has stable durable state and no mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-reconcile-repeat-"));
  let snapshots = 0;
  let mutations = 0;
  const cli = {
    snapshot: async () => {
      snapshots++;
      return { panes: [], tabs: [], workspaces: [], agents: [], worktrees: [] };
    },
    requireMutationCapabilities: () => {
      mutations++;
    },
  } as never;
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, join(root, "prompts")),
  });
  await Promise.all([
    service.reconcile(),
    service.reconcile(),
    service.reconcile(),
  ]);
  assert.equal(snapshots, 3);
  assert.equal(mutations, 0);
});
