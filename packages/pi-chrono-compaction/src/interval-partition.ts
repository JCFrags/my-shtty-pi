import { chargeRawTail } from "./context-budget.js";
import type { IntervalRenderUnit } from "./interval-render.js";

export interface IntervalPartitionUnit extends IntervalRenderUnit {
  /** Half-open gaps in the selected interval. Gaps must not be prompt indexes. */
  readonly start: number;
  readonly endExclusive: number;
  readonly complete: boolean;
  /** Assistant responses in this complete unit, not the number of tool results. */
  readonly assistantTurns: number;
}
export interface IntervalExactTurnCoverage {
  readonly metric: "assistant-responses";
  readonly target: number;
  readonly available: number;
  readonly retained: number;
  readonly shortfall: number;
  readonly shortfallReason: "none" | "source-exhausted" | "token-capacity" | "entry-capacity";
  readonly tokenTarget: number;
  readonly tokenMaximum: number;
}
export interface IntervalCutHint {
  readonly gap: number;
  readonly kind: "phase-transition" | "saved-position" | "wait" | "context";
  readonly sourceEntryId: string;
}
export interface IntervalPartition {
  readonly start: number;
  readonly compressedStart: number;
  readonly rawStart: number;
  readonly endExclusive: number;
  readonly prefixUnitCount: number;
  readonly compressedUnitCount: number;
  readonly exactUnitCount: number;
  readonly exactTokens: number;
  readonly exactMessages: number;
  readonly compressedReason: "empty" | "token-fit" | "ready-prefix" | IntervalCutHint["kind"];
  readonly exactReason: "empty" | "newest-complete-units" | "required-unit-expanded" | "recent-turns-expanded";
  /** Absent in preserved token-only receipts. Never infer old turn coverage. */
  readonly exactTurns?: IntervalExactTurnCoverage;
}

const hintWeight = { "phase-transition": 4, wait: 3, "saved-position": 2, context: 1 };
export const INTERVAL_READY_PREFIX_CANDIDATE_LIMIT = 16;
function recentWindowStart(units: readonly IntervalPartitionUnit[], rawUnitIndex: number, allowance: number): number {
  let index = rawUnitIndex, recentSourceTokens = 0;
  while (index > 0) {
    const unit = units[index - 1]!;
    if (unit.events.length > 256) break;
    const tokens = chargeRawTail(unit.events.map(event => event.projectedEntry)).tokens;
    if (recentSourceTokens + tokens > allowance && index < rawUnitIndex) break;
    if (tokens > allowance) break;
    recentSourceTokens += tokens; index--;
  }
  return index;
}
/** Rank only useful legal ready H cuts inside the same bounded recent window.
 * Source and derivation checks, rendered B usefulness and whole-request fitting
 * remain the compiler's responsibility. C is unchanged for every candidate. */
export function readyIntervalPartitions(input: {
  readonly partition: IntervalPartition;
  readonly units: readonly IntervalPartitionUnit[];
  readonly hints?: readonly IntervalCutHint[];
  readonly compressedHistoryTokens: number;
  readonly compressedStarts: readonly number[];
}): readonly IntervalPartition[] {
  const { partition, units } = input;
  if (!Number.isSafeInteger(input.compressedHistoryTokens) || input.compressedHistoryTokens < 0
    || input.compressedStarts.length > INTERVAL_READY_PREFIX_CANDIDATE_LIMIT) throw new Error("context-v4-interval-partition-budget-invalid");
  const rawUnitIndex = units.findIndex(unit => unit.start === partition.rawStart);
  if (rawUnitIndex < 1) return [];
  const earliest = units[recentWindowStart(units, rawUnitIndex, input.compressedHistoryTokens * 4)]?.start ?? partition.rawStart;
  const legal = new Map(units.map((unit, index) => [unit.start, index]));
  const weights = new Map<number, number>();
  for (const hint of input.hints ?? []) if (legal.has(hint.gap) && units.some(unit => unit.endExclusive === hint.gap
    && unit.events.some(event => event.entryId === hint.sourceEntryId))) weights.set(hint.gap, Math.max(weights.get(hint.gap) ?? 0, hintWeight[hint.kind]));
  return [...new Set(input.compressedStarts)].filter(gap => Number.isSafeInteger(gap) && gap > partition.start
    && gap >= earliest && gap <= partition.rawStart && (gap < partition.rawStart || partition.compressedUnitCount === 0) && legal.has(gap))
    .sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0)
      || Math.abs(a - partition.compressedStart) - Math.abs(b - partition.compressedStart) || a - b)
    .map(gap => ({ ...partition, compressedStart: gap, prefixUnitCount: legal.get(gap)!,
      compressedUnitCount: rawUnitIndex - legal.get(gap)!, compressedReason: "ready-prefix" as const }));
}

/** Select complete original interactions before rendering any lossy text. The
 * caller supplies source-bound gaps and model-derived allowances. This function
 * has no user timing knobs and cannot convert a timeout into a complete unit. */
