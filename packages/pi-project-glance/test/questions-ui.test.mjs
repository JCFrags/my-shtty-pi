import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ProjectGlanceQuestionsRegion } from "../dist/pane/questions.js";

const options = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta", description: "Second choice" }];
const question = (kind = "single", patch = {}) => ({
  id: "q-one", displayId: "Q-1", revision: 1, state: "pending", question: "Choose a result",
  reason: "A synthetic question", response: { kind, ...(kind === "text" ? {} : { options }) }, ...patch,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(q = question(), callback) {
  const actions = [];
  let renders = 0;
  const region = new ProjectGlanceQuestionsRegion(callback ?? ((action) => { actions.push(action); }), () => renders++);
  region.update([q], "session:branch-A");
  return { region, actions, renders: () => renders };
}
const plain = (region, width = 80) => region.render(width).map(stripTerminalSequences);
function event(y, width = 80, type = "click", x = 2) {
  return { type, button: "left", x, y, screenX: x, screenY: y, width, height: 40, shift: false, alt: false, ctrl: false };
}
function click(region, text, width = 80) {
  const row = plain(region, width).findIndex((line) => line.includes(text));
  assert.notEqual(row, -1, `missing control ${text}`);
  const result = region.handleMouse(event(row, width));
  assert.equal(result?.handled, true);
  assert.equal(result?.focus, true);
}
function edit(region, text) {
  const rows = plain(region);
  const label = rows.findIndex((line) => line === "Answer:" || line === "Or type an answer:");
  assert.notEqual(label, -1);
  region.handleMouse(event(label + 1));
  assert.equal(region.isEditing, true);
  region.handleInput(text);
}

test("no questions render no lines and do not own input", () => {
  const { region } = setup();
  region.focused = true;
  region.update([], "session:branch-A");
  assert.deepEqual(region.render(80), []);
  assert.equal(region.ownsKeyboard, false);
  assert.equal(region.handleInput("q"), false);
  assert.equal(region.handleMouse(event(0)), undefined);
});

test("single choice needs explicit Submit; recommendations/defaults never select", async () => {
  const { region, actions } = setup(question("single", { recommendedOptionIds: ["a"], recommendedText: "suggested", temporaryDefault: { optionIds: ["a"], disclosure: "Fallback only" } }));
  assert.match(plain(region).join("\n"), /Suggested options: a/);
  click(region, "[Submit]");
  await tick();
  assert.deepEqual(actions, []);
  click(region, "Alpha");
  click(region, "Beta");
  assert.equal(actions.length, 0);
  click(region, "[Submit]");
  await tick();
  assert.deepEqual(actions, [{ type: "question_answer", questionId: "q-one", expectedRevision: 1, answer: { optionIds: ["b"] } }]);
  assert.match(plain(region).join("\n"), /Submitted/);
  assert.doesNotMatch(plain(region).join("\n"), /\[Submit\]/);
});

test("multiple choices toggle independently", async () => {
  const { region, actions } = setup(question("multiple"));
  click(region, "Alpha"); click(region, "Beta"); click(region, "Alpha"); click(region, "Alpha");
  click(region, "[Submit]");
  await tick();
  assert.deepEqual(actions[0].answer.optionIds, ["b", "a"]);
});

for (const kind of ["text", "single_or_text", "multiple_or_text"]) {
  test(`${kind}: canonical Input owns typing and Enter does not submit`, async () => {
    const { region, actions } = setup(question(kind));
    if (kind !== "text") click(region, "Alpha");
    edit(region, "q jk");
    assert.equal(region.ownsKeyboard, true);
    assert.ok(region.render(80).some((line) => line.includes("\x1b_")), "canonical cursor marker is propagated");
    region.handleInput("\x7f");
    region.handleInput("k");
    region.handleInput("\r");
    await tick();
    assert.equal(actions.length, 0);
    assert.equal(region.isEditing, false);
    region.handleInput("\r");
    await tick();
    assert.deepEqual(actions[0].answer, { optionIds: [], text: "q jk" });
  });
}

test("selecting an option explicitly replaces alternative text", async () => {
  const { region, actions } = setup(question("single_or_text"));
  edit(region, "typed"); click(region, "Beta"); click(region, "[Submit]");
  await tick();
  assert.deepEqual(actions[0].answer, { optionIds: ["b"] });
});

test("Cancel is an explicit action; escape and feed keys do not cancel", async () => {
  const { region, actions } = setup();
  region.focused = true;
  for (const key of ["q", "j", "k", "\x1b"]) assert.equal(region.handleInput(key), true);
  await tick();
  assert.equal(actions.length, 0);
  click(region, "[Cancel]");
  await tick();
  assert.deepEqual(actions[0], { type: "question_cancel", questionId: "q-one", expectedRevision: 1 });
  assert.match(plain(region).join("\n"), /Cancelled/);
});

test("delivery_failed shows answer and explicit Retry; submitted is read-only", async () => {
  const { region, actions } = setup(question("text", { state: "delivery_failed", answer: { optionIds: [], text: "kept answer" }, failure: "Delivery failed" }));
  assert.match(plain(region).join("\n"), /kept answer/);
  click(region, "[Retry]");
  await tick();
  assert.deepEqual(actions[0], { type: "question_retry", questionId: "q-one", expectedRevision: 1 });
  region.update([question("text", { revision: 2, state: "submitted" })], "session:branch-A");
  assert.match(plain(region).join("\n"), /submitted/);
  assert.doesNotMatch(plain(region).join("\n"), /\[(Retry|Submit|Cancel)\]/);
  assert.equal(region.isEditing, false);
});

test("same-question snapshots preserve draft/selection; revision, id and branch reset them", async () => {
  const { region, actions } = setup(question("single_or_text"));
  click(region, "Alpha");
  region.update([question("single_or_text")], "session:branch-A");
  assert.match(plain(region).join("\n"), /\[x Alpha\]/);
  edit(region, "draft");
  region.update([question("single_or_text", { reason: "new display" })], "session:branch-A");
  assert.match(plain(region).join("\n"), /draft/);
  region.update([question("single_or_text", { revision: 2 })], "session:branch-A");
  assert.doesNotMatch(plain(region).join("\n"), /draft|\[x Alpha\]/);
  edit(region, "branch draft");
  region.update([question("single_or_text", { revision: 2 })], "session:branch-B");
  assert.doesNotMatch(plain(region).join("\n"), /branch draft/);
  edit(region, "id draft");
  region.update([question("single_or_text", { id: "q-two", revision: 2 })], "session:branch-B");
  assert.doesNotMatch(plain(region).join("\n"), /id draft/);
  click(region, "[Submit]"); await tick(); assert.equal(actions.length, 0);
});

test("chooser is capped at four, Prev/Next resets changed-question draft", () => {
  const { region } = setup();
  region.update(Array.from({ length: 5 }, (_, i) => question("text", { id: `q-${i}`, displayId: `Q-${i}` })), "A");
  edit(region, "draft");
  click(region, "[Next]");
  assert.match(plain(region).join("\n"), /QUESTIONS 2\/4/);
  assert.doesNotMatch(plain(region).join("\n"), /draft/);
  click(region, "[Prev]");
  assert.match(plain(region).join("\n"), /QUESTIONS 1\/4/);
  assert.doesNotMatch(plain(region).join("\n"), /draft/);
});

test("bounded narrow/wide rendering and resized mouse targets emit no OSC8", async () => {
  const { region, actions } = setup(question("multiple_or_text", {
    question: "Long 界 question ".repeat(200), reason: "reason ".repeat(200),
    recommendation: "recommendation ".repeat(200), recommendedOptionIds: ["a"], recommendedText: "text ".repeat(200),
    temporaryDefault: { optionIds: ["a"], disclosure: "default ".repeat(200) },
    response: { kind: "multiple_or_text", options: Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, label: `Choice ${i} 界`.repeat(20) })) },
  }));
  for (const width of [0, 1, 2, 8, 20, 80, 200, 12, 80]) {
    const lines = region.render(width);
    assert.ok(lines.length <= 28);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
      assert.ok(!line.includes("\x1b]8"));
    }
  }
  const row = plain(region, 20).findIndex((line) => line.includes("Choice 0"));
  region.render(80);
  assert.equal(region.handleMouse(event(row, 20))?.handled, true);
  click(region, "[Submit]", 20);
  await tick();
  assert.deepEqual(actions[0].answer.optionIds, ["0"]);
});

