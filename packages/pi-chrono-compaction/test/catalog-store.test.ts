import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { executeCatalogRequest } from "../src/catalog-engine.js";
import { createCatalogStoreExecutor, executeCatalogStoreRequest, type CatalogStoreFaultPoint } from "../src/catalog-store.js";
import { isCatalogStoreRequest } from "../src/catalog-store-contract.js";
import { type CatalogResponse, type CatalogView } from "../src/catalog-contract.js";
const line = (id: string, parentId: string | null): string => JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text: "synthetic" }] } }) + "\n";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "chrono-store-")), root = join(dir, "logical"), source = join(dir, "source.jsonl");
  writeFileSync(source, line("a", null), { mode: 0o600 });
  const base = { v: 1, catalogDirectory: root, sessionKey: "synthetic" };
  const ingest = { op: "ingestStep", shardKey: "s1", branchKey: "main", shardOrdinal: 0, sourcePath: source };
  const request = (r: Record<string, unknown>) => executeCatalogStoreRequest({ ...base, ...r });
  const ok = async (r: Record<string, unknown>): Promise<Record<string, any>> => result(await request(r));
  const pin = async (): Promise<CatalogView> => (await ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "a" } })).view;
  const active = (): any => JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
  const ref = (storeKey: string): any => JSON.parse(readFileSync(join(root, "refs", `${storeKey}.json`), "utf8"));
  const db = (storeKey: string): string => join(root, "stores", ref(storeKey).folder, `catalog-${createHash("sha256").update(base.sessionKey).digest("hex")}.sqlite`);
  const stage = async (rebuildKey: string) => {
    const s = await ok({ op: "recoverStart", rebuildKey });
    await ok({ ...ingest, targetStoreKey: s.targetStoreKey, generation: s.generation });
    return { op: "recoverPublish", targetStoreKey: s.targetStoreKey, generation: s.generation, expectedShards: 1, expectedActiveStoreKey: s.expectedActiveStoreKey };
  };
  return { dir, root, source, base, ingest, request, ok, pin, active, ref, db, stage };
}
async function fixture(fn: (f: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const f = setup(); try { await fn(f); } finally { rmSync(f.dir, { recursive: true, force: true }); }
}
function result(r: CatalogResponse): Record<string, any> { if (!r.ok) assert.fail(JSON.stringify(r)); return r.result; }
function refusal(r: CatalogResponse, code?: string): void { assert.equal(r.ok, false, JSON.stringify(r)); if (!r.ok) { assert.match(r.code, /^catalog-[a-z-]+$/); if (code) assert.equal(r.code, code); } }
const moduleUrl = new URL("../src/catalog-store.js", import.meta.url).href;
const engineUrl = new URL("../src/catalog-engine.js", import.meta.url).href;
async function child(request: unknown, killAt?: CatalogStoreFaultPoint): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  const script = `import {createCatalogStoreExecutor} from ${JSON.stringify(moduleUrl)}; import {executeCatalogRequest} from ${JSON.stringify(engineUrl)}; const run=createCatalogStoreExecutor(executeCatalogRequest,{fault(point){if(point===${JSON.stringify(killAt)})process.kill(process.pid,'SIGKILL')}}); console.log(JSON.stringify(await run(${JSON.stringify(request)})));`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", b => { stdout += b; }); p.stderr.on("data", b => { stderr += b; });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("synthetic-child-timeout")); }, 25000);
    p.once("error", e => { clearTimeout(timer); reject(e); });
    p.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test("pure store protocol validates recovery and immutable view routing", () => {
  const b = { v: 1, catalogDirectory: "/tmp/logical", sessionKey: "s" }, storeKey = randomUUID();
  assert.equal(isCatalogStoreRequest({ ...b, op: "recoverStart", rebuildKey: "recovery-1" }), true);
  assert.equal(isCatalogStoreRequest({ ...b, op: "recoverPublish", targetStoreKey: storeKey, generation: 2, expectedShards: 1, expectedActiveStoreKey: null }), true);
  for (const targetStoreKey of ["../escape", "x".repeat(5000), {}, null]) assert.equal(isCatalogStoreRequest({ ...b, op: "status", targetStoreKey }), false);
  const view = { sessionKey: "s", storeKey, generation: 1, eventCut: 1, branchKey: "main", segments: [{ segment: 1, cut: 1 }] };
  assert.equal(isCatalogStoreRequest({ ...b, op: "page", view }), true);
  assert.equal(isCatalogStoreRequest({ ...b, op: "page", view, targetStoreKey: randomUUID() }), false);
  assert.equal(isCatalogStoreRequest({ ...b, op: "page", view: { ...view, sessionKey: "other" } }), false);
});

test("initial concurrent processes converge on one restartable store", () => fixture(async f => {
  const responses = await Promise.all(Array.from({ length: 4 }, () => child({ ...f.base, ...f.ingest })));
  for (const r of responses) { assert.equal(r.code, 0, r.stderr); const response = JSON.parse(r.stdout); if (!response.ok) assert.match(response.code, /^catalog-/); }
  await f.ok(f.ingest);
  assert.ok(responses.some(r => JSON.parse(r.stdout).ok));
  const active = f.active();
  assert.equal((await f.ok({ op: "status" })).storeKey, active.storeKey);
  assert.equal(readdirSync(join(f.root, "stores")).length, 1);
  assert.equal(readdirSync(join(f.root, "refs")).length, 1);
  assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 1);
  for (const name of ["active.json", "publication.lock", `refs/${active.storeKey}.json`]) assert.equal(lstatSync(join(f.root, name)).mode & 0o777, 0o600);
  for (const name of ["", "refs", "stores", "stages", `stores/${f.ref(active.storeKey).folder}`]) assert.equal(lstatSync(join(f.root, name)).mode & 0o777, 0o700);
}));

