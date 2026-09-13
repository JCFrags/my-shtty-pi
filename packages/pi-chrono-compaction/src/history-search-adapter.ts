import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { estimateTokensFromText } from "./utils.js";
import { resolveCatalogHistory, resolveCompositionEntry, readCatalogHistoryPage, type CatalogHistoryExecutor, type CatalogHistoryScope } from "./catalog-history.js";
import { CAPSULE_REDUCER_PIPELINE_VERSION, isCapsuleCatalogView, isCapsuleReadiness, isScopedBodySourceRef, isScopedRawSourceRef, sourceRefWithinViewBounds, type ScopedRawSourceRef, type ScopedBodySourceRef, type CapsuleCatalogView, type DerivedStoreIdentity } from "./capsule-contract.js";
import { canonicalJson } from "./capsule-segment.js";
import { runCatalogWorker } from "./catalog-worker-client.js";
import { runCapsuleWorker } from "./capsule-worker-client.js";
import { runSearchV3Worker } from "./search-v3-worker-client.js";
import { isSearchV3Handle, type SearchV3Handle, type SearchV3Request } from "./search-v3-contract.js";
import { EPISODE_STATE_RULESET_VERSION, isEpisodeStateRequest, type EpisodeRollupCompositionItem, type EpisodeRollupHandle, type EpisodeRollupAfter, type EpisodeRollupRecallLevel, type EpisodeStateAfter, type EpisodeStateLevel, type EpisodeStateSelection } from "./episode-state-contract.js";
import { SearchLifecycleScheduler, type SearchLifecycleTarget, type SearchLifecycleProgress } from "./search-lifecycle.js";
import type { LogicalActivationGrant, LogicalShardRoute } from "./logical-session-routing.js";
import type { LogicalCatalogCut } from "./logical-session-contract.js";

type Target = Extract<SearchV3Request, { op: "ingestPage" }>;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const uuid = (text: string): string => { const h = hash(text); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const prefix = "chrono-v3:";
interface Reference { v: 1; view: CapsuleCatalogView; handle?: SearchV3Handle; source?: ScopedBodySourceRef; rawSource?: ScopedRawSourceRef; rollup?: { handle: EpisodeRollupHandle; nodeId?: string; path?: string[]; level: EpisodeRollupRecallLevel; query?: string; after?: EpisodeRollupAfter }; memory?: { ruleset?: string; level: EpisodeStateLevel; query?: string; source?: ScopedBodySourceRef; after: EpisodeStateAfter }; cursor?: string; range?: { start: string; end: string; after: number; byte?: number } }
const encode = (value: Reference): string => prefix + deflateRawSync(Buffer.from(JSON.stringify(value))).toString("base64url");
function decode(text: string): Reference {
  if (!text.startsWith(prefix) || text.length > 16_384) return fail("search-v3-reference-invalid");
  let r: Reference; try { r = JSON.parse(inflateRawSync(Buffer.from(text.slice(prefix.length), "base64url"), { maxOutputLength: 16384 }).toString("utf8")); } catch { return fail("search-v3-reference-invalid"); }
  if (r.v !== 1 || !isCapsuleCatalogView(r.view) || (r.handle !== undefined && !isSearchV3Handle(r.handle)) || (r.cursor !== undefined && (typeof r.cursor !== "string" || r.cursor.length > 4096))) return fail("search-v3-reference-invalid");
  if (r.source !== undefined && (!isScopedBodySourceRef(r.source) || !sourceRefWithinViewBounds(r.source, r.view))) return fail("search-v3-reference-invalid");
  if (r.rawSource !== undefined && (!isScopedRawSourceRef(r.rawSource) || !sourceRefWithinViewBounds(r.rawSource, r.view)
    || r.rawSource.raw.end - r.rawSource.raw.start > 65536)) return fail("search-v3-reference-invalid");
  if (r.memory && (!["episode", "resource", "state"].includes(r.memory.level) || !r.memory.after || !Number.isSafeInteger(r.memory.after.eventSeq)
    || !Number.isSafeInteger(r.memory.after.descriptor) || r.memory.after.eventSeq < 1 || r.memory.after.descriptor < 0
    || (r.memory.query !== undefined && (typeof r.memory.query !== "string" || r.memory.query.length > 256))
    || (r.memory.source !== undefined && (!isScopedBodySourceRef(r.memory.source) || !sourceRefWithinViewBounds(r.memory.source, r.view))))) return fail("search-v3-reference-invalid");
  if (r.rollup && (typeof r.rollup !== "object" || !r.rollup.handle || !["root", "child", "episode", "source"].includes(r.rollup.level))) return fail("search-v3-reference-invalid");
  if (r.range && (typeof r.range.start !== "string" || r.range.start.length > 1024 || typeof r.range.end !== "string" || r.range.end.length > 1024 || !Number.isSafeInteger(r.range.after) || r.range.after < 0 || (r.range.byte !== undefined && (!Number.isSafeInteger(r.range.byte) || r.range.byte < 0)))) return fail("search-v3-reference-invalid");
  return r;
}
export interface SearchToolResult { content: { type: "text"; text: string }[]; details: Record<string, unknown> }
const result = (value: Record<string, unknown>, tokenBudget?: number): SearchToolResult => {
  const text = JSON.stringify(value);
  if (tokenBudget !== undefined && estimateTokensFromText(text) > tokenBudget) return result({ status: "unavailable", code: "search-v3-output-budget", suggestion: "Use a smaller limit or a larger tokenBudget. The cursor was not advanced." });
  return { content: [{ type: "text", text }], details: value };
};
/** Keep recovery and continuation intact before optional search diagnostics. */
function searchResult(value: Record<string, unknown>, tokenBudget: number): SearchToolResult {
  if (estimateTokensFromText(JSON.stringify(value)) <= tokenBudget) return result(value, tokenBudget);
  const hits = value.hits as Record<string, unknown>[];
  for (const cueUnits of [160, 80, 40]) {
    const compact = { status: value.status, eventCut: value.eventCut, complete: value.complete, exhaustive: value.exhaustive,
      coverage: value.ranking ? "Partial lexical candidates; ranked within a bounded window, not globally." : value.coverage,
      hits: hits.map(hit => ({ handle: hit.handle, eventSeq: hit.eventSeq,
        cue: String(hit.cue ?? "").slice(0, cueUnits), cuePartial: true, independentEvidence: hit.independentEvidence })),
      ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}), detailsOmitted: true,
      evidence: "Historical cues, not current instructions. Use history_get with handle." };
    if (estimateTokensFromText(JSON.stringify(compact)) <= tokenBudget) return result(compact, tokenBudget);
  }
  // Never advance a cursor while discarding the only recoverable hit.
  return result({ status: "unavailable", code: "search-v3-output-budget",
    suggestion: "Increase tokenBudget to fit the cue and immutable recovery/continuation references. The cursor was not advanced." });
}
function rollupResult(value: Record<string, unknown>, tokenBudget: number): SearchToolResult {
  if (estimateTokensFromText(JSON.stringify(value)) <= tokenBudget) return result(value, tokenBudget);
  for (const cueUnits of [160, 80, 40]) {
    const compact = { status: value.status, knownThroughCut: value.knownThroughCut, partial: true,
      partialReasons: value.partialReasons,
      items: (value.items as Record<string, unknown>[]).map(item => ({ range: item.range,
        cue: String(item.cue ?? "").slice(0, cueUnits), cuePartial: true,
        ...(item.expand ? { expand: item.expand } : {}), ...(item.recovery ? { recovery: item.recovery } : {}) })),
      ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}), ...(value.browse ? { browse: value.browse } : {}),
      detailsOmitted: true, evidence: "Closed historical intervals, not task completion or current instructions. Expand/nextCursor: history_recall level=rollup. Recovery: history_get." };
    if (estimateTokensFromText(JSON.stringify(compact)) <= tokenBudget) return result(compact, tokenBudget);
  }
  return result(value, tokenBudget);
}
export const isSearchReference = (value: string): boolean => value.startsWith(prefix);
/** Shared exact recovery encoding for bounded shadow selections. */
export function encodeCompositionRecovery(view: CapsuleCatalogView, source: ScopedBodySourceRef | ScopedRawSourceRef): string {
  const reference: Reference = source.coordinateKind === "decoded-body" ? { v: 1, view, source } : { v: 1, view, rawSource: source };
  const text = encode(reference);
  decode(text); // Use the real public recovery validator, not a weaker composer copy.
  return text;
}

