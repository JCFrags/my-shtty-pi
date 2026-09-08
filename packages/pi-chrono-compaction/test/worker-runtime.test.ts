import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runBoundedWorker, canonicalWorkerJson, runtimeHostStatus, type BoundedWorkerOptions } from "../src/worker-runtime.js";
import { runtimeUnitName, runtimeUnitState } from "../src/worker-runtime-systemd.js";
import { rendezvousDirectory } from "../src/worker-runtime-rendezvous.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Request { id: string; action: string; marker: string; ms: number; }
interface Response { id: string; pid: number; group: string; started: number; ended: number; descendant?: number; code?: string; }
function validateRequest(value: unknown): Request {
  const v = value as Request;
  if (!v || Object.keys(v).sort().join(",") !== "action,id,marker,ms" || !["wait", "descendant", "pressure", "read", "kill"].includes(v.action) || typeof v.id !== "string" || typeof v.marker !== "string" || !Number.isSafeInteger(v.ms)) throw new Error("invalid-request");
  return v;
}
function validateResponse(value: unknown): Response | undefined {
  if (value && typeof value === "object" && Object.keys(value).sort().join(",") === "kind,stage" && (value as {kind?: unknown}).kind === "progress" && (value as {stage?: unknown}).stage === "synthetic-running") return undefined;
  const v = value as Response;
  if (!v || !Number.isSafeInteger(v.pid) || typeof v.id !== "string" || typeof v.group !== "string" || !Number.isSafeInteger(v.started) || !Number.isSafeInteger(v.ended)) throw new Error("invalid-response");
  return v;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chrono-runtime-test-"));
  const entryPath = join(directory, "worker.mjs");
  await writeFile(entryPath, `import {readFileSync,writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
process.on('message',q=>{process.send({kind:'progress',stage:'synthetic-running'});const started=Date.now();const group=readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1];writeFileSync(q.marker,JSON.stringify({pid:process.pid,group,started}));
const send=(extra={})=>process.send({id:q.id,pid:process.pid,group,started,ended:Date.now(),...extra});
if(q.action==='kill'){process.kill(process.pid,'SIGKILL');return;}
if(q.action==='pressure'){const held=[];setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),1);return;}
if(q.action==='descendant'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});send({descendant:child.pid});return;}
if(q.action==='read'){try{readFileSync(q.marker+'.large');}catch(e){send({code:e.code});}return;}
setTimeout(()=>send(),q.ms);});\n`, { mode: 0o600 });
  const schedulerDirectory = join(directory, "pool");
  const options = (id = "job", action = "wait", ms = 150): BoundedWorkerOptions<Request, Response> => ({ entryPath, request: { id, action, marker: join(directory, `${id}.marker`), ms }, identity: { schemaVersion: 1, kind: "synthetic", sessionKey: hash(id) }, caps: { deadlineMs: Date.now() + 30_000, sourceBytes: 1024 * 1024, responseBytes: 4096 }, schedulerDirectory, validateRequest, validateResponse });
  return { directory, entryPath, schedulerDirectory, options, cleanup: async () => { await rm(directory, { recursive: true, force: true }); const rv = await rendezvousDirectory(schedulerDirectory); await rm(rv, { recursive: true, force: true }); } };
}
async function marker(path: string): Promise<Response> { for (let n = 0; n < 500; n++) { try { return JSON.parse(await readFile(path, "utf8")); } catch { await pause(10); } } throw new Error("marker-timeout"); }
const runtimePath = fileURLToPath(new URL("../src/worker-runtime.js", import.meta.url));
function independent(options: BoundedWorkerOptions<Request, Response>, repeats = 1): { child: ChildProcess; result: Promise<Response[]> } {
  const { validateRequest: _a, validateResponse: _b, signal: _s, ...settings } = options;
  const script = `import {runBoundedWorker} from ${JSON.stringify(runtimePath)};const options=${JSON.stringify(settings)};let out=[];for(let n=0;n<${repeats};n++){const r=await runBoundedWorker({...options,request:{...options.request,id:options.request.id+'-'+n},validateRequest:v=>v,validateResponse:v=>v?.kind==='progress'?undefined:v});out.push(r.value);}process.stdout.write(JSON.stringify(out)+'\\n');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  const result = new Promise<Response[]>((resolve, reject) => { let out = "", err = ""; child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b); child.on("error", reject); child.on("close", code => { if (code !== 0) reject(new Error(`independent-client-${code}: ${err.slice(-1500)}`)); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } }); });
  return { child, result };
}

test("six independent clients repeat under actual cgroup slots 1, 2, 4", { timeout: 120_000 }, async () => {
  for (const slots of [1, 2, 4]) {
    const f = await fixture();
    try {
      const jobs = Array.from({ length: 6 }, (_, n) => independent({ ...f.options(`client-${n}`, "wait", 1500), slots }, 2));
      const results = (await Promise.all(jobs.map(j => j.result))).flat();
      assert.equal(results.length, 12);
      const groups = new Set(results.map(r => r.group)); assert.ok(groups.size <= slots);
      const events = results.flatMap(r => [{ at: r.started, delta: 1 }, { at: r.ended, delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
      let active = 0, peak = 0; for (const e of events) { active += e.delta; peak = Math.max(peak, active); }
      assert.ok(peak <= slots, `kernel-contained execution exceeded ${slots}: ${peak}`);
      assert.equal(peak, slots, "configured slots were not exercised");
      for (let slot = 0; slot < slots; slot++) assert.equal(await runtimeUnitState(runtimeUnitName(f.schedulerDirectory, slot)), "inactive");
    } finally { await f.cleanup(); }
  }
});

test("independent processes rendezvous equivalent requests once and distinct identities do not merge", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const options = f.options("duplicate", "wait", 1000);
    const clients = Array.from({ length: 6 }, () => independent(options));
    const results = (await Promise.all(clients.map(c => c.result))).flat();
    assert.equal(new Set(results.map(r => r.pid)).size, 1);
    const distinct = await Promise.all([runBoundedWorker(f.options("different-a")), runBoundedWorker(f.options("different-b"))]);
    assert.notEqual(distinct[0]!.value.pid, distinct[1]!.value.pid);
  } finally { await f.cleanup(); }
});

test("each duplicate waiter cancels independently and the last waits for cgroup stop", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const options = f.options("cancel", "wait", 1500), controller = new AbortController();
    const cancelled = runBoundedWorker({ ...options, signal: controller.signal });
    const kept = runBoundedWorker(options);
    await marker((options.request as Request).marker); controller.abort();
    await assert.rejects(cancelled, /worker-aborted/);
    assert.equal((await kept).value.id, "cancel");
    const lastController = new AbortController(), lastOptions = f.options("last", "wait", 20_000);
    const last = runBoundedWorker({ ...lastOptions, signal: lastController.signal });
    await marker((lastOptions.request as Request).marker); lastController.abort();
    await assert.rejects(last, /worker-aborted/);
    assert.equal(await runtimeUnitState(runtimeUnitName(f.schedulerDirectory, 0)), "inactive");
  } finally { await f.cleanup(); }
});

test("success and deadline stop detached descendants before returning capacity", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const result = await runBoundedWorker(f.options("tree", "descendant"));
    assert.ok(result.value.descendant);
    assert.equal(await runtimeUnitState(runtimeUnitName(f.schedulerDirectory, 0)), "inactive");
    await assert.rejects(readFile(`/sys/fs/cgroup${result.value.group}/cgroup.procs`), { code: "ENOENT" });
    const options = f.options("deadline", "wait", 60_000);
    await assert.rejects(runBoundedWorker({ ...options, caps: { ...options.caps, deadlineMs: Date.now() + 1000 } }), /worker-timeout/);
    assert.equal(await runtimeUnitState(runtimeUnitName(f.schedulerDirectory, 0)), "inactive");
  } finally { await f.cleanup(); }
});

test("controller confirms memory pressure, unexplained SIGKILL remains a crash, reads are pre-admitted", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const pressure = f.options("pressure", "pressure");
    await assert.rejects(runBoundedWorker({ ...pressure, caps: { ...pressure.caps, memoryBytes: 128 * 1024 * 1024 } }), /worker-resource-limit/);
    await assert.rejects(runBoundedWorker(f.options("kill", "kill")), /worker-crashed/);
    await writeFile(join(f.directory, "read.marker.large"), Buffer.alloc(2 * 1024 * 1024));
    const read = await runBoundedWorker(f.options("read", "read")); assert.equal(read.value.code, "worker-source-limit");
    assert.equal((await runBoundedWorker(f.options("after-pressure"))).value.id, "after-pressure");
  } finally { await f.cleanup(); }
});

test("abrupt client death leaves kernel occupancy until the old tree stops; next client recovers", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const options = f.options("dead-owner", "wait", 20_000);
    const owner = independent({ ...options, caps: { ...options.caps, deadlineMs: Date.now() + 2000 } });
    void owner.result.catch(() => {});
    const old = await marker((options.request as Request).marker);
    owner.child.kill("SIGKILL");
    const next = await runBoundedWorker(f.options("restart", "wait", 100));
    assert.notEqual(next.value.pid, old.pid);
    assert.ok(next.value.started >= old.started);
    await assert.rejects(readFile(`/sys/fs/cgroup${old.group}/cgroup.procs`), { code: "ENOENT" });
    assert.equal((await readdir(f.schedulerDirectory)).filter(n => n.startsWith("slot-")).length, 0);
  } finally { await f.cleanup(); }
});

test("stdio entries share the bounded transport; malformed canonical identities and default mixed-version admission refuse", async () => {
  const f = await fixture();
  try {
    const entryPath = join(f.directory, "stdio.mjs");
    await writeFile(entryPath, `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,pid:process.pid,group:'stdio',started:1,ended:2})+'\\n');});`);
    const result = await runBoundedWorker({ ...f.options("stdio"), entryPath, entryTransport: "stdio" }); assert.equal(result.value.id, "stdio");
    await assert.rejects(runBoundedWorker({ ...f.options(), schedulerDirectory: undefined }), /worker-legacy-transition-required/);
    assert.throws(() => canonicalWorkerJson({ n: Infinity }), /worker-protocol-error/);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; assert.throws(() => canonicalWorkerJson(cycle), /worker-protocol-error/);
    const mismatch = f.options("mismatch"); await assert.rejects(runBoundedWorker({ ...mismatch, slots: 2 }), /scheduler-policy-mismatch/);
  } finally { await f.cleanup(); }
});


test("different arrival deadlines share execution; shorter waiter times out without cancelling the longer waiter", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const options = f.options("deadlines", "wait", 1800);
    const short = runBoundedWorker({ ...options, caps: { ...options.caps, deadlineMs: Date.now() + 1000 } });
    const started = await marker((options.request as Request).marker);
    const stages: string[] = [];
    const long = runBoundedWorker({ ...options, caps: { ...options.caps, deadlineMs: Date.now() + 5000 }, onProgress: stage => stages.push(stage) });
    await assert.rejects(short, /worker-timeout/);
    const result = await long;
    assert.equal(result.value.pid, started.pid);
    const independentOptions = f.options("separate-arrivals", "wait", 1500);
    const clients = Array.from({ length: 6 }, (_, index) => independent({ ...independentOptions, caps: { ...independentOptions.caps, deadlineMs: Date.now() + 10_000 + index * 117 } }));
    const values = (await Promise.all(clients.map(c => c.result))).flat();
    assert.equal(new Set(values.map(v => v.pid)).size, 1);
  } finally { await f.cleanup(); }
});

test("host status and progress are bounded across waiters, heap cap is applied in the real child", async () => {
  const f = await fixture();
  try {
    const stages: string[] = [], options = f.options("status", "wait", 1200);
    const job = runBoundedWorker({ ...options, onProgress: stage => stages.push(stage) });
    await marker((options.request as Request).marker);
    let status = await runtimeHostStatus({ schedulerDirectory: f.schedulerDirectory });
    for (let n = 0; n < 20 && status.jobs[0]?.stage !== "synthetic-running"; n++) { await pause(20); status = await runtimeHostStatus({ schedulerDirectory: f.schedulerDirectory }); }
    assert.equal(status.active, 1); assert.equal(status.jobs[0]?.stage, "synthetic-running");
    assert.equal(status.limits.hostMemoryBytes, 2 * 1024 ** 3);
    assert.doesNotMatch(JSON.stringify(status), /\/tmp|\/home|sessionPath|entryPath/);
    await job; assert.ok(stages.includes("synthetic-running"));
    const entryPath = join(f.directory, "heap.mjs");
    await writeFile(entryPath, `process.on('message',q=>process.send({id:q.id,pid:process.pid,group:'heap',started:1,ended:2,code:process.execArgv.join(',')}));`);
    const heap = f.options("heap");
    const result = await runBoundedWorker({ ...heap, entryPath, caps: { ...heap.caps, memoryBytes: 128 * 1024 * 1024, heapMiB: 80 } });
    assert.match(result.value.code!, /--max-old-space-size=80/);
  } finally { await f.cleanup(); }
});


test("async FileHandle.read and fs/promises.readFile enforce aggregate pre-read admission", async () => {
 const f=await fixture();
 try{
  for(const mode of ["handle","promises"]){
   const entryPath=join(f.directory,`read-${mode}.mjs`),options=f.options(`read-${mode}`);
   await writeFile((options.request as Request).marker+".large",Buffer.alloc(2*1024*1024));
   await writeFile(entryPath,`import{open,readFile}from'node:fs/promises';process.on('message',async q=>{let handle;try{if('${mode}'==='handle'){handle=await open(q.marker+'.large','r');await handle.read(Buffer.alloc(2*1024*1024),0,2*1024*1024,0);}else await readFile(q.marker+'.large');}catch(e){process.send({id:q.id,pid:process.pid,group:'read',started:1,ended:2,code:e.code});}finally{await handle?.close();}});`);
   const result=await runBoundedWorker({...options,entryPath});assert.equal(result.value.code,"worker-source-limit");
  }
 }finally{await f.cleanup();}
});
