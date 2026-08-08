import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Dir } from "node:fs";
import { RepositoryTree, type FileSystemOps } from "../src/filesystem.ts";
import { makeDirectory, withTempDirectory, writeFile } from "./helpers.ts";

function childNames(tree: RepositoryTree, relativePath = ""): string[] {
  return tree.getNode(relativePath).children.map((childPath) => tree.getNode(childPath).name);
}

test("applies root and nested gitignore rules plus hard default exclusions", async () => {
  await withTempDirectory("pi-files-ignore", async (root) => {
    await writeFile(root, ".gitignore", "*.log\n!important.log\ncache/\n");
    await writeFile(root, "debug.log", "ignored");
    await writeFile(root, "important.log", "kept");
    await writeFile(root, "keep.txt", "kept");
    await writeFile(root, "cache/value.txt", "ignored dir");
    await writeFile(root, "src/.gitignore", "generated.ts\n");
    await writeFile(root, "src/generated.ts", "ignored nested");
    await writeFile(root, "src/index.ts", "kept nested");
    await writeFile(root, ".git/config", "ignored default");
    await writeFile(root, "node_modules/pkg/index.js", "ignored default");

    const tree = new RepositoryTree(root);
    await tree.initialize();
    assert.deepEqual(childNames(tree), ["src", ".gitignore", "important.log", "keep.txt"]);
    assert.equal(tree.findNode("debug.log"), undefined);
    assert.equal(tree.findNode("cache"), undefined);
    assert.equal(tree.findNode(".git"), undefined);
    assert.equal(tree.findNode("node_modules"), undefined);

    await tree.expand("src");
    assert.deepEqual(childNames(tree, "src"), [".gitignore", "index.ts"]);
    assert.equal(tree.findNode("src/generated.ts"), undefined);
    tree.dispose();
  });
});

test("hidden files are materialized but only shown after the visible toggle", async () => {
  await withTempDirectory("pi-files-hidden", async (root) => {
    await writeFile(root, ".secret", "secret");
    await writeFile(root, ".hidden/file.txt", "nested");
    await writeFile(root, "visible.txt", "visible");
    const tree = new RepositoryTree(root);
    await tree.initialize();

    const hiddenOff = tree.visibleRows({ showHidden: false, selectedPaths: new Set() });
    assert.deepEqual(
      hiddenOff.flatMap((row) => (row.node ? [row.node.relativePath] : [])),
      ["visible.txt"],
    );
    const hiddenOn = tree.visibleRows({ showHidden: true, selectedPaths: new Set() });
    assert.deepEqual(
      hiddenOn.flatMap((row) => (row.node ? [row.node.relativePath] : [])),
      [".hidden", ".secret", "visible.txt"],
    );
    tree.dispose();
  });
});

test("does not follow directory symlinks and blocks file symlinks outside ctx.cwd", async () => {
  await withTempDirectory("pi-files-links", async (base) => {
    const root = path.join(base, "repo");
    const outside = path.join(base, "outside");
    await makeDirectory(root, ".");
    await makeDirectory(outside, ".");
    await writeFile(root, "inside.txt", "inside");
    await writeFile(outside, "secret.txt", "outside");
    await writeFile(outside, "dir/nested.txt", "outside dir");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "outside-file"));
    await fs.symlink(path.join(outside, "dir"), path.join(root, "outside-dir"));
    await fs.symlink(path.join(root, "inside.txt"), path.join(root, "inside-link"));

    const tree = new RepositoryTree(root);
    await tree.initialize();
    const outsideFile = tree.getNode("outside-file");
    const outsideDir = tree.getNode("outside-dir");
    const insideLink = tree.getNode("inside-link");
    assert.equal(outsideFile.kind, "symlink");
    assert.equal(outsideFile.symlinkTargetKind, "file");
    assert.equal(outsideFile.symlinkWithinRoot, false);
    assert.ok(outsideFile.symlinkTarget?.includes("secret.txt"));
    assert.equal(outsideDir.kind, "symlink");
    assert.equal(outsideDir.symlinkTargetKind, "directory");
    assert.equal(outsideDir.loaded, true);
    assert.deepEqual(outsideDir.children, []);
    assert.equal(insideLink.symlinkWithinRoot, true);
    assert.equal((await tree.resolveSafeReadableFile("inside-link")).symlink, true);
    await assert.rejects(() => tree.resolveSafeReadableFile("outside-file"), /outside ctx\.cwd/);
    tree.dispose();
  });
});

test("loads directories lazily", async () => {
  await withTempDirectory("pi-files-lazy", async (root) => {
    await writeFile(root, "src/deep/file.ts", "text");
    const tree = new RepositoryTree(root);
    await tree.initialize();
    const src = tree.getNode("src");
    assert.equal(src.loaded, false);
    assert.equal(tree.listingCounts.get("src"), undefined);
    assert.equal(tree.findNode("src/deep"), undefined);
    await tree.expand("src");
    assert.equal(src.loaded, true);
    assert.equal(tree.listingCounts.get("src"), 1);
    assert.equal(tree.getNode("src/deep").loaded, false);
    assert.equal(tree.findNode("src/deep/file.ts"), undefined);
    tree.dispose();
  });
});


test("preserves literal backslashes in POSIX file names", { skip: path.sep !== "/" }, async () => {
  await withTempDirectory("pi-files-backslash", async (root) => {
    const fileName = "literal\\name.txt";
    await fs.writeFile(path.join(root, fileName), "value");
    const tree = new RepositoryTree(root);
    await tree.initialize();
    assert.equal(tree.getNode(fileName).name, fileName);
    assert.equal((await tree.resolveSafeReadableFile(fileName)).relativePath, fileName);
    tree.dispose();
  });
});

