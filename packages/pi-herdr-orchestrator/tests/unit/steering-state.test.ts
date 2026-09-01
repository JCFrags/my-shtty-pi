import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256 } from "../../src/shared/canonical-json.js";
import { emptyState, reduce } from "../../src/state/reducer.js";

const actor = { principalId: "prn_parent", kind: "pi_parent" };
const commandId = `cmd_${"0".repeat(26)}`;
const taskId = `tsk_${"1".repeat(26)}`;
const runId = `run_${"2".repeat(26)}`;
const agentId = `agt_${"3".repeat(26)}`;
const message = "Inspect the failure before editing.";

function workingState() {
  const state = emptyState();
  state.tasks[taskId] = {
    id: taskId,
    title: "Inspect",
    objective: "Inspect",
    state: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    currentRunId: runId,
    assignedAgentId: agentId,
  };
  state.runs[runId] = {
    id: runId,
    taskId,
    state: "working",
    agentId,
    agentGeneration: 4,
    assignmentGeneration: 7,
    assignmentDeliveryState: "accepted",
    piSessionId: "pi-session",
    settled: false,
  };
  state.agents[agentId] = {
    id: agentId,
    state: "working",
    generation: 4,
    currentRunId: runId,
    currentAssignmentGeneration: 7,
    piSessionId: "pi-session",
  };
  return state;
}

function enqueue(state = workingState()) {
  const paramsHash = sha256(
    canonicalJson({ method: "task.steer", taskId, message, delivery: "steer" }),
  );
  return reduce(state, {
    type: "steering.command.enqueued",
    actor,
    entityRefs: { commandId, taskId, runId, agentId },
    payload: {
      commandId,
      principalId: actor.principalId,
      taskId,
      runId,
      assignmentGeneration: 7,
      agentId,
      agentGeneration: 4,
      piSessionId: "pi-session",
      message,
      messageHash: sha256(message),
      idempotencyKey: "steer-once",
      paramsHash,
      timeoutMs: 10_000,
      createdAt: "2026-09-01T00:00:01.000Z",
    },
  });
}

test("steering command state persists identity, idempotency, and delivered lifecycle", () => {
  const pending = enqueue();
  assert.equal(pending.steeringCommands?.[commandId]?.state, "pending");
  assert.equal(pending.steeringCommands?.[commandId]?.message, message);
  assert.deepEqual(pending.idempotency["steer-once"]?.response, { commandId });

  const dispatching = reduce(pending, {
    type: "steering.command.dispatch_started",
    actor: { principalId: "broker", kind: "system" },
    entityRefs: { commandId, taskId, runId, agentId },
    payload: { commandId, at: "2026-09-01T00:00:02.000Z" },
  });
  assert.equal(
    dispatching.steeringCommands?.[commandId]?.state,
    "delivery_unknown",
  );

  const delivered = reduce(dispatching, {
    type: "steering.command.delivered",
    actor: { principalId: "broker", kind: "system" },
    entityRefs: { commandId, taskId, runId, agentId },
    payload: { commandId, at: "2026-09-01T00:00:03.000Z" },
  });
  assert.equal(delivered.steeringCommands?.[commandId]?.state, "delivered");
  assert.equal(
    delivered.steeringCommands?.[commandId]?.deliveredAt,
    "2026-09-01T00:00:03.000Z",
  );
  assert.throws(
    () =>
      reduce(delivered, {
        type: "steering.command.delivered",
        actor: { principalId: "broker", kind: "system" },
        entityRefs: { commandId },
        payload: { commandId, at: "2026-09-01T00:00:04.000Z" },
      }),
    /Steering command transition is invalid/u,
  );
});

test("dispatch start is conservatively recoverable as delivery_unknown", () => {
  const pending = enqueue();
  const unknown = reduce(pending, {
    type: "steering.command.dispatch_started",
    actor: { principalId: "broker", kind: "system" },
    entityRefs: { commandId, taskId, runId, agentId },
    payload: { commandId, at: "2026-09-01T00:00:02.000Z" },
  });
  assert.equal(
    unknown.steeringCommands?.[commandId]?.state,
    "delivery_unknown",
  );
  const finalized = reduce(unknown, {
    type: "steering.command.delivery_unknown",
    actor: { principalId: "broker", kind: "system" },
    entityRefs: { commandId, taskId, runId, agentId },
    payload: {
      commandId,
      at: "2026-09-01T00:00:12.000Z",
      reasonCode: "TIMEOUT",
    },
  });
  assert.equal(finalized.steeringCommands?.[commandId]?.reasonCode, "TIMEOUT");
  assert.equal(
    finalized.steeringCommands?.[commandId]?.terminalAt,
    "2026-09-01T00:00:12.000Z",
  );
});