test("new physical store publication preserves old pinned page/blocks/raw and source bytes", () => fixture(async f => {
  await f.ok(f.ingest); const old = await f.pin(), before = readFileSync(f.source);
  const publish = await f.stage("healthy-replacement"); await f.ok(publish);
  assert.notEqual(f.active().storeKey, old.storeKey);
  appendFileSync(f.source, line("b", "a")); await f.ok(f.ingest);
  assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 2);
  const page = await f.ok({ op: "page", view: old });
  assert.deepEqual(page.events.map((e: any) => e.metadata.id), ["a"]);
  assert.ok((await f.ok({ op: "blocks", view: old, eventSeq: 1 })).blocks.length > 0);
  const raw = await f.ok({ op: "raw", view: old, eventSeq: 1, offset: 0, length: before.length });
  assert.deepEqual(Buffer.from(raw.data, "base64"), before);
  assert.deepEqual(readFileSync(f.source), Buffer.concat([before, Buffer.from(line("b", "a"))]));
  refusal(await f.request({ op: "page", view: old, targetStoreKey: f.active().storeKey }), "catalog-request-invalid");
  refusal(await f.request({ op: "page", view: old, sessionKey: "other" }), "catalog-request-invalid");
  const oldPin = await f.ok({ op: "pin", targetStoreKey: old.storeKey, branchKey: "main", leaf: { shardKey: "s1", eventId: "a" } });
  assert.equal(oldPin.view.storeKey, old.storeKey);
  const oldRefPath = join(f.root, "refs", `${old.storeKey}.json`), oldRef = readFileSync(oldRefPath);
  rmSync(oldRefPath);
  refusal(await f.request({ op: "page", view: old }), "catalog-store-missing");
  writeFileSync(oldRefPath, oldRef, { mode: 0o600 });
}));

test("explicit recovery can publish into a new logical root with a null expected owner", () => fixture(async f => {
  const p = await f.stage("fresh-recovery"); assert.equal(p.expectedActiveStoreKey, null);
  await f.ok(p); assert.equal(f.active().storeKey, p.targetStoreKey);
  assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 1);
  refusal(await f.request({ op: "status", sessionKey: "other" }), "catalog-session-mismatch");
  refusal(await f.request({ op: "status", sessionKey: "other", targetStoreKey: p.targetStoreKey }), "catalog-store-mismatch");
}));

test("null-owner recovery CAS refuses when ordinary initialization wins first", () => fixture(async f => {
  const p = await f.stage("null-cas"); assert.equal(p.expectedActiveStoreKey, null);
  await f.ok(f.ingest); const owner = f.active().storeKey;
  refusal(await f.request(p), "catalog-publication-conflict");
  assert.equal(f.active().storeKey, owner);
}));

