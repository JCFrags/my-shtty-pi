import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linuxProcessStartIdentity } from "../src/host-worker-scheduler.js";
import { runtimeAdmissionStatusText, runtimeHostStatus } from "../src/worker-runtime-status.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("read-only status distinguishes a stopped reservation owner from active worker execution", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-reservation-status-"));
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" },
  });
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data");
    const owner = { schemaVersion: 1, pid: child.pid!, processStartIdentity: linuxProcessStartIdentity(child.pid!),
      nonce: "a".repeat(32), createdAtMs: Date.now(), priority: "low", jobType: "candidate-store-update" };
    assert.match(owner.processStartIdentity ?? "", /^\d+$/);
    const path = join(directory, "slot-0.json"), contents = JSON.stringify(owner);
    await writeFile(path, contents, { mode: 0o600 });
    const before = await runtimeHostStatus({ schedulerDirectory: directory });
    assert.equal(before.active, 0);
    const unitState = before.reservations[0]?.unitState;
    assert.ok(unitState === "inactive" || unitState === "unknown", "The private unit is inactive, or the host has no user manager.");
    assert.equal(before.containmentAvailable, unitState === "inactive");
    assert.deepEqual(before.reservations, [{ slot: 0, ownerState: "present", unitState }]);

    child.kill("SIGSTOP");
    let status = before;
    for (let n = 0; n < 100; n++) {
      status = await runtimeHostStatus({ schedulerDirectory: directory });
      if (status.reservations[0]?.ownerState === "stopped") break;
      await pause(10);
    }
    assert.deepEqual(status.reservations, [{ slot: 0, ownerState: "stopped", unitState }]);
    assert.equal(status.active, 0);
    assert.deepEqual(status.jobs, []);
    assert.equal(await readFile(path, "utf8"), contents, "Status must not remove or change a live reservation.");
    assert.deepEqual(await readdir(directory), ["slot-0.json"]);
    const text = runtimeAdmissionStatusText(status);
    assert.match(text, new RegExp(`owner stopped, unit ${unitState}`));
    assert.match(text, /deadlines include admission wait, not only worker execution/);
    assert.doesNotMatch(JSON.stringify(status) + text, /\/tmp|\/home|processStartIdentity|nonce|"pid"/);

    await writeFile(path, JSON.stringify({ ...owner, processStartIdentity: "0" }));
    assert.equal((await runtimeHostStatus({ schedulerDirectory: directory })).reservations[0]?.ownerState, "gone",
      "A reused PID must not identify a stopped owner.");
    await writeFile(path, "{}");
    assert.equal((await runtimeHostStatus({ schedulerDirectory: directory })).reservations[0]?.ownerState, "unverified");
    assert.equal(await readFile(path, "utf8"), "{}", "Status must not repair malformed metadata.");
  } finally {
    // Resume and terminate only this synthetic process, never a live installation process.
    child.kill("SIGCONT");
    child.kill("SIGTERM");
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
