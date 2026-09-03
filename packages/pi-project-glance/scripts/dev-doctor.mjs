#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const pluginId = "pi.project-glance";
const expectedPaneCommand = ["./bin/pi-project-glance", "glance"];
const legacyTuiAlias = ["@", "pi-herdr-", "deck/tui"].join("");
const execFileAsync = (file, args, options = {}) =>
  new Promise((resolveResult) => {
    execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      resolveResult({ ok: !error, stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "" });
    });
  });
const env = { ...process.env, HERDR_ENV: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  return match ? match.slice(1).map(Number) : undefined;
}

function nodeVersionSupported(manifest) {
  const range = manifest.engines?.node;
  const minimum = typeof range === "string" ? /^>=\s*(\d+)\.(\d+)\.(\d+)$/u.exec(range) : undefined;
  const actual = parseVersion(process.versions.node);
  if (!minimum || !actual) return false;
  const required = minimum.slice(1).map(Number);
  return actual[0] > required[0] ||
    (actual[0] === required[0] && (actual[1] > required[1] ||
      (actual[1] === required[1] && actual[2] >= required[2])));
}

function configuredLocalPath(source, agentDir) {
  if (typeof source !== "string" || !(source.startsWith(".") || source.startsWith("/") || source.startsWith("~"))) return undefined;
  const expanded = source.startsWith("~") ? join(homedir(), source.slice(2)) : source;
  return resolve(agentDir, expanded);
}

async function piLinkState() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  let settings;
  try {
    settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  } catch {
    return { present: false, rootMatches: false };
  }
  const entries = Array.isArray(settings.packages) ? settings.packages : [];
  let packageReal;
  try {
    packageReal = await realpath(packageRoot);
  } catch {
    return { present: false, rootMatches: false };
  }
  let present = false;
  let rootMatches = false;
  for (const item of entries) {
    const source = typeof item === "string" ? item : item?.source;
    const candidate = configuredLocalPath(source, agentDir);
    if (!candidate) continue;
    try {
      const candidateReal = await realpath(candidate);
      const metadata = JSON.parse(await readFile(join(candidateReal, "package.json"), "utf8"));
      if (metadata.name !== packageJson.name) continue;
      present = true;
      if (candidateReal === packageReal) rootMatches = true;
    } catch {
      // Missing or malformed local entries are not healthy Project Glance links.
    }
  }
  return { present, rootMatches };
}

