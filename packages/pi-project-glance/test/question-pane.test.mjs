import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ProjectGlancePaneView } from "../dist/pane/main.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";

const sessionKey = "a".repeat(64);
const generation = "b".repeat(32);
const nextGeneration = "c".repeat(32);
const at = "2026-09-03T00:00:00.000Z";
const id = "qst_00000000-0000-4000-8000-000000000001";
const question = (patch = {}) => ({
  id, displayId: "Q-1", revision: 1, state: "pending", question: "Choose a synthetic answer", reason: "Synthetic question pane fixture",
  response: { kind: "single_or_text", options: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }] }, ...patch,
});
const snapshot = (patch = {}) => ({
  protocolVersion: 1, sessionKey, revision: 1, generatedAt: at, branchId: "A",
  current: { step: "Synthetic CURRENT remains pinned" },
  feed: Array.from({ length: 12 }, (_, i) => ({ id: `item${i}`, type: "assistant_update", text: `Feed fixture ${i}\nSecond line\nThird line\nFourth line`, createdAt: at })),
  uiState: { dismissedIds: [], readIds: [] }, ...patch,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function findBox(box, component) {
  if (box.component === component) return box;
  for (const child of box.children ?? []) { const found = findBox(child, component); if (found) return found; }
  return undefined;
}
function harness(t, { width = 80, height = 36, questions = [question()], feed } = {}) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const terminal = {
    columns: width, rows: height,
    start(input, resize) { this.input = input; this.resize = resize; },
    stop() {}, write() {}, hideCursor() {}, showCursor() {},
  };
  const model = new ProjectGlancePaneModel(sessionKey, generation);
  model.applySnapshot(snapshot({ questions, ...(feed ? { feed } : {}) }), { sessionKey, generation });
  const actions = [];
  const feedHits = [];
  let quitCount = 0;
  let feedKeys = 0;
  let tui;
  const view = new ProjectGlancePaneView(model, (url) => {
    feedHits.push(url);
    const target = new URL(url);
    if (target.hostname === "toggle") model.toggleExpanded(target.pathname.slice(1));
    tui.requestRender();
  }, {
    onQuestionAction: (action) => { actions.push(action); },
    requestRender: () => tui?.requestRender(),
    onQuestionFocusExit: () => tui?.setFocus(null),
    onQuestionFocusEnter: () => tui?.setFocus(view.questions),
  });
  tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, wheelScrollLines: 3 });
  const removeInput = tui.addInputListener((data) => {
    if (view.handleQuestionInput(data)) return { consume: true };
    if (data === "q" || data === "Q" || data === "\x1b") { quitCount++; return { consume: true }; }
    if (data === "j" || data === "k" || data === " ") {
      feedKeys++;
      if (data === " ") model.toggleExpanded(model.selectedId);
      else model.selectRelative(data === "j" ? 1 : -1);
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });
  tui.setLayoutRoot(view.root);
  tui.start();
  tui.renderNow();
  t.after(() => {
    removeInput(); tui.setLayoutRoot(undefined); tui.stop();
    view.scrollView.hideTransientScrollbar(); view.questionScrollView.hideTransientScrollbar();
  });
  const rows = () => tui.currentLayout.lines.map(stripTerminalSequences);
  const box = (component) => findBox(tui.currentLayout.root, component);
  const click = (x, y) => {
    now += 1000;
    terminal.input(`\x1b[<0;${x + 1};${y + 1}M`); tui.renderNow();
    terminal.input(`\x1b[<0;${x + 1};${y + 1}m`); tui.renderNow();
  };
  const showQuestionText = (text) => {
    const scroll = view.questionScrollView;
    scroll.scrollToStart(); tui.renderNow();
    for (let i = 0; i < 40; i++) {
      const bounds = box(scroll).rect;
      const y = rows().findIndex((line, y) => y >= bounds.y && y < bounds.y + bounds.height && line.includes(text));
      if (y >= 0) return { x: Math.max(1, rows()[y].indexOf(text)), y };
      scroll.scrollBy(1); tui.renderNow();
    }
    assert.fail(`question text not reachable: ${text}\n${rows().join("\n")}`);
  };
  const clickQuestion = (text) => { const { x, y } = showQuestionText(text); click(x, y); };
  const resize = (width, height) => { terminal.columns = width; terminal.rows = height; terminal.resize(); tui.renderNow(); };
  return { terminal, model, view, tui, rows, box, click, showQuestionText, clickQuestion, resize, actions, feedHits, quitCount: () => quitCount, feedKeys: () => feedKeys };
}

