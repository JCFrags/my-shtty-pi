import {
  MAX_FEED_ITEMS,
  MAX_ITEM_ID_BYTES,
  MAX_ITEM_TEXT_BYTES,
  type ProjectGlanceFeedItem,
} from "../protocol/model.js";
import { projectDisplayText, projectFeedText } from "../protocol/projection-text.js";

const WORKPLAN_ACTIVITY_VERSION = 1 as const;
const MAX_SCAN_ENTRIES = 500;
const ASSISTANT_STOP_REASONS = new Set(["stop", "toolUse"]);

export type ProjectGlanceWorkplanActivityType =
  | "checkpoint_recorded"
  | "milestone_completed"
  | "plan_completed";

export interface ProjectGlanceWorkplanActivity {
  version: 1;
  id: string;
  type: ProjectGlanceWorkplanActivityType;
  planId: string;
  milestoneId?: string;
  title?: string;
  summary?: string;
  currentFocus?: string;
  nextActions?: string[];
  at: string;
}

interface TextSignature {
  id: string;
  phase?: "commentary" | "final_answer";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeIdentifier(value: unknown, maximum = MAX_ITEM_ID_BYTES): string | undefined {
  if (typeof value !== "string" || !value || /\p{Cc}|[\\/]|[\uD800-\uDFFF]/u.test(value)) return undefined;
  return Buffer.byteLength(value, "utf8") <= maximum ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function parseTextSignature(value: unknown): TextSignature | undefined {
  if (typeof value !== "string" || !value.startsWith("{")) return undefined;
  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || parsed.v !== 1 || !safeIdentifier(parsed.id, 512)) return undefined;
    if (Object.keys(parsed).some((key) => !["v", "id", "phase"].includes(key))) return undefined;
    if (parsed.phase !== undefined && parsed.phase !== "commentary" && parsed.phase !== "final_answer") return undefined;
    return parsed.phase
      ? { id: parsed.id as string, phase: parsed.phase as "commentary" | "final_answer" }
      : { id: parsed.id as string };
  } catch {
    return undefined;
  }
}

function malformedTextSignature(block: Record<string, unknown>): boolean {
  return Object.hasOwn(block, "textSignature") &&
    block.textSignature !== undefined &&
    !parseTextSignature(block.textSignature);
}

/** Extract at most one card from a finalized assistant message. */
export function extractAssistantFeedItems(
  message: unknown,
  sourceId?: unknown,
  createdAt?: unknown,
): ProjectGlanceFeedItem[] {
  const assistant = record(message);
  const id = safeIdentifier(sourceId);
  if (!assistant || !id || assistant.role !== "assistant" || !Array.isArray(assistant.content)) return [];
  if (!ASSISTANT_STOP_REASONS.has(String(assistant.stopReason))) return [];
  const at = timestamp(createdAt) ?? timestamp(assistant.timestamp);
  if (!at) return [];

  const content = assistant.content as unknown[];
  const textBlocks = content
    .map((value, index) => ({ block: record(value), index }))
    .filter(({ block }) => block?.type === "text" && typeof block.text === "string");

  if (textBlocks.some(({ block }) => block && malformedTextSignature(block))) return [];
  const phased = textBlocks
    .map(({ block }) => parseTextSignature(block?.textSignature))
    .filter((signature): signature is TextSignature & { phase: "commentary" | "final_answer" } => Boolean(signature?.phase));

  let selected: typeof textBlocks;
  if (phased.length > 0) {
    selected = textBlocks.filter(({ block }) => parseTextSignature(block?.textSignature)?.phase === "commentary");
  } else {
    const firstTool = content.findIndex((value) => record(value)?.type === "toolCall");
    if (assistant.stopReason !== "toolUse" || firstTool < 0) return [];
    selected = textBlocks.filter(({ block, index }) => index < firstTool && !Object.hasOwn(block!, "textSignature"));
  }

  const paragraphs = selected
    .map(({ block }) => projectFeedText(block?.text, MAX_ITEM_TEXT_BYTES))
    .filter((text): text is string => Boolean(text));
  const text = projectFeedText(paragraphs.join("\n\n"), MAX_ITEM_TEXT_BYTES);
  return text ? [{ id, type: "assistant_update", text, createdAt: at }] : [];
}

export function extractAssistantEntryItems(entry: unknown): ProjectGlanceFeedItem[] {
  const candidate = record(entry);
  return candidate?.type === "message"
    ? extractAssistantFeedItems(candidate.message, candidate.id, candidate.timestamp)
    : [];
}

