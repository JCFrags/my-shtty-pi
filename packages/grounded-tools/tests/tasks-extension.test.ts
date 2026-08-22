import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import groundedTasks from "../packages/tasks/index.ts";
import { loadTodoDisplayMode, saveTodoDisplayMode } from "../packages/tasks/settings.ts";

function loadTodo(settingsPath?: string) {
  let todo: any;
  const handlers = new Map<string, Function>();
  const eventHandlers = new Map<string, Function[]>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  groundedTasks({
    registerTool(value: any) { if (value.name === "todo") todo = value; },
    registerCommand(name: string, value: any) { commands.set(name, value); },
    registerShortcut(name: string, value: any) { shortcuts.set(name, value); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    events: {
      on(name: string, handler: Function) {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
        return () => eventHandlers.set(name, list.filter((entry) => entry !== handler));
      },
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
    },
    appendEntry() {},
  } as any, settingsPath ? { settingsPath } : {});
  return { todo, handlers, commands, shortcuts, emitted, eventHandlers };
}

test("todo summary events are bounded, read-only, and cleaned up on shutdown", async () => {
  const runtime = loadTodo();
  const context = { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setWidget() {} } };
  runtime.handlers.get("session_start")?.({}, context);
  const requestHandlers = runtime.eventHandlers.get("pi-todo:request-summary-v1") ?? [];
  assert.equal(requestHandlers.length, 1);
  await runtime.todo.execute("add", { action: "add", text: "current task" });
  await runtime.todo.execute("wait", { action: "update", id: "T1", waitReason: "external review" });
  for (const handler of requestHandlers) handler({ requestId: "req-1" });
  const response = runtime.emitted.filter((entry) => entry.channel === "pi-todo:summary-v1").at(-1);
  assert.ok(response);
  const snapshot = (response?.data as any).snapshot;
  assert.deepEqual(Object.keys(snapshot).sort(), ["countsByState", "currentUsefulTask", "externalWaits", "planSize", "unfinishedTasks", "version"]);
  assert.equal(snapshot.planSize, 1);
  assert.equal(snapshot.currentUsefulTask.id, "T1");
  assert.equal(snapshot.externalWaits[0].reason, "external review");
  assert.ok(snapshot.countsByState.blocked === 1);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "history"), false);
  assert.equal((response?.data as any).requestId, "req-1");
  runtime.handlers.get("session_shutdown")?.({}, context);
  assert.equal((runtime.eventHandlers.get("pi-todo:request-summary-v1") ?? []).length, 0);
});

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

test("todo supports dependency blocks and truthful external waits across reload", async () => {
  const { todo, handlers } = loadTodo();
  const replaced = await todo.execute("replace", {
    action: "replace",
    tasks: [
      { id: "T1", text: "first" },
      { id: "T2", text: "dependent", blockedBy: ["T1"] },
    ],
  });
  assert.equal(replaced.details.state.tasks[1].status, "blocked");
  assert.deepEqual(replaced.details.state.tasks[1].blockedBy, ["T1"]);

  await todo.execute("start", { action: "start", id: "T1" });
  const added = await todo.execute("add", { action: "add", text: "external" });
  const externalId = added.details.state.tasks.at(-1).id;
  const waiting = await todo.execute("block", {
    action: "block",
    id: externalId,
    waitReason: "reviewer response",
  });
  const waitingTask = waiting.details.state.tasks.find((task: any) => task.id === externalId);
  assert.equal(waitingTask.status, "blocked");
  assert.deepEqual(waitingTask.blockedBy, []);
  assert.equal(waitingTask.waitReason, "reviewer response");
  await assert.rejects(todo.execute("blocked-start", { action: "start", id: externalId }), /waiting/);

  await todo.execute("clear-wait", { action: "update", id: externalId, waitReason: "" });
  await todo.execute("external-start", { action: "start", id: externalId });
  await todo.execute("external-done", { action: "done", id: externalId });
  await todo.execute("first-done", { action: "done", id: "T1" });
  await todo.execute("dependent-start", { action: "start", id: "T2" });
  await todo.execute("dependent-done", { action: "done", id: "T2" });

  const listed = await todo.execute("list", { action: "list" });
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const rendered = todo.renderResult(listed, { expanded: true }, theme).render(120).join("\n");
  assert.equal((rendered.match(/T1 first/g) ?? []).length, 1);
  assert.equal(listed.details.state.tasks.filter((task: any) => task.id === "T1").length, 1);

  handlers.get("session_start")?.({}, {
    hasUI: false,
    sessionManager: { getBranch: () => [{
      type: "message",
      message: { role: "toolResult", toolName: "todo", details: listed.details },
    }] },
  });
  const reloaded = await todo.execute("reloaded-list", { action: "list" });
  assert.deepEqual(reloaded.details.state, listed.details.state);
});

