import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  structuredFileSearch,
  structuredFuzzySearch,
  structuredTextSearch,
} from "@grounded/pi-core/search";

test("structured search engines include hidden paths, honor ignores, and keep fuzzy ranking explicit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-search-"));
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, ".hidden"));
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, "src", "alpha.ts"), "needle one\nneedle two\n");
  await writeFile(join(cwd, "src", "beta.ts"), "needle three\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
  await writeFile(join(cwd, "ignored.ts"), "needle ignored\n");
  await writeFile(join(cwd, "src", "ignored.ts"), "needle nested ignored\n");
  await writeFile(join(cwd, ".hidden-note.ts"), "hidden needle\n");
  await writeFile(join(cwd, ".hidden", "nested-note.ts"), "hidden needle\n");
  await writeFile(join(cwd, ".git", "config"), "hidden needle\n");

  const text = await structuredTextSearch({ cwd, query: "needle", path: ".", literal: true });
  assert.equal(text.length, 5);
  assert.ok(text.some((hit) => hit.path === ".hidden-note.ts"));
  assert.ok(text.some((hit) => hit.path === ".hidden/nested-note.ts"));
  assert.ok(text.every((hit) => !hit.path.startsWith(".git/") && !hit.path.includes("ignored")));

  const files = await structuredFileSearch({ cwd, pathGlob: "*.ts", path: "." });
  assert.ok(files.some((hit) => hit.path === "src/alpha.ts"));
  assert.ok(files.some((hit) => hit.path === ".hidden-note.ts"));
  assert.ok(files.some((hit) => hit.path === ".hidden/nested-note.ts"));
  assert.ok(files.every((hit) => !hit.path.startsWith(".git/") && !hit.path.includes("ignored")));

  const scoped = await structuredTextSearch({ cwd, query: "needle", path: "src", literal: true });
  assert.equal(scoped.length, 3);
  assert.ok(scoped.every((hit) => !hit.path.includes("ignored")));

  const fuzzy = await structuredFuzzySearch({ cwd, query: "alp", path: "." });
  assert.equal(fuzzy.hits[0]?.path, "src/alpha.ts");
  const hiddenFuzzy = await structuredFuzzySearch({ cwd, query: "hiddennote", path: "." });
  assert.deepEqual(hiddenFuzzy.hits.map((entry) => entry.path), [".hidden-note.ts", ".hidden/nested-note.ts"]);
});
test("structured text search paginates match hits independently from context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-structured-text-"));
  await writeFile(join(cwd, "sample.txt"), "before\nneedle one\nafter\nmore\nneedle two\nend\n");
  const hits = await structuredTextSearch({ cwd, query: "needle", path: ".", contextLines: 1 });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((hit) => hit.line), [2, 5]);
  assert.match(hits[0]!.snippet, /1: before\n2: needle one\n3: after/);
  assert.equal(hits[0]!.submatchCount, 1);
});

test("structured path search preserves newline paths and defines basename and full-path globs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-structured-path-"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "a.ts"), "");
  await writeFile(join(cwd, "src", "line\nbreak.ts"), "");
  await writeFile(join(cwd, "root.ts"), "");

  const basenameGlob = await structuredFileSearch({ cwd, pathGlob: "*.ts", path: "." });
  assert.equal(basenameGlob.filter((hit) => hit.path.endsWith(".ts")).length, 3);
  assert.ok(basenameGlob.some((hit) => hit.path === "src/line\nbreak.ts"));

  const directoryGlob = await structuredFileSearch({ cwd, pathGlob: "src/*.ts", path: "." });
  assert.deepEqual(directoryGlob.map((hit) => hit.path), ["src/a.ts", "src/line\nbreak.ts"]);

  const scopedGlob = await structuredFileSearch({ cwd, pathGlob: "*.ts", path: "src" });
  assert.deepEqual(scopedGlob.map((hit) => hit.path), ["src/a.ts", "src/line\nbreak.ts"]);
  await mkdir(join(cwd, "src", "sub"));
  await writeFile(join(cwd, "src", "sub", "nested.ts"), "");
  const scopedSlashGlob = await structuredFileSearch({ cwd, pathGlob: "sub/*.ts", path: "src" });
  assert.deepEqual(scopedSlashGlob.map((hit) => hit.path), ["src/sub/nested.ts"]);

  const exactPath = await structuredFileSearch({ cwd, pathGlob: "src/a.ts", path: "." });
  assert.deepEqual(exactPath.map((hit) => hit.path), ["src/a.ts"]);
});

test("structured searches honor nested gitignore outside a Git repository", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-structured-ignore-"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "src", "ignored.txt"), "needle\n");
  await writeFile(join(cwd, "src", "kept.txt"), "needle\n");

  const text = await structuredTextSearch({ cwd, query: "needle", path: "." });
  assert.deepEqual(text.map((hit) => hit.path), ["src/kept.txt"]);
  const files = await structuredFileSearch({ cwd, pathGlob: "src/*.txt", path: "." });
  assert.deepEqual(files.map((hit) => hit.path), ["src/kept.txt"]);
  const fuzzy = await structuredFuzzySearch({ cwd, query: "ignored", path: "." });
  assert.equal(fuzzy.hits.length, 0);
  assert.equal(fuzzy.gitMetadataAvailable, false);
});

test("structured fuzzy search preserves cancellation during Git metadata capture", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-structured-fuzzy-abort-"));
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await writeFile(join(cwd, "candidate.txt"), "x\n");
  await writeFile(join(bin, "git"), "#!/bin/sh\nsleep 30\n");
  await chmod(join(bin, "git"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const controller = new AbortController();
    const pending = structuredFuzzySearch({
      cwd,
      query: "candidate",
      path: ".",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 50);
    await assert.rejects(pending, /test cancellation|abort/i);
  } finally {
    process.env.PATH = previousPath;
  }
});
