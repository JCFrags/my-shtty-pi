import assert from "node:assert/strict";
import test from "node:test";
import { registerParentTools } from "../../src/pi/tools.js";

interface ToolDefinition {
  name: string;
  parameters: unknown;
  renderCall?: (...args: any[]) => { render(width: number): string[] };
  renderResult?: (...args: any[]) => { render(width: number): string[] };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { cwd: string },
  ) => Promise<unknown>;
}

const adapter = { safeState: () => ({ agentId: "agt_parent" }) };

const recommendedModels = {
  profileId: "scout",
  thinkingGuide: [{ thinkingLevel: "medium", useFor: "balanced default" }],
  availableModels: [
    {
      rank: 1,
      provider: "provider-recommended",
      modelId: "model-recommended",
      recommended: true,
      thinkingLevels: [
        {
          rank: 1,
          thinkingLevel: "medium",
          recommended: true,
          ratings: {
            overall: "★★★★★ 5/5",
            taskFit: "★★★★★ 5/5",
            reliability: "★★★★★ 5/5",
            speed: "★★★★★ 5/5",
            value: "★★★★★ 5/5",
          },
        },
      ],
    },
  ],
  moreAvailable: 0,
} as const;

function fixture(
  request: (
    method: string,
    params: Record<string, unknown>,
    options?: { idempotencyKey?: string; timeoutMs?: number },
  ) => Promise<unknown>,
): { tools: ToolDefinition[]; tool: ToolDefinition } {
  const tools: ToolDefinition[] = [];
  registerParentTools(
    {
      registerTool: (definition: ToolDefinition) => tools.push(definition),
    } as never,
    adapter as never,
    {
      connected: true,
      principal: {
        id: "prn_parent",
        kind: "pi_parent",
        agentId: "agt_parent",
        permissions: ["delegate", "manage:self", "read:state"],
      },
      request,
    } as never,
  );
  const tool = tools.find((item) => item.name === "orchestrate");
  assert.ok(tool);
  return { tools, tool };
}

test("default parent surface registers one task-centered facade", () => {
  const previous = process.env.PI_HERDR_ORCH_ADVANCED_TOOLS;
  delete process.env.PI_HERDR_ORCH_ADVANCED_TOOLS;
  try {
    const { tools } = fixture(async () => ({}));
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["orchestrate"],
    );
  } finally {
    if (previous === undefined) delete process.env.PI_HERDR_ORCH_ADVANCED_TOOLS;
    else process.env.PI_HERDR_ORCH_ADVANCED_TOOLS = previous;
  }
});

test("facade rendering preserves complete model and user-visible content", async () => {
  const { tool } = fixture(async () => ({ items: [], nextCursor: null }));
  const input = {
    action: "list",
    kind: "task",
    state: "succeeded",
    limit: 4,
  };
  const result = (await tool.execute("call-render", input)) as {
    content: Array<{ type: string; text?: string }>;
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  assert.ok(tool.renderCall);
  assert.ok(tool.renderResult);
  const callText = tool
    .renderCall(input, theme, {})
    .render(100_000)
    .map((line) => line.trimEnd())
    .join("\n");
  const resultText = tool
    .renderResult(result, { expanded: false }, theme, {})
    .render(100_000)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.equal(callText.includes(JSON.stringify(input, null, 2)), true);
  assert.equal(
    resultText.includes(
      JSON.stringify(JSON.parse(result.content[0]?.text ?? "null"), null, 2),
    ),
    true,
  );
});

test("advanced mode keeps legacy capabilities opt-in", () => {
  const previous = process.env.PI_HERDR_ORCH_ADVANCED_TOOLS;
  process.env.PI_HERDR_ORCH_ADVANCED_TOOLS = "1";
  try {
    const { tools } = fixture(async () => ({}));
    assert.equal(tools.length, 30);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 30);
    const defaultBytes = Buffer.byteLength(
      JSON.stringify(
        tools.find((tool) => tool.name === "orchestrate")?.parameters,
      ),
    );
    const advancedBytes = Buffer.byteLength(
      JSON.stringify(
        tools
          .filter((tool) => tool.name !== "orchestrate")
          .map((tool) => tool.parameters),
      ),
    );
    assert.ok(defaultBytes < advancedBytes / 2);
  } finally {
    if (previous === undefined) delete process.env.PI_HERDR_ORCH_ADVANCED_TOOLS;
    else process.env.PI_HERDR_ORCH_ADVANCED_TOOLS = previous;
  }
});

