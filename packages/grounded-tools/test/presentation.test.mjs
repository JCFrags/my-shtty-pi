import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import files from "../files/index.ts";
import processes from "../process/index.ts";

const definitions = new Map();
const host = {
  events: { on() {}, emit() {} },
  on() {}, registerCommand() {},
  registerTool(tool) { definitions.set(tool.name, tool); },
};
// Capture the actual owner registrations without starting a session or any jobs.
files(host);
processes(host);
initTheme("dark", false);

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const result = (body, details, isError = false) => ({ content: [{ type: "text", text: body }], details, isError });
function view(name, args, saved, width, expanded, partial = false) {
  const before = JSON.stringify({ args, saved });
  const component = new ToolExecutionComponent(name, "fixture", freeze(args), { showImages: false }, definitions.get(name), { requestRender() {} }, ".");
  component.updateResult(freeze(saved), partial);
  component.setExpanded(expanded);
  const rows = component.render(width).map(stripTerminalSequences);
  assert.equal(rows[0], "", "Pi owns the preceding separator");
  assert.ok(rows.length <= (expanded ? 11 : 7), `${name}: ${rows.length} rows at ${width}`);
  for (const row of rows) assert.ok(visibleWidth(row) <= width, `${name}: overwide row ${JSON.stringify(row)}`);
  if (expanded) assert.match(rows.join("\n"), /raw: \/export NEW\.jsonl/);
  assert.equal(JSON.stringify({ args, saved }), before, `${name}: renderer mutated saved evidence`);
  return rows.join("\n");
}

const diff = " 1 before\n-2 old\n+2 new\n 3 after\n  ...\n-8 removed\n+8 added";
const wide = "界🙂 e\u0301\t\x1b[31mtext\x1b[0m\r\x00 ".repeat(20);
const fileFixtures = [
  ["read", { path: "skills/demo/SKILL.md" }, result("---\nname: demo\ndescription: >-\n  Read saved evidence\n---\n# Demo\n## Procedure\n" + wide)],
  ["read", { path: "wide.txt", offset: 3, limit: 5 }, result(wide + "\nsecond\nthird")],
  ["edit", { path: "sample.json", edits: [{ oldText: "old", newText: "new" }] }, result("Successfully replaced", { diff, syntax: { checked: true, ok: false, engine: "JSON", message: "SYNTAX_SENTINEL" }, groundedLsp: { diagnostics: [{ severity: 1, message: "LSP_SENTINEL", range: { start: { line: 1 } } }] } })],
  ["write", { path: "sample.txt", content: "DO_NOT_ECHO_INPUT" }, result("Wrote", { diff, syntax: { checked: false, ok: true } })],
  ["edit", { path: "sample.txt", edits: [] }, result("Exact text was not found", undefined, true)],
  ["local_search", { action: "query", strategy: "fuzzy", query: "demo" }, result("No fuzzy matches", { strategy: "fuzzy", hits: [], outcome: "no_matches", complete: false, qualifications: ["non-exhaustive"], warnings: ["Git metadata unavailable"] })],
  ["local_search", { action: "query", strategy: "text", query: "missing" }, result("No matches", { strategy: "text", hits: [], totalHits: 0, outcome: "no_matches", complete: true, qualifications: ["ignore-without-git", "symlinks-not-followed"], warnings: [] })],
];

