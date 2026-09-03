#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const pluginId = "pi.project-glance";
const execFileAsync = (file, args, options = {}) =>
  new Promise((resolveResult) => {
    execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      resolveResult({ ok: !error, stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "" });
    });
  });
const env = { ...process.env, HERDR_ENV: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };

function configuredPackage() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const entries = Array.isArray(settings.packages) ? settings.packages : [];
    return entries.some((item) => {
      const source = typeof item === "string" ? item : item?.source;
      if (typeof source !== "string") return false;
      const candidate = source.startsWith("~") ? join(homedir(), source.slice(2)) : source;
      const absolute = resolve(agentDir, candidate);
      try {
        return realpathSync(absolute) === realpathSync(packageRoot);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
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

async function run() {
  if (process.platform !== "linux") throw new Error("LINUX_REQUIRED");
  if (process.env.HERDR_ENV !== "1") throw new Error("HERDR_CONTEXT_REQUIRED");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const plugin = await pluginInfo();
  const pluginRootMatches = plugin
    ? await (async () => {
        try {
          const roots = await Promise.all([realpathSafe(plugin.plugin_root), realpathSafe(packageRoot)]);
          return roots[0] === roots[1];
        } catch {
          return false;
        }
      })()
    : false;
  const piList = await execFileAsync("pi", ["list"], { env });
  const expectedPane = plugin?.panes?.find((pane) => pane?.id === "glance");
  const checks = {
    package: manifest.name === "pi-project-glance" && manifest.version === "0.1.0" && manifest.private === true,
    piEntrypoint: await fileIsFile(join(packageRoot, "dist/pi/extension.js")),
    paneEntrypoint: await fileIsFile(join(packageRoot, "dist/pane/main.js")),
    piManifest: Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.includes("./dist/pi/extension.js"),
    piResolution: piList.ok && configuredPackage(),
    herdrPlugin: pluginRootMatches && plugin?.enabled === true,
    herdrEntrypoint: expectedPane?.id === "glance" && Array.isArray(expectedPane.command),
    relayProbe: false,
  };
  if (checks.piEntrypoint && checks.paneEntrypoint) {
    const { startStaticFixtureRelay } = await import("../dist/fixture/runtime.js");
    const { probeProjectGlanceRelay } = await import("../dist/protocol/client.js");
    const temporary = await mkdtemp(join(tmpdir(), "pi-project-glance-doctor-"));
    let fixture;
    try {
      fixture = await startStaticFixtureRelay({ ...env, XDG_RUNTIME_DIR: temporary });
      const snapshot = await probeProjectGlanceRelay(fixture.paths.descriptorPath);
      checks.relayProbe = snapshot.sessionKey === fixture.sessionKey && snapshot.feed.length === 2;
    } finally {
      await fixture?.stop();
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const healthy = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({ product: "Pi Project Glance", package: packageJson.name, checks, linked: { pi: checks.piResolution, herdr: checks.herdrPlugin }, healthy }, null, 2)}\n`);
  if (!healthy) process.exitCode = 1;
}
async function realpathSafe(path) {
  return await realpath(path);
}
async function fileIsFile(path) {
  try {
    await access(path);
    return (await stat(path)).isFile() && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
try {
  await run();
} catch (error) {
  process.stderr.write(error instanceof Error && error.message === "HERDR_CONTEXT_REQUIRED" ? "Run Project Glance doctor from a Herdr-managed pane.\n" : "Project Glance doctor failed safely.\n");
  process.exitCode = 1;
}
