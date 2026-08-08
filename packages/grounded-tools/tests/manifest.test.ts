import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function manifest(path: string) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("umbrella manifest loads every modular extension", async () => {
  const pkg = await manifest("../package.json");
  assert.deepEqual(pkg.pi.extensions, [
    "./packages/files/index.ts",
    "./packages/process/index.ts",
    "./packages/lsp/index.ts",
    "./packages/dialog/index.ts",
    "./packages/tasks/index.ts",
    "./packages/notes/index.ts",
    "./packages/workplan/index.ts",
  ]);
  assert.deepEqual(pkg.workspaces, ["packages/*"]);
  assert.equal(pkg.scripts.postinstall, undefined);
});

test("each feature is independently publishable and has no lifecycle scripts", async () => {
  const expected = new Map([
    ["core", undefined],
    ["files", "./index.ts"],
    ["process", "./index.ts"],
    ["lsp", "./index.ts"],
    ["dialog", "./index.ts"],
    ["tasks", "./index.ts"],
    ["notes", "./index.ts"],
    ["workplan", "./index.ts"],
  ]);
  for (const [directory, extension] of expected) {
    const pkg = await manifest(`../packages/${directory}/package.json`);
    assert.match(pkg.name, /^@grounded\/pi-/);
    assert.equal(pkg.scripts, undefined);
    if (extension) assert.deepEqual(pkg.pi.extensions, [extension]);
    else assert.equal(pkg.pi, undefined);
  }
});
