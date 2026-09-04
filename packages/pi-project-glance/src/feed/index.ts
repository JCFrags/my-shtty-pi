import { createHash } from "node:crypto";
import {
  MAX_FEED_ITEMS,
  MAX_ITEM_ID_BYTES,
  MAX_ITEM_TEXT_BYTES,
  type ProjectGlanceFeedItem,
} from "../protocol/model.js";
import { projectDisplayText } from "../protocol/projection-text.js";

const WORKPLAN_ACTIVITY_VERSION = 1 as const;
const WORKPLAN_ACTIVITY_ID_BYTES = 128;
const WORKPLAN_TITLE_BYTES = 512;
const WORKPLAN_SUMMARY_BYTES = 2 * 1024;
const WORKPLAN_FOCUS_BYTES = 512;
const WORKPLAN_NEXT_ACTION_BYTES = 512;
const WORKPLAN_NEXT_ACTIONS = 8;
const ASSISTANT_STOP_REASONS = new Set(["stop", "toolUse"]);
const EXPLICIT_PROGRESS_MARKER_PREFIXES = [
  "PROJECT GLANCE FEED CHECKPOINT:",
  "PROJECT GLANCE LIVE UPDATE:",
] as const;

export type ProjectGlanceWorkplanActivityType =
  | "checkpoint_recorded"
  | "milestone_completed"
  | "plan_completed";

