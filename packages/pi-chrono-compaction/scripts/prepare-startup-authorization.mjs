#!/usr/bin/env node
// Prepare exact-root authorization only. Do not start workers or change admission.
import { createHash } from "node:crypto";
import { constants, lstatSync, openSync, readdirSync, realpathSync, closeSync, writeFileSync, fsyncSync, fstatSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const keys = ["hostWorkerSlots", "workerTimeoutSeconds", "workerNiceLevel", "isolatedWorkerEnabled"];
const workers = ["catalog-worker-entry.js", "capsule-worker-entry.js", "search-v3-worker-entry.js",
  "compaction-worker-entry.js", "history-worker-entry.js", "worker-runtime-bootstrap.js", "worker-runtime-bridge.js"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (value, code) => { if (!value) throw new Error(code); };
const uid = process.getuid?.();
function ancestors(path, privateLeaf = false) {
  need(isAbsolute(path) && resolve(path) === path, "noncanonical-path");
  let current = "/";
  for (const part of path.slice(1).split("/").filter(Boolean)) {
    current = join(current, part);
    const st = lstatSync(current);
    need(st.isDirectory() && !st.isSymbolicLink() && (st.uid === 0 || st.uid === uid), "unsafe-ancestor");
    need(!(st.mode & 0o022) || st.uid === 0 && !!(st.mode & 0o1000), "writable-ancestor");
  }
  need(realpathSync(path) === path, "noncanonical-path");
  if (privateLeaf) {
    const st = lstatSync(path);
    need(st.uid === uid && (st.mode & 0o777) === 0o700, "unsafe-output-directory");
  }
}
function bytes(path, maximum, privateMode = false) {
  ancestors(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    need(st.isFile() && st.uid === uid && st.nlink === 1 && !(st.mode & 0o022) && st.size <= maximum, "unsafe-file");
    if (privateMode) need((st.mode & 0o777) === 0o600, "unsafe-file");
    const value = Buffer.alloc(st.size + 1);
    let offset = 0;
    while (offset < value.length) {
      const count = readSync(fd, value, offset, value.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd);
    need(offset === st.size && after.size === st.size && after.ino === st.ino && after.mtimeMs === st.mtimeMs, "file-changed");
    return value.subarray(0, offset);
  } finally { closeSync(fd); }
}
function runtimeFiles(root) {
  const files = [], pending = [join(root, "dist/src")];
  while (pending.length) {
    const directory = pending.pop();
    ancestors(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      need(!entry.isSymbolicLink(), "unsafe-dist-entry");
      if (entry.isDirectory()) pending.push(path);
      else {
        need(entry.isFile(), "unsafe-dist-entry");
        if (entry.name.endsWith(".js")) files.push(relative(root, path));
      }
      need(files.length + pending.length <= 4096, "runtime-file-bound");
    }
  }
  return ["package.json", ...files].sort();
}
export { ancestors as verifyPreparationDirectory, bytes as readPreparationBytes };

/** Verify reviewed accepted bytes. This function does not install authorization or select code. */
export function prepareStartupAuthorization({ checkout, commit, configPath }) {
  need(process.platform === "linux" && Number.isInteger(uid) && uid !== 0, "linux-user-required");
  ancestors(checkout); ancestors(dirname(configPath));
  need(isAbsolute(configPath) && resolve(configPath) === configPath, "noncanonical-path");
  need(/^[a-f0-9]{40}$/.test(commit), "invalid-commit");
  const git = args => execFileSync("git", ["-C", checkout, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
  need(git(["rev-parse", "--show-toplevel"]).toString().trim() === checkout, "checkout-root-mismatch");
  need(git(["rev-parse", "HEAD"]).toString().trim() === commit, "checkout-commit-mismatch");
  const prefix = "packages/pi-chrono-compaction/", packagePath = resolve(checkout, prefix);
  need(!git(["status", "--porcelain", "--", prefix]).toString().trim(), "dirty-package");
  const expected = git(["ls-tree", "-r", "--name-only", commit, "--", prefix]).toString().trim().split("\n")
    .map(path => path.slice(prefix.length)).filter(path => path === "package.json" || /^dist\/src\/.*\.js$/.test(path)).sort();
  need(JSON.stringify(runtimeFiles(packagePath)) === JSON.stringify(expected), "runtime-inventory-mismatch");
  const files = {};
  for (const path of expected) {
    need(/^package\.json$|^dist\/src\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(path), "runtime-path-invalid");
    const accepted = git(["show", `${commit}:${prefix}${path}`]);
    need(bytes(join(packagePath, path), path === "package.json" ? 65536 : 2 * 1024 * 1024).equals(accepted), "runtime-bytes-mismatch");
    files[path] = sha(accepted);
  }
  const manifest = JSON.parse(bytes(join(packagePath, "package.json"), 65536));
  need(manifest.name === "pi-chrono-compact" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version), "package-identity-mismatch");
  need(workers.every(name => files[`dist/src/${name}`]), "worker-inventory-mismatch");
  const configBytes = bytes(configPath, 65536), config = JSON.parse(configBytes);
  const projection = Object.fromEntries(keys.map(key => [key, config[key]]));
  need(Number.isInteger(projection.hostWorkerSlots) && projection.hostWorkerSlots >= 1 && projection.hostWorkerSlots <= 4
    && Number.isInteger(projection.workerTimeoutSeconds) && projection.workerTimeoutSeconds >= 30 && projection.workerTimeoutSeconds <= 3600
    && Number.isInteger(projection.workerNiceLevel) && projection.workerNiceLevel >= 0 && projection.workerNiceLevel <= 19
    && projection.isolatedWorkerEnabled === true, "configured-policy-invalid");
  const authorization = {
    schemaVersion: 1, purpose: "chrono-trusted-fresh-boot-startup",
    package: { path: packagePath, name: manifest.name, version: manifest.version, sourceCommit: commit, files },
    configuration: { path: configPath, projectionKeys: keys, projectionSha256: sha(JSON.stringify(projection)) },
    policy: { schemaVersion: 2 }, workerProcessBasenames: workers,
  };
  need(bytes(configPath, 65536).equals(configBytes), "configuration-changed");
  return { authorization, configurationBytes: configBytes, runtimePins: expected.length,
    expectedAuthorizationPath: join(dirname(configPath), "chrono-deployments", sha(packagePath), "startup-authorization.json") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    need(args.length === 8, "usage: --checkout <root> --commit <sha> --config <file> --output <new-private-file>");
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      need(["--checkout", "--commit", "--config", "--output"].includes(key) && options[key] === undefined, "invalid-options");
      options[key] = args[index + 1];
    }
    const checkout = options["--checkout"], output = options["--output"];
    ancestors(dirname(output), true);
    need(isAbsolute(output) && resolve(output) === output, "noncanonical-path");
    need(!output.startsWith(checkout + "/"), "output-inside-checkout");
    const prepared = prepareStartupAuthorization({ checkout, commit: options["--commit"], configPath: options["--config"] });
    const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(prepared.authorization, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    console.log(JSON.stringify({ prepared: true, installed: false, startupInvoked: false,
      runtimePins: prepared.runtimePins, expectedAuthorizationPath: prepared.expectedAuthorizationPath }));
  } catch (error) {
    console.error(error?.code === "EEXIST" ? "output-exists" : error instanceof Error && /^(?:[a-z][a-z0-9-]+|usage:.*)$/.test(error.message) ? error.message : "authorization-preparation-refused");
    process.exitCode = 1;
  }
}
