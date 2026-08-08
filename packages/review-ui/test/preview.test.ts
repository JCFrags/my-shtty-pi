import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { piBuiltinSemantics } from "../src/pi-semantics.js";
import { buildReviewPreview, type BuiltinSemantics } from "../src/preview.js";
import { makeTempDir } from "./helpers.js";

const simpleSemantics: BuiltinSemantics = {
  async constructEdit({ input, current }) {
    let content = current.toString("utf8");
    for (const edit of input.edits) {
      const index = content.indexOf(edit.oldText);
      if (index < 0) throw new Error("not found");
      content = content.slice(0, index) + edit.newText + content.slice(index + edit.oldText.length);
    }
    return content;
  },
  generateUnifiedDiff(path, oldContent, newContent) {
    return `--- ${path}\n+++ ${path}\n-${oldContent}\n+${newContent}`;
  },
};

test("edit preview constructs proposed content with Pi's built-in edit semantics", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const target = join(temp.path, "edit.txt");
  await writeFile(target, "alpha\nbeta\ngamma\n");

  const preview = await buildReviewPreview(
    {
      tool: "edit",
      toolCallId: "edit-1",
      input: { path: "edit.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
    },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: piBuiltinSemantics },
  );

  assert.equal(preview.proposedContent, "alpha\nBETA\ngamma\n");
  assert.match(preview.previewText, /--- edit\.txt/);
  assert.match(preview.previewText, /-beta/);
  assert.match(preview.previewText, /\+BETA/);
  assert.equal(await readFile(target, "utf8"), "alpha\nbeta\ngamma\n", "preview must not write");
});

test("diff labels escape path controls without mutating the requested path", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const input = { path: "odd\nname.txt", content: "created\n" };

  const preview = await buildReviewPreview(
    { tool: "write", toolCallId: "write-control-path", input },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: simpleSemantics },
  );

  assert.equal(input.path, "odd\nname.txt");
  const lines = preview.previewText.split("\n");
  assert.equal(lines[0], "--- odd␊name.txt");
  assert.equal(lines[1], "+++ odd␊name.txt");
});

test("new-file write shows a unified diff and missing parent directories", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);

  const preview = await buildReviewPreview(
    {
      tool: "write",
      toolCallId: "write-new",
      input: { path: "new/nested/file.txt", content: "created\n" },
    },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: piBuiltinSemantics },
  );

  assert.equal(preview.current.exists, false);
  assert.equal(preview.proposedContent, "created\n");
  assert.match(preview.previewText, /\+created/);
  const parentWarning = preview.warnings.find((warning) => warning.code === "missing-parents");
  assert.ok(parentWarning);
  assert.match(parentWarning.message, /new/);
  await assert.rejects(() => readFile(join(temp.path, "new/nested/file.txt")), /ENOENT/);
});

test("overwrite write diffs existing content without modifying it", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const target = join(temp.path, "file.txt");
  await writeFile(target, "old\n");

  const preview = await buildReviewPreview(
    { tool: "write", toolCallId: "write-overwrite", input: { path: "file.txt", content: "new\n" } },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: piBuiltinSemantics },
  );

  assert.equal(preview.current.exists, true);
  assert.equal(preview.changed, true);
  assert.match(preview.previewText, /-old/);
  assert.match(preview.previewText, /\+new/);
  assert.equal(await readFile(target, "utf8"), "old\n");
});

test("edit preview preserves CRLF line endings in the proposed content", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const target = join(temp.path, "crlf.txt");
  await writeFile(target, Buffer.from("one\r\ntwo\r\nthree\r\n", "utf8"));

  const preview = await buildReviewPreview(
    {
      tool: "edit",
      toolCallId: "edit-crlf",
      input: { path: "crlf.txt", edits: [{ oldText: "two\n", newText: "TWO\n" }] },
    },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: piBuiltinSemantics },
  );

  assert.equal(preview.proposedContent, "one\r\nTWO\r\nthree\r\n");
  assert.equal(preview.proposed.bytes, Buffer.byteLength("one\r\nTWO\r\nthree\r\n"));
  assert.equal(await readFile(target, "utf8"), "one\r\ntwo\r\nthree\r\n");
});