export function selectIntervalPartition(input: {
  readonly units: readonly IntervalPartitionUnit[];
  readonly hints?: readonly IntervalCutHint[];
  readonly exactTailTokens: number;
  readonly exactTailMaximumTokens: number;
  readonly exactTailMinimumTurns: number;
  readonly compressedHistoryTokens: number;
}): IntervalPartition {
  const { units } = input;
  for (const value of [input.exactTailTokens, input.exactTailMaximumTokens, input.exactTailMinimumTurns, input.compressedHistoryTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("context-v4-interval-partition-budget-invalid");
  }
  if (input.exactTailTokens > input.exactTailMaximumTokens || units.length > 16_384) throw new Error("context-v4-interval-partition-budget-invalid");
  let end = 0;
  for (const unit of units) {
    if (!unit.complete) throw new Error("context-v4-interval-incomplete-interaction");
    if (!unit.events.length || unit.start !== end || !Number.isSafeInteger(unit.endExclusive) || unit.endExclusive <= unit.start
      || !Number.isSafeInteger(unit.assistantTurns) || unit.assistantTurns < 0 || unit.assistantTurns > unit.events.length) {
      throw new Error("context-v4-interval-unit-range-invalid");
    }
    end = unit.endExclusive;
  }
  const availableTurns = units.reduce((sum, unit) => sum + unit.assistantTurns, 0);
  const turnGoal = Math.min(input.exactTailMinimumTurns, availableTurns);
  const coverage = (retained: number, limit: IntervalExactTurnCoverage["shortfallReason"]): IntervalExactTurnCoverage => ({
    metric: "assistant-responses", target: input.exactTailMinimumTurns, available: availableTurns, retained,
    shortfall: Math.max(0, input.exactTailMinimumTurns - retained),
    shortfallReason: retained >= input.exactTailMinimumTurns ? "none" : retained >= turnGoal ? "source-exhausted" : limit,
    tokenTarget: input.exactTailTokens, tokenMaximum: input.exactTailMaximumTokens,
  });
  if (!units.length) return { start: 0, compressedStart: 0, rawStart: 0, endExclusive: 0,
    prefixUnitCount: 0, compressedUnitCount: 0, exactUnitCount: 0, exactTokens: 0, exactMessages: 0,
    compressedReason: "empty", exactReason: "empty", exactTurns: coverage(0, "source-exhausted") };
  let rawUnitIndex = units.length - 1;
  const charge = (from: number) => chargeRawTail(units.slice(from).flatMap(unit => unit.events.map(event => event.projectedEntry)));
  let exact = charge(rawUnitIndex), retainedTurns = units[rawUnitIndex]!.assistantTurns;
  let exactEntries = units[rawUnitIndex]!.events.length;
  let turnLimit: IntervalExactTurnCoverage["shortfallReason"] = "source-exhausted";
  if (exact.tokens > input.exactTailMaximumTokens) throw new Error("context-v4-interval-required-unit-oversized");
  while (rawUnitIndex > 0) {
    if (exact.tokens >= input.exactTailTokens && retainedTurns >= turnGoal) break;
    // Retain a contiguous suffix of complete units. The soft token target may
    // yield to recent turns, but neither hard capacity nor native bounds may.
    const older = units[rawUnitIndex - 1]!;
    const candidateEntries = exactEntries + older.events.length;
    if (candidateEntries > 256) { turnLimit = "entry-capacity"; break; }
    const candidate = charge(rawUnitIndex - 1);
    if (candidate.tokens > input.exactTailMaximumTokens) { turnLimit = "token-capacity"; break; }
    if (candidate.tokens > input.exactTailTokens && retainedTurns >= turnGoal) break;
    rawUnitIndex--; exact = candidate; exactEntries = candidateEntries; retainedTurns += older.assistantTurns;
  }
  const rawStart = units[rawUnitIndex]!.start;
  // Recent compressed history is bounded by original content, not elapsed time
  // or a fixed number of turns. The factor is a versioned selection heuristic,
  // not a claimed compression ratio or permission to exceed the output budget.
  const sourceAllowance = input.compressedHistoryTokens * 4;
  let compressedUnitIndex = recentWindowStart(units, rawUnitIndex, sourceAllowance);
  let compressedReason: IntervalPartition["compressedReason"] = rawUnitIndex === 0 ? "empty" : "token-fit";
  const earliest = units[compressedUnitIndex]?.start ?? rawStart;
  const legal = new Map(units.map((unit, index) => [unit.start, index]));
  const eligible = (input.hints ?? []).filter(hint => hint.gap >= earliest && hint.gap < rawStart
    && legal.has(hint.gap) && units.some(unit => unit.endExclusive === hint.gap && unit.events.some(event => event.entryId === hint.sourceEntryId)));
  eligible.sort((a, b) => hintWeight[b.kind] - hintWeight[a.kind] || a.gap - b.gap);
  if (eligible[0]) { compressedUnitIndex = legal.get(eligible[0].gap)!; compressedReason = eligible[0].kind; }
  const compressedStart = units[compressedUnitIndex]?.start ?? rawStart;
  if (compressedStart > rawStart || rawStart > end) throw new Error("context-v4-interval-partition-overlap");
  return { start: 0, compressedStart, rawStart, endExclusive: end,
    prefixUnitCount: compressedUnitIndex, compressedUnitCount: rawUnitIndex - compressedUnitIndex,
    exactUnitCount: units.length - rawUnitIndex, exactTokens: exact.tokens, exactMessages: exact.messages,
    compressedReason, exactReason: exact.tokens > input.exactTailTokens
      ? rawUnitIndex === units.length - 1 ? "required-unit-expanded" : "recent-turns-expanded" : "newest-complete-units",
    exactTurns: coverage(retainedTurns, turnLimit) };
}
