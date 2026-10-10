import { createHash } from "node:crypto";
import type { SessionEntryLike } from "./types.js";
import { collectIntervalBoundaryHints, type IntervalBoundaryHint } from "./interval-boundary-hints.js";
export type { IntervalBoundaryHint, IntervalCutHint } from "./interval-boundary-hints.js";

export const INTERVAL_SOURCE_RULESET = "chrono-original-interval-v1" as const;
export interface IntervalSourceAssociation {
  readonly sessionId: string;
  readonly logicalSessionId?: string;
  readonly shardId?: string;
  readonly branchId?: string;
}
export interface IntervalSourceAnchor { readonly entryId: string; readonly source: IntervalSourceAssociation }
/** Index is a gap in snapshot.events, not a lifetime catalog sequence number. */
export interface IntervalSourcePosition {
  readonly index: number;
  readonly left: IntervalSourceAnchor | null;
  readonly right: IntervalSourceAnchor | null;
}
export interface IntervalToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly blockIndex: number;
}
export interface IntervalToolResult { readonly callId: string; readonly toolName?: string; readonly isError?: boolean }
export interface IntervalHistoricalToolCall {
  readonly callId: string;
  readonly blockIndex: number;
  readonly followingUserEntryId: string;
}
export interface IntervalSourceEvent {
  readonly index: number;
  readonly entryId: string;
  /** Effective native entry, before lossy reduction. Helper views replace only their own copy. */
  readonly projectedEntry: SessionEntryLike;
  readonly sourceHash: string;
  readonly projectionHash: string;
  readonly source: IntervalSourceAssociation;
  readonly role: string;
  readonly toolCalls: readonly IntervalToolCall[];
  readonly toolResult?: IntervalToolResult;
  /** Text-only evidence of an earlier call, never a fabricated tool result. */
  readonly historicalToolCalls?: readonly IntervalHistoricalToolCall[];
  readonly issues: readonly string[];
}
export interface IntervalCompleteUnit {
  readonly id: string;
  /** Contiguous event indexes, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly startPosition: IntervalSourcePosition;
  readonly endPosition: IntervalSourcePosition;
  readonly eventIndexes: readonly number[];
  readonly toolCallIds: readonly string[];
  readonly resultEntryIds: readonly string[];
  readonly status: "complete" | "incomplete" | "malformed";
}
export interface IntervalSourcePartition {
  readonly S: IntervalSourcePosition; readonly H: IntervalSourcePosition;
  readonly R: IntervalSourcePosition; readonly E: IntervalSourcePosition;
  readonly A: { readonly start: IntervalSourcePosition; readonly end: IntervalSourcePosition };
  readonly B: { readonly start: IntervalSourcePosition; readonly end: IntervalSourcePosition };
  readonly C: { readonly start: IntervalSourcePosition; readonly end: IntervalSourcePosition };
}
export interface IntervalSourceExclusion {
  readonly entryId: string;
  readonly source: IntervalSourceAssociation;
  readonly reason: string;
  /** Gap before the excluded source, or index of a purpose-filtered event. */
  readonly position: number;
  readonly blockIndex?: number;
  readonly sourceHash?: string;
  readonly projectionHash?: string;
}
export interface IntervalSourceCoverage {
  readonly complete: boolean;
  readonly sourceEntries: number;
  readonly eligibleEntries: number;
  readonly excludedEntries: number;
  readonly unsupportedBlocks: number;
}
export interface IntervalSourceBounds {
  readonly maxEntries: number; readonly maxBytes: number; readonly maxDepth: number;
  readonly maxBlocks: number; readonly maxRoutedSegments: number; readonly maxGeneratedSuffix: number;
}
export const INTERVAL_SOURCE_BOUNDS: IntervalSourceBounds = Object.freeze({
  maxEntries: 8192, maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxBlocks: 4096,
  maxRoutedSegments: 64, maxGeneratedSuffix: 128,
});
export interface IntervalControlIdentities {
  readonly entryIds?: readonly string[];
  readonly toolCallIds?: readonly string[];
  readonly customTypes?: readonly string[];
}
export interface IntervalRoutedSegment extends IntervalSourceAssociation {
  /** Caller supplies only the pinned selected ancestry, clipped at its logical cut. */
  readonly branchEntries: readonly SessionEntryLike[];
  readonly endEntryId?: string;
}
export interface CaptureIntervalSourceInput extends IntervalSourceAssociation {
  readonly branchEntries: readonly SessionEntryLike[];
  readonly endEntryId: string;
  readonly routedSegments?: readonly IntervalRoutedSegment[];
  readonly controlIdentities?: IntervalControlIdentities;
  readonly bounds?: Partial<IntervalSourceBounds>;
}
export interface IntervalSourceSnapshot {
  readonly ruleset: typeof INTERVAL_SOURCE_RULESET;
  readonly identity: string;
  readonly sourceHash: string;
  readonly projectionHash: string;
  readonly source: IntervalSourceAssociation;
  readonly origin: { readonly kind: "initial" | "compaction"; readonly entryId: string | null;
    readonly source: IntervalSourceAssociation; readonly receiptId?: string };
  readonly endEntryId: string;
  readonly frozenE: IntervalSourcePosition;
  readonly S: IntervalSourcePosition; readonly E: IntervalSourcePosition;
  readonly events: readonly IntervalSourceEvent[];
  readonly units: readonly IntervalCompleteUnit[];
  readonly legalCuts: readonly number[];
  readonly hints: readonly IntervalBoundaryHint[];
  readonly exclusions: readonly IntervalSourceExclusion[];
  readonly coverage: IntervalSourceCoverage;
  readonly bounds: IntervalSourceBounds;
  readonly controlIdentities: IntervalControlIdentities;
  readonly partition?: IntervalSourcePartition;
  readonly segments: readonly { readonly source: IntervalSourceAssociation; readonly endEntryId: string }[];
}
export type IntervalSourceViewPurpose = "synopsis" | "event" | "archive" | "exact";
export interface IntervalSourceView {
  readonly purpose: IntervalSourceViewPurpose;
  readonly start: IntervalSourcePosition; readonly end: IntervalSourcePosition;
  readonly events: readonly IntervalSourceEvent[];
  readonly sourceHash: string; readonly projectionHash: string;
  readonly coverage: IntervalSourceCoverage;
  readonly exclusions: readonly IntervalSourceExclusion[];
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
function fail(code: string): never { throw Object.assign(new Error(`interval-source-${code}`), { code: `interval-source-${code}` }); }
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    const object = record(item);
    if (!object) return item;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) if (object[key] !== undefined) result[key] = sort(object[key]);
    return result;
  };
  return JSON.stringify(sort(value));
}
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Bound strings before serialization, and clone only selected interval records. */
function boundedCopy<T>(value: T, bounds: IntervalSourceBounds, used: { bytes: number }, depth = 0): T {
  if (depth > bounds.maxDepth) fail("depth-limit");
  const charge = (bytes: number) => { used.bytes += bytes; if (used.bytes > bounds.maxBytes) fail("byte-limit"); };
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > bounds.maxBytes - used.bytes) fail("byte-limit");
    charge(Buffer.byteLength(JSON.stringify(value))); return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
    charge(JSON.stringify(value).length); return value;
  }
  if (Array.isArray(value)) {
    charge(2 + value.length);
    return value.map(item => boundedCopy(item === undefined ? null : item, bounds, used, depth + 1)) as T;
  }
  const object = record(value);
  if (!object) fail("unsupported-payload");
  charge(2);
  const result: Record<string, unknown> = Object.create(null);
  for (const key in object) {
    if (!Object.hasOwn(object, key) || object[key] === undefined) continue;
    boundedCopy(key, bounds, used, depth + 1); charge(2);
    result[key] = boundedCopy(object[key], bounds, used, depth + 1);
  }
  return result as T;
}
function sourceOf(input: IntervalSourceAssociation): IntervalSourceAssociation {
  if (!text(input.sessionId)) fail("session-missing");
  return { sessionId: input.sessionId, ...(input.logicalSessionId ? { logicalSessionId: input.logicalSessionId } : {}),
    ...(input.shardId ? { shardId: input.shardId } : {}), ...(input.branchId ? { branchId: input.branchId } : {}) };
}
const sourceKey = (source: IntervalSourceAssociation): string => canonical(source);
const callKey = (event: IntervalSourceEvent, id: string): string => `${sourceKey(event.source)}\0${id}`;
const HISTORY_RETRIEVAL = new Set(["history_get", "history_search", "history_recall", "history_range", "history_read", "history_status",
  "context_recall", "memory_get", "memory_search", "memory_list"]);