test("binary/NUL content renders metadata rather than text", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const target = join(temp.path, "binary.dat");
  await writeFile(target, Buffer.from([0x41, 0x00, 0x42]));

  const preview = await buildReviewPreview(
    {
      tool: "write",
      toolCallId: "binary-write",
      input: { path: "binary.dat", content: "C\0D" },
    },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: simpleSemantics },
  );

  assert.equal(preview.binary, true);
  assert.match(preview.previewText, /Binary\/NUL content metadata/);
  assert.match(preview.previewText, /sha256/);
  assert.doesNotMatch(preview.previewText, /C\0D/);
  assert.ok(preview.warnings.some((warning) => warning.code === "binary"));
});

test("invalid UTF-8 current content is treated as binary-like even without NUL bytes", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const target = join(temp.path, "invalid-utf8.dat");
  await writeFile(target, Buffer.from([0x66, 0x6f, 0x80, 0x6f]));

  const preview = await buildReviewPreview(
    {
      tool: "write",
      toolCallId: "invalid-utf8-write",
      input: { path: "invalid-utf8.dat", content: "replacement" },
    },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: simpleSemantics },
  );

  assert.equal(preview.current.containsNul, false);
  assert.equal(preview.current.binaryLike, true);
  assert.equal(preview.binary, true);
  assert.match(preview.previewText, /Binary\/NUL content metadata/);
});

test("control-heavy proposed text is treated as binary-like", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);

  const preview = await buildReviewPreview(
    {
      tool: "write",
      toolCallId: "control-write",
      input: { path: "control.dat", content: "x\u0001y" },
    },
    { cwd: temp.path, maxPreviewBytes: 1_048_576, semantics: simpleSemantics },
  );

  assert.equal(preview.proposed.containsNul, false);
  assert.equal(preview.proposed.binaryLike, true);
  assert.equal(preview.binary, true);
  assert.ok(preview.warnings.some((warning) => warning.code === "binary"));
});

test("oversized content produces a bounded summary and requires the oversized path", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const target = join(temp.path, "large.txt");
  const oldText = `${"a".repeat(2048)}\nold-tail\n`;
  const newText = `${"a".repeat(2048)}\nnew-tail\n`;
  await writeFile(target, oldText);

  const preview = await buildReviewPreview(
    { tool: "write", toolCallId: "large-write", input: { path: "large.txt", content: newText } },
    { cwd: temp.path, maxPreviewBytes: 1024, semantics: simpleSemantics },
  );

  assert.equal(preview.oversized, true);
  assert.match(preview.previewText, /Oversized diff summary/);
  assert.match(preview.previewText, /bounded current excerpt/);
  assert.ok(preview.previewText.length < 4096, "summary must remain bounded");
  assert.ok(preview.warnings.some((warning) => warning.code === "oversized"));
});

test("outside and symlink warnings include the effective target", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const project = join(temp.path, "project");
  await mkdir(project);
  const outside = join(temp.path, "outside.txt");
  await writeFile(outside, "outside\n");
  await (await import("node:fs/promises")).symlink(outside, join(project, "link.txt"));

  const preview = await buildReviewPreview(
    { tool: "write", toolCallId: "link-write", input: { path: "link.txt", content: "changed\n" } },
    { cwd: project, maxPreviewBytes: 1_048_576, semantics: simpleSemantics },
  );

  assert.equal(preview.path.outsideCwd, true);
  assert.ok(preview.warnings.some((warning) => warning.code === "outside-cwd"));
  const symlinkWarning = preview.warnings.find((warning) => warning.code === "symlink");
  assert.ok(symlinkWarning);
  assert.match(symlinkWarning.message, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