for (const [width, height] of [[80, 36], [24, 24], [20, 18]]) {
  test(`full SGR option/Submit routing at ${width}x${height} does not touch feed`, async (t) => {
    const h = harness(t, { width, height });
    const current = h.rows().slice(0, h.box(h.view.pinned).rect.height);
    h.clickQuestion("Alpha");
    assert.equal(h.actions.length, 0);
    assert.equal(h.view.questions.ownsKeyboard, true);
    assert.deepEqual(h.feedHits, []);
    h.clickQuestion("[Submit]"); await tick(); h.tui.renderNow();
    assert.deepEqual(h.actions, [{ type: "question_answer", questionId: id, expectedRevision: 1, answer: { optionIds: ["alpha"] } }]);
    assert.deepEqual(h.feedHits, []);
    assert.equal(h.model.isExpanded("item0"), false);
    assert.deepEqual(h.rows().slice(0, current.length), current);
    assert.ok(h.view.questionScrollView.viewportHeight <= 14);
    const remaining = height - current.length;
    assert.ok(h.view.questionScrollView.viewportHeight <= Math.floor(remaining / 2));
    assert.ok(h.view.scrollView.viewportHeight >= Math.ceil(remaining / 2));
    for (const line of h.tui.currentLayout.lines) assert.ok(visibleWidth(line) <= width);
  });
}

test("full SGR text editing suppresses q/space/j/k and Enter requires explicit Submit", async (t) => {
  const h = harness(t, { width: 24, height: 24 });
  h.clickQuestion("Type an answer");
  assert.equal(h.view.questions.isEditing, true);
  for (const key of ["q", " ", "j", "k"]) h.terminal.input(key);
  h.tui.renderNow();
  assert.equal(h.quitCount(), 0);
  assert.equal(h.feedKeys(), 0);
  assert.equal(h.model.isExpanded("item0"), false);
  h.terminal.input("\r"); h.tui.renderNow();
  assert.equal(h.actions.length, 0);
  assert.ok(h.rows().some((line) => line.includes(">[Submit]")), "keyboard navigation reveals Submit inside question scroll");
  h.clickQuestion("[Submit]"); await tick(); h.tui.renderNow();
  assert.deepEqual(h.actions[0].answer, { optionIds: [], text: "q jk" });
  assert.deepEqual(h.feedHits, []);
});

test("Escape exits editing then focus before quit; Tab returns to questions", (t) => {
  const h = harness(t);
  h.clickQuestion("Type an answer");
  h.terminal.input("draft");
  h.terminal.input("\x1b"); h.tui.renderNow();
  assert.equal(h.view.questions.isEditing, false);
  assert.equal(h.view.questions.ownsKeyboard, true);
  assert.equal(h.quitCount(), 0);
  h.terminal.input("\x1b"); h.tui.renderNow();
  assert.equal(h.view.questions.ownsKeyboard, false);
  assert.equal(h.quitCount(), 0);
  h.terminal.input("\t"); h.tui.renderNow();
  assert.equal(h.view.questions.ownsKeyboard, true);
  h.terminal.input("\x1b"); h.terminal.input("q");
  assert.equal(h.quitCount(), 1);
  assert.deepEqual(h.actions, []);
});

test("resized/scrolled full SGR Dismiss and Retry delivery remain isolated from feed", async (t) => {
  const h = harness(t);
  h.clickQuestion("Alpha");
  h.resize(20, 18);
  h.clickQuestion("[Dismiss witho"); await tick(); h.tui.renderNow();
  assert.equal(h.actions[0].type, "question_dismiss");
  h.model.applySnapshot(snapshot({ revision: 2, questions: [question({ revision: 2, state: "delivery_failed", answer: { optionIds: ["alpha"] }, failure: "Synthetic delivery failure" })] }), { sessionKey, generation });
  h.view.invalidate(); h.resize(50, 30);
  h.clickQuestion("[Retry delivery]"); await tick(); h.tui.renderNow();
  assert.equal(h.actions[1].type, "question_retry");
  assert.equal(h.actions[1].expectedRevision, 2);
  assert.deepEqual(h.feedHits, []);
});

