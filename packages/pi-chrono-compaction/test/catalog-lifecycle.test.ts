import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/pi-extension.js";
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
for (const enabled of [false, true]) test(`catalog lifecycle ${enabled ? "opt-in" : "default-off"} is nonblocking and isolated`, async () => {
  const root = mkdtempSync(join(tmpdir(), "chrono-catalog-lifecycle-"));
  const keys = ["PI_CHRONO_CONFIG_PATH", "PI_CHRONO_CATALOG_SHADOW", "PI_CHRONO_SEARCH_INDEX", "PI_CHRONO_INCREMENTAL_PRECOMPUTE", "PI_CHRONO_ROLLUP_SHADOW"];
  const previous = keys.map(key => process.env[key]);
  const hooks = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const source = join(root, "synthetic.jsonl");
  const original = JSON.stringify({ type: "session", version: 3, id: "synthetic", cwd: "/synthetic" }) + "\n" + JSON.stringify({ type: "message", id: "one", parentId: null, message: { role: "user", content: "Synthetic lifecycle only." } }) + "\n";
  writeFileSync(source, original, { mode: 0o600 });
  let status = "";
  let completed = false;
  const context = { hasUI: true, getContextUsage: () => undefined, isIdle: () => true,
    sessionManager: { getSessionFile: () => source, getSessionId: () => "synthetic", getEntries: () => { throw new Error("unexpected-whole-session-read"); }, getBranch: () => { throw new Error("unexpected-whole-branch-read"); } },
    ui: { notify: (message: string) => { status = message; } },
  };
  async function waitReady() {
    const deadline = Date.now() + 10_000;
    do {
      await commands.get("chrono-catalog-status")!.handler("", context);
      if (status.includes("shadow: ready.")) return;
      assert.ok(!status.includes("Safe refusal"), status);
      await pause();
    } while (Date.now() < deadline);
    assert.fail(`catalog lifecycle readiness timed out: ${status}`);
  }
  try {
    process.env.PI_CHRONO_CONFIG_PATH = join(root, "config.json");
    if (enabled) process.env.PI_CHRONO_CATALOG_SHADOW = "true"; else delete process.env.PI_CHRONO_CATALOG_SHADOW;
    process.env.PI_CHRONO_SEARCH_INDEX = "false";
    process.env.PI_CHRONO_INCREMENTAL_PRECOMPUTE = "false";
    process.env.PI_CHRONO_ROLLUP_SHADOW = "false";
    extension({ registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); }, on(name: string, hook: any) { assert.ok(!hooks.has(name)); hooks.set(name, hook); }, appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI, { schedulerDirectory: join(root, "scheduler") });
    await hooks.get("session_start")!({}, context);
    assert.equal(existsSync(join(root, ".chrono-catalog")), false, "scheduling stack does no catalog filesystem work");
    if (enabled) {
      await waitReady();
      const append = JSON.stringify({ type: "message", id: "two", parentId: "one", message: { role: "assistant", content: [{ type: "text", text: "Synthetic append." }] } }) + "\n";
      appendFileSync(source, append);
      hooks.get("agent_settled")!({}, context); await waitReady();
      assert.equal(readFileSync(source, "utf8"), original + append);
      assert.equal(existsSync(join(root, "scheduler")), true, "uses disposable adapter namespace, not production scheduler");
    } else {
      hooks.get("agent_settled")!({}, context); await pause();
      assert.equal(existsSync(join(root, ".chrono-catalog")), false);
      assert.equal(existsSync(join(root, "scheduler")), false);
    }
    hooks.get("session_before_switch")!({}, context);
    hooks.get("session_before_fork")!({}, context);
    hooks.get("session_shutdown")!({}, context);
    await commands.get("chrono-catalog-status")!.handler("", context);
    assert.ok(status.includes("disabled"));
    completed = true;
  } finally {
    hooks.get("session_shutdown")?.({}, context);
    for (let index = 0; index < keys.length; index++) { const value = previous[index]; if (value === undefined) delete process.env[keys[index]!]; else process.env[keys[index]!] = value; }
    // Failed/cancelled checks retain their namespace; do not remove active leases.
    if (completed) rmSync(root, { recursive: true, force: true });
  }
});
