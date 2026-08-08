import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  boundedStateOutput,
  clipUtf8,
  codePointLength,
  compareNumericIds,
  isPlainJson,
  makeStateEvent,
  normalizeStateText,
  StateToolError,
  utf8Length,
  validateStateEventEnvelope,
  writePrivateStateOutput,
} from "@grounded/pi-core/state";

test("state core accepts exact v1 envelopes and rejects envelope defects", () => {
  const event = makeStateEvent("notes", "add", 0, "2026-08-01T00:00:00.000Z", { value: 1 });
  assert.doesNotThrow(() => validateStateEventEnvelope(event, "notes", 0));
  for (const changed of [
    { ...event, extra: true },
    { ...event, protocol: "future" },
    { ...event, tool: "workplan" },
    { ...event, baseStateRevision: 1 },
    { ...event, stateRevision: 2 },
    { ...event, at: "not-a-time" },
    { ...event, at: "2026-02-29T00:00:00.000Z" },
    { ...event, at: "2026-99-99T99:99:99.999Z" },
  ]) assert.throws(() => validateStateEventEnvelope(changed, "notes", 0), StateToolError);
});

test("plain JSON rejects functions, instances, undefined, unsafe integers, non-finite values, and cycles", () => {
  assert.equal(isPlainJson({ text: "x", fraction: 1.5, list: [true, null] }), true);
  assert.equal(isPlainJson({ fn() {} }), false);
  assert.equal(isPlainJson(new Date()), false);
  assert.equal(isPlainJson({ missing: undefined }), false);
  assert.equal(isPlainJson(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isPlainJson(Number.POSITIVE_INFINITY), false);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.equal(isPlainJson(cycle), false);
});

test("text limits distinguish code points and UTF-8 bytes and normalize only line endings", () => {
  assert.equal(codePointLength("😀a"), 2);
  assert.equal(utf8Length("😀a"), 5);
  assert.equal(normalizeStateText(" a\r\nb\rc "), " a\nb\nc ");
});

test("numeric IDs sort by numeric components", () => {
  assert.deepEqual(["WP10-M2", "WP2-M10", "WP2-M2", "WP1-M20"].sort(compareNumericIds), ["WP1-M20", "WP2-M2", "WP2-M10", "WP10-M2"]);
});

test("UTF-8 context clipping is deterministic and does not split a code point", () => {
  assert.equal(clipUtf8("a😀b", 5), "a😀");
  assert.equal(clipUtf8("a😀b", 4), "a");
  assert.equal(clipUtf8("a😀b", 5), clipUtf8("a😀b", 5));
});

test("private state output has exact bytes and private POSIX modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-core-"));
  const exact = "first\n😀 second\n";
  const path = await writePrivateStateOutput("grounded-notes", exact, undefined, root);
  assert.equal(await readFile(path, "utf8"), exact);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal(join(path, "..").includes("first"), false);
});

test("bounded state output reports exact shown and total counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-bounded-"));
  const output = "one\ntwo\nthree\n";
  const result = await boundedStateOutput(output, "grounded-workplan", undefined, { maxLines: 2, maxBytes: 100, temporaryRoot: root });
  assert.equal(result.truncated, true);
  assert.equal(result.totalLines, 3);
  assert.equal(await readFile(result.fullOutputPath!, "utf8"), output);
  assert.match(result.text, /showing 2 of 3 lines/);
});

test("cancelled spill creation removes its partial private directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-cancel-"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writePrivateStateOutput("grounded-notes", "secret body", controller.signal, root), /STATE_CANCELLED/);
  assert.deepEqual(await readdir(root), []);
});

test("spill failure after private directory creation removes partial output", async () => {
  const root = await mkdtemp(join(tmpdir(), "state-partial-"));
  const controller = new AbortController();
  let created: string | undefined;
  const watcher = watch(root, { persistent: false }, (_event, filename) => {
    const name = filename?.toString();
    if (name?.startsWith("grounded-notes-")) {
      created = name;
      controller.abort();
    }
  });
  try {
    await assert.rejects(
      writePrivateStateOutput("grounded-notes", "partial output", controller.signal, root),
      /STATE_CANCELLED/,
    );
  } finally {
    watcher.close();
  }
  assert.ok(created);
  assert.deepEqual(await readdir(root), []);
});
