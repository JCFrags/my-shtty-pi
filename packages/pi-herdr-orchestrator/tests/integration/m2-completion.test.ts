import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HerdrProvisioner } from "../../src/herdr/provisioner.js";
import { HerdrService } from "../../src/herdr/service.js";
import { createManagedToken } from "../../src/herdr/token-files.js";
import { createId } from "../../src/shared/ids.js";
import { EventStore } from "../../src/state/event-store.js";
import { emptyState, reduce } from "../../src/state/reducer.js";

test("M2 fake registration retains files until verified and records lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-completion-"));
  const events = join(root, "events.ndjson");
  const prompts = join(root, "prompts");
  let closed = false;
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: closed
        ? []
        : [
            {
              id: "pane-1",
              terminalId: "terminal-1",
              occupant: {
                agentId: "agent-1",
                terminalId: "terminal-1",
                sessionId: "session-1",
                generation: 1,
              },
            },
          ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => {
      closed = true;
    },
  } as never;
  const store = new EventStore(events);
  await store.open();
  const service = new HerdrService({
    store,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  const result = await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent-1",
    role: "worker",
    workspaceId: "workspace-1",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "fake prompt",
  });
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "pending");
  assert.ok(result.promptPath);
  assert.ok(result.tokenFilePath);
  assert.equal((await readdir(prompts)).length, 2);
  await service.register("agent-1", {
    paneId: "pane-1",
    terminalId: "terminal-1",
    sessionId: "session-1",
    generation: 1,
  });
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "registered");
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "retained_registration_files",
  );
  assert.equal((await readdir(prompts)).length, 0);
  await assert.rejects(() => readFile(result.promptPath!, "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(result.tokenFilePath!, "utf8"), /ENOENT/);
  await service.close({
    paneId: "pane-1",
    terminalId: "terminal-1",
    sessionId: "session-1",
    generation: 1,
  });
  await service
    .close({
      paneId: "pane-1",
      terminalId: "terminal-1",
      sessionId: "session-1",
      generation: 1,
    })
    .catch((error: unknown) => assert.match(String(error), /IDENTITY/));
  assert.equal(closed, true);
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "close_succeeded",
  );
});

test("M2 close removes a dedicated managed tab and preserves a tab with another pane", async () => {
  for (const extraPane of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "m2-close-managed-tab-"));
    const store = new EventStore(join(root, "events.ndjson"));
    await store.open();
    const panes = [
      {
        id: "pane-managed",
        terminalId: "terminal-managed",
        workspaceId: "workspace-1",
        tabId: "tab-managed",
      },
      ...(extraPane
        ? [
            {
              id: "pane-user",
              terminalId: "terminal-user",
              workspaceId: "workspace-1",
              tabId: "tab-managed",
            },
          ]
        : []),
    ];
    let tabCloses = 0;
    let paneCloses = 0;
    let removed = false;
    const cli = {
      requireMutationCapabilities: (capabilities: string[]) =>
        assert.equal(capabilities.includes("tab.close"), true),
      snapshot: async () => {
        const livePanes = removed
          ? panes.filter((pane) => pane.id !== "pane-managed")
          : panes;
        return {
          panes: livePanes,
          tabs:
            removed && !extraPane
              ? []
              : [
                  {
                    id: "tab-managed",
                    workspaceId: "workspace-1",
                    panes: livePanes.map((pane) => ({ id: pane.id })),
                  },
                ],
          workspaces: [{ id: "workspace-1", tabs: [] }],
          agents: removed
            ? []
            : [
                {
                  kind: "pi",
                  paneId: "pane-managed",
                  terminalId: "terminal-managed",
                  workspaceId: "workspace-1",
                  tabId: "tab-managed",
                  sessionId: "session-managed",
                },
              ],
          worktrees: [],
        };
      },
      closeTab: async (tabId: string) => {
        assert.equal(tabId, "tab-managed");
        tabCloses += 1;
        removed = true;
      },
      closePane: async (paneId: string) => {
        assert.equal(paneId, "pane-managed");
        paneCloses += 1;
        removed = true;
      },
    } as never;
    await store.append({
      type: "herdr.provision.intent",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: "agent-managed" },
      payload: { agentId: "agent-managed" },
    });
    await store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId: "agent-managed" },
      payload: {
        agentId: "agent-managed",
        state: "registered",
        workspaceId: "workspace-1",
        tabId: "tab-managed",
        paneId: "pane-managed",
        terminalId: "terminal-managed",
        sessionId: "session-managed",
        generation: 1,
      },
    });
    const service = new HerdrService({
      store,
      cli,
      provisioner: {} as never,
    });
    await service.close(
      {
        paneId: "pane-managed",
        terminalId: "terminal-managed",
        sessionId: "session-managed",
        generation: 1,
      },
      "agent-managed",
    );
    assert.equal(tabCloses, extraPane ? 0 : 1);
    assert.equal(paneCloses, extraPane ? 1 : 0);
    assert.equal(
      store.state.herdrResources?.["agent-managed"]?.state,
      "closed",
    );
  }
});

