import {
  loadChronoCompact,
  type ChronoCompactApi,
} from "./chrono-compact-bridge.js";

export const RECENT_WORK_SCHEMA_VERSION = 2 as const;
export const DEFAULT_RECENT_WORK_ITEMS = 12;
export const DEFAULT_RECENT_WORK_BYTES = 8_192;
export const MAX_RECENT_WORK_ITEMS = 128;
export const MAX_RECENT_WORK_BYTES = 131_072;
export const MAX_RECENT_WORK_SOURCE_ENTRIES = 256;

export type RecentWorkItem =
  | {
      kind: "assistant";
      timestamp?: string;
      text: string;
      status?: "failed";
    }
  | {
      kind: "tool";
      timestamp?: string;
      toolName: string;
      status: "requested" | "succeeded" | "failed";
    }
  | {
      kind: "compaction";
      timestamp?: string;
      status: "completed";
    };

export interface RecentWorkSnapshot {
  schemaVersion: typeof RECENT_WORK_SCHEMA_VERSION;
  taskId: string;
  runId: string;
  source: "live_child_session";
  reducer: "builtin" | "chrono-compact";
  items: RecentWorkItem[];
  replay?: {
    text: string;
    rawTokens: number;
    renderedTokens: number;
    targetTokens: number;
    recovery: "repeat_inspection_with_larger_maxBytes";
  };
  sourceEntryCount: number;
  omittedEntryCount: number;
  omittedItemCount: number;
  truncated: boolean;
}

export function validateRecentWorkSnapshot(
  value: unknown,
  expected: { taskId: string; runId: string },
): value is RecentWorkSnapshot {
  const snapshot = record(value);
  if (
    !snapshot ||
    Object.keys(snapshot).some(
      (key) =>
        ![
          "schemaVersion",
          "taskId",
          "runId",
          "source",
          "reducer",
          "items",
          "replay",
          "sourceEntryCount",
          "omittedEntryCount",
          "omittedItemCount",
          "truncated",
        ].includes(key),
    ) ||
    snapshot.schemaVersion !== RECENT_WORK_SCHEMA_VERSION ||
    snapshot.taskId !== expected.taskId ||
    snapshot.runId !== expected.runId ||
    snapshot.source !== "live_child_session" ||
    !["builtin", "chrono-compact"].includes(String(snapshot.reducer)) ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length > MAX_RECENT_WORK_ITEMS ||
    !Number.isSafeInteger(snapshot.sourceEntryCount) ||
    Number(snapshot.sourceEntryCount) < 0 ||
    !Number.isSafeInteger(snapshot.omittedEntryCount) ||
    Number(snapshot.omittedEntryCount) < 0 ||
    !Number.isSafeInteger(snapshot.omittedItemCount) ||
    Number(snapshot.omittedItemCount) < 0 ||
    typeof snapshot.truncated !== "boolean" ||
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_RECENT_WORK_BYTES
  )
    return false;
  const replay =
    snapshot.replay === undefined ? undefined : record(snapshot.replay);
  if (
    snapshot.replay !== undefined &&
    (!replay ||
      Object.keys(replay).some(
        (key) =>
          ![
            "text",
            "rawTokens",
            "renderedTokens",
            "targetTokens",
            "recovery",
          ].includes(key),
      ) ||
      typeof replay.text !== "string" ||
      Buffer.byteLength(replay.text, "utf8") > MAX_RECENT_WORK_BYTES ||
      ![replay.rawTokens, replay.renderedTokens, replay.targetTokens].every(
        (value) => Number.isSafeInteger(value) && Number(value) >= 0,
      ) ||
      replay.recovery !== "repeat_inspection_with_larger_maxBytes")
  )
    return false;
  return snapshot.items.every((value) => {
    const item = record(value);
    if (!item || typeof item.kind !== "string") return false;
    const timestampValid =
      item.timestamp === undefined ||
      (typeof item.timestamp === "string" &&
        Buffer.byteLength(item.timestamp, "utf8") <= 64);
    if (!timestampValid) return false;
    if (item.kind === "assistant")
      return (
        Object.keys(item).every((key) =>
          ["kind", "timestamp", "text", "status"].includes(key),
        ) &&
        typeof item.text === "string" &&
        Buffer.byteLength(item.text, "utf8") <= 2_048 &&
        (item.status === undefined || item.status === "failed")
      );
    if (item.kind === "tool")
      return (
        Object.keys(item).every((key) =>
          ["kind", "timestamp", "toolName", "status"].includes(key),
        ) &&
        typeof item.toolName === "string" &&
        item.toolName.length > 0 &&
        Buffer.byteLength(item.toolName, "utf8") <= 128 &&
        ["requested", "succeeded", "failed"].includes(item.status as string)
      );
    return (
      item.kind === "compaction" &&
      Object.keys(item).every((key) =>
        ["kind", "timestamp", "status"].includes(key),
      ) &&
      item.status === "completed"
    );
  });
}

