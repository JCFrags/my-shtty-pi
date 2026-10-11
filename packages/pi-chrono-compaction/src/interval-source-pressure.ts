import type { SessionEntryLike } from "./types.js";

/** Reserve 8MiB below the finite 32MiB capture ceiling for batch growth and
 * the generated handoff exchange. A larger batch still refuses at capture.
 * This is not a bound on provider tokens. */
export const INTERVAL_SOURCE_PRESSURE_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 8192, MAX_DEPTH = 64, MAX_BLOCKS = 4096;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
function fail(reason: string): never { throw new Error(`context-v4-interval-source-pressure-${reason}`); }

/** Match the logical-source adapter's generated markers. Never inspect an old
 * compaction packet's body or count it as new original history. */
function selectedEntry(entry: SessionEntryLike): SessionEntryLike {
  const message = object(entry.message), customType = text(entry.customType) ?? text(message?.customType);
  const control = entry.type === "compaction" || entry.type === "branch_summary"
    || !!customType && /^chrono(?:[-_:]|$)/.test(customType)
    || message?.role === "toolResult" && message.toolName === "request_compaction";
  let calls: Record<string, unknown>[] = [];
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    if (message.content.length > MAX_BLOCKS) fail("block-limit");
    calls = message.content.map(object).filter((block): block is Record<string, unknown> => block?.type === "toolCall");
  }
  const generated = control || calls.length > 0 && calls.every(call => call.name === "request_compaction");
  const ordinary = !(entry.type === "message" && message?.role === "system") && !generated
    && (entry.type === "message" || entry.type === "custom_message");
  if (ordinary || entry.type === "context_edit") return entry;
  const marker: SessionEntryLike = { type: entry.type, id: entry.id, parentId: entry.parentId,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}) };
  if (text(entry.customType)) marker.customType = entry.customType;
  if (entry.type === "compaction") {
    if (text(entry.firstKeptEntryId)) marker.firstKeptEntryId = entry.firstKeptEntryId;
    const receiptId = text(object(object(entry.details)?.contextReceipt)?.receiptId);
    if (receiptId) marker.details = { contextReceipt: { receiptId } };
  }
  if (message) {
    marker.message = { role: message.role,
      ...(message.customType !== undefined ? { customType: message.customType } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
      ...(message.role === "assistant" && Array.isArray(message.content) ? {
        content: calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
      } : {}) };
  }
  return marker;
}

/** Count native current-interval fields without cloning entries or serializing
 * the lifetime branch. Stop at the newest compaction, root, or pressure bound.
 * This does not capture source, shorten history, or read routed prior shards. */
export function nativeIntervalSourcePressure(input: {
  readonly leafId: string | null;
  readonly getEntry: (id: string) => SessionEntryLike | undefined;
}): boolean {
  let bytes = 0;
  const charge = (size: number): boolean => (bytes = Math.min(INTERVAL_SOURCE_PRESSURE_BYTES, bytes + size)) >= INTERVAL_SOURCE_PRESSURE_BYTES;
  const countString = (value: string): boolean => {
    // Every UTF-16 code unit contributes at least one JSON byte. Reject growth
    // before scanning a single oversized field, without allocating JSON text.
    if (value.length + 2 >= INTERVAL_SOURCE_PRESSURE_BYTES - bytes) return charge(INTERVAL_SOURCE_PRESSURE_BYTES);
    if (charge(Buffer.byteLength(value) + 2)) return true;
    const escapes = /["\\\u0000-\u001f\ud800-\udfff]/g;
    for (let match; (match = escapes.exec(value));) {
      const code = value.charCodeAt(match.index);
      if (code >= 0xd800) {
        if (code <= 0xdbff && value.charCodeAt(match.index + 1) >= 0xdc00 && value.charCodeAt(match.index + 1) <= 0xdfff) {
          escapes.lastIndex++; continue;
        }
        // JSON escapes a lone surrogate. Buffer.byteLength charged its three
        // replacement-character bytes, so add the remaining three bytes.
        if (charge(3)) return true;
      } else if (charge(code < 0x20 && ![8, 9, 10, 12, 13].includes(code) ? 5 : 1)) return true;
    }
    return false;
  };
  const count = (value: unknown, depth = 0): boolean => {
    if (depth > MAX_DEPTH) fail("depth-limit");
    if (typeof value === "string") return countString(value);
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return charge(JSON.stringify(value).length);
    if (Array.isArray(value)) {
      if (charge(2 + value.length)) return true;
      for (const child of value) if (count(child === undefined ? null : child, depth + 1)) return true;
      return false;
    }
    const record = object(value); if (!record) fail("payload-invalid");
    if (charge(2)) return true;
    for (const key in record) if (Object.hasOwn(record, key) && record[key] !== undefined) {
      if (countString(key) || charge(2) || count(record[key], depth + 1)) return true;
    }
    return false;
  };
  const seen = new Set<string>();
  let id = input.leafId;
  while (id) {
    if (seen.has(id)) fail("parent-cycle");
    if (seen.size >= MAX_ENTRIES) fail("entry-limit");
    seen.add(id);
    const entry = input.getEntry(id);
    if (!entry || entry.id !== id) fail("entry-unavailable");
    if (count(selectedEntry(entry))) return true;
    if (entry.type === "compaction" || entry.parentId === null) return false;
    if (!text(entry.parentId)) fail("parent-unavailable");
    id = String(entry.parentId);
  }
  return false;
}
