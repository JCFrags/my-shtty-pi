import type { BodyResult, HistoryView, ItemPreview } from "../history/contracts.js";
import { PROJECT_GLANCE_SECTION } from "../protocol/model.js";
import type { ProjectGlanceConnectionState } from "../protocol/client.js";
import type {
  ProjectGlanceCurrent,
  ProjectGlanceFeedItem,
  ProjectGlanceSnapshot,
} from "../protocol/model.js";
import type { ProjectGlanceArchiveModel } from "./archive.js";
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
  return wrapTextWithAnsi(text, safeWidth).flatMap((line) => hardWrap(line, safeWidth));
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
  for (const line of wrapped.slice(1).flatMap((item) => hardWrap(item, continuationWidth))) lines.push(`  ${line}`);
  return lines.length > 0 ? lines : [truncateToWidth(prefix.trimEnd(), safeWidth)];
}

function renderCurrent(current: ProjectGlanceCurrent, width: number): string[] {
  const rows: string[] = [];
  for (const [label, value] of [["Step", current.step], ["Toward", current.toward], ["Focus", current.focus]] as const) {
    if (value) rows.push(...renderLabeled(label, value, width));
  }
  return rows;
}

function feedItemLabel(type: ProjectGlanceFeedItem["type"]): string {
  if (type === "assistant_update") return "Assistant update";
  if (type === "checkpoint") return "Checkpoint";
  if (type === "milestone_completed") return "Milestone completed";
  return "Plan completed";
}

interface RenderItem {
  id: string;
  type: ProjectGlanceFeedItem["type"];
  text: string;
  createdAt: string;
  bodyBytes?: number;
}

function renderItemContent(item: RenderItem, width: number, expanded: boolean, selected: boolean, history: boolean, unread = true, body?: BodyResult, loading = false, error?: string): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const date = new Date(item.createdAt);
  const time = Number.isFinite(date.getTime()) ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "--:--";
  const compact = [`${selected ? ">" : " "}${history ? "·" : unread ? "●" : "•"}`, expanded ? "▾" : "▸", time, feedItemLabel(item.type)].join(" ");
  const label = truncateToWidth(compact, safeWidth);
  const indent = safeWidth > 2 ? "  " : " ".repeat(Math.max(0, safeWidth - 1));
  const textWidth = Math.max(1, safeWidth - visibleWidth(indent));
  if (expanded) {
    const text = body?.text ?? item.text;
    const lines = [label, ...wrapText(text, textWidth).map((line) => `${indent}${line}`)];
    if (loading) lines.push(truncateToWidth(`${indent}Loading full body…`, safeWidth));
    if (error) lines.push(truncateToWidth(`${indent}${error}`, safeWidth));
    if (body) lines.push(truncateToWidth(`${indent}Bytes ${body.offset + Buffer.byteLength(body.text, "utf8")} of ${body.totalBytes}`, safeWidth));
    return lines;
  }
  const wrapped = wrapText(item.text, textWidth);
  const preview = wrapped.slice(0, 2);
  if (wrapped.length > 2) preview[1] = `${sliceByColumn(preview[1] ?? "", 0, Math.max(0, textWidth - 1), true).trimEnd()}…`;
  return [label, ...preview.map((line) => `${indent}${line}`)];
}

const FEED_CARD_STYLE = "\u001b[48;5;236m\u001b[38;5;255m";
const HISTORY_CARD_STYLE = "\u001b[48;5;234m\u001b[38;5;245m";
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
      return cardLine(`│${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}│`, safeWidth, style);
    }),
    cardLine(`└${"─".repeat(innerWidth)}┘`, safeWidth, style),
  ];
}

function link(action: string, id: string, text: string): string {
  return `\u001b]8;;project-glance://${action}/${encodeURIComponent(id)}\u0007${text}\u001b]8;;\u0007`;
}

