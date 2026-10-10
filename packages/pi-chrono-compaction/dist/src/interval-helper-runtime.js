import { createHash } from "node:crypto";
import { historyHelperDerivationIdentity, resolveHistoryHelperRole } from "./history-helper-config.js";
import { resolveHistoryHelperModel } from "./history-helper-model.js";
import { HistoryHelperService, historyHelperInputKey, HISTORY_HELPER_OUTPUT_TOKEN_RESERVATIONS } from "./history-helper.js";
import { IntervalPrefixPrecompute } from "./interval-precompute.js";
import { IntervalArchiveService, createPrivateIntervalArchiveStore } from "./interval-archive.js";
import { adaptIntervalHelperInput, selectIntervalEventCandidates } from "./interval-helper-adapter.js";
import { INTERVAL_READY_PREFIX_CANDIDATE_LIMIT } from "./interval-partition.js";
export const INTERVAL_HELPER_RUNTIME_POLICY = "chrono-finite-interval-helper-runtime-v1";
/** Internal finite admission, not persistent settings or an advertised quality level. */
export const INTERVAL_RESTART_HELPER_LIMITS = Object.freeze({
    concurrency: 2, queuedJobs: 8, cacheEntries: 16, cacheBytes: 8 * 1024 * 1024,
    sourceBytes: 4 * 1024 * 1024, parts: 512, callsPerJob: 64, callsTotal: 256,
    reservedInputTokensTotal: 2 * 1024 * 1024, reservedOutputTokensTotal: 131072,
    inputTokensPerCall: 48 * 1024, outputTokensPerCall: 512,
    outputTokensByRole: HISTORY_HELPER_OUTPUT_TOKEN_RESERVATIONS, outputBytesPerCall: 64 * 1024,
    artifactBytes: 2 * 1024 * 1024, requestBytesPerCall: 256 * 1024, framingTokens: 1024, timeoutMs: 60000,
});
export const INTERVAL_ARCHIVE_HELPER_LIMITS = Object.freeze({
    ...INTERVAL_RESTART_HELPER_LIMITS, concurrency: 1, queuedJobs: 2, cacheEntries: 4,
    cacheBytes: 8 * 1024 * 1024, callsTotal: 128, reservedInputTokensTotal: 1024 * 1024, reservedOutputTokensTotal: 65536,
});
const hash = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const errorCode = (error) => {
    const code = error && typeof error === "object" ? error.code : undefined;
    return typeof code === "string" && /^(?:interval-helper|chrono-history-helper)-[a-z-]{1,64}$/u.test(code) ? code : "helper-input-unavailable";
};
function validPartition(input) {
    const p = input.partition;
    if (![p.start, p.compressedStart, p.rawStart, p.endExclusive].every(Number.isSafeInteger)
        || p.start !== 0 || p.start > p.compressedStart || p.compressedStart > p.rawStart || p.rawStart > p.endExclusive
        || p.endExclusive !== input.snapshot.events.length)
        throw new Error("interval-helper-partition-invalid");
}
/** Owns finite helper lanes. No assembly method awaits a model or archive. */
export class IntervalHelperRuntime {
    options;
    restart;
    archiveLane;
    prefix;
    archive;
    states = { activePrefix: "absent", event: "absent", archive: "absent" };
    scope;
    admittedEventKeys = new Set();
    generation = 0;
    closed = false;
    constructor(options) {
        this.options = options;
        this.restart = new HistoryHelperService(options.restartLimits ?? INTERVAL_RESTART_HELPER_LIMITS, "restart");
        this.archiveLane = new HistoryHelperService(options.archiveLimits ?? INTERVAL_ARCHIVE_HELPER_LIMITS, "archive");
        this.prefix = new IntervalPrefixPrecompute(this.restart);
        if (options.archiveDirectory && options.archiveStore)
            throw new Error("interval-helper-archive-store-ambiguous");
        const store = options.archiveStore ?? (options.archiveDirectory ? createPrivateIntervalArchiveStore(options.archiveDirectory, 4 * 1024 * 1024) : undefined);
        this.archive = new IntervalArchiveService(this.archiveLane, store, 16);
    }
    model(ctx, role) {
        const config = this.options.getConfig(), selected = resolveHistoryHelperRole(config, role);
        if (!selected) {
            this.states[role] = "unselected";
            return undefined;
        }
        const resolution = (this.options.resolveModel ?? resolveHistoryHelperModel)(ctx, role, this.options.getConfig);
        if (resolution.status !== "ready") {
            this.states[role] = resolution.status;
            return undefined;
        }
        const model = resolution.model, identity = historyHelperDerivationIdentity(this.options.getConfig(), role);
        if (!identity || model.role !== role || model.selection.provider !== selected.provider || model.selection.model !== selected.model
            || !model.identity.startsWith(`${identity}:`)) {
            this.states[role] = "route-changed";
            return undefined;
        }
        return model;
    }
    prefixInput(input, model, compressedStart = input.partition.compressedStart) {
        return adaptIntervalHelperInput(input.snapshot, { role: "activePrefix", start: input.partition.start,
            endExclusive: compressedStart, modelIdentity: model.identity, disclosure: this.options.disclosure,
            sourceBytes: this.restart.limits.sourceBytes, parts: this.restart.limits.parts });
    }
    eventInputs(input, model) {
        const candidates = input.eventCandidates ?? selectIntervalEventCandidates(input.snapshot, input.partition.compressedStart, input.partition.rawStart);
        if (candidates.length > 256)
            throw new Error("interval-helper-event-selection-invalid");
        const groups = new Map();
        for (const candidate of candidates) {
            const group = groups.get(candidate.unitId) ?? [];
            group.push(candidate);
            groups.set(candidate.unitId, group);
        }
        if (groups.size > 4)
            throw new Error("interval-helper-event-selection-invalid");
        const inputs = [];
        for (const [id, selected] of groups) {
            const unit = input.snapshot.units.find(item => item.id === id && item.status === "complete"
                && item.start >= input.partition.compressedStart && item.end <= input.partition.rawStart);
            if (!unit)
                continue;
            try {
                const adapted = adaptIntervalHelperInput(input.snapshot, { role: "event", start: unit.start, endExclusive: unit.end,
                    modelIdentity: model.identity, candidates: selected, disclosure: this.options.disclosure,
                    sourceBytes: this.restart.limits.sourceBytes, parts: this.restart.limits.parts });
                if (adapted)
                    inputs.push(adapted);
            }
            catch (error) {
                this.states.event = errorCode(error);
            }
        }
        return inputs;
    }
    /** Schedule a closed A and selective B originals. Returning does not mean a helper finished. */
    prepare(input) {
        if (this.closed || input.signal?.aborted)
            return;
        try {
            validPartition(input);
        }
        catch (error) {
            this.states.activePrefix = errorCode(error);
            return;
        }
        const scope = hash([input.snapshot.source.logicalSessionId ?? input.snapshot.source.sessionId,
            input.snapshot.source.branchId ?? null, input.snapshot.origin, input.snapshot.events[0]?.source, input.snapshot.events[0]?.entryId]);
        if (this.scope !== undefined && this.scope !== scope)
            this.invalidate();
        this.scope = scope;
        const generation = ++this.generation;
        try {
            const model = this.model(input.ctx, "activePrefix");
            if (!model)
                this.prefix.pause();
            else {
                const adapted = this.prefixInput(input, model);
                if (!adapted) {
                    this.prefix.pause();
                    this.states.activePrefix = "empty";
                }
                else {
                    this.states.activePrefix = "pending";
                    const ticket = this.prefix.prepare(adapted, model, input.signal);
                    void ticket.settled.then(result => { if (!this.closed && this.generation === generation && this.prefix.status().key === ticket.key)
                        this.states.activePrefix = result.status; });
                }
            }
        }
        catch (error) {
            this.prefix.pause();
            this.states.activePrefix = errorCode(error);
        }
        try {
            const model = this.model(input.ctx, "event");
            if (model) {
                const adapted = this.eventInputs(input, model);
                if (!adapted.length)
                    this.states.event = "no-eligible-noisy-output";
                for (const item of adapted) {
                    this.states.event = "pending";
                    const key = historyHelperInputKey(item);
                    this.admittedEventKeys.delete(key);
                    this.admittedEventKeys.add(key);
                    while (this.admittedEventKeys.size > this.restart.limits.cacheEntries)
                        this.admittedEventKeys.delete(this.admittedEventKeys.values().next().value);
                    const ticket = this.restart.enqueue(item, model, { coalesceKey: hash([item.source.logicalSession, item.source.branch,
                            item.source.previousCommit, item.source.start, "event"]), signal: input.signal });
                    void ticket.settled.then(result => { if (!this.closed && this.generation === generation && this.scope === scope)
                        this.states.event = result.status; });
                }
            }
        }
        catch (error) {
            this.states.event = errorCode(error);
        }
    }
    /** Reproject current originals and current explicit routes synchronously. Never wait at assembly. */
    ready(input) {
        const events = [], activePrefixCandidates = [];
        let activePrefix;
        if (!this.closed && !input.signal?.aborted) {
            try {
                validPartition(input);
                const model = this.model(input.ctx, "activePrefix");
                if (model) {
                    for (const product of this.prefix.candidates().slice(-INTERVAL_READY_PREFIX_CANDIDATE_LIMIT))
                        try {
                            // H is anchored after the last original source, not to the old E or
                            // an old prompt index. Recreate bytes under today's permitted route.
                            let end;
                            try {
                                end = JSON.parse(product.input.source.endExclusive);
                            }
                            catch {
                                continue;
                            }
                            if (!Array.isArray(end) || end.length !== 3 || end[0] !== "after")
                                continue;
                            const last = input.snapshot.events.find(event => event.entryId === end[2]
                                && JSON.stringify(event.source) === JSON.stringify(end[1]));
                            if (!last || !input.snapshot.legalCuts.includes(last.index + 1))
                                continue;
                            const compressedStart = last.index + 1;
                            const adapted = this.prefixInput(input, model, compressedStart);
                            if (!adapted || historyHelperInputKey(adapted) !== product.artifact.key)
                                continue;
                            const candidate = Object.freeze({ compressedStart, input: adapted, artifact: product.artifact });
                            activePrefixCandidates.push(candidate);
                            if (compressedStart === input.partition.compressedStart)
                                activePrefix = Object.freeze({ input: adapted, artifact: product.artifact });
                        }
                        catch (error) {
                            this.states.activePrefix = errorCode(error);
                        }
                }
            }
            catch (error) {
                this.states.activePrefix = errorCode(error);
            }
            try {
                validPartition(input);
                const model = this.model(input.ctx, "event");
                if (model)
                    for (const adapted of this.eventInputs(input, model)) {
                        const artifact = this.admittedEventKeys.has(historyHelperInputKey(adapted)) && this.restart.ready(adapted);
                        if (artifact)
                            events.push(Object.freeze({ input: adapted, artifact }));
                    }
            }
            catch (error) {
                this.states.event = errorCode(error);
            }
        }
        return Object.freeze({ ...(activePrefix ? { activePrefix } : {}),
            activePrefixCandidates: Object.freeze(activePrefixCandidates), eventAlternatives: Object.freeze(events) });
    }
    /** Caller must supply proof of the correlated observed native commit, not a proposed replacement. */
    archiveVerified(input) {
        if (this.closed || input.signal?.aborted)
            return;
        if (input.verified !== true || !input.commitId) {
            this.states.archive = "commit-unverified";
            return;
        }
        try {
            const model = this.model(input.ctx, "archive");
            if (!model)
                return;
            const adapted = adaptIntervalHelperInput(input.snapshot, { role: "archive", start: 0, endExclusive: input.snapshot.events.length,
                modelIdentity: model.identity, disclosure: this.options.disclosure,
                sourceBytes: this.archiveLane.limits.sourceBytes, parts: this.archiveLane.limits.parts });
            if (!adapted) {
                this.states.archive = "empty";
                return;
            }
            this.states.archive = "pending";
            const ticket = this.archive.schedule({ verified: true, commitId: input.commitId, source: adapted.source }, adapted, model, input.signal);
            void ticket.settled.then(result => { this.states.archive = result.status; }).catch(() => { this.states.archive = "archive-unavailable"; });
        }
        catch (error) {
            this.states.archive = errorCode(error);
        }
    }
    /** Exact derived-store recovery. Does not select or call a model, or read another state owner. */
    async recoverArchive(input) {
        if (this.closed)
            return undefined;
        try {
            const adapted = adaptIntervalHelperInput(input.snapshot, { role: "archive", start: 0, endExclusive: input.snapshot.events.length,
                modelIdentity: "archive-recovery-source-binding-only", disclosure: this.options.disclosure,
                sourceBytes: this.archiveLane.limits.sourceBytes, parts: this.archiveLane.limits.parts });
            if (!adapted)
                return undefined;
            return await this.archive.recover({ verified: true, commitId: input.commitId, source: adapted.source });
        }
        catch {
            this.states.archive = "archive-recovery-unavailable";
            return undefined;
        }
    }
    status() {
        return Object.freeze({ policyIdentity: INTERVAL_HELPER_RUNTIME_POLICY, closed: this.closed,
            roles: Object.freeze({ ...this.states }), prefix: Object.freeze(this.prefix.status()),
            restart: Object.freeze(this.restart.status()), archiveLane: Object.freeze(this.archiveLane.status()), archive: Object.freeze(this.archive.status()),
            archivePersistence: !!(this.options.archiveDirectory || this.options.archiveStore) });
    }
    /** Cancel restart work and reject old ready products. Keep the same owned provider pools. */
    invalidate() {
        if (this.closed)
            return;
        this.generation++;
        this.scope = undefined;
        this.admittedEventKeys.clear();
        this.prefix.invalidate();
        this.restart.cancelAll();
        this.states.activePrefix = "invalidated";
        this.states.event = "invalidated";
    }
    /** Bounded cancellation request. Provider slots remain owned until their promises settle. */
    close() {
        if (this.closed)
            return;
        this.invalidate();
        this.closed = true;
        void this.restart.close().catch(() => undefined);
        void this.archiveLane.close().catch(() => undefined);
    }
}
export function createIntervalHelperRuntime(options) {
    return new IntervalHelperRuntime(options);
}
//# sourceMappingURL=interval-helper-runtime.js.map