test("run applies bounded defaults and returns one task reference", async () => {
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    idempotencyKey?: string;
    timeoutMs?: number;
  }> = [];
  const { tool } = fixture(async (method, params, options) => {
    calls.push({
      method,
      params,
      ...(options?.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
    if (method === "model.options") return recommendedModels;
    return {
      taskId: "tsk_01M1D000000000000000000001",
      agentId: "agt_01M1D000000000000000000001",
      runId: "run_01M1D000000000000000000001",
      state: "provisioning",
    };
  });
  await tool.execute(
    "call-run",
    {
      action: "run",
      task: { title: "Inspect", objective: "Inspect the bounded target." },
      idempotencyKey: "facade-run-1",
    },
    undefined,
    undefined,
    { cwd: "/tmp/project" },
  );
  assert.deepEqual(calls, [
    {
      method: "model.options",
      params: {
        profileId: "scout",
        placement: "current-workspace",
        projectKey: "/tmp/project",
        limit: 1,
      },
    },
    {
      method: "agent.spawn",
      params: {
        task: { title: "Inspect", objective: "Inspect the bounded target." },
        profileId: "scout",
        project: { cwd: "/tmp/project" },
        placement: "current-workspace",
        isolation: { mode: "shared-readonly" },
        wait: false,
        model: {
          provider: "provider-recommended",
          modelId: "model-recommended",
          thinkingLevel: "medium",
        },
      },
      idempotencyKey: "facade-run-1",
      timeoutMs: 120_000,
    },
  ]);
});

test("run preserves an explicit model without querying legacy model tools", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    return { taskId: "tsk_explicit", state: "provisioning" };
  });
  await tool.execute(
    "call-explicit",
    {
      action: "run",
      task: { title: "Implement", objective: "Apply one bounded change." },
      profileId: "implementer",
      model: {
        provider: "provider-explicit",
        modelId: "model-explicit",
        thinkingLevel: "high",
      },
    },
    undefined,
    undefined,
    { cwd: "/tmp/project" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "agent.spawn");
  assert.deepEqual(calls[0]?.params.model, {
    provider: "provider-explicit",
    modelId: "model-explicit",
    thinkingLevel: "high",
  });
  assert.deepEqual(calls[0]?.params.isolation, { mode: "worktree" });
});

test("run stops before spawn when no broker-allowed model is available", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, "model.options");
    return {
      profileId: "scout",
      thinkingGuide: [],
      availableModels: [],
      moreAvailable: 0,
    };
  });
  await assert.rejects(
    tool.execute(
      "call-no-model",
      { action: "run", task: { title: "Inspect", objective: "Inspect." } },
      undefined,
      undefined,
      { cwd: "/tmp/project" },
    ),
    /NO_ELIGIBLE_AGENT_MODEL/u,
  );
  assert.deepEqual(calls, [
    {
      method: "model.options",
      params: {
        profileId: "scout",
        placement: "current-workspace",
        projectKey: "/tmp/project",
        limit: 1,
      },
    },
  ]);
});

test("models defaults to scout and invalid action fields are explained", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    return recommendedModels;
  });
  await tool.execute("call-models", { action: "models" });
  assert.deepEqual(calls, [
    { method: "model.options", params: { profileId: "scout", limit: 16 } },
  ]);
  await assert.rejects(
    tool.execute("call-models-invalid", {
      action: "models",
      project: { cwd: "/tmp/project" },
    }),
    /does not accept project/u,
  );
});

test("inspect, list, collect, and cancel map to bounded broker operations", async () => {
  const taskId = "tsk_01M1D000000000000000000003";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    return method.endsWith(".list") ? { items: [], nextCursor: null } : {};
  });
  await tool.execute("call-inspect", {
    action: "inspect",
    kind: "task",
    id: taskId,
    include: ["runs"],
    maxBytes: 8_192,
  });
  await tool.execute("call-list", {
    action: "list",
    kind: "agent",
    state: "idle",
    profileId: "scout",
    limit: 8,
    maxBytes: 16_384,
  });
  await tool.execute("call-collect", {
    action: "collect",
    taskIds: [taskId],
    select: ["taskId", "state", "summary"],
    maxBytes: 32_768,
  });
  await tool.execute("call-cancel", {
    action: "cancel",
    taskId,
    cascade: false,
  });
  assert.deepEqual(calls, [
    {
      method: "task.get",
      params: {
        taskId,
        include: ["runs", "recentWork"],
        maxBytes: 8_192,
      },
    },
    {
      method: "agent.list",
      params: {
        state: "idle",
        profileId: "scout",
        limit: 8,
        maxBytes: 16_384,
      },
    },
    {
      method: "task.collect",
      params: {
        taskIds: [taskId],
        select: ["taskId", "state", "summary"],
        maxBytes: 32_768,
      },
    },
    {
      method: "task.cancel",
      params: {
        taskId,
        reason: "Cancelled through the orchestration facade.",
        cascade: false,
      },
    },
  ]);
});