test("question wheel stays contained; feed click restores feed key ownership", (t) => {
  const h = harness(t, { width: 40, height: 22 });
  h.clickQuestion("Alpha");
  const current = h.rows().slice(0, h.box(h.view.pinned).rect.height);
  const qbox = h.box(h.view.questionScrollView).rect;
  const before = h.view.scrollView.scrollTop;
  for (let i = 0; i < 10; i++) {
    h.terminal.input(`\x1b[<65;3;${qbox.y + 2}M`); h.tui.renderNow();
  }
  assert.ok(h.view.questionScrollView.scrollTop > 0);
  assert.equal(h.view.scrollView.scrollTop, before);
  assert.deepEqual(h.rows().slice(0, current.length), current);
  const y = h.rows().findIndex((line) => /[●•] [▸▾]/u.test(line));
  assert.ok(y >= 0);
  const x = h.rows()[y].indexOf("▸");
  h.click(x, y);
  assert.equal(h.feedHits.length, 1);
  assert.equal(h.model.isExpanded("item0"), true);
  assert.equal(h.view.questions.ownsKeyboard, false);
  h.terminal.input("j");
  assert.equal(h.feedKeys(), 1);
  assert.equal(h.model.selectedId, "item1");
});

test("no-question layout preserves the two-child baseline and feed clicks", (t) => {
  const h = harness(t, { questions: [] });
  assert.equal(h.tui.currentLayout.root.children.length, 2);
  assert.equal(h.tui.currentLayout.root.children[0].component, h.view.pinned);
  assert.equal(h.tui.currentLayout.root.children[1].component, h.view.scrollView);
  assert.equal(h.box(h.view.questionScrollView), undefined);
  assert.equal(h.rows().some((line) => line.includes("QUESTIONS")), false);
  const y = h.rows().findIndex((line) => /[●•] [▸▾]/u.test(line));
  h.click(h.rows()[y].indexOf("▸"), y);
  assert.equal(h.feedHits.length, 1);
  assert.equal(h.model.isExpanded("item0"), true);
  h.resize(20, 14);
  assert.equal(h.tui.currentLayout.root.children.length, 2);
});

test("draft survives normal snapshots but disconnect, relay generation and branch clear it", (t) => {
  const h = harness(t);
  h.clickQuestion("Type an answer"); h.terminal.input("draft-one"); h.tui.renderNow();
  h.model.applySnapshot(snapshot({ revision: 2, questions: [question()] }), { sessionKey, generation });
  h.view.invalidate(); h.tui.renderNow();
  assert.ok(h.rows().some((line) => line.includes("draft-one")));
  h.model.setConnectionState("disconnected"); h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.box(h.view.questionScrollView), undefined);
  assert.equal(h.view.questions.ownsKeyboard, false);
  h.model.setConnectionState("connected"); h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.rows().some((line) => line.includes("draft-one")), false);
  h.clickQuestion("Type an answer"); h.terminal.input("draft-two");
  h.model.setExpectedRelay({ sessionKey, generation: nextGeneration }); h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.box(h.view.questionScrollView), undefined);
  h.model.applySnapshot(snapshot({ questions: [question()] }), { sessionKey, generation: nextGeneration }); h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.rows().some((line) => line.includes("draft-two")), false);
  h.clickQuestion("Type an answer"); h.terminal.input("draft-three");
  h.model.applySnapshot(snapshot({ revision: 2, branchId: "B", questions: [question()] }), { sessionKey, generation: nextGeneration }); h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.rows().some((line) => line.includes("draft-three")), false);
});

test("question arrivals/removal preserve baseline and hidden tiny viewport does not retain focus", (t) => {
  const h = harness(t, { questions: [] });
  assert.equal(h.view.root.children.length, 2);
  h.model.applySnapshot(snapshot({ revision: 2, questions: [question()] }), { sessionKey, generation });
  h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.view.root.children.length, 3);
  h.clickQuestion("Type an answer");
  h.terminal.input("draft");
  const pinnedHeight = h.box(h.view.pinned).rect.height;
  h.resize(80, pinnedHeight + 1);
  assert.equal(h.box(h.view.questionScrollView), undefined);
  assert.equal(h.view.questions.ownsKeyboard, false);
  assert.equal(h.view.scrollView.viewportHeight, 1);
  h.terminal.input("\t");
  assert.equal(h.view.questions.ownsKeyboard, false);
  h.resize(80, 36);
  h.model.applySnapshot(snapshot({ revision: 3, questions: [] }), { sessionKey, generation });
  h.view.invalidate(); h.tui.renderNow();
  assert.equal(h.view.root.children.length, 2);
  assert.equal(h.tui.currentLayout.root.children.length, 2);
});

