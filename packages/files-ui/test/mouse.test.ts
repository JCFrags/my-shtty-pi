import assert from "node:assert/strict";
import test from "node:test";
import { attachFirstClassMouse, normalizeMouseEvent, parseSgrMouse } from "../src/ui/mouse.ts";

test("parses SGR mouse coordinates, modifiers, wheel, and release", () => {
  assert.deepEqual(parseSgrMouse("\u001b[<4;10;20M"), {
    kind: "press",
    x: 9,
    y: 19,
    button: "left",
    shift: true,
    alt: false,
    ctrl: false,
    raw: "\u001b[<4;10;20M",
  });
  assert.equal(parseSgrMouse("\u001b[<65;3;4M")?.wheelDelta, 1);
  assert.equal(parseSgrMouse("\u001b[<0;3;4m")?.kind, "release");
});

test("normalizes first-class mouse event shapes", () => {
  assert.deepEqual(
    normalizeMouseEvent({ type: "wheel", column: 5, row: 7, coordinateBase: 1, deltaY: -12, modifiers: { ctrl: true } }),
    {
      kind: "wheel",
      x: 4,
      y: 6,
      shift: false,
      alt: false,
      ctrl: true,
      wheelDelta: -1,
      raw: { type: "wheel", column: 5, row: 7, coordinateBase: 1, deltaY: -12, modifiers: { ctrl: true } },
    },
  );
});

test("prefers a first-class mouse API and cleans it up", () => {
  let listener: ((event: unknown) => unknown) | undefined;
  let disposed = 0;
  const tui = {
    addMouseListener(callback: (event: unknown) => unknown) {
      listener = callback;
      return () => {
        disposed += 1;
        listener = undefined;
      };
    },
  };
  const events: string[] = [];
  const attachment = attachFirstClassMouse(tui, (event) => {
    events.push(`${event.kind}:${event.x},${event.y}`);
    return { handled: true };
  });
  assert.equal(attachment.available, true);
  assert.equal(attachment.source, "addMouseListener");
  assert.equal(listener?.({ type: "press", x: 2, y: 3, button: "left" }), true);
  assert.deepEqual(events, ["press:2,3"]);
  attachment.dispose();
  assert.equal(disposed, 1);
});

test("treats a click-only first-class event as a completed press/release pair", () => {
  let listener: ((event: unknown) => unknown) | undefined;
  const kinds: string[] = [];
  attachFirstClassMouse(
    {
      addMouseListener(callback: (event: unknown) => unknown) {
        listener = callback;
      },
    },
    (event) => {
      kinds.push(event.kind);
      return { handled: true };
    },
  );
  assert.equal(listener?.({ type: "click", x: 1, y: 2 }), true);
  assert.deepEqual(kinds, ["press", "release"]);
});

test("does not enable a raw mouse fallback when no first-class API exists", () => {
  const attachment = attachFirstClassMouse({}, () => ({ handled: true }));
  assert.equal(attachment.available, false);
  assert.equal(attachment.source, "none");
  attachment.dispose();
});
