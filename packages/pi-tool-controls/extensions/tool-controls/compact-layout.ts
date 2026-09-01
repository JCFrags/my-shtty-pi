import type { HitRegion } from "./mouse.js";
import { textWidth, truncateText } from "./text.js";

export type CompactAction = "open" | "expand-turn" | "collapse-turn" | "more";
export type CompactLayoutMode = "wide" | "medium" | "narrow";

export interface CompactLayoutState {
  expanded: number;
  total: number;
  canExpandTurn: boolean;
  canCollapseTurn: boolean;
  busy: boolean;
}

export interface CompactControl {
  id: CompactAction;
  label: string;
  enabled: boolean;
  colStart: number;
  colEnd: number;
}

export interface CompactLayout {
  mode: CompactLayoutMode;
  controls: CompactControl[];
  regions: HitRegion[];
  plainLine: string;
}

function labelsForMode(mode: CompactLayoutMode, toolsLabel: string): Array<[CompactAction, string]> {
  if (mode === "wide") {
    return [
      ["open", toolsLabel],
      ["expand-turn", "[Expand turn]"],
      ["collapse-turn", "[Collapse turn]"],
      ["more", "[More…]"],
    ];
  }
  if (mode === "medium") {
    return [
      ["open", toolsLabel],
      ["expand-turn", "[Expand]"],
      ["collapse-turn", "[Collapse]"],
    ];
  }
  return [["open", toolsLabel]];
}

function candidateWidth(labels: readonly [CompactAction, string][]): number {
  return labels.reduce(
    (total, [, label], index) => total + textWidth(label) + (index === 0 ? 0 : 1),
    0,
  );
}

function enabledFor(action: CompactAction, state: CompactLayoutState): boolean {
  if (action === "open" || action === "more") return !state.busy;
  if (action === "expand-turn") return !state.busy && state.canExpandTurn;
  return !state.busy && state.canCollapseTurn;
}

export function createCompactLayout(width: number, state: CompactLayoutState): CompactLayout {
  const safeWidth = Math.max(0, Math.trunc(width));
  const toolsLabel = `[Tools ${state.expanded}/${state.total}]`;
  const wide = labelsForMode("wide", toolsLabel);
  const medium = labelsForMode("medium", toolsLabel);

  const mode: CompactLayoutMode =
    candidateWidth(wide) <= safeWidth
      ? "wide"
      : candidateWidth(medium) <= safeWidth
        ? "medium"
        : "narrow";

  const requested = labelsForMode(mode, toolsLabel);
  const controls: CompactControl[] = [];
  const regions: HitRegion[] = [];
  const pieces: string[] = [];
  let col = 0;

  for (const [id, originalLabel] of requested) {
    const separatorWidth = pieces.length === 0 ? 0 : 1;
    const remaining = safeWidth - col - separatorWidth;
    if (remaining <= 0) break;

    if (separatorWidth > 0) {
      pieces.push(" ");
      col += 1;
    }

    const label = truncateText(originalLabel, remaining, "");
    if (label.length === 0) break;
    const start = col;
    const end = start + textWidth(label);
    const enabled = enabledFor(id, state);

    pieces.push(label);
    controls.push({ id, label, enabled, colStart: start, colEnd: end });
    regions.push({
      id,
      role: "button",
      rowStart: 0,
      rowEnd: 1,
      colStart: start,
      colEnd: end,
      enabled,
    });
    col = end;
  }

  return { mode, controls, regions, plainLine: pieces.join("") };
}
