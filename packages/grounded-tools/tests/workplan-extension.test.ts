import assert from "node:assert/strict";
import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { Value } from "typebox/value";
import groundedWorkplan, { prepareWorkplanArguments, WORKPLAN_DESCRIPTION, WORKPLAN_GUIDELINES, WORKPLAN_PROMPT_SNIPPET, WorkplanParams } from "../packages/workplan/index.ts";

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
  assert.ok(Buffer.byteLength(WORKPLAN_GUIDELINES.join("\n")) <= 800);
  assert.match(WORKPLAN_GUIDELINES[0]!, /workplan/i);
});

test("workplan schema documents payloads and normalizes legacy section names", () => {
  assert.equal(Value.Check(WorkplanParams, { action: "recover", planId: "WP1" }), true);
  assert.equal(Value.Check(WorkplanParams, { action: "revise", planId: "WP1", section: "nonGoals", expectedRevision: 1, rationale: "x", content: [] }), true);
  assert.equal(Value.Check(WorkplanParams, { action: "revise", planId: "WP1", section: "non_goals", expectedRevision: 1, rationale: "x", content: [] }), false);
  assert.match(String((WorkplanParams.properties.content as { description?: string }).description), /create: \{title, objective, approach/);
  assert.deepEqual(prepareWorkplanArguments({ action: "revise", planId: "WP1", section: "acceptance_criteria", expectedRevision: 1, rationale: "x", content: [] }), {
    action: "revise", planId: "WP1", section: "acceptanceCriteria", expectedRevision: 1, rationale: "x", content: [],
  });
  assert.deepEqual(prepareWorkplanArguments({ action: "create", content: { title: "t", objective: "o", approach: "a", non_goals: ["n"], acceptance_criteria: ["c"] } }), {
    action: "create", content: { title: "t", objective: "o", approach: "a", nonGoals: ["n"], acceptanceCriteria: ["c"] },
  });
});

test("workplan mutation, list, and status results show the durable content to the user", async () => {
  const runtime = load();
  const created = await runtime.tool.execute("w1", { action: "create", content: {
    title: "Visible plan", objective: "Keep the complete goal visible", approach: "Show every durable mutation",
    scope: ["Visible scope"], nonGoals: ["Hidden changes"], constraints: ["Preserve exact text"], acceptanceCriteria: ["The result explains the change"], verification: ["Inspect tool output"],
  } });
  assert.match(created.content[0].text, /^# Workplan created\n\n# WP1: Visible plan/m);
  for (const value of ["Keep the complete goal visible", "Visible scope", "Hidden changes", "Preserve exact text", "The result explains the change"]) assert.match(created.content[0].text, new RegExp(value));

  const added = await runtime.tool.execute("w2", { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "Visible milestone", description: "Explain the actual work", acceptanceCriteria: ["Milestone output is complete"] } });
  for (const value of ["Action: add_milestone", "Plan: WP1: Visible plan", "Objective: Keep the complete goal visible", "### WP1-M1: Visible milestone", "Description: Explain the actual work", "Milestone output is complete"]) assert.match(added.content[0].text, new RegExp(value));

  const revised = await runtime.tool.execute("w3", { action: "revise", planId: "WP1", expectedRevision: 2, section: "constraints", rationale: "Make the visible boundary exact", content: ["Do not hide stored workplan content"] });
  assert.match(revised.content[0].text, /Action: revise[\s\S]*Section: constraints[\s\S]*Do not hide stored workplan content/);

  const decision = await runtime.tool.execute("w4", { action: "record_decision", planId: "WP1", expectedRevision: 3, rationale: "The user must see durable changes", content: { decision: "Return human-readable mutation details" } });
  assert.match(decision.content[0].text, /### WP1-D1[\s\S]*Decision: Return human-readable mutation details[\s\S]*Rationale: The user must see durable changes/);

  const risk = await runtime.tool.execute("w5", { action: "record_risk", planId: "WP1", expectedRevision: 4, content: { description: "Output could be too terse", impact: "The plan appears empty", mitigation: "Render the complete changed record" } });
  assert.match(risk.content[0].text, /### WP1-R1[\s\S]*Description: Output could be too terse[\s\S]*Impact: The plan appears empty[\s\S]*Mitigation: Render the complete changed record/);

  const question = await runtime.tool.execute("w6", { action: "record_question", planId: "WP1", expectedRevision: 5, content: { question: "Is the change visible?" } });
  assert.match(question.content[0].text, /### WP1-Q1[\s\S]*Question: Is the change visible\?/);

  const checkpoint = await runtime.tool.execute("w7", { action: "checkpoint", planId: "WP1", expectedRevision: 6, content: { summary: "Presentation is visible", currentFocus: "Verify output", nextActions: ["Inspect the result"] } });
  assert.match(checkpoint.content[0].text, /### WP1-K1[\s\S]*Summary: Presentation is visible[\s\S]*Current focus: Verify output[\s\S]*- Inspect the result/);

  const resumed = await runtime.tool.execute("w8", { action: "resume", planId: "WP1", expectedRevision: 7, rationale: "Start visible execution" });
  assert.match(resumed.content[0].text, /Action: resume[\s\S]*Status transition: draft -> active/);

  const updated = await runtime.tool.execute("w9", { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 8, content: { status: "in_progress", evidence: ["Output inspection started"] } });
  assert.match(updated.content[0].text, /Changed fields: evidence, status, updatedAt[\s\S]*### WP1-M1: Visible milestone[\s\S]*Status: in_progress[\s\S]*- Output inspection started/);

  const listed = await runtime.tool.execute("l", { action: "list" });
  assert.match(listed.content[0].text, /^# Workplans[\s\S]*## WP1: Visible plan[\s\S]*Objective: Keep the complete goal visible/);
  const status = await runtime.tool.execute("s", { action: "status", planId: "WP1" });
  assert.match(status.content[0].text, /^# Workplan status[\s\S]*Plan: WP1: Visible plan[\s\S]*WP1-M1 \[in_progress\]: Visible milestone/);
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
  assert.equal(result.messages[1].content, "[workplan state] active=WP1 status=active rev=4 milestones=0/1 blocked=0 recovery=required:workplan(action=recover,planId=WP1)");
  for (const prohibited of ["private", "T987"]) assert.equal(JSON.stringify(result.messages[1]).includes(prohibited), false);
  assert.ok(Buffer.byteLength(result.messages[1].content) <= 240);
});

test("recovery satisfies orientation only for the visible current plan revision", async () => {
  const runtime = load();
  await runtime.tool.execute("w1", createInput);
  await runtime.tool.execute("w2", { action: "resume", planId: "WP1", rationale: "start", expectedRevision: 1 });
  const recovery = await runtime.tool.execute("r1", { action: "recover", planId: "WP1" });
  assert.match(recovery.content[0].text, /## Goal/);
  assert.deepEqual(recovery.details.recovery, { planId: "WP1", revision: 2 });
  const visibleRecovery = { role: "toolResult", toolName: "workplan", details: recovery.details };
  let context = runtime.handlers.get("context")?.({ messages: [visibleRecovery] }, ctx([]));
  assert.match(context.messages.at(-1).content, /recovery=current$/);
  await runtime.tool.execute("w3", { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "next" } });
  context = runtime.handlers.get("context")?.({ messages: [visibleRecovery] }, ctx([]));
  assert.match(context.messages.at(-1).content, /recovery=required:workplan\(action=recover,planId=WP1\)$/);
});

test("repeated compaction fixtures retain state and require fresh recovery", async () => {
  const source = load();
  const created = await source.tool.execute("w1", createInput);
  const resumed = await source.tool.execute("w2", { action: "resume", planId: "WP1", rationale: "start", expectedRevision: 1 });
  const milestone = await source.tool.execute("w3", { action: "add_milestone", planId: "WP1", expectedRevision: 2, content: { title: "Durable next step" } });
  const branch = [
    entry("e1", created.details),
    { id: "c1", type: "compaction", summary: "first summary" },
    entry("e2", resumed.details),
    { id: "c2", type: "compaction", summary: "second summary" },
    entry("e3", milestone.details),
    { id: "c3", type: "compaction", summary: "third summary" },
  ];
  for (let iteration = 0; iteration < 3; iteration++) {
    const runtime = load();
    runtime.handlers.get("session_start")?.({ reason: "reload" }, ctx(branch));
    const before = runtime.handlers.get("context")?.({ messages: [{ role: "compactionSummary", summary: `iteration ${iteration}` }] }, ctx(branch));
    assert.match(before.messages.at(-1).content, /active=WP1.*rev=3.*recovery=required/);
    const recovery = await runtime.tool.execute("r", { action: "recover", planId: "WP1" });
    assert.match(recovery.content[0].text, /Plan objective/);
    assert.match(recovery.content[0].text, /Durable next step/);
    const after = runtime.handlers.get("context")?.({ messages: [{ role: "toolResult", toolName: "workplan", details: recovery.details }] }, ctx(branch));
    assert.match(after.messages.at(-1).content, /recovery=current$/);
  }
});

test("draft workplan context exposes durable state and recovery without stored prose", async () => {
  const runtime = load(); const created = await runtime.tool.execute("w1", createInput);
  let result = runtime.handlers.get("context")?.({ messages: [] }, ctx([]));
  assert.equal(result.messages[0].content, "[workplan state] active=none open=WP1:draft@rev1 openCount=1 retained=1 completed=0 archived=0 recovery=required:workplan(action=recover,planId=WP1)");
  for (const privateText of ["Plan title", "Plan objective", "Plan approach"]) assert.equal(result.messages[0].content.includes(privateText), false);
  const recovered = await runtime.tool.execute("r", { action: "recover", planId: "WP1" });
  result = runtime.handlers.get("context")?.({ messages: [{ role: "toolResult", toolName: "workplan", details: recovered.details }] }, ctx([entry("e1", created.details)]));
  assert.match(result.messages.at(-1).content, /recovery=current$/);
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
