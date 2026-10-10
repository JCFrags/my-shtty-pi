import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { historyHelperDerivationIdentity, resolveHistoryHelperRole, type HistoryHelperRole } from "./history-helper-config.js";
import { resolveHistoryHelperModel, type HistoryHelperModelResolution } from "./history-helper-model.js";
import { HistoryHelperService, historyHelperInputKey, type HistoryHelperInput, type HistoryHelperLimits, type HistoryHelperModel } from "./history-helper.js";
import { IntervalPrefixPrecompute } from "./interval-precompute.js";
import { IntervalArchiveService, createPrivateIntervalArchiveStore, type IntervalArchiveStore, type IntervalArchiveRecord } from "./interval-archive.js";
import { adaptIntervalHelperInput, selectIntervalEventCandidates, type IntervalEventCandidate, type IntervalHelperDisclosure,
  type IntervalReadyProduct } from "./interval-helper-adapter.js";
import type { IntervalPartition } from "./interval-partition.js";
import type { IntervalSourceSnapshot } from "./interval-source.js";

export const INTERVAL_HELPER_RUNTIME_POLICY = "chrono-finite-interval-helper-runtime-v1";
/** Internal finite admission, not persistent settings or an advertised quality level. */
export const INTERVAL_RESTART_HELPER_LIMITS: HistoryHelperLimits = Object.freeze({
  concurrency: 2, queuedJobs: 8, cacheEntries: 16, cacheBytes: 8 * 1024 * 1024,
  sourceBytes: 4 * 1024 * 1024, parts: 512, callsPerJob: 64, callsTotal: 256,
  reservedInputTokensTotal: 2 * 1024 * 1024, reservedOutputTokensTotal: 131072,
  inputTokensPerCall: 48 * 1024, outputTokensPerCall: 512, outputBytesPerCall: 64 * 1024,
  artifactBytes: 2 * 1024 * 1024, requestBytesPerCall: 256 * 1024, framingTokens: 1024, timeoutMs: 60000,
});
export const INTERVAL_ARCHIVE_HELPER_LIMITS: HistoryHelperLimits = Object.freeze({
  ...INTERVAL_RESTART_HELPER_LIMITS, concurrency: 1, queuedJobs: 2, cacheEntries: 4,
  cacheBytes: 8 * 1024 * 1024, callsTotal: 128, reservedInputTokensTotal: 1024 * 1024, reservedOutputTokensTotal: 65536,
});
type RegistryContext = Pick<ExtensionContext, "modelRegistry">;
export interface IntervalHelperPreparation {
  readonly snapshot: IntervalSourceSnapshot;
  readonly partition: Pick<IntervalPartition, "start" | "compressedStart" | "rawStart" | "endExclusive">;
  readonly ctx: RegistryContext;
  readonly eventCandidates?: readonly IntervalEventCandidate[];
  readonly signal?: AbortSignal;
}
export interface IntervalHelperReadyHistory {
  readonly activePrefix?: IntervalReadyProduct;
  readonly eventAlternatives: readonly IntervalReadyProduct[];
}
export interface IntervalHelperRuntimeOptions {
  /** HistoryHelperConfig only, not UserConfig or main-model settings. Read live consent. */
  readonly getConfig: () => unknown;
  readonly archiveDirectory?: string;
  readonly archiveStore?: IntervalArchiveStore;
  readonly disclosure?: IntervalHelperDisclosure;
  /** Inject for a bounded offline exercise. Production defaults to the exact selected registry route. */
  readonly resolveModel?: (ctx: RegistryContext, role: HistoryHelperRole, getConfig: () => unknown) => HistoryHelperModelResolution;
  readonly restartLimits?: HistoryHelperLimits;
  readonly archiveLimits?: HistoryHelperLimits;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const errorCode = (error: unknown): string => {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(?:interval-helper|chrono-history-helper)-[a-z-]{1,64}$/u.test(code) ? code : "helper-input-unavailable";
};
function validPartition(input: IntervalHelperPreparation): void {
  const p = input.partition;
  if (![p.start, p.compressedStart, p.rawStart, p.endExclusive].every(Number.isSafeInteger)
    || p.start !== 0 || p.start > p.compressedStart || p.compressedStart > p.rawStart || p.rawStart > p.endExclusive
    || p.endExclusive !== input.snapshot.events.length) throw new Error("interval-helper-partition-invalid");
}

/** Owns finite helper lanes. No assembly method awaits a model or archive. */
export class IntervalHelperRuntime {
  private readonly restart: HistoryHelperService;
  private readonly archiveLane: HistoryHelperService;
  private readonly prefix: IntervalPrefixPrecompute;
  private readonly archive: IntervalArchiveService;
  private readonly states: Record<HistoryHelperRole, string> = { activePrefix: "absent", event: "absent", archive: "absent" };
  private scope: string | undefined;
  private readonly admittedKeys = new Set<string>();
  private generation = 0;
  private closed = false;
  constructor(private readonly options: IntervalHelperRuntimeOptions) {
    this.restart = new HistoryHelperService(options.restartLimits ?? INTERVAL_RESTART_HELPER_LIMITS, "restart");
    this.archiveLane = new HistoryHelperService(options.archiveLimits ?? INTERVAL_ARCHIVE_HELPER_LIMITS, "archive");
    this.prefix = new IntervalPrefixPrecompute(this.restart);
    if (options.archiveDirectory && options.archiveStore) throw new Error("interval-helper-archive-store-ambiguous");
    const store = options.archiveStore ?? (options.archiveDirectory ? createPrivateIntervalArchiveStore(options.archiveDirectory, 4 * 1024 * 1024) : undefined);
    this.archive = new IntervalArchiveService(this.archiveLane, store, 16);
  }
  private model(ctx: RegistryContext, role: HistoryHelperRole): HistoryHelperModel | undefined {
    const config = this.options.getConfig(), selected = resolveHistoryHelperRole(config, role);
    if (!selected) { this.states[role] = "unselected"; return undefined; }
    const resolution = (this.options.resolveModel ?? resolveHistoryHelperModel)(ctx, role, this.options.getConfig);
    if (resolution.status !== "ready") { this.states[role] = resolution.status; return undefined; }
    const model = resolution.model, identity = historyHelperDerivationIdentity(this.options.getConfig(), role);
    if (!identity || model.role !== role || model.selection.provider !== selected.provider || model.selection.model !== selected.model
      || !model.identity.startsWith(`${identity}:`)) { this.states[role] = "route-changed"; return undefined; }
    return model;
  }
  private prefixInput(input: IntervalHelperPreparation, model: HistoryHelperModel): HistoryHelperInput | undefined {
    return adaptIntervalHelperInput(input.snapshot, { role: "activePrefix", start: input.partition.start,
      endExclusive: input.partition.compressedStart, modelIdentity: model.identity, disclosure: this.options.disclosure,
      sourceBytes: this.restart.limits.sourceBytes, parts: this.restart.limits.parts });
  }
  private eventInputs(input: IntervalHelperPreparation, model: HistoryHelperModel): readonly HistoryHelperInput[] {
    const candidates = input.eventCandidates ?? selectIntervalEventCandidates(input.snapshot, input.partition.compressedStart, input.partition.rawStart);
    if (candidates.length > 256) throw new Error("interval-helper-event-selection-invalid");
    const groups = new Map<string, IntervalEventCandidate[]>();
    for (const candidate of candidates) {
      const group = groups.get(candidate.unitId) ?? []; group.push(candidate); groups.set(candidate.unitId, group);
    }
    if (groups.size > 4) throw new Error("interval-helper-event-selection-invalid");
    const inputs: HistoryHelperInput[] = [];
    for (const [id, selected] of groups) {
      const unit = input.snapshot.units.find(item => item.id === id && item.status === "complete"
        && item.start >= input.partition.compressedStart && item.end <= input.partition.rawStart);
      if (!unit) continue;
      try {
        const adapted = adaptIntervalHelperInput(input.snapshot, { role: "event", start: unit.start, endExclusive: unit.end,
          modelIdentity: model.identity, candidates: selected, disclosure: this.options.disclosure,
          sourceBytes: this.restart.limits.sourceBytes, parts: this.restart.limits.parts });
        if (adapted) inputs.push(adapted);
      } catch (error) { this.states.event = errorCode(error); }
    }
    return inputs;
  }
  /** Schedule a closed A and selective B originals. Returning does not mean a helper finished. */
  prepare(input: IntervalHelperPreparation): void {
    if (this.closed || input.signal?.aborted) return;
    try { validPartition(input); } catch (error) { this.states.activePrefix = errorCode(error); return; }
    const scope = hash([input.snapshot.source.logicalSessionId ?? input.snapshot.source.sessionId,
      input.snapshot.source.branchId ?? null, input.snapshot.origin, input.snapshot.events[0]?.source, input.snapshot.events[0]?.entryId]);
    if (this.scope !== undefined && this.scope !== scope) this.invalidate();
    this.scope = scope;
    this.admittedKeys.clear();
    const generation = ++this.generation;
    try {
      const model = this.model(input.ctx, "activePrefix");
      if (!model) this.prefix.invalidate();
      else {
        const adapted = this.prefixInput(input, model);
        if (!adapted) { this.prefix.invalidate(); this.states.activePrefix = "empty"; }
        else {
          this.states.activePrefix = "pending";
          this.admittedKeys.add(historyHelperInputKey(adapted));
          const ticket = this.prefix.prepare(adapted, model, input.signal);
          void ticket.settled.then(result => { if (!this.closed && this.generation === generation && this.prefix.status().key === ticket.key) this.states.activePrefix = result.status; });
        }
      }
    } catch (error) { this.prefix.invalidate(); this.states.activePrefix = errorCode(error); }
    try {
      const model = this.model(input.ctx, "event");
      if (model) {
        const adapted = this.eventInputs(input, model);
        if (!adapted.length) this.states.event = "no-eligible-noisy-output";
        for (const item of adapted) {
          this.states.event = "pending";
          this.admittedKeys.add(historyHelperInputKey(item));
          const ticket = this.restart.enqueue(item, model, { coalesceKey: hash([item.source.logicalSession, item.source.branch,
            item.source.previousCommit, item.source.start, "event"]), signal: input.signal });
          void ticket.settled.then(result => { if (!this.closed && this.generation === generation && this.scope === scope) this.states.event = result.status; });
        }
      }
    } catch (error) { this.states.event = errorCode(error); }
  }
  /** Reproject current originals and current explicit routes synchronously. Never wait at assembly. */
  ready(input: IntervalHelperPreparation): IntervalHelperReadyHistory {
    const events: IntervalReadyProduct[] = [];
    let activePrefix: IntervalReadyProduct | undefined;
    if (!this.closed && !input.signal?.aborted) {
      try {
        validPartition(input);
        const model = this.model(input.ctx, "activePrefix"), adapted = model && this.prefixInput(input, model);
        const artifact = adapted && this.admittedKeys.has(historyHelperInputKey(adapted)) && this.prefix.ready(adapted);
        if (adapted && artifact) activePrefix = Object.freeze({ input: adapted, artifact });
      } catch (error) { this.states.activePrefix = errorCode(error); }
      try {
        validPartition(input);
        const model = this.model(input.ctx, "event");
        if (model) for (const adapted of this.eventInputs(input, model)) {
          const artifact = this.admittedKeys.has(historyHelperInputKey(adapted)) && this.restart.ready(adapted);
          if (artifact) events.push(Object.freeze({ input: adapted, artifact }));
        }
      } catch (error) { this.states.event = errorCode(error); }
    }
    return Object.freeze({ ...(activePrefix ? { activePrefix } : {}), eventAlternatives: Object.freeze(events) });
  }
  /** Caller must supply proof of the correlated observed native commit, not a proposed replacement. */
  archiveVerified(input: { readonly snapshot: IntervalSourceSnapshot; readonly commitId: string; readonly verified: true;
    readonly ctx: RegistryContext; readonly signal?: AbortSignal }): void {
    if (this.closed || input.signal?.aborted) return;
    if (input.verified !== true || !input.commitId) { this.states.archive = "commit-unverified"; return; }
    try {
      const model = this.model(input.ctx, "archive"); if (!model) return;
      const adapted = adaptIntervalHelperInput(input.snapshot, { role: "archive", start: 0, endExclusive: input.snapshot.events.length,
        modelIdentity: model.identity, disclosure: this.options.disclosure,
        sourceBytes: this.archiveLane.limits.sourceBytes, parts: this.archiveLane.limits.parts });
      if (!adapted) { this.states.archive = "empty"; return; }
      this.states.archive = "pending";
      const ticket = this.archive.schedule({ verified: true, commitId: input.commitId, source: adapted.source }, adapted, model, input.signal);
      void ticket.settled.then(result => { this.states.archive = result.status; }).catch(() => { this.states.archive = "archive-unavailable"; });
    } catch (error) { this.states.archive = errorCode(error); }
  }
  /** Exact derived-store recovery. Does not select or call a model, or read another state owner. */
  async recoverArchive(input: { readonly snapshot: IntervalSourceSnapshot; readonly commitId: string }): Promise<IntervalArchiveRecord | undefined> {
    if (this.closed) return undefined;
    try {
      const adapted = adaptIntervalHelperInput(input.snapshot, { role: "archive", start: 0, endExclusive: input.snapshot.events.length,
        modelIdentity: "archive-recovery-source-binding-only", disclosure: this.options.disclosure,
        sourceBytes: this.archiveLane.limits.sourceBytes, parts: this.archiveLane.limits.parts });
      if (!adapted) return undefined;
      return await this.archive.recover({ verified: true, commitId: input.commitId, source: adapted.source });
    } catch { this.states.archive = "archive-recovery-unavailable"; return undefined; }
  }
  status() {
    return Object.freeze({ policyIdentity: INTERVAL_HELPER_RUNTIME_POLICY, closed: this.closed,
      roles: Object.freeze({ ...this.states }), prefix: Object.freeze(this.prefix.status()),
      restart: Object.freeze(this.restart.status()), archiveLane: Object.freeze(this.archiveLane.status()), archive: Object.freeze(this.archive.status()),
      archivePersistence: !!(this.options.archiveDirectory || this.options.archiveStore) });
  }
  /** Cancel restart work and reject old ready products. Keep the same owned provider pools. */
  invalidate(): void {
    if (this.closed) return;
    this.generation++; this.scope = undefined; this.admittedKeys.clear();
    this.prefix.invalidate(); this.restart.cancelAll();
    this.states.activePrefix = "invalidated"; this.states.event = "invalidated";
  }
  /** Bounded cancellation request. Provider slots remain owned until their promises settle. */
  close(): void {
    if (this.closed) return;
    this.invalidate(); this.closed = true;
    void this.restart.close().catch(() => undefined);
    void this.archiveLane.close().catch(() => undefined);
  }
}
export function createIntervalHelperRuntime(options: IntervalHelperRuntimeOptions): IntervalHelperRuntime {
  return new IntervalHelperRuntime(options);
}
