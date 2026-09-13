import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/pi-extension.js";
import { schedulerArtifactCounts } from "../src/host-worker-scheduler.js";
import { setupCapsuleFixture, line } from "./capsule-storage-fixture.js";

test("synthetic prepared capsule shadow exposes cached status without model changes", async () => {
  const fixture = setupCapsuleFixture(line("a", null, "Not completed; approval required."));
  const schedulerDirectory = join(fixture.directory, "scheduler");
  const settings: Record<string, string> = {
    PI_CHRONO_CONFIG_PATH: join(fixture.directory, "config.json"),
    PI_CHRONO_CATALOG_SHADOW: "false", PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false",
    PI_CHRONO_ROLLUP_SHADOW: "false", PI_CHRONO_VALUE_WORKER_MODE: "off",
    PI_CHRONO_ISOLATED_WORKER: "false", PI_CHRONO_TOOL_RESULT_PROJECTION: "off",
  };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  writeFileSync(settings.PI_CHRONO_CONFIG_PATH!, "{}\n", { mode: 0o600 });
  const hooks = new Map<string, ((event: any, context: any) => any)[]>();
  const commands = new Map<string, (args: string, context: any) => any>();
  const notifications: string[] = [];
  let modelMutations = 0;
  const metadataTypes: string[] = [];
  const pi = {
    registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command.handler); },
    // Pi custom entries persist metadata but do not enter model context.
    appendEntry(type: string) { metadataTypes.push(type); }, sendMessage() { modelMutations++; },
    on(name: string, hook: any) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
  };
  const ctx = {
    hasUI: true, getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
    sessionManager: { getSessionFile: () => fixture.sourcePath, getSessionId: () => "synthetic-capsule", getEntries: () => [], getBranch: () => [] },
    ui: { notify(message: string) { notifications.push(message); } }, modelRegistry: {},
    compact() { modelMutations++; },
  };
  async function invoke(name: string) { for (const hook of hooks.get(name) ?? []) await hook({}, ctx); }
  try {
    const view = await fixture.initialize();
    extension(pi as unknown as ExtensionAPI, {
      schedulerDirectory,
      capsuleShadowTarget: () => ({ v: 1, op: "derivePage", identity: fixture.identity, view,
        catalogDirectory: fixture.catalogDirectory, derivedDirectory: fixture.derivedDirectory }),
    });
    const status = commands.get("chrono-capsules-status")!;
    await status("", ctx);
    assert.match(notifications.at(-1)!, /Capsule shadow: disabled/);
    await invoke("session_start");
    const deadline = Date.now() + 10_000;
    do {
      await status("", ctx);
      if (notifications.at(-1)!.includes("Capsule shadow: settled")) break;
      if (Date.now() >= deadline) assert.fail(notifications.at(-1));
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    assert.match(notifications.at(-1)!, /Capsules: unsupported \(1\/2\); chunks: ready \(1\/1\)/);
    assert.equal(modelMutations, 0);
    assert.deepEqual(metadataTypes, ["chrono-logical-adoption"], "V3 startup records only non-model adoption metadata");
    assert.ok(notifications.every(message => !message.includes(fixture.directory)));
    const before = await schedulerArtifactCounts(schedulerDirectory);
    for (let i = 0; i < 4; i++) await status("", ctx);
    assert.deepEqual(await schedulerArtifactCounts(schedulerDirectory), before);
    await invoke("session_before_switch");
    await status("", ctx);
    assert.match(notifications.at(-1)!, /Capsule shadow: idle/);
  } finally {
    await invoke("session_shutdown");
    assert.deepEqual(await schedulerArtifactCounts(schedulerDirectory), { tickets: 0, slots: 0 });
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fixture.cleanup();
  }
});