function entryRole(entry: SessionEntryLike): string {
  return entry.type === "custom_message" ? "custom" : text(record(entry.message)?.role) ?? "";
}
function toolCalls(entry: SessionEntryLike): { calls: IntervalToolCall[]; issues: string[] } {
  const message = record(entry.message), calls: IntervalToolCall[] = [], issues: string[] = [];
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return { calls, issues };
  message.content.forEach((item, blockIndex) => {
    const block = record(item);
    if (block?.type !== "toolCall") return;
    const id = text(block.id), name = text(block.name), args = record(block.arguments);
    if (!id || !name || !args) issues.push("malformed-tool-call");
    calls.push({ id: id ?? "", name: name ?? "", arguments: args ?? {}, blockIndex });
  });
  return { calls, issues };
}
function generated(entry: SessionEntryLike, controls: IntervalControlIdentities): boolean {
  if (entry.id && controls.entryIds?.includes(entry.id)) return true;
  if (entry.type === "compaction" || entry.type === "branch_summary") return true;
  const message = record(entry.message), customType = text(entry.customType) ?? text(message?.customType);
  if (customType && (/^chrono(?:[-_:]|$)/.test(customType) || controls.customTypes?.includes(customType))) return true;
  if (message?.role === "toolResult" && (message.toolName === "request_compaction"
    || typeof message.toolCallId === "string" && controls.toolCallIds?.includes(message.toolCallId))) return true;
  const calls = toolCalls(entry).calls;
  return calls.length > 0 && calls.every(call => call.name === "request_compaction" || controls.toolCallIds?.includes(call.id));
}
function position(events: readonly IntervalSourceEvent[], index: number): IntervalSourcePosition {
  if (!Number.isSafeInteger(index) || index < 0 || index > events.length) fail("position-invalid");
  const anchor = (event: IntervalSourceEvent | undefined): IntervalSourceAnchor | null =>
    event ? { entryId: event.entryId, source: event.source } : null;
  return { index, left: anchor(events[index - 1]), right: anchor(events[index]) };
}
export function intervalSourcePosition(snapshot: IntervalSourceSnapshot, index: number): IntervalSourcePosition {
  return freeze(position(snapshot.events, index));
}
/** A later native user entry closes an earlier interaction on this ancestry.
 * Keep an unmatched historical call as labeled text, not an executable call.
 * Custom messages, elapsed time and a compaction request cannot close it. */