interface Candidate {
  item: RecentWorkItem;
  toolCallId?: string;
  entryIndex: number;
  safeSourceText?: string;
}

const HIGH_VALUE =
  /\b(?:blocked|changed|complete(?:d)?|error|fail(?:ed|ure)?|fixed|implemented|next|passed|ready|resolved|tested|verified|warning)\b/iu;
const LOW_VALUE =
  /^(?:i(?:'m| am| will|'ll)|let me|now i(?:'ll| will)|okay|sure|thanks)\b/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value))
    return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return truncateUtf8(normalized, maxBytes);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /\b(api[_. -]?key|cookie|credential|password|private[_. -]?key|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/gu,
      "[redacted]",
    );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  if (maxBytes < Buffer.byteLength(marker, "utf8")) return "";
  const available = maxBytes - Buffer.byteLength(marker, "utf8");
  let end = Math.min(value.length, available);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > available)
    end--;
  return `${value.slice(0, end).trimEnd()}${marker}`;
}

/**
 * Deterministic extractive reduction inspired by ChronoCompact. It keeps the
 * opening sentence plus high-value conclusions and preserves source order.
 */
export function reduceAssistantText(value: string, maxBytes = 768): string {
  const normalized = redactSensitiveText(value)
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes)
    return normalized.replace(/[ \t]+/gu, " ");
  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (sentences.length === 0) return truncateUtf8(normalized, maxBytes);
  const selected = new Set<number>([0]);
  for (let index = 1; index < sentences.length; index++)
    if (
      HIGH_VALUE.test(sentences[index]!) &&
      !LOW_VALUE.test(sentences[index]!)
    )
      selected.add(index);
  selected.add(sentences.length - 1);
  const retained: string[] = [];
  for (const index of [...selected].sort((left, right) => left - right)) {
    const next = [...retained, sentences[index]!].join(" ");
    if (Buffer.byteLength(next, "utf8") > maxBytes) continue;
    retained.push(sentences[index]!);
  }
  return retained.length > 0
    ? retained.join(" ")
    : truncateUtf8(sentences[0]!, maxBytes);
}

function activeBranch(entries: unknown[]): unknown[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const item = record(entry);
    if (item && typeof item.id === "string") byId.set(item.id, item);
  }
  const leaf = record(entries.at(-1));
  if (!leaf || typeof leaf.id !== "string" || byId.size === 0) return entries;
  const reversed: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current: Record<string, unknown> | undefined = leaf;
  while (
    current &&
    typeof current.id === "string" &&
    !visited.has(current.id)
  ) {
    reversed.push(current);
    visited.add(current.id);
    current =
      typeof current.parentId === "string"
        ? byId.get(current.parentId)
        : undefined;
  }
  return reversed.reverse();
}