function parseActivity(value: unknown): ProjectGlanceWorkplanActivity | undefined {
  const candidate = record(value);
  if (!candidate || candidate.version !== WORKPLAN_ACTIVITY_VERSION) return undefined;
  if (!["checkpoint_recorded", "milestone_completed", "plan_completed"].includes(String(candidate.type))) return undefined;
  const allowed = ["version", "id", "type", "planId", "milestoneId", "title", "summary", "currentFocus", "nextActions", "at"];
  if (Object.keys(candidate).some((key) => !allowed.includes(key))) return undefined;
  const id = safeIdentifier(candidate.id, 128);
  const planId = safeIdentifier(candidate.planId, 128);
  const at = timestamp(candidate.at);
  if (!id || !planId || !at) return undefined;
  const result: ProjectGlanceWorkplanActivity = { version: 1, id, planId, at, type: candidate.type as ProjectGlanceWorkplanActivityType };
  for (const [key, maximum] of [["title", 512], ["summary", 2048], ["currentFocus", 512]] as const) {
    if (candidate[key] === undefined) continue;
    const text = projectDisplayText(candidate[key], maximum);
    if (!text) return undefined;
    result[key] = text;
  }
  if (candidate.nextActions !== undefined) {
    if (!Array.isArray(candidate.nextActions) || candidate.nextActions.length > 8) return undefined;
    const actions = candidate.nextActions.map((item) => projectDisplayText(item, 512));
    if (actions.some((item) => !item)) return undefined;
    result.nextActions = actions as string[];
  }
  return result;
}

export function parseWorkplanActivity(value: unknown): ProjectGlanceWorkplanActivity | undefined {
  return parseActivity(value);
}

export function extractWorkplanEntryItem(entry: unknown): ProjectGlanceFeedItem | undefined {
  const candidate = record(entry);
  const message = record(candidate?.message);
  const details = record(message?.details);
  if (candidate?.type !== "message" || message?.role !== "toolResult" || message.toolName !== "workplan") return undefined;
  const activity = parseActivity(details?.activity);
  if (!activity) return undefined;
  const prefix = activity.type === "checkpoint_recorded"
    ? "Checkpoint"
    : activity.type === "milestone_completed" ? "Milestone completed" : "Plan completed";
  const body = activity.type === "checkpoint_recorded"
    ? [activity.summary, activity.currentFocus, ...(activity.nextActions ?? [])].filter(Boolean).join(" — ")
    : activity.title;
  const text = projectDisplayText(body ? `${prefix}: ${body}` : undefined, MAX_ITEM_TEXT_BYTES);
  return text ? { id: activity.id, type: activity.type === "checkpoint_recorded" ? "checkpoint" : activity.type, text, createdAt: activity.at } : undefined;
}

export function boundRecentFeed(items: readonly ProjectGlanceFeedItem[], maximum = MAX_FEED_ITEMS): ProjectGlanceFeedItem[] {
  const result: ProjectGlanceFeedItem[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (!safeIdentifier(item?.id) || ids.has(item.id) || !projectFeedText(item.text, MAX_ITEM_TEXT_BYTES) || !timestamp(item.createdAt)) continue;
    ids.add(item.id);
    const previous = result.at(-1);
    if (previous?.type === item.type && previous.text.replace(/\s+/gu, " ") === item.text.replace(/\s+/gu, " ")) continue;
    result.push({ ...item });
  }
  return result.slice(-Math.max(0, Math.min(MAX_FEED_ITEMS, Math.floor(maximum))));
}

/** Scan only a bounded recent tail, backfilling until the feed is full. */
export function rebuildProgressFeed(branch: readonly unknown[]): ProjectGlanceFeedItem[] {
  const reverse: ProjectGlanceFeedItem[] = [];
  const start = Math.max(0, branch.length - MAX_SCAN_ENTRIES);
  for (let index = branch.length - 1; index >= start; index -= 1) {
    const workplan = extractWorkplanEntryItem(branch[index]);
    if (workplan) reverse.push(workplan);
    else reverse.push(...extractAssistantEntryItems(branch[index]));
  }
  return boundRecentFeed(reverse.reverse());
}

export function compareFeedItems(left: readonly ProjectGlanceFeedItem[], right: readonly ProjectGlanceFeedItem[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
