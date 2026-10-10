import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "./capsule-segment.js";
import { isLogicalSessionManifest, type LogicalSessionManifest, type LogicalCatalogCut } from "./logical-session-contract.js";
import { resolveLogicalShardRoutes, type LogicalActivationGrant, type LogicalShardRoute } from "./logical-session-routing.js";
import { resolveCatalogHistory, readCatalogHistoryPage, type CatalogHistoryExecutor, type CatalogHistoryScope } from "./catalog-history.js";
import type { CatalogEvent, CatalogView } from "./catalog-contract.js";
import type { IntervalRoutedSegment, IntervalSourceAssociation } from "./interval-source.js";
import type { SessionEntryLike } from "./types.js";

export const INTERVAL_LOGICAL_SOURCE_RULESET = "chrono-logical-original-source-v1" as const;
export interface LogicalIntervalSourceBounds {
  readonly maxRoutes: number; readonly maxEntries: number; readonly maxBytes: number;
  readonly maxRequests: number; readonly maxDepth: number; readonly maxSuffixEntries: number; readonly timeoutMs: number;
}
export const LOGICAL_INTERVAL_SOURCE_BOUNDS: LogicalIntervalSourceBounds = Object.freeze({
  maxRoutes: 64, maxEntries: 8192, maxBytes: 16 * 1024 * 1024, maxRequests: 4096,
  maxDepth: 64, maxSuffixEntries: 128, timeoutMs: 20_000,
});
export interface LogicalIntervalSourceAnchor { readonly sessionId: string; readonly shardId: string; readonly endEntryId: string }
export interface LogicalIntervalSourceManifest {
  readonly ruleset: typeof INTERVAL_LOGICAL_SOURCE_RULESET;
  readonly logicalSessionId: string; readonly branchId: string;
  /** Observed grant identity. Later rollover may advance this without changing an authorized prefix. */
  readonly manifestRevision: number; readonly manifestHash: string;
  readonly source: IntervalSourceAssociation; readonly endEntryId: string;
  readonly origin: { readonly kind: "initial" | "compaction"; readonly source: IntervalSourceAssociation;
    readonly entryId: string | null; readonly receiptId?: string };
  readonly segments: readonly { readonly source: IntervalSourceAssociation; readonly endEntryId: string;
    readonly sourceHash: string; readonly catalogCut?: LogicalCatalogCut }[];
  readonly identity: string;
}
export interface LogicalIntervalSourcePin {
  readonly source: IntervalSourceAssociation;
  readonly branchEntries: readonly SessionEntryLike[];
  readonly endEntryId: string;
  readonly routedSegments: readonly IntervalRoutedSegment[];
  readonly validationManifest: LogicalIntervalSourceManifest;
}
export interface RepinLogicalIntervalSourceInput {
  /** Must come from the existing activation guard, not continuation prose. */
  readonly logicalGrant: LogicalActivationGrant;
  readonly manifest?: LogicalSessionManifest;
  readonly current: { readonly sessionId: string; readonly sourcePath: string; readonly branchEntries: readonly SessionEntryLike[] };
  readonly endEntryId: string;
  /** Explicit old receipt source, still authorized by the current selected route ancestry. */
  readonly anchor?: LogicalIntervalSourceAnchor;
  /** Existing bounded catalog transport. Failures must throw their safe native code. No ingestion is requested. */
  readonly executeCatalog: CatalogHistoryExecutor;
  readonly expected?: LogicalIntervalSourceManifest;
  /** Runtime may enable this only for recapture of a verified committed receipt. */
  readonly allowOriginalSuffix?: true;
  /** Observed, operation-correlated failed summary records AFTER E, never prefix omissions. */
  readonly generatedSuffixEntryIds?: readonly string[];
  readonly bounds?: Partial<LogicalIntervalSourceBounds>;
  readonly signal?: AbortSignal;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Native payloads have already passed the bounded copier. Costs and arguments
 * can contain finite signed or fractional numbers, unlike capsule metadata. */
function nativeSourceDigest(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("payload-invalid");
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    const record = object(item);
    if (!record) fail("payload-invalid");
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = visit(record[key]);
    }
    return result;
  };
  const encoded = JSON.stringify(visit(value));
  if (encoded === undefined) fail("payload-invalid");
  return createHash("sha256").update(encoded).digest("hex");
}
function fail(reason: string): never {
  const code = `context-v4-interval-logical-source-${reason}`;
  throw Object.assign(new Error(code), { code });
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function association(route: LogicalShardRoute): IntervalSourceAssociation {
  return { sessionId: route.piSessionId, logicalSessionId: route.logicalSessionId, shardId: route.shardId, branchId: route.branchId };
}
function generated(entry: SessionEntryLike): boolean {
  const message = object(entry.message), customType = text(entry.customType) ?? text(message?.customType);
  if (entry.type === "compaction" || entry.type === "branch_summary" || customType && /^chrono(?:[-_:]|$)/.test(customType)) return true;
  if (message?.role === "toolResult" && message.toolName === "request_compaction") return true;
  const calls = message?.role === "assistant" && Array.isArray(message.content)
    ? message.content.map(object).filter(block => block?.type === "toolCall") : [];
  return calls.length > 0 && calls.every(call => call?.name === "request_compaction");
}
/** Generated bodies never become originals. Keep their actual identity/type only.
 * An origin marker retains the original commit receipt ID, not its old summary. */
function marker(entry: SessionEntryLike, retainCalls = true): SessionEntryLike {
  const message = object(entry.message);
  const base: SessionEntryLike = { type: entry.type, id: entry.id, parentId: entry.parentId,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}) };
  if (text(entry.customType)) base.customType = entry.customType;
  if (entry.type === "compaction") {
    if (text(entry.firstKeptEntryId)) base.firstKeptEntryId = entry.firstKeptEntryId;
    const receiptId = text(object(object(entry.details)?.contextReceipt)?.receiptId);
    if (receiptId) base.details = { contextReceipt: { receiptId } };
  }
  if (message) {
    base.message = { role: message.role,
      ...(message.customType !== undefined ? { customType: message.customType } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
      ...(retainCalls && message.role === "assistant" && Array.isArray(message.content) ? {
        content: message.content.map(object).filter(block => block?.type === "toolCall")
          .map(block => ({ type: "toolCall", id: block!.id, name: block!.name, arguments: {} })),
      } : {}) };
  }
  return base;
}
function ordinary(entry: SessionEntryLike): boolean {
  return !(entry.type === "message" && object(entry.message)?.role === "system")
    && !generated(entry) && (entry.type === "message" || entry.type === "custom_message");
}
function validateView(view: CatalogView, cut: LogicalCatalogCut): void {
  if (!view || view.storeKey !== cut.catalogStoreKey || view.generation !== cut.catalogGeneration
    || view.sessionKey !== cut.sessionKey || view.branchKey !== cut.branchKey || view.eventCut !== cut.eventCut
    || !Array.isArray(view.segments) || view.segments.length < 1 || view.segments.length > 64) fail("catalog-cut-mismatch");
}