test("corrupt active SQLite requires explicit new-store recovery; never opens corrupt store during rebuild", () => fixture(async f => {
  await f.ok(f.ingest); const old = f.active().storeKey, db = f.db(old), sourceBefore = readFileSync(f.source);
  const fd = openSync(db, "r+"); try { writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 0); } finally { closeSync(fd); }
  const corruptBefore = readFileSync(db);
  refusal(await f.request({ op: "status" }));
  const publish = await f.stage("corruption-recovery"); await f.ok(publish);
  assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 1);
  assert.deepEqual(readFileSync(db), corruptBefore);
  assert.deepEqual(readFileSync(f.source), sourceBefore);
  assert.ok(lstatSync(join(f.root, "refs", `${old}.json`)).isFile());
}));

test("unfinished staging and stale CAS cannot publish or overwrite a newer owner", () => fixture(async f => {
  await f.ok(f.ingest); const initial = f.active().storeKey;
  const s = await f.ok({ op: "recoverStart", rebuildKey: "unfinished" });
  refusal(await f.request({ op: "recoverPublish", ...s, expectedShards: 1 }), "catalog-rebuild-incomplete");
  assert.equal(f.active().storeKey, initial);
  const a = await f.stage("a"), b = await f.stage("b");
  await f.ok(a); refusal(await f.request(b), "catalog-publication-conflict");
  await f.ok(a); // idempotent publication retry
  const newer = await f.stage("newer"); await f.ok(newer);
  const bytes = readFileSync(join(f.root, "active.json"));
  refusal(await f.request(a), "catalog-publication-conflict");
  refusal(await f.request({ ...a, expectedActiveStoreKey: newer.targetStoreKey }), "catalog-recovery-mismatch");
  refusal(await f.request({ ...a, generation: Number(a.generation) + 1 }), "catalog-recovery-mismatch");
  assert.deepEqual(readFileSync(join(f.root, "active.json")), bytes);
  const retry = await f.ok({ op: "recoverStart", rebuildKey: "a" });
  assert.equal(retry.targetStoreKey, a.targetStoreKey); assert.equal(retry.expectedActiveStoreKey, initial);
}));

test("malformed, oversized, hardlinked, symlink and non-private pointers refuse without source I/O", () => fixture(async f => {
  await f.ok(f.ingest); const path = join(f.root, "active.json"), original = readFileSync(path), pinned = await f.pin();
  for (const bytes of [Buffer.from("{"), Buffer.from("{}"), Buffer.alloc(8 * 1024 * 1024, 32)]) {
    writeFileSync(path, bytes); const r = await f.request(f.ingest); refusal(r); assert.equal(r.sourceBytes, 0);
    assert.equal((await f.ok({ op: "page", view: pinned })).events.length, 1); // No active-pointer dependency.
  }
  writeFileSync(path, original); chmodSync(path, 0o644); refusal(await f.request({ op: "status" }), "catalog-pointer-unsafe"); chmodSync(path, 0o600);
  linkSync(path, `${path}.alias`); refusal(await f.request({ op: "status" }), "catalog-pointer-unsafe"); rmSync(`${path}.alias`);
  rmSync(path); symlinkSync(f.source, path); refusal(await f.request({ op: "status" }), "catalog-pointer-unsafe"); rmSync(path); writeFileSync(path, original, { mode: 0o600 });
  chmodSync(join(f.root, "refs"), 0o755); refusal(await f.request({ op: "status" }), "catalog-storage-unsafe"); chmodSync(join(f.root, "refs"), 0o700);
  const alias = join(f.dir, "alias"); symlinkSync(f.root, alias); refusal(await f.request({ op: "status", catalogDirectory: alias }), "catalog-storage-unsafe");
  assert.equal(readFileSync(f.source, "utf8"), line("a", null));
}));

