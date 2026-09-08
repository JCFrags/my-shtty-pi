import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProjectGlanceCurrentController,
} from "../dist/current/controller.js";
import { displayText, formatStep, formatToward } from "../dist/current/format.js";
import {
  parseTodoSummary,
  parseWorkplanSummary,
  TODO_SUMMARY_EVENT,
  TODO_SUMMARY_REQUEST_EVENT,
  WORKPLAN_SUMMARY_EVENT,
  WORKPLAN_SUMMARY_REQUEST_EVENT,
} from "../dist/current/contracts.js";
import { formatCurrentProjection } from "../dist/current/format.js";
import { prepareProjectGlanceCommand } from "../dist/pi/open-pane.js";
import {
  createLiveSnapshot,
  ProjectGlanceRelayRuntime,
} from "../dist/pi/lifecycle.js";
import { ProjectGlanceServer } from "../dist/protocol/server.js";
import { validateSnapshot } from "../dist/protocol/validation.js";
import { validateProjectionText } from "../dist/protocol/projection-text.js";
import { probeProjectGlanceRelay } from "../dist/protocol/client.js";
import { deriveSessionKey } from "../dist/runtime/paths.js";

class EventBus {
  #listeners = new Map();

  on(channel, handler) {
    const listeners = this.#listeners.get(channel) ?? new Set();
    listeners.add(handler);
    this.#listeners.set(channel, listeners);
    return () => listeners.delete(handler);
  }

