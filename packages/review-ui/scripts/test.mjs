import { readdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, ".test-dist");
await rm(outputRoot, { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.test.json"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [resolve(root, "scripts/prepare-test-peers.mjs"), resolve(outputRoot, "node_modules")], {
  cwd: root,
  stdio: "inherit",
});
const directory = resolve(outputRoot, "test");
const testFiles = (await readdir(directory))
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => resolve(directory, file));
const result = spawnSync(process.execPath, ["--test", ...testFiles], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