test("M2 close targets the exact agent when a closed resource shares its pane ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-reused-pane-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const oldAgentId = createId("agt");
  const liveAgentId = createId("agt");
  const state = { present: true, generation: 1 };
  let closeCount = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: state.present
        ? [
            {
              id: "pane-reused",
              terminalId: "terminal-live",
              workspaceId: "workspace-live",
              tabId: "tab-live",
            },
          ]
        : [],
      tabs: [{ id: "tab-live", workspaceId: "workspace-live", panes: [] }],
      workspaces: [{ id: "workspace-live", tabs: [] }],
      agents: state.present
        ? [
            {
              kind: "pi",
              paneId: "pane-reused",
              terminalId: "terminal-live",
              sessionId: "session-live",
              workspaceId: "workspace-live",
              tabId: "tab-live",
              generation: state.generation,
            },
          ]
        : [],
      worktrees: [],
    }),
    closePane: async (paneId: string) => {
      assert.equal(paneId, "pane-reused");
      closeCount += 1;
      state.present = false;
    },
  } as never;
  for (const [agentId, terminalId, sessionId] of [
    [oldAgentId, "terminal-old", "session-old"],
    [liveAgentId, "terminal-live", "session-live"],
  ] as const) {
    await store.append({
      type: "herdr.provision.intent",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId },
      payload: { agentId },
    });
    await store.append({
      type: "herdr.provision.outcome",
      actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: "pane-reused",
        terminalId,
        sessionId,
        generation: 1,
      },
    });
  }
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: oldAgentId },
    payload: {
      agentId: oldAgentId,
      state: "closed",
      cleanupOutcome: "close_succeeded",
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  const liveGuard = {
    paneId: "pane-reused",
    terminalId: "terminal-live",
    sessionId: "session-live",
    generation: 1,
  };
  await assert.rejects(
    service.close(liveGuard, oldAgentId),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 0);
  await service.close(liveGuard, liveAgentId);
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[oldAgentId]?.state, "closed");
  assert.equal(store.state.herdrResources?.[liveAgentId]?.state, "closed");
});

test("M2 historical closed resources are non-actionable while still occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-historical-live-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  let closeCount = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-historical",
          terminalId: "terminal-historical",
          occupant: {
            id: agentId,
            terminalId: "terminal-historical",
            sessionId: "session-historical",
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => void closeCount++,
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "pane-historical",
      terminalId: "terminal-historical",
      sessionId: "session-historical",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "closed",
      cleanupOutcome: "close_succeeded",
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-historical",
        terminalId: "terminal-historical",
        sessionId: "session-historical",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 0);
  assert.equal(store.state.herdrResources?.[agentId]?.state, "closed");
});

