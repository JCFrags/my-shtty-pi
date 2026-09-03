import {
  PROJECT_GLANCE_SECTION,
  PROJECT_GLANCE_TITLE,
  type ProjectGlanceCurrent,
  type ProjectGlanceFeedItem,
  type ProjectGlanceSnapshot,
} from "../protocol/model.js";
import type { ProjectGlanceConnectionState } from "../protocol/client.js";

function wrapText(text: string, width: number, prefix = ""): string[] {
  const available = Math.max(1, width - prefix.length);
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!word) continue;
    if (word.length > available && current.length === 0) {
      let rest = word;
      while (rest.length > available) {
        lines.push(`${prefix}${rest.slice(0, available)}`);
        rest = rest.slice(available);
      }
      current = rest;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= available) {
      current = candidate;
    } else {
      lines.push(`${prefix}${current}`);
      current = word;
    }
  }
  if (current) lines.push(`${prefix}${current}`);
  return lines.length > 0 ? lines : [prefix.trimEnd()];
}

function renderCurrent(current: ProjectGlanceCurrent, width: number): string[] {
  const rows: string[] = [];
  for (const [label, value] of [
    ["Step", current.step],
    ["Toward", current.toward],
    ["Focus", current.focus],
  ] as const) {
    if (!value) continue;
    rows.push(...wrapText(value, width, `${label}: `));
  }
  return rows;
}

function renderItem(item: ProjectGlanceFeedItem, width: number): string[] {
  const label = `• ${item.type}`;
  return [label, ...wrapText(item.text, width, "  ")];
}

export function renderProjectGlance(
  snapshot: ProjectGlanceSnapshot | undefined,
  state: ProjectGlanceConnectionState,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines = [PROJECT_GLANCE_TITLE, `Connection: ${state}`, ""];
  if (!snapshot) {
    lines.push("Waiting for the local relay.");
    return lines;
  }
  lines.push("CURRENT");
  lines.push(...renderCurrent(snapshot.current, safeWidth));
  lines.push("");
  lines.push(PROJECT_GLANCE_SECTION.toUpperCase());
  for (const item of snapshot.feed) {
    lines.push(...renderItem(item, safeWidth));
    lines.push("");
  }
  if (snapshot.feed.length === 0) lines.push("No progress items.");
  return lines;
}

export function renderProjectGlanceAtHeight(
  snapshot: ProjectGlanceSnapshot | undefined,
  state: ProjectGlanceConnectionState,
  width: number,
  height: number,
): string[] {
  return renderProjectGlance(snapshot, state, width).slice(0, Math.max(1, height));
}
