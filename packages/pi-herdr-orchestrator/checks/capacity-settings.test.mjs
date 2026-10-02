import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import extension from "../dist/extensions/pi-herdr-orchestrator.js";
import {
  CAPACITY_SETTINGS_FILENAME, DEFAULT_CAPACITY, MAX_CAPACITY, CapacitySettingsError,
  capacitySettingsPath, readCapacitySettings, readCapacitySnapshot, saveCapacitySettings,
} from "../dist/src/orchestrator/capacity.js";

// This test process must never reach live Herdr, settings, or provider credentials.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
globalThis.fetch = async () => { throw new Error("FIXTURE_NETWORK_REFUSED"); };

function registry() {
  const tools = [], commands = new Map(), handlers = new Map();
  extension({
    registerTool: tool => tools.push(tool.name),
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => handlers.set(event, handler),
  });
  return { tools, commands, handlers };
}

function menu(steps) {
  const notices = [], titles = [];
  const context = {
    hasUI: true,
    ui: {
      select: async (title, options) => {
        titles.push(title);
        const step = steps.shift();
        assert(step && step.kind === "select", "unexpected selection request");
        await step.before?.();
        if (step.value === undefined) return undefined;
        const option = options.find(value => value === step.value || value.startsWith(`${step.value}:`));
        assert(option, `missing option: ${step.value}`);
        return option;
      },
      input: async () => {
        const step = steps.shift();
        assert(step && step.kind === "input", "unexpected input request");
        return step.value;
      },
      notify: (message, level) => notices.push({ message, level }),
    },
  };
  return { context, notices, titles, finish: () => assert.equal(steps.length, 0) };
}
const select = (value, before) => ({ kind: "select", value, before });
const input = value => ({ kind: "input", value });
const code = expected => error => error instanceof CapacitySettingsError && error.code === expected && error.message === expected;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "orch-capacity-"));
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("capacity settings use fresh isolated agent-directory reads and private atomic saves", async () => fixture(async root => {
  assert.deepEqual(DEFAULT_CAPACITY, { total: 8, perTab: 4 });
  assert.equal(MAX_CAPACITY, 32);
  const firstPath = capacitySettingsPath();
  assert.equal(firstPath, join(root, "agent", CAPACITY_SETTINGS_FILENAME));
  const defaults = await readCapacitySettings();
  defaults.total = 1;
  assert.deepEqual(await readCapacitySettings(), DEFAULT_CAPACITY);
  await assert.rejects(access(dirname(firstPath)), { code: "ENOENT" });
  await saveCapacitySettings({ total: 1, perTab: 32 }, await readCapacitySnapshot());
  assert.deepEqual(await readCapacitySettings(), { total: 1, perTab: 32 });
  assert.deepEqual(JSON.parse(await readFile(firstPath, "utf8")), { version: 1, total: 1, perTab: 32 });
  assert.equal((await stat(firstPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(firstPath))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dirname(firstPath)), [CAPACITY_SETTINGS_FILENAME]);
  await writeFile(firstPath, JSON.stringify({ version: 1, total: 3, perTab: 2 }));
  assert.deepEqual(await readCapacitySettings(), { total: 3, perTab: 2 });
  const original = await readCapacitySnapshot();
  process.env.PI_CODING_AGENT_DIR = join(root, "other-agent");
  assert.deepEqual(await readCapacitySettings(), DEFAULT_CAPACITY);
  await assert.rejects(saveCapacitySettings({ total: 9, perTab: 5 }, original), code("CAPACITY_SETTINGS_CHANGED"));
  await assert.rejects(access(process.env.PI_CODING_AGENT_DIR), { code: "ENOENT" });
  process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
  assert.equal(capacitySettingsPath(), join(root, "home", "custom-agent", CAPACITY_SETTINGS_FILENAME));
  assert.deepEqual(await readCapacitySettings(), DEFAULT_CAPACITY);
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(capacitySettingsPath(), join(root, "home", ".pi", "agent", CAPACITY_SETTINGS_FILENAME));
  assert.deepEqual(await readCapacitySettings(), DEFAULT_CAPACITY);
}));

