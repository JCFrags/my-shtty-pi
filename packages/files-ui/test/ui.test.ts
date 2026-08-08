import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { formatSelectedPaths } from "../src/insertion.ts";
import { computeBrowserLayout } from "../src/ui/layout.ts";
import { cellWidth, stripAnsi } from "../src/ui/text.ts";
import { createBrowser, withTempDirectory, writeFile } from "./helpers.ts";

test("keyboard selection and Shift+Down extend a contiguous visible range", async () => {
  await withTempDirectory("pi-files-range", async (root) => {
    await writeFile(root, "a.txt", "a");
    await writeFile(root, "b.txt", "b");
    await writeFile(root, "c.txt", "c");
    const fixture = await createBrowser(root);
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    fixture.browser.handleInput("\u001b[B");
    await fixture.browser.settle();
    fixture.browser.handleInput("\u001b[1;2B");
    await fixture.browser.settle();
    assert.deepEqual([...fixture.state.selectedPaths].sort(), ["a.txt", "b.txt", "c.txt"]);
    assert.equal(fixture.browser.currentFocusedRowIndex, 2);
    fixture.browser.dispose();
  });
});

test("directory selection does not silently include hidden files until Hidden is enabled", async () => {
  await withTempDirectory("pi-files-hidden-select", async (root) => {
    await writeFile(root, "dir/visible.txt", "visible");
    await writeFile(root, "dir/.secret", "secret");
    const fixture = await createBrowser(root);
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    assert.deepEqual([...fixture.state.selectedPaths], ["dir/visible.txt"]);
    const hiddenOffDirectory = fixture.browser.currentRows.find((row) => row.node?.relativePath === "dir");
    assert.equal(hiddenOffDirectory?.selected, true);
    assert.equal(hiddenOffDirectory?.partiallySelected, false);
    fixture.browser.handleInput("h");
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    assert.deepEqual([...fixture.state.selectedPaths].sort(), ["dir/.secret", "dir/visible.txt"]);
    fixture.browser.dispose();
  });
});

test("incremental filtering preserves selection and shows filtered-out selections", async () => {
  await withTempDirectory("pi-files-filter", async (root) => {
    await writeFile(root, "alpha.ts", "a");
    await writeFile(root, "beta.ts", "b");
    await writeFile(root, "gamma.md", "g");
    const fixture = await createBrowser(root);
    const gammaIndex = fixture.browser.currentRows.findIndex((row) => row.node?.relativePath === "gamma.md");
    await fixture.browser.toggleSelectionAt(gammaIndex);
    fixture.browser.handleInput("/");
    fixture.browser.handleInput("a");
    fixture.browser.handleInput("l");
    await fixture.browser.settle();
    const paths = fixture.browser.currentRows.flatMap((row) => (row.node ? [row.node.relativePath] : []));
    assert.ok(paths.includes("alpha.ts"));
    assert.ok(paths.includes("gamma.md"), "selected file remains visible as a supplemental row");
    assert.equal(fixture.state.selectedPaths.has("gamma.md"), true);
    assert.equal(fixture.ui.notifications.some((entry) => /abort/i.test(entry.message)), false);
    fixture.browser.handleInput("\u001b");
    assert.equal(fixture.browser.currentFilter, "");
    assert.equal(fixture.closed.value, 0);
    fixture.browser.handleInput("\u001b");
    assert.equal(fixture.closed.value, 1);
  });
});

test("wide and narrow layouts never allocate unusably narrow side-by-side panes", () => {
  const wide = computeBrowserLayout(120, 30);
  assert.equal(wide.narrow, false);
  assert.ok((wide.tree?.width ?? 0) >= 28);
  assert.ok((wide.preview?.width ?? 0) >= 36);
  const narrow = computeBrowserLayout(70, 20);
  assert.equal(narrow.narrow, true);
  assert.equal(narrow.tree, undefined);
  assert.equal(narrow.preview, undefined);
  assert.ok(narrow.tabs);
  assert.ok(narrow.singlePane);
  assert.deepEqual(
    computeBrowserLayout(20, 12).actionButtons.map((button) => button.id),
    ["insert-paths", "insert-contents", "clear", "close"],
  );
});

