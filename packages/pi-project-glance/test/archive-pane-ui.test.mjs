import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ProjectGlanceArchiveModel, MAX_CACHED_ARCHIVE_PAGES, MAX_RENDERED_HISTORY_PAGES, MAX_CACHED_BODY_CHUNKS } from "../dist/pane/archive.js";
import { ProjectGlancePaneView } from "../dist/pane/main.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";
import { ProjectGlanceQuestionsRegion } from "../dist/pane/questions.js";
import { renderProjectGlanceFeed } from "../dist/pane/renderer.js";

const branchId = "branch-A";
const at = "2026-09-10T12:00:00.000Z";
const preview = (itemId, patch = {}) => ({ itemId, type: "assistant_update", preview: `Preview ${itemId}`, createdAt: at, bodyBytes: 64_000, ...patch });
const page = (view, items, patch = {}) => ({ branchId, view, snapshotSeq: 7, items, ...patch });
const snapshot = {
  protocolVersion: 1,
  sessionKey: "a".repeat(64),
  revision: 1,
  generatedAt: at,
  branchId,
  current: { step: "Keep CURRENT separate" },
  feed: [{ id: "legacy", type: "assistant_update", text: "Compatibility preview", createdAt: at }],
  uiState: { dismissedIds: [], readIds: ["legacy"] },
};
const plain = (lines) => lines.map(stripTerminalSequences);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function click(region, text, width = 80) {
  const lines = plain(region.render(width));
  const row = lines.findIndex((line) => line.includes(text));
  assert.notEqual(row, -1, `missing ${text}`);
  const x = Math.max(0, lines[row].indexOf(text));
  region.handleMouse({ type: "click", button: "left", x, y: row, screenX: x, screenY: row, width, height: lines.length, shift: false, alt: false, ctrl: false });
}

test("archive cache is bounded and resets only when the branch changes", () => {
  const model = new ProjectGlanceArchiveModel();
  model.sync(branchId, { inboxCount: 150, historyCount: 90, commitSeq: 7, state: "ready" });
  for (let index = 0; index < 8; index++) {
    const cursor = `cursor-${index}`;
    assert.equal(model.beginPage("inbox", cursor), true);
    model.receivePage("inbox", cursor, page("inbox", [preview(`i-${index}`)]), index === 7);
  }
  assert.ok(model.cachedPageCount() <= MAX_CACHED_ARCHIVE_PAGES);
  model.toggleHistory();
  model.sync(branchId, { inboxCount: 151, historyCount: 90, commitSeq: 8, state: "ready" });
  assert.equal(model.historyExpanded, true, "same-branch arrivals preserve local UI state");
  model.sync("branch-B", { inboxCount: 1, historyCount: 0, commitSeq: 1, state: "ready" });
  assert.equal(model.historyExpanded, false);
  assert.equal(model.cachedPageCount(), 0);
});

test("a newer archive commit queued behind an initial-page read is fetched immediately", async () => {
  const model = new ProjectGlancePaneModel(snapshot.sessionKey);
  model.applySnapshot({ ...snapshot, feed: [], archive: { inboxCount: 1, historyCount: 0, commitSeq: 7, state: "ready" } });
  const reads = [];
  const view = new ProjectGlancePaneView(model, undefined, {
    dataAdapter: {
      requestPage: (requestedBranch, requestedView, cursor) => new Promise((resolve) => reads.push({ requestedBranch, requestedView, cursor, resolve })),
      requestBody: () => Promise.reject(new Error("not used")),
    },
  });
  view.invalidate();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].requestedView, "inbox");

  model.applySnapshot({ ...snapshot, revision: 2, feed: [], archive: { inboxCount: 1, historyCount: 1, commitSeq: 8, state: "ready" } });
  view.invalidate();
  assert.equal(reads.length, 1, "the same initial-page key allows only one in-flight read");

  reads[0].resolve(page("inbox", [preview("dismissed-stale")], { snapshotSeq: 7 }));
  await tick();
  assert.equal(reads.length, 2, "completion starts the read for the newer commit");
  assert.doesNotMatch(plain(view.feed.render(80)).join("\n"), /dismissed-stale/, "the stale response is not activated");

  reads[1].resolve(page("inbox", [preview("new-arrival")], { snapshotSeq: 8 }));
  await tick();
  assert.deepEqual(model.archive.activeItems("inbox").map((item) => item.itemId), ["new-arrival"]);
  const rendered = plain(view.feed.render(80)).join("\n");
  assert.match(rendered, /Preview new-arrival/);
  assert.doesNotMatch(rendered, /dismissed-stale/);
  assert.ok(model.archive.cachedPageCount() <= MAX_CACHED_ARCHIVE_PAGES);
});

