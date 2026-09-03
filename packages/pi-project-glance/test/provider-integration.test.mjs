import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const providerRoot = process.env.PI_PROJECT_GLANCE_PROVIDER_ROOT
  ? resolve(process.env.PI_PROJECT_GLANCE_PROVIDER_ROOT)
  : fileURLToPath(new URL("../../..", import.meta.url));
const { default: groundedTasks } = await import(pathToFileURL(join(providerRoot, "packages/grounded-tools/tasks/index.ts")).href);
const { default: groundedWorkplan } = await import(pathToFileURL(join(providerRoot, "packages/grounded-tools/workplan/index.ts")).href);
const {
  WORKPLAN_SUMMARY_CHANGED_EVENT,
  workplanBranchId,
} = await import(pathToFileURL(join(providerRoot, "packages/grounded-tools/core/src/workplan-summary.ts")).href);
import {
  ProjectGlanceCurrentController,
} from "../dist/current/controller.js";
import {
  parseTodoSummaryChanged,
  parseWorkplanSummaryChanged,
  TODO_SUMMARY_CHANGED_EVENT,
  TODO_SUMMARY_EVENT,
  TODO_SUMMARY_REQUEST_EVENT,
  WORKPLAN_SUMMARY_EVENT,
  WORKPLAN_SUMMARY_REQUEST_EVENT,
} from "../dist/current/contracts.js";
import {
  branchIdForContext,
  ProjectGlanceRelayRuntime,
} from "../dist/pi/lifecycle.js";
import { probeProjectGlanceRelay } from "../dist/protocol/client.js";
import { deriveSessionKey } from "../dist/runtime/paths.js";
import { BRANCH_NORMALIZATION_CASES } from "./fixtures/branch-normalization.mjs";

class EventBus {
  #listeners = new Map();

  on(channel, handler) {
    const listeners = this.#listeners.get(channel) ?? new Set();
    listeners.add(handler);
    this.#listeners.set(channel, listeners);
    return () => {
      listeners.delete(handler);
      if (!listeners.size) this.#listeners.delete(channel);
    };
  }

  emit(channel, value) {
    for (const handler of [...(this.#listeners.get(channel) ?? [])]) handler(value);
  }

  count(channel) {
    return this.#listeners.get(channel)?.size ?? 0;
  }
}

class FakePi {
  #handlers = new Map();
  tools = new Map();
  commands = new Map();
  shortcuts = new Map();
  widgets = new Map();
  appended = [];

  constructor(eventBus) {
    this.events = eventBus;
  }

  on(event, handler) {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
  }

  ["registerTool"] (tool) {
    this.tools.set(tool.name, tool);
  }

  registerCommand(name, options) {
    this.commands.set(name, options);
  }

  ["registerShortcut"] (name, options) {
    this.shortcuts.set(name, options);
  }

  appendEntry(customType, data) {
    this.appended.push({ customType, data });
  }

  async emitLifecycle(event, value, context) {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) await handler(value, context);
  }
}

function context(leafId, branch = [], sessionId = "provider-integration-session") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getBranch: () => branch,
    },
    hasUI: false,
    ui: {
      ["setWidget"]() {},
      notify() {},
    },
  };
}

function signal() {
  return new AbortController().signal;
}

async function callTool(pi, name, params) {
  const tool = pi.tools.get(name);
  assert.ok(tool, `tool ${name} was registered`);
  return tool.execute(`integration-${name}`, params, signal());
}

async function nextTick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function shutdownProviders(todoPi, workplanPi, ctx) {
  await todoPi.emitLifecycle("session_shutdown", { type: "session_shutdown" }, ctx);
  await workplanPi.emitLifecycle("session_shutdown", { type: "session_shutdown" }, ctx);
}