test("mouse press only focuses options, click activates once; blank question area consumes click", () => {
  const { region } = setup();
  const row = plain(region).findIndex((line) => line.includes("Alpha"));
  region.handleMouse(event(row, 80, "press"));
  assert.doesNotMatch(plain(region).join("\n"), /\[x Alpha\]/);
  region.handleMouse(event(row));
  assert.match(plain(region).join("\n"), /\[x Alpha\]/);
  assert.equal(region.handleMouse(event(0))?.handled, true);
  assert.equal(region.handleMouse(event(100)), undefined);
  assert.equal(region.handleMouse(event(0, 80, "wheel")), undefined);
  region.focused = false;
  assert.equal(region.handleInput("q"), false);
});

test("inflight actions cannot double-submit and old completion cannot affect another question", async () => {
  let resolve;
  const actions = [];
  const { region } = setup(question("text"), (action) => { actions.push(action); return new Promise((r) => { resolve = r; }); });
  edit(region, "draft"); click(region, "[Submit]");
  region.handleInput("\r");
  await tick();
  assert.equal(actions.length, 1);
  assert.match(plain(region).join("\n"), /Sending/);
  region.update([question("text", { revision: 2 })], "session:branch-A");
  resolve(); await tick();
  assert.doesNotMatch(plain(region).join("\n"), /Submitted|Sending/);
});

test("callback failure preserves draft and permits explicit retry without leaking error details", async () => {
  let attempts = 0;
  const { region } = setup(question("text"), () => { if (++attempts === 1) throw new Error("private error detail"); });
  edit(region, "draft"); click(region, "[Submit]"); await tick();
  assert.match(plain(region).join("\n"), /draft/);
  assert.match(plain(region).join("\n"), /Action failed/);
  assert.doesNotMatch(plain(region).join("\n"), /private error/);
  click(region, "[Submit]"); await tick();
  assert.equal(attempts, 2);
  assert.match(plain(region).join("\n"), /Submitted/);
});

test("authoritative delivery failure replaces optimistic Submitted even at the same revision", async () => {
  const { region, actions } = setup(question("text"));
  edit(region, "draft"); click(region, "[Submit]"); await tick();
  region.update([question("text", { state: "delivery_failed", answer: { optionIds: [], text: "draft" } })], "session:branch-A");
  assert.doesNotMatch(plain(region).join("\n"), /Submitted/);
  click(region, "[Retry]"); await tick();
  assert.equal(actions[1].type, "question_retry");
});

test("oversized UTF-8 answers are not dispatched", async () => {
  const { region, actions } = setup(question("text"));
  edit(region, "界".repeat(1400)); click(region, "[Submit]"); await tick();
  assert.equal(actions.length, 0);
  assert.match(plain(region).join("\n"), /too long/);
});
