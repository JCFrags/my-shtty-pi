import assert from "node:assert/strict";
import test from "node:test";

import type { TokenSnapshot } from "../src/constants.ts";
import type { MetadataTransport } from "../src/herdr-client.ts";
import { MetadataReporter } from "../src/reporter.ts";
import { CapturingTransport, FakeClock, flushMicrotasks } from "./helpers.ts";

test("updates coalesce for 150 ms and reports remain at or below four per second", async () => {
  const clock = new FakeClock();
  const transport = new CapturingTransport();
  const reporter = new MetadataReporter(transport, { clock });

  reporter.setSnapshot({ summary: "a" });
  reporter.setSnapshot({ summary: "b" });
  reporter.setSnapshot({ summary: "c" });

  await clock.tick(149);
  assert.equal(transport.reports.length, 0);
  await clock.tick(1);
  assert.equal(transport.reports.length, 1);
  assert.equal(transport.reports[0]?.snapshot.summary, "c");
  assert.equal(transport.reports[0]?.ttlMs, 15_000);

  reporter.setSnapshot({ summary: "d" });
  await clock.tick(249);
  assert.equal(transport.reports.length, 1);
  await clock.tick(1);
  assert.equal(transport.reports.length, 2);
  assert.equal(transport.reports[1]?.sequence, 2);
});

test("sequence numbers are wall-clock anchored to remain fresh across process restarts", async () => {
  const clock = new FakeClock(1_234);
  const transport = new CapturingTransport();
  const reporter = new MetadataReporter(transport, { clock });

  reporter.setSnapshot({ summary: "waiting for model" });
  await clock.tick(150);

  assert.equal(transport.reports[0]?.sequence, 1_234_001);
  assert.equal(reporter.getStatus().nextSequence, 1_234_002);
});

test("TTL refresh resends the current snapshot without changing token contents", async () => {
  const clock = new FakeClock();
  const transport = new CapturingTransport();
  const reporter = new MetadataReporter(transport, { clock });
  const snapshot = { summary: "running npm test", tool: "bash" };

  reporter.setSnapshot(snapshot);
  await clock.tick(150);
  reporter.refresh();
  await clock.tick(250);

  assert.equal(transport.reports.length, 2);
  assert.deepEqual(transport.reports[1]?.snapshot, snapshot);
  assert.equal(transport.reports[1]?.ttlMs, 15_000);
});

test("in-flight reports serialize and newer state uses a larger sequence", async () => {
  const clock = new FakeClock();
  const pending: {
    snapshot: TokenSnapshot;
    sequence: number;
    resolve: () => void;
  }[] = [];
  const transport: MetadataTransport = {
    report(snapshot, sequence) {
      return new Promise<void>((resolve) => {
        pending.push({ snapshot: { ...snapshot }, sequence, resolve });
      });
    },
    async clear() {},
  };
  const reporter = new MetadataReporter(transport, { clock });

  reporter.setSnapshot({ summary: "older" });
  await clock.tick(150);
  assert.equal(pending.length, 1);

  reporter.setSnapshot({ summary: "newer" });
  await clock.tick(250);
  assert.equal(pending.length, 1, "second transport call must wait for the first");

  pending[0]?.resolve();
  await flushMicrotasks();
  await clock.tick(0);

  assert.equal(pending.length, 2);
  assert.deepEqual(
    pending.map(({ snapshot, sequence }) => ({ summary: snapshot.summary, sequence })),
    [
      { summary: "older", sequence: 1 },
      { summary: "newer", sequence: 2 },
    ],
  );
});

test("repeated failures back off and emit one concise notification", async () => {
  const clock = new FakeClock();
  const notifications: string[] = [];
  const transport: MetadataTransport = {
    async report() {
      throw new Error("server unavailable");
    },
    async clear() {},
  };
  const reporter = new MetadataReporter(transport, {
    clock,
    notifyPaused: (message) => notifications.push(message),
  });

  reporter.setSnapshot({ summary: "waiting for model" });
  await clock.tick(150); // failure 1
  await clock.tick(250); // failure 2
  await clock.tick(250); // failure 3, then one-second backoff

  assert.equal(reporter.getStatus().consecutiveFailures, 3);
  assert.deepEqual(notifications, ["Herdr status reporting paused after repeated failures"]);

  await clock.tick(999);
  assert.equal(reporter.getStatus().consecutiveFailures, 3);
  await clock.tick(1); // failure 4
  assert.equal(reporter.getStatus().consecutiveFailures, 4);
  assert.equal(notifications.length, 1);
});

test("shutdown cancels queued updates and performs one bounded clear", async () => {
  const clock = new FakeClock();
  const transport = new CapturingTransport();
  const reporter = new MetadataReporter(transport, { clock });

  reporter.setSnapshot({ summary: "queued" });
  await reporter.shutdownAndClear();
  await clock.tick(1_000);

  assert.equal(transport.reports.length, 0);
  assert.deepEqual(transport.clears, [1]);
});

test("shutdown clearing also respects the four-per-second report limit", async () => {
  const clock = new FakeClock();
  const transport = new CapturingTransport();
  const reporter = new MetadataReporter(transport, { clock });

  reporter.setSnapshot({ summary: "reported" });
  await clock.tick(150);
  assert.equal(transport.reports.length, 1);

  const shutdown = reporter.shutdownAndClear();
  await clock.tick(249);
  assert.equal(transport.clears.length, 0);
  await clock.tick(1);
  await shutdown;

  assert.deepEqual(transport.clears, [2]);
});
