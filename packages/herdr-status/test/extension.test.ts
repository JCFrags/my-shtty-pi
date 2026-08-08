import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";

import { registerHerdrStatusExtension } from "../src/extension.ts";
import type { MetadataTransport } from "../src/herdr-client.ts";
import { CapturingTransport, FakeClock, FakePi, createContext } from "./helpers.ts";

test("inactive environments load silently and /herdr-status explains why", async () => {
  const pi = new FakePi();
  const harness = createContext();
  registerHerdrStatusExtension(pi, {
    environment: {
      HERDR_ENV: "0",
      HERDR_PANE_ID: "inactive-pane",
      HERDR_SOCKET_PATH: "/secret/socket/path",
    },
    executableCheck: () => true,
  });

  assert.equal(pi.handlers.size, 0);
  const command = pi.commands.get("herdr-status");
  assert.ok(command);
  await command.handler("", harness.context);

  const message = harness.notifications.at(-1)?.message ?? "";
  assert.match(message, /Herdr status: inactive/u);
  assert.match(message, /HERDR_ENV is not 1/u);
  assert.match(message, /target pane: inactive-pane/u);
  assert.match(message, /source: user:pi-rich-status/u);
  assert.match(message, /official Pi integration/u);
  assert.doesNotMatch(message, /secret\/socket/u);
});

test("active extension registers the documented Pi event mapping and status command", async () => {
  const pi = new FakePi();
  const clock = new FakeClock();
  const transport = new CapturingTransport();
  const harness = createContext();
  const runtime = registerHerdrStatusExtension(pi, {
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w8:p4",
      HERDR_BIN_PATH: "/opt/herdr",
      HERDR_SOCKET_PATH: "/secret/socket/path",
    },
    executableCheck: () => true,
    clock,
    transportFactory: () => transport,
  });

  assert.equal(runtime.activation.active, true);
  assert.deepEqual([...pi.handlers.keys()].sort(), [
    "agent_settled",
    "model_select",
    "session_shutdown",
    "session_start",
    "thinking_level_select",
    "tool_execution_end",
    "tool_execution_start",
    "tool_execution_update",
    "turn_start",
  ]);

  await pi.emit("session_start", {}, harness.context);
  await pi.emit("turn_start", { turnIndex: 2 }, harness.context);
  await pi.emit(
    "tool_execution_start",
    { toolCallId: "t1", toolName: "read", args: { path: "src/index.ts" } },
    harness.context,
  );

  const command = pi.commands.get("herdr-status");
  assert.ok(command);
  await command.handler("", harness.context);
  const message = harness.notifications.at(-1)?.message ?? "";
  assert.match(message, /Herdr status: active/u);
  assert.match(message, /target pane: w8:p4/u);
  assert.match(message, /summary="reading src\/index.ts"/u);
  assert.match(message, /tool="read"/u);
  assert.match(message, /turn="2"/u);
  assert.doesNotMatch(message, /secret\/socket/u);

  await pi.emit("session_shutdown", {}, harness.context);
  assert.deepEqual(transport.clears, [1]);
});

test("extension surfaces only one warning after repeated Herdr failures", async () => {
  const pi = new FakePi();
  const clock = new FakeClock();
  const harness = createContext();
  const transport: MetadataTransport = {
    async report() {
      throw new Error("offline");
    },
    async clear() {},
  };

  registerHerdrStatusExtension(pi, {
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_BIN_PATH: "/opt/herdr",
    },
    executableCheck: () => true,
    clock,
    transportFactory: () => transport,
  });

  await pi.emit("session_start", {}, harness.context);
  await clock.tick(150);
  await clock.tick(250);
  await clock.tick(250);
  await clock.tick(1_000);

  const warnings = harness.notifications.filter((entry) => entry.type === "warning");
  assert.deepEqual(warnings, [
    {
      message: "Herdr status reporting paused after repeated failures",
      type: "warning",
    },
  ]);
});

test("/herdr-status redacts credentials and home paths from concise failures", async () => {
  const pi = new FakePi();
  const clock = new FakeClock();
  const harness = createContext();
  const home = homedir();
  const transport: MetadataTransport = {
    async report() {
      throw new Error(`EXAMPLE_TOKEN=demo at ${home}/private/socket`);
    },
    async clear() {},
  };

  registerHerdrStatusExtension(pi, {
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_BIN_PATH: "/opt/herdr",
    },
    executableCheck: () => true,
    clock,
    transportFactory: () => transport,
  });

  await pi.emit("session_start", {}, harness.context);
  await clock.tick(150);
  const command = pi.commands.get("herdr-status");
  assert.ok(command);
  await command.handler("", harness.context);

  const message = harness.notifications.at(-1)?.message ?? "";
  assert.match(message, /EXAMPLE_TOKEN=<redacted>/u);
  assert.doesNotMatch(message, /super-secret/u);
  assert.ok(!message.includes(home));
});
