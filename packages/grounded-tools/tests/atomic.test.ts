import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteText } from "@grounded/pi-core/atomic";

test("atomicWriteText preserves permissions and updates symlink targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grounded-atomic-"));
  const target = join(dir, "target.txt");
  const alias = join(dir, "alias.txt");
  await writeFile(target, "old", { mode: 0o640 });
  await symlink("target.txt", alias);
  const result = await atomicWriteText(alias, "new");
  assert.equal(result.atomic, true);
  assert.equal(await readFile(alias, "utf8"), "new");
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});

test("atomicWriteText follows a broken symlink instead of replacing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grounded-broken-link-"));
  const target = join(dir, "new-target.txt");
  const alias = join(dir, "alias.txt");
  await symlink("new-target.txt", alias);
  await atomicWriteText(alias, "created");
  assert.equal(await readFile(target, "utf8"), "created");
  assert.equal(await readFile(alias, "utf8"), "created");
});

test("atomicWriteText preserves hard links by writing in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grounded-hardlink-"));
  const first = join(dir, "first.txt");
  const second = join(dir, "second.txt");
  await writeFile(first, "old");
  await link(first, second);
  const result = await atomicWriteText(first, "new");
  assert.equal(result.atomic, false);
  assert.equal(result.preservedHardLinks, true);
  assert.equal(await readFile(second, "utf8"), "new");
});
