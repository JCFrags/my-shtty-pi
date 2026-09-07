import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireHostWorkerSlot as oldAcquire } from "./fixtures/legacy-host-worker-scheduler.js";
import { installLegacyAdmissionGate, removeLegacyAdmissionGate, verifyLegacyAdmissionGate, withVerifiedLegacyAdmission } from "../src/worker-runtime-legacy-gate.js";
import { startContainedWorker, runtimeUnitName, runtimeUnitState } from "../src/worker-runtime-systemd.js";

async function fixture() { const directory = await mkdtemp(join(tmpdir(), "chrono-legacy-gate-test-")); return { directory, runtimeDirectory: join(directory, "runtime"), legacyDirectory: join(directory, "legacy") }; }
const oldOptions = (directory: string, slots = 4) => ({ directory, slots, timeoutMs: 100, pollMs: 20, priority: "high" as const, jobType: "replay-compaction" as const });

test("frozen 2.0.2 cannot admit future work after all four PID1 inhibitors; new rollback drains before legacy admission", async () => {
  const f = await fixture();
  try {
    let verified = false;
    await installLegacyAdmissionGate({ ...f, confirmLegacyQuiescent: async () => { verified = true; assert.equal((await readdir(f.legacyDirectory)).filter(n => n.startsWith("slot-")).length, 4); return true; } });
    assert.equal(verified, true); assert.equal(await verifyLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory), true);
    for (const slots of [1, 2, 3, 4]) await assert.rejects(oldAcquire(oldOptions(f.legacyDirectory, slots)), /scheduler-timeout/);
    for (let slot = 0; slot < 4; slot++) { const p = join(f.legacyDirectory, `slot-${slot}.json`); const value = JSON.parse(await readFile(p, "utf8")); assert.equal(value.pid, 1); assert.equal((await stat(p)).mode & 0o777, 0o600); }
    const worker = await startContainedWorker(f.runtimeDirectory, 0, 1, 10_000);
    assert.equal(await runtimeUnitState(worker.unit), "active");
    await removeLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory);
    assert.equal(await runtimeUnitState(runtimeUnitName(f.runtimeDirectory, 0)), "inactive");
    await worker.stop();
    assert.equal(await verifyLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory), false);
    const lease = await oldAcquire(oldOptions(f.legacyDirectory)); await lease.release();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("activation refuses old live occupancy and false quiescence without stealing files", async () => {
  const f = await fixture();
  try {
    const old = await oldAcquire(oldOptions(f.legacyDirectory));
    const before = await readFile(join(f.legacyDirectory, "slot-0.json"), "utf8");
    await assert.rejects(installLegacyAdmissionGate({ ...f, confirmLegacyQuiescent: async () => true }), { code: "EEXIST" });
    assert.equal(await readFile(join(f.legacyDirectory, "slot-0.json"), "utf8"), before);
    await old.release();
    await assert.rejects(installLegacyAdmissionGate({ ...f, confirmLegacyQuiescent: async () => false }), /legacy-workers-not-quiescent/);
    assert.equal((await readdir(f.legacyDirectory)).filter(n => n.startsWith("slot-")).length, 0);
    assert.equal(await verifyLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory), false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("reboot identity, malformed or replaced inhibitors fail closed; rollback preserves replacements", async () => {
  const f = await fixture();
  try {
    await installLegacyAdmissionGate({ ...f, confirmLegacyQuiescent: async () => true });
    const manifestPath = join(f.runtimeDirectory, "legacy-gate.json"), original = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), bootId: "different-boot" }));
    assert.equal(await verifyLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory), false);
    await assert.rejects(installLegacyAdmissionGate({ ...f, confirmLegacyQuiescent: async () => true }), /legacy-gate-recovery-required/);
    await writeFile(manifestPath, original);
    const slot = join(f.legacyDirectory, "slot-2.json"), prior = await readFile(slot, "utf8");
    await writeFile(slot, JSON.stringify({ ...JSON.parse(prior), nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    assert.equal(await verifyLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory), false);
    await assert.rejects(removeLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory), /worker-legacy-transition-required/);
    assert.match(await readFile(slot, "utf8"), /aaaaaaaa/);
    await writeFile(slot, prior); await removeLegacyAdmissionGate(f.runtimeDirectory, f.legacyDirectory);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});


test("rollback serializes with pending starts and never enables old admission before stopping the winner", async () => {
 const f=await fixture();
 try{
  await installLegacyAdmissionGate({...f,confirmLegacyQuiescent:async()=>true});
  let entered!:()=>void;const inside=new Promise<void>(resolve=>{entered=resolve;});
  const pending=withVerifiedLegacyAdmission(f.runtimeDirectory,async()=>{entered();await new Promise(resolve=>setTimeout(resolve,100));return startContainedWorker(f.runtimeDirectory,0,1,10_000);},f.legacyDirectory);
  await inside;const rollback=removeLegacyAdmissionGate(f.runtimeDirectory,f.legacyDirectory);const worker=await pending;await rollback;await worker.stop();
  assert.equal(await runtimeUnitState(worker.unit),"inactive");
  let started=false;await assert.rejects(withVerifiedLegacyAdmission(f.runtimeDirectory,async()=>{started=true;},f.legacyDirectory),/worker-legacy-transition-required/);assert.equal(started,false);
  const old=await oldAcquire(oldOptions(f.legacyDirectory));await old.release();
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
