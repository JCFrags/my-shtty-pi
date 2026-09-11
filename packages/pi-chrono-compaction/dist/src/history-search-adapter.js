import { createHash } from "node:crypto";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { estimateTokensFromText } from "./utils.js";
import { resolveCatalogHistory, readCatalogHistoryPage } from "./catalog-history.js";
import { CAPSULE_REDUCER_PIPELINE_VERSION, isCapsuleCatalogView, isCapsuleReadiness, isScopedBodySourceRef, isScopedRawSourceRef, sourceRefWithinViewBounds } from "./capsule-contract.js";
import { canonicalJson } from "./capsule-segment.js";
import { runCatalogWorker } from "./catalog-worker-client.js";
import { runCapsuleWorker } from "./capsule-worker-client.js";
import { runSearchV3Worker } from "./search-v3-worker-client.js";
import { isSearchV3Handle } from "./search-v3-contract.js";
import { EPISODE_STATE_RULESET_VERSION, isEpisodeStateRequest } from "./episode-state-contract.js";
import { SearchLifecycleScheduler } from "./search-lifecycle.js";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const uuid = (text) => { const h = hash(text); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const prefix = "chrono-v3:";
const encode = (value) => prefix + deflateRawSync(Buffer.from(JSON.stringify(value))).toString("base64url");
function decode(text) {
    if (!text.startsWith(prefix) || text.length > 16_384)
        return fail("search-v3-reference-invalid");
    let r;
    try {
        r = JSON.parse(inflateRawSync(Buffer.from(text.slice(prefix.length), "base64url"), { maxOutputLength: 16384 }).toString("utf8"));
    }
    catch {
        return fail("search-v3-reference-invalid");
    }
    if (r.v !== 1 || !isCapsuleCatalogView(r.view) || (r.handle !== undefined && !isSearchV3Handle(r.handle)) || (r.cursor !== undefined && (typeof r.cursor !== "string" || r.cursor.length > 4096)))
        return fail("search-v3-reference-invalid");
    if (r.source !== undefined && (!isScopedBodySourceRef(r.source) || !sourceRefWithinViewBounds(r.source, r.view)))
        return fail("search-v3-reference-invalid");
    if (r.rawSource !== undefined && (!isScopedRawSourceRef(r.rawSource) || !sourceRefWithinViewBounds(r.rawSource, r.view)
        || r.rawSource.raw.end - r.rawSource.raw.start > 65536))
        return fail("search-v3-reference-invalid");
    if (r.memory && (!["episode", "resource", "state"].includes(r.memory.level) || !r.memory.after || !Number.isSafeInteger(r.memory.after.eventSeq)
        || !Number.isSafeInteger(r.memory.after.descriptor) || r.memory.after.eventSeq < 1 || r.memory.after.descriptor < 0
        || (r.memory.query !== undefined && (typeof r.memory.query !== "string" || r.memory.query.length > 256))
        || (r.memory.source !== undefined && (!isScopedBodySourceRef(r.memory.source) || !sourceRefWithinViewBounds(r.memory.source, r.view)))))
        return fail("search-v3-reference-invalid");
    if (r.rollup && (typeof r.rollup !== "object" || !r.rollup.handle || !["root", "child", "episode", "source"].includes(r.rollup.level)))
        return fail("search-v3-reference-invalid");
    if (r.range && (typeof r.range.start !== "string" || r.range.start.length > 1024 || typeof r.range.end !== "string" || r.range.end.length > 1024 || !Number.isSafeInteger(r.range.after) || r.range.after < 0 || (r.range.byte !== undefined && (!Number.isSafeInteger(r.range.byte) || r.range.byte < 0))))
        return fail("search-v3-reference-invalid");
    return r;
}
const result = (value, tokenBudget) => {
    const text = JSON.stringify(value);
    if (tokenBudget !== undefined && estimateTokensFromText(text) > tokenBudget)
        return result({ status: "unavailable", code: "search-v3-output-budget", suggestion: "Use a smaller limit or a larger tokenBudget. The cursor was not advanced." });
    return { content: [{ type: "text", text }], details: value };
};
export const isSearchReference = (value) => value.startsWith(prefix);
/** Shared exact recovery encoding for bounded shadow selections. */
export function encodeCompositionRecovery(view, source) {
    const reference = source.coordinateKind === "decoded-body" ? { v: 1, view, source } : { v: 1, view, rawSource: source };
    const text = encode(reference);
    decode(text); // Use the real public recovery validator, not a weaker composer copy.
    return text;
}
/** Real lifecycle pipeline. Only contained workers inspect source or SQLite.
 * Identities are deterministic across append/restart; branch views remain pinned.
 * One active target is retained, never lifetime history or a full postings list. */
export class HistorySearchAdapter {
    options;
    scheduler;
    key;
    target;
    workTarget;
    resumeChecked = false;
    lastReady;
    readyValidated = false;
    enabled = false;
    memory = { state: "pending", knownThroughCut: null };
    memoryTick = 0;
    memoryResumeChecked = false;
    rollup = { state: "pending", knownThroughCut: null };
    rollupTurn = false;
    rollupResumeChecked = false;
    sourceTarget;
    progress = { catalog: "pending", capsules: "pending", index: "pending" };
    constructor(options = {}) {
        this.options = options;
        this.scheduler = new SearchLifecycleScheduler((target, signal) => this.step(target, signal));
    }
    schedule(target) {
        const key = JSON.stringify(target);
        this.enabled = true;
        const prior = this.sourceTarget;
        if (!prior || ["sourcePath", "sessionKey", "shardKey", "catalogDirectory"].some(k => prior[k] !== target[k]))
            this.lastReady = undefined;
        this.sourceTarget = target;
        if (this.key !== key) {
            this.rollup = { state: "pending", knownThroughCut: null };
            this.rollupTurn = false;
            this.rollupResumeChecked = false;
            this.memory = { state: "pending", knownThroughCut: null };
            this.memoryTick = 0;
            this.memoryResumeChecked = false;
            this.key = key;
            this.target = undefined;
            this.workTarget = undefined;
            this.resumeChecked = false;
            this.readyValidated = false;
            this.progress = { catalog: "pending", capsules: "pending", index: "pending" };
        }
        this.scheduler.schedule(target);
    }
    cancel() { this.rollup = { state: "pending", knownThroughCut: null }; this.rollupTurn = false; this.rollupResumeChecked = false; this.memory = { state: "pending", knownThroughCut: null }; this.memoryTick = 0; this.scheduler.cancel(); this.key = undefined; this.target = undefined; this.workTarget = undefined; this.resumeChecked = false; this.lastReady = undefined; this.readyValidated = false; this.progress = { catalog: "pending", capsules: "pending", index: "pending" }; }
    disable() { this.enabled = false; this.cancel(); this.scheduler.disable(); }
    dispose() { this.disable(); this.scheduler.dispose(); }
    /** Cached bounded state only: no worker, source I/O, or lifetime counts. */
    status() {
        const state = this.scheduler.status();
        const requestedCut = this.target?.view.eventCut ?? null;
        const indexedCut = this.readyValidated ? this.lastReady?.view.eventCut ?? null : null;
        return { enabled: this.enabled, ...state, catalog: this.progress.catalog, capsules: this.progress.capsules, index: this.progress.index,
            memory: { ...this.memory, requestedCut, coverage: "Known through the materialized branch cut only; later state may exist." },
            rollup: { ...this.rollup, requestedCut, coverage: "Closed historical intervals only, not completed tasks. Later or open history may be absent." },
            requestedCut, indexedCut, lag: requestedCut !== null && indexedCut !== null ? Math.max(0, requestedCut - indexedCut) : null,
            servingLastReady: this.readyValidated && !!this.lastReady, requestedViewValidated: !!this.target, lastSafeError: state.errorCode ?? null };
    }
    /** Explicit shadow preview only. Pin the already-cataloged real compaction cut;
     * never ingest or change the automatic scheduler from this read path. */
    async compositionTarget(prefixLeafId, signal) {
        if (!this.enabled || !this.sourceTarget || !this.target || !this.readyValidated)
            return fail("search-v3-index-not-ready");
        const key = this.key, source = this.sourceTarget, current = this.target;
        const response = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: source.catalogDirectory,
            sessionKey: source.sessionKey, branchKey: "pi-session", leaf: { shardKey: source.shardKey, eventId: prefixLeafId } }, { ...this.options, signal });
        if (signal?.aborted || this.key !== key || !this.enabled)
            return fail("search-v3-worker-aborted");
        if (!response.ok)
            return fail(response.code);
        const view = response.result.view;
        if (!isCapsuleCatalogView(view) || !this.within(view, current.view))
            return fail("search-v3-view-incompatible");
        return structuredClone(this.makeTarget(source, view));
    }
    /** One contained read from an existing state store. No ingestion or publication. */
    async compositionSelection(prefixLeafId, signal) {
        const key = this.key;
        const target = await this.compositionTarget(prefixLeafId, signal);
        const response = await runSearchV3Worker({ ...target, op: "composeStateSelection" }, { ...this.options, signal });
        if (signal?.aborted || this.key !== key || !this.enabled)
            return fail("search-v3-worker-aborted");
        if (!response.ok)
            return fail(response.code);
        const selection = response.result;
        if (!isCapsuleCatalogView(selection.sourceView) || canonicalJson(selection.sourceView) !== canonicalJson(target.view)
            || selection.requestedCut !== target.view.eventCut || selection.processedCut > selection.requestedCut
            || selection.processedMemoryCut < selection.processedCut)
            return fail("search-v3-state-view-incompatible");
        return selection;
    }
    within(view, current) {
        return view.storeKey === current.storeKey && view.generation === current.generation && view.sessionKey === current.sessionKey
            && view.branchKey === current.branchKey && view.eventCut <= current.eventCut
            && view.segments.every(segment => current.segments.some(s => s.segment === segment.segment && segment.cut <= s.cut));
    }
    makeTarget(t, view) {
        // Prefix catch-up is a deliberate new derivation configuration. It must not
        // rewind or overwrite an installed whole-view head with the old config.
        const capsuleConfig = hash("chrono-m06-capsule-prefix-v1");
        const identity = { storeKey: uuid(`${view.storeKey}:${view.generation}:${CAPSULE_REDUCER_PIPELINE_VERSION}:${capsuleConfig}`), sessionKey: view.sessionKey, catalogStoreKey: view.storeKey, catalogGeneration: view.generation, derivedSchemaVersion: 2, capsuleSchemaVersion: 1, chunkSchemaVersion: 1, reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: capsuleConfig };
        const searchKey = uuid(`${identity.storeKey}:search-v3-v2`);
        return { v: 1, op: "ingestPage", catalogDirectory: t.catalogDirectory, capsuleDirectory: join(t.catalogDirectory, `capsules-${identity.storeKey}`), searchDirectory: join(t.catalogDirectory, `search-${searchKey}`), identity: { storeKey: searchKey, capsule: identity, schemaVersion: 1, configHash: hash("chrono-m06-search-default-v2") }, view };
    }
    async step(t, signal) {
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
        if (searchable && (memoryPending || rollupPending) && (searchComplete || this.memoryTick++ % 8 === 0)) {
            const key = this.key;
            const rollupJob = rollupPending && (!memoryPending || this.rollupTurn);
            this.rollupTurn = !rollupJob;
            const resumeRollup = rollupJob && !this.rollupResumeChecked;
            const resumeMemory = !rollupJob && !this.memoryResumeChecked;
            const response = await runSearchV3Worker({ ...searchable, op: rollupJob ? resumeRollup ? "rollupStatus" : "materializeRollup" : resumeMemory ? "stateStatus" : "materializeState" }, { ...this.options, signal });
            if (signal.aborted || key !== this.key)
                return fail("search-v3-worker-aborted");
            if (rollupJob) {
                this.rollupResumeChecked = true;
                // As with the search store, only an absent route may proceed to the
                // authoritative create operation. Corrupt/unsafe state remains refused.
                if (resumeRollup && !response.ok && response.code === "search-v3-rollup-store-missing")
                    this.rollup = { state: "pending", knownThroughCut: null };
                else
                    this.rollup = response.ok
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
            }
            else {
                this.memoryResumeChecked = true;
                if (resumeMemory && !response.ok && response.code === "search-v3-state-store-missing")
                    this.memory = { state: "pending", knownThroughCut: null };
                else
                    this.memory = response.ok
                        ? { state: response.result.complete === true ? "ready" : "lagging", complete: response.result.complete === true,
                            knownThroughCut: response.result.knownThroughCut ?? null, partial: response.result.partial === true,
                            stateGeneration: response.result.stateGeneration ?? null,
                            metadata: response.result.metadata ?? { complete: false, afterEventSeq: 0 } }
                        : { ...this.memory, state: "error", lastSafeError: response.code };
            }
        }
        else if (!searchComplete)
            await this.searchStep(t, signal);
        const memory = this.memory.state === "error" ? "error" : this.readyValidated && this.lastReady
            && this.memory.complete === true && this.memory.knownThroughCut === this.lastReady.view.eventCut ? "ready" : "pending";
        const rollup = this.rollup.state === "error" || this.memory.state === "error" ? "error"
            : this.rollup.complete === true && Number(this.rollup.processedCut ?? 0) >= Number(this.memory.knownThroughCut ?? 0) ? "ready" : "pending";
        return { ...this.progress, memory, rollup };
    }
    async searchStep(t, signal) {
        const options = { ...this.options, signal };
        const key = JSON.stringify(t);
        const valid = () => { if (signal.aborted || key !== this.key)
            fail("search-v3-worker-aborted"); };
        if (this.progress.catalog !== "ready") {
            const ingested = await runCatalogWorker({ v: 1, op: "ingestStep", sourcePath: t.sourcePath, catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, shardKey: t.shardKey, branchKey: "pi-session", shardOrdinal: 0 }, options);
            valid();
            if (!ingested.ok)
                return fail(ingested.code);
            if (ingested.result.error)
                return fail("catalog-ingestion-refused");
            if (ingested.result.caughtUp !== true) {
                this.progress = { ...this.progress, catalog: "lagging", waitingForAppend: ingested.result.incompleteTail === true };
                return { ...this.progress };
            }
            const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, branchKey: "pi-session", leaf: { shardKey: t.shardKey, eventId: t.leafId } }, options);
            valid();
            if (!pinned.ok)
                return fail(pinned.code);
            const view = pinned.result.view;
            if (!isCapsuleCatalogView(view))
                return fail("search-v3-pin-invalid");
            this.target = this.makeTarget(t, view);
            this.workTarget = undefined;
            this.resumeChecked = false;
            // The new pinned branch must prove the last-ready view is its prefix.
            // Until this check finishes, retain but do not serve the previous view.
            this.readyValidated = !!this.lastReady && this.within(this.lastReady.view, view);
            if (!this.readyValidated)
                this.lastReady = undefined;
            this.progress = this.readyValidated && this.lastReady?.view.eventCut === view.eventCut
                ? { catalog: "ready", capsules: "ready", index: "ready" }
                : { catalog: "ready", capsules: "pending", index: "pending" };
            return { ...this.progress };
        }
        const requested = this.target;
        if (!requested)
            return fail("search-v3-target-missing");
        if (!this.resumeChecked) {
            const status = await runSearchV3Worker({ ...requested, op: "status", view: requested.view }, options);
            valid();
            // A status open cannot distinguish an absent route from a generic missing
            // path. The subsequent create operation remains authoritative and will
            // preserve any real storage failure.
            if (!status.ok) {
                if (status.code !== "search-v3-storage-io")
                    return fail(status.code);
                this.resumeChecked = true;
                return { ...this.progress };
            }
            const indexed = status.result.indexedView;
            if (indexed === null) {
                this.resumeChecked = true;
                return { ...this.progress };
            }
            if (indexed.branchKey !== requested.view.branchKey || !Number.isSafeInteger(indexed.eventCut) || Number(indexed.eventCut) < 1
                || Number(indexed.eventCut) > requested.view.eventCut || typeof indexed.hash !== "string" || !/^[a-f0-9]{64}$/.test(indexed.hash)
                || typeof indexed.complete !== "boolean")
                return fail("search-v3-resume-invalid");
            const cut = Number(indexed.eventCut);
            const catalogView = { ...requested.view, segments: requested.view.segments.map(segment => ({ ...segment })) };
            const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, view: catalogView, after: cut - 1, limit: 1 }, options);
            valid();
            if (!page.ok)
                return fail(page.code);
            const leaf = page.result.events[0];
            if (!leaf || leaf.seq !== cut)
                return fail("search-v3-resume-invalid");
            const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, branchKey: "pi-session", leaf: { shardKey: leaf.shardKey, ordinal: leaf.ordinal } }, options);
            valid();
            if (!pinned.ok)
                return fail(pinned.code);
            const view = pinned.result.view;
            if (!isCapsuleCatalogView(view) || !this.within(view, requested.view) || view.eventCut !== cut
                || hash(canonicalJson(view)) !== indexed.hash)
                return fail("search-v3-resume-invalid");
            const resumed = this.makeTarget(t, view);
            if (indexed.complete) {
                this.lastReady = resumed;
                this.readyValidated = true;
                this.progress = cut === requested.view.eventCut
                    ? { catalog: "ready", capsules: "ready", index: "ready" }
                    : { catalog: "ready", capsules: "pending", index: "pending" };
            }
            else {
                const capsule = await runCapsuleWorker({ v: 1, op: "status", derivedDirectory: resumed.capsuleDirectory, catalogDirectory: resumed.catalogDirectory, identity: resumed.identity.capsule, view }, options);
                valid();
                if (!capsule.ok)
                    return fail(capsule.code);
                const readiness = capsule.result.readiness;
                if (!isCapsuleReadiness(readiness) || canonicalJson(readiness.view) !== canonicalJson(view)
                    || readiness.capsules.afterEventSeq !== cut || readiness.capsules.afterDescriptor !== 0
                    || readiness.chunks.afterEventSeq !== cut || readiness.chunks.afterDescriptor !== 0)
                    return fail("search-v3-resume-invalid");
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
            let leaf;
            let pageAfter = after;
            for (let batch = 0; batch < (after === 0 ? 1 : 8); batch++) {
                const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, view: catalogView, after: pageAfter, limit: 16 }, options);
                valid();
                if (!page.ok)
                    return fail(page.code);
                const events = page.result.events;
                if (!events.length)
                    break;
                leaf = events.at(-1);
                if (leaf.seq <= pageAfter)
                    return fail("search-v3-prefix-page-invalid");
                pageAfter = leaf.seq;
                if (events.length < 16 || pageAfter === requested.view.eventCut)
                    break;
            }
            if (!leaf)
                return fail("search-v3-prefix-page-invalid");
            const pinned = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory: t.catalogDirectory, sessionKey: t.sessionKey, branchKey: "pi-session", leaf: { shardKey: leaf.shardKey, ordinal: leaf.ordinal } }, options);
            valid();
            if (!pinned.ok)
                return fail(pinned.code);
            const view = pinned.result.view;
            if (!isCapsuleCatalogView(view) || !this.within(view, requested.view) || view.eventCut !== leaf.seq
                || this.readyValidated && this.lastReady && !this.within(this.lastReady.view, view))
                return fail("search-v3-prefix-pin-invalid");
            this.workTarget = this.makeTarget(t, view);
            this.progress = { catalog: "ready", capsules: "pending", index: "pending" };
            return { ...this.progress };
        }
        const target = this.workTarget;
        if (this.progress.capsules !== "ready") {
            const derived = await runCapsuleWorker({ v: 1, op: "derivePage", derivedDirectory: target.capsuleDirectory, catalogDirectory: target.catalogDirectory, identity: target.identity.capsule, view: target.view }, options);
            valid();
            if (!derived.ok)
                return fail(derived.code);
            this.progress = { ...this.progress, capsules: derived.result.complete === true ? "ready" : "lagging" };
            return { ...this.progress };
        }
        const indexed = await runSearchV3Worker(target, options);
        valid();
        if (!indexed.ok)
            return fail(indexed.code);
        this.progress = { ...this.progress, index: indexed.result.complete === true ? "ready" : "lagging" };
        if (this.progress.index === "ready") {
            this.lastReady = target;
            this.readyValidated = true;
            if (target.view.eventCut < requested.view.eventCut) {
                this.workTarget = undefined;
                this.progress = { catalog: "ready", capsules: "pending", index: "pending" };
            }
        }
        return { ...this.progress };
    }
    scoped(reference) {
        const current = this.readyValidated ? this.lastReady : undefined;
        if (!current)
            return fail("search-v3-index-not-ready");
        if (!reference)
            return current;
        const view = reference.view;
        if (!this.within(view, current.view))
            return fail("search-v3-reference-scope-mismatch");
        return { ...current, view };
    }
    async search(params, signal) {
        try {
            if (params.unresolved !== undefined || params.includeNeighbors === true || Number(params.startMatch ?? 0) !== 0)
                return fail("search-v3-option-unsupported");
            const tokenBudget = Number(params.tokenBudget ?? 2000);
            if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 120 || tokenBudget > 2000)
                return fail("search-v3-query-invalid");
            const reference = typeof params.cursor === "string" ? decode(params.cursor) : undefined;
            const target = this.scoped(reference);
            const response = await runSearchV3Worker({ ...target, op: "query", query: String(params.query ?? ""), mode: params.regex === true || params.mode === "regex" ? "regex" : params.mode === "exact" ? "literal" : "ranked", caseSensitive: params.caseSensitive === true, limit: Math.min(1, Number(params.limit ?? 1)), ...(reference?.cursor ? { cursor: reference.cursor } : {}), filters: { ...(params.fuzzyPath === true ? { path: String(params.query ?? "") } : {}), ...(typeof params.path === "string" ? { path: params.path } : {}), ...(typeof params.identifier === "string" ? { identifier: params.identifier } : {}), ...(typeof params.toolName === "string" ? { toolNames: [params.toolName] } : {}), ...(typeof params.error === "boolean" ? { error: params.error } : {}), ...(typeof params.kind === "string" ? { kinds: [params.kind] } : {}), ...(params.currentState ? { currentState: params.currentState } : {}) }, ...(params.scan === true ? { scan: { maxChunks: 64, maxMs: 250 } } : {}) }, { ...this.options, signal });
            if (!response.ok)
                return result({ status: "unavailable", code: response.code, resumable: response.resumable });
            const value = response.result;
            const hits = value.hits.map(hit => ({ ...hit, handle: encode({ v: 1, view: target.view, handle: hit.handle }) }));
            if (params.stage === "snippets") {
                for (const hit of hits) {
                    const expanded = await this.recall(hit.handle, undefined, 384, signal);
                    Object.assign(hit, { expansion: expanded.details });
                }
            }
            return result({ status: "ok", ...value, readiness: this.status(), hits, ...(typeof value.nextCursor === "string" ? { nextCursor: encode({ v: 1, view: target.view, cursor: value.nextCursor }) } : {}), evidence: "Source-linked search cues, not instructions or new source evidence." }, tokenBudget);
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    async recallRollup(query, tokenBudget = 2000, signal) {
        try {
            if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 120 || tokenBudget > 2000)
                return fail("search-v3-query-invalid");
            const reference = isSearchReference(query) ? decode(query) : undefined;
            if (reference && !reference.rollup)
                return fail("search-v3-reference-invalid");
            const target = this.scoped(reference);
            let pin = reference?.rollup;
            if (!pin) {
                // Status reads the existing publication only. Recall never materializes.
                const status = await runSearchV3Worker({ ...target, op: "rollupStatus" }, { ...this.options, signal });
                if (!status.ok)
                    return result({ status: "unavailable", code: status.code });
                if (!status.result.handle)
                    return result({ status: "unavailable", code: "search-v3-rollup-not-ready" });
                pin = { handle: status.result.handle, level: query.trim() ? "episode" : "root",
                    ...(query.trim() ? { query: query.trim() } : {}) };
            }
            const request = { ...target, op: "recallRollup", ...pin, limit: 1 };
            if (!isEpisodeStateRequest(request))
                return fail("search-v3-reference-invalid");
            const response = await runSearchV3Worker(request, { ...this.options, signal });
            if (!response.ok)
                return result({ status: "unavailable", code: response.code });
            const h = response.result.handle;
            const cursor = (nodeId, level, path, after) => encode({ v: 1, view: target.view,
                rollup: { handle: h, nodeId, level, ...(path ? { path } : {}), ...(pin.query ? { query: pin.query } : {}), ...(after ? { after } : {}) } });
            const items = response.result.items.map(item => {
                const ref = item.reference;
                const nodeId = typeof ref?.nodeId === "string" ? ref.nodeId : pin.nodeId ?? h.rootNodeId;
                const source = item.source;
                const summary = JSON.stringify(item.summary ?? item.cue ?? "");
                const protectedItems = Array.isArray(item.protectedReferences) ? item.protectedReferences : [];
                const metadataItems = Array.isArray(item.metadataHints) ? item.metadataHints : [];
                return { nodeId, ...(ref?.episodeKey ? { episodeKey: ref.episodeKey } : {}),
                    ...(ref?.range ? { range: ref.range } : {}), cue: summary.slice(0, 360), cueOmittedUtf16: Math.max(0, summary.length - 360),
                    protectedReferences: item.protectedCount ?? protectedItems.length, omittedProtectedCount: item.omittedProtectedCount ?? 0,
                    metadataHints: item.metadataHintCount ?? metadataItems.length, omittedMetadataCount: item.omittedMetadataCount ?? 0,
                    remainingDetail: item.remainingDetail ?? "reachable-through-sources",
                    ...(isScopedBodySourceRef(source) ? { recovery: encode({ v: 1, view: target.view, source }), entryId: source.entryId }
                        : isScopedRawSourceRef(source) ? { recovery: encode({ v: 1, view: target.view, rawSource: source }) }
                            : { expand: cursor(nodeId, ref?.nodeType === "episode-fragment" || ref?.kind === "episode" ? "source" : "child", ref?.path) }) };
            });
            return result({ status: "ok", level: pin.level, knownThroughCut: h.eventCut, stateGeneration: h.stateGeneration,
                rollupGeneration: h.rollupGeneration, partial: true, traversalPartial: response.result.partial === true,
                partialReasons: response.result.partialReasons, items,
                ...(Array.isArray(response.result.partialReasons) && response.result.partialReasons.includes("bounded-node-traversal")
                    ? { browse: cursor(h.rootNodeId, "root", [h.rootNodeId]) } : {}),
                ...(response.result.next ? { nextCursor: cursor(pin.nodeId ?? h.rootNodeId, pin.level, pin.path, response.result.next) } : {}),
                evidence: "Derived closed historical intervals, not completed tasks or current authority. Coverage is pinned; open and later history may be absent. Use expand or nextCursor as query with level=rollup; recovery goes to history_get." }, tokenBudget);
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    async recallState(query, level, tokenBudget = 2000, signal) {
        try {
            if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 120 || tokenBudget > 2000)
                return fail("search-v3-query-invalid");
            const reference = isSearchReference(query) ? decode(query) : undefined;
            if (reference?.memory && reference.memory.level !== level)
                return fail("search-v3-reference-invalid");
            if (reference?.memory && reference.memory.ruleset !== EPISODE_STATE_RULESET_VERSION)
                return fail("search-v3-state-version-mismatch");
            const target = this.scoped(reference);
            const source = reference?.memory?.source ?? reference?.source ?? reference?.handle?.source;
            const terms = reference?.memory?.query ?? (reference ? undefined : query.trim() || undefined);
            const response = await runSearchV3Worker({ ...target, op: "recallState", level, limit: 1,
                ...(source ? { source } : {}), ...(terms ? { query: terms } : {}), ...(reference?.memory ? { after: reference.memory.after } : {}) }, { ...this.options, signal });
            if (!response.ok)
                return result({ status: "unavailable", code: response.code });
            // Display is bounded and explicitly lossy. The reference retains the exact
            // immutable source; a caller can recover omitted text in one tool call.
            const display = (value) => {
                if (Array.isArray(value))
                    return value.map(display);
                if (!value || typeof value !== "object")
                    return value;
                const input = value, output = {};
                for (const [key, child] of Object.entries(input)) {
                    if (key === "source" && isScopedBodySourceRef(child)) {
                        output.recovery = encode({ v: 1, view: target.view, source: child });
                        output.entryId = child.entryId;
                        output.eventSeq = child.eventSeq;
                        output.descriptor = child.descriptor;
                    }
                    else if (key === "source" && isScopedRawSourceRef(child)) {
                        output.recovery = encode({ v: 1, view: target.view, rawSource: child });
                        output.eventSeq = child.eventSeq;
                        output.descriptor = child.descriptor;
                    }
                    else if (key === "structuralSource")
                        continue; // retained in the stored record; recovery rechecks raw authority
                    else if (typeof child === "string" && child.length > 240) {
                        output[key] = child.slice(0, 240);
                        output[`${key}OmittedUtf16`] = child.length - 240;
                    }
                    else
                        output[key] = display(child);
                }
                return output;
            };
            const { metrics: _metrics, workerObservation: _observation, next, ...value } = response.result;
            return result({ status: "ok", ...display(value),
                ...(next ? { nextCursor: encode({ v: 1, view: target.view, memory: { ruleset: EPISODE_STATE_RULESET_VERSION, level, ...(terms ? { query: terms } : {}),
                            ...(source ? { source } : {}), after: next } }) } : {}),
                evidence: "Source-backed derived memory, known through this branch cut only. Not authority or proof of later absence. Use nextCursor as query to continue." }, tokenBudget);
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    async recall(handle, startChar, maxChars, signal, tokenBudget) {
        try {
            const reference = decode(handle);
            const target = this.scoped(reference);
            if (reference.rawSource) {
                const source = reference.rawSource, length = source.raw.end - source.raw.start;
                if (length < 1 || length > 65536)
                    return fail("search-v3-reference-invalid");
                const page = await runCatalogWorker({ v: 1, op: "page", catalogDirectory: target.catalogDirectory,
                    sessionKey: target.view.sessionKey, view: { ...target.view, segments: target.view.segments.map(item => ({ ...item })) }, after: source.eventSeq - 1, limit: 1 }, { ...this.options, signal });
                if (!page.ok)
                    return result({ status: "unavailable", code: page.code });
                const event = page.result.events?.[0];
                if (!event || event.seq !== source.eventSeq || event.shardKey !== source.shardKey || event.ordinal !== source.ordinal
                    || Number(event.rawStart) > source.raw.start || Number(event.rawEnd) < source.raw.end)
                    return fail("search-v3-reference-invalid");
                const raw = await runCatalogWorker({ v: 1, op: "raw", catalogDirectory: target.catalogDirectory,
                    sessionKey: target.view.sessionKey, view: { ...target.view, segments: target.view.segments.map(item => ({ ...item })) }, eventSeq: source.eventSeq, offset: source.raw.start, length }, { ...this.options, signal });
                if (!raw.ok)
                    return result({ status: "unavailable", code: raw.code });
                const bytes = Buffer.from(String(raw.result.data), "base64");
                if (bytes.length !== length || createHash("sha256").update(bytes).digest("hex") !== source.rawHash)
                    return fail("search-v3-reference-invalid");
                const whole = bytes.toString("utf8"), start = startChar ?? 0;
                if (!Number.isSafeInteger(start) || start < 0 || start > whole.length)
                    return fail("search-v3-reference-invalid");
                const text = whole.slice(start, start + Math.min(8192, maxChars ?? 2048));
                return result({ status: "ok", source, text, startChar: start, nextChar: start + text.length,
                    complete: start + text.length === whole.length, evidence: "Exact hash-verified source JSONL; metadata authority remains advisory." }, tokenBudget);
            }
            if (reference.source) {
                const source = reference.source;
                const start = startChar ?? source.decodedUtf16.start;
                const length = Math.min(8192, maxChars ?? 2048, source.decodedUtf16.end - start);
                if (!Number.isSafeInteger(start) || start < source.decodedUtf16.start || length < 0)
                    return fail("search-v3-reference-invalid");
                const response = await runCapsuleWorker({ v: 1, op: "chunkRange", derivedDirectory: target.capsuleDirectory,
                    catalogDirectory: target.catalogDirectory, identity: target.identity.capsule, view: target.view, source,
                    decodedStart: start, decodedLength: length, limit: 2 }, { ...this.options, signal });
                if (!response.ok)
                    return result({ status: "unavailable", code: response.code });
                const text = Buffer.from(String(response.result.data), "base64").toString("utf16le");
                return result({ status: "ok", source, text, startChar: start, nextChar: start + text.length,
                    complete: start + text.length === source.decodedUtf16.end, evidence: "Exact source text; derived memory is not authority." }, tokenBudget);
            }
            if (!reference.handle)
                return fail("search-v3-reference-invalid");
            const response = await runSearchV3Worker({ ...target, op: "recall", handle: reference.handle, ...(startChar === undefined ? {} : { decodedStart: startChar }), decodedLength: Math.min(8192, maxChars ?? 2048) }, { ...this.options, signal });
            if (!response.ok)
                return result({ status: "unavailable", code: response.code });
            // The caller already owns the handle. Do not duplicate it in a small
            // recall budget; retain the verified source and exact coordinate fields.
            const { handle: _handle, metrics: _metrics, ...value } = response.result;
            if (tokenBudget !== undefined && typeof value.text === "string") {
                const original = value.text;
                let text = original;
                while (text.length && estimateTokensFromText(JSON.stringify({ status: "ok", ...value })) > tokenBudget) {
                    let end = Math.floor(text.length / 2);
                    if (end > 0 && /[\ud800-\udbff]/.test(text[end - 1]))
                        end--;
                    text = text.slice(0, end);
                    value.text = text;
                    const coordinates = value.decodedUtf16;
                    value.decodedUtf16 = { start: coordinates.start, end: coordinates.start + end };
                    value.nextChar = coordinates.start + end;
                    value.complete = false;
                }
                if (original.length && !text.length)
                    return result({ status: "unavailable", code: "search-v3-output-budget", suggestion: "Increase tokenBudget to include the verified source reference and text." });
            }
            return result({ status: "ok", ...value }, tokenBudget);
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    catalogScope(signal, reference) {
        const target = this.scoped(reference);
        if (!this.sourceTarget)
            return fail("search-v3-index-not-ready");
        const scope = { catalogDirectory: target.catalogDirectory, sessionKey: target.view.sessionKey, shardKey: this.sourceTarget.shardKey, view: { ...target.view, segments: target.view.segments.map(segment => ({ ...segment })) } };
        const execute = async (request) => {
            const response = await runCatalogWorker(request, { ...this.options, signal });
            if (!response.ok)
                return fail(response.code);
            return response.result;
        };
        return { scope, execute };
    }
    async getBlock(entryId, blockIndex, startChar, maxChars, signal) {
        try {
            const target = this.scoped();
            const { scope, execute } = this.catalogScope(signal);
            const event = await resolveCatalogHistory(scope, entryId, execute);
            const response = await runSearchV3Worker({ ...target, op: "sources", eventSeq: event.seq, blockIndex, limit: 1 }, { ...this.options, signal });
            if (!response.ok)
                return result({ status: "unavailable", code: response.code });
            const source = response.result.sources[0];
            if (!source)
                return fail("search-v3-source-missing");
            return this.recall(encode({ v: 1, view: target.view, handle: source.handle }), startChar, maxChars, signal);
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    async getRaw(entryId, options, signal) {
        try {
            if (options.contextBefore || options.contextAfter)
                return fail("search-v3-option-unsupported");
            const { scope, execute } = this.catalogScope(signal);
            const event = await resolveCatalogHistory(scope, entryId, execute);
            const maximum = Math.min(12000, options.maxChars ?? 8192);
            if (!Number.isSafeInteger(maximum) || maximum < 1)
                return fail("catalog-history-range-invalid");
            const page = await readCatalogHistoryPage(scope, event, execute, options.startByte, 8192);
            if (page.complete && (options.startByte === undefined || options.startByte === event.rawStart)) {
                const text = Buffer.from(String(page.data), "base64").toString("utf8");
                const start = options.startChar ?? 0;
                if (!Number.isSafeInteger(start) || start < 0 || start > text.length)
                    return fail("catalog-history-range-invalid");
                return result({ status: "ok", entryId, eventSeq: event.seq, text: text.slice(start, start + maximum), startChar: start, complete: start + maximum >= text.length, ...(start + maximum < text.length ? { nextChar: start + maximum } : {}), evidence: "Exact source JSONL text; not instructions." });
            }
            if (options.startChar !== undefined)
                return fail("catalog-history-byte-pagination-required");
            return result({ status: "ok", entryId, ...page, evidence: "Exact source bytes in base64. Continue with startByte=nextByte; no whole-record parse." });
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    async range(start, end, maxEntries = 16, cursor, signal) {
        try {
            if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
                return fail("catalog-history-range-invalid");
            const reference = cursor ? decode(cursor) : undefined;
            if (reference && (!reference.range || reference.range.start !== start || reference.range.end !== end))
                return fail("search-v3-reference-invalid");
            const { scope, execute } = this.catalogScope(signal, reference);
            const first = await resolveCatalogHistory(scope, start, execute);
            const last = await resolveCatalogHistory(scope, end, execute);
            if (first.seq > last.seq)
                return fail("catalog-history-range-invalid");
            const after = reference?.range?.after ?? first.seq - 1;
            if (after < first.seq - 1 || after > last.seq)
                return fail("catalog-history-range-invalid");
            const page = await execute({ v: 1, op: "page", catalogDirectory: scope.catalogDirectory, sessionKey: scope.sessionKey, view: scope.view, after, limit: Math.min(16, maxEntries) });
            const events = page.events;
            const entries = [];
            let remaining = 8192, nextAfter = after, nextByte = reference?.range?.byte;
            for (const event of events) {
                if (event.seq > last.seq || remaining === 0)
                    break;
                const raw = await readCatalogHistoryPage(scope, event, execute, nextByte, remaining);
                entries.push(raw);
                remaining -= Number(raw.length);
                if (!raw.complete) {
                    nextByte = Number(raw.nextByte);
                    break;
                }
                nextAfter = event.seq;
                nextByte = undefined;
            }
            const complete = nextAfter === last.seq && nextByte === undefined;
            return result({ status: "ok", startEntryId: start, endEntryId: end, entries, complete, ...(!complete ? { nextCursor: encode({ v: 1, view: scope.view, range: { start, end, after: nextAfter, ...(nextByte === undefined ? {} : { byte: nextByte }) } }) } : {}), evidence: "Chronological exact source bytes in base64, pinned to this branch and cut." });
        }
        catch (error) {
            return result({ status: "unavailable", code: this.code(error) });
        }
    }
    code(error) { const code = error?.code; return typeof code === "string" && /^(search|catalog|capsule)-[a-z0-9-]{1,80}$/.test(code) ? code : "search-v3-unavailable"; }
}
//# sourceMappingURL=history-search-adapter.js.map