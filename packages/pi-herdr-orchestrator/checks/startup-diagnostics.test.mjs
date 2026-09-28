import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ChildBindingError } from "../dist/src/orchestrator/child-binding.js";
import { HerdrCliError } from "../dist/src/orchestrator/herdr-cli.js";
import { RegistryError } from "../dist/src/orchestrator/store.js";
import { classifyValidationFailure, startupDiagnostic } from "../dist/src/orchestrator/child-tool.js";

test("startup role diagnostics remain fail-closed and private", { timeout: 30_000 }, async (t) => {
  const sdkRoot = process.env.ORCHESTRATOR_TEST_SDK_ROOT;
  const root = await mkdtemp(join(tmpdir(), "orch-startup-diagnostics-"));
  const sessions = new Set();
  // This disposable test process must never regain live Herdr or credentials.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"), PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1", PI_TELEMETRY: "0",
  });
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("FIXTURE_NETWORK_REFUSED"); };
  const sentinel = "/fixture-private/identity\nPRIVATE_STARTUP_DETAIL";
  const bounded = text => {
    assert(Buffer.byteLength(text, "utf8") <= 768);
    assert(!text.includes("fixture-private") && !text.includes("PRIVATE_STARTUP_DETAIL"));
  };
  for (const code of ["NOT_IN_HERDR", "CHILD_CONTEXT_INCOMPLETE", "CHILD_IDENTITY_MISMATCH",
    "CHILD_NATIVE_SESSION_UNAVAILABLE", "CHILD_NATIVE_SESSION_MISMATCH", "CHILD_BINDING_MISSING",
    "CHILD_BINDING_MALFORMED", "CHILD_BINDING_MISMATCH", "GENERATION_MISMATCH"])
    assert.equal(classifyValidationFailure(new ChildBindingError(code), "binding"), code);
  assert.equal(classifyValidationFailure(new ChildBindingError("__proto__"), "binding"), "CHILD_OPERATION_FAILED");
  assert.equal(classifyValidationFailure(new RegistryError("REGISTRY_MALFORMED"), "binding"), "REGISTRY_MALFORMED");
  assert.equal(classifyValidationFailure(new HerdrCliError(sentinel), "role"), "HERDR_COMMAND_FAILED");
  assert.equal(classifyValidationFailure(new HerdrCliError("HERDR_UNAVAILABLE"), "role"), "HERDR_UNAVAILABLE");
  assert.equal(classifyValidationFailure({ code: "HERDR_UNAVAILABLE", message: sentinel }, "role"), "ROLE_CHECK_FAILED");
  assert.equal(classifyValidationFailure(new Error(sentinel), "binding"), "CHILD_OPERATION_FAILED");
  assert.equal(startupDiagnostic(), undefined);
  const knownChild = startupDiagnostic(undefined, "CHILD_NATIVE_SESSION_UNAVAILABLE");
  assert.match(knownChild, /Managed-child context was detected/);
  assert.match(knownChild, /binding is unavailable/);
  assert(!knownChild.includes("Startup role resolution failed"));
  bounded(knownChild);
  const validatedLater = startupDiagnostic("HERDR_UNAVAILABLE");
  assert.match(validatedLater, /binding validated afterward/);
  assert(!validatedLater.includes("binding is unavailable"));
  bounded(validatedLater);

  const cwd = join(root, "cwd"), agentDir = process.env.PI_CODING_AGENT_DIR;
  const statePath = join(root, "herdr.json"), fakeHerdr = join(root, "herdr.mjs");
  const extensionPath = fileURLToPath(new URL("../dist/extensions/pi-herdr-orchestrator.js", import.meta.url));
  try {
    for (const dir of [cwd, agentDir, process.env.HOME, process.env.XDG_STATE_HOME,
      process.env.XDG_CONFIG_HOME, process.env.XDG_RUNTIME_DIR])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify({ fail: true, code: sentinel }), { mode: 0o600 });
    await writeFile(join(agentDir, "progressive-tools.json"), JSON.stringify({
      version: 1, summaries: { subagent_channel: "Fixture summary override." },
    }), { mode: 0o600 });
    await writeFile(fakeHerdr, `#!${process.execPath}
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.ORCHESTRATOR_FIXTURE_STATE, 'utf8'));
const a = process.argv.slice(2);
if (state.fail) { console.error(JSON.stringify({ code: state.code })); process.exit(1); }
const coords = { workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1' };
if (a[0] === 'pane' && a[1] === 'current') console.log(JSON.stringify({ result: { pane: coords } }));
else if (a[0] === 'agent' && a[1] === 'get' && a[2] === coords.pane_id)
  console.log(JSON.stringify({ result: { agent: { ...coords, name: 'fixture-parent', agent_status: 'idle' } } }));
else { console.error(JSON.stringify({ code: 'FIXTURE_COMMAND_REFUSED' })); process.exit(1); }
`, { mode: 0o700 });
    Object.assign(process.env, {
      HERDR_ENV: "1", HERDR_SOCKET_PATH: join(root, "unused.sock"), HERDR_BIN_PATH: fakeHerdr,
      HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1",
      ORCHESTRATOR_FIXTURE_STATE: statePath,
    });
    const sdk = await import(sdkRoot ? pathToFileURL(join(sdkRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent");
    const { isChildSession, CHILD_BINDING_ENTRY } = await import("../dist/src/orchestrator/child-binding.js");
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
    });
    const create = async label => {
      const settingsManager = sdk.SettingsManager.inMemory(), notifications = [], errors = [];
      const loader = new sdk.DefaultResourceLoader({
        cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [
          fileURLToPath(new URL("../../pi-progressive-tools/extensions/index.ts", import.meta.url)), extensionPath,
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      assert(loader.getExtensions().extensions.some(extension => extension.path === extensionPath));
      const sm = sdk.SessionManager.create(cwd, join(root, "sessions", label));
      const { session } = await sdk.createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, sessionManager: sm, noTools: "builtin",
      });
      sessions.add(session);
      await session.bindExtensions({ mode: "rpc",
        uiContext: { notify: (message, level) => notifications.push({ message, level }) },
        onError: error => errors.push(error),
      });
      return { session, sm, notifications, errors };
    };
    const tool = (session, name) => {
      const found = session.agent.state.tools.find(item => item.name === name);
      assert(found, `${name} must be executable`);
      return found;
    };
    const call = (session, name, params) => tool(session, name).execute("startup-fixture", params);
    const catalog = async session => (await call(session, "list_tools", {})).details.tools;
    const failed = await create("failed-startup");
    const before = await catalog(failed.session);
    assert(!before.some(item => item.name === "orchestrate"));
    assert.equal(before.find(item => item.name === "subagent_channel").summary, "Fixture summary override.");
    assert.equal(failed.session.extensionRunner.getCommand("agent-settings"), undefined);
    await assert.rejects(call(failed.session, "tool_help", { names: ["orchestrate"] }), /not registered/);
    assert.equal(failed.notifications.length, 1);
    const warning = failed.notifications[0].message;
    assert.equal(failed.notifications[0].level, "warning");
    assert.match(warning, /Startup role resolution failed \(HERDR_COMMAND_FAILED\)/);
    assert.match(warning, /CHILD_BINDING_MISSING/);
    assert.match(warning, /does not establish a managed child/);
    bounded(warning);
    const description = tool(failed.session, "subagent_channel").description;
    assert.match(description, /^Startup role resolution failed \(HERDR_COMMAND_FAILED\)/);
    bounded(description);
    const help = (await call(failed.session, "tool_help", { names: ["subagent_channel"] })).content
      .filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.match(help, /Fixture summary override/);
    assert.match(help, /Startup role resolution failed \(HERDR_COMMAND_FAILED\)/);
    assert.match(help, /never invent them/);
    bounded(help);
    const progress = { action: "progress", runId: "r-00000000-0000-4000-8000-000000000001",
      assignmentGeneration: 1, summary: "synthetic progress" };
    await assert.rejects(call(failed.session, "subagent_channel", { ...progress, assignmentGeneration: 0 }),
      error => error.code === "INVALID_REQUEST" && error.message === "INVALID_REQUEST");
    let refusal;
    await assert.rejects(call(failed.session, "subagent_channel", progress), error => {
      refusal = error.message;
      return error.code === "CHILD_BINDING_MISSING" && /^CHILD_BINDING_MISSING:/.test(refusal);
    });
    assert.match(refusal, /Startup role resolution failed \(HERDR_COMMAND_FAILED\)/);
    assert.match(refusal, /does not retry role selection/);
    bounded(refusal);
    assert.equal(failed.sm.getBranch().filter(entry => entry.customType === CHILD_BINDING_ENTRY).length, 0);
    assert.deepEqual(failed.errors, []);

    await writeFile(statePath, JSON.stringify({ fail: false }), { mode: 0o600 });
    assert.equal(await isChildSession({ sessionManager: failed.sm }), false);
    assert.deepEqual(await catalog(failed.session), before);
    await assert.rejects(call(failed.session, "subagent_channel", progress), error => error.code === "CHILD_BINDING_MISSING");
    const healthy = await create("healthy-startup");
    const after = await catalog(healthy.session);
    assert(after.some(item => item.name === "orchestrate"));
    assert(!after.some(item => item.name === "subagent_channel"));
    assert(healthy.session.extensionRunner.getCommand("agent-settings"));
    await call(healthy.session, "tool_help", { names: ["orchestrate"] });
    tool(healthy.session, "orchestrate");
    assert.deepEqual(healthy.notifications, []);
    assert.deepEqual(healthy.errors, []);
    assert.equal(networkAttempts, 0);
    const sdkVersion = sdkRoot ? JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")).version : "locked peer";
    t.diagnostic(JSON.stringify({ sdkVersion, warning, help, refusal, networkAttempts,
      identityRecoveryKeptChildOnly: true, healthyRootExecutable: true }));
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});