async function runRealProviders(order, exercise) {
  const bus = new EventBus();
  const todoPi = new FakePi(bus);
  const workplanPi = new FakePi(bus);
  groundedTasks(todoPi);
  groundedWorkplan(workplanPi);
  const ctx = context("branch-a");
  let controller;
  if (order === "glance-first") {
    controller = new ProjectGlanceCurrentController({ eventBus: bus, retryDelaysMs: [], onChange: exercise.onChange });
    controller.start("branch-a");
  }
  await todoPi.emitLifecycle("session_start", { type: "session_start" }, ctx);
  await workplanPi.emitLifecycle("session_start", { type: "session_start" }, ctx);
  if (order === "providers-first") {
    controller = new ProjectGlanceCurrentController({ eventBus: bus, retryDelaysMs: [], onChange: exercise.onChange });
    controller.start("branch-a");
  }
  await nextTick();
  try {
    await exercise.run({ bus, todoPi, workplanPi, controller, ctx });
  } finally {
    controller.dispose();
    await shutdownProviders(todoPi, workplanPi, ctx);
  }
}

async function persistWorkplanMutation(workplanPi, result) {
  await workplanPi.emitLifecycle("message_end", {
    message: { role: "toolResult", toolName: "workplan", details: result.details },
  }, context("branch-a"));
  await nextTick();
}

async function seedWorkplan(workplanPi) {
  const created = await callTool(workplanPi, "workplan", {
    action: "create",
    content: { title: "Integration plan", objective: "Project current state", approach: "Use bounded events" },
  });
  await persistWorkplanMutation(workplanPi, created);
  const resumed = await callTool(workplanPi, "workplan", {
    action: "resume",
    planId: "WP1",
    expectedRevision: 1,
    rationale: "Begin integration",
  });
  await persistWorkplanMutation(workplanPi, resumed);
  const added = await callTool(workplanPi, "workplan", {
    action: "add_milestone",
    planId: "WP1",
    expectedRevision: 2,
    content: { title: "Current milestone" },
  });
  await persistWorkplanMutation(workplanPi, added);
  const started = await callTool(workplanPi, "workplan", {
    action: "update_milestone",
    planId: "WP1",
    milestoneId: "WP1-M1",
    expectedRevision: 3,
    content: { status: "in_progress" },
  });
  await persistWorkplanMutation(workplanPi, started);
  const checkpoint = await callTool(workplanPi, "workplan", {
    action: "checkpoint",
    planId: "WP1",
    expectedRevision: 4,
    content: { summary: "Checkpoint summary", currentFocus: "Integration focus", nextActions: ["Verify current state"] },
  });
  await persistWorkplanMutation(workplanPi, checkpoint);
  return { created, resumed, added, started, checkpoint };
}

function oldGenericChangedParser(value, expectedBranchId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => key === "version" || key === "branchId")
    && value.version === 1
    && value.branchId === expectedBranchId;
}

async function observeTodoBranch(leafId) {
  const bus = new EventBus();
  const pi = new FakePi(bus);
  const responses = [];
  bus.on(TODO_SUMMARY_EVENT, (value) => responses.push(value));
  groundedTasks(pi);
  await pi.emitLifecycle("session_start", { type: "session_start" }, context(leafId));
  return responses.at(-1)?.branchId;
}

async function observeWorkplanBranch(leafId) {
  const bus = new EventBus();
  const pi = new FakePi(bus);
  const changes = [];
  bus.on(WORKPLAN_SUMMARY_CHANGED_EVENT, (value) => changes.push(value));
  groundedWorkplan(pi);
  await pi.emitLifecycle("session_start", { type: "session_start" }, context(leafId));
  return changes.at(-1)?.branchId;
}

function currentResponse(branchId, requestId, values) {
  return {
    version: 1,
    requestId,
    branchId,
    snapshot: {
      version: 1,
      ...(values.todo ? { currentUsefulTask: values.todo } : {}),
    },
  };
}

function planResponse(branchId, requestId, values) {
  return {
    version: 1,
    requestId,
    branchId,
    summary: {
      version: 1,
      ...(values.plan ? { activePlan: values.plan } : {}),
    },
  };
}

function branchValues(branchId) {
  if (branchId === "C") return {};
  return {
    todo: { id: `${branchId}-T1`, text: `${branchId} task`, status: "pending" },
    plan: {
      id: `${branchId}-WP1`,
      title: `${branchId} plan`,
      objective: "Branch objective",
      revision: 1,
      currentMilestone: { id: `${branchId}-M1`, title: `${branchId} milestone`, status: "in_progress" },
      latestCheckpoint: { id: `${branchId}-K1`, summary: "Branch checkpoint", currentFocus: `${branchId} focus`, at: "2026-09-03T00:00:00.000Z" },
    },
  };
}