function renderItem(item: RenderItem, width: number, options: { expanded: boolean; selected: boolean; history: boolean; unread?: boolean; body?: BodyResult; loading?: boolean; error?: string }): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const contentWidth = safeWidth < 4 ? safeWidth : safeWidth - 2;
  const bordered = safeWidth >= 4;
  const closeLabel = contentWidth >= 3 ? "[×]" : "×";
  const rightPadding = contentWidth >= 5 ? 1 : 0;
  const closeStart = safeWidth - (bordered ? 1 : 0) - rightPadding - visibleWidth(closeLabel);
  const content = renderItemContent(item, contentWidth, options.expanded, options.selected, options.history, options.unread, options.body, options.loading, options.error);
  const reserved = options.history ? 0 : visibleWidth(closeLabel) + rightPadding + 1;
  content[0] = truncateToWidth(content[0] ?? "", Math.max(0, contentWidth - reserved), "");
  const style = options.history ? HISTORY_CARD_STYLE : FEED_CARD_STYLE;
  const rows = renderBox(content, safeWidth, style);
  return rows.map((row, index) => {
    if (options.history || index !== (bordered ? 1 : 0)) return link("toggle", item.id, row);
    return cardLine(
      link("toggle", item.id, sliceByColumn(row, 0, closeStart, true)) +
        link("dismiss", item.id, `\u001b[1m${closeLabel}\u001b[22m`) +
        link("toggle", item.id, `${" ".repeat(rightPadding)}${bordered ? "│" : ""}`),
      safeWidth,
      style,
    );
  });
}

function bodyControls(itemId: string, previous: boolean, next: boolean, width: number): string[] {
  const controls = [
    previous ? link("body-previous", itemId, "[Previous body chunk]") : "",
    next ? link("body-next", itemId, "[Next body chunk]") : "",
  ].filter(Boolean).join(" ");
  return controls ? [truncateToWidth(controls, width, "")] : [];
}

function pageControls(view: HistoryView, previous: boolean, next: boolean, initial: boolean, width: number): string[] {
  const controls = [
    !initial ? link(`page-${view}-first`, view, "[First page]") : "",
    previous ? link(`page-${view}-previous`, view, "[Previous page]") : "",
    next ? link(`page-${view}-next`, view, "[Next page]") : "",
  ].filter(Boolean).join(" ");
  return controls ? [truncateToWidth(controls, width, "")] : [];
}

function connectionBanner(state: ProjectGlanceConnectionState): string | undefined {
  if (state === "connecting") return "CONNECTING: Waiting for the local relay.";
  if (state === "reconnecting") return "RECONNECTING: Reconnecting to the local relay.";
  if (state === "disconnected") return "DISCONNECTED: Local relay unavailable.";
  return undefined;
}

export function renderProjectGlancePinned(snapshot: ProjectGlanceSnapshot | undefined, state: ProjectGlanceConnectionState, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  const banner = connectionBanner(state);
  if (banner) lines.push(truncateToWidth(banner, safeWidth, ""));
  const contentWidth = safeWidth < 4 ? safeWidth : safeWidth - 2;
  lines.push(...renderBox(["CURRENT", ...(snapshot ? renderCurrent(snapshot.current, contentWidth) : [])], safeWidth, CURRENT_CARD_STYLE));
  lines.push("");
  return lines;
}

function previewItem(item: ItemPreview): RenderItem {
  return { id: item.itemId, type: item.type, text: item.preview, createdAt: item.createdAt, bodyBytes: item.bodyBytes };
}