test("History scroll automatically crosses page boundaries and recovers evicted newer cards", async () => {
  const model = new ProjectGlancePaneModel(snapshot.sessionKey);
  model.applySnapshot({ ...snapshot, feed: [], archive: { inboxCount: 0, historyCount: 100, commitSeq: 7, state: "ready" } });
  const records = Array.from({ length: 100 }, (_, index) => preview(`history-${100 - index}`, { archivedAt: at }));
  const reads = [];
  const cursorFor = (start, move) => `${move}-${start}`;
  const response = (cursor) => {
    const [move = "next", value = "0"] = cursor?.split("-") ?? [];
    const boundary = Number(value);
    const start = move === "previous" ? Math.max(0, boundary - 25) : boundary;
    const items = records.slice(start, start + 25);
    return page("history", items, {
      ...(start > 0 ? { previousCursor: cursorFor(start, "previous") } : {}),
      ...(start + items.length < records.length ? { nextCursor: cursorFor(start + items.length, "next") } : {}),
    });
  };
  const view = new ProjectGlancePaneView(model, undefined, {
    dataAdapter: {
      requestPage: async (_requestedBranch, requestedView, cursor) => {
        assert.equal(requestedView, "history");
        reads.push(cursor ?? "initial");
        return response(cursor);
      },
      requestBody: () => Promise.reject(new Error("not used")),
    },
  });
  view.toggleHistory();
  await tick();

  const width = 80;
  const height = 10;
  const layout = () => view.scrollView.updateLayout(view.feed.render(width).length, height, () => {});
  const wheel = (delta) => {
    const event = {
      type: "wheel", button: "none", wheelDelta: delta,
      x: 1, y: 1, screenX: 1, screenY: 1, width, height,
      shift: false, alt: false, ctrl: false,
    };
    view.scrollView.scrollBy(event.wheelDelta);
  };
  layout();
  let stableAnchorChecks = 0;
  for (let index = 0; index < 150 && !model.archive.activeItems("history").some((item) => item.itemId === "history-1"); index++) {
    wheel(3);
    const readsBeforeLayout = reads.length;
    layout();
    const anchorBeforeLoad = view.feed.anchorAt(view.scrollView.scrollTop);
    await tick();
    layout();
    if (reads.length > readsBeforeLayout && anchorBeforeLoad && model.archive.activeItems("history").some((item) => item.itemId === anchorBeforeLoad.id)) {
      assert.deepEqual(view.feed.anchorAt(view.scrollView.scrollTop), anchorBeforeLoad, "automatic append preserves the visible card and row offset");
      stableAnchorChecks += 1;
    }
  }

  const loaded = model.archive.activeItems("history").map((item) => item.itemId);
  assert.ok(reads.includes("next-25"), "scrolling crosses the first 25-card boundary");
  assert.ok(reads.includes("next-50"), "scrolling crosses the second 25-card boundary");
  assert.ok(reads.includes("next-75"), "scrolling reaches cards beyond 75 without a page action");
  assert.ok(loaded.includes("history-1"), "the contiguous rendered window reaches the oldest quarter");
  assert.equal(new Set(loaded).size, loaded.length, "the history window has no duplicate cards");
  assert.ok(stableAnchorChecks >= 2, "multiple automatic page appends preserve stable reading anchors");
  assert.ok(model.archive.renderedHistoryPageCount() <= MAX_RENDERED_HISTORY_PAGES);
  assert.ok(model.archive.cachedPageCount() <= MAX_CACHED_ARCHIVE_PAGES);
  assert.doesNotMatch(plain(view.feed.render(width)).join("\n"), /\[(?:Next|Previous|First) page\]/, "History has no manual page gate");

  for (let index = 0; index < 150 && !model.archive.activeItems("history").some((item) => item.itemId === "history-100"); index++) {
    wheel(-3);
    layout();
    await tick();
    layout();
  }
  const recovered = model.archive.activeItems("history").map((item) => item.itemId);
  assert.ok(recovered.includes("history-100"), "back-scroll recovers an evicted newer page");
  assert.equal(new Set(recovered).size, recovered.length);
  assert.ok(model.archive.renderedHistoryPageCount() <= MAX_RENDERED_HISTORY_PAGES);
  assert.ok(model.archive.cachedPageCount() <= MAX_CACHED_ARCHIVE_PAGES);
});

