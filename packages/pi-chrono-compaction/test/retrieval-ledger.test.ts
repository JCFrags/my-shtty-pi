import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSessionJsonl } from "../src/jsonl.js";
import { historyGet, historyGetFromLedger, historyRange, historyRangeFromLedger } from "../src/retrieval.js";
import { updateSourceLedger } from "../src/source-ledger.js";

const header={type:"session",version:3,id:"retrieval-ledger-test"};
const message=(id:string,parentId:string|null,content:unknown)=>({type:"message",id,parentId,message:{role:"assistant",content,stopReason:"stop"}});
async function fixture(t:test.TestContext,ending="\n"){const directory=await mkdtemp(join(tmpdir(),"chrono-retrieval-ledger-"));t.after(()=>rm(directory,{recursive:true,force:true}));const sessionPath=join(directory,"session.jsonl");const entries=[message("a",null,"short 雪"),message("b","a",[{type:"text",text:"block-zero"},{type:"text",text:"x".repeat(15_000)}]),message("side","a","side branch"),message("c","b","last")];await writeFile(sessionPath,[header,...entries].map(value=>JSON.stringify(value)).join(ending)+ending,{mode:0o600});return{sessionPath,ledger:await updateSourceLedger(sessionPath),parsed:await readSessionJsonl(sessionPath)};}

test("ledger history_get is byte-identical for records, pages, blocks, and neighbors",async t=>{const f=await fixture(t,"\r\n");for(const [id,options] of [["a",{}],["a",{contextBefore:0,contextAfter:3}],["b",{startChar:100,maxChars:321}],["b",{blockIndex:0}],["b",{blockIndex:1,startChar:12,maxChars:500}],["c",{contextBefore:3,contextAfter:0}]] as const)assert.equal(await historyGetFromLedger(f.sessionPath,f.ledger,id,options),historyGet(f.parsed,id,options));await assert.rejects(()=>historyGetFromLedger(f.sessionPath,f.ledger,"missing"),/Unknown history entry/);await assert.rejects(()=>historyGetFromLedger(f.sessionPath,f.ledger,"a",{blockIndex:99}),/has no block/);});

test("ledger history_range is byte-identical for parent paths, file order, limits, and oversized records",async t=>{const f=await fixture(t);for(const [start,end,options] of [["a","c",{}],["side","c",{}],["b","b",{}],["a","c",{maxEntries:2}]] as const)assert.equal(await historyRangeFromLedger(f.sessionPath,f.ledger,start,end,options),historyRange(f.parsed,start,end,options));await assert.rejects(()=>historyRangeFromLedger(f.sessionPath,f.ledger,"missing","c"),/Unknown start entry/);await assert.rejects(()=>historyRangeFromLedger(f.sessionPath,f.ledger,"c","a"),/occurs before/);});

test("ledger retrieval rejects changed selected bytes",async t=>{const f=await fixture(t);const bytes=await readFile(f.sessionPath);const selected=f.ledger.entryById.get("a")!;bytes[selected.sourceByteOffset+10]=bytes[selected.sourceByteOffset+10]!^1;await writeFile(f.sessionPath,bytes);await assert.rejects(()=>historyGetFromLedger(f.sessionPath,f.ledger,"a"),/source/);await assert.rejects(()=>historyRangeFromLedger(f.sessionPath,f.ledger,"a","a"),/source/);});
