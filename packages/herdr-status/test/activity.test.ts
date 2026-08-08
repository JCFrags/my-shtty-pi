import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityController,
  deriveToolSummary,
  formatContextPercent,
  formatModel,
} from "../src/activity.ts";
import { CapturingActivityReporter, FakeClock, createContext } from "./helpers.ts";

test("structured Pi tool inputs map to concise activity summaries", () => {
  const cwd = "/workspace/test/project";
  const home = "/workspace/test";

  assert.equal(
    deriveToolSummary("read", { path: "/workspace/test/project/src/auth/session.ts" }, cwd, home),
    "reading src/auth/session.ts",
  );
  assert.equal(
    deriveToolSummary("grep", { pattern: "createSession" }, cwd, home),
    "searching createSession",
  );
  assert.equal(
    deriveToolSummary("grep", { pattern: "EXAMPLE_TOKEN=demo" }, cwd, home),
    "searching EXAMPLE_TOKEN=<redacted>",
  );
  assert.equal(
    deriveToolSummary("bash", { command: "npm test\necho ignored" }, cwd, home),
    "running npm test",
  );
  assert.equal(
    deriveToolSummary("write", { path: "src/router.ts" }, cwd, home),
    "editing src/router.ts",
  );
});

test("model and context tokens use documented concise formats", () => {
  const harness = createContext();
  assert.equal(formatModel(harness.context.model), "openai/gpt-5.6-pro");
  assert.equal(formatContextPercent(harness.context), "25%");

  harness.setContextPercent(99.6);
  assert.equal(formatContextPercent(harness.context), "100%");
  harness.setContextPercent(null);
  assert.equal(formatContextPercent(harness.context), undefined);
});

test("empty or control-only tool names are omitted rather than reported as empty strings", () => {
  const reporter = new CapturingActivityReporter();
  const clock = new FakeClock();
  const controller = new ActivityController(reporter, { clock, homeDirectory: "/workspace/test" });
  const { context } = createContext();

  controller.onSessionStart(context);
  controller.onToolExecutionStart(
    { toolCallId: "empty", toolName: "\u0000\u001b[31m", args: {} },
    context,
  );

  assert.equal(controller.getSnapshot().tool, undefined);
  assert.equal(controller.getSnapshot().summary, "using tool");
});

test("all outgoing token values hide home prefixes and malformed turn indexes stay decimal", () => {
  const reporter = new CapturingActivityReporter();
  const clock = new FakeClock();
  const controller = new ActivityController(reporter, { clock, homeDirectory: "/workspace/test" });
  const { context } = createContext();

  controller.onSessionStart(context);
  controller.onTurnStart({ turnIndex: Number.NaN }, context);
  controller.onToolExecutionStart(
    {
      toolCallId: "grep-home",
      toolName: "grep",
      args: { pattern: "/workspace/test/private/EXAMPLE_TOKEN=demo" },
    },
    context,
  );

  assert.equal(controller.getSnapshot().turn, "0");
  assert.equal(controller.getSnapshot().summary, "searching ~/private/EXAMPLE_TOKEN=<redacted>");
});

test("successful edit and write events deduplicate normalized paths", async () => {
  const clock = new FakeClock();
  const reporter = new CapturingActivityReporter();
  const controller = new ActivityController(reporter, {
    clock,
    homeDirectory: "/workspace/test",
  });
  const { context } = createContext();

  controller.onSessionStart(context);
  controller.onTurnStart({ turnIndex: 4 }, context);

  controller.onToolExecutionStart(
    { toolCallId: "1", toolName: "edit", args: { path: "src/../src/router.ts" } },
    context,
  );
  controller.onToolExecutionEnd(
    { toolCallId: "1", toolName: "edit", isError: false },
    context,
  );
  controller.onToolExecutionStart(
    { toolCallId: "2", toolName: "write", args: { path: "src/router.ts" } },
    context,
  );
  controller.onToolExecutionEnd(
    { toolCallId: "2", toolName: "write", isError: false },
    context,
  );
  controller.onToolExecutionStart(
    { toolCallId: "3", toolName: "edit", args: { path: "src/failed.ts" } },
    context,
  );
  controller.onToolExecutionEnd(
    { toolCallId: "3", toolName: "edit", isError: true },
    context,
  );

  assert.equal(controller.getChangedFileCount(), 1);
  assert.equal(controller.getSnapshot().changed_files, "1");
  assert.equal(controller.getSnapshot().turn, "4");

  controller.onAgentSettled(context);
  assert.equal(controller.getSnapshot().summary, "idle · 1 file changed");
  assert.equal(controller.getSnapshot().tool, undefined);
  await controller.onSessionShutdown();
  assert.equal(reporter.shutdownCount, 1);
});

test("active tool clearing is debounced", async () => {
  const clock = new FakeClock();
  const reporter = new CapturingActivityReporter();
  const controller = new ActivityController(reporter, {
    clock,
    homeDirectory: "/workspace/test",
    toolClearDebounceMs: 350,
  });
  const { context } = createContext();

  controller.onSessionStart(context);
  controller.onTurnStart({ turnIndex: 1 }, context);
  controller.onToolExecutionStart(
    { toolCallId: "1", toolName: "read", args: { path: "src/a.ts" } },
    context,
  );
  controller.onToolExecutionEnd(
    { toolCallId: "1", toolName: "read", isError: false },
    context,
  );

  assert.equal(controller.getSnapshot().tool, "read");
  await clock.tick(349);
  assert.equal(controller.getSnapshot().tool, "read");
  await clock.tick(1);
  assert.equal(controller.getSnapshot().tool, undefined);
  assert.equal(controller.getSnapshot().summary, "waiting for model");
});

test("TTL refresh runs while active and tool updates are throttled", async () => {
  const clock = new FakeClock();
  const reporter = new CapturingActivityReporter();
  const controller = new ActivityController(reporter, {
    clock,
    homeDirectory: "/workspace/test",
    ttlRefreshMs: 5_000,
    toolUpdateRefreshMs: 3_000,
  });
  const { context } = createContext();

  controller.onSessionStart(context);
  controller.onTurnStart({ turnIndex: 1 }, context);
  controller.onToolExecutionStart(
    { toolCallId: "1", toolName: "bash", args: { command: "npm test" } },
    context,
  );

  controller.onToolExecutionUpdate({
    toolCallId: "1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.equal(reporter.refreshCount, 0);

  await clock.tick(2_999);
  controller.onToolExecutionUpdate({
    toolCallId: "1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.equal(reporter.refreshCount, 0);

  await clock.tick(1);
  controller.onToolExecutionUpdate({
    toolCallId: "1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.equal(reporter.refreshCount, 1);

  await clock.tick(2_000);
  assert.equal(reporter.refreshCount, 2);
});