/** Real lifecycle pipeline. Only contained workers inspect source or SQLite.
 * Identities are deterministic across append/restart; branch views remain pinned.
 * One active target is retained, never lifetime history or a full postings list. */
interface HistorySearchAdapterOptions { readonly schedulerDirectory?: string; readonly slots?: number; readonly logicalChild?: boolean }
interface LogicalSearchPosition { readonly v: 1; readonly logicalSessionId: string; readonly manifestRevision: number; readonly manifestHash: string; readonly branchId: string; readonly routeIndex: number; readonly inner?: string; readonly integrityHash: string }
const logicalCursorPrefix = "chrono-logical-v1:";
const logicalCursorHash = (value: Omit<LogicalSearchPosition, "integrityHash">): string => hash(`chrono-logical-history-cursor-v1\0${canonicalJson(value)}`);

export class HistorySearchAdapter {
  readonly scheduler: SearchLifecycleScheduler;
  private key?: string;
  private target?: Target;
  private workTarget?: Target;
  private resumeChecked = false;
  private lastReady?: Target;
  private readyValidated = false;
  private enabled = false;
  private memory: Record<string, unknown> = { state: "pending", knownThroughCut: null };
  private memoryTick = 0;
  private memoryResumeChecked = false;
  private rollup: Record<string, unknown> = { state: "pending", knownThroughCut: null };
  private rollupTurn = false;
  private rollupResumeChecked = false;
  private sourceTarget?: SearchLifecycleTarget;
  private progress: SearchLifecycleProgress = { catalog: "pending", capsules: "pending", index: "pending" };
  private logicalGrant?: LogicalActivationGrant;
  private readonly logicalAdapters = new Map<string, HistorySearchAdapter>();
  private expectedLogicalCut?: LogicalCatalogCut;
  constructor(private readonly options: HistorySearchAdapterOptions = {}) {
    this.scheduler = new SearchLifecycleScheduler((target, signal) => this.step(target, signal));
  }
  schedule(target: SearchLifecycleTarget): void {
    const key = JSON.stringify(target);
    this.enabled = true;
    const prior = this.sourceTarget;
    if (!prior || ["sourcePath", "sessionKey", "shardKey", "catalogDirectory"].some(k => prior[k as keyof SearchLifecycleTarget] !== target[k as keyof SearchLifecycleTarget])) this.lastReady = undefined;
    this.sourceTarget = target;
    if (this.key !== key) { this.rollup = { state: "pending", knownThroughCut: null }; this.rollupTurn = false; this.rollupResumeChecked = false; this.memory = { state: "pending", knownThroughCut: null }; this.memoryTick = 0; this.memoryResumeChecked = false; this.key = key; this.target = undefined; this.workTarget = undefined; this.resumeChecked = false; this.readyValidated = false; this.progress = { catalog: "pending", capsules: "pending", index: "pending" }; }
    this.scheduler.schedule(target);
  }
  cancel(): void { this.cancelLogical(); this.rollup = { state: "pending", knownThroughCut: null }; this.rollupTurn = false; this.rollupResumeChecked = false; this.memory = { state: "pending", knownThroughCut: null }; this.memoryTick = 0; this.scheduler.cancel(); this.key = undefined; this.target = undefined; this.workTarget = undefined; this.resumeChecked = false; this.lastReady = undefined; this.readyValidated = false; this.progress = { catalog: "pending", capsules: "pending", index: "pending" }; }
  disable(): void { this.enabled = false; this.cancel(); this.scheduler.disable(); }
  dispose(): void { this.disable(); this.scheduler.dispose(); }
  private cancelLogical(): void {
    this.logicalGrant = undefined;
    for (const adapter of this.logicalAdapters.values()) adapter.dispose();
    this.logicalAdapters.clear();
  }
  /** Re-establish ancestor tools only from an exact active-session grant. Closed shards use their pinned final cuts. */
  scheduleLogical(grant: LogicalActivationGrant): void {
    if (this.options.logicalChild || !this.sourceTarget) return fail("logical-session-activation-invalid");
    const active = grant.searchRoutes.find(route => route.shardId === grant.activeShardId);
    if (!active || active.sourcePath !== this.sourceTarget.sourcePath || grant.composerCanaryInherited !== false) return fail("logical-session-activation-invalid");
    this.cancelLogical();
    this.logicalGrant = grant;
    for (const route of grant.searchRoutes) {
      if (route.shardId === grant.activeShardId) continue;
      if (!route.catalog) return fail("logical-session-route-unpinned");
      const adapter = new HistorySearchAdapter({ ...this.options, logicalChild: true });
      adapter.expectedLogicalCut = route.catalog;
      adapter.schedule(this.targetForRoute(route));
      this.logicalAdapters.set(route.shardId, adapter);
    }
  }
  private targetForRoute(route: LogicalShardRoute): SearchLifecycleTarget {
    const cut = route.catalog ?? fail("logical-session-route-unpinned");
    return { sourcePath: route.sourcePath, sessionKey: cut.sessionKey,
      shardKey: hash(`pi-jsonl-v1\0${route.sourcePath}`), leafId: cut.entryId,
      catalogDirectory: join(dirname(route.sourcePath), ".chrono-catalog", cut.sessionKey) };
  }
  /** Cached bounded state only: no worker, source I/O, or lifetime counts. */
  status(): Record<string, unknown> {
    const state = this.scheduler.status();
    const requestedCut = this.target?.view.eventCut ?? null;
    const indexedCut = this.readyValidated ? this.lastReady?.view.eventCut ?? null : null;
    return { enabled: this.enabled, ...state, catalog: this.progress.catalog, capsules: this.progress.capsules, index: this.progress.index,
      memory: { ...this.memory, requestedCut, coverage: "Known through the materialized branch cut only; later state may exist." },
      rollup: { ...this.rollup, requestedCut, coverage: "Closed historical intervals only, not completed tasks. Later or open history may be absent." },
      requestedCut, indexedCut, lag: requestedCut !== null && indexedCut !== null ? Math.max(0, requestedCut - indexedCut) : null,
      logical: this.logicalGrant ? { logicalSessionId: this.logicalGrant.logicalSessionId, branchId: this.logicalGrant.branchId,
        routes: this.logicalGrant.searchRoutes.length, composerCanaryInherited: false } : null,
      servingLastReady: this.readyValidated && !!this.lastReady, requestedViewValidated: !!this.target, lastSafeError: state.errorCode ?? null };
  }
  /** Pin the already-cataloged compaction cut. A validated catalog target is
   * enough: optional capsule/index catch-up must not block last-good state reads.
   * This path never ingests or changes a stored source binding. */
  async compositionTarget(prefixLeafId: string, signal?: AbortSignal): Promise<Target> {
    if (!this.enabled || !this.sourceTarget || !this.target) return fail("search-v3-index-not-ready");
    const key = this.key, source = this.sourceTarget, current = this.target;
    const response = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: source.catalogDirectory,
      sessionKey: source.sessionKey, branchKey: "pi-session", leaf: { shardKey: source.shardKey, eventId: prefixLeafId } },
      { ...this.options, signal });
    if (signal?.aborted || this.key !== key || !this.enabled) return fail("search-v3-worker-aborted");
    // An event-ID pin uses catalog-parent-missing for a leaf not yet ingested.
    // Normalize only this lookup, not ingestion's missing-parent safeguard.
    if (!response.ok) return fail(response.code === "catalog-parent-missing" ? "catalog-event-missing" : response.code);
    const view = response.result.view as CapsuleCatalogView;
    if (!isCapsuleCatalogView(view)) return fail("search-v3-view-incompatible");
    if (!this.within(view, current.view)) {
      // A validated extension of the maintained view is ordinary catch-up lag.
      // Different ancestry or catalog identity must still refuse stored reads.
      if (this.within(current.view, view)) return fail("search-v3-index-not-ready");
      return fail("search-v3-view-incompatible");
    }
    return structuredClone(this.makeTarget(source, view));
  }
  /** Resolve an explicit historical compaction through current catalog membership
   * and bounded verified source bytes, including entries beyond discovery. */
  async compositionEntry(entryId: string, expected?: import("./types.js").SessionEntryLike, signal?: AbortSignal): Promise<import("./types.js").SessionEntryLike> {
    const key = this.key;
    const { scope, execute } = this.catalogScope(signal);
    const entry = await resolveCompositionEntry(scope, entryId, execute, expected);
    if (signal?.aborted || this.key !== key || !this.enabled) return fail("search-v3-worker-aborted");
    return entry;
  }
  /** Bounded reads from existing state and rollup stores. No ingestion or publication. */
  async compositionSelection(prefixLeafId: string, signal?: AbortSignal): Promise<EpisodeStateSelection> {
    const key = this.key;
    const target = await this.compositionTarget(prefixLeafId, signal);
    const response = await runSearchV3Worker({ ...target, op: "composeStateSelection" }, { ...this.options, signal });
    if (signal?.aborted || this.key !== key || !this.enabled) return fail("search-v3-worker-aborted");
    if (!response.ok) return fail(response.code);
    const selection = response.result as unknown as EpisodeStateSelection;
    if (!isCapsuleCatalogView(selection.sourceView) || canonicalJson(selection.sourceView) !== canonicalJson(target.view)
      || selection.requestedCut !== target.view.eventCut || selection.processedCut > selection.requestedCut
      || selection.processedMemoryCut < selection.processedCut) return fail("search-v3-state-view-incompatible");
    const queryTerms: string[] = [], seenTerms = new Set<string>();
    const queryItems = [...selection.protected, ...selection.current].sort((a, b) => {
      const rank = (kind: string): number => { const value = ["goal", "openwork", "blocker", "restriction"].indexOf(kind); return value < 0 ? 4 : value; };
      return rank(a.kind) - rank(b.kind) || b.effectiveAtCut - a.effectiveAtCut || a.stableKey.localeCompare(b.stableKey);
    });
    for (const item of queryItems) {
      const evidence = item.evidence as { exactText?: unknown } | null;
      const sourceText = `${item.subject} ${typeof evidence?.exactText === "string" ? evidence.exactText : ""}`;
      let taken = 0;
      for (const term of sourceText.match(/[\p{L}\p{N}_./:+-]{2,}/gu) ?? []) {
        const normalized = term.toLowerCase();
        if (seenTerms.has(normalized)) continue;
        if (`${queryTerms.join(" ")} ${term}`.trim().length > 256 || queryTerms.length >= 12) break;
        seenTerms.add(normalized); queryTerms.push(term); taken++;
        if (taken === 2) break;
      }
      if (queryTerms.length >= 12) break;
    }
    if (!queryTerms.length) return selection;
    const status = await runSearchV3Worker({ ...target, op: "rollupStatus" }, { ...this.options, signal });
    if (signal?.aborted || this.key !== key || !this.enabled) return fail("search-v3-worker-aborted");
    if (!status.ok) {
      if (["search-v3-rollup-store-missing", "search-v3-rollup-not-ready", "search-v3-worker-timeout"].includes(status.code)) return selection;
      return fail(status.code);
    }
    const handle = status.result.handle as EpisodeRollupHandle | undefined;
    if (!handle) return selection;
    if (handle.ruleset !== "episode-rollup-exact-v3" || handle.branchKey !== selection.branchKey) return fail("search-v3-rollup-publication-missing");
    if (handle.eventCut > selection.processedCut) return selection; // The optional publication is newer than this historical cut.
    const beforeEventSeq = selection.recent[0]?.eventSeq ?? selection.processedCut + 1;
    const rollupRequest = { ...target, op: "composeRollupSelection" as const, handle,
      query: queryTerms.join(" "), beforeEventSeq, limit: 4 };
    if (!isEpisodeStateRequest(rollupRequest)) return fail("search-v3-reference-invalid");
    const rollup = await runSearchV3Worker(rollupRequest, { ...this.options, signal });
    if (signal?.aborted || this.key !== key || !this.enabled) return fail("search-v3-worker-aborted");
    if (!rollup.ok) {
      if (["search-v3-rollup-not-ready", "search-v3-rollup-publication-missing", "search-v3-output-budget", "search-v3-worker-timeout"].includes(rollup.code)) return selection;
      return fail(rollup.code);
    }
    const pinned = rollup.result.handle as EpisodeRollupHandle;
    const represented = rollup.result.representedRange as { start?: { eventSeq?: unknown }; end?: { eventSeq?: unknown } } | undefined;
    if (canonicalJson(pinned) !== canonicalJson(handle) || !Number.isSafeInteger(represented?.start?.eventSeq)
      || !Number.isSafeInteger(represented?.end?.eventSeq) || Number(represented!.end!.eventSeq) > handle.eventCut) {
      return fail("search-v3-rollup-publication-missing");
    }
    const items = (rollup.result.items as Record<string, unknown>[]).map((item): EpisodeRollupCompositionItem => {
      const reference = item.reference as { nodeId?: unknown; nodeType?: unknown; path?: unknown; range?: unknown };
      if (typeof reference?.nodeId !== "string" || !["episode-fragment", "rollup"].includes(String(reference.nodeType))
        || !Array.isArray(reference.path) || !reference.path.every(value => typeof value === "string")
        || !item.range || !Array.isArray(item.summary)) return fail("search-v3-rollup-node-corrupt");
      const level: EpisodeRollupRecallLevel = reference.nodeType === "episode-fragment" ? "source" : "child";
      return { nodeId: reference.nodeId, nodeType: reference.nodeType as EpisodeRollupCompositionItem["nodeType"],
        path: reference.path as string[], range: item.range as EpisodeRollupCompositionItem["range"],
        summary: item.summary.map(String), recovery: encode({ v: 1, view: target.view,
          rollup: { handle, nodeId: reference.nodeId, path: reference.path as string[], level } }) };
    });
    return { ...selection, rollups: { handle, representedStartSeq: Number(represented!.start!.eventSeq),
      representedEndSeq: Number(represented!.end!.eventSeq), publicationComplete: rollup.result.publicationComplete === true,
      selectionPartial: rollup.result.selectionPartial === true,
      partialReasons: Array.isArray(rollup.result.partialReasons) ? rollup.result.partialReasons.map(String) : [], items } };
  }
  /** One finite repair transition. The caller repeats `step`; this method never loops. */
  async repairRollup(prefixLeafId: string, action: "start" | "step" | "status" | "publish", repairId: string,
    expectedActiveStoreId?: string | null, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const key = this.key, target = await this.compositionTarget(prefixLeafId, signal);
    const request = { ...target, op: "repairRollup" as const, action, repairId,
      ...(action === "step" ? { limit: 1 } : {}), ...(action === "publish" ? { expectedActiveStoreId: expectedActiveStoreId ?? null } : {}) };
    if (!isEpisodeStateRequest(request)) return fail("search-v3-reference-invalid");
    const response = await runSearchV3Worker(request, { ...this.options, signal });
    if (signal?.aborted || this.key !== key || !this.enabled) return fail("search-v3-worker-aborted");
    if (!response.ok) return fail(response.code);
    return response.result;
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
    const searchable = this.readyValidated ? this.lastReady : undefined;
    const searchComplete = this.progress.catalog === "ready" && this.progress.capsules === "ready" && this.progress.index === "ready";
    // One shadow job per eight search steps while catching up. Once search is
    // ready, finish shadow deltas without making queries perform ingestion.
    const memoryPending = !!searchable && this.memory.state !== "error"
      && (this.memory.complete !== true || this.memory.knownThroughCut !== searchable.view.eventCut);
    // The materializer establishes its own body+metadata-covered snapshot.
    // A growing requested view must not starve already closed history.
    const rollupPending = !!searchable && this.rollup.state !== "error" && Number(this.memory.knownThroughCut) > 0
      && (this.rollup.complete !== true || Number(this.rollup.processedCut ?? 0) < Number(this.memory.knownThroughCut));
    if (!this.expectedLogicalCut && searchable && (memoryPending || rollupPending) && (searchComplete || this.memoryTick++ % 8 === 0)) {
      const key = this.key;
      const rollupJob = rollupPending && (!memoryPending || this.rollupTurn);
      this.rollupTurn = !rollupJob;
      const resumeRollup = rollupJob && !this.rollupResumeChecked;
      const resumeMemory = !rollupJob && !this.memoryResumeChecked;
      const response = await runSearchV3Worker({ ...searchable, op: rollupJob ? resumeRollup ? "rollupStatus" : "materializeRollup" : resumeMemory ? "stateStatus" : "materializeState" }, { ...this.options, signal });
      if (signal.aborted || key !== this.key) return fail("search-v3-worker-aborted");
      if (rollupJob) {
        this.rollupResumeChecked = true;
        // As with the search store, only an absent route may proceed to the
        // authoritative create operation. Corrupt/unsafe state remains refused.
        if (resumeRollup && !response.ok && response.code === "search-v3-rollup-store-missing") this.rollup = { state: "pending", knownThroughCut: null };
        else this.rollup = response.ok
          ? { state: response.result.complete === true ? "ready" : "lagging", complete: response.result.complete === true,
            knownThroughCut: response.result.knownThroughCut ?? null, stateGeneration: response.result.stateGeneration ?? null,
            rollupGeneration: response.result.rollupGeneration ?? null, closedIntervalsOnly: true,
            requestedCut: response.result.requestedCut ?? searchable.view.eventCut,
            processedCut: response.result.processedCut ?? response.result.knownThroughCut ?? 0,
            processedMemoryCut: response.result.processedMemoryCut ?? null,
            representedClosedRange: response.result.representedClosedRange ?? null,
            remainingWork: response.result.remainingWork ?? "state-catch-up",
            noEligibleEpisode: response.result.noEligibleEpisode === true }
          : { ...this.rollup, state: "error", lastSafeError: response.code };
      } else {
        this.memoryResumeChecked = true;
        if (resumeMemory && !response.ok && response.code === "search-v3-state-store-missing") this.memory = { state: "pending", knownThroughCut: null };
        else this.memory = response.ok
          ? { state: response.result.complete === true ? "ready" : "lagging", complete: response.result.complete === true,
            knownThroughCut: response.result.knownThroughCut ?? null, partial: response.result.partial === true,
            stateGeneration: response.result.stateGeneration ?? null,
            metadata: response.result.metadata ?? { complete: false, afterEventSeq: 0 } }
          : { ...this.memory, state: "error", lastSafeError: response.code };
      }
    } else if (!searchComplete) await this.searchStep(t, signal);
    const memory = this.memory.state === "error" ? "error" : this.readyValidated && this.lastReady
      && this.memory.complete === true && this.memory.knownThroughCut === this.lastReady.view.eventCut ? "ready" : "pending";
    const rollup = this.rollup.state === "error" || this.memory.state === "error" ? "error"
      : this.rollup.complete === true && Number(this.rollup.processedCut ?? 0) >= Number(this.memory.knownThroughCut ?? 0) ? "ready" : "pending";
    return { ...this.progress, memory, rollup };
  }
  private async searchStep(t: SearchLifecycleTarget, signal: AbortSignal): Promise<SearchLifecycleProgress> {
    const options = { ...this.options, signal };
    const key = JSON.stringify(t);
    const valid = (): void => { if (signal.aborted || key !== this.key) fail("search-v3-worker-aborted"); };
    if (this.progress.catalog !== "ready" && this.expectedLogicalCut) {
      const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory,
        sessionKey: t.sessionKey, branchKey: this.expectedLogicalCut.branchKey,
        leaf: { shardKey: t.shardKey, eventId: this.expectedLogicalCut.entryId } }, options);
      valid(); if (!pinned.ok) return fail("logical-session-route-unavailable");
      const view = pinned.result.view as CapsuleCatalogView;
      if (!isCapsuleCatalogView(view) || view.storeKey !== this.expectedLogicalCut.catalogStoreKey
        || view.generation !== this.expectedLogicalCut.catalogGeneration || view.sessionKey !== this.expectedLogicalCut.sessionKey
        || view.branchKey !== this.expectedLogicalCut.branchKey || view.eventCut !== this.expectedLogicalCut.eventCut) return fail("logical-session-route-scope-mismatch");
      this.target = this.makeTarget(t, view); this.progress = { catalog: "ready", capsules: "pending", index: "pending" };
      return { ...this.progress };
    }
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
        if (this.expectedLogicalCut) return fail("logical-session-route-unavailable");
        if (status.code !== "search-v3-storage-io") return fail(status.code);
        this.resumeChecked = true;
        return { ...this.progress };
      }
      const indexed = status.result.indexedView as { branchKey?: unknown; eventCut?: unknown; hash?: unknown; complete?: unknown } | null;
      if (indexed === null) {
        if (this.expectedLogicalCut) return fail("logical-session-route-unavailable");
        // A new branch can share a long prefix with a newer committed ancestor
        // head. Reuse that covered prefix instead of deriving cut 16 against a
        // head that cannot rewind. Inspect only the bounded catalog ancestry.
        for (let length = requested.view.segments.length - 1; length > 0; length--) {
          const segments = requested.view.segments.slice(0, length);
          const view = { ...requested.view, eventCut: segments.at(-1)!.cut, segments };
          const ancestor = this.makeTarget(t, view);
          const saved = await runSearchV3Worker({ ...ancestor, op: "status" }, options);
          valid(); if (!saved.ok) return fail(saved.code);
          if (saved.result.error === "search-v3-indexed-view-incompatible") return fail("search-v3-resume-invalid");
          const readiness = saved.result.readiness as { cue?: unknown; raw?: unknown } | undefined;
          if (readiness?.cue !== "ready" || readiness.raw !== "ready") continue;
          const head = saved.result.indexedView as { branchKey?: unknown; eventCut?: unknown; hash?: unknown; complete?: unknown } | null;
          const expected = saved.result.requestedView as { branchKey?: unknown; eventCut?: unknown; hash?: unknown } | undefined;
          if (!head || head.branchKey !== view.branchKey || !Number.isSafeInteger(head.eventCut) || Number(head.eventCut) < view.eventCut
            || head.complete !== true || typeof head.hash !== "string" || !/^[a-f0-9]{64}$/.test(head.hash)
            || expected?.branchKey !== view.branchKey || expected.eventCut !== view.eventCut || expected.hash !== hash(canonicalJson(view))) return fail("search-v3-resume-invalid");
          const storedView = { ...view, eventCut: Number(head.eventCut), segments: segments.map((segment, index) =>
            index === segments.length - 1 ? { ...segment, cut: Number(head.eventCut) } : { ...segment }) };
          if (!isCapsuleCatalogView(storedView) || hash(canonicalJson(storedView)) !== head.hash) return fail("search-v3-resume-invalid");
          // Catalog reconstructs the committed head and verifies its hash and
          // ancestry. Serve only its common prefix from the requested branch.
          const authorized = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: t.catalogDirectory,
            sessionKey: t.sessionKey, view: storedView, after: storedView.eventCut, limit: 1 }, options);
          valid(); if (!authorized.ok) return fail(authorized.code);
          this.lastReady = ancestor;
          this.readyValidated = true;
          break;
        }
        this.resumeChecked = true;
        return { ...this.progress };
      }
      if (indexed.branchKey !== requested.view.branchKey || !Number.isSafeInteger(indexed.eventCut) || Number(indexed.eventCut) < 1
        || Number(indexed.eventCut) > requested.view.eventCut || typeof indexed.hash !== "string" || !/^[a-f0-9]{64}$/.test(indexed.hash)
        || typeof indexed.complete !== "boolean") return fail("search-v3-resume-invalid");
      const cut = Number(indexed.eventCut);
      if (this.expectedLogicalCut && (indexed.complete !== true || cut !== this.expectedLogicalCut.eventCut)) return fail("logical-session-route-unavailable");
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
      // Keep the first useful prefix small. Later prefixes coalesce at most
      // eight existing 16-event pages before one pin/publication. This removes
      // repeated pin/publication overhead without changing any worker limit,
      // configuration identity or already committed derived checkpoint.
      let leaf: import("./catalog-contract.js").CatalogEvent | undefined;
      let pageAfter = after;
      for (let batch = 0; batch < (after === 0 ? 1 : 8); batch++) {
        const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, view: catalogView, after: pageAfter, limit: 16 }, options);
        valid(); if (!page.ok) return fail(page.code);
        const events = page.result.events as import("./catalog-contract.js").CatalogEvent[];
        if (!events.length) break;
        leaf = events.at(-1)!;
        if (leaf.seq <= pageAfter) return fail("search-v3-prefix-page-invalid");
        pageAfter = leaf.seq;
        if (events.length < 16 || pageAfter === requested.view.eventCut) break;
      }
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
    if (this.expectedLogicalCut && (current.view.storeKey !== this.expectedLogicalCut.catalogStoreKey
      || current.view.generation !== this.expectedLogicalCut.catalogGeneration
      || current.view.sessionKey !== this.expectedLogicalCut.sessionKey || current.view.branchKey !== this.expectedLogicalCut.branchKey
      || current.view.eventCut !== this.expectedLogicalCut.eventCut)) return fail("logical-session-route-scope-mismatch");
    if (!reference) return current;
    const view = reference.view;
    if (!this.within(view, current.view)) return fail("search-v3-reference-scope-mismatch");
    return { ...current, view };
  }
  async search(params: Record<string, unknown>, signal?: AbortSignal): Promise<SearchToolResult> {
    if (!this.logicalGrant) return this.searchOne(params, signal);
    try {
      const grant = this.logicalGrant;
      const routes = [...grant.searchRoutes].reverse();
      let position = 0, inner: string | undefined;
      if (typeof params.cursor === "string" && params.cursor.startsWith(logicalCursorPrefix)) {
        const parsed = JSON.parse(Buffer.from(params.cursor.slice(logicalCursorPrefix.length), "base64url").toString("utf8")) as LogicalSearchPosition;
        const { integrityHash, ...body } = parsed;
        if (parsed.v !== 1 || parsed.logicalSessionId !== grant.logicalSessionId || parsed.manifestRevision !== grant.manifestRevision
          || parsed.manifestHash !== grant.manifestHash || parsed.branchId !== grant.branchId || !Number.isSafeInteger(parsed.routeIndex)
          || parsed.routeIndex < 0 || parsed.routeIndex >= routes.length || logicalCursorHash(body) !== integrityHash
          || parsed.inner !== undefined && (typeof parsed.inner !== "string" || parsed.inner.length > 16_384)) return fail("logical-session-cursor-invalid");
        position = parsed.routeIndex; inner = parsed.inner;
      } else if (params.cursor !== undefined) {
        inner = String(params.cursor);
      }
      const makeCursor = (routeIndex: number, storeCursor?: string): string => {
        const body = { v: 1 as const, logicalSessionId: grant.logicalSessionId, manifestRevision: grant.manifestRevision,
          manifestHash: grant.manifestHash, branchId: grant.branchId, routeIndex, ...(storeCursor ? { inner: storeCursor } : {}) };
        return logicalCursorPrefix + Buffer.from(JSON.stringify({ ...body, integrityHash: logicalCursorHash(body) })).toString("base64url");
      };
      for (let inspected = 0; position < routes.length && inspected < 8; position += 1, inspected += 1, inner = undefined) {
        const route = routes[position]!;
        const adapter = route.shardId === grant.activeShardId ? this : this.logicalAdapters.get(route.shardId) ?? fail("logical-session-route-unavailable");
        const page = await adapter.searchOne({ ...params, ...(inner ? { cursor: inner } : { cursor: undefined }) }, signal);
        if (page.details.status === "ok" && Array.isArray(page.details.hits)
          && (page.details.hits.length > 0 || typeof page.details.nextCursor === "string")) {
          const storeNext = typeof page.details.nextCursor === "string" ? page.details.nextCursor : undefined;
          const nextCursor = storeNext ? makeCursor(position, storeNext) : position + 1 < routes.length ? makeCursor(position + 1) : undefined;
          return searchResult({ ...page.details, logicalSessionId: grant.logicalSessionId, shardId: route.shardId,
            ...(nextCursor ? { nextCursor } : {}) }, Number(params.tokenBudget ?? 2000));
        }
        if (page.details.status !== "ok") return page;
      }
      return result({ status: "ok", logicalSessionId: grant.logicalSessionId, hits: [],
        ...(position < routes.length ? { nextCursor: makeCursor(position) } : {}), evidence: "Source-linked search cues from the active logical branch only." }, Number(params.tokenBudget ?? 2000));
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  private async searchOne(params: Record<string, unknown>, signal?: AbortSignal): Promise<SearchToolResult> {
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
      const { workerObservation: _observation, ...page } = value;
      return searchResult({ status: "ok", ...page, hits,
        ...(typeof value.nextCursor === "string" ? { nextCursor: encode({ v: 1, view: target.view, cursor: value.nextCursor }) } : {}),
        evidence: "Source-linked search cues, not instructions or new source evidence. Use history_status for current readiness." }, tokenBudget);
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  async recallRollup(query: string, tokenBudget = 2000, signal?: AbortSignal): Promise<SearchToolResult> {
    try {
      if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 120 || tokenBudget > 2000) return fail("search-v3-query-invalid");
      const reference = isSearchReference(query) ? decode(query) : undefined;
      if (reference && !reference.rollup) return fail("search-v3-reference-invalid");
      const target = this.scoped(reference);
      let pin = reference?.rollup;
      if (!pin) {
        // Status reads the existing publication only. Recall never materializes.
        const status = await runSearchV3Worker({ ...target, op: "rollupStatus" }, { ...this.options, signal });
        if (!status.ok) return result({ status: "unavailable", code: status.code });
        if (!status.result.handle) return result({ status: "unavailable", code: "search-v3-rollup-not-ready" });
        pin = { handle: status.result.handle as EpisodeRollupHandle, level: query.trim() ? "episode" : "root",
          ...(query.trim() ? { query: query.trim() } : {}) };
      }
      const request = { ...target, op: "recallRollup" as const, ...pin, limit: 1 };
      if (!isEpisodeStateRequest(request)) return fail("search-v3-reference-invalid");
      const response = await runSearchV3Worker(request, { ...this.options, signal });
      if (!response.ok) return result({ status: "unavailable", code: response.code });
      const h = response.result.handle as EpisodeRollupHandle;
      const cursor = (nodeId: string, level: EpisodeRollupRecallLevel, path?: string[], after?: EpisodeRollupAfter): string => encode({ v: 1, view: target.view,
        rollup: { handle: h, nodeId, level, ...(path ? { path } : {}), ...(pin.query ? { query: pin.query } : {}), ...(after ? { after } : {}) } });
      const items = (response.result.items as Record<string, unknown>[]).map(item => {
        const ref = item.reference as Record<string, unknown> | undefined;
        const nodeId = typeof ref?.nodeId === "string" ? ref.nodeId : pin.nodeId ?? h.rootNodeId;
        const source = item.source;
        const summaries = (Array.isArray(item.summary) ? item.summary : [item.cue])
          .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
        // Sample across the bounded node instead of displaying JSON syntax or
        // letting the first long excerpt hide every other navigation cue.
        const sampled = summaries.length > 3 ? [summaries[0]!, summaries[Math.floor(summaries.length / 2)]!, summaries.at(-1)!] : summaries;
        const displayed = sampled.map(text => text.replace(/\s+/gu, " ").trim().slice(0, Math.floor(354 / Math.max(1, sampled.length))));
        const cue = displayed.join(" | ") || "Topic cue unavailable. Expand for source detail.";
        const summaryUnits = summaries.reduce((units, text) => units + text.length, 0);
        const protectedItems = Array.isArray(item.protectedReferences) ? item.protectedReferences : [];
        const metadataItems = Array.isArray(item.metadataHints) ? item.metadataHints : [];
        return { nodeId, ...(ref?.episodeKey ? { episodeKey: ref.episodeKey } : {}),
          ...(ref?.range || ref?.boundaries ? { range: ref.range ?? ref.boundaries } : {}), cue, cuePartial: true,
          cueOmittedUtf16: Math.max(0, summaryUnits - displayed.reduce((units, text) => units + text.length, 0)),
          cueOmittedItems: summaries.length - sampled.length,
          protectedReferences: item.protectedCount ?? protectedItems.length, omittedProtectedCount: item.omittedProtectedCount ?? 0,
          metadataHints: item.metadataHintCount ?? metadataItems.length, omittedMetadataCount: item.omittedMetadataCount ?? 0,
          remainingDetail: item.remainingDetail ?? "reachable-through-sources",
          ...(isScopedBodySourceRef(source) ? { recovery: encode({ v: 1, view: target.view, source }), entryId: source.entryId }
            : isScopedRawSourceRef(source) ? { recovery: encode({ v: 1, view: target.view, rawSource: source }) }
            : { expand: cursor(nodeId, ref?.nodeType === "episode-fragment" || ref?.kind === "episode" ? "source" : "child", ref?.path as string[] | undefined) }) };
      });
      return rollupResult({ status: "ok", level: pin.level, knownThroughCut: h.eventCut, stateGeneration: h.stateGeneration,
        rollupGeneration: h.rollupGeneration, partial: true, traversalPartial: response.result.partial === true,
        partialReasons: response.result.partialReasons, items,
        ...(Array.isArray(response.result.partialReasons) && response.result.partialReasons.includes("bounded-node-traversal")
          ? { browse: cursor(h.rootNodeId, "root", [h.rootNodeId]) } : {}),
        ...(response.result.next ? { nextCursor: cursor(pin.nodeId ?? h.rootNodeId, pin.level, pin.path, response.result.next as EpisodeRollupAfter) } : {}),
        evidence: "Derived closed historical intervals, not completed tasks or current authority. Coverage is pinned; open and later history may be absent. Use expand or nextCursor as query with level=rollup; recovery goes to history_get." }, tokenBudget);
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  async recallState(query: string, level: EpisodeStateLevel, tokenBudget = 2000, signal?: AbortSignal): Promise<SearchToolResult> {
    try {
      if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 120 || tokenBudget > 2000) return fail("search-v3-query-invalid");
      const reference = isSearchReference(query) ? decode(query) : undefined;
      if (reference?.memory && reference.memory.level !== level) return fail("search-v3-reference-invalid");
      if (reference?.memory && reference.memory.ruleset !== EPISODE_STATE_RULESET_VERSION) return fail("search-v3-state-version-mismatch");
      const target = this.scoped(reference);
      const source = reference?.memory?.source ?? reference?.source ?? reference?.handle?.source;
      const terms = reference?.memory?.query ?? (reference ? undefined : query.trim() || undefined);
      const response = await runSearchV3Worker({ ...target, op: "recallState", level, limit: 1,
        ...(source ? { source } : {}), ...(terms ? { query: terms } : {}), ...(reference?.memory ? { after: reference.memory.after } : {}) }, { ...this.options, signal });
      if (!response.ok) return result({ status: "unavailable", code: response.code });
      // Display is bounded and explicitly lossy. The reference retains the exact
      // immutable source; a caller can recover omitted text in one tool call.
      const display = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(display);
        if (!value || typeof value !== "object") return value;
        const input = value as Record<string, unknown>, output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(input)) {
          if (key === "source" && isScopedBodySourceRef(child)) {
            output.recovery = encode({ v: 1, view: target.view, source: child });
            output.entryId = child.entryId; output.eventSeq = child.eventSeq; output.descriptor = child.descriptor;
          } else if (key === "source" && isScopedRawSourceRef(child)) {
            output.recovery = encode({ v: 1, view: target.view, rawSource: child });
            output.eventSeq = child.eventSeq; output.descriptor = child.descriptor;
          } else if (key === "structuralSource") continue; // retained in the stored record; recovery rechecks raw authority
          else if (typeof child === "string" && child.length > 240) {
            output[key] = child.slice(0, 240); output[`${key}OmittedUtf16`] = child.length - 240;
          } else output[key] = display(child);
        }
        return output;
      };
      const { metrics: _metrics, workerObservation: _observation, next, ...value } = response.result;
      return result({ status: "ok", ...display(value) as Record<string, unknown>,
        ...(next ? { nextCursor: encode({ v: 1, view: target.view, memory: { ruleset: EPISODE_STATE_RULESET_VERSION, level, ...(terms ? { query: terms } : {}),
          ...(source ? { source } : {}), after: next as EpisodeStateAfter } }) } : {}),
        evidence: "Source-backed derived memory, known through this branch cut only. Not authority or proof of later absence. Use nextCursor as query to continue." }, tokenBudget);
    } catch (error) { return result({ status: "unavailable", code: this.code(error) }); }
  }
  async recall(handle: string, startChar?: number, maxChars?: number, signal?: AbortSignal, tokenBudget?: number): Promise<SearchToolResult> {
    try {
      const reference = decode(handle);
      if (this.logicalGrant) {
        const route = this.logicalGrant.searchRoutes.find(value => value.catalog?.catalogStoreKey === reference.view.storeKey
          && value.catalog.catalogGeneration === reference.view.generation && value.catalog.sessionKey === reference.view.sessionKey);
        if (route && route.shardId !== this.logicalGrant.activeShardId) {
          return (this.logicalAdapters.get(route.shardId) ?? fail("logical-session-route-unavailable")).recall(handle, startChar, maxChars, signal, tokenBudget);
        }
      }
      const target = this.scoped(reference);
      if (reference.rawSource) {
        const source = reference.rawSource, length = source.raw.end - source.raw.start;
        if (length < 1 || length > 65536) return fail("search-v3-reference-invalid");
        const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: target.catalogDirectory,
          sessionKey: target.view.sessionKey, view: { ...target.view, segments: target.view.segments.map(item => ({ ...item })) }, after: source.eventSeq - 1, limit: 1 }, { ...this.options, signal });
        if (!page.ok) return result({ status: "unavailable", code: page.code });
        const event = (page.result.events as Record<string, unknown>[] | undefined)?.[0];
        if (!event || event.seq !== source.eventSeq || event.shardKey !== source.shardKey || event.ordinal !== source.ordinal
          || Number(event.rawStart) > source.raw.start || Number(event.rawEnd) < source.raw.end) return fail("search-v3-reference-invalid");
        const raw = await runCatalogWorker({ v: 1, op: "raw", catalogDirectory: target.catalogDirectory,
          sessionKey: target.view.sessionKey, view: { ...target.view, segments: target.view.segments.map(item => ({ ...item })) }, eventSeq: source.eventSeq, offset: source.raw.start, length }, { ...this.options, signal });
        if (!raw.ok) return result({ status: "unavailable", code: raw.code });
        const bytes = Buffer.from(String(raw.result.data), "base64");
        if (bytes.length !== length || createHash("sha256").update(bytes).digest("hex") !== source.rawHash) return fail("search-v3-reference-invalid");
        const whole = bytes.toString("utf8"), start = startChar ?? 0;
        if (!Number.isSafeInteger(start) || start < 0 || start > whole.length) return fail("search-v3-reference-invalid");
        const text = whole.slice(start, start + Math.min(8192, maxChars ?? 2048));
        return result({ status: "ok", source, text, startChar: start, nextChar: start + text.length,
          complete: start + text.length === whole.length, evidence: "Exact hash-verified source JSONL; metadata authority remains advisory." }, tokenBudget);
      }
      if (reference.source) {
        const source = reference.source;
        const start = startChar ?? source.decodedUtf16.start;
        const length = Math.min(8192, maxChars ?? 2048, source.decodedUtf16.end - start);
        if (!Number.isSafeInteger(start) || start < source.decodedUtf16.start || length < 0) return fail("search-v3-reference-invalid");
        const response = await runCapsuleWorker({ v: 1, op: "chunkRange", derivedDirectory: target.capsuleDirectory,
          catalogDirectory: target.catalogDirectory, identity: target.identity.capsule, view: target.view, source,
          decodedStart: start, decodedLength: length, limit: 2 }, { ...this.options, signal });
        if (!response.ok) return result({ status: "unavailable", code: response.code });
        const text = Buffer.from(String(response.result.data), "base64").toString("utf16le");
        return result({ status: "ok", source, text, startChar: start, nextChar: start + text.length,
          complete: start + text.length === source.decodedUtf16.end, evidence: "Exact source text; derived memory is not authority." }, tokenBudget);
      }
      if (!reference.handle) return fail("search-v3-reference-invalid");
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
  async getBlock(entryId: string, blockIndex: number, startChar?: number, maxChars?: number, signal?: AbortSignal, shardId?: string): Promise<SearchToolResult> {
    try {
      if (shardId && !this.logicalGrant) return result({ status: "unavailable", code: "logical-session-route-unavailable" });
      if (shardId && this.logicalGrant && shardId !== this.logicalGrant.activeShardId) return (this.logicalAdapters.get(shardId) ?? fail("logical-session-route-unavailable")).getBlock(entryId, blockIndex, startChar, maxChars, signal);
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
  async getRaw(entryId: string, options: { startByte?: number; maxChars?: number; startChar?: number; contextBefore?: number; contextAfter?: number }, signal?: AbortSignal, shardId?: string): Promise<SearchToolResult> {
    try {
      if (shardId && !this.logicalGrant) return result({ status: "unavailable", code: "logical-session-route-unavailable" });
      if (shardId && this.logicalGrant && shardId !== this.logicalGrant.activeShardId) return (this.logicalAdapters.get(shardId) ?? fail("logical-session-route-unavailable")).getRaw(entryId, options, signal);
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
  async range(start: string, end: string, maxEntries = 16, cursor?: string, signal?: AbortSignal, shardId?: string): Promise<SearchToolResult> {
    try {
      if (shardId && !this.logicalGrant) return result({ status: "unavailable", code: "logical-session-route-unavailable" });
      if (shardId && this.logicalGrant && shardId !== this.logicalGrant.activeShardId) return (this.logicalAdapters.get(shardId) ?? fail("logical-session-route-unavailable")).range(start, end, maxEntries, cursor, signal);
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
  private code(error: unknown): string { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^(search|catalog|capsule|logical-session)-[a-z0-9-]{1,80}$/.test(code) ? code : "search-v3-unavailable"; }
}
