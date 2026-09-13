import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const QUALITY_EVENT = "pi-context:quality-v1";
export const MAX_CORRELATIONS = 64;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
type Operation = "agent" | "turn" | "tool" | "compaction";
type Outcome = "ended" | "succeeded" | "failed" | "aborted";
type UsageSource = "assistant" | "tool" | "compaction" | "branch_summary";
export type CompactionReason = "manual" | "threshold" | "overflow";
export type QualityObservation = {
  version: 1;
  kind: "retrieval" | "agent_outcome";
  outcome: "pass" | "fail" | "unknown";
  basis?: "self_report" | "source_known_case";
  issue?: "none" | "missing_evidence" | "stale_conclusion" | "unsupported_claim";
  expectedEvidence?: number;
  observedEvidence?: number;
};
type Quality = Required<Pick<QualityObservation, "version" | "kind" | "outcome" | "basis" | "issue">>
  & Pick<QualityObservation, "expectedEvidence" | "observedEvidence">;
type RecordValue = string | number | boolean;
export type TelemetryRecord = Record<string, RecordValue>;
type Pending = { at: number; ambiguous: boolean; reason?: CompactionReason; willRetry?: boolean };

export function add(a: number, b = 1): number { return Math.min(MAX_NUMBER, a + b); }
function integer(value: unknown, max = MAX_NUMBER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
export function parseQuality(value: unknown): Quality | undefined {
  try {
    if (!value || typeof value !== "object") return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const keys = Reflect.ownKeys(value);
    const allowed = ["version", "kind", "outcome", "basis", "issue", "expectedEvidence", "observedEvidence"];
    if (keys.length > allowed.length || keys.some(key => typeof key !== "string" || !allowed.includes(key))) return;
    if (keys.some(key => !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return;
    const version = own(value, "version"), kind = own(value, "kind"), outcome = own(value, "outcome");
    const rawBasis = own(value, "basis"), rawIssue = own(value, "issue");
    const basis = rawBasis === undefined ? "self_report" : rawBasis;
    const issue = rawIssue === undefined ? "none" : rawIssue;
    const expectedEvidence = own(value, "expectedEvidence"), observedEvidence = own(value, "observedEvidence");
    if (version !== 1 || !oneOf(kind, ["retrieval", "agent_outcome"]) || !oneOf(outcome, ["pass", "fail", "unknown"])) return;
    if (!oneOf(basis, ["self_report", "source_known_case"]) || !oneOf(issue, ["none", "missing_evidence", "stale_conclusion", "unsupported_claim"])) return;
    if (expectedEvidence !== undefined && !integer(expectedEvidence, 1_000_000)) return;
    if (observedEvidence !== undefined && !integer(observedEvidence, 1_000_000)) return;
    const observation: Quality = { version, kind, outcome, basis, issue };
    if (integer(expectedEvidence, 1_000_000)) observation.expectedEvidence = expectedEvidence;
    if (integer(observedEvidence, 1_000_000)) observation.observedEvidence = observedEvidence;
    return observation;
  } catch { return; }
}
function operationStats() {
  return { started: 0, ended: 0, succeeded: 0, failed: 0, aborted: 0, abandoned: 0, unpaired: 0, totalMs: 0, maxMs: 0 };
}
function usageStats() { return { samples: 0, missingOrInvalid: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }; }
function qualityStats() {
  return { observations: 0, pass: 0, fail: 0, unknown: 0, missing_evidence: 0, stale_conclusion: 0, unsupported_claim: 0,
    expectedEvidence: 0, observedEvidence: 0 };
}

/** Only constructed after session_start. Raw correlation keys stay in bounded transient maps. */
export class Meter {
  readonly run = randomUUID();
  readonly runtime = {
    agent: operationStats(), turn: operationStats(), tool: operationStats(), compaction: operationStats(),
    usage: { assistant: usageStats(), tool: usageStats(), compaction: usageStats(), branch_summary: usageStats() },
    process: { samples: 0, rssBytes: 0, heapUsedBytes: 0 },
    settled: 0, boundaries: 0, correlationDrops: 0, observationErrors: 0,
  };
  readonly quality = {
    rejected: 0,
    self_report: { retrieval: qualityStats(), agent_outcome: qualityStats() },
    source_known_case: { retrieval: qualityStats(), agent_outcome: qualityStats() },
  };
  private pending: Record<Operation, Map<string, Pending>> = {
    agent: new Map(), turn: new Map(), tool: new Map(), compaction: new Map(),
  };
  private sequence = 0;
  private began: number;
  private sink: (record: TelemetryRecord) => void;
  private now: () => number;

  constructor(sink: (record: TelemetryRecord) => void, now = () => performance.now()) {
    this.sink = sink;
    this.now = now;
    this.began = now();
    this.record("runtime", { event: "session_start" });
  }
  private elapsed(at: number): number { return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(this.now() - at))); }
  private record(channel: "runtime" | "quality", fields: TelemetryRecord): void {
    this.sequence = add(this.sequence);
    this.sink({ version: 1, channel, run: this.run, sequence: this.sequence, elapsedMs: this.elapsed(this.began), ...fields });
  }
  begin(operation: Operation, key: string, reason?: CompactionReason, willRetry?: boolean): void {
    if (operation === "compaction" && (!oneOf(reason, ["manual", "threshold", "overflow"]) || typeof willRetry !== "boolean")) {
      this.runtime.observationErrors = add(this.runtime.observationErrors); return;
    }
    const stats = this.runtime[operation], pending = this.pending[operation];
    stats.started = add(stats.started);
    if (!key || key.length > 256 || (!pending.has(key) && pending.size >= MAX_CORRELATIONS)) {
      this.runtime.correlationDrops = add(this.runtime.correlationDrops);
      return;
    }
    const ambiguous = pending.has(key);
    if (ambiguous) stats.abandoned = add(stats.abandoned);
    pending.set(key, { at: this.now(), ambiguous, reason, willRetry });
    this.record("runtime", { event: operation, outcome: "started", ...(reason ? { reason, willRetry: !!willRetry } : {}) });
  }
  finish(operation: Operation, key: string, outcome: Outcome, reason?: CompactionReason, willRetry?: boolean): boolean {
    const stats = this.runtime[operation], pending = this.pending[operation];
    const started = pending.get(key);
    if (!started || started.ambiguous || started.reason !== reason || started.willRetry !== willRetry) {
      stats.unpaired = add(stats.unpaired);
      if (started) { stats.abandoned = add(stats.abandoned); pending.delete(key); }
      this.record("runtime", { event: operation, outcome: "unpaired" });
      return false;
    }
    pending.delete(key);
    const durationMs = this.elapsed(started.at);
    stats[outcome] = add(stats[outcome]);
    stats.totalMs = add(stats.totalMs, durationMs);
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    this.record("runtime", { event: operation, outcome, durationMs, ...(reason ? { reason, willRetry: !!willRetry } : {}) });
    return true;
  }
  abandon(operation: Operation): void {
    const count = this.pending[operation].size;
    this.runtime[operation].abandoned = add(this.runtime[operation].abandoned, count);
    this.pending[operation].clear();
    if (count) this.record("runtime", { event: operation, outcome: "abandoned", count });
  }
  boundary(): void {
    for (const operation of ["agent", "turn", "tool", "compaction"] as const) this.abandon(operation);
    this.runtime.boundaries = add(this.runtime.boundaries);
    this.record("runtime", { event: "session_boundary" });
  }
  settled(): void {
    this.runtime.settled = add(this.runtime.settled);
    this.record("runtime", { event: "agent_settled" });
  }
  usage(source: UsageSource, value: unknown): void {
    const stats = this.runtime.usage[source];
    const tokens: Record<string, number> = {};
    for (const field of TOKEN_FIELDS) {
      const amount = own(value, field);
      if (!integer(amount, 1_000_000_000)) { stats.missingOrInvalid = add(stats.missingOrInvalid); return; }
      tokens[field] = amount;
    }
    stats.samples = add(stats.samples);
    for (const field of TOKEN_FIELDS) stats[field] = add(stats[field], tokens[field]);
    this.record("runtime", { event: "usage", source, ...tokens });
  }
  sample(rss: number, heapUsed: number): void {
    if (!integer(rss) || !integer(heapUsed)) return;
    const stats = this.runtime.process;
    stats.samples = add(stats.samples);
    stats.rssBytes = rss;
    stats.heapUsedBytes = heapUsed;
    this.record("runtime", { event: "process_memory", rssBytes: rss, heapUsedBytes: heapUsed });
  }
  observe(value: unknown): void {
    const observation = parseQuality(value);
    if (!observation) { this.quality.rejected = add(this.quality.rejected); return; }
    const stats = this.quality[observation.basis][observation.kind];
    stats.observations = add(stats.observations);
    stats[observation.outcome] = add(stats[observation.outcome]);
    if (observation.issue !== "none") stats[observation.issue] = add(stats[observation.issue]);
    stats.expectedEvidence = add(stats.expectedEvidence, observation.expectedEvidence ?? 0);
    stats.observedEvidence = add(stats.observedEvidence, observation.observedEvidence ?? 0);
    this.record("quality", observation);
  }
  snapshot() {
    const observations = [this.quality.self_report, this.quality.source_known_case]
      .reduce((sum, basis) => sum + basis.retrieval.observations + basis.agent_outcome.observations, 0);
    return structuredClone({
      version: 1, run: this.run, runtime: this.runtime,
      quality: { state: observations ? "observed_not_verified" : "unknown", ...this.quality },
    });
  }
}
