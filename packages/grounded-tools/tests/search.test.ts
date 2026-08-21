import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exactFind, exactGrep, fuzzyFiles } from "@grounded/pi-core/search";

test("search tools are exhaustive, paged, and keep fuzzy ranking explicit", async () => {
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

  const first = await exactGrep({ cwd, pattern: "needle", path: ".", literal: true, limit: 2 });
  assert.equal(first.totalLines, 5);
  assert.equal(first.nextCursor, 2);
  assert.match(first.allOutput, /\.hidden-note\.ts/);
  assert.match(first.allOutput, /\.hidden\/nested-note\.ts/);
  assert.doesNotMatch(first.allOutput, /\.git\/config/);
  assert.doesNotMatch(first.allOutput, /ignored/);
  const second = await exactGrep({ cwd, pattern: "needle", path: ".", literal: true, cursor: first.nextCursor, limit: 2 });
  assert.equal(second.output.split("\n").length, 2);

  const found = await exactFind({ cwd, pattern: "*.ts", path: "." });
  assert.match(found.output, /alpha\.ts/);
  assert.match(found.output, /\.hidden-note\.ts/);
  assert.match(found.output, /\.hidden\/nested-note\.ts/);
  assert.equal(found.output.split("\n").filter(line => line.endsWith(".hidden-note.ts")).length, 1);
  assert.doesNotMatch(found.output, /\.git/);
  assert.doesNotMatch(found.output, /ignored/);
  const scoped = await exactGrep({ cwd, pattern: "needle", path: "src", literal: true });
  assert.equal(scoped.totalLines, 3);
  assert.doesNotMatch(scoped.output, /ignored/);

  const fuzzy = await fuzzyFiles({ cwd, query: "alp", path: "." });
  assert.equal(fuzzy[0]?.path, "src/alpha.ts");
  const hiddenFuzzy = await fuzzyFiles({ cwd, query: "hiddennote", path: "." });
  assert.deepEqual(hiddenFuzzy.map(entry => entry.path), [".hidden-note.ts", ".hidden/nested-note.ts"]);
});