test("todo settings persist a valid display mode and preserve other keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grounded-todo-settings-"));
  const path = join(directory, "settings.json");
  assert.equal(loadTodoDisplayMode(path), "compact");
  saveTodoDisplayMode("plan", path);
  const first = JSON.parse(readFileSync(path, "utf8"));
  first.futureSetting = true;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(first)));
  saveTodoDisplayMode("compact", path);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { displayMode: "compact", futureSetting: true });
});

test("responsive todo UI updates, persists size, scrolls the full overlay, and restores branches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grounded-todo-ui-"));
  const settingsPath = join(directory, "settings.json");
  const runtime = loadTodo(settingsPath);
  let branch: any[] = [];
  let widgetFactory: any;
  let overlay: any;
  let overlayOptions: any;
  let renders = 0;
  const notices: string[] = [];
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const tui = { terminal: { rows: 10 }, requestRender: () => { renders += 1; } };
  const context = {
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: {
      setWidget(_key: string, value: any) { widgetFactory = value; },
      notify(message: string) { notices.push(message); },
      async custom(factory: any, options: any) {
        overlayOptions = options;
        overlay = factory(tui, theme, {}, () => {});
      },
    },
  };

  runtime.handlers.get("session_start")?.({}, context);
  await runtime.todo.execute("replace", {
    action: "replace",
    tasks: [
      { id: "T1", text: "first active task" },
      { id: "T2", text: "dependency task", blockedBy: ["T1"] },
      { id: "T3", text: "external task", waitReason: "reviewer response" },
      { id: "T4", text: "long ".repeat(30) },
      { id: "T5", text: "fifth" },
      { id: "T6", text: "sixth" },
      { id: "T7", text: "seventh" },
      { id: "T8", text: "eighth" },
    ],
  });
  await runtime.todo.execute("start", { action: "start", id: "T1" });

  await runtime.commands.get("todos").handler("plan", context);
  assert.equal(loadTodoDisplayMode(settingsPath), "plan");
  const plan = widgetFactory(tui, theme).render(80);
  assert.ok(plan.length > 2);
  assert.ok(plan.some((line: string) => line.includes("needs T1")));
  assert.ok(plan.some((line: string) => line.includes("wait: reviewer response")));
  assert.equal(plan.filter((line: string) => line.includes("T1 ")).length, 1);
  assert.ok(plan.every((line: string) => visibleWidth(line) <= 80));

  const narrow = widgetFactory(tui, theme).render(20);
  assert.equal(narrow.length, 1);
  assert.ok(visibleWidth(narrow[0]) <= 20);
  assert.match(narrow[0], /^Todos 0\/8/);

  await runtime.shortcuts.get("ctrl+shift+u").handler(context);
  assert.equal(loadTodoDisplayMode(settingsPath), "compact");
  assert.equal(widgetFactory(tui, theme).render(80).length, 1);
  await runtime.shortcuts.get("ctrl+shift+u").handler(context);
  assert.equal(loadTodoDisplayMode(settingsPath), "plan");

  await runtime.commands.get("todos").handler("full", context);
  assert.equal(overlayOptions.overlay, true);
  assert.equal(overlayOptions.overlayOptions.width, "96%");
  const firstPage = overlay.render(32);
  assert.ok(firstPage.every((line: string) => visibleWidth(line) <= 32));
  assert.ok(firstPage[0].includes("1-4/8"));
  overlay.handleInput("\x1b[F");
  const lastPage = overlay.render(32);
  assert.ok(lastPage[0].includes("5-8/8"));
  assert.ok(renders > 0);

  await runtime.todo.execute("done-one", { action: "done", id: "T1" });
  await runtime.todo.execute("start-two", { action: "start", id: "T2" });
  await runtime.todo.execute("done-two", { action: "done", id: "T2" });
  const updated = widgetFactory(tui, theme).render(80).join("\n");
  assert.match(updated, /Todos 2\/8/);
  assert.doesNotMatch(updated, /T1 first active task/);

  const saved = (await runtime.todo.execute("saved", { action: "list" })).details;
  branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: saved } }];
  runtime.handlers.get("session_tree")?.({}, context);
  assert.match(widgetFactory(tui, theme).render(80).join("\n"), /Todos 2\/8/);
  branch = [];
  runtime.handlers.get("session_tree")?.({}, context);
  assert.equal(widgetFactory, undefined);

  const reloaded = loadTodo(settingsPath);
  let reloadedWidget: any;
  reloaded.handlers.get("session_start")?.({}, {
    ...context,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: saved } }] },
    ui: { ...context.ui, setWidget(_key: string, value: any) { reloadedWidget = value; } },
  });
  assert.ok(reloadedWidget(tui, theme).render(80).length > 2);
  assert.ok(notices.includes("Todo widget: plan"));
});