test("body rendering and cache stay bounded without concatenating chunks", () => {
  const model = new ProjectGlanceArchiveModel();
  model.sync(branchId, { inboxCount: 1, historyCount: 0, commitSeq: 7, state: "ready" });
  model.receivePage("inbox", undefined, page("inbox", [preview("long")]), true);
  let offset = 0;
  let previousOffset;
  for (let index = 0; index < 7; index++) {
    model.beginBody("long", offset);
    const nextOffset = offset + 24 * 1024 - (index % 2);
    model.receiveBody("long", offset, { itemId: "long", offset, text: `chunk-${index}`, ...(previousOffset === undefined ? {} : { previousOffset }), nextOffset, totalBytes: 500_000, bodyDigest: "b".repeat(64) });
    if (index < 6) {
      previousOffset = offset;
      offset = model.moveBody("long", "next");
    }
  }
  assert.ok(model.cachedBodyChunkCount() <= MAX_CACHED_BODY_CHUNKS);
  assert.ok(model.moveBody("long", "previous") < offset, "exact prior UTF-8 boundary is retained without retaining its body text");
  offset = model.moveBody("long", "next");
  assert.ok(offset > 0);
  const expanded = plain(renderProjectGlanceFeed(snapshot, 80, { archive: model, expandedIds: new Set(["long"]) })).join("\n");
  assert.match(expanded, /chunk-6/);
  assert.doesNotMatch(expanded, /chunk-0/);
});

test("receipt failure retains an archive Inbox card and renders a truthful error", async () => {
  const model = new ProjectGlancePaneModel(snapshot.sessionKey);
  model.applySnapshot({ ...snapshot, feed: [], archive: { inboxCount: 1, historyCount: 1, commitSeq: 7, state: "ready" } });
  model.archive.receivePage("inbox", undefined, page("inbox", [preview("inbox")]), true);
  model.archive.receivePage("history", undefined, page("history", [preview("history", { archivedAt: at })]), true);
  model.reconcileSelection();
  const calls = [];
  const view = new ProjectGlancePaneView(model, undefined, {
    onDismiss: (itemId) => { calls.push(itemId); return Promise.reject(new Error("private transport detail")); },
  });
  const width = 80;
  const layout = () => view.scrollView.updateLayout(view.feed.render(width).length, 4, () => {});
  layout();
  view.scrollView.scrollTo((view.feed.rowForItem("inbox") ?? 0) + 1);
  const anchor = view.feed.anchorAt(view.scrollView.scrollTop);
  view.dismissItem("history");
  assert.deepEqual(calls, [], "History cards cannot be dismissed");
  view.dismissItem("inbox");
  view.dismissItem("inbox");
  assert.deepEqual(calls, ["inbox"], "a pending receipt suppresses duplicate sends");
  assert.match(plain(view.feed.render(width)).join("\n"), /Preview inbox/, "receipt wait is not optimistic");
  await tick();
  layout();
  const rendered = plain(view.feed.render(width)).join("\n");
  assert.deepEqual(view.feed.anchorAt(view.scrollView.scrollTop), anchor);
  assert.match(rendered, /Preview inbox/);
  assert.match(rendered, /Dismiss failed\. The Inbox item remains\./);
  assert.doesNotMatch(rendered, /private transport detail/);
});

