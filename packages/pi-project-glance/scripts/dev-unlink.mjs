#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;
const pluginId = "pi.project-glance";
const execFileAsync = (file, args, options = {}) =>
  new Promise((resolveResult) => {
    execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      resolveResult({ ok: !error, stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "" });
    });
  });

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
function env() {
  return { ...process.env, HERDR_ENV: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
}
function settingsInfo() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    return { agentDir, settings: JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { agentDir, settings: {} };
    throw new Error("PI_SETTINGS_INVALID");
  }
}
function localPath(source, agentDir) {
  if (typeof source !== "string" || !(source.startsWith(".") || source.startsWith("/") || source.startsWith("~"))) return undefined;
  const expanded = source.startsWith("~") ? join(homedir(), source.slice(2)) : source;
  return resolve(agentDir, expanded);
}
async function piMatches() {
  const { agentDir, settings } = settingsInfo();
  const entries = Array.isArray(settings.packages) ? settings.packages : [];
  const root = await realpath(packageRoot);
  const matches = [];
  for (const item of entries) {
    const source = typeof item === "string" ? item : item?.source;
    const path = localPath(source, agentDir);
    if (!path) continue;
    try {
      const candidateRoot = await realpath(path);
      if (candidateRoot === root) matches.push(source);
      else {
        const metadata = JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8"));
        if (metadata.name === packageName) throw new Error("PROJECT_GLANCE_LINK_CONFLICT");
      }
    } catch (error) {
      if (error.message === "PROJECT_GLANCE_LINK_CONFLICT") throw error;
      // Ignore missing paths.
    }
  }
  return matches;
}
async function herdrPlugin() {
  const listed = await execFileAsync("herdr", ["plugin", "list", "--json"], { env: env() });
  if (!listed.ok) throw new Error("HERDR_LIST_FAILED");
  let plugins;
  try {
    plugins = JSON.parse(listed.stdout)?.result?.plugins;
  } catch {
    throw new Error("HERDR_LIST_FAILED");
  }
  if (!Array.isArray(plugins)) throw new Error("HERDR_LIST_FAILED");
  const matches = plugins.filter((item) => item?.plugin_id === pluginId);
  if (matches.length > 1) throw new Error("PROJECT_GLANCE_PLUGIN_CONFLICT");
  const plugin = matches[0];
  if (!plugin) return undefined;
  let rootMatches = false;
  try {
    rootMatches = (await realpath(plugin.plugin_root)) === (await realpath(packageRoot));
  } catch {
    rootMatches = false;
  }
  if (!rootMatches) throw new Error("PROJECT_GLANCE_PLUGIN_CONFLICT");
  return plugin;
}
async function run() {
  if (process.platform !== "linux") throw new Error("LINUX_REQUIRED");
  if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_CONTEXT_REQUIRED");
  // Preflight both owners before changing either registration.
  const matches = await piMatches();
  const plugin = await herdrPlugin();
  try {
    if (plugin) {
      const removed = await execFileAsync("herdr", ["plugin", "unlink", pluginId], { env: env() });
      if (!removed.ok) throw new Error("HERDR_UNLINK_FAILED");
    }
    // Remove the pane link first. If Pi refuses removal, restore exactly the
    // prior Herdr enabled state; Pi package filters have not been discarded.
    if (matches.length > 0) {
      const removed = await execFileAsync("pi", ["remove", packageRoot], { env: env() });
      if (!removed.ok) throw new Error("PI_UNLINK_FAILED");
    }
    if ((await piMatches()).length > 0 || (await herdrPlugin()) !== undefined) throw new Error("UNLINK_VERIFICATION_FAILED");
  } catch (error) {
    if (plugin) {
      // Recheck ownership before rollback; never overwrite a new owner's link.
      const current = await herdrPlugin();
      if (!current) {
        const restored = await execFileAsync("herdr", ["plugin", "link", packageRoot, ...(plugin.enabled === true ? ["--enabled"] : [])], { env: env() });
        if (!restored.ok) throw new Error("UNLINK_ROLLBACK_FAILED");
      }
    }
    throw error;
  }
  process.stdout.write("Project Glance links are absent.\n");
}
try {
  await run();
} catch (error) {
  const reason = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "UNKNOWN";
  fail(reason === "HERDR_CONTEXT_REQUIRED" ? "Run Project Glance unlinking from a Herdr-managed pane." : `Project Glance unlink failed: ${reason}. Check both registrations before retrying.`);
}