test("steer sends only task identity and defaults idempotency to the tool call", async () => {
  const taskId = "tsk_01M1D000000000000000000005";
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: { idempotencyKey?: string; timeoutMs?: number };
  }> = [];
  const { tool } = fixture(async (method, params, options) => {
    calls.push({ method, params, ...(options ? { options } : {}) });
    return {
      commandId: "cmd_01M1D000000000000000000005",
      taskId,
      runId: "run_01M1D000000000000000000005",
      state: "delivered",
      acceptedAt: "2026-09-01T00:00:00.000Z",
      deliveredAt: "2026-09-01T00:00:00.010Z",
    };
  });
  await tool.execute("call-steer-default-key", {
    action: "steer",
    taskId,
    message: "Inspect the failing test before editing.",
  });
  await tool.execute("call-steer-explicit-key", {
    action: "steer",
    taskId,
    message: "Then report the smallest fix.",
    timeoutMs: 2_000,
    idempotencyKey: "steer-explicit",
  });
  assert.deepEqual(calls, [
    {
      method: "task.steer",
      params: {
        taskId,
        message: "Inspect the failing test before editing.",
        timeoutMs: 10_000,
      },
      options: { idempotencyKey: "call-steer-default-key", timeoutMs: 15_000 },
    },
    {
      method: "task.steer",
      params: {
        taskId,
        message: "Then report the smallest fix.",
        timeoutMs: 2_000,
      },
      options: { idempotencyKey: "steer-explicit", timeoutMs: 7_000 },
    },
  ]);
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.params, "agentId"), false);
    assert.equal(Object.hasOwn(call.params, "runId"), false);
    assert.equal(Object.hasOwn(call.params, "assignmentGeneration"), false);
    assert.equal(Object.hasOwn(call.params, "piSessionId"), false);
  }
});

test("task inspection requests recent work by default without changing other kinds", async () => {
  const taskId = "tsk_01M1D000000000000000000009";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    return {};
  });
  await tool.execute("inspect-task-default", {
    action: "inspect",
    kind: "task",
    id: taskId,
  });
  await tool.execute("inspect-task-deduplicate", {
    action: "inspect",
    kind: "task",
    id: taskId,
    include: ["recentWork"],
  });
  await tool.execute("inspect-agent", {
    action: "inspect",
    kind: "agent",
    id: "agt_01M1D000000000000000000009",
  });
  assert.deepEqual(calls, [
    { method: "task.get", params: { taskId, include: ["recentWork"] } },
    { method: "task.get", params: { taskId, include: ["recentWork"] } },
    {
      method: "agent.get",
      params: { agentId: "agt_01M1D000000000000000000009" },
    },
  ]);
});