function assignmentStart(
  entries: unknown[],
  taskId: string,
  runId: string,
  assignmentId: string,
): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = record(entries[index]);
    if (
      entry?.customType !== "pi-herdr-orchestrator-assignment" ||
      entry.type !== "custom"
    )
      continue;
    const data = record(entry.data);
    if (
      data?.taskId === taskId &&
      data.runId === runId &&
      data.assignmentId === assignmentId
    )
      return index;
  }
  throw new Error("RECENT_WORK_SCOPE_UNAVAILABLE");
}

function timestampFields(
  entry: Record<string, unknown>,
): {} | { timestamp: string } {
  return typeof entry.timestamp === "string" &&
    Buffer.byteLength(entry.timestamp, "utf8") <= 64
    ? { timestamp: entry.timestamp }
    : {};
}

function assistantCandidates(
  message: Record<string, unknown>,
  entry: Record<string, unknown>,
  entryIndex: number,
): Candidate[] {
  const content = (
    Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : []
  ).slice(0, 128);
  const candidates: Candidate[] = [];
  let safeText = "";
  for (const value of content) {
    const part = record(value);
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    const separator = safeText ? "\n" : "";
    const remaining = 16_384 - Buffer.byteLength(safeText + separator, "utf8");
    if (remaining <= 0) break;
    safeText += `${separator}${truncateUtf8(part.text, remaining)}`;
  }
  safeText = safeText.trim();
  if (safeText) {
    const safeSourceText = redactSensitiveText(safeText)
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ")
      .replace(/\r\n?/gu, "\n")
      .trim();
    candidates.push({
      item: {
        kind: "assistant",
        ...timestampFields(entry),
        text: reduceAssistantText(safeSourceText),
        ...(message.stopReason === "error" ||
        typeof message.errorMessage === "string"
          ? { status: "failed" as const }
          : {}),
      },
      entryIndex,
      safeSourceText,
    });
  }
  for (const part of content.map(record)) {
    if (!part || part.type !== "toolCall") continue;
    const toolName = boundedText(part.name, 128);
    const toolCallId = boundedText(part.id, 256);
    if (!toolName) continue;
    candidates.push({
      item: {
        kind: "tool",
        ...timestampFields(entry),
        toolName,
        status: "requested",
      },
      ...(toolCallId ? { toolCallId } : {}),
      entryIndex,
    });
  }
  return candidates;
}