  emit(channel, value) {
    for (const handler of [...(this.#listeners.get(channel) ?? [])]) handler(value);
  }
}

function respondWithCurrent(bus, delayMs = 0) {
  bus.on(TODO_SUMMARY_REQUEST_EVENT, (request) => {
    const response = () => bus.emit(TODO_SUMMARY_EVENT, {
      version: 1,
      requestId: request.requestId,
      branchId: request.branchId,
      snapshot: {
        version: 1,
        currentUsefulTask: { id: "T1", text: "Do the bounded work", status: "blocked", waitReason: "external approval" },
      },
    });
    if (delayMs > 0) setTimeout(response, delayMs);
    else response();
  });
  bus.on(WORKPLAN_SUMMARY_REQUEST_EVENT, (request) => {
    const response = () => bus.emit(WORKPLAN_SUMMARY_EVENT, {
      version: 1,
      requestId: request.requestId,
      branchId: request.branchId,
      summary: {
        version: 1,
        activePlan: {
          id: "WP1",
          title: "Plan",
          objective: "Objective",
          revision: 2,
          currentMilestone: { id: "WP1-M1", title: "Milestone", status: "blocked" },
          latestCheckpoint: { id: "WP1-K1", summary: "Checkpoint", currentFocus: "Focus", at: "2026-09-03T00:00:00.000Z" },
        },
      },
    });
    if (delayMs > 0) setTimeout(response, delayMs);
    else response();
  });
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("production live snapshot starts empty and leaves the feed empty", () => {
  const snapshot = createLiveSnapshot("session-key", "2026-09-03T00:00:00.000Z");
  assert.deepEqual(snapshot.current, {});
  assert.deepEqual(snapshot.feed, []);
  assert.equal(snapshot.revision, 1);
});

test("current formatter maps bounded source state to Step, Toward, and Focus", () => {
  const formatted = formatCurrentProjection(
    { id: "T1", text: "Do the bounded work", status: "blocked", waitReason: "external approval" },
    {
      id: "WP1",
      title: "Plan",
      objective: "Objective",
      revision: 2,
      currentMilestone: { id: "WP1-M1", title: "Milestone", status: "blocked" },
      latestCheckpoint: { id: "WP1-K1", summary: "Checkpoint", currentFocus: "Focus", at: "2026-09-03T00:00:00.000Z" },
    },
  );
  assert.deepEqual(formatted, {
    step: "T1  Do the bounded work — waiting: external approval",
    toward: "WP1-M1  Milestone — blocked",
    focus: "Focus",
  });
  assert.equal(formatted.step.includes("T1 Do the bounded work"), false);
  assert.equal(formatted.toward.includes("WP1-M1 Milestone"), false);
  assert.deepEqual(formatCurrentProjection({ text: "Finished", status: "done" }, undefined), {});
});

test("projection privacy replaces embedded home paths and isolates unsafe rows", () => {
  const home = homedir().replace(/\/+$/u, "");
  assert.equal(formatStep({ text: `Inspect ${home}/project/file.ts`, status: "pending" }), "Inspect $HOME/project/file.ts");
  assert.equal(displayText(`prefix${home}/embedded/file.ts`), "prefix$HOME/embedded/file.ts");
  assert.equal(displayText("Read src/current/format.ts"), "Read src/current/format.ts");
  assert.equal(displayText("Open https://example.com/project"), "Open https://example.com/project");
  assert.equal(displayText("Inspect [/tmp/private/file.ts]"), undefined);
  assert.equal(displayText("/"), undefined);
  assert.equal(displayText("//tmp/private/file.ts"), undefined);
  assert.equal(displayText("\\\\server\\share\\private\\file.ts"), undefined);
  assert.equal(displayText("file:///"), undefined);
  assert.equal(displayText("file://localhost/tmp/private/file.ts"), undefined);
  assert.equal(validateProjectionText("\\\\server\\share\\private\\file.ts", 512), undefined);
  assert.equal(validateProjectionText("file://localhost/tmp/private/file.ts", 512), undefined);
  assert.equal(displayText(`Inspect ${home}2/project/file.ts`), undefined);
  assert.equal(formatStep({ id: "/private/task-id", text: "Safe task", status: "blocked", waitReason: "/var/private/reason" }), "Safe task");
  assert.equal(formatStep({ id: "T1", text: "Safe task", status: "blocked", waitReason: "/private/reason" }), "T1  Safe task");
  assert.equal(formatToward({
    id: "WP1",
    title: "Plan",
    objective: "Objective",
    revision: 1,
    currentMilestone: { id: "/private/milestone-id", title: "Milestone", status: "in_progress" },
  }), "Milestone");

  const todoUnsafe = { id: "T1", text: "/private/task", status: "pending" };
  const safeWorkplan = {
    id: "WP1",
    title: "Plan",
    objective: "Objective",
    revision: 1,
    currentMilestone: { id: "WP1-M1", title: "Milestone", status: "in_progress" },
    latestCheckpoint: { id: "WP1-K1", summary: "Checkpoint", currentFocus: "Focus", at: "2026-09-03T00:00:00.000Z" },
  };
  const onlyWorkplan = formatCurrentProjection(todoUnsafe, safeWorkplan);
  assert.deepEqual(onlyWorkplan, { toward: "WP1-M1  Milestone", focus: "Focus" });
  assert.deepEqual(validateSnapshot({
    ...createLiveSnapshot("a".repeat(16), "2026-09-03T00:00:00.000Z"),
    current: onlyWorkplan,
  }).current, onlyWorkplan);

  const unsafeFocus = { ...safeWorkplan, latestCheckpoint: { ...safeWorkplan.latestCheckpoint, currentFocus: "/private/focus" } };
  const onlySafeTodo = formatCurrentProjection({ id: "T1", text: "Safe task", status: "pending" }, unsafeFocus);
  assert.deepEqual(onlySafeTodo, { step: "T1  Safe task", toward: "WP1-M1  Milestone" });
  assert.deepEqual(validateSnapshot({
    ...createLiveSnapshot("b".repeat(16), "2026-09-03T00:00:00.000Z"),
    current: onlySafeTodo,
  }).current, onlySafeTodo);
});

test("provider request and branch identifiers preserve exact bytes", () => {
  const requestId = " request  1 ";
  const branchId = " branch  A ";
  const todo = parseTodoSummary({
    version: 1,
    requestId,
    branchId,
    snapshot: { version: 1, currentUsefulTask: { text: "Task", status: "pending" } },
  }, requestId, branchId);
  assert.equal(todo.requestId, requestId);
  assert.equal(todo.branchId, branchId);
  assert.equal(parseTodoSummary({
    version: 1,
    requestId: "request  1",
    branchId,
    snapshot: { version: 1 },
  }, requestId, branchId), undefined);

  const workplan = parseWorkplanSummary({
    version: 1,
    requestId,
    branchId,
    summary: { version: 1 },
  }, requestId, branchId);
  assert.equal(workplan.requestId, requestId);
  assert.equal(workplan.branchId, branchId);
  assert.equal(parseWorkplanSummary({
    version: 1,
    requestId,
    branchId: "branch  A",
    summary: { version: 1 },
  }, requestId, branchId), undefined);
});

test("controller correlates both providers and publishes only semantic changes", async () => {
  const bus = new EventBus();
  respondWithCurrent(bus);
  const changes = [];
  const controller = new ProjectGlanceCurrentController({ eventBus: bus, retryDelaysMs: [], onChange: (value) => changes.push(value) });
  controller.start("leaf-a");
  await waitFor(() => controller.current.focus === "Focus");
  assert.deepEqual(controller.current, {
    step: "T1  Do the bounded work — waiting: external approval",
    toward: "WP1-M1  Milestone — blocked",
    focus: "Focus",
  });
  const count = changes.length;
  bus.emit("pi-todo:summary-changed-v1", { version: 1, branchId: "leaf-a" });
  assert.equal(changes.length, count);
  controller.dispose();
});

test("controller publication is transactional across thrown and false callbacks", async () => {
  for (const failure of ["throw", "false"]) {
    const bus = new EventBus();
    let callbackMode = failure;
    let requestCount = 0;
    let acceptedCount = 0;
    bus.on(TODO_SUMMARY_REQUEST_EVENT, (request) => {
      requestCount += 1;
      bus.emit(TODO_SUMMARY_EVENT, {
        version: 1,
        requestId: request.requestId,
        branchId: request.branchId,
        snapshot: { version: 1, currentUsefulTask: { id: "T1", text: "Retryable task", status: "pending" } },
      });
    });
    const attempts = [];
    const controller = new ProjectGlanceCurrentController({
      eventBus: bus,
      retryDelaysMs: [],
      onChange: (value) => {
        attempts.push(value);
        if (callbackMode === "throw") {
          callbackMode = "success";
          throw new Error("PUBLISH_FAILED");
        }
        if (callbackMode === "false") {
          callbackMode = "success";
          return false;
        }
        acceptedCount += 1;
      },
    });
    controller.start("branch");
    await waitFor(() => requestCount === 1);
    assert.deepEqual(controller.current, {});
    controller.refresh();
    await waitFor(() => controller.current.step === "T1  Retryable task");
    assert.equal(acceptedCount, 1);
    assert.equal(attempts.length, 2);
    const beforeDuplicate = attempts.length;
    controller.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.length, beforeDuplicate);
    controller.dispose();
  }
});

test("command preparation reconciles command context before one refresh", async () => {
  const order = [];
  let branch = "A";
  const requests = [];
  const runtime = {
    descriptorPath: "/disposable/descriptor.json",
    sessionKey: "0123456789abcdef",
    async ensureForContext(ctx) {
      order.push("ensure");
      branch = ctx.sessionManager.getLeafId();
      requests.push({ branch, phase: "ensure" });
    },
    refreshCurrent() {
      order.push("refresh");
      requests.push({ branch, phase: "refresh" });
    },
  };
  const ctx = {
    cwd: "/disposable",
    sessionManager: {
      getLeafId: () => "B",
      getSessionId: () => "command-session",
      getBranch: () => [],
    },
  };
  const prepared = await prepareProjectGlanceCommand(ctx, runtime, { HERDR_ENV: "1", HERDR_PANE_ID: "pane-b" });
  assert.deepEqual(order, ["ensure", "refresh"]);
  assert.deepEqual(requests, [{ branch: "B", phase: "ensure" }, { branch: "B", phase: "refresh" }]);
  assert.equal(prepared.sessionKey, runtime.sessionKey);
  assert.equal(prepared.descriptorPath, runtime.descriptorPath);
  assert.equal(prepared.currentPaneId, "pane-b");
  assert.equal(prepared.cwd, undefined);
});

test("controller defers initial requests for provider restore ordering", async () => {
  const bus = new EventBus();
  const controller = new ProjectGlanceCurrentController({ eventBus: bus, retryDelaysMs: [], onChange: () => undefined });
  controller.start("leaf-order");
  queueMicrotask(() => respondWithCurrent(bus));
  await waitFor(() => controller.current.focus === "Focus");
  assert.equal(controller.current.step, "T1  Do the bounded work — waiting: external approval");
  controller.dispose();
});

test("controller clears on branch change and rejects old-epoch responses", async () => {
  const bus = new EventBus();
  const requests = [];
  bus.on(TODO_SUMMARY_REQUEST_EVENT, (request) => requests.push({ source: "todo", request }));
  bus.on(WORKPLAN_SUMMARY_REQUEST_EVENT, (request) => requests.push({ source: "workplan", request }));
  const changes = [];
  const controller = new ProjectGlanceCurrentController({ eventBus: bus, retryDelaysMs: [], onChange: (value) => changes.push(value) });
  controller.start("leaf-a");
  await waitFor(() => requests.some((item) => item.source === "todo"));
  const oldTodo = requests.find((item) => item.source === "todo").request;
  bus.emit(TODO_SUMMARY_EVENT, { version: 1, requestId: oldTodo.requestId, branchId: "leaf-a", snapshot: { version: 1, currentUsefulTask: { id: "old", text: "Old", status: "pending" } } });
  assert.equal(controller.current.step, "old  Old");
  controller.onSessionTree("leaf-b");
  assert.deepEqual(controller.current, {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  const currentTodo = requests.filter((item) => item.source === "todo").at(-1).request;
  bus.emit(TODO_SUMMARY_EVENT, { version: 1, requestId: currentTodo.requestId, branchId: "leaf-b", snapshot: { version: 1, currentUsefulTask: { id: "new", text: "New", status: "pending" } } });
  assert.equal(controller.current.step, "new  New");
  assert.ok(changes.some((value) => Object.keys(value).length === 0));
  controller.dispose();
});

test("controller retries finite requests when a provider becomes available late", async () => {
  const bus = new EventBus();
  const responses = [];
  const controller = new ProjectGlanceCurrentController({ eventBus: bus, retryDelaysMs: [5], onChange: (value) => responses.push(value) });
  controller.start("leaf-late");
  bus.on(TODO_SUMMARY_REQUEST_EVENT, (request) => bus.emit(TODO_SUMMARY_EVENT, {
    version: 1,
    requestId: request.requestId,
    branchId: request.branchId,
    snapshot: { version: 1, currentUsefulTask: { text: "Late task", status: "pending" } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.current.step, "Late task");
  assert.equal(responses.at(-1).step, "Late task");
  controller.dispose();
});

test("runtime publication failure leaves relay state unchanged and retries exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-publication-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  const bus = new EventBus();
  let requests = 0;
  bus.on(TODO_SUMMARY_REQUEST_EVENT, (request) => {
    requests += 1;
    bus.emit(TODO_SUMMARY_EVENT, {
      version: 1,
      requestId: request.requestId,
      branchId: request.branchId,
      snapshot: { version: 1, currentUsefulTask: { id: "T1", text: "Retryable task", status: "pending" } },
    });
  });
  const originalPublish = ProjectGlanceServer.prototype.publish;
  let failures = 1;
  ProjectGlanceServer.prototype.publish = function publishWithOneFailure(snapshot) {
    if (failures > 0) {
      failures -= 1;
      throw new Error("PUBLISH_FAILED");
    }
    return originalPublish.call(this, snapshot);
  };
  const runtime = new ProjectGlanceRelayRuntime(environment, bus);
  try {
    await runtime.start(deriveSessionKey("publication-session"), "2026-09-03T00:00:00.000Z");
    const descriptorPath = runtime.descriptorPath;
    assert.ok(descriptorPath);
    await waitFor(() => requests > 0);
    assert.deepEqual(runtime.current, {});
    assert.equal((await probeProjectGlanceRelay(descriptorPath)).revision, 1);

    runtime.refreshCurrent();
    await waitFor(() => runtime.current.step === "T1  Retryable task");
    const accepted = await probeProjectGlanceRelay(descriptorPath);
    assert.equal(accepted.revision, 2);

    runtime.refreshCurrent();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await probeProjectGlanceRelay(descriptorPath)).revision, 2);
  } finally {
    ProjectGlanceServer.prototype.publish = originalPublish;
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("live runtime starts empty, publishes bounded current state, and resets on branch changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-glance-current-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root };
  const bus = new EventBus();
  respondWithCurrent(bus, 20);
  const runtime = new ProjectGlanceRelayRuntime(environment, bus);
  try {
    await runtime.start(deriveSessionKey("live-session"), "2026-09-03T00:00:00.000Z");
    const descriptorPath = runtime.descriptorPath;
    assert.ok(descriptorPath);
    const initial = await probeProjectGlanceRelay(descriptorPath);
    assert.deepEqual(initial.current, {});
    assert.deepEqual(initial.feed, []);
    assert.equal(initial.revision, 1);

    await waitFor(() => runtime.current.focus === "Focus");
    const connected = await probeProjectGlanceRelay(descriptorPath);
    assert.equal(connected.current.step, "T1  Do the bounded work — waiting: external approval");
    assert.equal(connected.current.toward, "WP1-M1  Milestone — blocked");
    assert.equal(connected.current.focus, "Focus");
    assert.deepEqual(connected.feed, []);
    assert.equal(connected.revision, 3);

    await runtime.onSessionTree({ sessionManager: { getLeafId: () => "leaf-b" } });
    const cleared = await probeProjectGlanceRelay(descriptorPath);
    assert.deepEqual(cleared.current, {});
    assert.deepEqual(cleared.feed, []);
    assert.equal(cleared.revision, 4);

    await waitFor(() => runtime.current.focus === "Focus");
    await runtime.restart("2026-09-03T00:00:01.000Z");
    const restartedDescriptorPath = runtime.descriptorPath;
    assert.ok(restartedDescriptorPath);
    const restartedInitial = await probeProjectGlanceRelay(restartedDescriptorPath);
    assert.deepEqual(restartedInitial.current, {});
    assert.deepEqual(restartedInitial.feed, []);
    await waitFor(() => runtime.current.focus === "Focus");
    assert.equal(runtime.current.step, "T1  Do the bounded work — waiting: external approval");
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
