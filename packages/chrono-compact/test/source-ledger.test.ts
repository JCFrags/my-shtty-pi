import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSourceLedger, readExactSourceEntry, sourceLedgerPath, updateSourceLedger } from "../src/source-ledger.js";

const header = { type: "session", version: 3, id: "session-test" };
const entry = (id: string, parentId: string | null, text = `message-${id}`) => ({ type: "message", id, parentId, message: { role: "user", content: text } });
const line = (value: unknown) => JSON.stringify(value);
async function temporary(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "chrono-source-ledger-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

for (const ending of ["\n", "\r\n"] as const) test(`builds offsets and retrieves exact entries with ${ending === "\n" ? "LF" : "CRLF"}`, async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  const values = [header, entry("a", null), entry("b", "a")];
  const text = values.map(line).join(ending) + ending;
  await writeFile(session, text);
  const ledger = await updateSourceLedger(session);
  assert.equal(ledger.metrics.transition, "new");
  assert.deepEqual(ledger.sourceOrder.map((item) => [item.entryId, item.parentId]), [["a", null], ["b", "a"]]);
  const exact = await readExactSourceEntry(session, ledger, "b");
  assert.equal(exact.text, line(values[2]));
  assert.equal(exact.bytesRead, Buffer.byteLength(exact.text));
  const item = ledger.entryById.get("b")!;
  assert.equal(text.slice(item.sourceByteOffset, item.sourceByteOffset + item.sourceByteLength), exact.text);
  assert.equal(item.nextSourceByteOffset, Buffer.byteLength(text));
});

test("supports a complete final line without a newline", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}`);
  const ledger = await updateSourceLedger(session);
  assert.equal(ledger.sourceOrder.length, 1);
  assert.equal(ledger.checkpoint.sourceBytePosition, (await stat(session)).size);
});

test("waits for an incomplete final line and appends after completion", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  const second = line(entry("a", null)); const cut = Math.floor(second.length / 2);
  await writeFile(session, `${line(header)}\n${second.slice(0, cut)}`);
  let ledger = await updateSourceLedger(session);
  assert.equal(ledger.sourceOrder.length, 0);
  const sidecarSize = (await stat(sourceLedgerPath(session))).size;
  await appendFile(session, second.slice(cut, cut + 2));
  ledger = await updateSourceLedger(session, ledger);
  assert.equal(ledger.metrics.transition, "exact-hit");
  assert.equal((await stat(sourceLedgerPath(session))).size, sidecarSize);
  await appendFile(session, `${second.slice(cut + 2)}\n`);
  ledger = await updateSourceLedger(session, ledger);
  assert.equal(ledger.metrics.transition, "append");
  assert.equal(ledger.sourceOrder[0]?.entryId, "a");
});

test("warm append and exact hit read bounded source bytes and reuse maps", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`);
  let ledger = await updateSourceLedger(session); const map = ledger.entryById;
  await appendFile(session, `${line(entry("b", "a"))}\n`);
  ledger = await updateSourceLedger(session, ledger);
  assert.equal(ledger.entryById, map);
  assert.equal(ledger.metrics.transition, "append");
  assert.ok(ledger.metrics.sourceBytesRead < (await stat(session)).size);
  const sidecarBefore = await stat(sourceLedgerPath(session));
  const exact = await updateSourceLedger(session, ledger);
  const sidecarAfter = await stat(sourceLedgerPath(session));
  assert.equal(exact.metrics.transition, "exact-hit");
  assert.equal(exact.metrics.ledgerBytesWritten, 0);
  assert.ok(exact.metrics.sourceBytesRead < exact.metrics.sourceFileSize);
  assert.equal(sidecarAfter.size, sidecarBefore.size);
  assert.equal(sidecarAfter.mtimeMs, sidecarBefore.mtimeMs);
});

