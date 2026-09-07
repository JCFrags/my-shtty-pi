import { PROJECT_GLANCE_SECTION } from "../protocol/model.js";
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
  if (prefixWidth >= safeWidth) return wrapText(`${prefix}${value}`, safeWidth);
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

function feedItemLabel(type: ProjectGlanceFeedItem["type"]): string {
  if (type === "assistant_update") return "Assistant update";
  if (type === "checkpoint") return "Checkpoint";
  if (type === "milestone_completed") return "Milestone completed";
  return "Plan completed";
}

function renderItemContent(
  item: ProjectGlanceFeedItem,
  width: number,
  expanded = true,
  selected = false,
  unread = false,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const link = (action: string, text: string) =>
    `\u001b]8;;project-glance://${action}/${encodeURIComponent(item.id)}\u0007${text}\u001b]8;;\u0007`;
  const date = new Date(item.createdAt);
  const time = Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : "--:--";
  const compact = [
    `${selected ? ">" : " "}${link("read", unread ? "●" : "•")}`,
    time,
    link("toggle", feedItemLabel(item.type)),
    link("dismiss", "×"),
  ].join(" ");
  const label = truncateToWidth(compact, safeWidth);
  const indent = safeWidth > 2 ? "  " : " ".repeat(Math.max(0, safeWidth - 1));
  const textWidth = Math.max(1, safeWidth - visibleWidth(indent));
  if (expanded) {
    return [
      label,
      ...wrapText(item.text, textWidth).map((line) => `${indent}${line}`),
    ];
  }
  const summary = item.text.replace(/\s+/gu, " ");
  return [label, truncateToWidth(`${indent}${summary}`, safeWidth)];
}

const FEED_CARD_STYLE = "\u001b[48;5;236m\u001b[38;5;255m";
const CURRENT_CARD_STYLE = "\u001b[48;5;24m\u001b[38;5;255m";
const CARD_RESET = "\u001b[0m";

function cardLine(text: string, width: number, style: string): string {
  const clipped = truncateToWidth(text, width, "");
  const styleSafe = clipped.replaceAll(CARD_RESET, `${CARD_RESET}${style}`);
  return `${style}${styleSafe}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${CARD_RESET}`;
}

function renderBox(content: string[], width: number, style: string): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < 4) return content.map((line) => cardLine(line, safeWidth, style));
  const innerWidth = safeWidth - 2;
  return [
    cardLine(`┌${"─".repeat(innerWidth)}┐`, safeWidth, style),
    ...content.map((line) => {
      const clipped = truncateToWidth(line, innerWidth, "");
      return cardLine(
        `│${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}│`,
        safeWidth,
        style,
      );
    }),
    cardLine(`└${"─".repeat(innerWidth)}┘`, safeWidth, style),
  ];
}

function renderItem(
  item: ProjectGlanceFeedItem,
  width: number,
  expanded = true,
  selected = false,
  unread = false,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const contentWidth = safeWidth < 4 ? safeWidth : safeWidth - 2;
  return renderBox(
    renderItemContent(item, contentWidth, expanded, selected, unread),
    safeWidth,
    FEED_CARD_STYLE,
  );
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
  const lines: string[] = [];
  const banner = connectionBanner(state);
  if (banner) lines.push(truncateToWidth(banner, safeWidth, ""));
  const contentWidth = safeWidth < 4 ? safeWidth : safeWidth - 2;
  lines.push(...renderBox(
    ["CURRENT", ...(snapshot ? renderCurrent(snapshot.current, contentWidth) : [])],
    safeWidth,
    CURRENT_CARD_STYLE,
  ));
  lines.push("");
  return lines;
}

/** Render only the feed region; this is the sole content placed in ScrollView. */
export function renderProjectGlanceFeed(
  snapshot: ProjectGlanceSnapshot | undefined,
  width: number,
  options: { selectedId?: string; expandedIds?: ReadonlySet<string> } = {},
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const dismissed = new Set(snapshot?.uiState?.dismissedIds ?? []);
  const read = new Set(snapshot?.uiState?.readIds ?? []);
  const visible = snapshot?.feed.filter((item) => !dismissed.has(item.id)) ?? [];
  const unread = visible.filter((item) => !read.has(item.id)).length;
  const lines: string[] = [
    truncateToWidth(PROJECT_GLANCE_SECTION.toUpperCase(), safeWidth, ""),
    truncateToWidth(`${unread} unread`, safeWidth, ""),
  ];
  if (!snapshot) {
    lines.push(truncateToWidth("Waiting for the local relay.", safeWidth, ""));
    return lines;
  }
  for (const item of visible) {
    lines.push(...renderItem(
      item,
      safeWidth,
      options.expandedIds?.has(item.id) ?? true,
      options.selectedId === item.id,
      !read.has(item.id),
    ));
    lines.push("");
  }
  if (visible.length === 0) lines.push(truncateToWidth("No progress items.", safeWidth, ""));
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
