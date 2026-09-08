import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Use Pi's real bundled component implementation, without loading Pi sessions.
const require = createRequire(import.meta.url);
let tuiPath;
try {
  tuiPath = require.resolve("@earendil-works/pi-tui");
} catch {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim();
  tuiPath = createRequire(join(globalRoot, "@earendil-works/pi-coding-agent/package.json"))
    .resolve("@earendil-works/pi-tui");
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@earendil-works/pi-tui"
      ? { url: pathToFileURL(tuiPath).href, shortCircuit: true }
      : next(specifier, context);
  },
});
const { default: extension } = await import("../dist/extensions/pi-herdr-orchestrator.js");
const { openAgentSettings } = await import("../dist/src/pi/agent-settings.js");
hooks.deregister();

function registration(child) {
  const commands = new Map();
  const tools = [];
  const events = [];
  const prior = process.env.PI_HERDR_AGENT_ID;
  try {
    if (child) process.env.PI_HERDR_AGENT_ID = "synthetic-child";
    else delete process.env.PI_HERDR_AGENT_ID;
    extension({
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: tool => tools.push(tool.name),
      on: name => events.push(name),
    });
  } finally {
    if (prior === undefined) delete process.env.PI_HERDR_AGENT_ID;
    else process.env.PI_HERDR_AGENT_ID = prior;
  }
  return { commands, tools, events };
}

test("root registers direct orchestration plus settings; child only exact channel", async () => {
  const root = registration(false);
  assert.deepEqual(root.tools, ["orchestrate"]);
  assert.deepEqual([...root.commands.keys()], ["agent-settings"]);
  assert.ok(root.events.includes("session_start"));
  assert.ok(root.events.includes("session_shutdown"));
  const child = registration(true);
  assert.deepEqual(child.tools, ["subagent_channel"]);
  assert.equal(child.commands.size, 0);
  const notifications = [];
  await root.commands.get("agent-settings").handler("", {
    mode: "rpc", ui: { notify: text => notifications.push(text) },
  });
  assert.match(notifications[0], /TUI mode/);
});

test("real settings component renders and saves only after explicit Save", { timeout: 5000 }, async () => {
  const calls = [];
  const notifications = [];
  const client = {
    connected: true,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "model.capabilities") return {
        models: [{ provider: "fixture", modelId: "synthetic", reasoning: false, thinkingLevels: ["off"] }],
      };
      if (method === "model.policy.get") return { policy: {}, operatorSettings: {} };
      if (method === "model.operator.settings.set") return { persisted: true };
      throw new Error("Unexpected request");
    },
  };
  const context = {
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "synthetic" }] },
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      custom: async factory => {
        let finished = false;
        let result;
        const component = factory({}, { fg: (_color, text) => text, bold: text => text }, {}, value => {
          finished = true; result = value;
        });
        assert.match(component.render(100).join("\n"), /Agent settings/);
        assert.equal(calls.filter(call => call.method.endsWith(".set")).length, 0);
        for (const char of "Save agent settings") component.handleInput(char);
        component.handleInput("\r");
        assert.equal(finished, true);
        return result;
      },
    },
  };
  await openAgentSettings(client, context);
  assert.equal(calls.at(-1).method, "model.operator.settings.set");
  assert.equal(calls.at(-1).params.allowlist, null);
  assert.equal(notifications.at(-1).level, "info");
  calls.length = 0;
  context.ui.custom = async () => undefined;
  await openAgentSettings(client, context);
  assert.deepEqual(calls.map(call => call.method), ["model.capabilities", "model.policy.get"]);
});
