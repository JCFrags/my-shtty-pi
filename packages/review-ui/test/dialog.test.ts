import assert from "node:assert/strict";
import test from "node:test";
import { ReviewDialogComponent } from "../src/dialog.js";
import type { QueueRunContext } from "../src/queue.js";
import { FakeTui, identityTheme } from "./helpers.js";

type Decision = "approve" | "approve-turn" | "reject";

function createDialog(options: {
  body?: string;
  signal?: AbortSignal;
  queueContext?: QueueRunContext;
  includeApproveTurn?: boolean;
  title?: string;
  warnings?: string[];
} = {}) {
  const tui = new FakeTui();
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller?.signal;
  if (!signal) throw new Error("missing signal");
  const results: Array<Decision | "abort"> = [];
  const dialog = new ReviewDialogComponent<Decision>(
    tui,
    identityTheme,
    {
      title: options.title ?? "Review WRITE file.txt",
      body: options.body ?? "--- file.txt\n+++ file.txt\n-old\n+new",
      warnings: options.warnings ?? [],
      actions: [
        { id: "approve", label: "Approve once", tone: "approve" },
        { id: "reject", label: "Reject", tone: "reject" },
        ...(options.includeApproveTurn
          ? [{ id: "approve-turn" as const, label: "Approve all edit/write calls for this turn", tone: "neutral" as const }]
          : []),
      ],
      defaultAction: "reject",
      approveHotkeyResult: "approve",
      rejectResult: "reject",
      keyboardHint: "keys",
    },
    (result) => results.push(result),
    signal,
    options.queueContext,
  );
  return { dialog, tui, results, controller };
}

test("terminal and bidirectional controls are escaped before rendering", () => {
  const { dialog } = createDialog({
    title: "Review WRITE bad\x1b[2J-\nname.txt",
    warnings: ["target\t\u202Etxt.exe"],
    body: "--- file\n+++ file\n+safe\x1b]2;spoof\u0007text\n+rtl\u2066name\u2069",
  });
  const rendered = dialog.render(80);
  assert.ok(rendered.every((line) => !line.includes("\n") && !line.includes("\r")));
  const output = rendered.join("\n");
  assert.doesNotMatch(output, /\x1b|\u0007|\u202E|\u2066|\u2069/u);
  assert.match(output, /␛\[2J-␊name\.txt/);
  assert.match(output, /target␉<U\+202E>txt\.exe/);
  assert.match(output, /␛\]2;spoof␇text/);
  assert.match(output, /<U\+202E>/);
  assert.match(output, /<U\+2066>name<U\+2069>/);
});

test("narrow renders never exceed the width supplied by Pi", () => {
  const compact = createDialog({ title: "Review WRITE a very long path/file.txt" });
  for (const width of [1, 4, 8, 20]) {
    const rendered = compact.dialog.render(width);
    assert.ok(rendered.length > 0);
    assert.ok(
      rendered.every((line) => [...line].length <= width),
      `a rendered line exceeded width ${width}`,
    );
  }
});

test("long warning text stays bounded so actions remain pinned", () => {
  const { dialog } = createDialog({ warnings: [`outside target ${"x".repeat(2_000)}`] });
  const rendered = dialog.render(52);
  assert.ok(rendered.some((line) => line.includes("Approve once")));
  assert.ok(rendered.some((line) => line.includes("Reject")));
  const warningRows = rendered.filter((line) => line.includes("outside target"));
  assert.equal(warningRows.length, 1);
});

test("keyboard focus defaults to Reject and Enter activates only the focused action", () => {
  const { dialog, results } = createDialog();
  dialog.render(80);
  dialog.handleInput("\r");
  assert.deepEqual(results, ["reject"]);
});

test("Tab and Shift+Tab move action focus", () => {
  const forward = createDialog();
  forward.dialog.render(80);
  forward.dialog.handleInput("\t");
  forward.dialog.handleInput("\r");
  assert.deepEqual(forward.results, ["approve"]);

  const backward = createDialog();
  backward.dialog.render(80);
  backward.dialog.handleInput("\x1b[Z");
  backward.dialog.handleInput("\r");
  assert.deepEqual(backward.results, ["approve"]);
});