test("M2 managed close rejects canonical omission without a durable session", async () => {
  for (const modern of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "m2-close-id-omission-"));
    const store = new EventStore(join(root, "events.ndjson"));
    await store.open();
    const agentId = createId("agt");
    let closeCount = 0;
    const cli = {
      requireMutationCapabilities: () => undefined,
      snapshot: async () =>
        modern
          ? {
              panes: [
                {
                  id: "pane-omission",
                  terminalId: "terminal-omission",
                  workspaceId: "workspace-omission",
                  tabId: "tab-omission",
                },
              ],
              tabs: [
                {
                  id: "tab-omission",
                  workspaceId: "workspace-omission",
                  panes: [],
                },
              ],
              workspaces: [{ id: "workspace-omission", tabs: [] }],
              agents: [
                {
                  kind: "pi",
                  paneId: "pane-omission",
                  terminalId: "terminal-omission",
                  workspaceId: "workspace-omission",
                  tabId: "tab-omission",
                  generation: 1,
                },
              ],
              worktrees: [],
            }
          : {
              panes: [
                {
                  id: "pane-omission",
                  terminalId: "terminal-omission",
                  occupant: {
                    terminalId: "terminal-omission",
                    generation: 1,
                  },
                },
              ],
              tabs: [],
              workspaces: [],
              agents: [],
              worktrees: [],
            },
      closePane: async () => void closeCount++,
    } as never;
    await store.append({
      type: "herdr.provision.intent",
      actor: {
        principalId: "prn_00000000000000000000000000",
        kind: "system",
      },
      entityRefs: { agentId },
      payload: { agentId },
    });
    await store.append({
      type: "herdr.provision.outcome",
      actor: {
        principalId: "prn_00000000000000000000000000",
        kind: "system",
      },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: "pane-omission",
        terminalId: "terminal-omission",
        generation: 1,
      },
    });
    const service = new HerdrService({ store, cli, provisioner: {} as never });
    await assert.rejects(
      service.close(
        {
          paneId: "pane-omission",
          terminalId: "terminal-omission",
          generation: 1,
        },
        agentId,
      ),
      /HERDR_IDENTITY_MISMATCH/,
    );
    assert.equal(closeCount, 0);
  }
});

test("M2 managed close rejects non-unique durable-session proof", async () => {
  for (const modern of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "m2-close-session-duplicate-"));
    const store = new EventStore(join(root, "events.ndjson"));
    await store.open();
    const agentId = createId("agt");
    let closeCount = 0;
    const cli = {
      requireMutationCapabilities: () => undefined,
      snapshot: async () =>
        modern
          ? {
              panes: [
                {
                  id: "pane-target",
                  terminalId: "terminal-target",
                  workspaceId: "workspace-target",
                  tabId: "tab-target",
                },
                {
                  id: "pane-other",
                  terminalId: "terminal-other",
                  workspaceId: "workspace-other",
                  tabId: "tab-other",
                },
              ],
              tabs: [
                {
                  id: "tab-target",
                  workspaceId: "workspace-target",
                  panes: [],
                },
                {
                  id: "tab-other",
                  workspaceId: "workspace-other",
                  panes: [],
                },
              ],
              workspaces: [
                { id: "workspace-target", tabs: [] },
                { id: "workspace-other", tabs: [] },
              ],
              agents: [
                {
                  kind: "pi",
                  paneId: "pane-target",
                  terminalId: "terminal-target",
                  workspaceId: "workspace-target",
                  tabId: "tab-target",
                  sessionId: "session-shared",
                  generation: 1,
                },
                {
                  kind: "pi",
                  paneId: "pane-other",
                  terminalId: "terminal-other",
                  workspaceId: "workspace-other",
                  tabId: "tab-other",
                  sessionId: "session-shared",
                  generation: 1,
                },
              ],
              worktrees: [],
            }
          : {
              panes: [
                {
                  id: "pane-target",
                  terminalId: "terminal-target",
                  occupant: {
                    terminalId: "terminal-target",
                    sessionId: "session-shared",
                    generation: 1,
                  },
                },
                {
                  id: "pane-other",
                  terminalId: "terminal-other",
                  occupant: {
                    terminalId: "terminal-other",
                    sessionId: "session-shared",
                    generation: 1,
                  },
                },
              ],
              tabs: [],
              workspaces: [],
              agents: [],
              worktrees: [],
            },
      closePane: async () => void closeCount++,
    } as never;
    await store.append({
      type: "herdr.provision.intent",
      actor: {
        principalId: "prn_00000000000000000000000000",
        kind: "system",
      },
      entityRefs: { agentId },
      payload: { agentId },
    });
    await store.append({
      type: "herdr.provision.outcome",
      actor: {
        principalId: "prn_00000000000000000000000000",
        kind: "system",
      },
      entityRefs: { agentId },
      payload: {
        agentId,
        state: "registered",
        paneId: "pane-target",
        terminalId: "terminal-target",
        sessionId: "session-shared",
        generation: 1,
      },
    });
    const service = new HerdrService({ store, cli, provisioner: {} as never });
    await assert.rejects(
      service.close(
        {
          paneId: "pane-target",
          terminalId: "terminal-target",
          sessionId: "session-shared",
          generation: 1,
        },
        agentId,
      ),
      /HERDR_IDENTITY_MISMATCH/,
    );
    assert.equal(closeCount, 0);
  }
});

