import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/pi-extension.js";
import { sessionMigrationStatus } from "../src/session-migration.js";
import { writeSessionRollout } from "../src/session-rollout.js";

test("existing V3 sessions retain exclusions and refuse compaction before legacy reconstruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrono-migration-"));
  const previous = process.env.PI_CHRONO_CONFIG_PATH;
  try {
    for (const exclusion of ["config", "record", "unsafe"] as const) {
      const agent = join(root, exclusion);
      await mkdir(agent, { mode: 0o700 });
      process.env.PI_CHRONO_CONFIG_PATH = join(agent, "config.json");
      await writeFile(process.env.PI_CHRONO_CONFIG_PATH, JSON.stringify({ memoryEngineEnabled: true,
        incrementalPrecomputeEnabled: true, ...(exclusion === "config" ? { searchIndexEnabled: false } : {}) }));
      const sourcePath = join(agent, "session.jsonl"), sessionId = "existing-session";
      await writeFile(sourcePath, "", { mode: 0o600 });
      const rollout = join(agent, "chrono-session-rollouts");
      if (exclusion === "record") await writeSessionRollout(rollout, { sessionId, sourcePath }, false);
      if (exclusion === "unsafe") await mkdir(rollout, { mode: 0o755 });
      const hooks = new Map<string, (event: any, ctx: any) => any>();
      const tools = new Map<string, any>();
      const pi = { registerFlag() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
        on(name: string, hook: (event: any, ctx: any) => any) { hooks.set(name, hook); } };
      extension(pi as unknown as ExtensionAPI, { schedulerDirectory: join(root, "runtime") });
      const branch = [
        { id: "prefix", parentId: null, type: "message", message: { role: "user", content: "Keep the source." } },
        { id: "tail", parentId: "prefix", type: "message", message: { role: "assistant", content: [] } },
      ];
      const ctx = { hasUI: false, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sourcePath,
        getBranch: () => branch, getLeafId: () => "tail", getEntry() { throw new Error("historical reconstruction was entered"); } } };
      await hooks.get("session_start")!({ reason: "resume" }, ctx);
      const status = (await tools.get("history_status").execute("status", {}, undefined, undefined, ctx)).details;
      assert.equal(status.enabled, false, exclusion);
      assert.equal(status.migration.phase, "unavailable", exclusion);
      assert.equal(status.migration.composerEligibility, "requires-cut-validation");
      assert.equal(status.composition.mode, "v3");
      assert.deepEqual(await hooks.get("session_before_compact")!({ branchEntries: branch,
        preparation: { firstKeptEntryId: "tail", tokensBefore: 1000 }, signal: new AbortController().signal }, ctx), { cancel: true });
      await hooks.get("session_shutdown")!({}, ctx);
    }
    const ready = { catalog: "ready", capsules: "ready", index: "ready", memory: { state: "ready" }, rollup: { state: "ready" } };
    assert.equal(sessionMigrationStatus({ enabled: true, searchEnabled: true, unsafe: false, startup: "ready", progress: ready }).phase, "awaiting-cut-validation");
    assert.equal(sessionMigrationStatus({ enabled: true, searchEnabled: true, unsafe: false, startup: "ready", progress: { ...ready, memory: { state: "lagging" } } }).phase, "memory");
  } finally {
    if (previous === undefined) delete process.env.PI_CHRONO_CONFIG_PATH;
    else process.env.PI_CHRONO_CONFIG_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