test("repeated multi-parent facade use does not lose or cross close identities", async () => {
  const tasks = new Map<
    string,
    {
      parent: number;
      agentId: string;
      runId: string;
      generation: number;
      collected: boolean;
      closed: boolean;
    }
  >();
  let sequence = 0;
  const parents = Array.from({ length: 4 }, (_, parent) =>
    fixture(async (method, params) => {
      if (method === "agent.spawn") {
        const suffix = String(++sequence).padStart(26, "0");
        const taskId = `tsk_${suffix}`;
        const value = {
          parent,
          agentId: `agt_${suffix}`,
          runId: `run_${suffix}`,
          generation: 1,
          collected: false,
          closed: false,
        };
        tasks.set(taskId, value);
        return { taskId, agentId: value.agentId, runId: value.runId };
      }
      if (method === "coordination.wait")
        return {
          kind: "task",
          targetId: params.targetId,
          state: "succeeded",
          ready: true,
        };
      if (method === "task.collect") {
        for (const taskId of params.taskIds as string[]) {
          const value = tasks.get(taskId);
          assert.equal(value?.parent, parent);
          if (value) value.collected = true;
        }
        return { items: [], snapshotSeq: sequence };
      }
      if (method === "task.get") {
        const value = tasks.get(String(params.taskId));
        assert.equal(value?.parent, parent);
        return value
          ? {
              id: params.taskId,
              assignedAgentId: value.agentId,
              currentRunId: value.runId,
            }
          : null;
      }
      if (method === "agent.get") {
        const value = [...tasks.values()].find(
          (item) => item.agentId === params.agentId,
        );
        assert.equal(value?.parent, parent);
        return value
          ? {
              id: value.agentId,
              currentAssignmentGeneration: value.generation,
            }
          : null;
      }
      if (method === "agent.close") {
        const value = [...tasks.values()].find(
          (item) => item.agentId === params.agentId,
        );
        assert.equal(value?.parent, parent);
        assert.equal(value?.runId, params.runId);
        assert.equal(value?.generation, params.assignmentGeneration);
        assert.equal(value?.collected, true);
        if (value) value.closed = true;
        return { agentId: params.agentId, state: "closed" };
      }
      throw new Error(`unexpected method ${method}`);
    }),
  );
  await Promise.all(
    parents.flatMap(({ tool }, parent) =>
      Array.from({ length: 8 }, async (_, child) => {
        await tool.execute(`run-${parent}-${child}`, {
          action: "run",
          task: {
            title: `Child ${parent}-${child}`,
            objective: "Complete one bounded synthetic lifecycle.",
          },
          profileId: "scout",
          model: {
            provider: "provider-explicit",
            modelId: "model-explicit",
            thinkingLevel: "medium",
          },
          project: { cwd: "/tmp/project" },
          isolation: { mode: "shared-readonly" },
        });
      }),
    ),
  );
  await Promise.all(
    [...tasks.entries()].map(async ([taskId, value]) => {
      const tool = parents[value.parent]!.tool;
      await tool.execute(
        `wait-${taskId}`,
        { action: "wait", taskId },
        new AbortController().signal,
      );
      await tool.execute(`collect-${taskId}`, {
        action: "collect",
        taskIds: [taskId],
      });
      await tool.execute(`close-${taskId}`, {
        action: "close",
        taskId,
        confirm: true,
      });
    }),
  );
  assert.equal(tasks.size, 32);
  assert.equal(
    [...tasks.values()].every((value) => value.collected && value.closed),
    true,
  );
});

test("wait has no countdown, ignores blocked by default, and reports why it woke", async () => {
  const taskId = "tsk_01M1D000000000000000000002";
  const states = ["running", "blocked", "succeeded"];
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: { idempotencyKey?: string; timeoutMs?: number };
  }> = [];
  const { tool } = fixture(async (method, params, options) => {
    calls.push({ method, params, ...(options ? { options } : {}) });
    assert.equal(method, "coordination.wait");
    const state = states[Math.min(calls.length - 1, states.length - 1)]!;
    return {
      kind: "task",
      targetId: taskId,
      state,
      ready: state === "succeeded",
      value: { id: taskId },
    };
  });
  const schema = tool.parameters as {
    properties?: Record<string, unknown>;
  };
  assert.equal(Object.hasOwn(schema.properties ?? {}, "budget"), false);
  assert.equal(Object.hasOwn(schema.properties ?? {}, "reason"), false);
  assert.equal(
    (schema.properties?.timeoutMs as { maximum?: number }).maximum,
    30_000,
  );
  assert.equal(Object.hasOwn(schema.properties ?? {}, "until"), false);
  assert.deepEqual(
    (schema.properties?.wakeOn as { items?: { enum?: string[] } }).items?.enum,
    ["blocked"],
  );

  const waitOutput = (await tool.execute(
    "call-wait",
    { action: "wait", taskId, idempotencyKey: "wait-once" },
    new AbortController().signal,
  )) as { content: Array<{ text?: string }> };
  assert.deepEqual(JSON.parse(waitOutput.content[0]?.text ?? "null"), {
    taskId,
    state: "succeeded",
    ready: true,
    wakeReason: "task_finished",
  });
  assert.equal(calls.length, 3);
  for (const call of calls)
    assert.deepEqual(call.params, {
      kind: "task",
      targetId: taskId,
      until: ["succeeded", "failed", "cancelled", "timed_out"],
      timeoutMs: 15_000,
      pollMs: 250,
    });
  assert.equal(calls[0]?.options?.idempotencyKey, "wait-once");
  assert.equal(calls[1]?.options?.idempotencyKey, undefined);
  assert.equal(calls[2]?.options?.idempotencyKey, undefined);
});