async function pluginInfo() {
  const result = await execFileAsync("herdr", ["plugin", "list", "--json"], { env });
  if (!result.ok) return undefined;
  try {
    const plugins = JSON.parse(result.stdout)?.result?.plugins;
    return Array.isArray(plugins) ? plugins.find((item) => item?.plugin_id === pluginId) : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function modeIs(path, expected, kind) {
  try {
    const entry = await lstat(path);
    return (kind === "directory" ? entry.isDirectory() : kind === "socket" ? entry.isSocket() : entry.isFile()) &&
      !entry.isSymbolicLink() && (entry.mode & 0o7777) === expected;
  } catch {
    return false;
  }
}

async function launcherState(path) {
  try {
    const entry = await lstat(path);
    return {
      present: true,
      regular: entry.isFile(),
      executable: entry.isFile() && (entry.mode & 0o111) !== 0,
      notSymlink: !entry.isSymbolicLink(),
    };
  } catch {
    return { present: false, regular: false, executable: false, notSymlink: false };
  }
}

function initialChecks(manifest) {
  return {
    platformLinux: process.platform === "linux",
    nodeVersionSupported: nodeVersionSupported(manifest),
    packageIdentity: manifest.name === "pi-project-glance" && manifest.version === "0.1.0" && manifest.private === true && manifest.type === "module",
    canonicalTuiPeer: manifest.peerDependencies?.["@earendil-works/pi-tui"] === ">=0.84.2 <0.85.0",
    canonicalTuiDevelopmentDependency: manifest.devDependencies?.["@earendil-works/pi-tui"] === "0.84.2",
    legacyTuiAliasAbsent: !JSON.stringify({ dependencies: manifest.dependencies, devDependencies: manifest.devDependencies, peerDependencies: manifest.peerDependencies }).includes(legacyTuiAlias),
    piManifestEntrypoint: sameJson(manifest.pi?.extensions, ["./dist/pi/extension.js"]),
    piEntrypointBuilt: false,
    paneEntrypointBuilt: false,
    launcherRegularFile: false,
    launcherExecutable: false,
    launcherNotSymlink: false,
    piLinkPresent: false,
    piLinkRootMatches: false,
    herdrPluginPresent: false,
    herdrPluginRootMatches: false,
    herdrPluginEnabled: false,
    herdrPanePresent: false,
    herdrPaneCommandExact: false,
    relayHandshake: false,
    runtimeDirectoryMode: false,
    descriptorMode: false,
    socketMode: false,
    relaySnapshotBounded: false,
    disposableArtifactsRemoved: false,
  };
}

async function run() {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const checks = initialChecks(manifest);
  const piEntrypoint = join(packageRoot, "dist/pi/extension.js");
  const paneEntrypoint = join(packageRoot, "dist/pane/main.js");
  const launcher = join(packageRoot, "bin/pi-project-glance");
  checks.piEntrypointBuilt = await modeIs(piEntrypoint, 0o644, "file") || await fileIsBuilt(piEntrypoint);
  checks.paneEntrypointBuilt = await modeIs(paneEntrypoint, 0o644, "file") || await fileIsBuilt(paneEntrypoint);
  const launcherFacts = await launcherState(launcher);
  checks.launcherRegularFile = launcherFacts.regular;
  checks.launcherExecutable = launcherFacts.executable;
  checks.launcherNotSymlink = launcherFacts.notSymlink;

  if (checks.platformLinux && process.env.HERDR_ENV === "1") {
    const piList = await execFileAsync("pi", ["list"], { env });
    const piLinks = await piLinkState();
    checks.piLinkPresent = piList.ok && piLinks.present;
    checks.piLinkRootMatches = piList.ok && piLinks.rootMatches;

    const plugin = await pluginInfo();
    checks.herdrPluginPresent = plugin !== undefined;
    if (plugin) {
      try {
        checks.herdrPluginRootMatches = (await realpath(plugin.plugin_root)) === (await realpath(packageRoot));
      } catch {
        checks.herdrPluginRootMatches = false;
      }
      checks.herdrPluginEnabled = plugin.enabled === true;
      const panes = Array.isArray(plugin.panes) ? plugin.panes : [];
      const pane = panes.find((item) => item?.id === "glance");
      checks.herdrPanePresent = pane !== undefined;
      checks.herdrPaneCommandExact = sameJson(pane?.command, expectedPaneCommand);
    }

    let temporary;
    let fixture;
    let descriptorPath;
    let socketPath;
    let runtimeDirectory;
    try {
      const { startStaticFixtureRelay } = await import("../dist/fixture/runtime.js");
      const { probeProjectGlanceRelay } = await import("../dist/protocol/client.js");
      const { MAX_SNAPSHOT_BYTES } = await import("../dist/protocol/model.js");
      temporary = await mkdtemp(join(tmpdir(), "pi-project-glance-doctor-"));
      fixture = await startStaticFixtureRelay({ ...env, XDG_RUNTIME_DIR: temporary });
      ({ descriptorPath, socketPath } = fixture.paths);
      runtimeDirectory = fixture.paths.runtimeDirectory;
      checks.runtimeDirectoryMode = await modeIs(runtimeDirectory, 0o700, "directory");
      checks.descriptorMode = await modeIs(descriptorPath, 0o600, "file");
      checks.socketMode = await modeIs(socketPath, 0o600, "socket");
      const snapshot = await probeProjectGlanceRelay(descriptorPath);
      checks.relayHandshake = snapshot.sessionKey === fixture.sessionKey && snapshot.revision === 1;
      checks.relaySnapshotBounded = Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_SNAPSHOT_BYTES && snapshot.feed.length <= 50;
    } catch {
      // Failed checks remain false; cleanup is still attempted below.
    } finally {
      try {
        await fixture?.stop();
      } catch {
        // The final cleanup check reports any residue without exposing paths.
      }
      const knownArtifactsRemoved = !(await pathExists(descriptorPath)) && !(await pathExists(socketPath));
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } catch {
        // The final root-existence check reports cleanup failure.
      }
      checks.disposableArtifactsRemoved = knownArtifactsRemoved && temporary !== undefined && !(await pathExists(temporary)) && !(await pathExists(runtimeDirectory));
    }
  }

  const healthy = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({ product: "Pi Project Glance", package: packageJson.name, checks, healthy }, null, 2)}\n`);
  if (!healthy) process.exitCode = 1;
}

async function fileIsBuilt(path) {
  try {
    const entry = await lstat(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

try {
  await run();
} catch {
  process.stderr.write("Project Glance doctor failed safely.\n");
  process.exitCode = 1;
}