test("M2 close rejects a replaced occupant generation before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-generation-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  let closeCount = 0;
  let liveGeneration: number | undefined = 2;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-generation",
          occupant: {
            agentId,
            ...(liveGeneration !== undefined
              ? { generation: liveGeneration }
              : {}),
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => void closeCount++,
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "pane-generation",
      generation: 1,
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close({ paneId: "pane-generation", generation: 1 }, agentId),
    /HERDR_IDENTITY_MISMATCH/,
  );
  liveGeneration = undefined;
  await assert.rejects(
    service.close({ paneId: "pane-generation", generation: 1 }, agentId),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 0);
});

test("M2 close rejects a different canonical legacy occupant ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-legacy-agent-id-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  let closeCount = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-legacy-id",
          terminalId: "terminal-legacy-id",
          occupant: {
            id: createId("agt"),
            terminalId: "terminal-legacy-id",
            sessionId: "session-legacy-id",
            generation: 1,
          },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
    closePane: async () => void closeCount++,
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "pane-legacy-id",
      terminalId: "terminal-legacy-id",
      sessionId: "session-legacy-id",
      generation: 1,
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-legacy-id",
        terminalId: "terminal-legacy-id",
        sessionId: "session-legacy-id",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 0);
});

test("M2 close rejects a different canonical modern Herdr agent ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-modern-agent-id-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  let closeCount = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-modern-id",
          terminalId: "terminal-modern-id",
          workspaceId: "workspace-modern-id",
          tabId: "tab-modern-id",
        },
      ],
      tabs: [
        {
          id: "tab-modern-id",
          workspaceId: "workspace-modern-id",
          panes: [],
        },
      ],
      workspaces: [{ id: "workspace-modern-id", tabs: [] }],
      agents: [
        {
          id: createId("agt"),
          kind: "pi",
          paneId: "pane-modern-id",
          terminalId: "terminal-modern-id",
          workspaceId: "workspace-modern-id",
          tabId: "tab-modern-id",
          sessionId: "session-modern-id",
          generation: 1,
        },
      ],
      worktrees: [],
    }),
    closePane: async () => void closeCount++,
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "pane-modern-id",
      terminalId: "terminal-modern-id",
      sessionId: "session-modern-id",
      generation: 1,
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-modern-id",
        terminalId: "terminal-modern-id",
        sessionId: "session-modern-id",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 0);
});

test("M2 closed outcome rejects success while the expected canonical agent remains elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-moved-agent-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  let closeCount = 0;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-new",
          terminalId: "terminal-new",
          workspaceId: "workspace-new",
          tabId: "tab-new",
        },
      ],
      tabs: [{ id: "tab-new", workspaceId: "workspace-new", panes: [] }],
      workspaces: [{ id: "workspace-new", tabs: [] }],
      agents: [
        {
          id: agentId,
          kind: "pi",
          paneId: "pane-new",
          terminalId: "terminal-new",
          workspaceId: "workspace-new",
          tabId: "tab-new",
          sessionId: "session-new",
          generation: 1,
        },
      ],
      worktrees: [],
    }),
    closePane: async () => void closeCount++,
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "closed",
      paneId: "pane-old",
      terminalId: "terminal-old",
      sessionId: "session-old",
      generation: 1,
      cleanupOutcome: "close_succeeded",
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-old",
        terminalId: "terminal-old",
        sessionId: "session-old",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 0);
});

test("M2 missing outcome rejects canonical target agent still live elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-missing-live-id-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-new",
          terminalId: "terminal-new",
          workspaceId: "workspace-new",
          tabId: "tab-new",
        },
      ],
      tabs: [{ id: "tab-new", workspaceId: "workspace-new", panes: [] }],
      workspaces: [{ id: "workspace-new", tabs: [] }],
      agents: [
        {
          id: agentId,
          kind: "pi",
          paneId: "pane-new",
          terminalId: "terminal-new",
          workspaceId: "workspace-new",
          tabId: "tab-new",
          sessionId: "session-new",
        },
      ],
      worktrees: [],
    }),
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
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
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-old",
        terminalId: "terminal-old",
        sessionId: "session-old",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(store.state.herdrResources?.[agentId]?.state, "missing");
});

