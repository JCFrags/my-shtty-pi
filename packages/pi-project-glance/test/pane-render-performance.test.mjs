import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import { renderProjectGlanceFeed } from "../dist/pane/renderer.js";
import { ProjectGlanceFeedRegion } from "../dist/pane/main.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";

const sessionKey = "a".repeat(64), generation = "b".repeat(32);
const snapshot = (revision = 1) => ({
  protocolVersion: 1, sessionKey, revision, generatedAt: "2026-09-03T00:00:00.000Z", branchId: "A",
  current: { step: "Synthetic render benchmark" },
  feed: Array.from({ length: 50 }, (_, i) => ({ id: `item${i}`, type: "assistant_update", text: `Update ${i}: ${"Long wrapped content 界 and measurements. ".repeat(20)}`, createdAt: "2026-09-03T00:00:00.000Z" })),
  uiState: { dismissedIds: [], readIds: [] },
});
function setup() {
  const model = new ProjectGlancePaneModel(sessionKey, generation);
  model.applySnapshot(snapshot(), { sessionKey, generation });
  return { model, feed: new ProjectGlanceFeedRegion(model) };
}
// Optional bounded reproduction of the old per-cell scan. Not a timing gate.
if (process.env.GLANCE_BENCH_LEGACY === "1") {
  for (const width of [80, 200, 320]) {
    const { model } = setup();
    const start = performance.now();
    const lines = renderProjectGlanceFeed(model.snapshot, width, { selectedId: model.selectedId });
    const hits = new Map();
    for (let y = 0; y < lines.length; y++) for (let x = 0; x < width; x++) {
      const url = getOsc8LinkAtColumn(lines[y], x);
      if (url) { hits.set(`${y}:${x}`, url); decodeURIComponent(new URL(url).pathname.slice(1)); }
    }
    console.log(`legacy collapsed width=${width}: ${(performance.now() - start).toFixed(2)}ms, ${hits.size} cell targets`);
  }
}

for (const width of [80, 200, 320]) {
  test(`50-card render latency at width ${width}`, (t) => {
    const { model, feed } = setup();
    const measure = (fn, count) => {
      const samples = Array.from({ length: count }, () => { const start = performance.now(); fn(); return performance.now() - start; }).sort((a, b) => a - b);
      return `median=${samples[Math.floor(count / 2)].toFixed(2)}ms max=${samples.at(-1).toFixed(2)}ms`;
    };
    t.diagnostic(`collapsed cold: ${measure(() => { feed.invalidate(); feed.render(width); }, 3)}`);
    t.diagnostic(`unchanged (typing/scroll): ${measure(() => feed.render(width), 10)}`);
    for (const item of model.visibleFeed) model.toggleExpanded(item.id);
    t.diagnostic(`expanded cold: ${measure(() => { feed.invalidate(); feed.render(width); }, 3)}`);
    t.diagnostic(`expanded unchanged: ${measure(() => feed.render(width), 10)}`);
    assert.ok(feed.render(width).length > 300);
  });
}

test("feed cache follows actual inputs and explicit invalidation", () => {
  const { model, feed } = setup();
  const initial = feed.render(80);
  assert.equal(feed.render(80), initial, "unchanged layout/typing reuses lines and hit spans");
  const next = snapshot(2);
  next.current.step = "Only CURRENT changed";
  model.applySnapshot(next, { sessionKey, generation });
  assert.equal(feed.render(80), initial, "unrelated snapshot fields do not rebuild feed");
  model.selectRelative(1);
  const selected = feed.render(80);
  assert.notEqual(selected, initial);
  model.toggleExpanded("item1");
  const expanded = feed.render(80);
  assert.notEqual(expanded, selected);
  assert.ok(expanded.length > selected.length);
  assert.notEqual(feed.render(40), expanded);
  const updated = snapshot(3);
  updated.feed[0].text = "Changed text";
  updated.uiState.readIds = ["item0"];
  updated.uiState.dismissedIds = ["item2"];
  model.applySnapshot(updated, { sessionKey, generation });
  const changed = feed.render(80);
  assert.ok(changed.some((line) => line.includes("Changed text")));
  assert.equal(feed.rowForItem("item2"), undefined);
  feed.invalidate();
  assert.notEqual(feed.render(80), changed);
});

test("linear hit spans agree with canonical OSC8 cell lookup, including wide text and exclusive close", () => {
  const { model } = setup();
  const value = snapshot(2);
  value.feed = value.feed.slice(0, 2);
  value.feed[0].id = "space / 界";
  model.applySnapshot(value, { sessionKey, generation });
  const hits = [];
  const feed = new ProjectGlanceFeedRegion(model, (url) => hits.push(url));
  for (const width of [1, 3, 4, 20, 80]) {
    const linked = renderProjectGlanceFeed(model.snapshot, width, { selectedId: model.selectedId });
    feed.render(width);
    for (let y = 0; y < linked.length; y++) for (let x = 0; x < width; x++) {
      const expected = getOsc8LinkAtColumn(linked[y], x);
      const before = hits.length;
      feed.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: linked.length, shift: false, alt: false, ctrl: false });
      assert.equal(hits.length - before, expected ? 1 : 0, `${width}:${y}:${x}`);
      if (expected) assert.equal(hits.at(-1), expected);
    }
  }
});