test("question frame has fixed edges between CURRENT and feed through scrolling and tiny resizes", (t) => {
  const h = harness(t);
  for (const [width, height] of [[80, 36], [24, 24], [20, 18], [8, 36], [3, 36], [2, 36], [1, 6], [80, 10], [80, 36]]) {
    h.resize(width, height);
    const q = h.box(h.view.questionScrollView)?.rect;
    if (!q) { assert.equal(h.view.questions.ownsKeyboard, false); continue; }
    const current = h.box(h.view.pinned).rect;
    const feed = h.box(h.view.scrollView).rect;
    assert.equal(q.x, 1);
    assert.equal(q.width, width - 2);
    assert.equal(q.y, current.y + current.height + 1);
    assert.equal(q.y + q.height + 1, feed.y);
    const top = h.rows()[q.y - 1];
    const bottom = h.rows()[q.y + q.height];
    assert.ok(top.startsWith("┌") && top.endsWith("┐"));
    assert.ok(bottom.startsWith("└") && bottom.endsWith("┘"));
    for (let y = q.y; y < q.y + q.height; y++) assert.ok(h.rows()[y].startsWith("│") && h.rows()[y].endsWith("│"));
    const feedTop = h.view.scrollView.scrollTop;
    h.terminal.input(`\x1b[<65;1;${q.y}M`); h.tui.renderNow();
    h.view.questionScrollView.scrollToEnd(); h.tui.renderNow();
    assert.equal(h.rows()[q.y - 1], top);
    assert.equal(h.rows()[q.y + q.height], bottom);
    assert.equal(h.view.scrollView.scrollTop, feedTop);
    assert.equal(h.tui.currentLayout.lines.length, height);
    for (const line of h.tui.currentLayout.lines) assert.ok(visibleWidth(line) <= width);
  }
  h.clickQuestion("Alpha");
  assert.deepEqual(h.feedHits, []);
});

test("50-card wide full layout typing and scrolling reuse the unchanged feed", (t) => {
  const feed = Array.from({ length: 50 }, (_, i) => ({ id: `item${i}`, type: "assistant_update", text: `Update ${i}: ${"Long wrapped content 界 and measurements. ".repeat(20)}`, createdAt: at }));
  const h = harness(t, { width: 240, height: 50, feed, questions: [question({ reason: "Long question reason ".repeat(150) })] });
  h.clickQuestion("Type an answer");
  const cached = h.view.feed.render(240);
  const typing = [];
  for (const key of "answer typing") {
    const start = performance.now();
    h.terminal.input(key); h.tui.renderNow();
    typing.push(performance.now() - start);
    assert.equal(h.view.feed.render(240), cached);
  }
  const qbox = h.box(h.view.questionScrollView).rect;
  const scrolling = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    h.terminal.input(`\x1b[<65;3;${qbox.y + 2}M`); h.tui.renderNow();
    scrolling.push(performance.now() - start);
    assert.equal(h.view.feed.render(240), cached);
  }
  const feedBox = h.box(h.view.scrollView).rect;
  const feedScrolling = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    h.terminal.input(`\x1b[<65;3;${feedBox.y + 2}M`); h.tui.renderNow();
    feedScrolling.push(performance.now() - start);
    assert.equal(h.view.feed.render(240), cached);
  }
  assert.ok(h.view.scrollView.scrollTop > 0);
  const stats = (values) => { values.sort((a, b) => a - b); return `median=${values[Math.floor(values.length / 2)].toFixed(2)}ms max=${values.at(-1).toFixed(2)}ms`; };
  t.diagnostic(`full layout typing ${stats(typing)}; question wheel ${stats(scrolling)}; feed wheel ${stats(feedScrolling)}`);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.feedHits, []);
});
