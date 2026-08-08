import assert from "node:assert/strict";
import test from "node:test";
import groundedDialog from "../packages/dialog/index.ts";

function loadTool() {
  let tool: any;
  groundedDialog({ registerTool(value: any) { tool = value; }, on() {} } as any);
  return tool;
}

test("headless sessions deactivate the question tool", () => {
  let start: Function | undefined;
  let active = ["read", "ask_user_question"];
  groundedDialog({
    registerTool() {},
    on(name: string, handler: Function) { if (name === "session_start") start = handler; },
    getActiveTools() { return active; },
    setActiveTools(next: string[]) { active = next; },
  } as any);
  start?.({}, { hasUI: false });
  assert.deepEqual(active, ["read"]);
});

test("RPC questionnaire exposes previews and decodes selected stable values", async () => {
  const tool = loadTool();
  let choices: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      async select(_prompt: string, values: string[]) {
        choices = values;
        return values[1];
      },
      async input() { return undefined; },
    },
  };
  const result = await tool.execute("q1", { questions: [{
    id: "storage",
    prompt: "Choose storage",
    options: [
      { value: "file", label: "File", description: "simple", preview: "config: file" },
      { value: "db", label: "Database", description: "durable", preview: "config: db" },
    ],
  }] }, undefined, undefined, ctx);
  assert.match(choices[0]!, /Preview:\nconfig: file/);
  assert.equal(result.details.answers[0].value, "db");
  assert.equal(result.details.answers[0].custom, false);
});

test("questionnaire preserves free-form input and rejects ambiguous ids", async () => {
  const tool = loadTool();
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      async select(_prompt: string, values: string[]) { return values.at(-1); },
      async input() { return "  exact custom answer  "; },
    },
  };
  const question = { id: "one", prompt: "Choose", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] };
  const result = await tool.execute("q1", { questions: [question] }, undefined, undefined, ctx);
  assert.equal(result.details.answers[0].value, "exact custom answer");
  await assert.rejects(
    tool.execute("q2", { questions: [question, question] }, undefined, undefined, ctx),
    /unique/,
  );
});
