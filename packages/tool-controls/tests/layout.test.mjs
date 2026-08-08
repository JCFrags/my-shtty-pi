import test from "node:test";
import assert from "node:assert/strict";
import { createCompactLayout } from "../dist/extensions/tool-controls/compact-layout.js";
import { containsPoint, findHitRegion } from "../dist/extensions/tool-controls/mouse.js";

const base = {
  expanded: 3,
  total: 11,
  canExpandTurn: true,
  canCollapseTurn: true,
  busy: false,
};

test("compact layout selects wide, medium, and narrow variants without wrapping", () => {
  const wide = createCompactLayout(50, base);
  assert.equal(wide.mode, "wide");
  assert.equal(wide.plainLine, "[Tools 3/11] [Expand turn] [Collapse turn] [More…]");
  assert.deepEqual(
    wide.controls.map((control) => control.id),
    ["open", "expand-turn", "collapse-turn", "more"],
  );
  assert.ok(!wide.plainLine.includes("\n"));

  const medium = createCompactLayout(49, base);
  assert.equal(medium.mode, "medium");
  assert.equal(medium.plainLine, "[Tools 3/11] [Expand] [Collapse]");
  assert.deepEqual(
    medium.controls.map((control) => control.id),
    ["open", "expand-turn", "collapse-turn"],
  );

  const narrow = createCompactLayout(31, base);
  assert.equal(narrow.mode, "narrow");
  assert.equal(narrow.plainLine, "[Tools 3/11]");
  assert.deepEqual(narrow.controls.map((control) => control.id), ["open"]);

  const extremelyNarrow = createCompactLayout(7, base);
  assert.equal(extremelyNarrow.mode, "narrow");
  assert.ok(extremelyNarrow.plainLine.length <= 7);
  assert.equal(extremelyNarrow.controls.length, 1);
});

test("responsive thresholds are exact", () => {
  assert.equal(createCompactLayout(50, base).mode, "wide");
  assert.equal(createCompactLayout(49, base).mode, "medium");
  assert.equal(createCompactLayout(32, base).mode, "medium");
  assert.equal(createCompactLayout(31, base).mode, "narrow");
});

test("hit regions use inclusive starts and exclusive ends", () => {
  const layout = createCompactLayout(80, base);
  const tools = layout.regions.find((region) => region.id === "open");
  const expand = layout.regions.find((region) => region.id === "expand-turn");
  assert.ok(tools);
  assert.ok(expand);

  assert.equal(containsPoint(tools, 0, tools.colStart), true);
  assert.equal(containsPoint(tools, 0, tools.colEnd - 1), true);
  assert.equal(containsPoint(tools, 0, tools.colEnd), false);
  assert.equal(containsPoint(tools, 1, tools.colStart), false);
  assert.equal(findHitRegion(layout.regions, 0, tools.colEnd), undefined);
  assert.equal(findHitRegion(layout.regions, 0, expand.colStart)?.id, "expand-turn");
});

test("disabled operations retain regions but cannot be hit", () => {
  const layout = createCompactLayout(80, {
    ...base,
    canExpandTurn: false,
    canCollapseTurn: false,
  });
  const expand = layout.regions.find((region) => region.id === "expand-turn");
  assert.ok(expand);
  assert.equal(expand.enabled, false);
  assert.equal(findHitRegion(layout.regions, 0, expand.colStart), undefined);
  assert.equal(findHitRegion(layout.regions, 0, expand.colStart, true)?.id, "expand-turn");
});