function installBranchEnforcingProviders(bus, state) {
  bus.on(TODO_SUMMARY_REQUEST_EVENT, (request) => {
    state.requests.push({ source: "todo", request: { ...request } });
    if (request.branchId !== state.activeBranch) {
      state.rejected += 1;
      return;
    }
    if (state.pauseResponses) return;
    if (request.branchId === "A" && state.delayNextA) {
      state.delayNextA = false;
      state.delayedA = () => bus.emit(TODO_SUMMARY_EVENT, currentResponse("A", request.requestId, branchValues("A")));
      return;
    }
    bus.emit(TODO_SUMMARY_EVENT, currentResponse(request.branchId, request.requestId, branchValues(request.branchId)));
  });
  bus.on(WORKPLAN_SUMMARY_REQUEST_EVENT, (request) => {
    state.requests.push({ source: "workplan", request: { ...request } });
    if (request.branchId !== state.activeBranch) {
      state.rejected += 1;
      return;
    }
    if (state.pauseResponses) return;
    bus.emit(WORKPLAN_SUMMARY_EVENT, planResponse(request.branchId, request.requestId, branchValues(request.branchId)));
  });
}

test("actual Todo mutation accepts its snapshot-bearing invalidation and refreshes once", async () => {
  const changes = [];
  let captureChanged;
  let tamperNextChanged = false;
  await runRealProviders("providers-first", {
    onChange: (value) => changes.push(value),
    async run({ bus, todoPi, controller }) {
      bus.on(TODO_SUMMARY_CHANGED_EVENT, (value) => {
        if (!tamperNextChanged) return;
        tamperNextChanged = false;
        captureChanged = structuredClone(value);
        value.snapshot.currentUsefulTask.text = "forged changed-event text";
      });
      const seeded = await callTool(todoPi, "todo", { action: "add", text: "Initial task" });
      await waitFor(() => controller.current.step === "T1  Initial task");
      assert.equal(seeded.details.action, "add");

      const before = changes.length;
      tamperNextChanged = true;
      await callTool(todoPi, "todo", { action: "update", id: "T1", text: "Updated task" });
      await waitFor(() => controller.current.step === "T1  Updated task");
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.deepEqual(Object.keys(captureChanged).sort(), ["branchId", "snapshot", "version"]);
      assert.equal(captureChanged.snapshot.version, 1);
      assert.equal(captureChanged.snapshot.currentUsefulTask.text, "Updated task");
      assert.equal(oldGenericChangedParser(captureChanged, "branch-a"), false);
      assert.ok(parseTodoSummaryChanged(captureChanged, "branch-a"));
      assert.equal(changes.length, before + 1);
      assert.equal(controller.current.step, "T1  Updated task");
    },
  });
});

test("actual Todo, Workplan, and Project Glance entrypoints work in both lifecycle orders", async () => {
  for (const order of ["glance-first", "providers-first"]) {
    const changes = [];
    await runRealProviders(order, {
      onChange: (value) => changes.push(value),
      async run({ todoPi, workplanPi, controller }) {
        await callTool(todoPi, "todo", { action: "add", text: "Integration task" });
        await waitFor(() => controller.current.step === "T1  Integration task");
        await seedWorkplan(workplanPi);
        await waitFor(() => controller.current.toward === "WP1-M1  Current milestone" && controller.current.focus === "Integration focus");
        assert.equal(controller.current.step, "T1  Integration task");
        assert.deepEqual(changes.at(-1), {
          step: "T1  Integration task",
          toward: "WP1-M1  Current milestone",
          focus: "Integration focus",
        });
      },
    });
  }
});

test("branch normalization conformance uses one fixture across Todo, Workplan, and Project Glance", async () => {
  for (const item of BRANCH_NORMALIZATION_CASES) {
    const expected = item.expected;
    const project = branchIdForContext(context(item.leafId));
    const todo = await observeTodoBranch(item.leafId);
    const workplan = workplanBranchId(item.leafId);
    const workplanProvider = await observeWorkplanBranch(item.leafId);
    assert.equal(project, expected, item.name);
    assert.equal(todo, expected, `Todo: ${item.name}`);
    assert.equal(workplan, expected, `Workplan helper: ${item.name}`);
    assert.equal(workplanProvider, expected, `Workplan provider: ${item.name}`);
  }
});