export interface ProjectGlanceWorkplanActivity {
  version: typeof WORKPLAN_ACTIVITY_VERSION;
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

export interface FeedExtractionOptions {
  sourceId?: unknown;
  createdAt?: unknown;
}

interface TextSignature {
  id: string;
  phase?: "commentary" | "final_answer";
}

interface TextBlock {
  type: "text";
  text: unknown;
  textSignature?: unknown;
}

interface AssistantMessageLike {
  role: "assistant";
  content: unknown;
  stopReason: unknown;
  timestamp?: unknown;
}

interface SessionEntryLike {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function safeIdentifier(value: unknown, maximumBytes = MAX_ITEM_ID_BYTES): string | undefined {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) return undefined;
  if (/\p{Cc}/u.test(value) || /[\\/]/u.test(value)) return undefined;
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : undefined;
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return '"[cycle]"';
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
  } else {
    result = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function deterministicId(value: unknown): string {
  return `feed:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : undefined;
}

function assistantMessage(value: unknown): AssistantMessageLike | undefined {
  const candidate = record(value);
  if (!candidate || candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
  if (!ASSISTANT_STOP_REASONS.has(candidate.stopReason as string)) return undefined;
  return candidate as unknown as AssistantMessageLike;
}

/**
 * Pi stores TextSignatureV1 as a JSON string on a text content block. Its
 * phase is optional; the extractor applies the stricter context rules below
 * instead of treating an unscoped signature as ordinary commentary.
 */
export function parseTextSignature(value: unknown): TextSignature | undefined {
  if (typeof value !== "string" || !value.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const candidate = record(parsed);
  if (!candidate || candidate.v !== 1 || typeof candidate.id !== "string" || !candidate.id || hasUnpairedSurrogate(candidate.id)) {
    return undefined;
  }
  if (Object.keys(candidate).some((key) => !["v", "id", "phase"].includes(key))) return undefined;
  if (candidate.phase !== undefined && candidate.phase !== "commentary" && candidate.phase !== "final_answer") return undefined;
  if (/\p{Cc}/u.test(candidate.id) || Buffer.byteLength(candidate.id, "utf8") > 512) return undefined;
  return {
    id: candidate.id,
    ...(candidate.phase === undefined ? {} : { phase: candidate.phase }),
  };
}

function textBlock(value: unknown): TextBlock | undefined {
  const candidate = record(value);
  return candidate?.type === "text" && Object.hasOwn(candidate, "text")
    ? candidate as unknown as TextBlock
    : undefined;
}

function itemId(sourceId: unknown, message: unknown, blockIndex: number, blockCount: number, signatureId?: string): string {
  const source = safeIdentifier(sourceId);
  if (!source) return deterministicId({ message, blockIndex, signatureId });
  if (blockCount === 1) return source;
  const suffix = `:text-${blockIndex + 1}`;
  if (Buffer.byteLength(`${source}${suffix}`, "utf8") <= MAX_ITEM_ID_BYTES) return `${source}${suffix}`;
  return deterministicId({ source, blockIndex, signatureId });
}

function explicitProgressMarker(value: string): boolean {
  return EXPLICIT_PROGRESS_MARKER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function makeAssistantItem(
  text: unknown,
  sourceId: unknown,
  createdAt: unknown,
  message: unknown,
  blockIndex: number,
  blockCount: number,
  signatureId?: string,
): ProjectGlanceFeedItem | undefined {
  const projectedText = projectDisplayText(text, MAX_ITEM_TEXT_BYTES);
  const at = timestamp(createdAt);
  if (!projectedText || !at) return undefined;
  return {
    id: itemId(sourceId, message, blockIndex, blockCount, signatureId),
    type: "assistant_update",
    text: projectedText,
    createdAt: at,
  };
}

/**
 * Extract only privacy-safe assistant commentary from one finalized Pi
 * AssistantMessage. Thinking and final-answer blocks never enter the feed.
 * For providers without commentary signatures, the narrow fallback is text
 * before the first tool call; unsigned text without a tool call is excluded.
 */
export function extractAssistantFeedItems(
  message: unknown,
  sourceId?: unknown,
  createdAt?: unknown,
): ProjectGlanceFeedItem[] {
  const assistant = assistantMessage(message);
  if (!assistant) return [];
  const content = assistant.content as unknown[];
  const firstToolCall = content.findIndex((value) => record(value)?.type === "toolCall");
  const hasToolCall = firstToolCall >= 0;
  const end = hasToolCall ? firstToolCall : content.length;
  const items: ProjectGlanceFeedItem[] = [];
  const at = timestamp(createdAt) ?? timestamp(assistant.timestamp);
  if (!at) return [];

  for (let index = 0; index < end; index += 1) {
    const block = textBlock(content[index]);
    if (!block || typeof block.text !== "string") continue;
    const projectedText = projectDisplayText(block.text, MAX_ITEM_TEXT_BYTES);
    if (!projectedText) continue;
    const marker = explicitProgressMarker(projectedText);
    let include = false;
    let signatureId: string | undefined;
    if (Object.hasOwn(block, "textSignature")) {
      const signature = parseTextSignature(block.textSignature);
      if (!signature && !marker) continue;
      if (signature?.phase === "final_answer" && !marker) continue;
      include = marker || signature?.phase === "commentary" || hasToolCall;
      signatureId = signature?.id;
    } else {
      include = hasToolCall || marker;
    }
    if (!include) continue;
    const item = makeAssistantItem(block.text, sourceId, at, message, index, end, signatureId);
    if (item) items.push(item);
  }
  return items;
}

/** Extract feed items from one active-branch session message entry. */
export function extractAssistantEntryItems(entry: unknown): ProjectGlanceFeedItem[] {
  const candidate = record(entry) as SessionEntryLike | undefined;
  if (!candidate || candidate.type !== "message") return [];
  const message = record(candidate.message);
  if (!message || message.role !== "assistant") return [];
  return extractAssistantFeedItems(message, candidate.id, candidate.timestamp);
}

function boundedActivityText(value: unknown, maximumBytes: number): string | undefined {
  return projectDisplayText(value, maximumBytes);
}

function activityRecord(value: unknown): ProjectGlanceWorkplanActivity | undefined {
  const candidate = record(value);
  if (!candidate || candidate.version !== WORKPLAN_ACTIVITY_VERSION) return undefined;
  const allowed = new Set([
    "version", "id", "type", "planId", "milestoneId", "title", "summary", "currentFocus", "nextActions", "at",
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return undefined;
  if (candidate.type !== "checkpoint_recorded" && candidate.type !== "milestone_completed" && candidate.type !== "plan_completed") return undefined;
  const id = safeIdentifier(candidate.id, WORKPLAN_ACTIVITY_ID_BYTES);
  const planId = safeIdentifier(candidate.planId, WORKPLAN_ACTIVITY_ID_BYTES);
  const at = timestamp(candidate.at);
  if (!id || !planId || !at) return undefined;
  const milestoneId = candidate.milestoneId === undefined ? undefined : safeIdentifier(candidate.milestoneId, WORKPLAN_ACTIVITY_ID_BYTES);
  if (candidate.milestoneId !== undefined && !milestoneId) return undefined;
  const title = candidate.title === undefined ? undefined : boundedActivityText(candidate.title, WORKPLAN_TITLE_BYTES);
  const summary = candidate.summary === undefined ? undefined : boundedActivityText(candidate.summary, WORKPLAN_SUMMARY_BYTES);
  const currentFocus = candidate.currentFocus === undefined ? undefined : boundedActivityText(candidate.currentFocus, WORKPLAN_FOCUS_BYTES);
  if (candidate.title !== undefined && !title) return undefined;
  if (candidate.summary !== undefined && !summary) return undefined;
  if (candidate.currentFocus !== undefined && !currentFocus) return undefined;
  let nextActions: string[] | undefined;
  if (candidate.nextActions !== undefined) {
    if (!Array.isArray(candidate.nextActions) || candidate.nextActions.length > WORKPLAN_NEXT_ACTIONS) return undefined;
    const parsedActions = candidate.nextActions.map((item) => boundedActivityText(item, WORKPLAN_NEXT_ACTION_BYTES));
    if (parsedActions.some((item) => !item)) return undefined;
    nextActions = parsedActions.filter((item): item is string => item !== undefined);
  }
  return {
    version: WORKPLAN_ACTIVITY_VERSION,
    id,
    type: candidate.type,
    planId,
    ...(milestoneId ? { milestoneId } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(currentFocus ? { currentFocus } : {}),
    ...(nextActions ? { nextActions } : {}),
    at,
  };
}

export function parseWorkplanActivity(value: unknown): ProjectGlanceWorkplanActivity | undefined {
  return activityRecord(value);
}

function workplanItem(activity: ProjectGlanceWorkplanActivity): ProjectGlanceFeedItem | undefined {
  const subject = activity.type === "checkpoint_recorded"
    ? activity.summary
      ? `Checkpoint: ${activity.summary}`
      : undefined
    : activity.type === "milestone_completed"
      ? activity.title
        ? `Milestone completed: ${activity.title}`
        : undefined
      : activity.title
        ? `Plan completed: ${activity.title}`
        : undefined;
  const text = projectDisplayText(subject, MAX_ITEM_TEXT_BYTES);
  if (!text) return undefined;
  return { id: activity.id, type: activity.type === "checkpoint_recorded" ? "checkpoint" : activity.type, text, createdAt: activity.at };
}

/** Extract the persisted Workplan activity projection from a tool-result entry. */
export function extractWorkplanEntryItem(entry: unknown): ProjectGlanceFeedItem | undefined {
  const candidate = record(entry) as SessionEntryLike | undefined;
  if (!candidate || candidate.type !== "message") return undefined;
  const message = record(candidate.message);
  if (!message || message.role !== "toolResult" || message.toolName !== "workplan") return undefined;
  const details = record(message.details);
  const activity = activityRecord(details?.activity);
  return activity ? workplanItem(activity) : undefined;
}

function feedOrder(left: ProjectGlanceFeedItem, right: ProjectGlanceFeedItem): number {
  const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return Number.isFinite(difference) ? difference : left.createdAt.localeCompare(right.createdAt);
}

/**
 * Keep a deterministic, chronological recent feed. The relay performs the
 * correlated wire-envelope fitting after combining this result with current
 * state, so this helper never publishes or mutates provider state.
 */
export function boundRecentFeed(items: readonly ProjectGlanceFeedItem[], maximum = MAX_FEED_ITEMS): ProjectGlanceFeedItem[] {
  const deduplicated = new Map<string, { item: ProjectGlanceFeedItem; order: number }>();
  items.forEach((item, order) => {
    if (!item || !safeIdentifier(item.id) || !projectDisplayText(item.text, MAX_ITEM_TEXT_BYTES) || !timestamp(item.createdAt)) return;
    deduplicated.set(item.id, { item: { ...item }, order });
  });
  return [...deduplicated.values()]
    .sort((left, right) => feedOrder(left.item, right.item) || left.order - right.order || left.item.id.localeCompare(right.item.id))
    .map(({ item }) => item)
    .slice(-Math.max(0, Math.min(MAX_FEED_ITEMS, Math.floor(maximum))));
}

/** Rebuild the feed solely from the supplied active SessionManager branch. */
export function rebuildProgressFeed(branch: readonly unknown[]): ProjectGlanceFeedItem[] {
  const items: ProjectGlanceFeedItem[] = [];
  for (const entry of branch) {
    items.push(...extractAssistantEntryItems(entry));
    const activity = extractWorkplanEntryItem(entry);
    if (activity) items.push(activity);
  }
  return boundRecentFeed(items);
}

export function compareFeedItems(left: readonly ProjectGlanceFeedItem[], right: readonly ProjectGlanceFeedItem[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
