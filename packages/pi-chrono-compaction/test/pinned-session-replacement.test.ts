import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  VERSION,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

test("installed Pi 0.85.1 reloads committed replacement and switch state without a provider call", async () => {
  assert.equal(VERSION, "0.85.1");
  const root = await mkdtemp(join(tmpdir(), "chrono-pinned-session-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), sessions = join(root, "sessions");
  await mkdir(cwd);
  const lifecycle: string[] = [];
  let preSetupBranch: { count: number; types: string[] } | undefined;
  let originalPath = "", replacementPath = "", switchTargetPath = "";
  let newCancelled: boolean | undefined;
  let recordSwitchLifecycle = false, switchManifestCommitted = false;
  const switchLifecycle: string[] = [];

  const extension: ExtensionFactory = pi => {
    pi.on("session_start", (event, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      if (event.reason === "new") preSetupBranch = { count: branch.length, types: branch.map(entry => entry.type) };
      const continuations = branch.filter(entry => entry.type === "custom_message").length;
      lifecycle.push(`session_start:${event.reason}:${continuations}`);
      if (recordSwitchLifecycle) switchLifecycle.push(`session_start:${event.reason}:committed=${switchManifestCommitted}`);
    });
    pi.on("session_shutdown", event => { lifecycle.push(`session_shutdown:${event.reason}`); });
    pi.registerCommand("replace-probe", { description: "test", handler: async (_args, ctx) => {
      originalPath = ctx.sessionManager.getSessionFile()!;
      const result = await ctx.newSession({ parentSession: originalPath,
        setup: async manager => {
          lifecycle.push("setup");
          manager.appendCustomMessageEntry("probe", "continuation", true);
        },
        withSession: async replacement => {
          replacementPath = replacement.sessionManager.getSessionFile()!;
          assert.notEqual(replacementPath, originalPath);
          assert.equal(replacement.sessionManager.getBranch().filter(entry => entry.type === "custom_message").length, 1);
          lifecycle.push("withSession:1");
          await replacement.reload();
          return;
        },
      });
      newCancelled = result.cancelled;
    } });
    pi.registerCommand("switch-probe", { description: "test", handler: async (args, ctx) => {
      const result = await ctx.switchSession(args, { withSession: async replacement => {
        assert.equal(replacement.sessionManager.getSessionFile(), args);
        switchManifestCommitted = true;
        await replacement.reload();
      } });
      assert.equal(result.cancelled, false);
    } });
  };

  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: runtimeCwd, agentDir: runtimeAgentDir,
      resourceLoaderOptions: { extensionFactories: [extension], noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true } });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" });
    const session = result.session;
    await session.bindExtensions({ mode: "print", commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: options => runtime!.newSession(options),
      fork: (entryId, options) => runtime!.fork(entryId, options),
      navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      switchSession: (path, options) => runtime!.switchSession(path, options),
      reload: () => session.reload(),
    } });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  try {
    runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir,
      sessionManager: SessionManager.create(cwd, sessions) });
    const replace = runtime.session.extensionRunner.getCommand("replace-probe");
    assert.ok(replace);
    await replace.handler("", runtime.session.extensionRunner.createCommandContext());
    assert.equal(newCancelled, false);
    assert.notEqual(replacementPath, originalPath);
    assert.deepEqual(preSetupBranch, { count: 1, types: ["thinking_level_change"] },
      "Pi 0.85.1 adds only its thinking bootstrap metadata before replacement setup");
    assert.deepEqual(lifecycle, [
      "session_start:startup:0",
      "session_shutdown:new",
      "session_start:new:0",
      "setup",
      "withSession:1",
      "session_shutdown:reload",
      "session_start:reload:1",
    ]);

    const target = SessionManager.create(cwd, sessions);
    target.appendSessionInfo("switch target");
    switchTargetPath = target.getSessionFile()!;
    const switchBack = runtime.session.extensionRunner.getCommand("switch-probe");
    assert.ok(switchBack);
    recordSwitchLifecycle = true;
    await switchBack.handler(switchTargetPath, runtime.session.extensionRunner.createCommandContext());
    assert.equal(runtime.session.sessionFile, switchTargetPath);
    assert.deepEqual(switchLifecycle, ["session_start:resume:committed=false", "session_start:reload:committed=true"],
      "Pi starts the switched runtime before withSession, then reload observes state committed by withSession");
  } finally {
    await runtime?.dispose();
  }
});