test("runtime reconciles authoritative branches through navigation, restart, ensure, and return", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-branch-") );
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  const bus = new EventBus();
  const state = { activeBranch: "A", requests: [], rejected: 0, pauseResponses: false };
  installBranchEnforcingProviders(bus, state);
  const runtime = new ProjectGlanceRelayRuntime(environment, bus);
  const sessionA = context("A", [], "branch-continuity-session");
  const sessionB = context("B", [], "branch-continuity-session");
  const sessionC = context("C", [], "branch-continuity-session");
  try {
    await runtime.ensureForContext(sessionA);
    await waitFor(() => runtime.current.step === "A-T1  A task");
    assert.equal(runtime.branchId, "A");
    let snapshot = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.deepEqual(snapshot.feed, []);

    state.activeBranch = "B";
    runtime.onSessionTree(sessionB);
    assert.equal(runtime.branchId, "B");
    assert.deepEqual(runtime.current, {});
    await waitFor(() => runtime.current.step === "B-T1  B task");
    snapshot = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.deepEqual(snapshot.feed, []);

    state.delayNextA = true;
    state.activeBranch = "A";
    runtime.onSessionTree(sessionA);
    await waitFor(() => runtime.current.step === "A-T1  A task");
    runtime.refreshCurrent();
    await waitFor(() => state.delayedA !== undefined);

    state.activeBranch = "B";
    runtime.onSessionTree(sessionB);
    await waitFor(() => runtime.current.step === "B-T1  B task");
    state.pauseResponses = true;
    await runtime.restart("2026-09-03T00:00:01.000Z");
    assert.equal(runtime.branchId, "B");
    snapshot = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.deepEqual(snapshot.current, {});
    assert.deepEqual(snapshot.feed, []);
    state.pauseResponses = false;
    runtime.refreshCurrent();
    await waitFor(() => runtime.current.step === "B-T1  B task");
    state.delayedA();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.current.step, "B-T1  B task");
    assert.equal(state.rejected, 0);

    state.activeBranch = "C";
    await runtime.ensureForContext(sessionC);
    assert.equal(runtime.branchId, "C");
    assert.deepEqual(runtime.current, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(runtime.current, {});
    snapshot = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.deepEqual(snapshot.current, {});
    assert.deepEqual(snapshot.feed, []);

    state.activeBranch = "A";
    await runtime.ensureForContext(sessionA);
    assert.equal(runtime.branchId, "A");
    await waitFor(() => runtime.current.step === "A-T1  A task");
    snapshot = await probeProjectGlanceRelay(runtime.descriptorPath);
    assert.equal(snapshot.current.step, "A-T1  A task");
    assert.deepEqual(snapshot.feed, []);
    assert.ok(state.requests.some(({ request }) => request.branchId === "B"));
    assert.ok(state.requests.some(({ request }) => request.branchId === "C"));
    assert.ok(state.requests.some(({ request }) => request.branchId === "A"));
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("source-specific changed parsers reject cross-source envelopes and unsafe branches", () => {
  const todoChanged = { version: 1, branchId: "branch-a", snapshot: { version: 1 } };
  assert.ok(parseTodoSummaryChanged(todoChanged, "branch-a"));
  assert.ok(parseTodoSummaryChanged({ version: 1, branchId: "branch-a" }, "branch-a"));
  assert.equal(parseTodoSummaryChanged({ ...todoChanged, extra: true }, "branch-a"), undefined);
  assert.equal(parseTodoSummaryChanged({ ...todoChanged, snapshot: { version: 2 } }, "branch-a"), undefined);
  assert.equal(parseTodoSummaryChanged({ ...todoChanged, branchId: "branch/a" }, "branch/a"), undefined);
  assert.ok(parseWorkplanSummaryChanged({ version: 1, branchId: "branch-a" }, "branch-a"));
  assert.equal(parseWorkplanSummaryChanged(todoChanged, "branch-a"), undefined);
  assert.equal(parseWorkplanSummaryChanged({ version: 1, branchId: "branch-a", snapshot: { version: 1 } }, "branch-a"), undefined);
});