test("y approves, n and Escape reject, and Space never approves", () => {
  const yes = createDialog();
  yes.dialog.handleInput("y");
  assert.deepEqual(yes.results, ["approve"]);

  const no = createDialog();
  no.dialog.handleInput("n");
  assert.deepEqual(no.results, ["reject"]);

  const escape = createDialog();
  escape.dialog.handleInput("\x1b");
  assert.deepEqual(escape.results, ["reject"]);

  const space = createDialog();
  space.dialog.handleInput(" ");
  assert.deepEqual(space.results, []);
  space.dialog.handleInput("\r");
  assert.deepEqual(space.results, ["reject"]);
});

test("Up/Down and PageUp/PageDown scroll the body", () => {
  const body = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");
  const { dialog } = createDialog({ body });
  const initial = dialog.render(70).join("\n");
  assert.match(initial, /line-1/);

  dialog.handleInput("\x1b[6~");
  const pageDown = dialog.render(70).join("\n");
  assert.doesNotMatch(pageDown, /│ line-1\s/);

  dialog.handleInput("\x1b[A");
  dialog.handleInput("\x1b[5~");
  const pageUp = dialog.render(70).join("\n");
  assert.match(pageUp, /line-1/);
});

test("mouse wheel scrolls and explicit press/release clicks activate buttons", () => {
  const body = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");
  const click = createDialog({ body });
  let rendered = click.dialog.render(80);
  const initial = rendered.join("\n");
  click.dialog.handleMouse({ kind: "wheel", deltaY: 1, row: 5, col: 5 });
  rendered = click.dialog.render(80);
  assert.notEqual(rendered.join("\n"), initial);

  const actionRow = rendered.findIndex((line) => line.includes("Approve once"));
  const actionCol = rendered[actionRow]?.indexOf("Approve once") ?? -1;
  assert.ok(actionRow >= 0 && actionCol >= 0);
  assert.equal(click.dialog.handleMouse({ kind: "press", button: "left", row: actionRow, col: actionCol }), true);
  assert.deepEqual(click.results, [], "press alone must not approve");
  click.dialog.handleMouse({ kind: "release", button: "left", row: actionRow, col: actionCol });
  assert.deepEqual(click.results, ["approve"]);
});

test("owned Pi local mouse coordinates activate only the explicit button", () => {
  const click = createDialog();
  const rendered = click.dialog.render(80);
  const actionRow = rendered.findIndex((line) => line.includes("Approve once"));
  const actionCol = rendered[actionRow]?.indexOf("Approve once") ?? -1;
  assert.ok(actionRow >= 0 && actionCol >= 0);

  click.dialog.handleMouse({ kind: "press", button: "left", x: 999, y: 999, localRow: actionRow, localCol: actionCol });
  click.dialog.handleMouse({ kind: "release", button: "left", x: 999, y: 999, localRow: actionRow, localCol: actionCol });
  assert.deepEqual(click.results, ["approve"]);
});

test("long optional approve-all action wraps into a pinned clickable row", () => {
  const click = createDialog({ includeApproveTurn: true });
  const rendered = click.dialog.render(52);
  const actionRow = rendered.findIndex((line) => line.includes("Approve all edit/write calls for this turn"));
  const actionCol = rendered[actionRow]?.indexOf("Approve all edit/write calls for this turn") ?? -1;
  assert.ok(actionRow >= 0 && actionCol >= 0);
  assert.ok(actionRow > rendered.findIndex((line) => line.includes("Approve once")));

  click.dialog.handleMouse({ type: "mousedown", button: "primary", row: actionRow, column: actionCol });
  assert.deepEqual(click.results, []);
  click.dialog.handleMouse({ type: "mouseup", button: "primary", row: actionRow, column: actionCol });
  assert.deepEqual(click.results, ["approve-turn"]);
});

