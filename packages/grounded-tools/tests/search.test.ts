import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exactFind, exactGrep, fuzzyFiles } from "@grounded/pi-core/search";

test("search tools are exhaustive, paged, and keep fuzzy ranking explicit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-search-"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "alpha.ts"), "needle one\nneedle two\n");
  await writeFile(join(cwd, "src", "beta.ts"), "needle three\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
  await writeFile(join(cwd, "ignored.ts"), "needle ignored\n");
  await writeFile(join(cwd, "src", "ignored.ts"), "needle nested ignored\n");

  const first = await exactGrep({ cwd, pattern: "needle", path: ".", literal: true, limit: 2 });
  assert.equal(first.totalLines, 3);
  assert.equal(first.nextCursor, 2);
  assert.doesNotMatch(first.allOutput, /ignored/);
  const second = await exactGrep({ cwd, pattern: "needle", path: ".", literal: true, cursor: first.nextCursor, limit: 2 });
  assert.equal(second.output.split("\n").length, 1);

  const found = await exactFind({ cwd, pattern: "*.ts", path: "." });
  assert.match(found.output, /alpha\.ts/);
  assert.doesNotMatch(found.output, /ignored/);
  const scoped = await exactGrep({ cwd, pattern: "needle", path: "src", literal: true });
  assert.equal(scoped.totalLines, 3);
  assert.doesNotMatch(scoped.output, /ignored/);

  const fuzzy = await fuzzyFiles({ cwd, query: "alp", path: "." });
  assert.equal(fuzzy[0]?.path, "src/alpha.ts");
});