function projectHistoricalToolCalls(events: IntervalSourceEvent[], exclusions: IntervalSourceExclusion[],
  bounds: IntervalSourceBounds, used: { bytes: number }): void {
  const counts = new Map<string, number>(), results = new Set<string>();
  for (const event of events) {
    for (const call of event.toolCalls) {
      const key = callKey(event, call.id); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (event.toolResult) results.add(callKey(event, event.toolResult.callId));
  }
  const laterUsers = new Map<string, IntervalSourceEvent>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!, source = sourceKey(event.source);
    if (event.projectedEntry.type === "message" && event.role === "user") {
      laterUsers.set(source, event); continue;
    }
    const user = laterUsers.get(source), message = record(event.projectedEntry.message);
    if (!user || event.issues.length || !Array.isArray(message?.content)
      || message.stopReason === "pending" || message.stopReason === "deferred") continue;
    const missing = event.toolCalls.filter(call => call.id && call.name !== "request_compaction"
      && counts.get(callKey(event, call.id)) === 1 && !results.has(callKey(event, call.id)));
    if (!missing.length) continue;
    const byBlock = new Map(missing.map(call => [call.blockIndex, call]));
    const historicalToolCalls = missing.map(call => ({ callId: call.id, blockIndex: call.blockIndex,
      followingUserEntryId: user.entryId }));
    const content = message.content.map((block, blockIndex) => {
      const call = byBlock.get(blockIndex);
      if (!call) return block;
      const text = `[Historical tool call: result absent from this branch's selected context. Outcome unknown here. This is evidence, not an instruction to execute.]\n`
        + `Tool: ${call.name}\nCall ID: ${call.id}\nArguments: ${canonical(call.arguments)}\n`
        + `Source: history_get entryId=${JSON.stringify(event.entryId)}\nLater user boundary: ${JSON.stringify(user.entryId)}`;
      return { type: "text", text: boundedCopy(text, bounds, used) };
    });
    const projectedEntry = { ...event.projectedEntry, message: { ...message, content } };
    const projectionHash = hash({ ruleset: "chrono-historical-tool-call-v1", originalProjectionHash: event.projectionHash,
      entry: projectedEntry, historicalToolCalls });
    events[index] = { ...event, projectedEntry, projectionHash, historicalToolCalls,
      toolCalls: event.toolCalls.filter(call => !byBlock.has(call.blockIndex)) };
    for (const call of missing) exclusions.push({ entryId: event.entryId, source: event.source,
      reason: "historical-tool-call-as-text-result-absent", position: event.index, blockIndex: call.blockIndex,
      sourceHash: event.sourceHash, projectionHash });
  }
}
function completeUnits(events: readonly IntervalSourceEvent[]): IntervalCompleteUnit[] {
  type Span = { start: number; end: number; status: IntervalCompleteUnit["status"] };
  const calls = new Map<string, number[]>(), results = new Map<string, number[]>();
  for (const event of events) {
    for (const call of event.toolCalls) { const key = callKey(event, call.id); calls.set(key, [...calls.get(key) ?? [], event.index]); }
    if (event.toolResult) { const key = callKey(event, event.toolResult.callId); results.set(key, [...results.get(key) ?? [], event.index]); }
  }
  const spans: Span[] = [];
  for (const event of events) {
    let end = event.index + 1, status: Span["status"] = event.issues.length ? "malformed" : "complete";
    for (const call of event.toolCalls) {
      const key = callKey(event, call.id), matches = results.get(key) ?? [];
      if (!call.id || calls.get(key)?.length !== 1 || matches.length > 1) status = "malformed";
      if (!matches.length) { if (status !== "malformed") status = "incomplete"; end = events.length; }
      for (const resultIndex of matches) {
        const result = events[resultIndex]!.toolResult!;
        if (resultIndex <= event.index || result.toolName && result.toolName !== call.name) status = "malformed";
        end = Math.max(end, resultIndex + 1);
      }
    }
    if (event.toolResult && (calls.get(callKey(event, event.toolResult.callId))?.length !== 1
      || results.get(callKey(event, event.toolResult.callId))?.length !== 1)) status = "malformed";
    spans.push({ start: event.index, end, status });
  }
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (span.status === "malformed" || last.status === "malformed") last.status = "malformed";
      else if (span.status === "incomplete" || last.status === "incomplete") last.status = "incomplete";
    } else merged.push({ ...span });
  }
  return merged.map(span => {
    const members = events.slice(span.start, span.end), startPosition = position(events, span.start), endPosition = position(events, span.end);
    return { id: `interval-unit:${hash(members.map(event => [event.source, event.entryId, event.projectionHash]))}`,
      ...span, startPosition, endPosition, eventIndexes: members.map(event => event.index),
      toolCallIds: members.flatMap(event => event.toolCalls.map(call => call.id)),
      resultEntryIds: members.filter(event => event.toolResult).map(event => event.entryId) };
  });
}

