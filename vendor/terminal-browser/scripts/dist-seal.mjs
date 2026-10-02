import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileHash, inventory, objectHash, readJson, sourceIdentity, validateBundle, validateManifest, writeJson } from "./dist-manifest.mjs";

const command = (bin, args, cwd) => execFileSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
export function validateClosure(meta) {
  for (const output of Object.values(meta.outputs)) {
    for (const entry of output.imports) {
      assert(entry.external && (builtins.has(entry.path) || entry.path === "electron" || entry.path === "../native/pixel.node"), `unclosed runtime import: ${entry.path}`);
    }
  }
}

function portableBuildMetadata(root, stage, entry, meta) {
  const relative = (base, file) => {
    const result = path.relative(base, file);
    assert(result && !result.startsWith("../") && !path.isAbsolute(result), "build metadata path escapes its source or artifact");
    return result;
  };
  const outputs = Object.fromEntries(Object.entries(meta.outputs).map(([file, value]) => [relative(stage, path.resolve(root, file)), value]));
  for (const file of Object.keys(meta.inputs)) relative(root, path.resolve(root, file));
  const mapFile = path.join(stage, `${entry}.map`);
  const map = readJson(mapFile);
  map.sources = map.sources.map((file) => relative(root, path.resolve(path.dirname(mapFile), file)));
  map.sourceRoot = "terminal-browser-source:///";
  writeJson(mapFile, map);
  return { ...meta, outputs };
}

function copyLicenses(directory, destination) {
  const names = fs.readdirSync(directory).filter((name) => /^(licen[sc]e|copying|notice|ofl)(?:[._-]|$)/i.test(name));
  fs.mkdirSync(destination, { recursive: true });
  for (const name of names) fs.cpSync(path.join(directory, name), path.join(destination, name), { recursive: true, dereference: true });
  return names;
}

function nodeLicenses(root, stage, metas) {
  const packages = new Map();
  const inputs = metas.flatMap((meta) => Object.keys(meta.inputs));
  inputs.push(command("node", ["-e", 'console.log(require.resolve("react-grab/dist/index.global.js",{paths:[process.argv[1]]}))', path.join(root, "browser")], root));
  for (const input of inputs) {
    let directory = path.dirname(fs.realpathSync(path.resolve(root, input)));
    while (directory !== path.dirname(directory)) {
      const file = path.join(directory, "package.json");
      if (fs.existsSync(file)) {
        const pkg = readJson(file);
        if (pkg.name && pkg.version) {
          packages.set(directory, pkg);
          break;
        }
      }
      directory = path.dirname(directory);
    }
  }
  const records = [];
  for (const [directory, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const id = `${pkg.name.replaceAll("/", "__")}@${pkg.version}`;
    const destination = path.join(stage, "licenses/node", id);
    const files = copyLicenses(directory, destination);
    const supplemental = path.join(root, "assets/licenses", id);
    if (fs.existsSync(supplemental)) files.push(...copyLicenses(supplemental, destination));
    assert(files.length || directory.startsWith(`${root}/`) && !directory.includes("/node_modules/"), `missing license files for ${id}`);
    records.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, files: files.map((file) => `node/${id}/${file}`) });
  }
  writeJson(path.join(stage, "licenses/node-packages.json"), records);
}

