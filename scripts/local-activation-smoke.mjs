#!/usr/bin/env node
// Clean indexed checkout and isolated real Herdr/Pi link lifecycle. No model calls.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "pi-local-lifecycle-"));
await chmod(sandbox, 0o700);
const checkout = join(sandbox, "checkout");
const configHome = join(sandbox, "config");
const name = "v1-lifecycle";
const socket = join(configHome, "herdr", "sessions", name, "herdr.sock");
const env = { ...process.env, HERDR_ENV: "1", HERDR_CONFIG_PATH: join(sandbox, "config.toml"),
  XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(sandbox, "data"),
  PI_CODING_AGENT_DIR: join(sandbox, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
for (const key of ["HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_SESSION_FILE", "PI_SESSION_ID"]) delete env[key];
let server;
let serverClosed;
const checks = [];
async function run(file, args, cwd = checkout, commandEnv = env) {
  // Keep diagnostics bounded and private; only check names are printed.
  try { return await exec(file, args, { cwd, env: commandEnv, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new Error(`Failed ${file} ${args.slice(0, 2).join(" ")}`); }
}
async function herdr(args) { return JSON.parse((await run("herdr", args)).stdout); }
try {
  await mkdir(checkout, { mode: 0o700 });
  await mkdir(env.PI_CODING_AGENT_DIR, { mode: 0o700 });
  await writeFile(env.HERDR_CONFIG_PATH, "onboarding = false\n", { mode: 0o600 });
  await writeFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), "{}\n", { mode: 0o600 });
  await run("git", ["checkout-index", "--all", `--prefix=${checkout}/`], root);
  const glance = join(checkout, "packages/pi-project-glance");
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], glance);
  await run("npm", ["run", "build"], glance);
  checks.push("clean indexed build");
  server = spawn("herdr", ["--session", name, "server"], { cwd: sandbox, env, stdio: "ignore" });
  serverClosed = once(server, "close");
  env.HERDR_SOCKET_PATH = socket;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { assert.deepEqual((await herdr(["plugin", "list", "--json"])).result.plugins, []); ready = true; break; }
    catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  assert(ready, "Isolated Herdr server did not start");
  const created = (await herdr(["workspace", "create", "--cwd", sandbox, "--label", "Disposable V1 lifecycle", "--no-focus"])).result;
  env.HERDR_PANE_ID = created.root_pane.pane_id;
  env.HERDR_TAB_ID = created.tab.tab_id;
  env.HERDR_WORKSPACE_ID = created.workspace.workspace_id;
  for (const step of ["dev:link", "dev:smoke", "dev:unlink", "dev:link", "dev:smoke", "dev:unlink"]) {
    await run("npm", ["run", step], glance);
    checks.push(step);
  }
  assert.deepEqual((await herdr(["plugin", "list", "--json"])).result.plugins, []);
  const settings = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
  assert.equal(settings.packages?.length ?? 0, 0);
  checks.push("disposable registrations absent");
  console.log(JSON.stringify({ status: "pass", checks, modelPromptSent: false, productionModified: false }, null, 2));
} finally {
  if (server && server.exitCode === null) {
    try { await run("herdr", ["server", "stop"], sandbox); }
    catch { server.kill("SIGTERM"); }
    await Promise.race([serverClosed, new Promise((done) => setTimeout(done, 5000))]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await serverClosed;
    }
  }
  await rm(sandbox, { recursive: true, force: true });
}