/** Capture original current-interval work. No earlier body is copied or rendered. */
export function captureIntervalSource(input: CaptureIntervalSourceInput): IntervalSourceSnapshot {
  const bounds = { ...INTERVAL_SOURCE_BOUNDS, ...input.bounds };
  for (const value of Object.values(bounds)) if (!Number.isSafeInteger(value) || value < 1) fail("bounds-invalid");
  if ((input.routedSegments?.length ?? 0) > bounds.maxRoutedSegments) fail("segment-limit");
  const controls = boundedCopy(input.controlIdentities ?? {}, bounds, { bytes: 0 });
  const source = sourceOf(input), live = { ...source, branchEntries: input.branchEntries, endEntryId: input.endEntryId };
  const segments = [...input.routedSegments ?? [], live].map((segment, index) => {
    const endId = segment.endEntryId ?? segment.branchEntries.at(-1)?.id;
    const endIndex = segment.branchEntries.findIndex(entry => entry.id === endId);
    if (!endId || endIndex < 0) fail("end-missing");
    return { source: sourceOf(segment), entries: segment.branchEntries, endId, endIndex,
      projectionEnd: index === (input.routedSegments?.length ?? 0) ? segment.branchEntries.length : endIndex + 1 };
  });
  let originSegment = 0, originIndex = -1;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!;
    for (let index = segment.endIndex; index >= 0; index--) if (segment.entries[index]!.type === "compaction") {
      originSegment = segmentIndex; originIndex = index; break;
    }
  }
  const originEntry = segments[originSegment]!.entries[originIndex];
  const receiptId = text(record(record(originEntry?.details)?.contextReceipt)?.receiptId);
  const origin: IntervalSourceSnapshot["origin"] = { kind: originEntry ? "compaction" : "initial",
    entryId: originEntry?.id ?? null, source: segments[originSegment]!.source, ...(receiptId ? { receiptId } : {}) };
  const events: IntervalSourceEvent[] = [], exclusions: IntervalSourceExclusion[] = [], identities: unknown[] = [];
  const used = { bytes: 0 }; let sourceEntries = 0;
  for (let segmentIndex = originSegment; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!, start = segmentIndex === originSegment ? originIndex + 1 : 0;
    // Freeze the retained-edit boundary at admission. A later generated commit
    // must not change the interpretation of this interval during reload validation.
    let retainedStart = 0;
    for (let index = segment.endIndex; index >= 0; index--) if (segment.entries[index]!.type === "compaction") {
      const kept = segment.entries.findIndex(entry => entry.id === segment.entries[index]!.firstKeptEntryId);
      retainedStart = kept >= 0 && kept < index ? kept : index + 1; break;
    }
    const edits = new Map<string, SessionEntryLike>();
    for (let index = retainedStart; index < segment.projectionEnd; index++) {
      const edit = segment.entries[index]!;
      if (edit.type === "context_edit" && text(edit.targetId)) edits.set(String(edit.targetId), edit);
    }
    const seen = new Set<string>();
    for (let index = start; index <= segment.endIndex; index++) {
      if (++sourceEntries > bounds.maxEntries) fail("entry-limit");
      const entry = segment.entries[index]!, entryId = text(entry.id);
      if (!entryId || seen.has(entryId)) fail("entry-identity-invalid");
      seen.add(entryId);
      if (index > 0 && entry.parentId !== undefined && entry.parentId !== segment.entries[index - 1]!.id) fail("branch-diverged");
      identities.push([segment.source, entryId, entry.parentId ?? null, entry.type]);
      const omit = (reason: string, proof?: { sourceHash: string; projectionHash: string }) =>
        exclusions.push({ entryId, source: segment.source, reason, position: events.length, ...proof });
      if (generated(entry, controls)) { omit("generated-packet-or-control"); continue; }
      const role = entryRole(entry), message = record(entry.message);
      if (!["user", "assistant", "toolResult", "bashExecution", "custom"].includes(role)) { omit("non-history-metadata"); continue; }
      if (message?.excludeFromContext === true) { omit("excluded-from-context"); continue; }
      const copied = boundedCopy(entry, bounds, used), sourceHash = hash(copied), edit = edits.get(entryId);
      if (edit?.replacement === null) {
        identities.push([entryId, sourceHash, edit.id, null]);
        omit("context-edit-omission", { sourceHash, projectionHash: hash({ editId: edit.id, targetId: edit.targetId, replacement: null }) });
        continue;
      }
      let projectedEntry = copied;
      if (edit) {
        const replacement = record(edit.replacement);
        if (!replacement || typeof replacement.content !== "string" && !Array.isArray(replacement.content)) fail("edit-invalid");
        const content = boundedCopy(replacement.content, bounds, used);
        if (role !== "bashExecution") {
          const normalized = (role === "assistant" || role === "toolResult") && typeof content === "string" ? [{ type: "text", text: content }] : content;
          projectedEntry = entry.type === "custom_message" ? { ...copied, content: normalized }
            : { ...copied, message: { ...record(copied.message), content: normalized } };
        }
      }
      const content = record(projectedEntry.message)?.content ?? projectedEntry.content;
      if (Array.isArray(content) && content.length > bounds.maxBlocks) fail("block-limit");
      const projectionHash = hash({ entry: projectedEntry, edit: edit ? { id: edit.id, targetId: edit.targetId } : null });
      const extracted = toolCalls(projectedEntry), result = record(projectedEntry.message);
      const toolResult = role === "toolResult" ? { callId: text(result?.toolCallId) ?? "",
        ...(text(result?.toolName) ? { toolName: String(result!.toolName) } : {}),
        ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}) } : undefined;
      if (toolResult && !toolResult.callId) extracted.issues.push("malformed-tool-result");
      events.push({ index: events.length, entryId, projectedEntry, sourceHash, projectionHash, source: segment.source,
        role, toolCalls: extracted.calls, ...(toolResult ? { toolResult } : {}), issues: extracted.issues });
      identities.push([entryId, sourceHash, projectionHash]);
    }
  }
  projectHistoricalToolCalls(events, exclusions, bounds, used);
  const units = completeUnits(events), S = position(events, 0), E = position(events, events.length);
  const sourceHash = hash({ origin, identities }), projectionHash = hash(events.map(event => [event.source, event.entryId, event.projectionHash]));
  const identity = `chrono-interval:${hash({ ruleset: INTERVAL_SOURCE_RULESET, source, origin, endEntryId: input.endEntryId, sourceHash, projectionHash })}`;
  return freeze({ ruleset: INTERVAL_SOURCE_RULESET, identity, sourceHash, projectionHash, source, origin,
    endEntryId: input.endEntryId, frozenE: E, S, E, events, units,
    legalCuts: [0, ...units.filter(unit => unit.status === "complete").map(unit => unit.end)],
    hints: collectIntervalBoundaryHints(events, units), exclusions,
    coverage: { complete: true, sourceEntries, eligibleEntries: events.length, excludedEntries: exclusions.length, unsupportedBlocks: 0 },
    bounds, controlIdentities: controls, segments: segments.map(segment => ({ source: segment.source, endEntryId: segment.endId })) });
}

