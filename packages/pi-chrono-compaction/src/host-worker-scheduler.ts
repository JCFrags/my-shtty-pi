import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_WORKER_PROTOCOL_VERSION, type WorkerJobType } from "./compaction-worker-protocol.js";

export type WorkerPriority = "high" | "low";
interface Owner { readonly schemaVersion: 1; readonly pid: number; readonly processStartIdentity: string; readonly nonce: string; readonly createdAtMs: number; readonly priority: WorkerPriority; readonly jobType: WorkerJobType; }
export interface SchedulerLease { readonly slot: number; readonly slots: number; readonly queueWaitMs: number; readonly queuePosition: number; release(): Promise<void>; }
export interface SchedulerOptions { readonly slots?: number; readonly timeoutMs?: number; readonly pollMs?: number; readonly priority: WorkerPriority; readonly jobType: WorkerJobType; readonly signal?: AbortSignal; readonly directory?: string; }
const START_RE=/^\d+ \([^)]*\) [A-Z] (?:\S+ ){18}(\S+)/;
export function linuxProcessStartIdentity(pid=process.pid): string | undefined { try { const text=readFileSync(`/proc/${pid}/stat`,"utf8"); return text.match(START_RE)?.[1]; } catch { return undefined; } }
function ownerAlive(owner: Owner): boolean | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const text = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
    const current = text.match(START_RE)?.[1];
    return current === undefined ? undefined : current === owner.processStartIdentity;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
}
export function defaultSchedulerDirectory(): string { const uid=typeof process.getuid==="function"?String(process.getuid()):"unknown";const identity=createHash("sha256").update(uid).digest("hex").slice(0,16);return join(tmpdir(),`chrono-compact-worker-v${COMPACTION_WORKER_PROTOCOL_VERSION}-${identity}`); }
async function ensureDirectory(path:string):Promise<void>{await mkdir(path,{recursive:true,mode:0o700});await chmod(path,0o700);}
async function readOwner(path:string):Promise<Owner|undefined>{try{const value=JSON.parse(await readFile(path,"utf8")) as Owner;return value&&value.schemaVersion===1&&typeof value.pid==="number"&&typeof value.nonce==="string"?value:undefined;}catch{return undefined;}}
async function removeDead(path:string):Promise<boolean>{const owner=await readOwner(path);if(!owner)return false;const alive=ownerAlive(owner);if(alive===false){const again=await readOwner(path);if(again?.nonce===owner.nonce){await rm(path,{force:true});return true;}}return false;}
async function cleanup(directory:string):Promise<void>{for(const name of await readdir(directory)){if(!name.startsWith("ticket-")&&!name.startsWith("slot-"))continue;await removeDead(join(directory,name));}}
function wait(ms:number,signal?:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(new Error("worker-aborted"));const timer=setTimeout(resolve,ms);signal?.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("worker-aborted"));},{once:true});});}
function priorityValue(value:WorkerPriority):number{return value==="high"?0:1;}
export async function acquireHostWorkerSlot(options:SchedulerOptions):Promise<SchedulerLease>{
 const slots=Math.floor(options.slots??1);if(slots<1||slots>4)throw new Error("host worker slots must be from 1 through 4");const timeoutMs=Math.max(1,Math.floor(options.timeoutMs??900_000));const pollMs=Math.min(1000,Math.max(20,Math.floor(options.pollMs??75)));const directory=options.directory??defaultSchedulerDirectory();await ensureDirectory(directory);await cleanup(directory);
 const startIdentity=linuxProcessStartIdentity()??"unverified";const nonce=randomBytes(16).toString("hex");const owner:Owner={schemaVersion:1,pid:process.pid,processStartIdentity:startIdentity,nonce,createdAtMs:Date.now(),priority:options.priority,jobType:options.jobType};const ticketName=`ticket-${nonce}.json`;const ticketPath=join(directory,ticketName);await writeFile(ticketPath,JSON.stringify(owner),{mode:0o600,flag:"wx"});const started=Date.now();let maximumPosition=1;
 try{for(;;){if(options.signal?.aborted)throw new Error("worker-aborted");if(Date.now()-started>=timeoutMs)throw new Error("scheduler-timeout");await cleanup(directory);const names=(await readdir(directory)).filter(x=>x.startsWith("ticket-"));const tickets:(Owner&{name:string})[]=[];for(const name of names){const value=await readOwner(join(directory,name));if(value)tickets.push({...value,name});}tickets.sort((a,b)=>priorityValue(a.priority)-priorityValue(b.priority)||a.createdAtMs-b.createdAtMs||a.nonce.localeCompare(b.nonce));const position=Math.max(1,tickets.findIndex(x=>x.nonce===nonce)+1);maximumPosition=Math.max(maximumPosition,position);
   let available=-1;for(let slot=0;slot<slots;slot++){const path=join(directory,`slot-${slot}.json`);await removeDead(path);try{const handle=await open(path,"wx",0o600);await handle.writeFile(JSON.stringify(owner));await handle.sync();await handle.close();available=slot;break;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}}
   if(available>=0){const earlier=tickets.slice(0,position-1).length;if(earlier>=slots){const path=join(directory,`slot-${available}.json`);const current=await readOwner(path);if(current?.nonce===nonce)await rm(path,{force:true});}else{await rm(ticketPath,{force:true});let released=false;return{slot:available,slots,queueWaitMs:Date.now()-started,queuePosition:maximumPosition,release:async()=>{if(released)return;released=true;const path=join(directory,`slot-${available}.json`);const current=await readOwner(path);if(current?.nonce===nonce)await rm(path,{force:true});await rm(ticketPath,{force:true});}};}}
   await wait(pollMs,options.signal);
 }}finally{await rm(ticketPath,{force:true});}
}
export async function schedulerArtifactCounts(directory=defaultSchedulerDirectory()):Promise<{tickets:number;slots:number}>{try{const names=await readdir(directory);return{tickets:names.filter(x=>x.startsWith("ticket-")).length,slots:names.filter(x=>x.startsWith("slot-")).length};}catch{return{tickets:0,slots:0};}}