test("M2 missing outcome rejects a canonical legacy target still live elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-missing-legacy-id-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: [
        {
          id: "pane-new",
          terminalId: "terminal-new",
          occupant: { id: agentId, terminalId: "terminal-new" },
        },
      ],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
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
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-old",
        terminalId: "terminal-old",
        sessionId: "session-old",
        generation: 1,
      },
      agentId,
    ),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(store.state.herdrResources?.[agentId]?.state, "missing");
});

test("M2 close rejects a mutation that leaves the exact occupant live", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-postcondition-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  const agentId = createId("agt");
  const snapshot = {
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
        kind: "pi",
        paneId: "pane-live",
        terminalId: "terminal-live",
        sessionId: "session-live",
        workspaceId: "workspace-live",
        tabId: "tab-live",
      },
    ],
    worktrees: [],
  };
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => snapshot,
    closePane: async () => undefined,
  } as never;
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "registered",
      paneId: "pane-live",
      terminalId: "terminal-live",
      sessionId: "session-live",
      generation: 1,
    },
  });
  const service = new HerdrService({ store, cli, provisioner: {} as never });
  await assert.rejects(
    service.close(
      {
        paneId: "pane-live",
        terminalId: "terminal-live",
        sessionId: "session-live",
      },
      agentId,
    ),
    /HERDR_CLOSE_NOT_CONFIRMED/,
  );
  assert.notEqual(store.state.herdrResources?.[agentId]?.state, "closed");
});

test("M2 registration remains durable when registration archival fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-archive-failure-"));
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
            agentId: "agent-1",
            terminalId: "terminal-1",
            sessionId: "session-1",
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
  const provisioner = new HerdrProvisioner(cli, prompts, () => [], true);
  provisioner.archiveRegistration = async () => {
    throw new Error("archive unavailable");
  };
  const service = new HerdrService({ store, cli, provisioner });
  await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent-1",
    role: "worker",
    workspaceId: "workspace-1",
    cwd: root,
    profileId: "test-runner",
    isolation: "shared-readonly",
    prompt: "fake prompt",
  });
  await service.register("agent-1", {
    paneId: "pane-1",
    terminalId: "terminal-1",
    sessionId: "session-1",
    generation: 1,
  });
  assert.equal(store.state.herdrResources?.["agent-1"]?.state, "registered");
  assert.equal(
    store.state.herdrResources?.["agent-1"]?.cleanupOutcome,
    "registration_archive_failed",
  );
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 fake registration refuses a replaced occupant before token deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-replaced-"));
  const store = new EventStore(join(root, "events.ndjson"));
  await store.open();
  let occupant = "agent-1";
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-1", root_pane_id: "pane-1" }),
    startPi: async () => ({ pane_id: "pane-1" }),
    snapshot: async () => ({
      panes: [{ id: "pane-1", occupant: { agentId: occupant, generation: 1 } }],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
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
  await service.provision({
    agentId: "agent-1",
    parentAgentId: "parent-1",
    role: "worker",
    workspaceId: "w",
    cwd: root,
    profileId: "p",
    isolation: "shared-readonly",
    prompt: "p",
  });
  occupant = "replacement";
  await assert.rejects(
    () => service.register("agent-1", { paneId: "pane-1", generation: 1 }),
    /IDENTITY_MISMATCH/,
  );
});

test("M2 reducer retains explicit dirty and replacement classifications", () => {
  const id = createId("agt");
  let state = emptyState();
  state = reduce(state, {
    type: "herdr.provision.intent",
    actor: { principalId: "system", kind: "system" },
    entityRefs: { agentId: id },
    payload: { agentId: id },
  });
  state = reduce(state, {
    type: "herdr.provision.outcome",
    actor: { principalId: "system", kind: "system" },
    entityRefs: { agentId: id },
    payload: {
      agentId: id,
      state: "replaced",
      dirty: true,
      replaced: true,
      cleanupOutcome: "retained",
    },
  });
  assert.equal(state.herdrResources?.[id]?.dirty, true);
  assert.equal(state.herdrResources?.[id]?.replaced, true);
  assert.equal(state.herdrResources?.[id]?.cleanupOutcome, "retained");
});