export function renderProjectGlanceFeed(snapshot: ProjectGlanceSnapshot | undefined, width: number, options: { selectedId?: string; expandedIds?: ReadonlySet<string>; archive?: ProjectGlanceArchiveModel } = {}): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const archive = options.archive;
  const dismissed = new Set(snapshot?.uiState?.dismissedIds ?? []);
  if (!archive?.summary) {
    const read = new Set(snapshot?.uiState?.readIds ?? []);
    const visible = snapshot?.feed.filter((item) => !dismissed.has(item.id)) ?? [];
    const lines = [
      truncateToWidth(PROJECT_GLANCE_SECTION.toUpperCase(), safeWidth, ""),
      truncateToWidth(`${visible.filter((item) => !read.has(item.id)).length} unread`, safeWidth, ""),
    ];
    if (!snapshot) {
      lines.push(truncateToWidth("Waiting for the local relay.", safeWidth, ""));
      return lines;
    }
    for (const value of visible) {
      const item = { id: value.id, type: value.type, text: value.text, createdAt: value.createdAt };
      lines.push(...renderItem(item, safeWidth, {
        expanded: options.expandedIds?.has(item.id) ?? false,
        selected: options.selectedId === item.id,
        history: false,
        unread: !read.has(item.id),
      }), "");
    }
    if (visible.length === 0) lines.push(truncateToWidth("No progress items.", safeWidth, ""));
    return lines;
  }
  const fallback = snapshot?.feed.filter((item) => !dismissed.has(item.id)) ?? [];
  const inbox: RenderItem[] = archive?.hasActivePage("inbox") ? archive.activeItems("inbox").map(previewItem) : fallback.map((item) => ({ id: item.id, type: item.type, text: item.text, createdAt: item.createdAt, bodyBytes: Buffer.byteLength(item.text, "utf8") }));
  const inboxCount = archive?.summary?.inboxCount ?? inbox.length;
  const lines: string[] = [truncateToWidth("INBOX", safeWidth, ""), truncateToWidth(`${inboxCount} unread`, safeWidth, "")];
  if (!snapshot) {
    lines.push(truncateToWidth("Waiting for the local relay.", safeWidth, ""));
    return lines;
  }
  if (archive?.summary?.state === "importing") lines.push(truncateToWidth("Archive import is in progress.", safeWidth, ""));
  if (archive?.summary?.state === "error") lines.push(truncateToWidth(`Archive error${archive.summary.errorCode ? `: ${archive.summary.errorCode}` : "."}`, safeWidth, ""));
  if (archive?.pageLoading("inbox") && !archive.hasActivePage("inbox")) lines.push(truncateToWidth("Loading inbox…", safeWidth, ""));
  if (archive.pageError("inbox")) {
    lines.push(truncateToWidth(archive.pageError("inbox") ?? "", safeWidth, ""));
    lines.push(link("page-inbox-first", "inbox", "[Retry inbox page]"));
  }
  for (const item of inbox) {
    const expanded = options.expandedIds?.has(item.id) ?? false;
    const body = archive?.body(item.id);
    const error = archive?.bodyError(item.id);
    lines.push(...renderItem(item, safeWidth, {
      expanded,
      selected: options.selectedId === item.id,
      history: false,
      ...(body ? { body } : {}),
      ...(archive.bodyLoading(item.id) ? { loading: true } : {}),
      ...(error ? { error } : {}),
    }));
    if (expanded && body) lines.push(...bodyControls(item.id, archive.canMoveBodyPrevious(item.id), body.nextOffset !== undefined, safeWidth));
    lines.push("");
  }
  if (inbox.length === 0) lines.push(truncateToWidth("Inbox is empty.", safeWidth, ""));
  if (archive.hasActivePage("inbox")) lines.push(...pageControls("inbox", !!archive.pageCursor("inbox", "previous"), !!archive.pageCursor("inbox", "next"), archive.activeIsInitial("inbox"), safeWidth));

  const historyCount = archive?.summary?.historyCount ?? dismissed.size;
  const expandedHistory = archive?.historyExpanded ?? false;
  lines.push("");
  lines.push(link("history", "toggle", truncateToWidth(`${expandedHistory ? "▾" : "▸"} HISTORY (${historyCount})`, safeWidth, "")));
  if (expandedHistory) {
    if (archive?.pageLoading("history") && !archive.hasActivePage("history")) lines.push(truncateToWidth("Loading history…", safeWidth, ""));
    if (archive.pageError("history")) {
      lines.push(truncateToWidth(archive.pageError("history") ?? "", safeWidth, ""));
      lines.push(link("page-history-first", "history", "[Retry history page]"));
    }
    const history = archive?.activeItems("history") ?? [];
    for (const value of history) {
      const item = previewItem(value);
      const expanded = options.expandedIds?.has(item.id) ?? false;
      const body = archive?.body(item.id);
      const error = archive?.bodyError(item.id);
      lines.push(...renderItem(item, safeWidth, {
        expanded,
        selected: options.selectedId === item.id,
        history: true,
        ...(body ? { body } : {}),
        ...(archive.bodyLoading(item.id) ? { loading: true } : {}),
        ...(error ? { error } : {}),
      }));
      if (expanded && body) lines.push(...bodyControls(item.id, archive.canMoveBodyPrevious(item.id), body.nextOffset !== undefined, safeWidth));
      lines.push("");
    }
    if (archive?.hasActivePage("history") && history.length === 0) lines.push(truncateToWidth("History is empty.", safeWidth, ""));
  }
  return lines;
}

export function renderProjectGlance(snapshot: ProjectGlanceSnapshot | undefined, state: ProjectGlanceConnectionState, width: number): string[] {
  return [...renderProjectGlancePinned(snapshot, state, width), ...renderProjectGlanceFeed(snapshot, width)];
}

export function renderProjectGlanceAtHeight(snapshot: ProjectGlanceSnapshot | undefined, state: ProjectGlanceConnectionState, width: number, height: number): string[] {
  return renderProjectGlance(snapshot, state, width).slice(0, Math.max(1, height));
}
