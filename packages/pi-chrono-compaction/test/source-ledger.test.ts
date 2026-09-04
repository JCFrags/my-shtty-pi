import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSourceLedger, readExactSourceEntry, readSourceEntryRange, SOURCE_LEDGER_TAIL_ANCHOR_BYTES, sourceLedgerMatchesSource, sourceLedgerPath, updateSourceLedger } from "../src/source-ledger.js";
import { stableStringify } from "../src/utils.js";

const header = { type: "session", version: 3, id: "session-test" };
const entry = (id: string, parentId: string | null, text = `message-${id}`) => ({ type: "message", id, parentId, message: { role: "user", content: text } });
const line = (value: unknown) => JSON.stringify(value);
const largeEntry = (id: string, parentId: string | null, tokens: number) => entry(id, parentId, `LARGE-${id}-` + "x".repeat(tokens * 4));
async function temporary(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "chrono-source-ledger-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function afterNextPositionalRead(path: string, position: number, action: () => Promise<void>): Promise<{ restore: () => void; called: () => boolean }> {
  const probe = await open(path, "r"); const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
  await probe.close(); const original = prototype.read; let intercepted = false;
  prototype.read = async function (...args: unknown[]): Promise<unknown> { const result = await original.apply(this, args); if (!intercepted && args[3] === position) { intercepted = true; await action(); } return result; };
  return { restore: () => { prototype.read = original; }, called: () => intercepted };
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

test("append refuses a symlinked source-ledger sidecar", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`);
  const ledger = await updateSourceLedger(session);
  const sidecar = sourceLedgerPath(session);
  const target = join(directory, "unrelated.txt");
  await writeFile(target, "unchanged");
  await rm(sidecar);
  await symlink(target, sidecar);
  await appendFile(session, `${line(entry("b", "a"))}\n`);
  await assert.rejects(updateSourceLedger(session, ledger));
  assert.equal(await readFile(target, "utf8"), "unchanged");
});

test("warm append and exact hit read bounded source bytes and reuse maps", async (t) => {
  const directory = await temporary(t); const session = join(directory, "session.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`);
  let ledger = await updateSourceLedger(session); const map = ledger.entryById;
  const suffix = `${line(entry("b", "a"))}\n`;
  await appendFile(session, suffix);
  ledger = await updateSourceLedger(session, ledger);
  assert.equal(ledger.entryById, map);
  assert.equal(ledger.metrics.transition, "append");
  assert.equal(ledger.metrics.sourceBytesRead, ledger.metrics.tailAnchorBytesRead + Buffer.byteLength(suffix));
  const sidecarBefore = await stat(sourceLedgerPath(session));
  const exact = await updateSourceLedger(session, ledger);
  const sidecarAfter = await stat(sourceLedgerPath(session));
  assert.equal(exact.metrics.transition, "exact-hit");
  assert.equal(exact.metrics.ledgerBytesWritten, 0);
  assert.ok(exact.metrics.sourceBytesRead <= SOURCE_LEDGER_TAIL_ANCHOR_BYTES);
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

test("verified ledger snapshots remain readable after a genuine append", async (t) => {
  const directory = await temporary(t); const session = join(directory, "append-snapshot.jsonl");
  const originalEntry = line(entry("a", null));
  await writeFile(session, `${line(header)}\n${originalEntry}\n`);
  const ledger = await updateSourceLedger(session);
  await appendFile(session, `${line(entry("b", "a"))}\n`);
  assert.equal(await sourceLedgerMatchesSource(session, ledger), true);
  const range = await readSourceEntryRange(session, ledger, 0, 1);
  assert.deepEqual(range.entries.map((item) => item.text), [originalEntry]);
  assert.equal((await readExactSourceEntry(session, ledger, "a")).text, originalEntry);
});

test("a genuine append during range loading does not invalidate the verified snapshot", async (t) => {
  const directory = await temporary(t); const session = join(directory, "concurrent-append-snapshot.jsonl");
  const originalEntries = [line(entry("a", null)), line(largeEntry("b", "a", 250_000))];
  await writeFile(session, `${line(header)}\n${originalEntries.join("\n")}\n`);
  const ledger = await updateSourceLedger(session);
  const hook = await afterNextPositionalRead(session, ledger.checkpoint.anchorSourceOffset, () => appendFile(session, `${line(entry("c", "b"))}\n`));
  try {
    const range = await readSourceEntryRange(session, ledger, 0, ledger.sourceOrder.length);
    assert.deepEqual(range.entries.map((item) => item.text), originalEntries);
    assert.equal(hook.called(), true);
  } finally { hook.restore(); }
  assert.equal(await sourceLedgerMatchesSource(session, ledger), true);
});

test("range snapshots fail closed for replacement, truncation, selected mutation, and checkpoint mutation", async (t) => {
  const makeSnapshot = async (name: string): Promise<{ session: string; ledger: Awaited<ReturnType<typeof updateSourceLedger>>; original: Buffer }> => {
    const session = join(directory, `${name}.jsonl`);
    const original = Buffer.from(`${line(header)}\n${line(entry("a", null, "SELECTED-CONTENT"))}\n${line(largeEntry("tail", "a", 250_000))}\n`);
    await writeFile(session, original);
    return { session, ledger: await updateSourceLedger(session), original };
  };
  const directory = await temporary(t);

  const replaced = await makeSnapshot("replacement");
  const replacement = join(directory, "replacement-new.jsonl");
  await writeFile(replacement, replaced.original); await rename(replacement, replaced.session);
  assert.equal(await sourceLedgerMatchesSource(replaced.session, replaced.ledger), false);
  await assert.rejects(readSourceEntryRange(replaced.session, replaced.ledger, 0, 1), /checkpoint failed verification/);

  const truncated = await makeSnapshot("truncation");
  await writeFile(truncated.session, truncated.original.subarray(0, truncated.ledger.sourceOrder[0]!.nextSourceByteOffset));
  assert.equal(await sourceLedgerMatchesSource(truncated.session, truncated.ledger), false);
  await assert.rejects(readSourceEntryRange(truncated.session, truncated.ledger, 0, 1), /checkpoint failed verification/);

  const selectedMutation = await makeSnapshot("selected-mutation");
  const selected = selectedMutation.ledger.sourceOrder[0]!;
  const selectedBytes = Buffer.from(selectedMutation.original); const selectedIndex = selected.sourceByteOffset + selected.sourceByteLength - 3;
  selectedBytes.writeUInt8(selectedBytes.readUInt8(selectedIndex) ^ 1, selectedIndex);
  await writeFile(selectedMutation.session, selectedBytes);
  assert.equal(await sourceLedgerMatchesSource(selectedMutation.session, selectedMutation.ledger), true);
  await assert.rejects(readSourceEntryRange(selectedMutation.session, selectedMutation.ledger, 0, 1), /source bytes failed verification/);

  const checkpointMutation = await makeSnapshot("checkpoint-mutation");
  const checkpointBytes = Buffer.from(checkpointMutation.original);
  const checkpointIndex = checkpointMutation.ledger.checkpoint.anchorSourceOffset + 1;
  checkpointBytes.writeUInt8(checkpointBytes.readUInt8(checkpointIndex) ^ 1, checkpointIndex);
  await writeFile(checkpointMutation.session, checkpointBytes);
  assert.equal(await sourceLedgerMatchesSource(checkpointMutation.session, checkpointMutation.ledger), false);
  await assert.rejects(readSourceEntryRange(checkpointMutation.session, checkpointMutation.ledger, 0, 1), /checkpoint failed verification/);
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
  const sourceSentinel = "UNIQUE-SOURCE-MESSAGE";
  await writeFile(session, `${line(header)}\n${line(entry("a", null, sourceSentinel))}\n`);
  const ledger = await updateSourceLedger(session); const sidecar = await readFile(sourceLedgerPath(session), "utf8");
  assert.doesNotMatch(sidecar, new RegExp(sourceSentinel));
  assert.doesNotMatch(sidecar, /secret-session|messageText|tool output/);
  const metadata = await stat(sourceLedgerPath(session)); assert.equal(metadata.mode & 0o077, 0);
  assert.equal(ledger.sourceSessionIdentity, "session-test");
});

test("large source lines are assembled once and retain exact offsets, hashes, and retrieval", async (t) => {
  const directory = await temporary(t);
  for (const tokens of [250_000, 500_000]) {
    const session = join(directory, `large-${tokens}.jsonl`); const value = largeEntry(`large-${tokens}`, null, tokens);
    const raw = line(value); const text = `${line(header)}\n${raw}\n`;
    await writeFile(session, text);
    const ledger = await updateSourceLedger(session); const metadata = ledger.sourceOrder[0]!;
    assert.equal(text.slice(metadata.sourceByteOffset, metadata.sourceByteOffset + metadata.sourceByteLength), raw);
    assert.equal(metadata.sourceContentHash, createHash("sha256").update(raw).digest("hex"));
    assert.equal((await readExactSourceEntry(session, ledger, metadata.entryId)).text, raw);
    assert.equal(ledger.metrics.maximumSourceLineBytes, Buffer.byteLength(raw));
    assert.ok(ledger.metrics.sourceLineAssemblyBytes >= Buffer.byteLength(raw));
    assert.ok(ledger.metrics.sourceLineAssemblyBytes <= Buffer.byteLength(raw) + 1024);
    assert.doesNotMatch(await readFile(sourceLedgerPath(session), "utf8"), /LARGE-large-/);
  }
});

test("fixed tail anchor bounds exact hits and small appends after a large final entry", async (t) => {
  const directory = await temporary(t); const session = join(directory, "large-tail.jsonl");
  const large = line(largeEntry("large", null, 500_000));
  await writeFile(session, `${line(header)}\n${large}\n`);
  let ledger = await updateSourceLedger(session);
  ledger = await updateSourceLedger(session, ledger);
  assert.ok(ledger.metrics.tailAnchorBytesRead <= SOURCE_LEDGER_TAIL_ANCHOR_BYTES);
  assert.equal(ledger.metrics.tailAnchorBytesRead, SOURCE_LEDGER_TAIL_ANCHOR_BYTES);
  const suffix = `${line(entry("small", "large"))}\n`; await appendFile(session, suffix);
  ledger = await updateSourceLedger(session, ledger);
  assert.equal(ledger.metrics.tailAnchorBytesRead, SOURCE_LEDGER_TAIL_ANCHOR_BYTES);
  assert.equal(ledger.metrics.appendedSourceBytesRead, Buffer.byteLength(suffix));
  assert.equal(ledger.metrics.sourceBytesRead, SOURCE_LEDGER_TAIL_ANCHOR_BYTES + Buffer.byteLength(suffix));
  assert.ok(ledger.metrics.sourceBytesRead < Buffer.byteLength(large));
});

test("anchor changes rebuild while old-prefix changes wait for exact retrieval", async (t) => {
  const directory = await temporary(t); const session = join(directory, "anchor-change.jsonl");
  const old = line(entry("old", null, "OLD-CONTENT")); const large = line(largeEntry("large", "old", 250_000));
  const original = `${line(header)}\n${old}\n${large}\n`; await writeFile(session, original);
  let ledger = await updateSourceLedger(session);
  const anchorChanged = Buffer.from(original); const anchorIndex = anchorChanged.length - 10;
  anchorChanged.writeUInt8(anchorChanged.readUInt8(anchorIndex) ^ 1, anchorIndex); await writeFile(session, anchorChanged);
  ledger = await updateSourceLedger(session, ledger); assert.equal(ledger.metrics.transition, "rebuild-tail-rewrite");
  const oldMetadata = ledger.entryById.get("old")!;
  const prefixChanged = Buffer.from(anchorChanged); const prefixIndex = oldMetadata.sourceByteOffset + oldMetadata.sourceByteLength - 3;
  prefixChanged.writeUInt8(prefixChanged.readUInt8(prefixIndex) ^ 1, prefixIndex); await writeFile(session, prefixChanged);
  const exact = await updateSourceLedger(session, ledger); assert.equal(exact.metrics.transition, "exact-hit");
  await assert.rejects(readExactSourceEntry(session, exact, "old"), /Stale source ledger entry/);
});

test("a large incomplete final line is indexed once after completion", async (t) => {
  const directory = await temporary(t); const session = join(directory, "large-incomplete.jsonl");
  const raw = line(largeEntry("large", null, 250_000)); const cut = raw.length - 20;
  await writeFile(session, `${line(header)}\n${raw.slice(0, cut)}`);
  let ledger = await updateSourceLedger(session); assert.equal(ledger.sourceOrder.length, 0);
  await appendFile(session, `${raw.slice(cut)}\n`); ledger = await updateSourceLedger(session, ledger);
  assert.deepEqual(ledger.sourceOrder.map((item) => item.entryId), ["large"]);
});

test("a checkpoint without fixed anchor fields is not accepted", async (t) => {
  const directory = await temporary(t); const session = join(directory, "old-schema.jsonl");
  await writeFile(session, `${line(header)}\n${line(entry("a", null))}\n`); await updateSourceLedger(session);
  const sidecar = sourceLedgerPath(session); const records = (await readFile(sidecar, "utf8")).trim().split("\n").map((item) => JSON.parse(item));
  const checkpoint = records.at(-1); delete checkpoint.anchorSourceOffset; delete checkpoint.anchorByteLength; delete checkpoint.anchorContentHash;
  const base = { ...checkpoint }; delete base.ledgerRecordHash;
  checkpoint.ledgerRecordHash = createHash("sha256").update(stableStringify(base)).digest("hex");
  await writeFile(sidecar, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
  await assert.rejects(loadSourceLedger(session), /fixed tail anchor|hash chain/);
});