function collectCandidates(entries: unknown[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = record(entries[index]);
    if (!entry) continue;
    if (entry.type === "compaction") {
      candidates.push({
        item: {
          kind: "compaction",
          ...timestampFields(entry),
          status: "completed",
        },
        entryIndex: index,
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (!message) continue;
    if (message.role === "assistant") {
      candidates.push(...assistantCandidates(message, entry, index));
      continue;
    }
    if (message.role !== "toolResult") continue;
    const callId = boundedText(message.toolCallId, 256);
    const toolName = boundedText(message.toolName, 128);
    const prior = callId
      ? [...candidates]
          .reverse()
          .find(
            (candidate) =>
              candidate.item.kind === "tool" && candidate.toolCallId === callId,
          )
      : undefined;
    if (prior && prior.item.kind === "tool") {
      prior.item.status = message.isError === true ? "failed" : "succeeded";
      continue;
    }
    if (!toolName) continue;
    candidates.push({
      item: {
        kind: "tool",
        ...timestampFields(entry),
        toolName,
        status: message.isError === true ? "failed" : "succeeded",
      },
      ...(callId ? { toolCallId: callId } : {}),
      entryIndex: index,
    });
  }
  return candidates;
}

export function projectRecentWork(options: {
  entries: unknown[];
  taskId: string;
  runId: string;
  assignmentId: string;
  maxItems?: number;
  maxBytes?: number;
}): RecentWorkSnapshot {
  const maxItems = options.maxItems ?? DEFAULT_RECENT_WORK_ITEMS;
  const maxBytes = options.maxBytes ?? DEFAULT_RECENT_WORK_BYTES;
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > MAX_RECENT_WORK_ITEMS ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1_024 ||
    maxBytes > MAX_RECENT_WORK_BYTES
  )
    throw new Error("INVALID_REQUEST");
  const branch = activeBranch(options.entries);
  const start = assignmentStart(
    branch,
    options.taskId,
    options.runId,
    options.assignmentId,
  );
  const scoped = branch.slice(start + 1);
  const sourceEntryOffset = Math.max(
    0,
    scoped.length - MAX_RECENT_WORK_SOURCE_ENTRIES,
  );
  const sourceWindow = scoped.slice(sourceEntryOffset);
  const candidates = collectCandidates(sourceWindow).map((candidate) => ({
    ...candidate,
    entryIndex: candidate.entryIndex + sourceEntryOffset,
  }));
  const byCount = candidates.slice(-maxItems);
  const base = {
    schemaVersion: RECENT_WORK_SCHEMA_VERSION,
    taskId: options.taskId,
    runId: options.runId,
    source: "live_child_session" as const,
    reducer: "builtin" as const,
    sourceEntryCount: scoped.length,
  };
  const retained: Candidate[] = [];
  for (let index = byCount.length - 1; index >= 0; index--) {
    const next = [byCount[index]!, ...retained];
    const candidate = {
      ...base,
      items: next.map((value) => value.item),
      omittedEntryCount: 0,
      omittedItemCount: candidates.length - next.length,
      truncated: candidates.length > next.length,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes)
      retained.unshift(byCount[index]!);
    else break;
  }
  const firstRetainedEntry = retained[0]?.entryIndex ?? scoped.length;
  const omittedEntryCount = scoped.filter(
    (_entry, index) => index < firstRetainedEntry,
  ).length;
  const omittedItemCount = candidates.length - retained.length;
  return {
    ...base,
    items: retained.map((value) => value.item),
    omittedEntryCount,
    omittedItemCount,
    truncated: omittedEntryCount > 0 || omittedItemCount > 0,
  };
}

function chronoAssistantBlock(
  text: string,
  index: number,
): Record<string, unknown> {
  return {
    id: `recent-work-${index}`,
    entryId: `recent-work-${index}`,
    entryIndex: index,
    kind: "assistant_text",
    label: "ASSISTANT TEXT",
    exactText: text,
    rawTokens: Math.max(1, Math.ceil(text.length / 4)),
    sourceRefs: [{ entryId: `recent-work-${index}` }],
    protectedExact: false,
    reproducible: false,
    unresolved: /\b(?:blocked|unresolved|pending|next)\b/iu.test(text),
    exactIdentifiers: [],
    attributes: { phase: "post_tool_text" },
  };
}

function chronoEntries(
  items: readonly RecentWorkItem[],
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  let parentId: string | null = null;
  const append = (entry: Record<string, unknown>): void => {
    entries.push({ ...entry, parentId });
    parentId = String(entry.id);
  };
  items.forEach((item, index) => {
    if (item.kind === "assistant") {
      append({
        type: "message",
        id: `recent-work-${index}-assistant`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: item.text }],
          ...(item.status === "failed" ? { stopReason: "error" } : {}),
        },
      });
      return;
    }
    if (item.kind === "tool") {
      const callId = `recent-work-call-${index}`;
      append({
        type: "message",
        id: `recent-work-${index}-call`,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: callId,
              name: item.toolName,
              arguments: {},
            },
          ],
        },
      });
      if (item.status !== "requested")
        append({
          type: "message",
          id: `recent-work-${index}-result`,
          message: {
            role: "toolResult",
            toolCallId: callId,
            toolName: item.toolName,
            content: [{ type: "text", text: item.status }],
            isError: item.status === "failed",
          },
        });
      return;
    }
    append({
      type: "message",
      id: `recent-work-${index}-compaction`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Session compaction completed." }],
      },
    });
  });
  return entries;
}

function sanitizeReplay(text: string): string {
  return redactSensitiveText(text)
    .replace(
      /history_(?:get|range)\([^\n)]*\)/gu,
      "repeat orchestrate inspect with a larger maxBytes value",
    )
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ")
    .trim();
}

