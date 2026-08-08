import assert from "node:assert/strict";
import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { Value } from "typebox/value";
import groundedWorkplan, { WORKPLAN_DESCRIPTION, WORKPLAN_GUIDELINES, WORKPLAN_PROMPT_SNIPPET, WorkplanParams } from "../packages/workplan/index.ts";

function load() {
  let tool: any;
  const handlers = new Map<string, Function>();
  groundedWorkplan({ registerTool(value: any) { tool = value; }, on(name: string, handler: Function) { handlers.set(name, handler); } } as any);
  return { tool, handlers };
}
function ctx(branch: unknown[], mode = "json") { return { sessionManager: { getBranch: () => branch }, mode, hasUI: mode === "tui" || mode === "rpc" }; }
function entry(id: string, details: unknown, toolName = "workplan") { return { id, type: "message", message: { role: "toolResult", toolName, details } }; }
const createInput = { action: "create", content: { title: "Plan title", objective: "Plan objective", approach: "Plan approach" } };

test("workplan schema has no export or destination input and meets metadata budgets", () => {
  assert.equal(Value.Check(WorkplanParams, createInput), true);
  assert.equal(Value.Check(WorkplanParams, { action: "export", planId: "WP1" }), false);
  assert.equal(Value.Check(WorkplanParams, { ...createInput, path: "/tmp/out" }), false);
  const text = JSON.stringify(WorkplanParams);
  assert.ok(Buffer.byteLength(text) <= 2000);
  for (const field of ["path", "expectedDigest", "destination", "fileHandle", "export"]) assert.equal(Object.hasOwn(WorkplanParams.properties, field), false);
  assert.ok(Buffer.byteLength(WORKPLAN_DESCRIPTION) <= 700);
  assert.ok(Buffer.byteLength(WORKPLAN_PROMPT_SNIPPET) <= 140);
  assert.ok(Buffer.byteLength(WORKPLAN_GUIDELINES.join("\n")) <= 500);
  assert.match(WORKPLAN_GUIDELINES[0]!, /workplan/i);
});

test("workplan extension is sequential and reconstructs branch state for lifecycle fixtures", async () => {
  const source = load();
  assert.equal(source.tool.executionMode, "sequential");
  const created = await source.tool.execute("w1", createInput);
  const resumed = await source.tool.execute("w2", { action: "resume", planId: "WP1", rationale: "start", expectedRevision: 1 });
  const branch = [entry("e1", created.details), entry("e2", resumed.details), { id: "cmp", type: "compaction" }];
  for (const fixture of ["reload", "resume", "interactive fork", "clone", "CLI fork", "explicit import", "in-memory"] as const) {
    const runtime = load();
    runtime.handlers.get("session_start")?.({ reason: fixture === "reload" ? "reload" : "startup", fixture }, ctx(branch));
    const status = await runtime.tool.execute("s", { action: "status", planId: "WP1" });
    assert.equal(status.details.result.status, "active");
  }
  const empty = load();
  empty.handlers.get("session_start")?.({ reason: "new", previousSessionFile: "/must-not-read" }, ctx([]));
  assert.deepEqual((await empty.tool.execute("l", { action: "list" })).details.result, []);
});

test("workplan session-tree branch changes rebuild and diverge", async () => {
  const runtime = load();
  const created = await runtime.tool.execute("w1", createInput);
  const first = await runtime.tool.execute("w2", { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "left" } });
  runtime.handlers.get("session_tree")?.({}, ctx([entry("e1", created.details)]));
  const other = await runtime.tool.execute("w3", { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "right" } });
  assert.equal(first.details.event.data.milestone.id, "WP1-M1");
  assert.equal(other.details.event.data.milestone.id, "WP1-M1");
  assert.notEqual(first.details.event.data.milestone.title, other.details.event.data.milestone.title);
});

test("workplan matching corruption fails closed and unrelated or future entries are ignored", async () => {
  const source = load(); const created = await source.tool.execute("w1", createInput);
  const bad = structuredClone(created.details); bad.event.data.plan.nextPlanNumber = 99;
  const runtime = load();
  runtime.handlers.get("session_start")?.({}, ctx([
    entry("todo", bad, "todo"),
    entry("future", { protocol: "grounded-state-result/v1", event: { protocol: "grounded-state-event/v2", tool: "workplan" } }),
    entry("bad-entry", bad),
    entry("later", created.details),
  ]));
  await assert.rejects(runtime.tool.execute("l", { action: "list" }), /STATE_CORRUPT.*bad-entry/);
  const result = runtime.handlers.get("context")?.({ messages: [] }, ctx([]));
  assert.equal(result.messages[0].content, "[workplan state] corrupt entry=bad-entry");
});

