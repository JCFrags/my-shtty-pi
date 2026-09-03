#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).name;
const pluginId = "pi.project-glance";
const commandLimit = 128 * 1024;

function runCommand(file, args, options = {}) {
  return new Promise((resolveResult) => {
    execFile(file, args, { ...options, encoding: "utf8", maxBuffer: commandLimit }, (error, stdout, stderr) => {
      resolveResult({ ok: !error, stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "" });
    });
  });
}
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
function env() {
  return { ...process.env, HERDR_ENV: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
}
async function loadSettingsInfo() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    return { agentDir, settings: JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) };
  } catch {
    return { agentDir, settings: {} };
  }
}
function configuredLocalPath(source, agentDir) {
  if (typeof source !== "string") return undefined;
  if (!(source.startsWith(".") || source.startsWith("/") || source.startsWith("~"))) return undefined;
  const expanded = source.startsWith("~") ? join(homedir(), source.slice(2)) : source;
  return resolve(agentDir, expanded);
}
async function packageEntries() {
  const { agentDir, settings } = await loadSettingsInfo();
  const entries = Array.isArray(settings.packages) ? settings.packages : [];
  const packageReal = await realpath(packageRoot);
  const matches = [];
  for (const item of entries) {
    const source = typeof item === "string" ? item : item?.source;
    const path = configuredLocalPath(source, agentDir);
    if (!path) continue;
    try {
      if ((await realpath(path)) === packageReal) matches.push(source);
    } catch {
      // A missing configured path is not this link.
    }
  }
  return { agentDir, matches, entries };
}
async function listHerdr() {
  const result = await runCommand("herdr", ["plugin", "list", "--json"], { env: env() });
  if (!result.ok) throw new Error("HERDR_LIST_FAILED");
  try {
    const plugins = JSON.parse(result.stdout)?.result?.plugins;
    if (!Array.isArray(plugins)) throw new Error("HERDR_LIST_FAILED");
    return plugins;
  } catch {
    throw new Error("HERDR_LIST_FAILED");
  }
}
async function herdrLinkState() {
  const plugins = await listHerdr();
  const plugin = plugins.find((item) => item?.plugin_id === pluginId);
  if (!plugin) return { plugin: undefined, rootMatches: false };
  let rootMatches = false;
  if (typeof plugin.plugin_root === "string") {
    try {
      rootMatches = (await realpath(plugin.plugin_root)) === (await realpath(packageRoot));
    } catch {
      rootMatches = false;
    }
  }
  return { plugin, rootMatches };
}

async function run() {
  if (process.platform !== "linux") throw new Error("LINUX_REQUIRED");
  if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_CONTEXT_REQUIRED");
  await access(join(packageRoot, "bin", "pi-project-glance"));
  const build = await runCommand("npm", ["run", "build"], { cwd: packageRoot, env: env() });
  if (!build.ok) throw new Error("BUILD_FAILED");

  const piBefore = await packageEntries();
  const packageReal = await realpath(packageRoot);
  const existingByName = [];
  for (const item of piBefore.entries) {
    const source = typeof item === "string" ? item : item?.source;
    const path = configuredLocalPath(source, piBefore.agentDir);
    if (!path) continue;
    try {
      const metadata = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
      if (metadata.name === packageName && (await realpath(path)) !== packageReal) existingByName.push(source);
    } catch {
      // Ignore unrelated or missing package entries.
    }
  }
  if (existingByName.length > 0) throw new Error("PROJECT_GLANCE_LINK_CONFLICT");
  const piAdded = piBefore.matches.length === 0;
  if (piAdded) {
    const installed = await runCommand("pi", ["install", packageRoot], { env: env() });
    if (!installed.ok) throw new Error("PI_LINK_FAILED");
  }

  try {
    const beforeHerdr = await herdrLinkState();
    if (beforeHerdr.plugin && !beforeHerdr.rootMatches) throw new Error("PROJECT_GLANCE_PLUGIN_CONFLICT");
    if (!beforeHerdr.plugin) {
      const linked = await runCommand("herdr", ["plugin", "link", packageRoot, "--enabled"], { env: env() });
      if (!linked.ok) throw new Error("HERDR_LINK_FAILED");
    } else if (beforeHerdr.plugin.enabled !== true) {
      const enabled = await runCommand("herdr", ["plugin", "enable", pluginId], { env: env() });
      if (!enabled.ok) throw new Error("HERDR_ENABLE_FAILED");
    }
  } catch (error) {
    if (piAdded) await runCommand("pi", ["remove", packageRoot], { env: env() });
    throw error;
  }

  const afterPi = await packageEntries();
  const afterHerdr = await herdrLinkState();
  if (afterPi.matches.length !== 1 || !afterHerdr.rootMatches || afterHerdr.plugin?.enabled !== true) {
    throw new Error("LINK_VERIFICATION_FAILED");
  }
  process.stdout.write("BUILD + LINK COMPLETE\n");
  process.stdout.write("Project Glance links are healthy.\n");
  process.stdout.write("PROJECT_GLANCE_RELOAD_REQUIRED: run /reload in each already-running Pi session, then /project-glance.\n");
}

try {
  await run();
} catch (error) {
  if (error instanceof Error && error.message === "HERDR_CONTEXT_REQUIRED") {
    fail("Run Project Glance linking from a Herdr-managed pane.");
  } else {
    const reason = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "UNKNOWN";
    fail(`Project Glance link failed safely: ${reason}.`);
  }
}