test("file/search renderers bound visual rows and preserve frozen saved evidence", () => {
  assert.deepEqual([...definitions.keys()], ["read", "edit", "write", "local_search", "bash", "process", "session"]);
  for (const [name, args, saved] of fileFixtures) {
    for (const width of [24, 48, 80]) for (const expanded of [false, true]) view(name, args, saved, width, expanded);
  }
  assert.equal(view(...fileFixtures[0], 80, false).split("\n").length, 2);
  const skill = view(...fileFixtures[0], 80, true);
  assert.match(skill, /Description: Read saved evidence/);
  assert.match(skill, /## Procedure/);
  const edit = view(...fileFixtures[2], 80, false);
  assert.match(edit, /Syntax warning/);
  assert.match(edit, /LSP: 1 diagnostics/);
  assert.match(view(...fileFixtures[2], 80, true), /LSP_SENTINEL/);
  assert.doesNotMatch(view(...fileFixtures[3], 80, true), /DO_NOT_ECHO_INPUT/);
  assert.match(view(...fileFixtures[4], 80, false), /Error/);
  assert.match(view(...fileFixtures[5], 80, false), /no absence proof/);
  assert.match(view(...fileFixtures[6], 80, false), /qualifications/);
  const limited = view("read", { path: "demo/SKILL.md", limit: 1 }, result("---\n\n[9 more lines in file. Use offset=2 to continue.]"), 80, false);
  assert.match(limited, /\[limit 1\]/);
  assert.match(limited, /Requested slice: 1 line/);
  assert.doesNotMatch(limited, /9 more lines/, "do not interpret arbitrary file prose as metadata");
  const manyNotices = result("Saved change", { diff, syntax: { ok: false, message: "invalid" }, groundedLsp: { error: "offline", diagnostics: [{ severity: 1, message: "diagnostic" }], fullOutputPath: "diagnostics.log" }, atomic: false, hardLinkTopologyRollback: false, hardLinksBefore: 2 });
  const crowded = view("edit", { path: "sample.json" }, manyNotices, 80, false);
  assert.match(crowded, /Syntax warning/);
  assert.match(crowded, /LSP error/);
  assert.match(crowded, /4 more notices/);
  assert.match(crowded, /raw: \/export/);
  assert.match(view("edit", { path: "sample.json" }, manyNotices, 80, true), /Hard-link topology/);
});

test("shell/process/session renderers keep failure and lifecycle states without input dumps", () => {
  const fixtures = [
    ["bash", { command: "printf 'DO_NOT_ECHO_SCRIPT'\nprintf ok" }, result("[exited]\nexit_code: 0\n---\nQUIET_STDOUT", { exitCode: 0, running: false })],
    ["bash", { command: "command --private-argument" }, result("[exited]\nexit_code: 2\n---\nerror: FAILURE_SENTINEL", { exitCode: 2, running: false })],
    ["bash", { command: "build" }, result(wide, {}), true],
    ["bash", { command: "build", sessionId: "local-1" }, result("[cancelled: timeout]", { sessionId: "local-1", result: { cancelled: true, timedOut: true } })],
    ["process", { action: "poll", id: "process-1" }, result("[still running]\n---\nworking", { snapshot: { id: "process-1", running: true }, visibleOutputTruncated: true })],
    ["session", { action: "input", sessionId: "local-1", data: "DO_NOT_ECHO_INPUT" }, result("Queued 4 bytes", { snapshot: { id: "local-1", backend: "local", state: "tainted", taintReason: "TAINT_SENTINEL", cwd: "." } })],
    ["session", { action: "close", sessionId: "local-1" }, result("Closed session local-1", { snapshot: null, sessions: [] })],
    ["process", { action: "poll", id: "older" }, result("older saved result", undefined)],
  ];
  for (const [name, args, saved, partial] of fixtures) {
    for (const width of [24, 48, 80]) for (const expanded of [false, true]) {
      const rendered = view(name, args, saved, width, expanded, partial);
      assert.doesNotMatch(rendered, /DO_NOT_ECHO_/);
    }
  }
  assert.doesNotMatch(view(...fixtures[0].slice(0, 3), 80, false), /QUIET_STDOUT/);
  assert.match(view(...fixtures[1].slice(0, 3), 80, false), /Exit 2/);
  assert.match(view(...fixtures[1].slice(0, 3), 80, false), /FAILURE_SENTINEL/);
  assert.match(view(...fixtures[2].slice(0, 3), 80, false, true), /Running · partial/);
  assert.match(view(...fixtures[3].slice(0, 3), 80, false), /Cancelled · timeout/);
  assert.match(view(...fixtures[4].slice(0, 3), 80, false), /Running/);
  assert.match(view(...fixtures[5].slice(0, 3), 80, false), /Input queued · tainted/);
  assert.match(view(...fixtures[5].slice(0, 3), 80, false), /TAINT_SENTINEL/);
  assert.match(view(...fixtures[6].slice(0, 3), 80, false), /Session closed/);
  assert.match(view(...fixtures[7].slice(0, 3), 80, false), /Status not recorded/);
  const entries = Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}`, running: false, exitCode: index === 7 ? 2 : 0 }));
  const listed = view("process", { action: "list" }, result("saved list", { sessions: entries }), 80, false);
  assert.match(listed, /1 failed exits/);
  assert.ok(listed.indexOf("p1 · Exit 0") < listed.indexOf("p2 · Exit 0"));
  const mixed = entries.map((entry, index) => index === 5 ? { id: entry.id } : index === 6 ? { id: entry.id, cancelled: true } : entry);
  const states = view("process", { action: "list" }, result("saved list", { sessions: mixed }), 80, false);
  assert.match(states, /1 failed exits/);
  assert.match(states, /1 cancelled/);
  assert.match(states, /1 unknown status/);
});
