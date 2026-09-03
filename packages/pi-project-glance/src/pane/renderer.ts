import {
  PROJECT_GLANCE_SECTION,
  PROJECT_GLANCE_TITLE,
} from "../protocol/model.js";
import type { ProjectGlanceConnectionState } from "../protocol/client.js";
import type {
  ProjectGlanceCurrent,
  ProjectGlanceFeedItem,
  ProjectGlanceSnapshot,
} from "../protocol/model.js";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

function hardWrap(line: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  if (visibleWidth(line) <= safeWidth) return [line];
  const lines: string[] = [];
  let remaining = line;
  while (visibleWidth(remaining) > safeWidth) {
    let part = sliceByColumn(remaining, 0, safeWidth, true);
    if (visibleWidth(part) === 0) part = sliceByColumn(remaining, 0, safeWidth, false);
    if (visibleWidth(part) === 0) break;
    lines.push(part);
    remaining = sliceByColumn(remaining, visibleWidth(part), Number.MAX_SAFE_INTEGER, false);
  }
  if (remaining.length > 0 || lines.length === 0) lines.push(remaining);
  return lines;
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const wrapped = wrapTextWithAnsi(text, safeWidth);
  return wrapped.flatMap((line) => hardWrap(line, safeWidth));
}

function renderLabeled(label: string, value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const prefix = `${label}: `;
  const prefixWidth = visibleWidth(prefix);
  const firstWidth = Math.max(1, safeWidth - prefixWidth);
  const wrapped = wrapText(value, safeWidth);
  const firstParts = hardWrap(wrapped[0] ?? "", firstWidth);
  const lines: string[] = [];
  if (firstParts.length > 0) lines.push(`${prefix}${firstParts[0]}`);
  for (const part of firstParts.slice(1)) lines.push(`  ${part}`);
  const continuationWidth = Math.max(1, safeWidth - 2);
  for (const line of wrapped.slice(1).flatMap((item) => hardWrap(item, continuationWidth))) {
    lines.push(`  ${line}`);
  }
  return lines.length > 0 ? lines : [truncateToWidth(prefix.trimEnd(), safeWidth)];
}

function renderCurrent(current: ProjectGlanceCurrent, width: number): string[] {
  const rows: string[] = [];
  for (const [label, value] of [
    ["Step", current.step],
    ["Toward", current.toward],
    ["Focus", current.focus],
  ] as const) {
    if (!value) continue;
    rows.push(...renderLabeled(label, value, width));
  }
  return rows;
}

function renderItem(item: ProjectGlanceFeedItem, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const label = truncateToWidth(`• ${item.type}`, safeWidth);
  const indent = safeWidth > 2 ? "  " : " ".repeat(Math.max(0, safeWidth - 1));
  const textWidth = Math.max(1, safeWidth - visibleWidth(indent));
  return [label, ...wrapText(item.text, textWidth).map((line) => `${indent}${line}`)];
}

function connectionBanner(state: ProjectGlanceConnectionState): string | undefined {
  if (state === "connecting") return "CONNECTING: Waiting for the local relay.";
  if (state === "reconnecting") return "RECONNECTING: Reconnecting to the local relay.";
  if (state === "disconnected") return "DISCONNECTED: Local relay unavailable.";
  return undefined;
}

/** Render the fixed region. It is intentionally a separate component boundary. */
export function renderProjectGlancePinned(
  snapshot: ProjectGlanceSnapshot | undefined,
  state: ProjectGlanceConnectionState,
  width: number,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [PROJECT_GLANCE_TITLE];
  const banner = connectionBanner(state);
  if (banner) lines.push(banner);
  lines.push("CURRENT");
  if (snapshot) lines.push(...renderCurrent(snapshot.current, safeWidth));
  lines.push("");
  return lines;
}

/** Render only the feed region; this is the sole content placed in ScrollView. */
export function renderProjectGlanceFeed(
  snapshot: ProjectGlanceSnapshot | undefined,
  width: number,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [PROJECT_GLANCE_SECTION.toUpperCase()];
  if (!snapshot) {
    lines.push("Waiting for the local relay.");
    return lines;
  }
  for (const item of snapshot.feed) {
    lines.push(...renderItem(item, safeWidth));
    lines.push("");
  }
  if (snapshot.feed.length === 0) lines.push("No progress items.");
  return lines;
}

/** Convenience document renderer for bounded tests and diagnostics. */
export function renderProjectGlance(
  snapshot: ProjectGlanceSnapshot | undefined,
  state: ProjectGlanceConnectionState,
  width: number,
): string[] {
  return [
    ...renderProjectGlancePinned(snapshot, state, width),
    ...renderProjectGlanceFeed(snapshot, width),
  ];
}

export function renderProjectGlanceAtHeight(
  snapshot: ProjectGlanceSnapshot | undefined,
  state: ProjectGlanceConnectionState,
  width: number,
  height: number,
): string[] {
  return renderProjectGlance(snapshot, state, width).slice(0, Math.max(1, height));
}