test("M2 registration reconstructs pending files after service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-restart-"));
  const prompts = join(root, "prompts");
  const events = join(root, "events.ndjson");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-r", root_pane_id: "pane-r" }),
    startPi: async () => ({ pane_id: "pane-r" }),
    snapshot: async () => ({
      panes: [
        {
          id: "pane-r",
          terminalId: "term-r",
          occupant: {
            agentId: "agent-r",
            terminalId: "term-r",
            sessionId: "sess-r",
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
  const firstStore = new EventStore(events);
  await firstStore.open();
  const first = new HerdrService({
    store: firstStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  const result = await first.provision({
    agentId: "agent-r",
    parentAgentId: "parent-r",
    role: "worker",
    workspaceId: "w",
    cwd: root,
    profileId: "p",
    isolation: "shared-readonly",
    prompt: "restart",
  });
  const secondStore = new EventStore(events);
  await secondStore.open();
  const second = new HerdrService({
    store: secondStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await second.startupReconcile();
  await second.register(
    "agent-r",
    {
      paneId: "pane-r",
      terminalId: "term-r",
      sessionId: "sess-r",
      generation: 1,
    },
    undefined,
    result.token.digest,
  );
  assert.equal(
    secondStore.state.herdrResources?.["agent-r"]?.state,
    "registered",
  );
  assert.equal((await readdir(prompts)).length, 0);
});

test("M2 restart expiry durably times out pending registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-expiry-"));
  const prompts = join(root, "prompts");
  const events = join(root, "events.ndjson");
  const cli = {
    requireMutationCapabilities: () => undefined,
    createTab: async () => ({ tab_id: "tab-e", root_pane_id: "pane-e" }),
    startPi: async () => ({ pane_id: "pane-e" }),
    snapshot: async () => ({
      panes: [],
      tabs: [],
      workspaces: [],
      agents: [],
      worktrees: [],
    }),
  } as never;
  const firstStore = new EventStore(events);
  await firstStore.open();
  const first = new HerdrService({
    store: firstStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await first.provision({
    agentId: "agent-e",
    parentAgentId: "parent-e",
    role: "worker",
    workspaceId: "w",
    cwd: root,
    profileId: "p",
    isolation: "shared-readonly",
    prompt: "expiry",
  });
  await firstStore.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: "agent-e" },
    payload: {
      agentId: "agent-e",
      state: "pending",
      paneId: "pane-e",
      registrationDeadline: new Date(Date.now() - 1).toISOString(),
    },
  });
  const secondStore = new EventStore(events);
  await secondStore.open();
  const second = new HerdrService({
    store: secondStore,
    cli,
    provisioner: new HerdrProvisioner(cli, prompts, () => [], true),
  });
  await second.startupReconcile();
  assert.equal(
    secondStore.state.herdrResources?.["agent-e"]?.state,
    "timed_out",
  );
  assert.equal((await readdir(prompts)).length, 2);
});

test("M2 close is serialized and repeated close mutates once", async () => {
  const root = await mkdtemp(join(tmpdir(), "m2-close-lock-"));
  const eventPath = join(root, "events.ndjson");
  const store = new EventStore(eventPath);
  await store.open();
  let closeCount = 0;
  const agentId = createId("agt");
  let livePanes: Array<Record<string, unknown>> = [
    { id: "pane-c", occupant: { agentId, generation: 1 } },
  ];
  let liveAgents: Array<Record<string, unknown>> = [];
  let liveWorkspaces: Array<Record<string, unknown>> = [];
  let liveWorktrees: Array<Record<string, unknown>> = [];
  let worktreeInventoryPresent = false;
  const cli = {
    requireMutationCapabilities: () => undefined,
    snapshot: async () => ({
      panes: livePanes,
      tabs: [],
      workspaces: liveWorkspaces,
      agents: liveAgents,
      worktrees: liveWorktrees,
      worktreeInventoryPresent,
    }),
    closePane: async () => {
      closeCount++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      livePanes = [];
    },
  } as never;
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
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: { agentId, state: "registered", paneId: "pane-c", generation: 1 },
  });
  await Promise.all([
    service.close({ paneId: "pane-c", generation: 1 }),
    service.close({ paneId: "pane-c", generation: 1 }),
  ]);
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[agentId]?.state, "closed");
  const closedSeq = store.state.lastEventSeq;
  assert.deepEqual(await service.reconcile(), []);
  assert.equal(store.state.lastEventSeq, closedSeq);
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId },
    payload: {
      agentId,
      state: "closing",
      cleanupOutcome: "mutation_pending",
      generation: 2,
    },
  });
  assert.equal(store.state.herdrResources?.[agentId]?.state, "closed");
  const replay = new EventStore(eventPath);
  await replay.open();
  assert.equal(replay.state.herdrResources?.[agentId]?.state, "closed");

  const missingAgentId = createId("agt");
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: missingAgentId },
    payload: { agentId: missingAgentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: missingAgentId },
    payload: {
      agentId: missingAgentId,
      state: "registered",
      paneId: "pane-m",
      terminalId: "terminal-m",
      workspaceId: "workspace-shared",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: missingAgentId },
    payload: {
      agentId: missingAgentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  liveWorkspaces = [{ id: "workspace-shared" }];
  await service.close({ paneId: "pane-m", terminalId: "terminal-m" });
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[missingAgentId]?.state, "closed");
  assert.equal(
    store.state.herdrResources?.[missingAgentId]?.cleanupOutcome,
    "already_absent",
  );

  liveWorkspaces = [];
  const movedAgentId = createId("agt");
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: movedAgentId },
    payload: { agentId: movedAgentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: movedAgentId },
    payload: {
      agentId: movedAgentId,
      ownerId: movedAgentId,
      state: "registered",
      paneId: "pane-old",
      terminalId: "terminal-old",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: movedAgentId },
    payload: {
      agentId: movedAgentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  livePanes = [
    {
      id: "pane-new",
      terminalId: "terminal-new",
      occupant: { agentId: movedAgentId, terminalId: "terminal-new" },
    },
  ];
  liveAgents = [
    {
      agentId: movedAgentId,
      paneId: "pane-new",
      terminalId: "terminal-new",
    },
  ];
  await assert.rejects(
    service.close({ paneId: "pane-old", terminalId: "terminal-old" }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[movedAgentId]?.state, "missing");

  const worktreeAgentId = createId("agt");
  await store.append({
    type: "herdr.provision.intent",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: worktreeAgentId },
    payload: { agentId: worktreeAgentId },
  });
  await store.append({
    type: "herdr.provision.outcome",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: worktreeAgentId },
    payload: {
      agentId: worktreeAgentId,
      ownerId: worktreeAgentId,
      state: "registered",
      paneId: "pane-worktree",
      terminalId: "terminal-worktree",
      workspaceId: "workspace-worktree",
      worktreeId: "worktree-id",
      worktreePath: "/repo/worktree",
      generation: 1,
    },
  });
  await store.append({
    type: "herdr.reconciled",
    actor: { principalId: "prn_00000000000000000000000000", kind: "system" },
    entityRefs: { agentId: worktreeAgentId },
    payload: {
      agentId: worktreeAgentId,
      state: "missing",
      reason: "Recorded pane is absent.",
    },
  });
  livePanes = [];
  liveAgents = [];
  liveWorkspaces = [{ id: "workspace-worktree" }];
  await assert.rejects(
    service.close({
      paneId: "pane-worktree",
      terminalId: "terminal-worktree",
    }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  liveWorkspaces = [];
  await assert.rejects(
    service.close({
      paneId: "pane-worktree",
      terminalId: "terminal-worktree",
    }),
    /HERDR_IDENTITY_MISMATCH/,
  );
  worktreeInventoryPresent = true;
  liveWorktrees = [];
  await service.close({
    paneId: "pane-worktree",
    terminalId: "terminal-worktree",
  });
  assert.equal(closeCount, 1);
  assert.equal(store.state.herdrResources?.[worktreeAgentId]?.state, "closed");
  assert.equal(
    store.state.herdrResources?.[worktreeAgentId]?.cleanupOutcome,
    "already_absent",
  );
});

test("M2 token digest is the only durable token value", () => {
  const token = createManagedToken();
  assert.match(token.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(token.token, token.digest);
});