test("tree and preview wheel scrolling are independent", async () => {
  await withTempDirectory("pi-files-wheel", async (root) => {
    await writeFile(root, "00-long.txt", Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n"));
    for (let index = 1; index < 35; index += 1) await writeFile(root, `${String(index).padStart(2, "0")}.txt`, String(index));
    const fixture = await createBrowser(root, { rows: 16, columns: 120 });
    fixture.browser.handleInput("\r");
    await fixture.browser.settle();
    fixture.browser.render(120);
    const layout = fixture.browser.currentLayout;
    assert.ok(layout.tree && layout.preview);
    fixture.browser.handleMouse({
      kind: "wheel",
      x: (layout.tree?.x ?? 0) + 2,
      y: (layout.tree?.y ?? 0) + 3,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 1,
    });
    assert.ok(fixture.browser.currentTreeScroll > 0);
    assert.equal(fixture.browser.currentPreviewScroll, 0);
    const treeAfter = fixture.browser.currentTreeScroll;
    fixture.browser.handleMouse({
      kind: "wheel",
      x: (layout.preview?.x ?? 0) + 2,
      y: (layout.preview?.y ?? 0) + 3,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 1,
    });
    assert.equal(fixture.browser.currentTreeScroll, treeAfter);
    assert.ok(fixture.browser.currentPreviewScroll > 0);
    fixture.browser.dispose();
  });
});

test("preview dragging is left to terminal text selection", async () => {
  await withTempDirectory("pi-files-preview-drag", async (root) => {
    await writeFile(root, "file.txt", "one\ntwo");
    const fixture = await createBrowser(root);
    const preview = fixture.browser.currentLayout.preview;
    assert.ok(preview);
    const result = fixture.browser.handleMouse({
      kind: "press",
      button: "left",
      x: (preview?.x ?? 0) + 2,
      y: (preview?.y ?? 0) + 2,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.equal(result.handled, false);
    assert.equal(result.preserveTextSelection, true);
    fixture.browser.dispose();
  });
});

test("mouse checkbox selection matches Space and directory row activation matches Right", async () => {
  await withTempDirectory("pi-files-parity", async (root) => {
    await writeFile(root, "dir/file.txt", "value");
    await writeFile(root, "z.txt", "z");

    const keyboard = await createBrowser(root);
    keyboard.browser.handleInput(" ");
    await keyboard.browser.settle();
    const keyboardSelected = [...keyboard.state.selectedPaths].sort();
    keyboard.browser.handleInput("\u001b[C");
    await keyboard.browser.settle();
    assert.equal(keyboard.tree.getNode("dir").expanded, true);

    const mouse = await createBrowser(root);
    mouse.browser.render(120);
    const tree = mouse.browser.currentLayout.tree;
    assert.ok(tree);
    const firstRowY = (tree?.y ?? 0) + 1;
    const checkboxX = (tree?.x ?? 0) + 2;
    mouse.browser.handleMouse({
      kind: "press",
      button: "left",
      x: checkboxX,
      y: firstRowY,
      shift: false,
      alt: false,
      ctrl: false,
    });
    await mouse.browser.settle();
    assert.deepEqual([...mouse.state.selectedPaths].sort(), keyboardSelected);

    // Recreate and click the directory row outside its checkbox: row click toggles expansion.
    const rowMouse = await createBrowser(root);
    rowMouse.browser.render(120);
    const rowTree = rowMouse.browser.currentLayout.tree;
    rowMouse.browser.handleMouse({
      kind: "press",
      button: "left",
      x: (rowTree?.x ?? 0) + 8,
      y: (rowTree?.y ?? 0) + 1,
      shift: false,
      alt: false,
      ctrl: false,
    });
    await rowMouse.browser.settle();
    assert.equal(rowMouse.tree.getNode("dir").expanded, true);
    keyboard.browser.dispose();
    mouse.browser.dispose();
    rowMouse.browser.dispose();
  });
});


test("clicking a file opens the Preview tab on narrow terminals", async () => {
  await withTempDirectory("pi-files-narrow-preview", async (root) => {
    await writeFile(root, "file.txt", "preview me");
    const fixture = await createBrowser(root, { columns: 60, rows: 14 });
    const pane = fixture.browser.currentLayout.singlePane;
    assert.ok(pane);
    fixture.browser.handleMouse({
      kind: "press",
      button: "left",
      x: (pane?.x ?? 0) + 8,
      y: (pane?.y ?? 0) + 1,
      shift: false,
      alt: false,
      ctrl: false,
    });
    await fixture.browser.settle();
    assert.equal(fixture.browser.currentFocusTarget, "preview");
    assert.equal(fixture.browser.currentPreview?.metadata.relativePath, "file.txt");
    fixture.browser.dispose();
  });
});

test("dragging an action into Preview cancels and clears the pending press", async () => {
  await withTempDirectory("pi-files-button-preview-drag", async (root) => {
    await writeFile(root, "file.txt", "value");
    const fixture = await createBrowser(root);
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    fixture.browser.render(120);
    const button = fixture.browser.currentLayout.actionButtons.find((entry) => entry.id === "insert-paths");
    const preview = fixture.browser.currentLayout.preview;
    assert.ok(button && preview);
    const buttonX = (button?.rect.x ?? 0) + 1;
    const buttonY = button?.rect.y ?? 0;
    const previewX = (preview?.x ?? 0) + 2;
    const previewY = (preview?.y ?? 0) + 2;
    fixture.browser.handleMouse({ kind: "press", button: "left", x: buttonX, y: buttonY, shift: false, alt: false, ctrl: false });
    fixture.browser.handleMouse({ kind: "move", button: "left", x: previewX, y: previewY, shift: false, alt: false, ctrl: false });
    fixture.browser.handleMouse({ kind: "release", button: "left", x: previewX, y: previewY, shift: false, alt: false, ctrl: false });
    await fixture.browser.settle();
    assert.deepEqual(fixture.ui.pastes, []);

    fixture.browser.handleMouse({ kind: "press", button: "left", x: buttonX, y: buttonY, shift: false, alt: false, ctrl: false });
    fixture.browser.handleMouse({ kind: "release", button: "left", x: buttonX, y: buttonY, shift: false, alt: false, ctrl: false });
    await fixture.browser.settle();
    assert.equal(fixture.ui.pastes.length, 1, "a cancelled drag must not leave stale pressed state");
  });
});

test("action buttons require press and release in place; dragging cancels", async () => {
  await withTempDirectory("pi-files-button", async (root) => {
    await writeFile(root, "file.txt", "value");
    const fixture = await createBrowser(root);
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    fixture.browser.render(120);
    const button = fixture.browser.currentLayout.actionButtons.find((entry) => entry.id === "insert-paths");
    assert.ok(button);
    const x = (button?.rect.x ?? 0) + 1;
    const y = button?.rect.y ?? 0;
    fixture.browser.handleMouse({ kind: "press", button: "left", x, y, shift: false, alt: false, ctrl: false });
    fixture.browser.handleMouse({ kind: "move", button: "left", x: x + 20, y, shift: false, alt: false, ctrl: false });
    fixture.browser.handleMouse({ kind: "release", button: "left", x: x + 20, y, shift: false, alt: false, ctrl: false });
    await fixture.browser.settle();
    assert.deepEqual(fixture.ui.pastes, []);
    fixture.browser.handleMouse({ kind: "press", button: "left", x, y, shift: false, alt: false, ctrl: false });
    fixture.browser.handleMouse({ kind: "release", button: "left", x, y, shift: false, alt: false, ctrl: false });
    await fixture.browser.settle();
    assert.deepEqual(fixture.ui.pastes, [formatSelectedPaths(["file.txt"])]);
    assert.equal(fixture.closed.value, 1);
  });
});

test("Insert contents uses the budget dialog and never submits the editor", async () => {
  await withTempDirectory("pi-files-no-submit", async (root) => {
    await writeFile(root, "file.txt", "exact content\n</file>\n");
    const fixture = await createBrowser(root);
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    fixture.browser.handleInput("\t"); // preview
    fixture.browser.handleInput("\t"); // insert paths
    fixture.browser.handleInput("\t"); // insert contents
    fixture.browser.handleInput("\r");
    await fixture.browser.settle();
    assert.equal(fixture.browser.isBudgetOpen, true);
    fixture.browser.render(120);
    fixture.browser.handleInput("\t"); // Insert button
    fixture.browser.handleInput("\r");
    await fixture.browser.settle();
    assert.equal(fixture.ui.pastes.length, 1);
    assert.match(fixture.ui.pastes[0] ?? "", /pi-files-ui:length-delimited-v1/);
    assert.equal(fixture.ui.submissions, 0);
    assert.equal(fixture.closed.value, 1);
  });
});

test("refresh removes deleted stale selections with a notification", async () => {
  await withTempDirectory("pi-files-stale", async (root) => {
    await writeFile(root, "gone.txt", "value");
    const fixture = await createBrowser(root);
    fixture.browser.handleInput(" ");
    await fixture.browser.settle();
    await fs.unlink(path.join(root, "gone.txt"));
    await fixture.browser.refreshNow();
    assert.deepEqual([...fixture.state.selectedPaths], []);
    assert.ok(fixture.ui.notifications.some((entry) => /Removed deleted selection/.test(entry.message)));
    fixture.browser.dispose();
  });
});

test("rendering stays within terminal width and switches narrow tabs", async () => {
  await withTempDirectory("pi-files-render", async (root) => {
    await writeFile(root, "very-long-file-name-that-needs-truncation.txt", "line\twith\ttabs");
    const fixture = await createBrowser(root, { columns: 60, rows: 14 });
    const lines = fixture.browser.render(60);
    assert.equal(lines.length, 14);
    for (const line of lines) assert.ok(cellWidth(line) <= 60, `${stripAnsi(line)} exceeded width`);
    assert.equal(fixture.browser.currentLayout.narrow, true);
    fixture.browser.handleInput("\t");
    assert.equal(fixture.browser.currentFocusTarget, "preview");
    fixture.browser.dispose();
  });
});

test("cleanup disposes mouse listeners, bounded refresh resources, and the tree", async () => {
  await withTempDirectory("pi-files-cleanup", async (root) => {
    await writeFile(root, "file.txt", "value");
    const fixture = await createBrowser(root, { refreshIntervalMs: 60_000 });
    assert.equal(fixture.browser.mouseAvailable, true);
    fixture.browser.dispose();
    assert.equal(fixture.browser.isDisposed, true);
    assert.equal(fixture.tree.isDisposed, true);
    assert.equal(fixture.tui.mouseDisposed, 1);
    fixture.browser.dispose();
    assert.equal(fixture.tui.mouseDisposed, 1);
  });
});