/** Routed originals must be independently repinned by the adapter, not recovered from a continuation body. */
export function revalidateIntervalSource(snapshot: IntervalSourceSnapshot, currentBranch: readonly SessionEntryLike[],
  routedSegments?: readonly IntervalRoutedSegment[]): void {
  if (snapshot.segments.length > 1 && !routedSegments) fail("routed-source-required");
  const end = currentBranch.findIndex(entry => entry.id === snapshot.endEntryId);
  if (end < 0) fail("source-removed");
  if (currentBranch.length - end - 1 > snapshot.bounds.maxGeneratedSuffix) fail("generated-suffix-limit");
  for (let index = end + 1; index < currentBranch.length; index++) {
    const entry = currentBranch[index]!;
    if (!text(entry.id) || entry.parentId !== undefined && entry.parentId !== currentBranch[index - 1]!.id) fail("branch-diverged");
    if (entry.type === "context_edit") continue; // Recapture below detects applicable target changes.
    // Persisted prompt/loadout deltas are overhead, not original interaction growth.
    if (entry.type === "message" && record(entry.message)?.role === "system") continue;
    if (!generated(entry, snapshot.controlIdentities) && !["custom", "label", "session_info", "model_change", "thinking_level_change"].includes(entry.type)) {
      fail("new-original-after-end");
    }
  }
  const captured = captureIntervalSource({ ...snapshot.source, branchEntries: currentBranch, endEntryId: snapshot.endEntryId,
    routedSegments, controlIdentities: snapshot.controlIdentities, bounds: snapshot.bounds });
  if (captured.identity !== snapshot.identity) fail("source-diverged");
}
export function partitionIntervalSource(snapshot: IntervalSourceSnapshot, H: number, R: number): IntervalSourcePartition {
  if (H > R || !snapshot.legalCuts.includes(H) || !snapshot.legalCuts.includes(R)
    || snapshot.units.some(unit => unit.status !== "complete")) fail("partition-invalid");
  const h = intervalSourcePosition(snapshot, H), r = intervalSourcePosition(snapshot, R);
  return freeze({ S: snapshot.S, H: h, R: r, E: snapshot.E,
    A: { start: snapshot.S, end: h }, B: { start: h, end: r }, C: { start: r, end: snapshot.E } });
}