test("invalid and unreadable capacity files fail closed without leaking their contents", async () => fixture(async () => {
  const path = capacitySettingsPath();
  await mkdir(dirname(path), { recursive: true });
  for (const raw of ["PRIVATE_FIXTURE_DETAIL", "null", "{}", JSON.stringify({ version: 2, total: 8, perTab: 4 }),
    JSON.stringify({ version: 1, total: 0, perTab: 4 }), JSON.stringify({ version: 1, total: 8, perTab: 33 }),
    JSON.stringify({ version: 1, total: 1.5, perTab: 4 }), JSON.stringify({ version: 1, total: "8", perTab: 4 }),
    JSON.stringify({ version: 1, total: 8, perTab: 4, wait: 8 })]) {
    await writeFile(path, raw);
    await assert.rejects(readCapacitySettings(), code("CAPACITY_SETTINGS_INVALID"));
    assert.equal(await readFile(path, "utf8"), raw);
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(readCapacitySettings(), code("CAPACITY_SETTINGS_UNREADABLE"));
  await rm(path, { recursive: true });
  await symlink(join(dirname(path), "missing"), path);
  await assert.rejects(readCapacitySettings(), code("CAPACITY_SETTINGS_UNREADABLE"));
}));

test("stale and concurrent saves do not overwrite newer preferences", async () => fixture(async () => {
  const absent = await readCapacitySnapshot();
  await saveCapacitySettings({ total: 4, perTab: 2 }, absent);
  const older = await readCapacitySnapshot();
  await saveCapacitySettings({ total: 6, perTab: 3 }, older);
  const newerBytes = await readFile(capacitySettingsPath());
  await assert.rejects(saveCapacitySettings({ total: 8, perTab: 4 }, older), code("CAPACITY_SETTINGS_CHANGED"));
  await assert.rejects(saveCapacitySettings({ total: 8, perTab: 4 }, absent), code("CAPACITY_SETTINGS_CHANGED"));
  assert.deepEqual(await readFile(capacitySettingsPath()), newerBytes);
  const current = await readCapacitySnapshot();
  await assert.rejects(saveCapacitySettings({ total: 1.5, perTab: 4 }, current), code("CAPACITY_SETTINGS_INVALID"));
  const saves = await Promise.allSettled([
    saveCapacitySettings({ total: 9, perTab: 5 }, current),
    saveCapacitySettings({ total: 10, perTab: 6 }, current),
  ]);
  assert.equal(saves.filter(result => result.status === "fulfilled").length, 1);
  const failure = saves.find(result => result.status === "rejected").reason;
  assert(failure instanceof CapacitySettingsError);
  assert(["CAPACITY_SETTINGS_BUSY", "CAPACITY_SETTINGS_CHANGED"].includes(failure.code));
  assert.deepEqual(await readdir(dirname(capacitySettingsPath())), [CAPACITY_SETTINGS_FILENAME]);
}));

test("root menu keeps drafts private until Save, supports defaults, and rejects stale saves", async () => fixture(async () => {
  const { tools, commands } = registry();
  assert.deepEqual(tools, ["orchestrate"]);
  assert.deepEqual([...commands.keys()], ["subagents"]);
  await assert.rejects(access(process.env.PI_CODING_AGENT_DIR), { code: "ENOENT" });
  const command = commands.get("subagents");
  const invoke = async steps => {
    const ui = menu(steps);
    await command.handler("", ui.context);
    ui.finish();
    return ui;
  };
  await invoke([select("Total workers"), input("12"), select("Cancel")]);
  await invoke([select(undefined)]);
  await assert.rejects(access(process.env.PI_CODING_AGENT_DIR), { code: "ENOENT" });
  const saved = await invoke([
    select("Total workers"), input("0"), select("Total workers"), input("1"),
    select("Workers per tab"), input("32"), select("Save", async () => {
      await assert.rejects(access(process.env.PI_CODING_AGENT_DIR), { code: "ENOENT" });
    }),
  ]);
  assert.deepEqual(await readCapacitySettings(), { total: 1, perTab: 32 });
  assert(saved.notices.some(notice => notice.level === "warning" && notice.message.includes("draft has not changed")));
  assert(saved.notices.some(notice => notice.message.includes("Saved subagent capacity")));
  assert(saved.titles.every(title => title.includes("parent/project domain") && title.includes("do not move or terminate")));
  const beforeCancel = await readFile(capacitySettingsPath());
  await invoke([select("Use defaults (8 total, 4 per tab)"), select("Cancel")]);
  assert.deepEqual(await readFile(capacitySettingsPath()), beforeCancel);
  await invoke([select("Use defaults (8 total, 4 per tab)"), select("Save")]);
  assert.deepEqual(await readCapacitySettings(), DEFAULT_CAPACITY);
  const conflict = await invoke([select("Total workers"), input("16"), select("Save", async () => {
    await saveCapacitySettings({ total: 5, perTab: 2 }, await readCapacitySnapshot());
  })]);
  assert.deepEqual(await readCapacitySettings(), { total: 5, perTab: 2 });
  assert(conflict.notices.some(notice => notice.message.startsWith("CAPACITY_SETTINGS_CHANGED:")));
  await writeFile(capacitySettingsPath(), "PRIVATE_FIXTURE_DETAIL");
  const refused = await invoke([]);
  assert.equal(await readFile(capacitySettingsPath(), "utf8"), "PRIVATE_FIXTURE_DETAIL");
  assert(refused.notices.some(notice => notice.message.includes("Back up and repair")));
  assert(refused.notices.every(notice => !notice.message.includes("PRIVATE_FIXTURE_DETAIL")));
  const headless = menu([]);
  headless.context.hasUI = false;
  await command.handler("", headless.context);
  assert(headless.notices.some(notice => notice.message.includes("interactive Pi UI")));
  const withArgs = menu([]);
  await command.handler("total=32", withArgs.context);
  assert(withArgs.notices.some(notice => notice.message.includes("without arguments")));
}));

test("children and failed role resolution never register the capacity command", async () => fixture(async root => {
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => "fixture-session", getSessionFile: () => join(root, "session.jsonl"), getBranch: () => [] },
    ui: { notify() {} },
  };
  try {
    process.env.PI_HERDR_AGENT_ID = "incomplete-fixture-child";
    const child = registry();
    assert.deepEqual(child.tools, []);
    assert.deepEqual([...child.commands.keys()], []);
    await child.handlers.get("session_start")({}, context);
    assert.deepEqual(child.tools, ["subagent_channel"]);
    assert.deepEqual([...child.commands.keys()], []);
    delete process.env.PI_HERDR_AGENT_ID;
    process.env.HERDR_ENV = "1";
    const failed = registry();
    await failed.handlers.get("session_start")({}, context);
    assert.deepEqual(failed.tools, ["subagent_channel"]);
    assert.deepEqual([...failed.commands.keys()], []);
    await assert.rejects(access(process.env.PI_CODING_AGENT_DIR), { code: "ENOENT" });
  } finally {
    delete process.env.PI_HERDR_AGENT_ID;
    delete process.env.HERDR_ENV;
  }
}));
