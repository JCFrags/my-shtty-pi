import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMouseEvent,
  PressReleaseTracker,
} from "../dist/extensions/tool-controls/mouse.js";

const regions = [
  {
    id: "button",
    role: "button",
    rowStart: 0,
    rowEnd: 1,
    colStart: 2,
    colEnd: 8,
    enabled: true,
  },
];

test("normalizes structural first-class mouse events without terminal escape parsing", () => {
  assert.deepEqual(normalizeMouseEvent({ kind: "press", button: "left", row: 1, col: 2 }), {
    phase: "press",
    button: "left",
    row: 1,
    col: 2,
    wheelDelta: 0,
  });
  assert.deepEqual(
    normalizeMouseEvent({ type: "scroll", button: "wheel-up", localRow: 3, localCol: 4 }),
    { phase: "wheel", button: "none", row: 3, col: 4, wheelDelta: -1 },
  );
  assert.equal(normalizeMouseEvent({ kind: "press", button: "left" }), undefined);
  assert.equal(normalizeMouseEvent({ raw: "\u001b[<0;1;1M" }), undefined);
});

test("activation requires left press and release inside the same region", () => {
  const tracker = new PressReleaseTracker();
  assert.equal(
    tracker.press(
      { phase: "press", button: "left", row: 0, col: 2, wheelDelta: 0 },
      regions,
    ),
    true,
  );
  assert.equal(
    tracker.release(
      { phase: "release", button: "left", row: 0, col: 7, wheelDelta: 0 },
      regions,
    ),
    "button",
  );

  tracker.press({ phase: "press", button: "left", row: 0, col: 2, wheelDelta: 0 }, regions);
  assert.equal(
    tracker.release(
      { phase: "release", button: "left", row: 0, col: 8, wheelDelta: 0 },
      regions,
    ),
    undefined,
  );
});

test("any drag motion cancels activation", () => {
  const tracker = new PressReleaseTracker();
  tracker.press({ phase: "press", button: "left", row: 0, col: 3, wheelDelta: 0 }, regions);
  assert.equal(
    tracker.move({ phase: "move", button: "left", row: 0, col: 3, wheelDelta: 0 }),
    true,
  );
  assert.equal(
    tracker.release(
      { phase: "release", button: "left", row: 0, col: 3, wheelDelta: 0 },
      regions,
    ),
    undefined,
  );
});

test("right and middle buttons never arm controls", () => {
  const tracker = new PressReleaseTracker();
  for (const button of ["right", "middle"]) {
    assert.equal(
      tracker.press({ phase: "press", button, row: 0, col: 3, wheelDelta: 0 }, regions),
      false,
    );
    assert.equal(
      tracker.release({ phase: "release", button, row: 0, col: 3, wheelDelta: 0 }, regions),
      undefined,
    );
  }
});
