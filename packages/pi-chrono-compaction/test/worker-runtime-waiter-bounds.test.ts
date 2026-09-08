import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { rm, readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { coalesceHostJob, rendezvousDirectory, WaiterCancellationError, WAITER_CANCELLATION_ALLOWANCE_MS } from "../src/worker-runtime-rendezvous.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const moduleUrl = new URL("../src/worker-runtime-rendezvous.js", import.meta.url).href;
async function fixture() {
  const namespace = `waiter-bounds-${randomBytes(12).toString("hex")}`;
  const identity = randomBytes(32).toString("hex");
  const directory = await rendezvousDirectory(namespace);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { coalesceHostJob } from ${JSON.stringify(moduleUrl)};
    const controller = new AbortController(); let release;
    process.on('message', m => { if(m==='release') release?.(); if(m==='abort') controller.abort(); });
    try {
      const value = await coalesceHostJob(${JSON.stringify(namespace)}, ${JSON.stringify(identity)}, controller.signal,
        signal => new Promise(resolve => {
          release = () => resolve('original');
          signal.addEventListener('abort', () => setTimeout(() => { process.send({kind:'cleaned'}); resolve('cleaned'); }, 30), {once:true});
          process.send({kind:'ready'});
        }), 4096, {deadlineMs: Date.now()+15000});
      process.send({kind:'result', value});
    } catch(e) { process.send({kind:'error', code:e.message, status:e.cancellationStatus}); }
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: "/usr/bin:/bin" } });
  let stderr = "";
  child.stderr!.on("data", b => stderr += b);
  const messages: Array<{kind: string; value?: string; status?: string}> = [];
  child.on("message", m => messages.push(m as typeof messages[number]));
  const closed = once(child, "exit");
  async function until(check: () => boolean) {
    for (let n = 0; n < 500; n++) { if (check()) return; await pause(10); }
    throw new Error(`fixture-wait-timeout: ${stderr}`);
  }
  await until(() => messages.some(m => m.kind === "ready"));
  return { child, messages, until, directory, namespace, identity,
    follow: (signal?: AbortSignal, timeout = 5000) => coalesceHostJob(namespace, identity, signal, async () => { throw new Error("duplicate-execution"); }, 4096, {deadlineMs: Date.now()+timeout}),
    cleanup: async () => {
      // Always resume our synthetic coordinator, including assertion failures.
      child.kill("SIGCONT");
      if (child.connected) { child.send("release"); child.disconnect(); }
      const exit = await Promise.race([closed.then(() => true), pause(3000).then(() => false)]);
      if (!exit) { child.kill("SIGKILL"); await closed; }
      await rm(directory, { recursive: true, force: true });
      assert.equal(stderr, "", "no unhandled socket errors");
    }
  };
}
async function stopped(pid: number) {
  for (let n = 0; n < 100; n++) {
    if (/State:\s+T/.test(await readFile(`/proc/${pid}/status`, "utf8"))) return;
    await pause(10);
  }
  throw new Error("coordinator-not-stopped");
}
function cancellation(code: string, status: string) {
  return (error: unknown) => error instanceof WaiterCancellationError && error.message === code && error.cancellationStatus === status;
}

for (const mode of ["deadline", "abort"] as const) {
  test(`SIGSTOP coordinator: ${mode} settles locally; resume preserves surviving job`, {timeout: 15000}, async () => {
    const f = await fixture();
    try {
      f.child.kill("SIGSTOP"); await stopped(f.child.pid!);
      const controller = new AbortController();
      const start = Date.now();
      const pending = f.follow(controller.signal, mode === "deadline" ? 900 : 5000);
      const rejected = assert.rejects(pending, cancellation(mode === "deadline" ? "worker-timeout" : "worker-aborted", "unconfirmed"));
      if (mode === "abort") { await pause(150); controller.abort(); }
      await rejected;
      const elapsed = Date.now() - start;
      const trigger = mode === "deadline" ? 900 : 150;
      assert.ok(elapsed >= trigger, `${elapsed} settled before cancellation`);
      assert.ok(elapsed < trigger + WAITER_CANCELLATION_ALLOWANCE_MS + 500, `${elapsed} exceeded local bound`);
      assert.ok((await readdir(f.directory)).some(n => /^[a-f0-9]{48}$/.test(n)), "live occupancy is not removed");
      f.child.kill("SIGCONT");
      const surviving = f.follow();
      await pause(100); f.child.send("release");
      assert.equal(await surviving, "original");
      await f.until(() => f.messages.some(m => m.kind === "result"));
      for (let n = 0; n < 100 && (await readdir(f.directory)).some(n => /^[a-f0-9]{48}$/.test(n)); n++) await pause(10);
      assert.equal((await readdir(f.directory)).filter(n => /^[a-f0-9]{48}$/.test(n)).length, 0);
    } finally { await f.cleanup(); }
  });
}

