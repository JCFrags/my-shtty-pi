import { historicalEvent } from "./historical-fixture.mjs";
import { canonicalJson } from "../dist/src/shared/canonical-json.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brokerRequest } from "../dist/src/cli/client.js";
import { sessionKey } from "../dist/src/shared/paths.js";

const run = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const methods = [
  "session.snapshot", "events.subscribe", "workspace.list", "workspace.get",
  "workspace.focus", "workspace.close", "tab.create", "tab.get", "tab.close",
  "pane.list", "pane.get", "pane.focus", "pane.close", "agent.list", "agent.get",
  "agent.start", "agent.focus", "worktree.list", "worktree.create", "worktree.open",
  "worktree.remove",
];

test("disposable packaged startup, auth, status, doctor and settings persistence", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-test-"));
  const socketPath = join(root, "herdr.sock");
  const server = createServer(socket => socket.destroy());
  let started = false;
  let env;
  const cli = async (...args) => {
    const result = await run(process.execPath, [join(packageRoot, "bin/pi-herdr-orchestrator"), ...args], {
      cwd: root, env, timeout: 25_000, maxBuffer: 256 * 1024,
    });
    return result.stdout.trim();
  };
  try {
    await chmod(root, 0o700);
    for (const dir of ["bin", "home", "state", "runtime", "config"])
      await mkdir(join(root, dir), { mode: 0o700 });
    await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const herdr = join(root, "bin/herdr");
    await writeFile(herdr, `#!${process.execPath}\nconst a=process.argv.slice(2).join(' ');\nif(a==='api schema --json') console.log(JSON.stringify({methods:${JSON.stringify(methods)}}));\nelse if(a==='api snapshot') console.log(JSON.stringify({id:'cli:api:snapshot',result:{type:'session_snapshot',workspaces:[],tabs:[],panes:[],agents:[],worktrees:[]}}));\nelse {console.error('Unexpected fake Herdr command');process.exitCode=2;}\n`, { mode: 0o700 });
    await writeFile(join(root, "bin/pi"), `#!${process.execPath}\nif(process.argv.includes('--help')) console.log('--thinking <level> off');\nelse if(process.argv.includes('--list-models')) console.log('provider model context max reasoning images\\nfixture synthetic 1000 100 no no');\nelse process.exitCode=2;\n`, { mode: 0o700 });
    const configPath = join(root, "config/broker.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }), { mode: 0o600 });
    // Deliberately do not spread process.env: no real socket, credentials or Pi configuration.
    env = {
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
      HERDR_ENV: "1", HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: socketPath,
      PI_HERDR_ORCH_RUNTIME_ROOT: join(root, "runtime"),
      PI_HERDR_ORCH_STATE_ROOT: join(root, "state"),
      PI_HERDR_ORCH_CONFIG_PATH: configPath,
    };
    const key = sessionKey(socketPath);
    const brokerSocket = join(root, "runtime", key, "broker.sock");
    assert.equal(JSON.parse(await cli("broker", "status")).status, "stopped");
    await mkdir(join(root, "state", key), { mode: 0o700 });
    await writeFile(join(root, "state", key, "events-v1.jsonl"), `${canonicalJson(historicalEvent())}\n`, { mode: 0o600 });
    started = true; // Ensure cleanup also runs if startup fails after spawning.
    await cli("broker", "startup");
    assert.equal(JSON.parse(await cli("broker", "status")).status, "running");
    assert.equal(JSON.parse(await cli("doctor", "--json")).ok, true);
    const secret = join(root, "runtime", key, "client.secret");
    const request = (method, params = {}) => brokerRequest(brokerSocket, secret, method, params, key, { timeoutMs: 10_000 });
    assert.equal((await request("system.status")).status, "healthy");
    const policy = await request("model.policy.get");
    assert.equal(typeof policy.policy, "object");
    assert.equal((await request("model.capabilities")).models[0].provider, "fixture");
    const saved = await request("model.operator.settings.set", {
      allowlist: null, endpoints: null,
      modelIntelligence: { schemaVersion: 1, routingMode: "current_default", mappings: [] },
    });
    assert.equal(saved.persisted, true);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).modelIntelligence.routingMode, "current_default");
    const wrongSecret = join(root, "wrong-secret");
    await writeFile(wrongSecret, "invalid-test-credential", { mode: 0o600 });
    await assert.rejects(brokerRequest(brokerSocket, wrongSecret, "model.policy.get", {}, key, { timeoutMs: 200 }), /failed|timed out|authentication/i);
    await cli("broker", "stop");
    started = false;
    assert.equal(JSON.parse(await cli("broker", "status")).status, "stopped");
  } finally {
    if (started) await cli("broker", "stop");
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