/** Repin exact original ancestry through recorded cuts. Never initializes a store,
 * scans lifetime bodies, substitutes continuation text, or silently shortens input.
 * Callback execution is already bounded by the existing catalog worker. This job
 * checks its elapsed-time budget before and after each awaited callback. */
export async function repinLogicalIntervalSource(input: RepinLogicalIntervalSourceInput): Promise<LogicalIntervalSourcePin> {
  const bounds = { ...LOGICAL_INTERVAL_SOURCE_BOUNDS, ...input.bounds }, grant = input.logicalGrant;
  for (const value of Object.values(bounds)) if (!Number.isSafeInteger(value) || value < 1) fail("bounds-invalid");
  if (input.allowOriginalSuffix !== undefined && input.allowOriginalSuffix !== true) fail("suffix-mode-invalid");
  const generatedIds = input.generatedSuffixEntryIds ?? [];
  if (!Array.isArray(generatedIds) || generatedIds.length > 8
    || generatedIds.some(id => !text(id) || id.length > 512) || new Set(generatedIds).size !== generatedIds.length) fail("generated-suffix-ids-invalid");
  const generatedSuffixIds = new Set(generatedIds), matchedGeneratedIds = new Set<string>();
  if (!grant || grant.composerCanaryInherited !== false || !text(grant.logicalSessionId) || !text(grant.branchId)
    || !Number.isSafeInteger(grant.manifestRevision) || !/^[a-f0-9]{64}$/.test(grant.manifestHash)
    || !Array.isArray(grant.searchRoutes) || !grant.searchRoutes.length || grant.searchRoutes.length > bounds.maxRoutes) fail("grant-invalid");
  if (input.manifest && (!isLogicalSessionManifest(input.manifest) || input.manifest.pendingRollover
    || input.manifest.logicalSessionId !== grant.logicalSessionId || input.manifest.revision !== grant.manifestRevision
    || input.manifest.integrityHash !== grant.manifestHash
    || canonicalJson(resolveLogicalShardRoutes(input.manifest, grant.branchId)) !== canonicalJson(grant.searchRoutes))) fail("manifest-changed");
  const routes = grant.searchRoutes, seenShards = new Set<string>();
  for (const route of routes) {
    if (route.logicalSessionId !== grant.logicalSessionId || route.branchId !== grant.branchId
      || route.manifestRevision !== grant.manifestRevision || !text(route.shardId) || seenShards.has(route.shardId)
      || !text(route.piSessionId) || !text(route.sourcePath) || !isAbsolute(route.sourcePath)
      || route.sourcePath !== resolve(route.sourcePath) || route.sourcePath.length > 4096 || route.sourcePath.includes("\0")) fail("route-invalid");
    seenShards.add(route.shardId);
  }
  const active = routes.at(-1)!;
  if (active.shardId !== grant.activeShardId || active.piSessionId !== input.current.sessionId
    || active.sourcePath !== input.current.sourcePath) fail("active-source-mismatch");
  const targetIndex = input.anchor ? routes.findIndex(route => route.shardId === input.anchor!.shardId) : routes.length - 1;
  if (targetIndex < 0 || input.anchor && routes[targetIndex]!.piSessionId !== input.anchor.sessionId) fail("anchor-outside-ancestry");
  const endEntryId = input.anchor?.endEntryId ?? input.endEntryId;
  if (!text(endEntryId)) fail("end-missing");
  const target = routes[targetIndex]!, source = association(target);
  const deadline = Date.now() + bounds.timeoutMs;
  let requests = 0, entriesUsed = 0, rawBytes = 0, copiedBytes = 0;
  const check = () => { if (input.signal?.aborted) fail("aborted"); if (Date.now() >= deadline) fail("timeout"); };
  const execute: CatalogHistoryExecutor = async request => {
    check(); if (++requests > bounds.maxRequests) fail("request-limit");
    let result: Record<string, unknown>;
    try { result = await input.executeCatalog(request); }
    catch (error) {
      check();
      const native = object(error), code = text(native?.code) ?? text(native?.message);
      if (code && /^catalog-[a-z0-9-]{1,80}$/.test(code)) throw Object.assign(new Error(code), { code });
      fail("reader-unavailable");
    }
    check(); if (!object(result)) fail("reader-response-invalid"); return result;
  };
  const chargeEntry = () => { check(); if (++entriesUsed > bounds.maxEntries) fail("metadata-limit"); };
  // Count before stringifying/cloning any selected native field. No lifetime clone.
  const copy = (value: unknown, depth = 0): unknown => {
    if (depth > bounds.maxDepth) fail("depth-limit");
    const charge = (bytes: number) => { copiedBytes += bytes; if (copiedBytes > bounds.maxBytes) fail("byte-limit"); };
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > bounds.maxBytes - copiedBytes) fail("byte-limit");
      charge(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
      charge(JSON.stringify(value).length); return value;
    }
    if (Array.isArray(value)) { charge(2 + value.length); return value.map(child => copy(child === undefined ? null : child, depth + 1)); }
    const record = object(value); if (!record) fail("payload-invalid");
    charge(2); const result: Record<string, unknown> = Object.create(null);
    for (const key in record) if (Object.hasOwn(record, key) && record[key] !== undefined) {
      copy(key, depth + 1); charge(2); result[key] = copy(record[key], depth + 1);
    }
    return result;
  };
  type Segment = { source: IntervalSourceAssociation; endEntryId: string; branchEntries: SessionEntryLike[]; catalogCut?: LogicalCatalogCut;
    foundCommit: boolean; reachedRoot: boolean };
  const suffixEntry = (entry: SessionEntryLike, prefixIds: ReadonlySet<string>): SessionEntryLike => {
    if (entry.id && generatedSuffixIds.has(entry.id)) {
      const message = object(entry.message), content = message?.content;
      if (matchedGeneratedIds.has(entry.id) || entry.type !== "message" || message?.role !== "assistant"
        || !["aborted", "error", "length"].includes(String(message.stopReason))
        || !Array.isArray(content) || content.length > 4096) fail("generated-suffix-entry-invalid");
      let calls = 0;
      for (const item of content) {
        const block = object(item);
        if (block?.type === "toolCall" && (++calls > 1 || block.name !== "request_compaction"
          || !text(block.id) || !object(block.arguments))) fail("generated-suffix-entry-invalid");
      }
      matchedGeneratedIds.add(entry.id);
      const result = marker(entry);
      result.message = { ...object(result.message), stopReason: message.stopReason };
      return copy(result) as SessionEntryLike;
    }
    if (entry.type === "context_edit") {
      return copy(text(entry.targetId) && prefixIds.has(String(entry.targetId)) ? entry : marker(entry, false)) as SessionEntryLike;
    }
    // Receipt recovery reads suffix identity only. Do not inspect later body arrays.
    if (input.allowOriginalSuffix === true) return copy(marker(entry, false)) as SessionEntryLike;
    if (ordinary(entry)) fail("new-original-after-end");
    return copy(marker(entry)) as SessionEntryLike;
  };
  const nativeSegment = (): Segment => {
    const branch = input.current.branchEntries;
    let end = -1;
    const suffixLimit = input.allowOriginalSuffix === true ? bounds.maxEntries : bounds.maxSuffixEntries;
    for (let index = branch.length - 1, suffix = 0; index >= 0 && suffix <= suffixLimit; index--, suffix++) {
      chargeEntry();
      if (branch[index]!.id === endEntryId) { end = index; break; }
    }
    if (end < 0) fail("native-end-unavailable");
    let start = end, foundCommit = false, reachedRoot = false;
    for (; start >= 0; start--) {
      if (start !== end) chargeEntry();
      const entry = branch[start]!;
      if (!text(entry.id)) fail("entry-invalid");
      if (entry.type === "compaction") { foundCommit = true; break; }
      if (entry.parentId === null) { reachedRoot = true; break; }
      if (start === 0 || entry.parentId !== branch[start - 1]!.id) fail("native-ancestry-incomplete");
    }
    if (!foundCommit && !reachedRoot) fail("origin-unavailable");
    const prefixIds = new Set(branch.slice(start, end + 1).map(entry => String(entry.id)));
    const result: SessionEntryLike[] = [], seen = new Set<string>();
    for (let index = start; index < branch.length; index++) {
      const entry = branch[index]!;
      if (!text(entry.id) || seen.has(entry.id!)) fail("entry-invalid");
      seen.add(entry.id!);
      if (index > start && entry.parentId !== branch[index - 1]!.id) fail("branch-diverged");
      if (index <= end && generatedSuffixIds.has(entry.id!)) fail("generated-suffix-not-after-end");
      result.push(index > end ? suffixEntry(entry, prefixIds)
        : copy(generated(entry) || !ordinary(entry) && entry.type !== "context_edit" ? marker(entry) : entry) as SessionEntryLike);
    }
    return { source, endEntryId, branchEntries: result, foundCommit, reachedRoot };
  };
  const catalogSegment = async (route: LogicalShardRoute, anchor: string): Promise<Segment> => {
    const cut = route.catalog; if (!cut) fail("route-unpinned");
    const catalogDirectory = join(dirname(route.sourcePath), ".chrono-catalog", cut.sessionKey);
    const shardKey = createHash("sha256").update(`pi-jsonl-v1\0${route.sourcePath}`).digest("hex");
    const base = { v: 1 as const, catalogDirectory, sessionKey: cut.sessionKey };
    const pin = await execute({ ...base, op: "pin", generation: cut.catalogGeneration, branchKey: cut.branchKey,
      leaf: { shardKey, eventId: cut.entryId } });
    const view = pin.view as CatalogView; validateView(view, cut);
    const scope: CatalogHistoryScope = { catalogDirectory, sessionKey: cut.sessionKey, shardKey, view };
    const anchorEvent = await resolveCatalogHistory(scope, anchor, execute);
    const cache = new Map<string, CatalogEvent>();
    const window = async (event: CatalogEvent) => {
      const result = await execute({ ...base, op: "page", view, after: Math.max(0, event.seq - 16), limit: 16 });
      if (!Array.isArray(result.events) || result.events.length > 16) fail("catalog-page-invalid");
      cache.clear();
      for (const row of result.events as CatalogEvent[]) {
        if (row.shardKey !== shardKey || !Number.isSafeInteger(row.seq) || row.seq > view.eventCut || !text(row.metadata?.id)) fail("catalog-page-invalid");
        cache.set(String(row.metadata.id), row);
      }
    };
    const metadata = (event: CatalogEvent) => {
      if (event.shardKey !== shardKey || !text(event.metadata?.id) || !text(event.metadata?.type)
        || !Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > view.eventCut
        || !Number.isSafeInteger(event.rawStart) || !Number.isSafeInteger(event.endByte) || event.endByte <= event.rawStart) fail("catalog-event-invalid");
      return event.metadata;
    };
    const walk = async (first: CatalogEvent, stop?: string): Promise<CatalogEvent[]> => {
      const rows: CatalogEvent[] = [], seen = new Set<string>(); let event = first;
      while (true) {
        chargeEntry(); const data = metadata(event), id = String(data.id);
        if (seen.has(id)) fail("parent-cycle"); seen.add(id);
        if (id === stop) break;
        rows.push(event);
        if (!stop && data.type === "compaction") break;
        if (data.parentId === null) { if (stop) fail("anchor-not-parent"); break; }
        if (!text(data.parentId)) fail("parent-unavailable");
        if (!cache.has(String(data.parentId))) await window(event);
        event = cache.get(String(data.parentId)) ?? await resolveCatalogHistory(scope, String(data.parentId), execute);
      }
      return rows.reverse();
    };
    if (metadata(anchorEvent).id !== anchor) fail("catalog-anchor-mismatch");
    const rows = await walk(anchorEvent);
    const read = async (event: CatalogEvent, suffixPrefixIds?: ReadonlySet<string>): Promise<SessionEntryLike> => {
      const data = metadata(event);
      const skeleton: SessionEntryLike = { type: String(data.type), id: String(data.id), parentId: data.parentId as string | null,
        ...(typeof data.timestamp === "string" ? { timestamp: data.timestamp } : {}),
        ...(text(data.customType) ? { customType: data.customType } : {}),
        ...(text(data.role) ? { message: { role: data.role, customType: data.messageCustomType } } : {}) };
      if (suffixPrefixIds) {
        // Only correlated failures and edits need suffix raw bytes. Ordinary later
        // receipt work stays indexed metadata, even when its body is very large.
        if (!generatedSuffixIds.has(String(data.id)) && skeleton.type !== "context_edit") {
          const message = object(skeleton.message);
          if (message) {
            if (text(data.toolName)) message.toolName = data.toolName;
            if (text(data.toolCallId)) message.toolCallId = data.toolCallId;
            if (input.allowOriginalSuffix !== true && message.role === "assistant") {
              if (!Array.isArray(data.blocks) || data.blocks.length > 4096) fail("catalog-event-invalid");
              message.content = data.blocks.map(object).filter(block => block?.type === "toolCall")
                .map(block => ({ type: "toolCall", id: block!.id, name: block!.name, arguments: {} }));
            }
          }
          return suffixEntry(skeleton, suffixPrefixIds);
        }
      } else {
        if (generatedSuffixIds.has(String(data.id))) fail("generated-suffix-not-after-end");
        if (generated(skeleton) && skeleton.type !== "compaction" || !ordinary(skeleton) && !["compaction", "context_edit"].includes(skeleton.type)) {
          return copy(marker(skeleton)) as SessionEntryLike;
        }
      }
      const length = event.endByte - event.rawStart;
      if (rawBytes + length > bounds.maxBytes) fail("byte-limit");
      const chunks: Buffer[] = [];
      for (let offset = event.rawStart; offset < event.endByte;) {
        const page = await readCatalogHistoryPage(scope, event, execute, offset, 32768);
        const bytes = Buffer.from(String(page.data), "base64");
        if (!bytes.length) fail("raw-page-empty");
        rawBytes += bytes.length; chunks.push(bytes); offset += bytes.length;
      }
      let entry: SessionEntryLike;
      try { entry = JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as SessionEntryLike; }
      catch { fail("raw-json-invalid"); }
      if (entry.id !== data.id || entry.type !== data.type || entry.parentId !== data.parentId) fail("raw-record-mismatch");
      return suffixPrefixIds ? suffixEntry(entry, suffixPrefixIds)
        : copy(generated(entry) || !ordinary(entry) && entry.type !== "context_edit" ? marker(entry) : entry) as SessionEntryLike;
    };
    const branchEntries: SessionEntryLike[] = [];
    for (const event of rows) branchEntries.push(await read(event));
    if (anchor !== cut.entryId) {
      const final = await resolveCatalogHistory(scope, cut.entryId, execute);
      if (metadata(final).id !== cut.entryId) fail("catalog-anchor-mismatch");
      const suffix = await walk(final, anchor);
      if (input.allowOriginalSuffix !== true && suffix.length > bounds.maxSuffixEntries) fail("suffix-limit");
      const prefixIds = new Set(rows.map(event => String(event.metadata.id)));
      for (const event of suffix) branchEntries.push(await read(event, prefixIds));
    }
    // A returned parent path is exact and clipped. No sibling or later source can extend it.
    for (let index = 1; index < branchEntries.length; index++) if (branchEntries[index]!.parentId !== branchEntries[index - 1]!.id) fail("branch-diverged");
    return { source: association(route), endEntryId: anchor, branchEntries, catalogCut: cut,
      foundCommit: rows[0]?.metadata.type === "compaction", reachedRoot: rows[0]?.metadata.parentId === null };
  };
  const selected: Segment[] = [];
  const last = targetIndex === routes.length - 1 ? nativeSegment() : await catalogSegment(target, endEntryId);
  selected.unshift(last);
  if (!last.foundCommit) {
    for (let index = targetIndex - 1; index >= 0; index--) {
      const route = routes[index]!; if (!route.catalog) fail("route-unpinned");
      const segment = await catalogSegment(route, route.catalog.entryId);
      selected.unshift(segment); if (segment.foundCommit) break;
    }
  }
  if (matchedGeneratedIds.size !== generatedSuffixIds.size) fail("generated-suffix-entry-missing");
  const first = selected[0]!, originEntry = first.foundCommit ? first.branchEntries[0] : undefined;
  if (!originEntry && (!first.reachedRoot || routes.findIndex(route => route.shardId === first.source.shardId) !== 0)) fail("origin-unavailable");
  const receiptId = text(object(object(originEntry?.details)?.contextReceipt)?.receiptId);
  const origin: LogicalIntervalSourceManifest["origin"] = { kind: originEntry ? "compaction" : "initial", source: first.source,
    entryId: originEntry?.id ?? null, ...(receiptId ? { receiptId } : {}) };
  const segmentBindings = selected.map(segment => {
    const end = segment.branchEntries.findIndex(value => value.id === segment.endEntryId);
    if (end < 0) fail("end-missing");
    const prefixIds = new Set(segment.branchEntries.slice(0, end + 1).map(entry => String(entry.id)));
    return { source: segment.source, endEntryId: segment.endEntryId,
      // Bind edits to the frozen source, not edits to unrelated later work.
      sourceHash: nativeSourceDigest(segment.branchEntries.filter((entry, index) => index <= end
        || entry.type === "context_edit" && text(entry.targetId) && prefixIds.has(String(entry.targetId)))),
      ...(segment.catalogCut ? { catalogCut: segment.catalogCut } : {}) };
  });
  const stable = { ruleset: INTERVAL_LOGICAL_SOURCE_RULESET, logicalSessionId: grant.logicalSessionId, branchId: grant.branchId,
    source, endEntryId, origin, segments: segmentBindings.map(({ catalogCut: _cut, ...binding }) => binding) };
  const validationManifest: LogicalIntervalSourceManifest = { ...stable, segments: segmentBindings,
    manifestRevision: grant.manifestRevision, manifestHash: grant.manifestHash, identity: `chrono-logical-original:${digest(stable)}` };
  if (input.expected) {
    const expected = input.expected;
    const expectedBody = { ruleset: expected.ruleset, logicalSessionId: expected.logicalSessionId, branchId: expected.branchId,
      source: expected.source, endEntryId: expected.endEntryId, origin: expected.origin,
      segments: expected.segments.map(({ catalogCut: _cut, ...binding }) => binding) };
    if (expected.identity !== `chrono-logical-original:${digest(expectedBody)}`) fail("manifest-invalid");
    if (expected.ruleset !== INTERVAL_LOGICAL_SOURCE_RULESET || expected.logicalSessionId !== grant.logicalSessionId
      || expected.branchId !== grant.branchId || expected.manifestRevision > grant.manifestRevision
      || expected.identity !== validationManifest.identity) fail("source-changed");
    for (const binding of expected.segments) if (binding.catalogCut) {
      const actual = segmentBindings.find(value => value.source.shardId === binding.source.shardId)?.catalogCut;
      if (!actual || canonicalJson(actual) !== canonicalJson(binding.catalogCut)) fail("recorded-cut-changed");
    }
  }
  check();
  return freeze({ source, branchEntries: last.branchEntries, endEntryId,
    routedSegments: selected.slice(0, -1).map(segment => ({ ...segment.source, branchEntries: segment.branchEntries, endEntryId: segment.endEntryId })),
    validationManifest });
}
