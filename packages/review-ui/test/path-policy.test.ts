import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectTargetPath, isPathWithin } from "../src/path-policy.js";
import { makeTempDir } from "./helpers.js";

test("relative and absolute in-cwd paths normalize inside ctx.cwd", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  await writeFile(join(temp.path, "inside.txt"), "hello\n");

  const relative = await inspectTargetPath(temp.path, "./nested/../inside.txt");
  assert.equal(relative.lexicalPath, join(temp.path, "inside.txt"));
  assert.equal(relative.displayPath, "inside.txt");
  assert.equal(relative.outsideCwd, false);
  assert.equal(relative.targetExists, true);
  assert.equal(relative.targetKind, "file");

  const absolute = await inspectTargetPath(temp.path, join(temp.path, "inside.txt"));
  assert.equal(absolute.outsideCwd, false);
  assert.equal(absolute.displayPath, "inside.txt");
});

test("lexical outside-cwd paths are detected", async (t) => {
  const root = await makeTempDir();
  t.after(root.cleanup);
  const cwd = join(root.path, "project");
  await mkdir(cwd);
  const outside = join(root.path, "outside.txt");
  await writeFile(outside, "outside\n");

  const inspection = await inspectTargetPath(cwd, "../outside.txt");
  assert.equal(inspection.lexicalOutsideCwd, true);
  assert.equal(inspection.outsideCwd, true);
  assert.equal(inspection.lexicalPath, outside);
  assert.equal(inspection.displayPath, "../outside.txt");
});

test("symlinks inside cwd are disclosed without an outside result", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  await mkdir(join(temp.path, "real"));
  await writeFile(join(temp.path, "real", "file.txt"), "inside\n");
  await symlink(join(temp.path, "real", "file.txt"), join(temp.path, "link.txt"));

  const inspection = await inspectTargetPath(temp.path, "link.txt");
  assert.equal(inspection.usedSymlink, true);
  assert.equal(inspection.outsideCwd, false);
  assert.equal(inspection.effectivePath, join(temp.path, "real", "file.txt"));
  assert.deepEqual(inspection.symlinkPaths, [join(temp.path, "link.txt")]);
});

test("a symlink whose effective target leaves cwd receives outside-cwd treatment", async (t) => {
  const root = await makeTempDir();
  t.after(root.cleanup);
  const cwd = join(root.path, "project");
  await mkdir(cwd);
  const outside = join(root.path, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(cwd, "escape.txt"));

  const inspection = await inspectTargetPath(cwd, "escape.txt");
  assert.equal(inspection.lexicalOutsideCwd, false);
  assert.equal(inspection.effectiveOutsideCwd, true);
  assert.equal(inspection.outsideCwd, true);
  assert.equal(inspection.usedSymlink, true);
  assert.equal(inspection.effectivePath, outside);
});

test("missing parent directories are enumerated in creation order", async (t) => {
  const temp = await makeTempDir();
  t.after(temp.cleanup);
  const inspection = await inspectTargetPath(temp.path, "one/two/file.txt");
  assert.equal(inspection.targetExists, false);
  assert.deepEqual(inspection.missingParentDirectories, [
    join(temp.path, "one"),
    join(temp.path, "one", "two"),
  ]);
});

test("missing children under a symlink use the effective target for containment", async (t) => {
  const root = await makeTempDir();
  t.after(root.cleanup);
  const cwd = join(root.path, "project");
  const outsideDir = join(root.path, "outside-dir");
  await mkdir(cwd);
  await mkdir(outsideDir);
  await symlink(outsideDir, join(cwd, "linked-dir"));

  const inspection = await inspectTargetPath(cwd, "linked-dir/new/file.txt");
  assert.equal(inspection.usedSymlink, true);
  assert.equal(inspection.effectivePath, join(outsideDir, "new", "file.txt"));
  assert.equal(inspection.outsideCwd, true);
  assert.ok(inspection.missingParentDirectories.includes(join(outsideDir, "new")));
});

test("isPathWithin rejects sibling prefix tricks", () => {
  assert.equal(isPathWithin("/tmp/project", "/tmp/project/file"), true);
  assert.equal(isPathWithin("/tmp/project", "/tmp/project-other/file"), false);
  assert.equal(isPathWithin("/tmp/project", resolve("/tmp/project/../outside")), false);
});

test("NUL-containing paths fail closed", async () => {
  await assert.rejects(() => inspectTargetPath("/tmp", "bad\0name"), /NUL/);
});
