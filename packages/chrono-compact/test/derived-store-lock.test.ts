import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDerivedStoreLock, type DerivedStoreLockOwner } from "../src/derived-store-lock.js";
import { createCandidateSegmentStore, updateCandidateSegmentStore } from "../src/candidate-segment-store.js";
import { resolveCompactorConfig } from "../src/compactor.js";
import { sourceLedgerPath, updateSourceLedger } from "../src/source-ledger.js";

async function temporary(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "chrono-derived-lock-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const owner = (overrides: Partial<DerivedStoreLockOwner> = {}): DerivedStoreLockOwner => ({
  schemaVersion: 1,
  pid: 101,
  processStartIdentity: "start-a",
  nonce: randomBytes(16).toString("hex"),
  creationTime: new Date(0).toISOString(),
  ...overrides,
});

test("derived store lock acquires, flushes an owner record, and releases", async (t) => {
  const path = join(await temporary(t), "writer.lock");
  const release = await acquireDerivedStoreLock(path, { readProcessStart: async () => "self-start" });
  const record = JSON.parse(await readFile(path, "utf8")) as DerivedStoreLockOwner;
  assert.equal(record.pid, process.pid);
  assert.equal(record.processStartIdentity, "self-start");
  await release();
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("derived store lock protects live, unverifiable, malformed, and legacy empty owners", async (t) => {
  for (const state of ["live", "unverifiable", "malformed", "empty"] as const) {
    const path = join(await temporary(t), `${state}.lock`);
    if (state === "malformed") await writeFile(path, "{bad", { mode: 0o600 });
    else if (state === "empty") await writeFile(path, "", { mode: 0o600 });
    else await writeFile(path, JSON.stringify(owner()), { mode: 0o600 });
    const readProcessStart = async (pid: number): Promise<string | "missing" | "unverifiable"> =>
      pid === process.pid ? "self-start" : state === "live" ? "start-a" : "unverifiable";
    await assert.rejects(acquireDerivedStoreLock(path, { readProcessStart }), /busy|unverifiable/);
    await stat(path);
  }
});

test("derived store lock recovers missing owners and reused PIDs", async (t) => {
  for (const state of ["missing", "reused"] as const) {
    const path = join(await temporary(t), `${state}.lock`);
    await writeFile(path, JSON.stringify(owner()), { mode: 0o600 });
    const release = await acquireDerivedStoreLock(path, { readProcessStart: async (pid) =>
      pid === process.pid ? "self-start" : state === "missing" ? "missing" : "start-b" });
    const replacement = JSON.parse(await readFile(path, "utf8")) as DerivedStoreLockOwner;
    assert.equal(replacement.pid, process.pid);
    await release();
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
});

test("source-ledger and candidate-store writers recover a proven dead owner", async (t) => {
  const directory = await temporary(t);
  const session = join(directory, "session.jsonl");
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "lock-integration" })}\n${JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Keep this." } })}\n`, { mode: 0o600 });
  const dead = owner({ pid: 999_999_999, processStartIdentity: "1" });
  await writeFile(`${sourceLedgerPath(session)}.lock`, JSON.stringify(dead), { mode: 0o600 });
  assert.equal((await updateSourceLedger(session)).sourceOrder.length, 1);

  const store = createCandidateSegmentStore(session, { storePath: join(directory, "candidate"), ledgerPath: join(directory, "candidate-ledger.jsonl") });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(store.storePath, { recursive: true, mode: 0o700 });
  await writeFile(join(store.storePath, ".writer.lock"), JSON.stringify(dead), { mode: 0o600 });
  await updateCandidateSegmentStore(store, resolveCompactorConfig({ targetTokens: 2_000, enableSemanticCompression: false }));
  assert.equal(store.manifest?.sourceEntryCountCovered, 1);
});

test("derived store release cannot remove a replacement owner with another inode or nonce", async (t) => {
  const directory = await temporary(t);
  for (const mode of ["inode", "nonce"] as const) {
    const path = join(directory, `${mode}.lock`);
    const release = await acquireDerivedStoreLock(path, { readProcessStart: async () => "self-start" });
    const current = JSON.parse(await readFile(path, "utf8")) as DerivedStoreLockOwner;
    if (mode === "inode") {
      await rm(path);
      await writeFile(path, JSON.stringify({ ...current, nonce: randomBytes(16).toString("hex") }), { mode: 0o600 });
    } else {
      await writeFile(path, JSON.stringify({ ...current, nonce: randomBytes(16).toString("hex") }), { mode: 0o600 });
    }
    await release();
    await stat(path);
  }
});