test("workplan context is compact and contains no stored prose or todo IDs", async () => {
  const runtime = load();
  await runtime.tool.execute("w1", { action: "create", content: { title: "private title", objective: "private objective", approach: "private approach" } });
  await runtime.tool.execute("w2", { action: "resume", planId: "WP1", rationale: "private rationale", expectedRevision: 1 });
  await runtime.tool.execute("w3", { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "private milestone" } });
  await runtime.tool.execute("w4", { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 3, content: { status: "in_progress", linkedTodoIds: ["T987"] } });
  const original = [{ role: "user", content: "request", timestamp: 1 }];
  const result = runtime.handlers.get("context")?.({ messages: original }, ctx([]));
  assert.equal(result.messages[0], original[0]);
  assert.equal(result.messages[1].content, "[workplan state] active=WP1 status=active rev=4 milestones=0/1 blocked=0");
  for (const prohibited of ["private", "T987"]) assert.equal(JSON.stringify(result.messages[1]).includes(prohibited), false);
  assert.ok(Buffer.byteLength(result.messages[1].content) <= 240);
});

test("draft-only workplan context uses the exact no-active format", async () => {
  const runtime = load(); await runtime.tool.execute("w1", createInput);
  const result = runtime.handlers.get("context")?.({ messages: [] }, ctx([]));
  assert.equal(result.messages[0].content, "[workplan state] active=none status=none rev=0 milestones=0/0 blocked=0");
});

test("large workplan read spills exact private output with no user-selected path", async () => {
  const runtime = load();
  const item = "x".repeat(900);
  await runtime.tool.execute("w1", { action: "create", content: { title: "Large", objective: "Objective", approach: "Approach", scope: Array.from({ length: 64 }, () => item) } });
  const read = await runtime.tool.execute("r", { action: "read", planId: "WP1" });
  assert.ok(read.details.fullOutputPath);
  assert.match(read.content[0].text, /Output truncated exactly/);
  const full = await readFile(read.details.fullOutputPath, "utf8");
  assert.match(full, /^# WP1: Large/);
  assert.match(full, /## Revisions/);
  if (process.platform !== "win32") {
    assert.equal((await stat(read.details.fullOutputPath)).mode & 0o777, 0o600);
    assert.equal((await stat(new URL(".", `file://${read.details.fullOutputPath}`))).mode & 0o777, 0o700);
  }
  assert.equal(read.details.fullOutputPath.includes("Large"), false);
});

test("cancellation during workplan output preparation reports no success and removes partial spill", async () => {
  const runtime = load();
  const item = "x".repeat(900);
  await runtime.tool.execute("w1", { action: "create", content: { title: "Large", objective: "Objective", approach: "Approach", scope: Array.from({ length: 64 }, () => item) } });
  const existing = new Set(await readdir(tmpdir()));
  const controller = new AbortController();
  let created: string | undefined;
  const watcher = watch(tmpdir(), { persistent: false }, (_event, filename) => {
    const name = filename?.toString();
    if (name?.startsWith("grounded-workplan-") && !existing.has(name)) {
      created = name;
      controller.abort();
    }
  });
  try {
    await assert.rejects(runtime.tool.execute("r", { action: "read", planId: "WP1" }, controller.signal), /STATE_CANCELLED/);
  } finally {
    watcher.close();
  }
  assert.ok(created);
  assert.equal((await readdir(tmpdir())).includes(created), false);
  assert.equal((await runtime.tool.execute("s", { action: "status", planId: "WP1" })).details.result.revision, 1);
});

test("workplan loads without TUI or dialog requirements in all modes", async () => {
  for (const mode of ["tui", "rpc", "json", "print", "in-memory"]) {
    const runtime = load(); runtime.handlers.get("session_start")?.({ reason: "startup" }, ctx([], mode));
    assert.deepEqual((await runtime.tool.execute("l", { action: "list" })).details.result, []);
  }
});

test("workplan cancellation before commit leaves no event and no state change", async () => {
  const runtime = load(); const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.tool.execute("w1", createInput, controller.signal), /STATE_CANCELLED/);
  assert.deepEqual((await runtime.tool.execute("l", { action: "list" })).details.result, []);
});