test("routing is bounded and does not scan accumulated stores or refs", () => fixture(async f => {
  await f.ok(f.ingest);
  // Invalid unrelated records must never be parsed or enumerated by routing.
  for (let i = 0; i < 128; i++) writeFileSync(join(f.root, "refs", `unrelated-${i}.json`), "{", { mode: 0o600 });
  for (let i = 0; i < 8; i++) assert.equal((await f.ok({ op: "status" })).storeKey, f.active().storeKey);
  const implementation = readFileSync(new URL("../../src/catalog-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(implementation, /readdir|opendir|readFile/);
  assert.match(implementation, /Buffer\.alloc\(4097\)/);
}));

for (const phase of ["after-store-commit", "after-ref-commit", "before-active-publish", "after-active-publish"] as const) {
  test(`SIGKILL initial ${phase} resumes the same store`, () => fixture(async f => {
    const dead = await child({ ...f.base, ...f.ingest }, phase); assert.equal(dead.signal, "SIGKILL", dead.stderr);
    const folder = `initial-${createHash("sha256").update(f.base.sessionKey).digest("hex")}`;
    const committedKey = result(executeCatalogRequest({ ...f.base, op: "status", catalogDirectory: join(f.root, "stores", folder) })).storeKey;
    await f.ok(f.ingest); assert.equal(f.active().storeKey, committedKey);
    assert.equal(readdirSync(join(f.root, "stores")).length, 1);
    assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 1);
  }));
  test(`SIGKILL recovery publication ${phase} resumes or preserves the current owner`, () => fixture(async f => {
    await f.ok(f.ingest);
    if (phase === "after-ref-commit") {
      const dead = await child({ ...f.base, op: "recoverStart", rebuildKey: phase }, phase); assert.equal(dead.signal, "SIGKILL", dead.stderr);
      const p = await f.stage(phase); await f.ok(p);
    } else {
      const p = await f.stage(phase), dead = await child({ ...f.base, ...p }, phase); assert.equal(dead.signal, "SIGKILL", dead.stderr);
      await f.ok(p); assert.equal(f.active().storeKey, p.targetStoreKey);
    }
    assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 1);
  }));
}

for (const phase of ["before-metadata-rename", "after-metadata-rename"] as const) {
  test(`SIGKILL recovery active pointer ${phase} never exposes a partial record`, () => fixture(async f => {
    await f.ok(f.ingest); const old = f.active().storeKey, p = await f.stage(phase);
    const dead = await child({ ...f.base, ...p }, phase); assert.equal(dead.signal, "SIGKILL", dead.stderr);
    assert.ok([old, p.targetStoreKey].includes(f.active().storeKey));
    const orphans = readdirSync(f.root).filter(n => n.startsWith(".pending-"));
    if (phase === "before-metadata-rename") assert.equal(orphans.length, 1);
    await f.ok(p); assert.equal(f.active().storeKey, p.targetStoreKey);
    for (const name of orphans) assert.ok(lstatSync(join(f.root, name)).isFile());
  }));
}
test("SIGKILL recovery DB commit before ref creation reuses the deterministic staging store", () => fixture(async f => {
  await f.ok(f.ingest);
  const dead = await child({ ...f.base, op: "recoverStart", rebuildKey: "commit-retry" }, "after-store-commit");
  assert.equal(dead.signal, "SIGKILL", dead.stderr);
  const folder = `recovery-${createHash("sha256").update(`${f.base.sessionKey}\0commit-retry`).digest("hex")}`;
  const committedKey = result(executeCatalogRequest({ ...f.base, op: "status", catalogDirectory: join(f.root, "stores", folder) })).storeKey;
  const p = await f.stage("commit-retry"); assert.equal(p.targetStoreKey, committedKey); await f.ok(p);
  assert.equal(readdirSync(join(f.root, "stores")).length, 2);
  assert.equal((await f.ok({ op: "status", shardKey: "s1" })).records, 1);
}));

for (const code of ["EIO", "ENOSPC"]) for (const phase of ["before-metadata-write", "before-metadata-sync", "before-metadata-rename", "after-metadata-rename"] as const) {
  test(`${code} at ${phase} leaves old or complete new publication and retry succeeds`, () => fixture(async f => {
    await f.ok(f.ingest); const old = f.active().storeKey, p = await f.stage(`${code}-${phase}`), source = readFileSync(f.source);
    let fired = false;
    const execute = createCatalogStoreExecutor(executeCatalogRequest, { fault(point) { if (point === phase && !fired) { fired = true; throw Object.assign(Error(code), { code }); } } });
    refusal(await execute({ ...f.base, ...p }), code === "ENOSPC" ? "catalog-storage-full" : "catalog-storage-io");
    assert.ok([old, p.targetStoreKey].includes(f.active().storeKey));
    await f.ok(p); assert.equal(f.active().storeKey, p.targetStoreKey);
    assert.deepEqual(readFileSync(f.source), source);
    assert.ok(lstatSync(f.db(old)).isFile());
  }));
}