test("mouse wheel aliases are consumed and scroll without activating actions", () => {
  const body = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");
  const dialog = createDialog({ body });
  const initial = dialog.dialog.render(70).join("\n");
  assert.equal(dialog.dialog.handleMouse({ type: "wheel", button: "wheel-up", row: 4, column: 4 }), true);
  const afterUpAtTop = dialog.dialog.render(70).join("\n");
  assert.equal(afterUpAtTop, initial);
  assert.equal(dialog.dialog.handleMouse({ action: "wheel-down", row: 4, col: 4 }), true);
  const afterDown = dialog.dialog.render(70).join("\n");
  assert.notEqual(afterDown, initial);
  assert.deepEqual(dialog.results, []);
});

test("mouse drag cancels, header/body clicks never approve, and outside events are consumed", () => {
  const drag = createDialog();
  const rendered = drag.dialog.render(80);
  const actionRow = rendered.findIndex((line) => line.includes("Approve once"));
  const actionCol = rendered[actionRow]?.indexOf("Approve once") ?? -1;
  drag.dialog.handleMouse({ kind: "press", button: "left", row: actionRow, col: actionCol });
  drag.dialog.handleMouse({ kind: "move", button: "left", row: actionRow, col: actionCol + 2, dragged: true });
  drag.dialog.handleMouse({ kind: "release", button: "left", row: actionRow, col: actionCol + 2 });
  assert.deepEqual(drag.results, []);

  const releaseMarkedDragged = createDialog();
  const releaseRendered = releaseMarkedDragged.dialog.render(80);
  const releaseActionRow = releaseRendered.findIndex((line) => line.includes("Approve once"));
  const releaseActionCol = releaseRendered[releaseActionRow]?.indexOf("Approve once") ?? -1;
  releaseMarkedDragged.dialog.handleMouse({
    kind: "press",
    button: "left",
    row: releaseActionRow,
    col: releaseActionCol,
  });
  releaseMarkedDragged.dialog.handleMouse({
    kind: "release",
    button: "left",
    row: releaseActionRow,
    col: releaseActionCol,
    dragged: true,
  });
  assert.deepEqual(releaseMarkedDragged.results, []);

  const body = createDialog();
  body.dialog.render(80);
  assert.equal(body.dialog.handleMouse({ kind: "press", button: "left", row: 1, col: 10 }), true);
  assert.equal(body.dialog.handleMouse({ kind: "release", button: "left", row: 1, col: 10 }), true);
  assert.equal(body.dialog.handleMouse({ kind: "press", button: "left", row: 999, col: 999 }), true);
  assert.equal(body.dialog.handleMouse({ kind: "release", button: "left", row: 999, col: 999 }), true);
  assert.deepEqual(body.results, []);
});

test("abort settles the dialog and cleanup removes listeners exactly once", () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let additions = 0;
  let removals = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    additions += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removals += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];

  let unsubscribes = 0;
  const queueContext: QueueRunContext = {
    signal,
    getPosition: () => ({ current: 1, total: 2 }),
    onPositionChange(listener) {
      listener({ current: 1, total: 2 });
      return () => {
        unsubscribes += 1;
      };
    },
  };
  const { dialog, results } = createDialog({ signal, queueContext });
  assert.equal(additions, 1);
  controller.abort();
  assert.deepEqual(results, ["abort"]);
  dialog.dispose();
  dialog.dispose();
  assert.equal(removals, 1);
  assert.equal(unsubscribes, 1);
});

test("queue position changes request a render and appear in the title", () => {
  let listener: ((position: { current: number; total: number }) => void) | undefined;
  const controller = new AbortController();
  const queueContext: QueueRunContext = {
    signal: controller.signal,
    getPosition: () => ({ current: 1, total: 1 }),
    onPositionChange(next) {
      listener = next;
      next({ current: 1, total: 1 });
      return () => {};
    },
  };
  const { dialog, tui } = createDialog({ signal: controller.signal, queueContext });
  listener?.({ current: 2, total: 3 });
  const output = dialog.render(80).join("\n");
  assert.match(output, /\[2\/3\]/);
  assert.ok(tui.renderRequests >= 2);
});
