#!/usr/bin/env node
// Controlled local build, or verification of its exact native output. No prebuild/download fallback.
// Header preparation is a separate explicit step. See ADR-002.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const sourceHash = "7c76d8e2733fd21d379c87a1e6d6f75eba49e30488944b62c8e68b19e3769d38";
const nativeHashes = new Map([
  ["115", "fbec82d69dbfacd218cc74282230dc7284c084877e94cac20cef2630738a7725"],
  ["127", "5f591c496eab00b6fd562e7929e93230804315ccac1bd87f922a3db842af1a35"],
  ["137", "baac38739b5e4c5137ea0514c451df58423c2e626f43cddcfb4542206f93d013"],
]);
const headerHashes = new Map([
  ["20.0.0", "5507c41f3ef9b3b9b442db2011df5cfbde00c13aa20362c238a60f3a799e6fac"],
  ["22.0.0", "acf42a40923151680e8fa664504b73a002fcad2386266363fd7e309d3002234d"],
  ["24.18.0", "3586827feee78d3d4ad791406d5f6d8a9021a8f495dfbeb38085423299742fdf"],
]);
const targetAbi = new Map([["20.0.0", "115"], ["22.0.0", "127"], ["24.18.0", "137"]]);
const hash = (bytes = Buffer.alloc(0)) => createHash("sha256").update(bytes).digest("hex");
const read = (path = "", maxBytes = 16 * 1024 * 1024) => {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) throw new Error("unsafe-build-input");
  return readFileSync(path);
};
const walk = (root = "") => {
  const paths = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error("unsafe-build-input");
      if (paths.length + pending.length > 4096) throw new Error("unsafe-build-input");
    }
  }
  return paths;
};
let temporary;
try {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("unverified-build-platform");
  const packagePath = require.resolve("better-sqlite3/package.json");
  const root = dirname(packagePath);
  if (JSON.parse(read(packagePath).toString()).version !== "12.9.0") throw new Error("native-package-version-mismatch");
  const definesPath = join(root, "deps/defines.gypi");
  const files = [packagePath, join(root, "binding.gyp"), join(root, "LICENSE"), ...walk(join(root, "lib")), ...walk(join(root, "src")), ...walk(join(root, "deps"))];
  const digest = createHash("sha256");
  for (const path of files.sort((a, b) => relative(root, a) < relative(root, b) ? -1 : relative(root, a) > relative(root, b) ? 1 : 0)) {
    const bytes = path === definesPath ? Buffer.from(read(path).toString().replace("SQLITE_DEFAULT_MEMSTATUS=1", "SQLITE_DEFAULT_MEMSTATUS=0")) : read(path);
    digest.update(relative(root, path)).update("\0").update(bytes).update("\0");
  }
  if (digest.digest("hex") !== sourceHash) throw new Error("native-source-mismatch");
  if (["--build-native", "--build-native-record"].includes(process.argv[2]) && process.argv.length === 6) {
    const recordBuild = process.argv[2] === "--build-native-record";
    const gyp = resolve(process.argv[3]); const headers = resolve(process.argv[4]); const target = process.argv[5];
    if (JSON.parse(read(join(dirname(dirname(gyp)), "package.json")).toString()).version !== "12.3.0") throw new Error("unverified-node-gyp");
    const versionHeader = read(join(headers, "include/node/node_version.h")).toString();
    const headerVersion = ["MAJOR", "MINOR", "PATCH"].map((part) => versionHeader.match(new RegExp(`#define NODE_${part}_VERSION\\s+(\\d+)`))?.[1]).join(".");
    if (headerVersion !== target) throw new Error("native-header-version-mismatch");
    const headerDigest = createHash("sha256");
    for (const path of walk(join(headers, "include/node")).sort()) headerDigest.update(relative(headers, path)).update("\0").update(read(path)).update("\0");
    const headersSha256 = headerDigest.digest("hex");
    if (headerHashes.get(target) !== headersSha256) throw new Error("native-header-version-mismatch");
    const defines = read(definesPath).toString();
    writeFileSync(definesPath, defines.replace("SQLITE_DEFAULT_MEMSTATUS=0", "SQLITE_DEFAULT_MEMSTATUS=1"));
    const env = { ...process.env, CC: "gcc", CXX: "g++", CFLAGS: "", CXXFLAGS: "", CPPFLAGS: "", LDFLAGS: "", npm_config_build_from_source: "true" };
    execFileSync(process.execPath, [gyp, "rebuild", "--release", "--jobs=1", `--nodedir=${headers}`, `--target=${target}`], { cwd: root, env, timeout: 240000, stdio: "inherit" });
    const nativeSha256 = hash(read(join(root, "build/Release/better_sqlite3.node")));
    if (!recordBuild && nativeHashes.get(targetAbi.get(target) ?? "") !== nativeSha256) throw new Error("unverified-native-binary");
    const provenance = { binding: "12.9.0", sourceSha256: sourceHash, definesSha256: hash(read(definesPath)),
      target, nodeGyp: "12.3.0", buildNode: process.versions.node,
      gcc: execFileSync("gcc", ["--version"], { encoding: "utf8", timeout: 5000 }).split("\n")[0],
      python: execFileSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 }).trim(),
      make: execFileSync("make", ["--version"], { encoding: "utf8", timeout: 5000 }).split("\n")[0],
      headersSha256, nativeSha256 };
    if (recordBuild) writeFileSync(join(root, "build/chrono-native-provenance.json"), JSON.stringify(provenance) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(provenance));
  } else if (["--probe", "--probe-record"].includes(process.argv[2]) && process.argv.length === 3) {
    const installedHash = hash(read(join(root, "build/Release/better_sqlite3.node")));
    if (process.argv[2] === "--probe-record") {
      const record = JSON.parse(read(join(root, "build/chrono-native-provenance.json"), 4096).toString());
      if (record.binding !== "12.9.0" || record.nodeGyp !== "12.3.0" || record.sourceSha256 !== sourceHash ||
        record.definesSha256 !== "27e5cb5ffe37d25185f3d48ea700c6294c20611c951135ede47686ace8d76045" ||
        headerHashes.get(record.target) !== record.headersSha256 || targetAbi.get(record.target) !== process.versions.modules ||
        record.nativeSha256 !== installedHash) throw new Error("unverified-native-binary");
    } else if (nativeHashes.get(process.versions.modules) !== installedHash) throw new Error("unverified-native-binary");
    const { CatalogSqlite } = await import("../dist/src/catalog-sqlite.js");
    temporary = mkdtempSync(join(tmpdir(), "chrono-sqlite-probe-")); chmodSync(temporary, 0o700);
    const db = CatalogSqlite.create(join(temporary, "synthetic.sqlite"));
    try {
      const capabilities = db.capabilities();
      // SQL can only lower this process-global limit. Probe process exits after this test.
      db.prepare("PRAGMA hard_heap_limit=1048576").get();
      let refused = false;
      try { db.prepare("SELECT length(randomblob(2097152)) AS n").get(); }
      catch (e) { refused = e instanceof Error && "code" in e && e.code === "catalog-sqlite-limit"; }
      if (!refused) throw new Error("native-heap-not-enforced");
      console.log(JSON.stringify({ node: process.versions.node, abi: process.versions.modules, binding: "12.9.0", nativeSha256: installedHash, provenanceMode: process.argv[2], capabilities, allocationRefused: true }));
    } finally { db.close(); }
  } else throw new Error("usage: --build-native[-record] <node-gyp.js> <headers-root> <target-version> | --probe[-record]");
} catch (e) {
  const known = /^(unsafe-build-input|unverified-build-platform|native-package-version-mismatch|native-source-mismatch|unverified-node-gyp|native-header-version-mismatch|unverified-native-binary|native-heap-not-enforced|usage:.*)$/;
  console.error(e instanceof Error && known.test(e.message) ? e.message : "catalog-sqlite-probe-failed"); process.exitCode = 1;
} finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