test("responsive coordinator acknowledges detachment without aborting surviving waiter", {timeout: 10000}, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const pending = f.follow(controller.signal);
    const rejected = assert.rejects(pending, cancellation("worker-aborted", "detached"));
    await pause(150); controller.abort(); await rejected;
    assert.ok(!f.messages.some(m => m.kind === "cleaned"));
    f.child.send("release");
    await f.until(() => f.messages.some(m => m.kind === "result" && m.value === "original"));
  } finally { await f.cleanup(); }
});

test("responsive last waiter acknowledges only after execution cleanup", {timeout: 10000}, async () => {
  const f = await fixture();
  try {
    f.child.send("abort");
    await f.until(() => f.messages.some(m => m.kind === "error"));
    assert.equal(f.messages.find(m => m.kind === "error")?.status, "confirmed");
    assert.ok(f.messages.findIndex(m => m.kind === "cleaned") < f.messages.findIndex(m => m.kind === "error"));
  } finally { await f.cleanup(); }
});

test("deadline bounds mutex election and fences late job execution", {timeout: 20000}, async () => {
  const namespace = `waiter-lock-${randomBytes(12).toString("hex")}`;
  const directory = await rendezvousDirectory(namespace);
  const lock = spawn("/usr/bin/flock", ["--exclusive", `${directory}/lock`, process.execPath, "-e", "process.stdout.write('ready');process.stdin.resume()"], {stdio:["pipe", "pipe", "pipe"], env:{PATH:"/usr/bin:/bin"}});
  const closed = once(lock, "close");
  try {
    await once(lock.stdout!, "data");
    // flock creates its path using the inherited umask; secure the fixture.
    const { chmod } = await import("node:fs/promises"); await chmod(`${directory}/lock`, 0o600);
    let executed = false; const start = Date.now();
    await assert.rejects(coalesceHostJob(namespace, randomBytes(32).toString("hex"), undefined, async () => {executed = true; return 1;}, 4096, {deadlineMs: start+900}), cancellation("worker-timeout", "detached"));
    assert.ok(Date.now()-start < 1650);
    lock.stdin!.end(); await closed;
    await pause(200);
    assert.equal(executed, false);
    assert.deepEqual((await readdir(directory)).filter(n => /^[a-f0-9]{48}$/.test(n)), []);
  } finally { lock.stdin!.end(); await closed; await rm(directory, {recursive:true, force:true}); }
});


test("dead coordinator permits re-election, not a duplicate while live", {timeout: 10000}, async () => {
  const f = await fixture();
  try {
    let executed = 0;
    const recovered = coalesceHostJob(f.namespace, f.identity, undefined, async () => { executed++; return "recovered"; }, 4096, {deadlineMs: Date.now()+5000});
    await pause(150); assert.equal(executed, 0);
    f.child.kill("SIGKILL");
    assert.equal(await recovered, "recovered"); assert.equal(executed, 1);
  } finally { await f.cleanup(); }
});

test("cleanup failure cannot acknowledge confirmed cancellation", {timeout: 10000}, async () => {
  const namespace = `waiter-cleanup-${randomBytes(12).toString("hex")}`;
  const directory = await rendezvousDirectory(namespace);
  const controller = new AbortController();
  try {
    const pending = coalesceHostJob(namespace, randomBytes(32).toString("hex"), controller.signal,
      signal => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("worker-containment-unavailable")), {once:true}); setTimeout(() => controller.abort(), 10); }), 4096);
    await assert.rejects(pending, cancellation("worker-aborted", "unconfirmed"));
    await pause(100);
  } finally { await rm(directory, {recursive:true, force:true}); }
});