function rustLicenses(root, stage) {
  const records = new Map();
  for (const manifest of [path.join(root, "engine/Cargo.toml")]) {
    const metadata = JSON.parse(command("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest], root));
    for (const pkg of metadata.packages) {
      const id = `${pkg.name}@${pkg.version}`;
      if (records.has(id)) continue;
      const directory = path.dirname(pkg.manifest_path);
      const files = copyLicenses(directory, path.join(stage, "licenses/rust", id));
      if (pkg.license_file && !files.includes(pkg.license_file)) {
        const name = path.basename(pkg.license_file);
        fs.copyFileSync(path.resolve(directory, pkg.license_file), path.join(stage, "licenses/rust", id, name));
        files.push(name);
      }
      records.set(id, { name: pkg.name, version: pkg.version, source: pkg.source, license: pkg.license, files: files.map((file) => `rust/${id}/${file}`) });
    }
  }
  writeJson(path.join(stage, "licenses/rust-packages.json"), [...records.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)));
}

const [action, root, stage, sourceFile, requestedVersion, channel, platform] = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (action === "prepare") {
    const source = readJson(sourceFile);
    assert.match(requestedVersion, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.match(channel, /^[a-z][a-z0-9-]*$/);
    if (channel !== "dev") {
      assert.match(requestedVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
      assert.equal(source.dirty, false, "published releases require clean source");
    }
    assert.equal(platform, "linux-x64", "only Linux x64 standalone releases are verified");
    const native = fs.readFileSync(path.join(stage, "browser/native/pixel.node"));
    for (const directory of [root, stage, os.homedir(), process.env.CARGO_HOME].filter(Boolean)) {
      assert(!native.includes(Buffer.from(`${directory}/`)), "native module contains a private build path; check Rust and C/C++ path remapping");
    }
    const version = source.dirty ? `${requestedVersion}-dirty-${source.treeSha256.slice(0, 12)}` : requestedVersion;
    const pins = readJson(path.join(root, "upstreams.lock.json"));
    const browser = readJson(path.join(root, "browser/package.json"));
    const agentcursor = readJson(path.join(root, "browser/node_modules/agentcursor/package.json"));
    assert.equal(browser.devDependencies.electron, pins.electron.version);
    assert.equal(browser.dependencies.agentcursor, `git+https://github.com/kumard3/agentcursor.git#${pins.agentcursor.inspectedSha}`);
    assert(fs.realpathSync(path.join(root, "browser/node_modules/agentcursor")).includes(pins.agentcursor.inspectedSha), "installed AgentCursor is not the locked commit");
    const blocking = pins.blocking;
    assert.equal(blocking.engine.package, "@ghostery/adblocker");
    assert.equal(browser.dependencies[blocking.engine.package], blocking.engine.version);
    assert.equal(readJson(path.join(root, "browser/node_modules", blocking.engine.package, "package.json")).version, blocking.engine.version);
    assert.equal(blocking.list.file, "assets/blocking/easylist.txt");
    assert.equal(fileHash(path.join(stage, blocking.list.file)), blocking.list.sha256, "bundled EasyList differs from its source pin");
    const pi = readJson(path.join(stage, "pi-extension/package.json"));
    const herdr = fs.readFileSync(path.join(stage, "herdr-plugin/herdr-plugin.toml"), "utf8");
    const field = (name) => herdr.match(new RegExp(`^${name} = "([^"]+)"`, "m"))?.[1];
    const metas = [["cli", "cli/dist/main.js"], ["browser", "browser/dist/main.js"], ["runtime-check", "browser/dist/runtime-check.js"]].map(([name, entry]) => {
      const file = path.join(stage, `${entry}.meta.json`);
      const meta = readJson(file);
      validateClosure(meta);
      writeJson(path.join(stage, "metadata", `${name}-bundle.json`), portableBuildMetadata(root, stage, entry, meta));
      fs.unlinkSync(file);
      return meta;
    });
    nodeLicenses(root, stage, metas);
    rustLicenses(root, stage);
    const identity = {
      version, channel, platform, source,
      locks: { pnpm: fileHash(path.join(root, "pnpm-lock.yaml")), cargo: fileHash(path.join(root, "engine/Cargo.lock")), upstreams: fileHash(path.join(root, "upstreams.lock.json")) },
      runtimes: { electron: { version: pins.electron.version, archiveSha256: pins.electron.archives[platform] }, agentcursor: { commit: pins.agentcursor.inspectedSha, version: agentcursor.version } },
      tools: { node: process.version, pnpm: command("pnpm", ["--version"], root), rustc: command("rustc", ["--version"], root), esbuild: command(path.join(root, "node_modules/.bin/esbuild"), ["--version"], root), host: process.platform === "linux" ? fs.readFileSync("/etc/os-release", "utf8") : command("sw_vers", [], root) },
      integrations: { pi: { name: pi.name, version: pi.version, peerDependencies: pi.peerDependencies, node: pi.engines.node }, herdr: { id: field("id"), version: field("version"), minimumVersion: field("min_herdr_version") } },
    };
    fs.writeFileSync(path.join(stage, "VERSION"), `${version}\n`);
    fs.writeFileSync(path.join(stage, "CHANNEL"), `${channel}\n`);
    writeJson(path.join(stage, "metadata/identity.json"), identity);
    fs.writeFileSync(path.join(stage, "SOURCE.md"), `# Terminal Browser source\n\nProduct source: https://github.com/JCFrags/my-shtty-pi/tree/${source.commit}/vendor/terminal-browser\n\nUpstream Terminal Browser: https://github.com/zenbu-labs/terminal-browser\nBrowser-only copy origin: https://github.com/JCFrags/my-shtty-pi-web\n\nSee LICENSE, metadata/copy-provenance.json, metadata/upstreams.lock.json, and\nlicenses/ for source attribution, pinned revisions, and dependency notices.\nBundled request blocking uses @ghostery/adblocker and the pinned EasyList\nsnapshot. See licenses/notices/ for MPL 2.0, EasyList, and tldts notices.\nElectron includes its own LICENSE and LICENSES.chromium.html.\n\nVersion: ${version}. Source dirty: ${source.dirty}.\nOnly Linux x64 is a verified standalone release target. Pi and Herdr are optional\nhost integrations. Use this artifact's scripts/install.sh for schema 2 artifacts\nand optional-integration receipts. Older managers cannot install this format.\nInstallation and rollback never restart loaded processes.\n`);
  } else if (action === "seal") {
    assert.deepEqual(sourceIdentity(root), readJson(sourceFile), "source inputs changed during build; rebuild from the frozen tree");
    const identity = readJson(path.join(stage, "metadata/identity.json"));
    const files = inventory(stage);
    const manifest = validateManifest({ schemaVersion: 2, artifactId: objectHash({ identity, files }), identity, files });
    writeJson(path.join(stage, "build-manifest.json"), manifest);
    console.log(validateBundle(stage).artifactId);
  } else if (action === "archive") {
    const bundle = root;
    const archive = stage;
    const output = sourceFile;
    const manifest = validateBundle(bundle);
    writeJson(output, { schemaVersion: 1, version: manifest.identity.version, channel: manifest.identity.channel, platform: manifest.identity.platform, file: path.basename(archive), sha256: fileHash(archive), size: fs.statSync(archive).size, published: new Date().toISOString(), artifactId: manifest.artifactId, manifestSha256: fileHash(path.join(bundle, "build-manifest.json")) });
  } else throw new Error("usage: dist-seal.mjs prepare|seal|archive ...");
}
