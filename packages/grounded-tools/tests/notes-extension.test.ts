import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import groundedNotes, { NOTES_DESCRIPTION, NOTES_GUIDELINES, NOTES_PROMPT_SNIPPET, NotesParams } from "../packages/notes/index.ts";

function load() {
  let tool: any;
  const handlers = new Map<string, Function>();
  groundedNotes({
    registerTool(value: any) { tool = value; },
    on(name: string, handler: Function) { handlers.set(name, handler); },
  } as any);
  return { tool, handlers };
}
function ctx(branch: unknown[], mode = "json") { return { sessionManager: { getBranch: () => branch }, mode, hasUI: mode === "tui" || mode === "rpc" }; }
function entry(id: string, details: unknown) {
  return { id, type: "message", message: { role: "toolResult", toolName: "notes", details } };
}

test("notes schema is strict, has no file destination, and stays inside byte budgets", () => {
  assert.equal(Value.Check(NotesParams, { action: "add", body: "x" }), true);
  assert.equal(Value.Check(NotesParams, { action: "add", body: "x", extra: true }), false);
  assert.equal(Value.Check(NotesParams, { action: "export", body: "x" }), false);
  const schemaText = JSON.stringify(NotesParams);
  assert.ok(Buffer.byteLength(schemaText) <= 1600);
  for (const name of ["path", "expectedDigest", "destination", "fileHandle"]) assert.equal(Object.hasOwn(NotesParams.properties, name), false);
  assert.ok(Buffer.byteLength(NOTES_DESCRIPTION) <= 700);
  assert.ok(Buffer.byteLength(NOTES_PROMPT_SNIPPET) <= 140);
  assert.ok(Buffer.byteLength(NOTES_GUIDELINES.join("\n")) <= 500);
  assert.match(NOTES_GUIDELINES[0]!, /notes/);
});

test("notes extension uses sequential transactional mutation and exact branch replay", async () => {
  const first = load();
  assert.equal(first.tool.executionMode, "sequential");
  const added = await first.tool.execute("n1", { action: "add", body: "branch prose" });
  const appended = await first.tool.execute("n2", { action: "append", id: "N1", body: " literal", expectedRevision: 1 });
  const branch = [entry("e1", added.details), entry("e2", appended.details)];

  for (const reason of ["startup", "reload", "resume", "fork"] as const) {
    const runtime = load();
    runtime.handlers.get("session_start")?.({ reason }, ctx(branch));
    const read = await runtime.tool.execute("r", { action: "read", id: "N1" });
    assert.match(read.content[0].text, /branch prose literal/);
  }

  first.handlers.get("session_tree")?.({}, ctx([entry("e1", added.details)]));
  const diverged = await first.tool.execute("n3", { action: "append", id: "N1", body: " other", expectedRevision: 1 });
  assert.match(diverged.content[0].text, /revision 2/);
});

test("notes survive compaction entries and explicit copied-path fixtures but new sessions are empty", async () => {
  const source = load();
  const added = await source.tool.execute("n1", { action: "add", body: "kept state" });
  const copied = [entry("n", added.details), { id: "c", type: "compaction", summary: "does not carry state" }];
  for (const label of ["compaction", "interactive fork", "clone", "CLI fork", "explicit import", "in-memory"] as const) {
    const runtime = load();
    runtime.handlers.get("session_start")?.({ reason: "startup", label }, ctx(copied));
    assert.match((await runtime.tool.execute("r", { action: "read", id: "N1" })).content[0].text, /kept state/);
  }
  const empty = load();
  empty.handlers.get("session_start")?.({ reason: "new", previousSessionFile: "/not/read" }, ctx([]));
  assert.deepEqual((await empty.tool.execute("l", { action: "list" })).details.result.items, []);
});

test("notes load without TUI or dialog requirements in every required mode", async () => {
  for (const mode of ["tui", "rpc", "json", "print", "in-memory"]) {
    const runtime = load();
    runtime.handlers.get("session_start")?.({ reason: "startup" }, ctx([], mode));
    assert.deepEqual((await runtime.tool.execute("l", { action: "list" })).details.result.items, []);
  }
});

test("duplicate same-turn notes mutations serialize with distinct monotonic IDs", async () => {
  const runtime = load();
  assert.equal(runtime.tool.executionMode, "sequential");
  const [first, second] = await Promise.all([
    runtime.tool.execute("n1", { action: "add", body: "duplicate" }),
    runtime.tool.execute("n2", { action: "add", body: "duplicate" }),
  ]);
  assert.deepEqual([first.details.result.id, second.details.result.id], ["N1", "N2"]);
  assert.equal((await runtime.tool.execute("l", { action: "list" })).details.result.total, 2);
});

test("notes corruption fails closed while unrelated and future protocol entries are ignored", async () => {
  const source = load();
  const added = await source.tool.execute("n1", { action: "add", body: "private body" });
  const corrupt = structuredClone(added.details);
  corrupt.event.stateRevision = 9;
  const runtime = load();
  runtime.handlers.get("session_start")?.({}, ctx([
    { id: "u", type: "message", message: { role: "toolResult", toolName: "todo", details: corrupt } },
    entry("future", { protocol: "grounded-state-result/v1", event: { protocol: "grounded-state-event/v2", tool: "notes" } }),
    entry("bad", corrupt),
    entry("later", added.details),
  ]));
  await assert.rejects(runtime.tool.execute("l", { action: "list" }), /STATE_CORRUPT.*bad/);
  const event = { messages: [{ role: "user", content: "private body", timestamp: 1 }] };
  const changed = runtime.handlers.get("context")?.(event, ctx([]));
  assert.equal(changed.messages.length, 2);
  assert.equal(changed.messages[0], event.messages[0]);
  assert.equal(changed.messages[1].content, "[notes state] corrupt entry=bad");
});

test("notes automatic context contains counts only and no note prose", async () => {
  const runtime = load();
  await runtime.tool.execute("n1", { action: "add", title: "secret title", body: "secret body", tags: ["secret tag"] });
  const original = [{ role: "user", content: "request", timestamp: 1 }];
  const result = runtime.handlers.get("context")?.({ messages: original }, ctx([]));
  assert.notEqual(result.messages, original);
  assert.equal(result.messages[0], original[0]);
  assert.equal(result.messages[1].content, "[notes state] active=1 archived=0");
  assert.equal(JSON.stringify(result.messages[1]).includes("secret"), false);
  assert.ok(Buffer.byteLength(result.messages[1].content) <= 240);
});

test("notes cancellation before commit creates no event and leaves state unchanged", async () => {
  const runtime = load();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.tool.execute("n1", { action: "add", body: "not committed" }, controller.signal), /STATE_CANCELLED/);
  const list = await runtime.tool.execute("l", { action: "list" });
  assert.equal(list.details.result.total, 0);
});