function fitChronoSnapshot(
  snapshot: RecentWorkSnapshot,
  maxBytes: number,
): RecentWorkSnapshot {
  const fitted: RecentWorkSnapshot = {
    ...snapshot,
    items: [...snapshot.items],
    ...(snapshot.replay ? { replay: { ...snapshot.replay } } : {}),
  };
  while (
    Buffer.byteLength(JSON.stringify(fitted), "utf8") > maxBytes &&
    fitted.items.length > 0
  ) {
    fitted.items.shift();
    fitted.omittedItemCount++;
    fitted.truncated = true;
  }
  while (
    fitted.replay &&
    Buffer.byteLength(JSON.stringify(fitted), "utf8") > maxBytes &&
    fitted.replay.text.length > 0
  ) {
    const overflow =
      Buffer.byteLength(JSON.stringify(fitted), "utf8") - maxBytes;
    fitted.replay.text = truncateUtf8(
      fitted.replay.text,
      Math.max(
        0,
        Buffer.byteLength(fitted.replay.text, "utf8") - overflow - 16,
      ),
    );
    fitted.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(fitted), "utf8") > maxBytes)
    return {
      schemaVersion: RECENT_WORK_SCHEMA_VERSION,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      source: "live_child_session",
      reducer: snapshot.reducer,
      items: [],
      sourceEntryCount: snapshot.sourceEntryCount,
      omittedEntryCount: snapshot.sourceEntryCount,
      omittedItemCount: snapshot.omittedItemCount + snapshot.items.length,
      truncated: true,
    };
  return fitted;
}

/**
 * Use the optional ChronoCompact peer on already-safe recent-work items. Raw
 * user messages, reasoning, tool arguments, and tool-result bodies never enter
 * this boundary. Any load, reduction, planning, or validation failure returns
 * the deterministic built-in projection.
 */
export async function projectRecentWorkWithChrono(options: {
  entries: unknown[];
  taskId: string;
  runId: string;
  assignmentId: string;
  maxItems?: number;
  maxBytes?: number;
  chrono?: ChronoCompactApi;
}): Promise<RecentWorkSnapshot> {
  const fallback = projectRecentWork(options);
  const chrono = options.chrono ?? (await loadChronoCompact());
  if (!chrono) return fallback;
  try {
    const maxTokensPerItem = Math.max(
      48,
      Math.min(
        512,
        Math.floor((options.maxBytes ?? DEFAULT_RECENT_WORK_BYTES) / 32),
      ),
    );
    const items = fallback.items.map((item, index): RecentWorkItem => {
      if (item.kind !== "assistant") return item;
      const reduced = chrono.reduceBlock({
        block: chronoAssistantBlock(item.text, index),
        maxTokens: maxTokensPerItem,
        laterText: "",
      });
      const text = reduceAssistantText(reduced.text, 2_048);
      return { ...item, text };
    });
    let snapshot: RecentWorkSnapshot = {
      ...fallback,
      reducer: "chrono-compact",
      items,
    };
    const maxBytes = options.maxBytes ?? DEFAULT_RECENT_WORK_BYTES;
    if (maxBytes >= 16_384 && items.length >= 4) {
      const targetTokens = Math.max(
        256,
        Math.min(25_000, Math.floor((maxBytes - 2_048) / 4)),
      );
      const compacted = await chrono.compactEntries(chronoEntries(items), {
        config: {
          targetTokens,
          enableSemanticCompression: false,
          includeHeader: false,
        },
        hardOutputTokens: targetTokens,
      });
      if (compacted.validation.ok) {
        snapshot = {
          ...snapshot,
          replay: {
            text: sanitizeReplay(compacted.summary),
            rawTokens: compacted.rawTokens,
            renderedTokens: compacted.renderedTokens,
            targetTokens: compacted.targetTokens,
            recovery: "repeat_inspection_with_larger_maxBytes",
          },
        };
      }
    }
    return fitChronoSnapshot(snapshot, maxBytes);
  } catch {
    return fallback;
  }
}