test("Inbox is all unread, History defaults collapsed and has subdued cards without X", () => {
  const model = new ProjectGlanceArchiveModel();
  model.sync(branchId, { inboxCount: 27, historyCount: 1, commitSeq: 7, state: "ready" });
  model.receivePage("inbox", undefined, page("inbox", [preview("oldest"), preview("newer")], { nextCursor: "inbox-next" }), true);
  model.receivePage("history", undefined, page("history", [preview("archived", { archivedAt: at })]), true);
  let rendered = renderProjectGlanceFeed(snapshot, 48, { archive: model });
  let text = plain(rendered).join("\n");
  assert.match(text, /27 unread/);
  assert.match(text, /▸ HISTORY \(1\)/);
  assert.doesNotMatch(text, /Preview archived/);
  assert.match(text, /\[Next page\]/);
  model.toggleHistory();
  rendered = renderProjectGlanceFeed(snapshot, 48, { archive: model });
  text = plain(rendered).join("\n");
  assert.match(text, /Preview archived/);
  const historyLine = plain(rendered).find((line) => line.includes("Preview archived"));
  assert.ok(historyLine && !historyLine.includes("×"));
  for (const line of rendered) assert.ok(visibleWidth(line) <= 48);
});

const question = (patch = {}) => ({
  id: "q-one",
  displayId: "Q-1",
  revision: 1,
  state: "pending",
  question: "Provide a value",
  reason: "Synthetic fixture",
  response: { kind: "text" },
  ...patch,
});

test("question editing presence follows text editing only", () => {
  const editing = [];
  const actions = [];
  const region = new ProjectGlanceQuestionsRegion((action) => actions.push(action), () => {}, (questionId, revision, active) => editing.push({ questionId, revision, active }));
  region.update([question()], "session:branch-A");
  region.focused = true;
  assert.deepEqual(editing, [{ questionId: "q-one", revision: 1, active: true }]);
  region.handleInput("draft");
  assert.equal(editing.length, 1, "typing does not count as a separate expiry action");
  region.handleInput("\t");
  assert.deepEqual(editing.at(-1), { questionId: "q-one", revision: 1, active: false });
  region.handleInput("\t");
  assert.equal(editing.length, 2, "control navigation does not renew editing presence");
  assert.deepEqual(actions, []);
});

test("hidden answer attention is subdued, compact, and retries without restoring the answer", async () => {
  const actions = [];
  const region = new ProjectGlanceQuestionsRegion((action) => actions.push(action), () => {});
  region.update([], "session:branch-A", [{ questionId: "q-hidden", displayId: "Q-9", revision: 4, state: "delivery_failed", retryAvailable: true, message: "Answer hidden; delivery failed." }]);
  const rendered = region.render(80);
  const text = plain(rendered).join("\n");
  assert.match(text, /QUESTION ATTENTION/);
  assert.match(text, /Q-9 · delivery_failed: Answer hidden; delivery failed\./);
  assert.ok(rendered.some((line) => line.includes("\x1b[2m")), "attention status uses subdued styling");
  assert.doesNotMatch(text, /Answer:|Type an answer|\[Dismiss/);
  click(region, "Retry delivery for Q-9");
  await tick();
  assert.deepEqual(actions, [{ type: "question_retry", questionId: "q-hidden", expectedRevision: 4 }]);
});

test("Dismiss is distinct from answering and Hide keeps delivery failure attention", async () => {
  const actions = [];
  const pending = new ProjectGlanceQuestionsRegion((action) => actions.push(action), () => {});
  pending.update([question()], "session:branch-A");
  click(pending, "Dismiss without answering");
  await tick();
  assert.deepEqual(actions[0], { type: "question_dismiss", questionId: "q-one", expectedRevision: 1 });

  const failed = new ProjectGlanceQuestionsRegion((action) => actions.push(action), () => {});
  failed.update([question({ state: "delivery_failed", answer: { optionIds: [], text: "private answer" }, failure: "Delivery failed" })], "session:branch-A");
  click(failed, "Hide answer");
  await tick();
  const text = plain(failed.render(80)).join("\n");
  assert.deepEqual(actions[1], { type: "question_hide", questionId: "q-one", expectedRevision: 1 });
  assert.doesNotMatch(text, /private answer/);
  assert.match(text, /Answer hidden locally\. Delivery state is unchanged\./);
  assert.match(text, /\[Retry delivery\]/);
});
