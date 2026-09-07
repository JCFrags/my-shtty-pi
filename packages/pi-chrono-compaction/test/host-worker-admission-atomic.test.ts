import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acquireHostWorkerSlot, schedulerArtifactCounts } from "../src/host-worker-scheduler.js";

const original = { open: fs.open, link: fs.link, rename: fs.rename, rm: fs.rm };
const options = (directory:string) => ({ directory, slots:1, priority:"high" as const, jobType:"replay-compaction" as const, enforcePolicy:true, timeoutMs:3_000, pollMs:20 });
const error = (code:string) => Object.assign(new Error(`injected ${code}`), { code });
function restore(){Object.assign(fs, original);syncBuiltinESMExports();}
async function clean(directory:string){
 assert.deepEqual(await schedulerArtifactCounts(directory), {tickets:0,slots:0});
 assert.deepEqual((await fs.readdir(directory)).filter(name=>!['queue.lock','turns.json','policy.json'].includes(name)), []);
}
async function reacquire(directory:string){
 // The failed owner is this still-live process. Neither retry may rely on PID death.
 const source=`import { acquireHostWorkerSlot, schedulerArtifactCounts } from ${JSON.stringify(new URL("../src/host-worker-scheduler.js",import.meta.url).href)};
 const lease=await acquireHostWorkerSlot(${JSON.stringify(options(directory))});await lease.release();
 const counts=await schedulerArtifactCounts(${JSON.stringify(directory)});
 if(counts.tickets||counts.slots)throw new Error('child residue');`;
 await promisify(execFile)(process.execPath,["--input-type=module","-e",source],{timeout:10_000});
 await clean(directory);
 const lease=await acquireHostWorkerSlot(options(directory));await lease.release();await clean(directory);
}
type Target = "policy"|"ticket"|"turns"|"slot";
function matches(path:unknown,target:Target){return basename(String(path)).startsWith(`.${target}${target==='policy'?'.json-':'-'}`);}
type Fault = "open"|"writeFile"|"sync"|"stat"|"close"|"link"|"rename"|"unlink";
function inject(target:Target,operation:Fault,code="EIO"){
 let fired=0;
 const fail=(path:unknown)=>{if(!fired&&matches(path,target)){fired++;throw error(code);}};
 if(operation==='open')fs.open=(async(...args:Parameters<typeof fs.open>)=>{fail(args[0]);return original.open(...args);}) as typeof fs.open;
 else if(operation==='link')fs.link=async(...args)=>{fail(args[0]);return original.link(...args);};
 else if(operation==='rename')fs.rename=async(...args)=>{fail(args[0]);return original.rename(...args);};
 else if(operation==='unlink')fs.rm=async(...args)=>{fail(args[0]);return original.rm(...args);};
 else fs.open=(async(...args:Parameters<typeof fs.open>)=>{
  const handle=await original.open(...args);
  if(matches(args[0],target)){
   // FileHandle methods are patched on this synthetic file only, never globally.
   const method=handle[operation].bind(handle) as (...args:unknown[])=>Promise<unknown>;
   Object.defineProperty(handle,operation,{value:async(...values:unknown[])=>{
    if(operation==='writeFile'&&!fired)await method(String(values[0]).slice(0,10));
    fail(args[0]);return method(...values);
   }});
  }
  return handle;
 }) as typeof fs.open;
 syncBuiltinESMExports();return ()=>fired;
}

test("turns.json EISDIR does not publish a slot or leak its ticket/temp",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
 try{
  await fs.mkdir(join(directory,"turns.json"),{mode:0o700});
  await assert.rejects(acquireHostWorkerSlot(options(directory)),{code:"EISDIR"});
  await clean(directory);
  await fs.rmdir(join(directory,"turns.json"));
  await reacquire(directory);
 }finally{await original.rm(directory,{recursive:true,force:true});}
});

for(const target of ["policy","ticket","turns","slot"] as const){
 for(const operation of ["open","writeFile","sync",...(target==='turns'?["rename"] as const:["link"] as const)] as const){
  test(`${target} ${operation} failure is atomic and both clients recover`,async()=>{
   const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
   const code=operation==='open'?"ENOSPC":"EIO";
   const fired=inject(target,operation,code);
   try{
    await assert.rejects(acquireHostWorkerSlot(options(directory)),{code});
    assert.equal(fired(),1);restore();await clean(directory);
    await reacquire(directory);
   }finally{restore();await original.rm(directory,{recursive:true,force:true});}
  });
 }
 for(const operation of ["stat","close","unlink"] as const){
  // Successful rename consumes the turns temp, so exercise its cleanup on failure below.
  if(target==='turns'&&operation==='unlink')continue;
  test(`${target} ${operation} cleanup fault keeps ownership until automatic retry`,async()=>{
   const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
   const fired=inject(target,operation);
   try{
    const lease=await acquireHostWorkerSlot(options(directory));assert.equal(fired(),1);
    restore();await lease.release();await clean(directory);await reacquire(directory);
   }finally{restore();await original.rm(directory,{recursive:true,force:true});}
  });
 }
}