test("wait retries a bounded broker transport timeout without changing task state", async () => {
  const taskId = "tsk_01M1D000000000000000000005";
  const methods: string[] = [];
  const { tool } = fixture(async (method) => {
    methods.push(method);
    if (methods.length === 1) throw new Error("BROKER_TIMEOUT");
    return {
      kind: "task",
      targetId: taskId,
      state: "succeeded",
      ready: true,
      value: { id: taskId },
    };
  });
  const output = (await tool.execute(
    "call-transport-retry",
    { action: "wait", taskId },
    new AbortController().signal,
  )) as { content: Array<{ text?: string }> };
  assert.deepEqual(JSON.parse(output.content[0]?.text ?? "null"), {
    taskId,
    state: "succeeded",
    ready: true,
    wakeReason: "task_finished",
  });
  assert.deepEqual(methods, ["coordination.wait", "coordination.wait"]);
});

test("wait wakes early only for an explicit reason and remains cancellable", async () => {
  const taskId = "tsk_01M1D000000000000000000003";
  const { tool } = fixture(async () => ({
    kind: "task",
    targetId: taskId,
    state: "blocked",
    ready: true,
    value: { id: taskId },
  }));
  const early = (await tool.execute(
    "call-wake-blocked",
    { action: "wait", taskId, wakeOn: ["blocked"] },
    new AbortController().signal,
  )) as { content: Array<{ text?: string }> };
  assert.deepEqual(JSON.parse(early.content[0]?.text ?? "null"), {
    taskId,
    state: "blocked",
    ready: true,
    wakeReason: "blocked",
  });

  const pendingMethods: string[] = [];
  const pending = fixture(async (method) => {
    pendingMethods.push(method);
    return await new Promise<never>(() => {
      // The tool-level AbortSignal must end the wait even when transport stalls.
    });
  }).tool;
  const controller = new AbortController();
  const wait = pending.execute(
    "call-cancel-wait",
    { action: "wait", taskId },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(wait, /CANCELLED/u);
  assert.deepEqual(pendingMethods, ["coordination.wait"]);
  await assert.rejects(
    () =>
      tool.execute("call-old-countdown", {
        action: "wait",
        taskId,
        timeoutMs: 1_000,
      }),
    /ORCHESTRATE_INVALID_ARGUMENTS/u,
  );
});

test("close derives exact agent identity after a task wait", async () => {
  const taskId = "tsk_01M1D000000000000000000002";
  const agentId = "agt_01M1D000000000000000000002";
  const runId = "run_01M1D000000000000000000002";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    if (method === "task.get")
      return { id: taskId, assignedAgentId: agentId, currentRunId: runId };
    if (method === "agent.get")
      return { id: agentId, currentAssignmentGeneration: 3 };
    if (method === "agent.close") return { agentId, state: "closed" };
    throw new Error(`unexpected method ${method}`);
  });
  await tool.execute("call-close", {
    action: "close",
    taskId,
    confirm: true,
  });
  assert.deepEqual(calls, [
    { method: "task.get", params: { taskId } },
    { method: "agent.get", params: { agentId } },
    {
      method: "agent.close",
      params: {
        agentId,
        runId,
        assignmentGeneration: 3,
        reason: "Closed through the orchestration facade.",
        confirm: true,
      },
    },
  ]);
});

test("close is idempotent after lifecycle cleanup already closed the resource", async () => {
  const taskId = "tsk_01M1D000000000000000000004";
  const agentId = "agt_01M1D000000000000000000004";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { tool } = fixture(async (method, params) => {
    calls.push({ method, params });
    if (method === "task.get")
      return { id: taskId, assignedAgentId: agentId, currentRunId: "run_old" };
    if (method === "agent.get")
      return { id: agentId, state: "stopped", managedResourceState: "closed" };
    throw new Error(`unexpected method ${method}`);
  });
  const output = (await tool.execute("call-close-already-closed", {
    action: "close",
    taskId,
    confirm: true,
  })) as { content: Array<{ text?: string }> };
  assert.deepEqual(JSON.parse(output.content[0]?.text ?? "null"), {
    taskId,
    agentId,
    state: "closed",
    alreadyClosed: true,
  });
  assert.deepEqual(calls, [
    { method: "task.get", params: { taskId } },
    { method: "agent.get", params: { agentId } },
  ]);
});
