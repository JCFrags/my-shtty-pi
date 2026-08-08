import assert from "node:assert/strict";
import test from "node:test";
import { QueueAbortError, ReviewQueue, type QueuePosition } from "../src/queue.js";
import { nextTick } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("parallel calls are serialized through a FIFO queue", async () => {
  const queue = new ReviewQueue();
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  const events: string[] = [];

  const promises = gates.map((gate, index) =>
    queue.enqueue(async () => {
      events.push(`start-${index + 1}`);
      const value = await gate.promise;
      events.push(`end-${index + 1}`);
      return value;
    }),
  );

  await nextTick();
  assert.deepEqual(events, ["start-1"]);
  gates[0]?.resolve("one");
  await nextTick();
  assert.deepEqual(events, ["start-1", "end-1", "start-2"]);
  gates[1]?.resolve("two");
  await nextTick();
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2", "start-3"]);
  gates[2]?.resolve("three");

  assert.deepEqual(await Promise.all(promises), ["one", "two", "three"]);
  assert.equal(queue.size, 0);
});

test("queue positions preserve item ordinals as calls are added", async () => {
  const queue = new ReviewQueue();
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const positions: QueuePosition[] = [];
  const secondPositions: QueuePosition[] = [];

  const first = queue.enqueue(async (context) => {
    context.onPositionChange((position) => positions.push(position));
    await firstGate.promise;
  });
  await nextTick();
  const second = queue.enqueue(async (context) => {
    context.onPositionChange((position) => secondPositions.push(position));
    await secondGate.promise;
  });
  const third = queue.enqueue(async () => undefined);
  await nextTick();

  assert.ok(positions.some((position) => position.current === 1 && position.total === 3));
  firstGate.resolve();
  await first;
  await nextTick();
  assert.ok(secondPositions.some((position) => position.current === 2 && position.total === 3));
  secondGate.resolve();
  await Promise.all([second, third]);
});

test("each queued call receives its own result", async () => {
  const queue = new ReviewQueue();
  const first = queue.enqueue(async () => "approve");
  const second = queue.enqueue(async () => "reject");
  assert.equal(await first, "approve");
  assert.equal(await second, "reject");
});

test("aborting a queued call rejects it deterministically without affecting the active call", async () => {
  const queue = new ReviewQueue();
  const activeGate = deferred<string>();
  const active = queue.enqueue(async () => activeGate.promise);
  const controller = new AbortController();
  const queued = queue.enqueue(async () => "should-not-run", controller.signal);
  controller.abort();

  await assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof QueueAbortError && error.blockReason === "Review aborted: tool call was cancelled",
  );
  activeGate.resolve("active-ok");
  assert.equal(await active, "active-ok");
  assert.equal(queue.size, 0);
});

test("abortAll unblocks active and queued handlers and never deadlocks", async () => {
  const queue = new ReviewQueue();
  const never = new Promise<never>(() => {});
  const active = queue.enqueue(async () => never);
  const queued = queue.enqueue(async () => "queued");
  await nextTick();
  queue.abortAll("Review aborted: session shutdown (reload)");

  for (const promise of [active, queued]) {
    await assert.rejects(
      promise,
      (error: unknown) =>
        error instanceof QueueAbortError &&
        error.blockReason === "Review aborted: session shutdown (reload)",
    );
  }
  assert.equal(queue.size, 0);
});

test("a runner exception fails its call but the next FIFO item still runs", async () => {
  const queue = new ReviewQueue();
  const first = queue.enqueue(async () => {
    throw new Error("dialog failed");
  });
  const second = queue.enqueue(async () => "next-ran");
  await assert.rejects(first, /dialog failed/);
  assert.equal(await second, "next-ran");
});

test("external abort listeners are removed after normal completion", async () => {
  const queue = new ReviewQueue();
  const controller = new AbortController();
  const signal = controller.signal;
  let additions = 0;
  let removals = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    additions += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removals += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];

  assert.equal(await queue.enqueue(async () => "ok", signal), "ok");
  assert.equal(additions, 1);
  assert.equal(removals, 1);
});
