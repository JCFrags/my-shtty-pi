import type { BrowserFocusTarget, BrowserLayout, Rect } from "../types.ts";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function actionLabels(width: number): Array<{ id: Exclude<BrowserFocusTarget, "tree" | "preview">; label: string }> {
  if (width >= 62) {
    return [
      { id: "insert-paths", label: "Insert paths" },
      { id: "insert-contents", label: "Insert contents" },
      { id: "clear", label: "Clear" },
      { id: "close", label: "Close" },
    ];
  }
  if (width >= 34) {
    return [
      { id: "insert-paths", label: "Paths" },
      { id: "insert-contents", label: "Contents" },
      { id: "clear", label: "Clear" },
      { id: "close", label: "Close" },
    ];
  }
  return [
    { id: "insert-paths", label: "P" },
    { id: "insert-contents", label: "C" },
    { id: "clear", label: "X" },
    { id: "close", label: "Q" },
  ];
}

function buildActionButtons(width: number, y: number): BrowserLayout["actionButtons"] {
  const labels = actionLabels(width);
  const buttons: BrowserLayout["actionButtons"] = [];
  let x = 0;
  for (const entry of labels) {
    const buttonWidth = entry.label.length + 2;
    if (x + buttonWidth > width) break;
    buttons.push({ id: entry.id, label: entry.label, rect: { x, y, width: buttonWidth, height: 1 } });
    x += buttonWidth + 1;
  }
  return buttons;
}

export function computeBrowserLayout(width: number, height: number): BrowserLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(6, Math.floor(height));
  const narrow = safeWidth < 78;
  const header: Rect = { x: 0, y: 0, width: safeWidth, height: 1 };
  const actions: Rect = { x: 0, y: safeHeight - 1, width: safeWidth, height: 1 };
  const actionButtons = buildActionButtons(safeWidth, actions.y);

  if (narrow) {
    const tabs: Rect = { x: 0, y: 1, width: safeWidth, height: 1 };
    const contentY = 3;
    const contentRows = Math.max(1, safeHeight - contentY - 2);
    const singlePane: Rect = {
      x: 1,
      y: contentY,
      width: Math.max(1, safeWidth - 2),
      height: contentRows,
    };
    return {
      width: safeWidth,
      height: safeHeight,
      narrow,
      header,
      tabs,
      singlePane,
      actions,
      contentRows,
      actionButtons,
    };
  }

  const interiorWidth = Math.max(3, safeWidth - 2);
  const minimumTree = 28;
  const minimumPreview = 36;
  const treeWidth = clamp(Math.floor(interiorWidth * 0.38), minimumTree, Math.max(minimumTree, interiorWidth - minimumPreview - 1));
  const previewWidth = Math.max(1, interiorWidth - treeWidth - 1);
  const contentRows = Math.max(1, safeHeight - 4);
  const tree: Rect = { x: 1, y: 2, width: treeWidth, height: contentRows };
  const preview: Rect = { x: tree.x + tree.width + 1, y: 2, width: previewWidth, height: contentRows };
  return {
    width: safeWidth,
    height: safeHeight,
    narrow,
    header,
    tree,
    preview,
    actions,
    contentRows,
    actionButtons,
  };
}

export function pointInRect(x: number, y: number, rect: Rect | undefined): boolean {
  return rect !== undefined && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
