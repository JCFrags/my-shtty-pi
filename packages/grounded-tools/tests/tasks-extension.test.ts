import assert from "node:assert/strict";
import test from "node:test";
import groundedTasks from "../packages/tasks/index.ts";

function loadTodo() {
  let todo: any;
  const handlers = new Map<string, Function>();
  groundedTasks({
    registerTool(value: any) { if (value.name === "todo") todo = value; },
    registerCommand() {},
    on(name: string, handler: Function) { handlers.set(name, handler); },
    appendEntry() {},
  } as any);
  return { todo, handlers };
}

test("session-tree changes restore only the active branch task snapshot", async () => {
  const { todo, handlers } = loadTodo();
  const savedState = {
    nextId: 2,
    tasks: [{ id: "T1", text: "branch task", status: "pending", blockedBy: [], createdAt: 1, updatedAt: 1 }],
  };
  const context = (branch: unknown[]) => ({
    hasUI: false,
    sessionManager: { getBranch: () => branch },
  });
  handlers.get("session_start")?.({}, context([{
    type: "message",
    message: { role: "toolResult", toolName: "todo", details: { action: "add", state: savedState } },
  }]));
  assert.equal((await todo.execute("t1", { action: "list" })).details.state.tasks[0].text, "branch task");
  handlers.get("session_tree")?.({}, context([]));
  assert.equal((await todo.execute("t2", { action: "list" })).details.state.tasks.length, 0);
});

test("todo replacement resolves forward dependencies and advances explicit ids", async () => {
  const { todo } = loadTodo();
  const replaced = await todo.execute("t1", {
    action: "replace",
    tasks: [
      { id: "T9", text: "dependent", blockedBy: ["T10"] },
      { id: "T10", text: "blocker" },
    ],
  });
  assert.equal(replaced.details.state.tasks[0].status, "blocked");
  assert.equal(replaced.details.state.nextId, 11);
  const added = await todo.execute("t2", { action: "add", text: "next" });
  assert.equal(added.details.state.tasks.at(-1).id, "T11");
});

test("failed todo operations leave live extension state unchanged", async () => {
  const { todo } = loadTodo();
  await todo.execute("t1", { action: "add", text: "first" });
  await todo.execute("t2", { action: "add", text: "second" });
  await assert.rejects(
    todo.execute("t3", { action: "update", id: "T1", blockedBy: ["missing"] }),
    /unknown blocker/,
  );
  const listed = await todo.execute("t4", { action: "list" });
  assert.equal(listed.details.state.tasks.length, 2);
  assert.deepEqual(listed.details.state.tasks[0].blockedBy, []);
});