test("detects truncation, replacement, and tail rewrite", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  const first = `${line(header)}\n${line(entry("a", null))}\n${line(entry("b", "a"))}\n`;
  await writeFile(session, first); let ledger = await updateSourceLedger(session);
  await writeFile(session, `${line(header)}\n`);
  ledger = await updateSourceLedger(session, ledger); assert.equal(ledger.metrics.transition, "rebuild-truncation");
  const replacement = join(directory, "replacement.jsonl");
  await writeFile(replacement, `${line(header)}\n${line(entry("c", null))}\n`); await rename(replacement, session);
  ledger = await updateSourceLedger(session, ledger); assert.equal(ledger.metrics.transition, "rebuild-replacement");
  const rewritten = `${line(header)}\n${line(entry("d", null))}\n`;
  assert.equal(Buffer.byteLength(rewritten), (await stat(session)).size);
  await writeFile(session, rewritten);
  ledger = await updateSourceLedger(session, ledger); assert.equal(ledger.metrics.transition, "rebuild-tail-rewrite");
});

test("validates the session header, IDs, duplicates, and complete JSON", async (t) => {
  const directory = await temporary(t);
  for (const [name, text, expected] of [
    ["header", `${line({ type: "message", id: "x" })}\n`, /session header/],
    ["missing", `${line(header)}\n${line({ type: "message" })}\n`, /missing an id/],
    ["duplicate", `${line(header)}\n${line(entry("a", null))}\n${line(entry("a", null))}\n`, /Duplicate entry/],
    ["json", `${line(header)}\nnot-json\n`, /Invalid JSON/],
  ] as const) {
    const path = join(directory, `${name}.jsonl`); await writeFile(path, text);
    await assert.rejects(updateSourceLedger(path), expected);
  }
});

test("missing and changed exact entries fail closed", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  const original = `${line(header)}\n${line(entry("a", null, "alpha"))}\n`;
  await writeFile(session, original); const ledger = await updateSourceLedger(session);
  await assert.rejects(readExactSourceEntry(session, ledger, "missing"), /Unknown source entry/);
  await writeFile(session, original.replace("alpha", "bravo"));
  await assert.rejects(readExactSourceEntry(session, ledger, "a"), /Stale source ledger entry/);
});

test("recovers an incomplete sidecar tail from the last checkpoint", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`);
  await updateSourceLedger(session);
  await appendFile(sourceLedgerPath(session), '{"recordType":"entry"');
  const loaded = await loadSourceLedger(session);
  assert.equal(loaded.incompleteSidecarTail, true);
  const recovered = await updateSourceLedger(session, loaded);
  assert.equal(recovered.metrics.transition, "recover-incomplete-ledger-tail");
  assert.equal(recovered.incompleteSidecarTail, false);
});

test("does not accept a broken committed hash chain", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`);
  await updateSourceLedger(session); const sidecar = sourceLedgerPath(session);
  const text = await readFile(sidecar, "utf8");
  await writeFile(sidecar, text.replace(/"entryId":"a"/, '"entryId":"z"'));
  await assert.rejects(loadSourceLedger(session), /hash chain is broken/);
});

test("one-writer lock rejects a concurrent writer with a clear busy result", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void; const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const first = updateSourceLedger(session, undefined, { lockAcquired: async () => { acquired(); await held; } });
  await ready;
  await assert.rejects(updateSourceLedger(session), /busy/);
  release(); await first;
});

test("sidecar contains bounded metadata but no source text or source path", async (t) => {
  const directory = await temporary(t); const session = join(directory, "secret-session.jsonl");
  const secret = "UNIQUE-SOURCE-MESSAGE";
  await writeFile(session, `${line(header)}\n${line(entry("a", null, secret))}\n`);
  const ledger = await updateSourceLedger(session); const sidecar = await readFile(sourceLedgerPath(session), "utf8");
  assert.doesNotMatch(sidecar, new RegExp(secret));
  assert.doesNotMatch(sidecar, /secret-session|messageText|tool output/);
  const metadata = await stat(sourceLedgerPath(session)); assert.equal(metadata.mode & 0o077, 0);
  assert.equal(ledger.sourceSessionIdentity, "session-test");
});