function readback(toolName: string | undefined, action: unknown): boolean {
  return ["workplan", "todo", "notes"].includes(toolName ?? "") && ["list", "status", "read", "recover", "search"].includes(String(action));
}
/** Purpose views retain source indexes and never feed a prior rewrite to a helper. */
export function projectIntervalSource(snapshot: IntervalSourceSnapshot, purpose: IntervalSourceViewPurpose,
  start = 0, end = snapshot.events.length): IntervalSourceView {
  if (!["synopsis", "event", "archive", "exact"].includes(purpose) || start > end) fail("view-invalid");
  const startPosition = intervalSourcePosition(snapshot, start), endPosition = intervalSourcePosition(snapshot, end);
  const selected = snapshot.events.slice(start, end), exclusions: IntervalSourceExclusion[] = [];
  const sourceExclusions = snapshot.exclusions.filter(exclusion => exclusion.position >= start && exclusion.position < end);
  let unsupportedBlocks = 0;
  const calls = new Map<string, IntervalToolCall>();
  for (const event of snapshot.events) for (const call of event.toolCalls) calls.set(callKey(event, call.id), call);
  const events = purpose === "exact" ? selected : selected.map(event => {
    const exclude = (reason: string, blockIndex?: number) => exclusions.push({ entryId: event.entryId, source: event.source,
      reason, position: event.index, ...(blockIndex === undefined ? {} : { blockIndex }) });
    const entry = event.projectedEntry, message = record(entry.message), result = event.toolResult;
    const joined = result ? calls.get(callKey(event, result.callId)) : undefined;
    const toolName = result?.toolName ?? joined?.name, details = record(message?.details);
    const action = details?.action ?? joined?.arguments.action;
    let projectedEntry: SessionEntryLike;
    if (result && (HISTORY_RETRIEVAL.has(toolName ?? "") || purpose === "synopsis" && readback(toolName, action))) {
      const native = record(details?.result), owner = record(details?.owner);
      const metadata = { toolName, action, toolCallId: result.callId, isError: result.isError,
        ...(text(owner?.commitId) ? { commitId: owner!.commitId } : {}),
        ...(typeof owner?.revision === "number" ? { providerRevision: owner.revision } : {}),
        ...(text(native?.planId) ? { planId: native!.planId } : {}),
        ...(typeof native?.revision === "number" ? { planRevision: native.revision } : {}),
        ...(text(joined?.arguments.id) ? { recordId: joined!.arguments.id } : {}),
        ...(text(joined?.arguments.milestoneId) ? { milestoneId: joined!.arguments.milestoneId } : {}) };
      const reason = HISTORY_RETRIEVAL.has(toolName ?? "") ? "imported-history-body" : "native-readback-as-identity";
      exclude(reason);
      // Keep an outcome/source observation, not the imported state or transcript body.
      const { details: _details, ...envelope } = message!;
      projectedEntry = { ...entry, message: { ...envelope, content: [{ type: "text", text: `${reason}: ${canonical(metadata)}` }] } };
    } else {
      const content = message?.content ?? entry.content;
      const clean = (items: readonly unknown[]) => items.flatMap((item, blockIndex) => {
        const block = record(item);
        if (block?.type === "thinking" || block?.type === "redactedThinking") { exclude("hidden-reasoning", blockIndex); return []; }
        if (block?.type === "image" || block?.type === "audio" || block?.type === "video") {
          exclude("unsupported-helper-modality", blockIndex); unsupportedBlocks++; return [];
        }
        if (block?.type === "toolCall" && (block.name === "request_compaction" || snapshot.controlIdentities.toolCallIds?.includes(String(block.id)))) {
          exclude("generated-control-block", blockIndex); return [];
        }
        if (!block || !["text", "toolCall"].includes(String(block.type))) {
          exclude("unsupported-helper-block", blockIndex); unsupportedBlocks++; return [];
        }
        return [item];
      });
      const filtered = Array.isArray(content) ? clean(content) : content;
      projectedEntry = entry.type === "custom_message" ? { ...entry, content: filtered }
        : message ? { ...entry, message: { ...message, content: filtered } } : entry;
    }
    const projectionHash = hash({ purpose, nativeProjectionHash: event.projectionHash, entry: projectedEntry });
    return { ...event, projectedEntry, projectionHash };
  });
  return freeze({ purpose, start: startPosition, end: endPosition, events,
    sourceHash: hash({ origin: snapshot.origin, entries: selected.map(event => [event.source, event.entryId, event.sourceHash]), sourceExclusions }),
    projectionHash: hash({ purpose, entries: events.map(event => [event.source, event.entryId, event.projectionHash]),
      exclusions: [...sourceExclusions, ...exclusions] }),
    coverage: { complete: snapshot.coverage.complete && unsupportedBlocks === 0, sourceEntries: selected.length,
      eligibleEntries: selected.length, excludedEntries: 0, unsupportedBlocks },
    exclusions: [...sourceExclusions, ...exclusions] });
}
