import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

test("pinned Pi 0.84.2 replaces, rebinds, runs withSession, and switches back without a provider call", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrono-pinned-session-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), sessions = join(root, "sessions");
  let originalPath = "", replacementPath = "", switchTargetPath = "";
  let newCancelled: boolean | undefined;
  const extension: ExtensionFactory = pi => {
    pi.on("session_start", () => undefined);
    pi.registerCommand("replace-probe", { description: "test", handler: async (_args, ctx) => {
      originalPath = ctx.sessionManager.getSessionFile()!;
      const result = await ctx.newSession({ parentSession: originalPath,
        setup: async manager => { manager.appendCustomMessageEntry("probe", "continuation", true); },
        withSession: async replacement => {
          replacementPath = replacement.sessionManager.getSessionFile()!;
          assert.notEqual(replacementPath, originalPath);
          assert.equal(replacement.sessionManager.getBranch().filter(entry => entry.type === "custom_message").length, 1);
        },
      });
      newCancelled = result.cancelled;
    } });
    pi.registerCommand("switch-probe", { description: "test", handler: async (args, ctx) => {
      const result = await ctx.switchSession(args, { withSession: async replacement => {
        assert.equal(replacement.sessionManager.getSessionFile(), args);
      } });
      assert.equal(result.cancelled, false);
    } });
  };
  const settings = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, extensionFactories: [extension],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, sessions), noTools: "all" });
  const initial = session.sessionFile!;
  const replace = session.extensionRunner.getCommand("replace-probe");
  assert.ok(replace); await replace.handler("", session.extensionRunner.createCommandContext());
  assert.equal(newCancelled, false);
  assert.notEqual(replacementPath, initial);
  session.dispose();

  const target = SessionManager.create(cwd, sessions); target.appendSessionInfo("switch target"); switchTargetPath = target.getSessionFile()!;
  const secondManager = SessionManager.create(cwd, sessions);
  const secondLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, extensionFactories: [extension],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await secondLoader.reload();
  const second = (await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: secondLoader,
    sessionManager: secondManager, noTools: "all" })).session;
  const back = second.extensionRunner.getCommand("switch-probe");
  assert.ok(back); await back.handler(switchTargetPath, second.extensionRunner.createCommandContext());
  second.dispose();
});
