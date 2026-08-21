import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import groundedNotes, { NOTES_DESCRIPTION, NOTES_GUIDELINES, NOTES_PROMPT_SNIPPET, NotesParams } from "../packages/notes/index.ts";
import groundedTasks from "../packages/tasks/index.ts";
import groundedWorkplan, { WORKPLAN_DESCRIPTION, WORKPLAN_GUIDELINES, WORKPLAN_PROMPT_SNIPPET, WorkplanParams } from "../packages/workplan/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function json(path: string) { return JSON.parse(await readFile(join(root, path), "utf8")); }
async function absent(path: string) { await assert.rejects(access(join(root, path))); }
function load(factory: Function, name: string) {
  let tool: any;
  factory({ registerTool(value: any) { if (value.name === name) tool = value; }, registerCommand() {}, on() {}, appendEntry() {} } as any);
  return tool;
}

test("Gate A root order, package inventory, core exports, peers, and bundled core are exact", async () => {
  const pkg = await json("package.json");
  assert.deepEqual(pkg.pi.extensions, [
    "./packages/files/index.ts", "./packages/process/index.ts", "./packages/lsp/index.ts", "./packages/dialog/index.ts",
    "./packages/tasks/index.ts", "./packages/notes/index.ts", "./packages/workplan/index.ts",
  ]);
  assert.deepEqual((await readdir(join(root, "packages"))).sort(), ["core", "dialog", "files", "lsp", "notes", "process", "tasks", "workplan"]);
  assert.deepEqual(pkg.bundledDependencies, ["@grounded/pi-core"]);
  for (const value of Object.values(pkg.peerDependencies)) assert.equal(value, "*");
  const core = await json("packages/core/package.json");
  assert.equal(core.exports["./state"], "./src/state.ts");
  assert.equal(core.exports["./notes"], "./src/notes.ts");
  assert.equal(core.exports["./workplan"], "./src/workplan.ts");
  assert.equal(core.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  for (const name of ["notes", "workplan"]) {
    const feature = await json(`packages/${name}/package.json`);
    assert.equal(feature.version, "0.1.0");
    assert.deepEqual(feature.pi.extensions, ["./index.ts"]);
    assert.equal(feature.dependencies["@grounded/pi-core"], "0.1.0");
    assert.deepEqual(feature.bundledDependencies, ["@grounded/pi-core"]);
    assert.deepEqual(feature.peerDependencies, { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*", typebox: "*" });
    assert.equal(feature.scripts, undefined);
  }
});

test("todo-owned files retain exact reviewed SHA-256 values", async () => {
  const expected = new Map([
    ["packages/core/src/tasks.ts", "f13e07833f0b5a64cf2298c33a4727f7739d29204a887452b7259d246b0a9392"],
    ["packages/tasks/index.ts", "a831a07aff0698d5aae6a2ad57482c02eee63987cd9fda72ed53a8407b69f268"],
    ["packages/tasks/package.json", "3ebaef6925127d0bbd9e46e46ddf9dcfff8b266f3568833e4df6d4c94313b039"],
    ["packages/tasks/README.md", "70bfc9b1cddf9e98d79fbc1b62b8c84055f947fe6183e124825856b4f448195a"],
    ["tests/tasks.test.ts", "849f541db8ee55369dc0856aa17e2e31088fb8ef06fa920e796429db59587c1f"],
    ["tests/tasks-extension.test.ts", "74e4c22fa6786714f139dfb7add9f030b675ae9daf5f8d75fa48dd5498bde6ac"],
  ]);
  for (const [path, digest] of expected) assert.equal(sha(await readFile(join(root, path))), digest, path);
});

test("todo and workplan stay behaviorally separate in both directions", async () => {
  const todo = load(groundedTasks, "todo");
  const workplan = load(groundedWorkplan, "workplan");
  await todo.execute("t1", { action: "add", text: "task" });
  await workplan.execute("w1", { action: "create", content: { title: "p", objective: "o", approach: "a" } });
  await workplan.execute("w2", { action: "add_milestone", planId: "WP1", expectedRevision: 1, content: { title: "m" } });
  await workplan.execute("w3", { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 2, content: { status: "in_progress", linkedTodoIds: ["T1"] } });
  await todo.execute("t2", { action: "done", id: "T1" });
  const before = await workplan.execute("s1", { action: "status", planId: "WP1" });
  assert.equal(before.details.result.milestones.completed, 0);
  await workplan.execute("w4", { action: "update_milestone", planId: "WP1", milestoneId: "WP1-M1", expectedRevision: 3, content: { evidence: ["proof"], status: "completed" } });
  assert.equal((await todo.execute("t3", { action: "list" })).details.state.tasks[0].status, "done");
  await todo.execute("t4", { action: "remove", id: "T1" });
  assert.equal((await workplan.execute("s2", { action: "status", planId: "WP1" })).details.result.milestones.completed, 1);
});

test("no workplan export module, action, input, helper import, or direct file side effect exists", async () => {
  for (const path of ["packages/core/src/workplan-export.ts", "packages/workplan/export.ts", "tests/workplan-export.test.ts"]) await absent(path);
  const core = await readFile(join(root, "packages/core/src/workplan.ts"), "utf8");
  const extension = await readFile(join(root, "packages/workplan/index.ts"), "utf8");
  assert.equal(/node:(fs|path)|withFileMutationQueue|atomic|rename|symlink|hardLink|resolveToolPath|persistOutput/.test(core), false);
  assert.equal(/node:(fs|path)|withFileMutationQueue|atomic|rename|symlink|hardLink|resolveToolPath|write\s*\(/.test(extension), false);
  assert.equal(JSON.stringify(WorkplanParams).includes('"export"'), false);
  for (const field of ["path", "expectedDigest", "destination", "fileHandle"]) assert.equal(Object.hasOwn(WorkplanParams.properties, field), false);
});

test("Gate A runtime, manifests, lock records, tools, schemas, events, context, and artifacts contain no goal feature", async () => {
  for (const path of ["packages/core/src/goal.ts", "packages/goal", "tests/goal.test.ts", "tests/goal-extension.test.ts"]) await absent(path);
  const pkg = await json("package.json");
  const lock = await readFile(join(root, "package-lock.json"), "utf8");
  assert.equal(JSON.stringify(pkg).includes("@grounded/pi-goal"), false);
  assert.equal(lock.includes("@grounded/pi-goal"), false);
  assert.equal(pkg.pi.extensions.some((entry: string) => /goal/.test(entry)), false);
  const registered: string[] = [];
  const contexts: Function[] = [];
  const api = { registerTool(value: any) { registered.push(value.name); }, on(name: string, handler: Function) { if (name === "context") contexts.push(handler); } };
  groundedNotes(api as any); groundedWorkplan(api as any);
  assert.deepEqual(registered, ["notes", "workplan"]);
  assert.equal(JSON.stringify([NotesParams, WorkplanParams]).includes('"goal"'), false);
  for (const handler of contexts) {
    const result = handler({ messages: [] }, { sessionManager: { getBranch: () => [] } });
    assert.equal(JSON.stringify(result ?? {}).includes("[goal state]"), false);
  }
  const stateSources = await Promise.all(["state.ts", "notes.ts", "workplan.ts"].map((name) => readFile(join(root, "packages/core/src", name), "utf8")));
  for (const source of stateSources) assert.equal(/before_provider_request|turn_end|agent_settled|continuation|retry hook/i.test(source), false);
});

test("state core and extension imports preserve the security boundary", async () => {
  const pure = await Promise.all(["notes.ts", "workplan.ts"].map((name) => readFile(join(root, "packages/core/src", name), "utf8")));
  for (const source of pure) {
    for (const prohibited of ["@earendil-works/pi-", "node:fs", "node:path", "node:child_process", "process.env", ".agents", "ACTIVE_GOAL", "WORKSPACE_PLAN", "GROUNDED_STATE_TOOLS"]) assert.equal(source.includes(prohibited), false, prohibited);
  }
  for (const name of ["notes", "workplan"]) {
    const source = await readFile(join(root, `packages/${name}/index.ts`), "utf8");
    for (const prohibited of ["node:fs", "node:path", "node:child_process", "process.env", "@grounded/pi-core/tasks", "appendEntry(", "sendMessage("]) assert.equal(source.includes(prohibited), false, `${name}: ${prohibited}`);
  }
  const workplan = await readFile(join(root, "packages/core/src/workplan.ts"), "utf8");
  const tasks = await readFile(join(root, "packages/core/src/tasks.ts"), "utf8");
  assert.equal(workplan.includes("./tasks"), false);
  assert.equal(tasks.includes("workplan"), false);
});

test("combined schema, descriptions, snippets, and guidelines meet the total metadata budget", () => {
  const schemaBytes = Buffer.byteLength(JSON.stringify(NotesParams)) + Buffer.byteLength(JSON.stringify(WorkplanParams));
  assert.ok(schemaBytes <= 3600);
  const total = schemaBytes + Buffer.byteLength(NOTES_DESCRIPTION) + Buffer.byteLength(WORKPLAN_DESCRIPTION)
    + Buffer.byteLength(NOTES_PROMPT_SNIPPET) + Buffer.byteLength(WORKPLAN_PROMPT_SNIPPET)
    + Buffer.byteLength(NOTES_GUIDELINES.join("\n")) + Buffer.byteLength(WORKPLAN_GUIDELINES.join("\n"));
  assert.ok(total <= 6000);
});