test("rename failure plus turns temporary unlink failure cleans both reservations",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
 let unlinks=0;
 fs.rename=async(...args)=>{if(matches(args[0],"turns"))throw error("EIO");return original.rename(...args);};
 fs.rm=async(...args)=>{if(matches(args[0],"turns")&&unlinks++===0)throw error("EBUSY");return original.rm(...args);};
 syncBuiltinESMExports();
 try{await assert.rejects(acquireHostWorkerSlot(options(directory)),{code:"EIO"});assert.equal(unlinks,2);restore();await clean(directory);await reacquire(directory);}
 finally{restore();await original.rm(directory,{recursive:true,force:true});}
});

test("ticket unlink outage holds pending admission; another client cannot steal it",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
 let unblock=false,observed!:()=>void;
 const blocked=new Promise<void>(resolve=>{observed=resolve;});
 fs.rm=async(...args)=>{
  if(basename(String(args[0])).startsWith('ticket-')&&!unblock){observed();throw error("EBUSY");}
  return original.rm(...args);
 };
 syncBuiltinESMExports();
 let pending:ReturnType<typeof acquireHostWorkerSlot>|undefined;
 let contender:ReturnType<typeof acquireHostWorkerSlot>|undefined;
 try{
  pending=acquireHostWorkerSlot(options(directory));await blocked;
  let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});
  contender=acquireHostWorkerSlot(options(directory));let stolen=false;
  contender.then(()=>{stolen=true;},()=>{});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(settled,false);assert.equal(stolen,false);
  assert.deepEqual(await schedulerArtifactCounts(directory),{tickets:1,slots:0});
  unblock=true;const lease=await pending;await lease.release();
  const next=await contender;await next.release();restore();await clean(directory);await reacquire(directory);
 }finally{
  unblock=true;restore();
  for(const promise of [pending,contender])if(promise)await promise.then(lease=>lease.release(),()=>{});
  await original.rm(directory,{recursive:true,force:true});
 }
});

test("failed publication cleanup retries ticket unlink, not a replacement inode",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
 let ticket:string|undefined,contents="",fired=false;
 fs.open=(async(...args:Parameters<typeof fs.open>)=>{
  if(matches(args[0],"turns"))throw error("ENOSPC");
  return original.open(...args);
 }) as typeof fs.open;
 fs.rm=async(...args)=>{
  const path=String(args[0]);
  if(basename(path).startsWith('ticket-')&&!fired){
   fired=true;ticket=path;contents=await fs.readFile(path,"utf8");
   // Keep the exact nonce but replace the inode between cleanup retries.
   const replacement=join(directory,"replacement");await fs.writeFile(replacement,contents,{mode:0o600});
   await original.rename(replacement,path);throw error("EBUSY");
  }
  return original.rm(...args);
 };
 syncBuiltinESMExports();
 try{
  await assert.rejects(acquireHostWorkerSlot(options(directory)),{code:"ENOSPC"});assert.equal(fired,true);
  assert.equal(await fs.readFile(ticket!,"utf8"),contents);
  restore();await original.rm(ticket!);await clean(directory);await reacquire(directory);
 }finally{restore();await original.rm(directory,{recursive:true,force:true});}
});

test("lease release preserves a replacement inode even with the same nonce",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
 try{
  const lease=await acquireHostWorkerSlot(options(directory));const path=join(directory,"slot-0.json");
  const contents=await fs.readFile(path,"utf8"),replacement=join(directory,"replacement");
  await fs.writeFile(replacement,contents,{mode:0o600});await fs.rename(replacement,path);
  await lease.release();assert.equal(await fs.readFile(path,"utf8"),contents);
  await fs.rm(path);await clean(directory);
 }finally{await original.rm(directory,{recursive:true,force:true});}
});

test("failed partial writes retry temporary cleanup before reporting failure",async()=>{
 for(const target of ['policy','ticket','turns','slot'] as const){
  const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
  const fired=inject(target,'writeFile');let cleanupFaults=0;
  fs.rm=async(...args)=>{if(matches(args[0],target)&&cleanupFaults++===0)throw error('EBUSY');return original.rm(...args);};
  syncBuiltinESMExports();
  try{
   await assert.rejects(acquireHostWorkerSlot(options(directory)),{code:'EIO'});
   assert.equal(fired(),1);assert.equal(cleanupFaults,2);
   restore();await clean(directory);await reacquire(directory);
  }finally{restore();await original.rm(directory,{recursive:true,force:true});}
 }
});

test("abandoned temp aliases recover without releasing a live slot",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"chrono-admission-atomic-"));
 let held:Awaited<ReturnType<typeof acquireHostWorkerSlot>>|undefined;
 try{
  held=await acquireHostWorkerSlot(options(directory));const slot=join(directory,'slot-0.json');
  const contents=await fs.readFile(slot,'utf8');const {nonce}=JSON.parse(contents) as {nonce:string};
  await fs.link(slot,join(directory,`.slot-0.json-${nonce}.tmp`));
  await fs.writeFile(join(directory,`.turns-${nonce}.tmp`),'partial',{mode:0o600});
  await fs.writeFile(join(directory,`.policy.json-${nonce}.tmp`),'partial',{mode:0o600});
  await assert.rejects(acquireHostWorkerSlot({...options(directory),timeoutMs:100}),/scheduler-timeout/);
  assert.equal(await fs.readFile(slot,'utf8'),contents);
  assert.deepEqual((await fs.readdir(directory)).filter(name=>name.endsWith('.tmp')),[]);
  await held.release();await clean(directory);await reacquire(directory);
 }finally{await held?.release();await original.rm(directory,{recursive:true,force:true});}
});
