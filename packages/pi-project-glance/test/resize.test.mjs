import assert from "node:assert/strict";
import test from "node:test";
import { ProjectGlancePaneView } from "../dist/pane/main.js";
import { ProjectGlancePaneModel } from "../dist/pane/model.js";
import { TuiAltScreen, stripTerminalSequences } from "@earendil-works/pi-tui";

test("full mouse dispatch survives resize, scrolling and scrollbar transitions", (t) => {
  let clickTime = Date.now();
  t.mock.method(Date, "now", () => clickTime);
  const terminal = {
    columns: 50, rows: 20,
    start(input, resize) { this.input = input; this.resize = resize; },
    stop() {}, write() {}, hideCursor() {}, showCursor() {},
  };
  const model = new ProjectGlancePaneModel("a".repeat(64));
  model.applySnapshot({
    protocolVersion: 1, sessionKey: "a".repeat(64), revision: 1,
    generatedAt: "2026-09-03T00:00:00.000Z", branchId: "A",
    current: { step: "Synthetic resize fixture with enough wrapping" },
    feed: Array.from({ length: 12 }, (_, i) => ({
      id: `item${i}`, type: "assistant_update",
      text: `First line ${i}\nSecond line\nThird line\nFourth line with long words wrapping at narrow widths`,
      createdAt: "2026-09-03T00:00:00.000Z",
    })),
    uiState: { dismissedIds: [], readIds: [] },
  });
  const hits = [];
  const view = new ProjectGlancePaneView(model, (url) => {
    hits.push(url);
    const target = new URL(url);
    if (target.hostname === "toggle") model.toggleExpanded(target.pathname.slice(1));
    tui.requestRender();
  });
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const scrollbarStates = new Set();
  const scrollTops = new Set();
  let clicks = 0;
  try {
    tui.setLayoutRoot(view.root);
    tui.start();
    for (const [width, height, scrollTop] of [
      [50, 110, 0], [24, 20, 5], [60, 130, 0],
      [20, 14, 10], [40, 30, 15], [80, 110, 0],
    ]) {
      terminal.columns = width;
      terminal.rows = height;
      terminal.resize();
      tui.renderNow();
      view.scrollView.scrollTo(scrollTop);
      tui.renderNow();
      scrollbarStates.add(view.scrollView.isScrollbarVisible);
      scrollTops.add(view.scrollView.scrollTop);
      for (let i = 0; i < 2; i++) {
        const rows = tui.currentLayout.lines.map(stripTerminalSequences);
        const y = rows.findIndex((line) => /[●•] [▸▾]/u.test(line));
        assert(y >= 0, "a visible toggle must remain available");
        const label = rows[y].match(/[●•] ([▸▾])/u)[1];
        const x = rows[y].indexOf(label);
        // Separate ordinary clicks from the TUI double/triple-click text-selection gesture.
        clickTime += 1000;
        const before = hits.length;
        terminal.input(`\x1b[<0;${x + 1};${y + 1}M`);
        tui.renderNow();
        terminal.input(`\x1b[<0;${x + 1};${y + 1}m`);
        tui.renderNow();
        assert.equal(hits.length, before + 1, "one full-path click activates once");
        const id = new URL(hits.at(-1)).pathname.slice(1);
        assert.equal(model.isExpanded(id), label === "▸");
        const feedBox = tui.currentLayout.root.children[1].children[0];
        const row = view.feed.rowForItem(id);
        assert.equal(typeof row, "number");
        assert(feedBox.lines.slice(row, row + 2).some((line) => stripTerminalSequences(line).includes(label === "▸" ? "▾" : "▸")));
        clicks++;
      }
    }
    assert.deepEqual([...scrollbarStates].sort(), [false, true]);
    assert([...scrollTops].some((top) => top > 0));
    assert.equal(clicks, 12);
  } finally {
    tui.setLayoutRoot(undefined);
    tui.stop();
    view.scrollView.hideTransientScrollbar();
  }
});
