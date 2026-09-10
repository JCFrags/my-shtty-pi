import { createHash } from "node:crypto";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { estimateTokensFromText } from "./utils.js";
import { resolveCatalogHistory, readCatalogHistoryPage, type CatalogHistoryExecutor, type CatalogHistoryScope } from "./catalog-history.js";
import { CAPSULE_REDUCER_PIPELINE_VERSION, isCapsuleCatalogView, isCapsuleReadiness, type CapsuleCatalogView, type DerivedStoreIdentity } from "./capsule-contract.js";
import { canonicalJson } from "./capsule-segment.js";
import { runCatalogWorker } from "./catalog-worker-client.js";
import { runCapsuleWorker } from "./capsule-worker-client.js";
import { runSearchV3Worker } from "./search-v3-worker-client.js";
import { isSearchV3Handle, type SearchV3Handle, type SearchV3Request } from "./search-v3-contract.js";
import { SearchLifecycleScheduler, type SearchLifecycleTarget, type SearchLifecycleProgress } from "./search-lifecycle.js";

type Target = Extract<SearchV3Request, { op: "ingestPage" }>;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const uuid = (text: string): string => { const h = hash(text); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const prefix = "chrono-v3:";
interface Reference { v: 1; view: CapsuleCatalogView; handle?: SearchV3Handle; cursor?: string; range?: { start: string; end: string; after: number; byte?: number } }
const encode = (value: Reference): string => prefix + deflateRawSync(Buffer.from(JSON.stringify(value))).toString("base64url");
function decode(text: string): Reference {
  if (!text.startsWith(prefix) || text.length > 16_384) return fail("search-v3-reference-invalid");
  let r: Reference; try { r = JSON.parse(inflateRawSync(Buffer.from(text.slice(prefix.length), "base64url"), { maxOutputLength: 16384 }).toString("utf8")); } catch { return fail("search-v3-reference-invalid"); }
  if (r.v !== 1 || !isCapsuleCatalogView(r.view) || (r.handle !== undefined && !isSearchV3Handle(r.handle)) || (r.cursor !== undefined && (typeof r.cursor !== "string" || r.cursor.length > 4096))) return fail("search-v3-reference-invalid");
  if (r.range && (typeof r.range.start !== "string" || r.range.start.length > 1024 || typeof r.range.end !== "string" || r.range.end.length > 1024 || !Number.isSafeInteger(r.range.after) || r.range.after < 0 || (r.range.byte !== undefined && (!Number.isSafeInteger(r.range.byte) || r.range.byte < 0)))) return fail("search-v3-reference-invalid");
  return r;
}
export interface SearchToolResult { content: { type: "text"; text: string }[]; details: Record<string, unknown> }
const result = (value: Record<string, unknown>, tokenBudget?: number): SearchToolResult => {
  const text = JSON.stringify(value);
  if (tokenBudget !== undefined && estimateTokensFromText(text) > tokenBudget) return result({ status: "unavailable", code: "search-v3-output-budget", suggestion: "Use a smaller limit or a larger tokenBudget. The cursor was not advanced." });
  return { content: [{ type: "text", text }], details: value };
};
export const isSearchReference = (value: string): boolean => value.startsWith(prefix);

/** Real lifecycle pipeline. Only contained workers inspect source or SQLite.
 * Identities are deterministic across append/restart; branch views remain pinned.
 * One active target is retained, never lifetime history or a full postings list. */
export class HistorySearchAdapter {
  readonly scheduler: SearchLifecycleScheduler;
  private key?: string;
  private target?: Target;
  private workTarget?: Target;
  private resumeChecked = false;
  private lastReady?: Target;
  private readyValidated = false;
  private enabled = false;
  private sourceTarget?: SearchLifecycleTarget;
  private progress: SearchLifecycleProgress = { catalog: "pending", capsules: "pending", index: "pending" };
  constructor(private readonly options: { schedulerDirectory?: string; slots?: number } = {}) {
    this.scheduler = new SearchLifecycleScheduler((target, signal) => this.step(target, signal));
  }
  schedule(target: SearchLifecycleTarget): void {
    const key = JSON.stringify(target);
    this.enabled = true;
    const prior = this.sourceTarget;
    if (!prior || ["sourcePath", "sessionKey", "shardKey", "catalogDirectory"].some(k => prior[k as keyof SearchLifecycleTarget] !== target[k as keyof SearchLifecycleTarget])) this.lastReady = undefined;
    this.sourceTarget = target;
    if (this.key !== key) { this.key = key; this.target = undefined; this.workTarget = undefined; this.resumeChecked = false; this.readyValidated = false; this.progress = { catalog: "pending", capsules: "pending", index: "pending" }; }
    this.scheduler.schedule(target);
  }
  cancel(): void { this.scheduler.cancel(); this.key = undefined; this.target = undefined; this.workTarget = undefined; this.resumeChecked = false; this.lastReady = undefined; this.readyValidated = false; this.progress = { catalog: "pending", capsules: "pending", index: "pending" }; }
  disable(): void { this.enabled = false; this.cancel(); this.scheduler.disable(); }
  dispose(): void { this.disable(); this.scheduler.dispose(); }
  /** Cached bounded state only: no worker, source I/O, or lifetime counts. */
  status(): Record<string, unknown> {
    const state = this.scheduler.status();
    const requestedCut = this.target?.view.eventCut ?? null;
    const indexedCut = this.readyValidated ? this.lastReady?.view.eventCut ?? null : null;
    return { enabled: this.enabled, ...state, catalog: this.progress.catalog, capsules: this.progress.capsules, index: this.progress.index,
      requestedCut, indexedCut, lag: requestedCut !== null && indexedCut !== null ? Math.max(0, requestedCut - indexedCut) : null,
      servingLastReady: this.readyValidated && !!this.lastReady, requestedViewValidated: !!this.target, lastSafeError: state.errorCode ?? null };
  }
  private within(view: CapsuleCatalogView, current: CapsuleCatalogView): boolean {
    return view.storeKey === current.storeKey && view.generation === current.generation && view.sessionKey === current.sessionKey
      && view.branchKey === current.branchKey && view.eventCut <= current.eventCut
      && view.segments.every(segment => current.segments.some(s => s.segment === segment.segment && segment.cut <= s.cut));
  }
  private makeTarget(t: SearchLifecycleTarget, view: CapsuleCatalogView): Target {
    // Prefix catch-up is a deliberate new derivation configuration. It must not
    // rewind or overwrite an installed whole-view head with the old config.
    const capsuleConfig = hash("chrono-m06-capsule-prefix-v1");
    const identity: DerivedStoreIdentity = { storeKey: uuid(`${view.storeKey}:${view.generation}:${CAPSULE_REDUCER_PIPELINE_VERSION}:${capsuleConfig}`), sessionKey: view.sessionKey, catalogStoreKey: view.storeKey, catalogGeneration: view.generation, derivedSchemaVersion: 2, capsuleSchemaVersion: 1, chunkSchemaVersion: 1, reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: capsuleConfig };
    const searchKey = uuid(`${identity.storeKey}:search-v3-v2`);
    return { v: 1, op: "ingestPage", catalogDirectory: t.catalogDirectory, capsuleDirectory: join(t.catalogDirectory, `capsules-${identity.storeKey}`), searchDirectory: join(t.catalogDirectory, `search-${searchKey}`), identity: { storeKey: searchKey, capsule: identity, schemaVersion: 1, configHash: hash("chrono-m06-search-default-v2") }, view };
  }
  private async step(t: SearchLifecycleTarget, signal: AbortSignal): Promise<SearchLifecycleProgress> {
    const options = { ...this.options, signal };
    const key = JSON.stringify(t);
    const valid = (): void => { if (signal.aborted || key !== this.key) fail("search-v3-worker-aborted"); };
    if (this.progress.catalog !== "ready") {
      const ingested = await runCatalogWorker({ v: 1, op: "ingestStep", sourcePath: t.sourcePath, catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, shardKey: t.shardKey, branchKey: "pi-session", shardOrdinal: 0 }, options);
      valid(); if (!ingested.ok) return fail(ingested.code);
      if (ingested.result.error) return fail("catalog-ingestion-refused");
      if (ingested.result.caughtUp !== true) {
        this.progress = { ...this.progress, catalog: "lagging", waitingForAppend: ingested.result.incompleteTail === true };
        return { ...this.progress };
      }
      const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, branchKey: "pi-session", leaf: { shardKey: t.shardKey, eventId: t.leafId } }, options);
      valid(); if (!pinned.ok) return fail(pinned.code);
      const view = pinned.result.view as CapsuleCatalogView;
      if (!isCapsuleCatalogView(view)) return fail("search-v3-pin-invalid");
      this.target = this.makeTarget(t, view);
      this.workTarget = undefined;
      this.resumeChecked = false;
      // The new pinned branch must prove the last-ready view is its prefix.
      // Until this check finishes, retain but do not serve the previous view.
      this.readyValidated = !!this.lastReady && this.within(this.lastReady.view, view);
      if (!this.readyValidated) this.lastReady = undefined;
      this.progress = this.readyValidated && this.lastReady?.view.eventCut === view.eventCut
        ? { catalog: "ready", capsules: "ready", index: "ready" }
        : { catalog: "ready", capsules: "pending", index: "pending" };
      return { ...this.progress };
    }
    const requested = this.target; if (!requested) return fail("search-v3-target-missing");
    if (!this.resumeChecked) {
      const status = await runSearchV3Worker({ ...requested, op: "status", view: requested.view }, options);
      valid();
      // A status open cannot distinguish an absent route from a generic missing
      // path. The subsequent create operation remains authoritative and will
      // preserve any real storage failure.
      if (!status.ok) {
        if (status.code !== "search-v3-storage-io") return fail(status.code);
        this.resumeChecked = true;
        return { ...this.progress };
      }
      const indexed = status.result.indexedView as { branchKey?: unknown; eventCut?: unknown; hash?: unknown; complete?: unknown } | null;
      if (indexed === null) {
        this.resumeChecked = true;
        return { ...this.progress };
      }
      if (indexed.branchKey !== requested.view.branchKey || !Number.isSafeInteger(indexed.eventCut) || Number(indexed.eventCut) < 1
        || Number(indexed.eventCut) > requested.view.eventCut || typeof indexed.hash !== "string" || !/^[a-f0-9]{64}$/.test(indexed.hash)
        || typeof indexed.complete !== "boolean") return fail("search-v3-resume-invalid");
      const cut = Number(indexed.eventCut);
      const catalogView = { ...requested.view, segments: requested.view.segments.map(segment => ({ ...segment })) };
      const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, view: catalogView, after: cut - 1, limit: 1 }, options);
      valid(); if (!page.ok) return fail(page.code);
      const leaf = (page.result.events as import("./catalog-contract.js").CatalogEvent[])[0];
      if (!leaf || leaf.seq !== cut) return fail("search-v3-resume-invalid");
      const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, branchKey: "pi-session", leaf: { shardKey: leaf.shardKey, ordinal: leaf.ordinal } }, options);
      valid(); if (!pinned.ok) return fail(pinned.code);
      const view = pinned.result.view as CapsuleCatalogView;
      if (!isCapsuleCatalogView(view) || !this.within(view, requested.view) || view.eventCut !== cut
        || hash(canonicalJson(view)) !== indexed.hash) return fail("search-v3-resume-invalid");
      const resumed = this.makeTarget(t, view);
      if (indexed.complete) {
        this.lastReady = resumed;
        this.readyValidated = true;
        this.progress = cut === requested.view.eventCut
          ? { catalog: "ready", capsules: "ready", index: "ready" }
          : { catalog: "ready", capsules: "pending", index: "pending" };
      } else {
        const capsule = await runCapsuleWorker({ v: 1, op: "status", derivedDirectory: resumed.capsuleDirectory, catalogDirectory: resumed.catalogDirectory, identity: resumed.identity.capsule, view }, options);
        valid(); if (!capsule.ok) return fail(capsule.code);
        const readiness = capsule.result.readiness;
        if (!isCapsuleReadiness(readiness) || canonicalJson(readiness.view) !== canonicalJson(view)
          || readiness.capsules.afterEventSeq !== cut || readiness.capsules.afterDescriptor !== 0
          || readiness.chunks.afterEventSeq !== cut || readiness.chunks.afterDescriptor !== 0) return fail("search-v3-resume-invalid");
        this.workTarget = resumed;
        this.progress = { catalog: "ready", capsules: "ready", index: "pending" };
      }
      this.resumeChecked = true;
      return { ...this.progress };
    }
    if (!this.workTarget) {
      const after = this.readyValidated ? this.lastReady?.view.eventCut ?? 0 : 0;
      const catalogView = { ...requested.view, segments: requested.view.segments.map(segment => ({ ...segment })) };
      const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, view: catalogView, after, limit: 16 }, options);
      valid(); if (!page.ok) return fail(page.code);
      const events = page.result.events as import("./catalog-contract.js").CatalogEvent[];
      const leaf = events.at(-1);
      if (!leaf) return fail("search-v3-prefix-page-invalid");
      const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, branchKey: "pi-session", leaf: { shardKey: leaf.shardKey, ordinal: leaf.ordinal } }, options);
      valid(); if (!pinned.ok) return fail(pinned.code);
      const view = pinned.result.view as CapsuleCatalogView;
      if (!isCapsuleCatalogView(view) || !this.within(view, requested.view) || view.eventCut !== leaf.seq
        || this.readyValidated && this.lastReady && !this.within(this.lastReady.view, view)) return fail("search-v3-prefix-pin-invalid");
      this.workTarget = this.makeTarget(t, view);
      this.progress = { catalog: "ready", capsules: "pending", index: "pending" };
      return { ...this.progress };
    }
    const target = this.workTarget;
    if (this.progress.capsules !== "ready") {
      const derived = await runCapsuleWorker({ v: 1, op: "derivePage", derivedDirectory: target.capsuleDirectory, catalogDirectory: target.catalogDirectory, identity: target.identity.capsule, view: target.view }, options);
      valid(); if (!derived.ok) return fail(derived.code);
      this.progress = { ...this.progress, capsules: derived.result.complete === true ? "ready" : "lagging" };
      return { ...this.progress };
    }
    const indexed = await runSearchV3Worker(target, options);
    valid(); if (!indexed.ok) return fail(indexed.code);
    this.progress = { ...this.progress, index: indexed.result.complete === true ? "ready" : "lagging" };
    if (this.progress.index === "ready") {
      this.lastReady = target; this.readyValidated = true;
      if (target.view.eventCut < requested.view.eventCut) {
        this.workTarget = undefined;
        this.progress = { catalog: "ready", capsules: "pending", index: "pending" };
      }
    }
    return { ...this.progress };
  }
  private scoped(reference?: Reference): Target {
    const current = this.readyValidated ? this.lastReady : undefined;
    if (!current) return fail("search-v3-index-not-ready");
    if (!reference) return current;
    const view = reference.view;
    if (!this.within(view, current.view)) return fail("search-v3-reference-scope-mismatch");
    return { ...current, view };
  }
  async search(params: Record<string, unknown>, signal?: AbortSignal): Promise<SearchToolResult> {
    try {
      if (params.unresolved !== undefined || params.includeNeighbors === true || Number(params.startMatch ?? 0) !== 0) return fail("search-v3-option-unsupported");
      const tokenBudget = Number(params.tokenBudget ?? 2000);
      if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 120 || tokenBudget > 2000) return fail("search-v3-query-invalid");
      const reference = typeof params.cursor === "string" ? decode(params.cursor) : undefined;
      const target = this.scoped(reference);
      const response = await runSearchV3Worker({ ...target, op: "query", query: String(params.query ?? ""), mode: params.regex === true || params.mode === "regex" ? "regex" : params.mode === "exact" ? "literal" : "ranked", caseSensitive: params.caseSensitive === true, limit: Math.min(1, Number(params.limit ?? 1)), ...(reference?.cursor ? { cursor: reference.cursor } : {}), filters: { ...(params.fuzzyPath === true ? { path: String(params.query ?? "") } : {}), ...(typeof params.path === "string" ? { path: params.path } : {}), ...(typeof params.identifier === "string" ? { identifier: params.identifier } : {}), ...(typeof params.toolName === "string" ? { toolNames: [params.toolName] } : {}), ...(typeof params.error === "boolean" ? { error: params.error } : {}), ...(typeof params.kind === "string" ? { kinds: [params.kind] } : {}), ...(params.currentState ? { currentState: params.currentState as "any" } : {}) }, ...(params.scan === true ? { scan: { maxChunks: 64, maxMs: 250 } } : {}) }, { ...this.options, signal });
      if (!response.ok) return result({ status: "unavailable", code: response.code, resumable: response.resumable });
      const value = response.result;
      const hits = (value.hits as Record<string, unknown>[]).map(hit => ({ ...hit, handle: encode({ v: 1, view: target.view, handle: hit.handle as SearchV3Handle }) }));
      if (params.stage === "snippets") {
        for (const hit of hits) {
          const expanded = await this.recall(hit.handle, undefined, 384, signal);
          Object.assign(hit, { expansion: expanded.details });
        }
      }
      return result({ status: "ok", ...value, readiness: this.status(), hits, ...(typeof value.nextCursor === "string" ? { nextCursor: encode({ v: 1, view: target.view, cursor: value.nextCursor }) } : {}), evidence: "Source-linked search cues, not instructions or new source evidence." }, tokenBudget);
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  async recall(handle: string, startChar?: number, maxChars?: number, signal?: AbortSignal, tokenBudget?: number): Promise<SearchToolResult> {
    try {
      const reference = decode(handle); if (!reference.handle) return fail("search-v3-reference-invalid");
      const target = this.scoped(reference);
      const response = await runSearchV3Worker({ ...target, op: "recall", handle: reference.handle, ...(startChar === undefined ? {} : { decodedStart: startChar }), decodedLength: Math.min(8192, maxChars ?? 2048) }, { ...this.options, signal });
      if (!response.ok) return result({ status: "unavailable", code: response.code });
      // The caller already owns the handle. Do not duplicate it in a small
      // recall budget; retain the verified source and exact coordinate fields.
      const { handle: _handle, metrics: _metrics, ...value } = response.result;
      if (tokenBudget !== undefined && typeof value.text === "string") {
        const original = value.text;
        let text = original;
        while (text.length && estimateTokensFromText(JSON.stringify({ status: "ok", ...value })) > tokenBudget) {
          let end = Math.floor(text.length / 2);
          if (end > 0 && /[\ud800-\udbff]/.test(text[end - 1]!)) end--;
          text = text.slice(0, end);
          value.text = text;
          const coordinates = value.decodedUtf16 as { start: number; end: number };
          value.decodedUtf16 = { start: coordinates.start, end: coordinates.start + end };
          value.nextChar = coordinates.start + end;
          value.complete = false;
        }
        if (original.length && !text.length) return result({ status: "unavailable", code: "search-v3-output-budget", suggestion: "Increase tokenBudget to include the verified source reference and text." });
      }
      return result({ status: "ok", ...value }, tokenBudget);
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  private catalogScope(signal?: AbortSignal, reference?: Reference): { scope: CatalogHistoryScope; execute: CatalogHistoryExecutor } {
    const target = this.scoped(reference);
    if (!this.sourceTarget) return fail("search-v3-index-not-ready");
    const scope: CatalogHistoryScope = { catalogDirectory: target.catalogDirectory, sessionKey: target.view.sessionKey, shardKey: this.sourceTarget.shardKey, view: { ...target.view, segments: target.view.segments.map(segment => ({ ...segment })) } };
    const execute: CatalogHistoryExecutor = async request => {
      const response = await runCatalogWorker(request, { ...this.options, signal });
      if (!response.ok) return fail(response.code);
      return response.result;
    };
    return { scope, execute };
  }
  async getBlock(entryId: string, blockIndex: number, startChar?: number, maxChars?: number, signal?: AbortSignal): Promise<SearchToolResult> {
    try {
      const target = this.scoped();
      const { scope, execute } = this.catalogScope(signal);
      const event = await resolveCatalogHistory(scope, entryId, execute);
      const response = await runSearchV3Worker({ ...target, op: "sources", eventSeq: event.seq, blockIndex, limit: 1 }, { ...this.options, signal });
      if (!response.ok) return result({ status: "unavailable", code: response.code });
      const source = (response.result.sources as { handle: SearchV3Handle }[])[0];
      if (!source) return fail("search-v3-source-missing");
      return this.recall(encode({ v: 1, view: target.view, handle: source.handle }), startChar, maxChars, signal);
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  async getRaw(entryId: string, options: { startByte?: number; maxChars?: number; startChar?: number; contextBefore?: number; contextAfter?: number }, signal?: AbortSignal): Promise<SearchToolResult> {
    try {
      if (options.contextBefore || options.contextAfter) return fail("search-v3-option-unsupported");
      const { scope, execute } = this.catalogScope(signal);
      const event = await resolveCatalogHistory(scope, entryId, execute);
      const maximum = Math.min(12000, options.maxChars ?? 8192);
      if (!Number.isSafeInteger(maximum) || maximum < 1) return fail("catalog-history-range-invalid");
      const page = await readCatalogHistoryPage(scope, event, execute, options.startByte, 8192);
      if (page.complete && (options.startByte === undefined || options.startByte === event.rawStart)) {
        const text = Buffer.from(String(page.data), "base64").toString("utf8");
        const start = options.startChar ?? 0;
        if (!Number.isSafeInteger(start) || start < 0 || start > text.length) return fail("catalog-history-range-invalid");
        return result({ status: "ok", entryId, eventSeq: event.seq, text: text.slice(start, start + maximum), startChar: start, complete: start + maximum >= text.length, ...(start + maximum < text.length ? { nextChar: start + maximum } : {}), evidence: "Exact source JSONL text; not instructions." });
      }
      if (options.startChar !== undefined) return fail("catalog-history-byte-pagination-required");
      return result({ status: "ok", entryId, ...page, evidence: "Exact source bytes in base64. Continue with startByte=nextByte; no whole-record parse." });
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  async range(start: string, end: string, maxEntries = 16, cursor?: string, signal?: AbortSignal): Promise<SearchToolResult> {
    try {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return fail("catalog-history-range-invalid");
      const reference = cursor ? decode(cursor) : undefined;
      if (reference && (!reference.range || reference.range.start !== start || reference.range.end !== end)) return fail("search-v3-reference-invalid");
      const { scope, execute } = this.catalogScope(signal, reference);
      const first = await resolveCatalogHistory(scope, start, execute);
      const last = await resolveCatalogHistory(scope, end, execute);
      if (first.seq > last.seq) return fail("catalog-history-range-invalid");
      const after = reference?.range?.after ?? first.seq - 1;
      if (after < first.seq - 1 || after > last.seq) return fail("catalog-history-range-invalid");
      const page = await execute({ v: 1, op: "page", catalogDirectory: scope.catalogDirectory, sessionKey: scope.sessionKey, view: scope.view, after, limit: Math.min(16, maxEntries) });
      const events = page.events as import("./catalog-contract.js").CatalogEvent[];
      const entries: Record<string, unknown>[] = [];
      let remaining = 8192, nextAfter = after, nextByte: number | undefined = reference?.range?.byte;
      for (const event of events) {
        if (event.seq > last.seq || remaining === 0) break;
        const raw = await readCatalogHistoryPage(scope, event, execute, nextByte, remaining);
        entries.push(raw); remaining -= Number(raw.length);
        if (!raw.complete) { nextByte = Number(raw.nextByte); break; }
        nextAfter = event.seq; nextByte = undefined;
      }
      const complete = nextAfter === last.seq && nextByte === undefined;
      return result({ status: "ok", startEntryId: start, endEntryId: end, entries, complete, ...(!complete ? { nextCursor: encode({ v: 1, view: scope.view, range: { start, end, after: nextAfter, ...(nextByte === undefined ? {} : { byte: nextByte }) } }) } : {}), evidence: "Chronological exact source bytes in base64, pinned to this branch and cut." });
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  private code(error: unknown): string { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^(search|catalog|capsule)-[a-z0-9-]{1,80}$/.test(code) ? code : "search-v3-unavailable"; }
}
