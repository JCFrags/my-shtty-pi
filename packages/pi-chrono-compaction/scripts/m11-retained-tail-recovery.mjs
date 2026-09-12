#!/usr/bin/env node
// @ts-nocheck
// Explicit operator-gated recovery of synthetic M11 data. No ordinary resume fallback.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as F } from "node:fs";
import { lstat, open, readdir, realpath, statfs } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FULL, distribution, exerciseLane, faultCampaign, maximum, metrics, runtimeModules, sessionTargets } from "./m11-scale-campaign.mjs";

export const FROZEN = Object.freeze({
  sourcePreparationSha: "aa160c082dd9f027b0e378c53c2784e00ef1727e",
  runtimeSha: "09a8e9147095079668689546ae85146d787d8b68",
  packageTree: "c317f4851100b072ff84a5d78dd0a7fadc77131f", packageFiles: 427,
  packageVersion: "2.0.30", nodeVersion: "24.18.0",
  packageLockSha256: "36c55c89ec4541a28ddff1176f8f25fcd1783f153ce6eb5383935cf5d4eb1659",
  nativeSha256: "baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013",
});
export const RECOVERY_LIMITS = Object.freeze({
  sessions: 16, shards: 72, records: 3967, sourceBytes: 8 * 1024 ** 3,
  documentBytes: 8 * 1024 ** 2, suffixBytesPerSession: 16 * 1024,
  inventoryEntries: 600_000, inventoryDepth: 16, sqliteStatements: 4096, sqliteRowsPerQuery: 1024,
  validationWorkerCalls: 80, faultWorkerCalls: 3, matrixWorkerCalls: 504, leaseProbes: 39,
  appendedEvents: 84, doubleCompositions: 128, diskBytes: 48 * 1024 ** 3,
  wallMs: 2 * 60 * 60_000, parentMemoryBytes: 1024 ** 3,
});
const SELF = fileURLToPath(import.meta.url), PACKAGE = resolve(dirname(SELF), ".."), REPO = resolve(PACKAGE, "../..");
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(new Error(`m11-recovery-${code}`), { code: `m11-recovery-${code}` }); };
const check = (condition, code) => { if (!condition) fail(code); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
const command = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 ** 2,
  env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: process.env.HOME ?? "", XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` } }).trim();
const git = (cwd, ...args) => command("/usr/bin/git", ["-C", cwd, ...args]);
const namespaces = root => ["scheduler-prepare", "scheduler-faults", ...FULL.sessionCounts.flatMap(count => FULL.slots.map(slots => `scheduler-lane-${count}-${slots}`))].map(name => join(root, name));
const semantic = value => JSON.parse(JSON.stringify(value, (key, item) => ["metrics", "workerObservation"].includes(key) ? undefined : item));

export function parseRecoveryArgs(argv) {
  if (argv.length === 1 && ["plan", "--help"].includes(argv[0])) return { mode: "plan" };
  check(argv.length === 5 && argv[0] === "recover" && argv[1] === "--go" && argv[3] === "--go-sha256"
    && isAbsolute(argv[2]) && resolve(argv[2]) === argv[2] && HASH.test(argv[4]), "exact-go-required");
  return { mode: "recover", goPath: argv[2], goSha256: argv[4] };
}
export function validateGo(go) {
  check(go?.schemaVersion === 1 && go.kind === "chrono-m11-retained-tail-exact-go"
    && go.approveRetainedTail === true && go.naturalSettlement === true, "exact-go-required");
  check(go.sourcePreparationSha === FROZEN.sourcePreparationSha && go.statePreparationSha === FROZEN.runtimeSha
    && go.executionRuntimeSha === FROZEN.runtimeSha && COMMIT.test(go.currentMainSha) && COMMIT.test(go.harnessSha), "revision-binding");
  for (const key of ["campaignRoot", "runtimePackage", "failedReport", "output"]) check(isAbsolute(go[key] ?? "") && resolve(go[key]) === go[key] && go[key] !== "/", "route");
  check(!go.output.startsWith(`${go.campaignRoot}/`) && go.output !== go.campaignRoot && go.output !== go.failedReport, "output-route");
  check(basenameOf(go.campaignRoot) === FROZEN.sourcePreparationSha, "campaign-route");
  check(go.parent?.unit === `chrono-m11-resume-${FROZEN.runtimeSha.slice(0, 12)}.service`
    && /^[a-f0-9-]{36}$/.test(go.parent.bootId ?? "") && Array.isArray(go.parent.processes) && go.parent.processes.length === 2
    && new Set(go.parent.processes.map(item => item.pid)).size === 2
    && go.parent.processes.every(item => Number.isSafeInteger(item.pid) && item.pid > 1 && /^\d+$/.test(item.startTicks ?? "")), "parent-binding");
  check(go.recoveryUnit === `chrono-m11-retained-tail-${go.harnessSha.slice(0, 12)}.service`, "guard-unit");
  for (const key of ["manifest", "checkpoint", "failedReport", "harness", "sharedHarness", "dependencies", "node"]) check(HASH.test(go.hashes?.[key] ?? ""), "hash-binding");
  check(Array.isArray(go.sources) && go.sources.length === RECOVERY_LIMITS.shards, "source-bindings");
  const seen = new Set();
  for (const item of go.sources) {
    const key = `${item.session}:${item.ordinal}`;
    check(Number.isSafeInteger(item.session) && item.session >= 1 && item.session <= 16 && Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 && item.ordinal < 16
      && /^\d+$/.test(item.device ?? "") && /^\d+$/.test(item.inode ?? "") && HASH.test(item.prefixSha256 ?? "") && !seen.has(key), "source-bindings");
    seen.add(key);
  }
  return go;
}
const basenameOf = path => path.slice(path.lastIndexOf("/") + 1);
async function safeDirectory(path, privateLeaf = true) {
  check(isAbsolute(path) && resolve(path) === path && path !== "/", "directory-route");
  const parts = path.split("/").filter(Boolean); check(parts.length <= 64, "directory-depth");
  let current = "";
  for (const part of parts) {
    current += `/${part}`; const info = await lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink() && [0, process.getuid()].includes(info.uid)
      && (!(info.mode & 0o022) || info.uid === 0 && Boolean(info.mode & 0o1000)), "directory-unsafe");
  }
  const info = await lstat(path);
  check(info.uid === process.getuid() && (!privateLeaf || (info.mode & 0o7777) === 0o700) && await realpath(path) === path, "directory-unsafe");
}
async function regular(path, privateFile = true) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && (privateFile ? info.uid === process.getuid() : [0, process.getuid()].includes(info.uid)) && info.nlink === 1
    && (privateFile ? (info.mode & 0o7777) === 0o600 : !(info.mode & 0o022)), "file-unsafe");
  return info;
}
async function bytes(path, maximum, counters, privateFile = true) {
  const before = await regular(path, privateFile); check(before.size <= maximum, "file-bound");
  const handle = await open(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    check(sameFile(before, await handle.stat()), "file-changed");
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    check(offset === before.size && sameFile(before, await handle.stat()) && sameFile(before, await lstat(path)), "file-changed");
    if (counters) { counters.fileReads++; counters.fileBytes += offset; }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function jsonFile(path, digest, counters) {
  await safeDirectory(dirname(path)); const input = await bytes(path, RECOVERY_LIMITS.documentBytes, counters);
  check(sha(input) === digest, "document-hash"); return JSON.parse(input.toString("utf8"));
}
async function rangeHash(path, offset, length, counters) {
  check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0 && length <= RECOVERY_LIMITS.sourceBytes, "source-read-bound");
  const before = await regular(path); check(offset + length <= before.size, "source-truncated");
  const handle = await open(path, F.O_RDONLY | F.O_NOFOLLOW), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  try {
    check(sameFile(before, await handle.stat()), "source-changed"); let at = offset;
    while (at < offset + length) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, offset + length - at), at); check(bytesRead > 0, "source-truncated"); hash.update(buffer.subarray(0, bytesRead)); at += bytesRead; }
    check(sameFile(before, await handle.stat()) && sameFile(before, await lstat(path)), "source-changed");
    counters.fileReads++; counters.fileBytes += length; return hash.digest("hex");
  } finally { await handle.close(); }
}
export async function reserveOutput(path) {
  await safeDirectory(dirname(path)); return open(path, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
}
async function inventory(root, counters) {
  let entries = 0, size = 0;
  async function walk(path, depth) {
    check(depth <= RECOVERY_LIMITS.inventoryDepth, "inventory-depth");
    const names = await readdir(path); check(entries + names.length <= RECOVERY_LIMITS.inventoryEntries, "inventory-bound");
    for (const name of names) {
      const child = join(path, name), info = await lstat(child); check(++entries <= RECOVERY_LIMITS.inventoryEntries, "inventory-bound");
      check(info.uid === process.getuid() && !info.isSymbolicLink(), "inventory-owner");
      if (info.isDirectory()) { check((info.mode & 0o7777) === 0o700, "inventory-mode"); await walk(child, depth + 1); }
      else { check(info.isFile() && info.nlink === 1 && (info.mode & 0o7777) === 0o600, "inventory-file"); size += info.size; check(size <= RECOVERY_LIMITS.diskBytes, "disk-limit"); }
    }
  }
  await safeDirectory(root); await walk(root, 0); counters.inventoryEntries += entries;
  return { entries, bytes: size };
}
async function heldCampaignLock(root) {
  const path = join(dirname(root), ".campaign.lock"); await safeDirectory(dirname(path), false);
  const before = await regular(path, false), handle = await open(path, F.O_RDWR | F.O_NOFOLLOW);
  check(sameFile(before, await handle.stat()), "lock-changed");
  const child = spawn("/usr/bin/flock", ["--nonblock", "--no-fork", "/proc/self/fd/3", process.execPath, "-e", "process.stdout.write('held');process.stdin.resume()"],
    { stdio: ["pipe", "pipe", "ignore", handle.fd], env: { PATH: "/usr/bin:/bin" } });
  let ended = false; const closed = new Promise(resolveClosed => child.once("close", () => { ended = true; resolveClosed(); }));
  try {
    await new Promise((resolveHeld, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("m11-recovery-lock-timeout"), { code: "m11-recovery-lock-timeout" })), 5000);
      child.stdout.once("data", data => { clearTimeout(timer); data.toString() === "held" ? resolveHeld() : reject(new Error("lock")); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(Object.assign(new Error("m11-recovery-campaign-busy"), { code: "m11-recovery-campaign-busy" })); });
    });
    return { async check() { check(!ended && sameFile(before, await lstat(path)), "lock-lost"); }, async release() { child.stdin.end(); await closed; await handle.close(); } };
  } catch (error) { child.stdin.end(); child.kill(); await closed; await handle.close(); throw error; }
}
function unitProperties(unit, properties) {
  const text = command("/usr/bin/systemctl", ["--user", "show", unit, ...properties.map(key => `--property=${key}`)]);
  return Object.fromEntries(text.split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
}
async function settled(go, counters) {
  // procfs files are not ordinary owner files. Read these bounded kernel records directly.
  const kernel = async (path, maximum) => { const handle = await open(path, F.O_RDONLY | F.O_NOFOLLOW); try { const buffer = Buffer.alloc(maximum); const { bytesRead } = await handle.read(buffer, 0, maximum, 0); check(bytesRead < maximum, "kernel-bound"); return buffer.subarray(0, bytesRead).toString(); } finally { await handle.close(); } };
  const bootId = (await kernel("/proc/sys/kernel/random/boot_id", 128)).trim();
  check(bootId === go.parent.bootId, "settlement-boot");
  for (const owner of go.parent.processes) {
    let text; try { text = await kernel(`/proc/${owner.pid}/stat`, 8192); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (text) check(text.slice(text.lastIndexOf(")") + 2).split(/\s+/)[19] !== owner.startTicks, "parent-alive");
  }
  const directories = namespaces(go.campaignRoot), units = [go.parent.unit, ...directories.flatMap(directory => Array.from({ length: 4 }, (_, slot) => `chrono-runtime-${sha(directory).slice(0, 24)}-${slot}.service`))];
  for (const unit of units) {
    const data = unitProperties(unit, ["ActiveState", "MainPID", "ControlPID", "ControlGroup"]); counters.unitChecks++;
    check(["inactive", "failed"].includes(data.ActiveState) && data.MainPID === "0" && data.ControlPID === "0", "unit-unsettled");
    if (data.ControlGroup) {
      check(data.ControlGroup.startsWith("/user.slice/") && !data.ControlGroup.includes(".."), "cgroup-route");
      let events; try { events = await kernel(`/sys/fs/cgroup${data.ControlGroup}/cgroup.events`, 4096); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (events) check(/^populated 0$/m.test(events), "cgroup-populated");
    }
  }
  for (const directory of directories) {
    await safeDirectory(directory); const entries = await readdir(directory); check(entries.length <= 256, "namespace-bound");
    check(!entries.some(name => /^(ticket-|slot-)/.test(name)), "admission-residue");
  }
}
async function verifyGuards(go) {
  check(process.platform === "linux" && process.versions.node === FROZEN.nodeVersion && process.execArgv.length === 1
    && process.execArgv[0] === "--max-old-space-size=512" && !process.env.NODE_OPTIONS && !process.env.NODE_PATH
    && !process.env.NODE_BINDINGS_COMPILED_DIR, "node-guard");
  const data = unitProperties(go.recoveryUnit, ["ActiveState", "ControlGroup", "MemoryMax", "MemorySwapMax", "TasksMax", "RuntimeMaxUSec"]);
  check(data.ActiveState === "active" && data.MemoryMax === String(RECOVERY_LIMITS.parentMemoryBytes) && data.MemorySwapMax === "0" && data.TasksMax === "512", "resource-guard");
  // systemd renders RuntimeMaxUSec as a duration, not necessarily a numeric value.
  check(data.RuntimeMaxUSec === "2h", "wall-guard");
  const handle = await open("/proc/self/cgroup", "r"); let cgroup;
  try { const buffer = Buffer.alloc(8192); const result = await handle.read(buffer, 0, buffer.length, 0); check(result.bytesRead < buffer.length, "cgroup-bound"); cgroup = buffer.subarray(0, result.bytesRead).toString(); } finally { await handle.close(); }
  check(data.ControlGroup?.startsWith("/user.slice/") && !data.ControlGroup.includes("..") && cgroup.split("\n").includes(`0::${data.ControlGroup}`), "parent-containment");
  for (const [name, expected] of [["memory.max", String(RECOVERY_LIMITS.parentMemoryBytes)], ["memory.swap.max", "0"], ["pids.max", "512"]]) {
    const fd = await open(`/sys/fs/cgroup${data.ControlGroup}/${name}`, F.O_RDONLY | F.O_NOFOLLOW);
    try { const buffer = Buffer.alloc(128), result = await fd.read(buffer, 0, buffer.length, 0); check(result.bytesRead < buffer.length && buffer.subarray(0, result.bytesRead).toString().trim() === expected, "kernel-resource-guard"); }
    finally { await fd.close(); }
  }
}
async function verifyRuntime(go, counters) {
  await safeDirectory(go.runtimePackage, false);
  check(git(go.runtimePackage, "rev-parse", "HEAD") === FROZEN.runtimeSha, "runtime-head");
  check(git(go.runtimePackage, "rev-parse", `${FROZEN.runtimeSha}:packages/pi-chrono-compaction`) === FROZEN.packageTree, "runtime-tree");
  // Use the repository root for pathspecs even when the caller's cwd differs.
  const root = git(go.runtimePackage, "rev-parse", "--show-toplevel");
  const tracked = git(root, "ls-tree", "-r", FROZEN.runtimeSha, "--", "packages/pi-chrono-compaction").split("\n");
  check(tracked.length === FROZEN.packageFiles, "runtime-file-count");
  for (const record of tracked) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(packages\/pi-chrono-compaction\/.+)$/.exec(record); check(match, "runtime-file-mode");
    const input = await bytes(join(root, match[3]), 32 * 1024 ** 2, counters, false);
    check(createHash("sha1").update(`blob ${input.length}\0`).update(input).digest("hex") === match[2], "runtime-file-hash");
  }
  check(git(REPO, "rev-parse", "HEAD") === go.harnessSha && git(REPO, "rev-parse", "refs/remotes/origin/main") === go.currentMainSha, "harness-head");
  git(REPO, "merge-base", "--is-ancestor", go.currentMainSha, go.harnessSha);
  for (const [name, expected] of [[basenameOf(SELF), go.hashes.harness], ["m11-scale-campaign.mjs", go.hashes.sharedHarness]]) {
    const input = await bytes(join(PACKAGE, "scripts", name), 128 * 1024, counters, false);
    check(sha(input) === expected && createHash("sha1").update(`blob ${input.length}\0`).update(input).digest("hex") === git(REPO, "rev-parse", `${go.harnessSha}:packages/pi-chrono-compaction/scripts/${name}`), "harness-hash");
  }
  check(sha(await bytes(process.execPath, 256 * 1024 ** 2, counters, false)) === go.hashes.node, "node-hash");
  const require = createRequire(pathToFileURL(join(go.runtimePackage, "package.json")));
  const dependencies = [];
  async function collect(directory, depth = 0) {
    check(depth <= 4, "dependency-depth"); const names = (await readdir(directory)).sort(); check(names.length <= 64, "dependency-bound");
    for (const name of names) {
      const path = join(directory, name), info = await lstat(path); check(!info.isSymbolicLink(), "dependency-symlink");
      if (info.isDirectory()) await collect(path, depth + 1); else { check(name.endsWith(".js"), "dependency-kind"); dependencies.push(path); }
      check(dependencies.length <= 64, "dependency-bound");
    }
  }
  const nm = join(go.runtimePackage, "node_modules"); await safeDirectory(nm, false);
  await collect(join(nm, "better-sqlite3", "lib"));
  dependencies.push(...["better-sqlite3/package.json", "better-sqlite3/build/Release/better_sqlite3.node", "bindings/package.json", "bindings/bindings.js", "file-uri-to-path/package.json", "file-uri-to-path/index.js"].map(name => join(nm, name)));
  const hash = createHash("sha256");
  for (const path of dependencies.sort()) { await safeDirectory(dirname(path), false); const input = await bytes(path, 32 * 1024 ** 2, counters, false); hash.update(relative(nm, path)).update("\0").update(input).update("\0"); }
  check(hash.digest("hex") === go.hashes.dependencies, "dependency-hash");
  check(sha(await bytes(join(nm, "better-sqlite3/build/Release/better_sqlite3.node"), 32 * 1024 ** 2, counters, false)) === FROZEN.nativeSha256, "native-hash");
  const metadata = JSON.parse((await bytes(join(nm, "better-sqlite3/package.json"), 32768, counters, false)).toString());
  check(metadata.version === "12.9.0" && require.resolve("better-sqlite3") === join(nm, "better-sqlite3/lib/index.js"), "dependency-route");
  const sqliteRequire = createRequire(pathToFileURL(join(nm, "better-sqlite3/lib/database.js")));
  const bindingsRequire = createRequire(pathToFileURL(join(nm, "bindings/bindings.js")));
  check(sqliteRequire.resolve("bindings") === join(nm, "bindings/bindings.js") && bindingsRequire.resolve("file-uri-to-path") === join(nm, "file-uri-to-path/index.js"), "dependency-route");
  // Resolve without loading a candidate addon. Frozen workers must choose the verified release binding.
  check(require(join(nm, "bindings/bindings.js"))({ bindings: "better_sqlite3.node", module_root: join(nm, "better-sqlite3"), path: true })
    === join(nm, "better-sqlite3/build/Release/better_sqlite3.node"), "native-route");
  const modules = await runtimeModules(go.runtimePackage), segment = await import(pathToFileURL(join(go.runtimePackage, "dist/src/capsule-segment.js")));
  const schemas = {};
  for (const name of ["catalog-engine", "capsule-store", "search-v3-store", "episode-state-store"]) {
    const input = (await bytes(join(go.runtimePackage, `dist/src/${name}.js`), 512 * 1024, counters, false)).toString();
    const match = /const schema = \[([\s\S]*?)\n\];/.exec(input); check(match, "schema-source");
    schemas[name] = JSON.parse(`[${match[1].replace(/,\s*$/, "")}]`);
  }
  return { modules, Database: require("better-sqlite3"), segment, schemas };
}
export function matrixSuffix(session, rounds = 1) {
  check([1, 2].includes(rounds), "suffix-rounds"); const shard = session.shards.at(-1); let offset = shard.sourceBytes, text = "", events = 0;
  for (let round = 0; round < rounds; round++) for (const count of FULL.sessionCounts) for (const slots of FULL.slots) if (session.session <= count) {
    const value = { type: "message", id: `m11-s${session.session}-append-${count}-${slots}-${offset}`, parentId: session.leafId, timestamp: "2026-09-10T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: `m11 append session ${session.session}, lane ${count}x${slots}` }] } };
    const line = `${JSON.stringify(value)}\n`; text += line; offset += Buffer.byteLength(line); events++;
  }
  check(Buffer.byteLength(text) <= RECOVERY_LIMITS.suffixBytesPerSession, "suffix-bound"); return { bytes: Buffer.from(text), events };
}
export function validateCheckpoint(manifest, checkpoint, failure) {
  check(manifest.schemaVersion === 1 && manifest.candidateSha === FROZEN.sourcePreparationSha && manifest.profile === "full", "manifest-identity");
  check(checkpoint.schemaVersion === 1 && checkpoint.candidateSha === FROZEN.runtimeSha && checkpoint.preparedCandidateSha === FROZEN.sourcePreparationSha
    && checkpoint.reusedPreparedStores === true && checkpoint.states?.length === 16, "checkpoint-identity");
  check(failure.kind === "chrono-m11-scale-campaign" && failure.status === "failed" && failure.candidateSha === FROZEN.runtimeSha
    && failure.preparedCandidateSha === FROZEN.sourcePreparationSha && failure.failureCode === "m11-campaign-failed"
    && failure.failureMessage === "Maximum call stack size exceeded" && failure.retainedCampaignRoot === true, "natural-report-failure-required");
  const generated = manifest.generated; check(generated?.sessions?.length === 16 && generated.totals?.shards === 72
    && generated.totals.events + generated.totals.compactions === RECOVERY_LIMITS.records
    && generated.totals.decodedUnits === FULL.totalDecodedUnits && generated.totals.sourceBytes <= RECOVERY_LIMITS.sourceBytes, "manifest-scale");
  const targets = sessionTargets(FULL); let shards = 0, records = 0, sourceBytes = 0, appends = 0;
  for (const [index, session] of generated.sessions.entries()) {
    check(session.session === index + 1 && session.decodedUnits === targets[index] && Number.isSafeInteger(session.events) && session.events > 0
      && Number.isSafeInteger(session.compactions) && session.compactions >= 0 && session.shards.length >= 1 && session.shards.length <= 16, "session-shape");
    const state = checkpoint.states[index], cut = session.events + session.compactions;
    assert.deepEqual(state.session, session, "checkpoint-session"); check(state.sessionKey === sha(`m11-session-${session.session}`) && state.view.eventCut === cut && state.view.branchKey === "main", "pinned-cut");
    assert.deepEqual(state.selection.sourceView, state.view, "selection-view");
    check(state.selection.requestedCut === cut && state.selection.processedCut === cut && state.selection.processedMemoryCut === cut
      && state.selection.coverage?.bodyComplete === true && state.selection.coverage?.metadataComplete === true
      && Number.isSafeInteger(state.selection.stateGeneration) && state.selection.stateGeneration > 0, "selection-incomplete");
    check(state.verifiedShards === session.shards.length, "shard-evidence");
    for (const [ordinal, shard] of session.shards.entries()) check(shard.ordinal === ordinal && Number.isSafeInteger(shard.sourceBytes) && shard.sourceBytes > 0, "shard-shape");
    check(session.shards.reduce((sum, item) => sum + item.sourceBytes, 0) === session.sourceBytes, "source-total");
    shards += session.shards.length; records += cut; sourceBytes += session.sourceBytes; appends += matrixSuffix(session).events;
  }
  check(shards === 72 && records === RECOVERY_LIMITS.records && sourceBytes === generated.totals.sourceBytes && appends === 84, "manifest-totals");
  return checkpoint.states;
}
async function validateSources(go, states, counters, rounds) {
  for (const state of states) for (const shard of state.session.shards) {
    const path = join(go.campaignRoot, `session-${String(state.session.session).padStart(2, "0")}`, `shard-${String(shard.ordinal).padStart(4, "0")}.jsonl`);
    check(shard.path === path && state.session.sessionRoot === dirname(path), "source-route"); await safeDirectory(dirname(path));
    const info = await regular(path), binding = go.sources.find(item => item.session === state.session.session && item.ordinal === shard.ordinal);
    check(binding && String(info.dev) === binding.device && String(info.ino) === binding.inode, "source-identity");
    const suffix = shard === state.session.shards.at(-1) ? matrixSuffix(state.session, rounds).bytes : Buffer.alloc(0);
    check(info.size === shard.sourceBytes + suffix.length, "source-suffix-size");
    if (suffix.length) { const handle = await open(path, F.O_RDONLY | F.O_NOFOLLOW); try { const actual = Buffer.alloc(suffix.length); const result = await handle.read(actual, 0, actual.length, shard.sourceBytes); check(result.bytesRead === actual.length && actual.equals(suffix), "source-suffix"); counters.fileReads++; counters.fileBytes += actual.length; } finally { await handle.close(); } }
    check(await rangeHash(path, 0, shard.sourceBytes, counters) === binding.prefixSha256, "source-prefix");
  }
}
async function database(path, schema, runtime, counters, action) {
  await safeDirectory(dirname(path)); const before = await regular(path);
  check(before.size <= RECOVERY_LIMITS.diskBytes, "database-bound");
  const db = new runtime.Database(path, { readonly: true, fileMustExist: true }); counters.sqliteOpens++;
  try {
    const rows = (sql, values = [], limit = RECOVERY_LIMITS.sqliteRowsPerQuery) => {
      check(++counters.sqliteStatements <= RECOVERY_LIMITS.sqliteStatements, "sqlite-work-bound");
      const result = []; for (const row of db.prepare(sql).iterate(...values)) { check(result.length < limit, "sqlite-row-bound"); result.push(row); } return result;
    };
    const one = (sql, values) => { const result = rows(sql, values, 2); check(result.length === 1, "database-row-count"); return result[0]; };
    check(rows("SELECT name FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").length === 0, "database-extra-program");
    for (const sql of schema) { const parts = sql.split(" "), name = parts[1] === "VIRTUAL" ? parts[3] : parts[2]; check(one("SELECT sql FROM sqlite_master WHERE name=?", [name]).sql === sql, "database-schema"); }
    return await action({ rows, one });
  } finally { db.close(); check(sameFile(before, await lstat(path)), "readonly-database-changed"); }
}
async function validateStores(go, states, runtime, counters) {
  const canonical = runtime.segment.canonicalJson;
  for (const state of states) {
    const root = join(go.campaignRoot, "prepared", `session-${String(state.session.session).padStart(2, "0")}`), cut = state.view.eventCut;
    const expected = { catalogDirectory: join(root, "catalog"), derivedDirectory: join(root, "derived"), searchDirectory: join(root, "search") };
    assert.deepEqual(state.directories, expected, "store-routes");
    for (const directory of Object.values(expected)) await safeDirectory(directory);
    const active = JSON.parse((await bytes(join(expected.catalogDirectory, "active.json"), 4096, counters)).toString());
    check(active.v === 1 && active.sessionKey === state.sessionKey && active.storeKey === state.view.storeKey, "catalog-active");
    const stores = join(expected.catalogDirectory, "stores"); await safeDirectory(stores); const folders = await readdir(stores); check(folders.length === 1, "catalog-store-count");
    const folder = join(stores, folders[0]); await safeDirectory(folder); const files = (await readdir(folder)).filter(name => name.endsWith(".sqlite")); check(files.length === 1, "catalog-database-count");
    await database(join(folder, files[0]), runtime.schemas["catalog-engine"], runtime, counters, async db => {
      const meta = db.one("SELECT version,session,active,store FROM meta WHERE singleton=1");
      assert.deepEqual(meta, { version: 1, session: state.sessionKey, active: state.view.generation, store: active.storeKey });
      check(db.one("SELECT count(*) AS n FROM (SELECT 1 FROM events LIMIT 4097)").n === cut + matrixSuffix(state.session).events, "catalog-event-count");
      const original = db.one("SELECT id FROM events WHERE g=? AND seq=?", [state.view.generation, cut]); check(JSON.parse(original.id) === state.session.leafId, "catalog-original-leaf");
      const shards = db.rows("SELECT * FROM shards WHERE g=? ORDER BY ordinal LIMIT 73", [state.view.generation]); check(shards.length === state.session.shards.length, "catalog-shards");
      for (const [index, row] of shards.entries()) {
        const shard = state.session.shards[index], snapshot = JSON.parse(row.snapshot), info = await regular(shard.path);
        check(row.shard === `shard-${index}` && row.ordinal === index && row.branch === "main" && row.path === shard.path && row.caught === 1
          && row.observed === info.size && row.committed === info.size && snapshot.size === info.size
          && snapshot.identity.device === String(info.dev) && snapshot.identity.inode === String(info.ino), "catalog-source-binding");
        check(Array.isArray(snapshot.anchors) && snapshot.anchors.length >= 1 && snapshot.anchors.length <= 16, "anchor-bound");
        for (const anchor of snapshot.anchors) check(Number.isSafeInteger(anchor.length) && anchor.length > 0 && anchor.length <= 64 * 1024
          && await rangeHash(shard.path, anchor.offset, anchor.length, counters) === anchor.sha256, "source-anchor");
      }
    });
    await database(join(expected.derivedDirectory, "derived.sqlite"), runtime.schemas["capsule-store"], runtime, counters, db => {
      const meta = db.one("SELECT * FROM meta WHERE singleton=1"), head = db.one("SELECT * FROM heads LIMIT 2"), ready = db.one("SELECT * FROM readiness LIMIT 2"), cursor = JSON.parse(head.cursor);
      check(meta.version === runtime.modules.contract.DERIVED_SCHEMA_VERSION && meta.derivedRoute === expected.derivedDirectory && meta.catalogRoute === expected.catalogDirectory, "derived-meta");
      assert.deepEqual(JSON.parse(meta.identity), state.identity); assert.deepEqual(JSON.parse(head.view), state.view); assert.deepEqual(JSON.parse(ready.view), state.view);
      assert.deepEqual(cursor.identity, state.identity); assert.deepEqual(cursor.view, state.view); check(head.privateState === null && head.privateHash === null, "derived-active-cursor");
      check(state.identity.sessionKey === state.sessionKey && state.identity.catalogStoreKey === active.storeKey && state.identity.catalogGeneration === state.view.generation, "derived-identity");
      for (const [key, expectedCount] of Object.entries({ capsuleEligible: state.session.events * 2 + state.session.compactions, capsuleReady: cut,
        capsuleUnsupported: state.session.events, capsuleFailed: 0, chunkEligible: cut, chunkReady: cut, chunkFailed: 0, chunkExcluded: state.session.events })) check(ready[key] === expectedCount, "derived-readiness");
    });
    await database(join(expected.searchDirectory, "search.sqlite"), runtime.schemas["search-v3-store"], runtime, counters, db => {
      const meta = db.one("SELECT * FROM meta WHERE singleton=1"), head = db.one("SELECT * FROM heads LIMIT 2");
      check(meta.version === 1 && meta.searchRoute === expected.searchDirectory && meta.capsuleRoute === expected.derivedDirectory && meta.catalogRoute === expected.catalogDirectory, "search-meta");
      assert.deepEqual(JSON.parse(meta.identity), state.searchIdentity); assert.deepEqual(state.searchIdentity.capsule, state.identity); assert.deepEqual(JSON.parse(head.view), state.view);
      check(head.complete === 1 && head.active === null && head.afterEventSeq === cut && head.afterDescriptor === 0 && head.generation === cut && meta.generation === cut
        && head.cueReady === cut && head.rawReady === state.session.events && head.excluded === state.session.compactions, "search-readiness");
      for (const table of ["documents", "membership"]) check(db.one(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT 4097)`).n === cut, "search-count");
    });
    await database(join(expected.searchDirectory, "state-v4.sqlite"), runtime.schemas["episode-state-store"], runtime, counters, db => {
      const meta = db.one("SELECT * FROM meta WHERE singleton=1"), head = db.one("SELECT * FROM heads LIMIT 2");
      check(meta.version === runtime.modules.stateContract.EPISODE_STATE_SCHEMA_VERSION && meta.ruleset === runtime.modules.stateContract.EPISODE_STATE_RULESET_VERSION
        && meta.searchRoute === expected.searchDirectory && meta.capsuleRoute === expected.derivedDirectory && meta.catalogRoute === expected.catalogDirectory, "state-meta");
      assert.deepEqual(JSON.parse(meta.identity), state.searchIdentity); assert.deepEqual(JSON.parse(head.view), state.view);
      check(head.complete === 1 && head.metadataComplete === 1 && head.afterEventSeq === cut && head.afterDescriptor === 0 && head.metadataAfterEventSeq === cut
        && head.generation === meta.generation && db.rows("SELECT 1 FROM large_bodies LIMIT 1").length === 0, "state-incomplete");
      const generation = db.one("SELECT MAX(generation) AS n FROM cuts WHERE lineage=? AND eventSeq<=?", [head.lineage, cut]).n;
      check(generation === state.selection.stateGeneration && generation <= head.generation, "state-generation");
    });
  }
}
function measuredModules(modules, counters, phase, track) {
  const allowed = phase === "validation" ? { catalog: ["pin"], capsule: ["status"], search: ["status", "stateStatus", "composeStateSelection"] }
    : phase === "fault" ? { catalog: [], capsule: ["capsulePage"], search: ["status"] }
      : { catalog: ["ingestStep", "page", "raw"], capsule: ["chunkRange"], search: ["query", "recall"] };
  const limit = phase === "validation" ? RECOVERY_LIMITS.validationWorkerCalls : phase === "fault" ? 3 : 504;
  const result = { ...modules };
  for (const [kind, method] of [["catalog", "runCatalogWorker"], ["capsule", "runCapsuleWorker"], ["search", "runSearchV3Worker"]]) result[kind] = { ...modules[kind], [method](request, options) {
    return track((async () => {
      check(allowed[kind].includes(request.op) && ++counters.workerCalls <= limit, "worker-call-bound");
      const response = await modules[kind][method](request, options); counters.workerSourceBytes += response.sourceBytes ?? 0;
      if (request.op === "ingestStep") check(response.ok === true && response.result.caughtUp === true, "append-not-caught-up");
      return response;
    })());
  } };
  result.scheduler = { ...modules.scheduler, async acquireHostWorkerSlot(options) {
    check(phase === "matrix" && ++counters.leaseProbes <= 39, "lease-bound"); return modules.scheduler.acquireHostWorkerSlot(options);
  } };
  return result;
}
async function validateWorkerViews(root, states, modules) {
  const options = { schedulerDirectory: join(root, "scheduler-prepare"), slots: 4 };
  for (const state of states) {
    const common = { v: 1, catalogDirectory: state.directories.catalogDirectory, sessionKey: state.sessionKey };
    const pinned = await modules.catalog.runCatalogWorker({ ...common, op: "pin", branchKey: "main", leaf: { shardKey: `shard-${state.session.shards.length - 1}`, eventId: state.session.leafId } }, options);
    check(pinned.ok, "catalog-pin"); assert.deepEqual(pinned.result.view, state.view);
    const capsule = await modules.capsule.runCapsuleWorker({ v: 1, catalogDirectory: state.directories.catalogDirectory, derivedDirectory: state.directories.derivedDirectory, identity: state.identity, op: "status", view: state.view }, options); check(capsule.ok, "capsule-status");
    for (const op of ["status", "stateStatus", "composeStateSelection"]) {
      const response = await modules.search.runSearchV3Worker({ v: 1, catalogDirectory: state.directories.catalogDirectory, capsuleDirectory: state.directories.derivedDirectory,
        searchDirectory: state.directories.searchDirectory, identity: state.searchIdentity, view: state.view, op }, options);
      check(response.ok, "search-state-validation");
      if (op === "composeStateSelection") assert.deepEqual(semantic(response.result), semantic(state.selection), "stored-selection-changed");
    }
  }
}
const counters = () => ({ fileReads: 0, fileBytes: 0, inventoryEntries: 0, sqliteOpens: 0, sqliteStatements: 0, unitChecks: 0, workerCalls: 0, workerSourceBytes: 0, leaseProbes: 0 });
async function recover(args) {
  const validation = counters(), faultReads = counters(), matrix = counters(), fault = counters(), pending = new Set();
  const track = promise => { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const go = validateGo(await jsonFile(args.goPath, args.goSha256, validation));
  await verifyGuards(go); const lock = await heldCampaignLock(go.campaignRoot); let output, report, runtime, capsuleBackup;
  const started = performance.now();
  try {
    await settled(go, validation); await lock.check(); output = await reserveOutput(go.output);
    runtime = await verifyRuntime(go, validation);
    const manifestPath = join(go.campaignRoot, "campaign-manifest.json"), checkpointPath = join(go.campaignRoot, "prepared-state.json");
    const manifest = await jsonFile(manifestPath, go.hashes.manifest, validation), checkpoint = await jsonFile(checkpointPath, go.hashes.checkpoint, validation);
    const previous = await jsonFile(go.failedReport, go.hashes.failedReport, validation), states = validateCheckpoint(manifest, checkpoint, previous);
    const initialDisk = await inventory(go.campaignRoot, validation), fs = await statfs(go.campaignRoot);
    check(Number(fs.bavail) * Number(fs.bsize) >= 64 * 1024 ** 2, "disk-headroom");
    await validateSources(go, states, validation, 1); await validateStores(go, states, runtime, validation);
    await validateWorkerViews(go.campaignRoot, states, measuredModules(runtime.modules, validation, "validation", track));
    check(validation.workerCalls === 80, "validation-call-count"); await lock.check();
    const m = metrics(), tailStarted = performance.now();
    const faults = await faultCampaign(go.campaignRoot, states[0], measuredModules(runtime.modules, fault, "fault", track), m, {
      Database: runtime.Database,
      sourceHash: path => track((async () => rangeHash(path, 0, (await regular(path)).size, faultReads))()),
      async beforeCorruption(path, original, name) {
        faultReads.sqliteOpens++; faultReads.sqliteStatements++; faultReads.fileReads++; faultReads.fileBytes += original.length;
        check(original.length <= 1024 * 1024 && sha(original) === name, "capsule-integrity");
        const envelope = runtime.segment.decodeCapsuleSegment(original);
        check(envelope.source.sessionKey === states[0].sessionKey && envelope.source.catalogStoreKey === states[0].view.storeKey
          && envelope.source.catalogGeneration === states[0].view.generation && envelope.source.eventSeq >= 1
          && states[0].view.segments.some(item => item.segment === envelope.source.segment && item.cut >= envelope.source.eventSeq), "capsule-selection");
        const handle = await reserveOutput(`${go.output}.capsule-restore`);
        capsuleBackup = { path, hash: name, bytes: original.length, sidecarComplete: false };
        try { await handle.writeFile(original); await handle.sync(); capsuleBackup.sidecarComplete = true; } finally { await handle.close(); }
        await lock.check();
      },
    });
    check(fault.workerCalls === 3 && faults.corruptSegmentCode === "capsule-content-corrupt", "fault-count");
    const lanes = [], matrixModules = measuredModules(runtime.modules, matrix, "matrix", track);
    for (const count of FULL.sessionCounts) for (const slots of FULL.slots) { await lock.check(); lanes.push(await exerciseLane(go.campaignRoot, states, count, slots, matrixModules, m, { settleOnFailure: true })); }
    check(matrix.workerCalls === 504 && matrix.leaseProbes === 39, "matrix-count");
    const hashes = [], coverage = [];
    for (let ordinal = 1; ordinal <= 128; ordinal++) {
      const state = states[(ordinal - 1) % states.length], start = performance.now();
      const input = { regularPiSummary: `Deterministic Pi summary for session ${state.session.session}, generation ${ordinal}.`, combinedCeilingTokens: 30_000,
        cut: { sourceCutEntryId: state.session.leafId, sourceCutSeq: state.view.eventCut, firstKeptEntryId: `m11-tail-${state.session.session}-${ordinal}`, firstKeptSeq: state.view.eventCut + 1, rawTailTokens: 64, toolPairSafe: true } };
      const recoverSource = source => `opaque:m11:${state.session.session}:${source.eventSeq}:${source.descriptor}`;
      const one = runtime.modules.composer.composeStoredSelection(input, state.selection, recoverSource), two = runtime.modules.composer.composeStoredSelection(input, state.selection, recoverSource);
      check(one.envelope.payloadHash === two.envelope.payloadHash, "composition-nondeterministic"); hashes.push(one.envelope.payloadHash); coverage.push(one.envelope.validation); m.latencies.composition.push(performance.now() - start);
    }
    const tailWallMs = performance.now() - tailStarted;
    await validateSources(go, states, validation, 2);
    for (const [path, hash] of [[manifestPath, go.hashes.manifest], [checkpointPath, go.hashes.checkpoint], [go.failedReport, go.hashes.failedReport], [args.goPath, args.goSha256]]) await jsonFile(path, hash, validation);
    check(capsuleBackup && sha(await bytes(capsuleBackup.path, 1024 * 1024, validation)) === capsuleBackup.hash, "capsule-not-restored");
    const finalDisk = await inventory(go.campaignRoot, validation); await settled(go, validation); await lock.check();
    check(performance.now() - started <= RECOVERY_LIMITS.wallMs, "wall-limit");
    validation.wallMs = performance.now() - started - tailWallMs;
    report = { schemaVersion: 1, kind: "chrono-m11-retained-tail-recovery", status: "completed", qualificationStatus: "partial-frozen-runtime-tail-only",
      fullM11Acceptance: false, currentMainAcceptance: false, identities: { sourcePreparationSha: go.sourcePreparationSha, statePreparationSha: go.statePreparationSha,
        executionRuntimeSha: go.executionRuntimeSha, currentMainSha: go.currentMainSha, correctedHarnessSha: go.harnessSha, runtimePackageTree: FROZEN.packageTree,
        runtimeVersion: FROZEN.packageVersion, runtimePackageLockSha256: FROZEN.packageLockSha256, nodeVersion: process.versions.node, nativeSha256: FROZEN.nativeSha256, hashes: go.hashes, exactGoSha256: args.goSha256 },
      bounds: RECOVERY_LIMITS, validation, sourceIdentity: "Owner-supplied settled prefix hashes, original device/inode and catalog anchors verified. Prefixes and prior checkpoint/report bytes preserved.",
      initialPreparationMetrics: "unavailable: the original process did not persist its metric accumulator; no distribution was reconstructed",
      repeatedTail: { wallMs: tailWallMs, faults, faultCalls: fault, faultSourceReads: faultReads, matrixCalls: matrix, lanes, appendedEvents: 84, doubleCompositions: hashes.length,
        compositionHashes: hashes, coverage, requestWallMs: distribution(m.latencies.request), latencies: Object.fromEntries(Object.entries(m.latencies).map(([key, value]) => [key, distribution(value)])),
        sourceBytesByOperation: Object.fromEntries(Object.entries(m.sourceBytes).map(([key, value]) => [key, distribution(value)])),
        workerPeakRssBytes: maximum(m.workerPeaks.map(item => item.processPeakRssBytes ?? 0), 0),
        workerPeakCgroupBytes: maximum(m.workerPeaks.map(item => item.cgroupMemoryPeakBytes ?? 0), 0),
        processIoByOperation: Object.fromEntries(Object.entries(m.processIoByOperation).map(([kind, values]) => [kind, Object.fromEntries(Object.entries(values).map(([key, samples]) => [key, distribution(samples)]))])), failures: m.failures },
      disk: { initial: initialDisk, final: finalDisk, acceptanceOnly: true }, wallMs: performance.now() - started,
      limitations: ["This reuses frozen completed preparation and selections. It does not rerun state derivation or qualify changed current-main state semantics.",
        "Validation calls and source reads are separate from the repeated tail. Historical preparation timings, exact per-segment I/O and operator reboot evidence remain unavailable.",
        "The source-prefix hashes bind the settled input and its preservation. They do not reconstruct missing historical full-file hashes.",
        "External systemd wall/memory limits remain required. Disk is checked before and after, not continuously enforced. The exclusive capsule-restore sidecar remains available for interruption recovery."] };
  } catch (error) {
    await Promise.allSettled([...pending]);
    let settlementVerified = false;
    try { await settled(go, validation); settlementVerified = true; } catch { /* Retain the original failure code and disclose incomplete settlement. */ }
    report = { schemaVersion: 1, kind: "chrono-m11-retained-tail-recovery", status: "failed", qualificationStatus: "not-qualified",
      failureCode: /^m11-recovery-[a-z-]+$/.test(error?.code ?? "") ? error.code : "m11-recovery-validation-or-tail-failed", validation, faultReads, fault, matrix,
      sourcePreparationSha: go.sourcePreparationSha, statePreparationSha: go.statePreparationSha, executionRuntimeSha: go.executionRuntimeSha,
      currentMainSha: go.currentMainSha, correctedHarnessSha: go.harnessSha, exactGoSha256: args.goSha256,
      priorReportsAndCheckpointsNotOverwritten: true, settlementVerified, capsuleRestoration: "not-verified-after-failure",
      capsuleRestoreSidecarReserved: Boolean(capsuleBackup), capsuleRestoreSidecarComplete: Boolean(capsuleBackup?.sidecarComplete), wallMs: performance.now() - started };
  } finally {
    try { if (output) { await lock.check(); check(sameFile(await output.stat(), await regular(go.output)), "output-changed"); await output.writeFile(`${JSON.stringify(report)}\n`); await output.sync(); await output.close(); } }
    finally { await lock.release(); }
  }
  check(output, "output-not-reserved"); console.log(JSON.stringify({ status: report.status, qualificationStatus: report.qualificationStatus, wallMs: report.wallMs }));
  process.exitCode = report.status === "completed" ? 0 : 1;
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseRecoveryArgs(argv);
  if (args.mode === "plan") return console.log(JSON.stringify({ kind: "chrono-m11-retained-tail-plan", frozen: FROZEN, limits: RECOVERY_LIMITS,
    command: "recover --go <absolute-owner-only-exact-go.json> --go-sha256 <sha256>", executionEnabled: false,
    prerequisites: ["natural parent and worker settlement", "new explicit parent exact-go with settled hashes", "same existing campaign lock and namespaces", "2h systemd guard, 1GiB memory, no swap, 512 tasks, 512MiB V8 heap"],
    sourceReads: "Two full original-prefix passes, at most 16GiB, plus bounded anchors/suffixes. Fault phase separately hashes the largest session twice.",
    sqlite: "64 read-only database opens, at most 4096 statements with bounded returned rows. No state/capsule/search derivation or schema migration.",
    acceptance: "Frozen retained tail only. Not current-main or full M11 acceptance." }));
  await recover(args);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => { console.error(/^m11-recovery-[a-z-]+$/.test(error?.code ?? "") ? error.code : "m11-recovery-refused"); process.exitCode = 1; });
