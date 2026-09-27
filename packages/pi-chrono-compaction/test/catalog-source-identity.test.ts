import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CatalogSource, type CatalogSourceSnapshot } from "../src/catalog-source.js";
import { sameCatalogFileIdentity } from "../src/catalog-file-identity.js";
import { CatalogSqlite } from "../src/catalog-sqlite.js";
import { executeCatalogStoreRequest } from "../src/catalog-store.js";
import { isCatalogStoreRequest } from "../src/catalog-store-contract.js";
import type { CatalogResponse, CatalogView } from "../src/catalog-contract.js";

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const line = (id: string, parentId: string | null, text = "synthetic"): string => JSON.stringify({ type: "message", id, parentId,
  message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
function result(response: CatalogResponse): Record<string, any> {
  assert.ok(response.sourceBytes <= 8 * 1024 * 1024);
  if (!response.ok) assert.fail(JSON.stringify(response));
  return response.result;
}
function refused(response: CatalogResponse, code: string): void {
  assert.equal(response.ok, false, JSON.stringify(response));
  if (!response.ok) assert.equal(response.code, code);
}
async function fixture(t: TestContext, fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  // Use the checkout filesystem, not /tmp (often tmpfs). The production Btrfs
  // probe is exercised without an IPC flag or a mocked durable identity.
  const dir = mkdtempSync(join(process.cwd(), ".chrono-source-identity-"));
  try {
    const source = join(dir, "source.jsonl");
    writeFileSync(source, line("a", null, "x".repeat(7 * 1024 * 1024)), { mode: 0o600 });
    const opened = new CatalogSource(source);
    const supported = opened.fileIdentity.kind === "linux-btrfs-statfs"; opened.close();
    if (!supported) { t.skip("legacy promotion requires a Linux Btrfs fixture filesystem"); return; }
    await fn(await setup(dir, source));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function setup(dir: string, source: string) {
  const root = join(dir, "logical"), base = { v: 1, sessionKey: "synthetic", catalogDirectory: root };
  const ingest = { op: "ingestStep", sourcePath: source, shardKey: "s1", shardOrdinal: 0, branchKey: "main" };
  const request = (operation: Record<string, unknown>) => executeCatalogStoreRequest({ ...base, ...operation });
  const ok = async (operation: Record<string, unknown>) => result(await request(operation));
  for (let i = 0; i < 64; i++) { if ((await ok(ingest)).caughtUp) break; }
  assert.equal((await ok({ op: "status", shardKey: "s1" })).caughtUp, true);
  const view = (await ok({ op: "pin", branchKey: "main", leaf: { shardKey: "s1", eventId: "a" } })).view as CatalogView;
  const refPath = join(root, "refs", `${view.storeKey}.json`), activePath = join(root, "active.json");
  const folder = JSON.parse(readFileSync(refPath, "utf8")).folder;
  const dbPath = join(root, "stores", folder, `catalog-${hash(base.sessionKey)}.sqlite`);
  const sql = <T>(fn: (db: CatalogSqlite) => T): T => { const db = CatalogSqlite.open(dbPath); try { return fn(db); } finally { db.close(); } };
  const shard = () => sql(db => db.prepare("SELECT * FROM shards WHERE g=1 AND shard='s1'").get()!);
  const original = JSON.parse(String(shard().snapshot)) as CatalogSourceSnapshot;
  const legacy = JSON.stringify({ schemaVersion: 1, identity: { ...original.identity, device: String(BigInt(original.identity.device) + 1n) }, size: original.size, anchors: original.anchors });
  sql(db => db.prepare("UPDATE shards SET snapshot=? WHERE g=1 AND shard='s1'").run(legacy));
  const frozen = shard();
  const recovery = { op: "sourceIdentity", targetStoreKey: view.storeKey, generation: 1, shardKey: "s1", recoveryKey: "reboot-proof",
    expectedSnapshotHash: hash(legacy), expectedCheckpointHash: String(frozen.checkpointHash) };
  const cold = (operation: Record<string, unknown>): CatalogResponse => {
    const script = `import {executeCatalogStoreRequest} from ${JSON.stringify(new URL("../src/catalog-store.js", import.meta.url).href)}; console.log(JSON.stringify(await executeCatalogStoreRequest(${JSON.stringify({ ...base, ...operation })})));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout) as CatalogResponse;
  };
  const unchangedData = () => sql(db => Object.fromEntries(["meta", "generations", "events", "segments", "blocks", "tool_calls", "spans"].map(table =>
    [table, [...db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate(1024)]])));
  return { dir, root, source, base, ingest, request, ok, view, refPath, activePath, sql, shard, legacy, frozen, recovery, cold, unchangedData };
}

test("explicit full-span identity promotion survives cold reopen and retains every catalog identity", t => fixture(t, async f => {
  const before = f.unchangedData(), pointers = [readFileSync(f.activePath), readFileSync(f.refPath)];
  const spans = f.sql(db => Number(db.prepare("SELECT COUNT(*) AS n FROM spans").get()!.n));
  assert.ok(spans > 96, "fixture must require more than one proof page");
  refused(f.cold(f.ingest), "catalog-source-changed");
  const raw = { op: "raw", view: f.view, eventSeq: 1, offset: 0, length: 100 };
  refused(f.cold(raw), "catalog-source-changed");
  for (const bad of [{ force: true }, { after: 1 }, { evidence: "trusted" }]) {
    assert.equal(isCatalogStoreRequest({ ...f.base, ...f.recovery, action: "start", ...bad }), false);
  }
  assert.equal(result(f.cold({ ...f.recovery, action: "start" })).after, 0);
  refused(f.cold({ ...f.recovery, action: "publish" }), "catalog-source-identity-incomplete");
  const first = result(f.cold({ ...f.recovery, action: "step" }));
  assert.equal(first.spans, 96); assert.equal(first.complete, false);
  assert.equal(result(f.cold({ ...f.recovery, action: "status" })).after, first.after);
  refused(f.cold(raw), "catalog-source-changed"); // Progress alone is not acceptance.
  const second = result(f.cold({ ...f.recovery, action: "step" }));
  assert.equal(second.spans, spans); assert.equal(second.complete, true); assert.equal(second.published, false);
  assert.equal(result(f.cold({ ...f.recovery, action: "publish" })).published, true);
  assert.deepEqual(f.unchangedData(), before);
  const { snapshot: _old, ...oldRow } = f.frozen, { snapshot: _new, ...newRow } = f.shard();
  assert.deepEqual(newRow, oldRow);
  assert.deepEqual([readFileSync(f.activePath), readFileSync(f.refPath)], pointers);
  const promoted = JSON.parse(String(f.shard().snapshot));
  assert.equal(promoted.schemaVersion, 2);
  assert.equal(promoted.identityReceipt.previousSnapshot, f.legacy);
  assert.equal(promoted.identityReceipt.prefixBytes, second.after);
  assert.equal(promoted.identityReceipt.spans, spans);
  const receipt = structuredClone(promoted.identityReceipt);
  // Model a reboot-only raw device observation change. Stable identity still
  // comes from the actual inherited-FD probe on each fresh process.
  promoted.identity.device = JSON.parse(f.legacy).identity.device;
  f.sql(db => db.prepare("UPDATE shards SET snapshot=? WHERE g=1 AND shard='s1'").run(JSON.stringify(promoted)));
  assert.equal(Buffer.from(result(f.cold(raw)).data, "base64").toString(), readFileSync(f.source).subarray(0, 100).toString());
  assert.equal(result(f.cold(f.ingest)).records, 0);
  appendFileSync(f.source, line("b", "a"));
  assert.equal(result(f.cold(f.ingest)).records, 1);
  assert.deepEqual(JSON.parse(String(f.shard().snapshot)).identityReceipt, receipt);
  assert.equal(result(f.cold({ ...f.recovery, action: "publish" })).published, true, "publication retry survives a later append");
  assert.equal(result(f.cold({ op: "page", view: f.view })).events.length, 1);
  const changed = JSON.parse(String(f.shard().snapshot));
  changed.fileIdentity.fsid = changed.fileIdentity.fsid === "1" ? "2" : "1";
  f.sql(db => db.prepare("UPDATE shards SET snapshot=? WHERE g=1 AND shard='s1'").run(JSON.stringify(changed)));
  refused(f.cold(raw), "catalog-source-changed");
}));

test("proof refuses changed bytes, overlapping spans, append during proof, and replacement", t => fixture(t, async f => {
  const request = (action: string, recoveryKey: string) => ({ ...f.recovery, action, recoveryKey });
  const offset = 100000, fd = openSync(f.source, "r+");
  try { writeSync(fd, Buffer.from("y"), 0, 1, offset); } finally { closeSync(fd); }
  await f.ok(request("start", "changed-span")); // Outside the sampled anchors.
  refused(await f.request(request("step", "changed-span")), "catalog-source-changed");
  assert.equal(f.shard().snapshot, f.legacy);
  const restore = openSync(f.source, "r+");
  try { writeSync(restore, Buffer.from("x"), 0, 1, offset); } finally { closeSync(restore); }
  await f.ok(request("start", "overlap"));
  await f.ok(request("step", "overlap"));
  const boundary = f.sql(db => db.prepare("SELECT offset,length FROM spans ORDER BY offset LIMIT 1 OFFSET 95").get()!);
  const overlappingOffset = Number(boundary.offset) + 1;
  f.sql(db => db.prepare("INSERT INTO spans VALUES(1,'s1',?,1,?)").run(overlappingOffset, hash("x")));
  refused(await f.request(request("step", "overlap")), "catalog-source-identity-span-invalid");
  f.sql(db => db.prepare("DELETE FROM spans WHERE offset=?").run(overlappingOffset));
  await f.ok(request("start", "append-window"));
  await f.ok(request("step", "append-window"));
  appendFileSync(f.source, line("b", "a"));
  refused(await f.request(request("step", "append-window")), "catalog-source-changed");
  refused(await f.request(request("publish", "append-window")), "catalog-source-changed");
  assert.equal(f.shard().snapshot, f.legacy);
  await f.ok(request("start", "settled-window"));
  while (!(await f.ok(request("step", "settled-window"))).complete) { /* bounded fixture prefix */ }
  renameSync(f.source, `${f.source}.old`);
  writeFileSync(f.source, readFileSync(`${f.source}.old`), { mode: 0o600 });
  refused(await f.request(request("publish", "settled-window")), "catalog-source-changed");
  assert.equal(f.shard().snapshot, f.legacy);
}));

test("source capture refuses same-path replacement during the inherited-FD probe", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(process.cwd(), ".chrono-source-identity-")), source = join(dir, "source.jsonl");
  try {
    writeFileSync(source, line("a", null), { mode: 0o600 });
    const script = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
      import {renameSync,readFileSync,writeFileSync} from 'node:fs'; import assert from 'node:assert/strict';
      import {CatalogSource} from ${JSON.stringify(new URL("../src/catalog-source.js", import.meta.url).href)};
      const path=${JSON.stringify(source)}, original=cp.execFileSync;
      cp.execFileSync=function(...args){const output=original.apply(this,args);renameSync(path,path+'.old');writeFileSync(path,readFileSync(path+'.old'),{mode:0o600});return output;};
      syncBuiltinESMExports(); assert.throws(()=>new CatalogSource(path),/catalog-source-changed/);
      cp.execFileSync=()=>{throw new Error('synthetic probe failure')}; syncBuiltinESMExports();
      assert.throws(()=>new CatalogSource(path),/catalog-source-identity-unavailable/);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("durable identity never ignores unsupported-filesystem device changes or Btrfs namespace changes", () => {
  const strict = { version: 1 as const, kind: "device-inode" as const, device: "10", inode: "42" };
  assert.equal(sameCatalogFileIdentity(strict, { ...strict, device: "11" }), false);
  const stable = { version: 1 as const, kind: "linux-btrfs-statfs" as const, fsType: "9123683e" as const, fsid: "1234", inode: "42", birthtimeNs: "12345" };
  assert.equal(sameCatalogFileIdentity(stable, { ...stable }), true);
  assert.equal(sameCatalogFileIdentity(stable, { ...stable, fsid: "1235" }), false);
  assert.equal(sameCatalogFileIdentity(stable, { ...stable, birthtimeNs: "12346" }), false);
  assert.equal(sameCatalogFileIdentity(stable, strict), false);
});
