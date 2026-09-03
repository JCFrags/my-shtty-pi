import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProjectGlanceCurrentController,
} from "../dist/current/controller.js";
import {
  TODO_SUMMARY_EVENT,
  TODO_SUMMARY_REQUEST_EVENT,
  WORKPLAN_SUMMARY_EVENT,
  WORKPLAN_SUMMARY_REQUEST_EVENT,
} from "../dist/current/contracts.js";
import { formatCurrentProjection } from "../dist/current/format.js";
import {
  createLiveSnapshot,
  ProjectGlanceRelayRuntime,
} from "../dist/pi/lifecycle.js";
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
  assert.deepEqual(formatCurrentProjection(
    { id: "T1", text: "Do the bounded work", status: "blocked", waitReason: "external approval" },
    {
      id: "WP1",
      title: "Plan",
      objective: "Objective",
      revision: 2,
      currentMilestone: { id: "WP1-M1", title: "Milestone", status: "blocked" },
      latestCheckpoint: { id: "WP1-K1", summary: "Checkpoint", currentFocus: "Focus", at: "2026-09-03T00:00:00.000Z" },
    },
  ), {
    step: "T1  Do the bounded work — waiting: external approval",
    toward: "WP1-M1  Milestone — blocked",
    focus: "Focus",
  });
  assert.deepEqual(formatCurrentProjection({ text: "Finished", status: "done" }, undefined), {});
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

    runtime.onSessionTree({ sessionManager: { getLeafId: () => "leaf-b" } });
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