test("refreshes safely when an entry changes between directory and file", async () => {
  await withTempDirectory("pi-files-kind-transition", async (root) => {
    await writeFile(root, "node/child.txt", "old child");
    const tree = new RepositoryTree(root);
    await tree.initialize();
    await tree.expand("node");
    assert.equal(tree.getNode("node").kind, "directory");
    assert.equal(tree.getNode("node/child.txt").kind, "file");

    await fs.rm(path.join(root, "node"), { recursive: true, force: true });
    await fs.writeFile(path.join(root, "node"), "now a file");
    await tree.loadDirectory("", true);
    assert.equal(tree.getNode("node").kind, "file");
    assert.equal(tree.findNode("node/child.txt"), undefined);

    await fs.rm(path.join(root, "node"), { force: true });
    await writeFile(root, "node/new-child.txt", "new child");
    await tree.loadDirectory("", true);
    const directory = tree.getNode("node");
    assert.equal(directory.kind, "directory");
    assert.equal(directory.loaded, false);
    assert.equal(tree.findNode("node/new-child.txt"), undefined);
    await tree.expand("node");
    assert.equal(tree.getNode("node/new-child.txt").kind, "file");
    tree.dispose();
  });
});

test("uses deterministic locale-independent directory-first sorting", async () => {
  await withTempDirectory("pi-files-sort", async (root) => {
    await makeDirectory(root, "bDir");
    await makeDirectory(root, "ADir");
    await writeFile(root, "b.ts", "");
    await writeFile(root, "a.ts", "");
    await writeFile(root, "A.ts", "");
    const tree = new RepositoryTree(root);
    await tree.initialize();
    assert.deepEqual(childNames(tree), ["ADir", "bDir", "A.ts", "a.ts", "b.ts"]);
    tree.dispose();
  });
});

test("directory errors stay on the affected node and do not crash the model", async () => {
  await withTempDirectory("pi-files-errors", async (root) => {
    await writeFile(root, "denied/value.txt", "value");
    await writeFile(root, "ok.txt", "ok");
    const deniedPath = path.join(root, "denied");
    const ops: FileSystemOps = {
      lstat: fs.lstat,
      stat: fs.stat,
      realpath: fs.realpath,
      readlink: fs.readlink,
      readFile: async (filePath, encoding) => fs.readFile(filePath, encoding),
      opendir: async (filePath): Promise<Dir> => {
        if (path.resolve(filePath) === path.resolve(deniedPath)) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return fs.opendir(filePath);
      },
    };
    const tree = new RepositoryTree(root, { fs: ops });
    await tree.initialize();
    const denied = await tree.expand("denied");
    assert.match(denied.error ?? "", /EACCES: permission denied/);
    assert.deepEqual(denied.children, []);
    assert.equal(tree.getNode("ok.txt").kind, "file");
    tree.dispose();
  });
});


test("root listing errors are rendered as a visible warning instead of crashing", async () => {
  await withTempDirectory("pi-files-root-error", async (root) => {
    const ops: FileSystemOps = {
      lstat: fs.lstat,
      stat: fs.stat,
      realpath: fs.realpath,
      readlink: fs.readlink,
      readFile: async (filePath, encoding) => fs.readFile(filePath, encoding),
      opendir: async (filePath): Promise<Dir> => {
        if (path.resolve(filePath) === path.resolve(root)) {
          throw Object.assign(new Error("root permission denied"), { code: "EACCES" });
        }
        return fs.opendir(filePath);
      },
    };
    const tree = new RepositoryTree(root, { fs: ops });
    await tree.initialize();
    const warning = tree
      .visibleRows({ showHidden: false, selectedPaths: new Set() })
      .find((row) => row.key === "warning:root-error");
    assert.match(warning?.label ?? "", /EACCES: root permission denied/);
    tree.dispose();
  });
});

test("forced refresh replaces rather than accumulates changed gitignore rules", async () => {
  await withTempDirectory("pi-files-ignore-refresh", async (root) => {
    await writeFile(root, ".gitignore", "old.txt\n");
    await writeFile(root, "old.txt", "old");
    await writeFile(root, "new.txt", "new");
    const tree = new RepositoryTree(root);
    await tree.initialize();
    assert.equal(tree.findNode("old.txt"), undefined);
    assert.ok(tree.findNode("new.txt"));
    await writeFile(root, ".gitignore", "new.txt\n");
    await tree.loadDirectory("", true);
    assert.ok(tree.findNode("old.txt"));
    assert.equal(tree.findNode("new.txt"), undefined);
    tree.dispose();
  });
});

test("caps one listing and emits a visible truncation warning", async () => {
  await withTempDirectory("pi-files-cap", async (root) => {
    for (let index = 0; index < 6; index += 1) await writeFile(root, `file-${index}.txt`, String(index));
    const tree = new RepositoryTree(root, { directoryEntryLimit: 3 });
    await tree.initialize();
    assert.equal(tree.getNode("").children.length, 3);
    assert.equal(tree.getNode("").truncated, true);
    const warning = tree.visibleRows({ showHidden: false, selectedPaths: new Set() }).find((row) => row.kind === "warning");
    assert.match(warning?.label ?? "", /truncated at 3 entries/);
    tree.dispose();
  });
});
