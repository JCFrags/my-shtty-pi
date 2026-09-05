import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAdmissionController } from "../src/memory-admission.js";

test("memory admission reserves atomically and reports every retained component", () => {
  const controller = new MemoryAdmissionController(1_000);
  const load = controller.reserve({ pendingLoad: 600 });
  assert.ok(load);
  assert.equal(controller.reserve({ pendingBuild: 401 }), undefined);
  assert.deepEqual(controller.status(), {
    byteLimit: 1_000,
    totalBytes: 600,
    reservations: 1,
    components: { pendingLoad: 600, pendingBuild: 0, liveIndex: 0, queryResults: 0, retainedReferences: 0 },
  });

  assert.equal(load.move({ pendingBuild: 600 }), true);
  assert.equal(load.move({ liveIndex: 250, queryResults: 50, retainedReferences: 300 }), true);
  assert.deepEqual(controller.status().components, {
    pendingLoad: 0,
    pendingBuild: 0,
    liveIndex: 250,
    queryResults: 50,
    retainedReferences: 300,
  });
  load.release();
  load.release();
  assert.equal(controller.status().totalBytes, 0);
  assert.equal(controller.status().reservations, 0);
});

test("memory admission refuses a growing transition without losing the existing reservation", () => {
  const controller = new MemoryAdmissionController(1_000);
  const first = controller.reserve({ pendingLoad: 700 });
  const second = controller.reserve({ queryResults: 300 });
  assert.ok(first && second);
  assert.equal(first.move({ pendingBuild: 701 }), false);
  assert.deepEqual(controller.status().components, {
    pendingLoad: 700,
    pendingBuild: 0,
    liveIndex: 0,
    queryResults: 300,
    retainedReferences: 0,
  });
  first.release();
  second.release();
});

test("memory admission rejects invalid requests and released transitions", () => {
  const controller = new MemoryAdmissionController(100);
  assert.throws(() => controller.reserve({}), /invalid-memory-admission-request/);
  assert.throws(() => controller.reserve({ pendingLoad: -1 }), /invalid-memory-admission-request/);
  const reservation = controller.reserve({ pendingLoad: 1 });
  assert.ok(reservation);
  reservation.release();
  assert.throws(() => reservation.move({ pendingBuild: 1 }), /memory-reservation-released/);
});
