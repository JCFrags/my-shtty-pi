import type { CandidateUnit, HistoricalBlock, RepresentationCandidate, SourceRef } from "./types.js";
import { estimateTokensFromText, truncateToTokens, unique } from "./utils.js";

export type RetentionBand = "hot" | "warm" | "cold";

export interface RetentionPolicy {
  readonly hotSourceTokens: number;
  readonly warmSourceTokens: number;
  readonly coldCueTokens: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  hotSourceTokens: 10_000,
  warmSourceTokens: 75_000,
  coldCueTokens: 56,
});

export interface RetentionAssignment {
  readonly blockId: string;
  readonly band: RetentionBand;
  readonly sourceTokensFromNewest: number;
  readonly value: number;
  readonly reasons: readonly string[];
  readonly ageOverridden: boolean;
}

function valueFor(block: HistoricalBlock, reuseCount: number, novelty: number): { value: number; reasons: string[] } {
  let value = 25;
  const reasons: string[] = [];
  if (block.protectedExact) {
    value += 1_000;
    reasons.push("protected authority or exact evidence");
  }
  if (block.unresolved) {
    value += 500;
    reasons.push("unresolved work");
  }
  if (block.isError) {
    value += 180;
    reasons.push("failure evidence");
  }
  if (block.kind === "user" || block.kind === "custom_message") {
    value += 150;
    reasons.push("direct request or control message");
  }
  if (block.kind === "assistant_text" && block.attributes.phase === "final") {
    value += 90;
    reasons.push("assistant outcome");
  }
  if (block.exactIdentifiers.length > 0) {
    value += Math.min(60, block.exactIdentifiers.length * 4);
    reasons.push("exact identifiers");
  }
  if (reuseCount > 0) {
    value += Math.min(120, reuseCount * 20);
    reasons.push(`reused ${reuseCount} time(s)`);
  }
  value += Math.round(Math.max(0, Math.min(1, novelty)) * 60);
  if (novelty >= 0.75) reasons.push("high novelty");
  if (block.reproducible && !block.isError) {
    value -= 35;
    reasons.push("reproducible routine output");
  }
  return { value: Math.max(1, value), reasons };
}

export function assignRetentionGradient(
  blocks: readonly HistoricalBlock[],
  options: Partial<RetentionPolicy> & {
    readonly reuseByBlockId?: ReadonlyMap<string, number>;
    readonly noveltyByBlockId?: ReadonlyMap<string, number>;
  } = {},
): ReadonlyMap<string, RetentionAssignment> {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...options };
  const assignments = new Map<string, RetentionAssignment>();
  let sourceTokensFromNewest = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    sourceTokensFromNewest += block.rawTokens;
    const ageBand: RetentionBand = sourceTokensFromNewest <= policy.hotSourceTokens
      ? "hot"
      : sourceTokensFromNewest <= policy.hotSourceTokens + policy.warmSourceTokens
        ? "warm"
        : "cold";
    const score = valueFor(
      block,
      options.reuseByBlockId?.get(block.id) ?? 0,
      options.noveltyByBlockId?.get(block.id) ?? 0.5,
    );
    const override = block.protectedExact || block.unresolved;
    const band: RetentionBand = override && ageBand === "cold" ? "warm" : ageBand;
    assignments.set(block.id, {
      blockId: block.id,
      band,
      sourceTokensFromNewest,
      value: score.value,
      reasons: score.reasons,
      ageOverridden: band !== ageBand,
    });
  }
  return assignments;
}

function sourceRefText(ref: SourceRef | undefined): string {
  if (!ref) return "unknown source";
  return ref.blockIndex === undefined ? ref.entryId : `${ref.entryId} block ${ref.blockIndex}`;
}

function coldCue(unit: CandidateUnit, block: HistoricalBlock, policy: RetentionPolicy): RepresentationCandidate {
  const normalized = block.exactText.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/(?<=[.!?])\s+|\n/).find(Boolean) ?? `${block.label} event`;
  const outcome = block.isError ? "Failure" : block.unresolved ? "Unresolved" : "Historical";
  const text = truncateToTokens(
    `${outcome} ${block.label.toLowerCase()}: ${firstSentence}\nExact source: ${sourceRefText(unit.sourceRefs[0])}`,
    policy.coldCueTokens,
    "…",
  );
  return {
    id: `${unit.id}:marker:cold-cue`,
    level: "marker",
    text,
    tokens: estimateTokensFromText(text),
    rawTokens: unit.rawTokens,
    utility: block.isError || block.unresolved ? 0.78 : 0.38,
    lossy: true,
    reducer: "cold-cue",
    reducerVersion: "2.0.0",
    omissions: [{
      description: "Cold routine history reduced to a one-to-two-line cue; exact source remains recoverable",
      omittedLines: Math.max(0, block.exactText.split("\n").length - 2),
      omittedBytes: Math.max(0, Buffer.byteLength(block.exactText) - Buffer.byteLength(text)),
    }],
    sourceRefs: unit.sourceRefs,
    metadata: { retentionBand: "cold" },
  };
}

function isAggressivelyLossy(candidate: RepresentationCandidate): boolean {
  return candidate.level === "marker" || candidate.level === "absent" || candidate.level === "merged";
}

/**
 * Apply age as candidate eligibility. Hot history keeps raw or lossless text,
 * except that known structured tool reducers can still remove representation
 * waste. Cold history gets a bounded cue. Protected and unresolved content
 * never receives the generic cold cue.
 */
export function applyRetentionGradient(
  units: readonly CandidateUnit[],
  blocks: readonly HistoricalBlock[],
  options: Partial<RetentionPolicy> & {
    readonly reuseByBlockId?: ReadonlyMap<string, number>;
    readonly noveltyByBlockId?: ReadonlyMap<string, number>;
  } = {},
): { readonly units: readonly CandidateUnit[]; readonly assignments: ReadonlyMap<string, RetentionAssignment> } {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...options };
  const assignments = assignRetentionGradient(blocks, policy);
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const output = units.map((unit) => {
    const block = blocksById.get(unit.id);
    const assignment = assignments.get(unit.id);
    if (!block || !assignment) return unit;
    let candidates = [...unit.candidates];
    if (assignment.band === "hot" && !block.reproducible) {
      candidates = candidates.filter((candidate) => !isAggressivelyLossy(candidate));
    }
    if (assignment.band === "cold" && !block.protectedExact && !block.unresolved) {
      candidates.push(coldCue(unit, block, policy));
    }
    return {
      ...unit,
      importance: unit.importance + Math.min(220, assignment.value * (assignment.band === "hot" ? 0.24 : 0.1)),
      importanceReasons: unique([
        ...unit.importanceReasons,
        `retention band ${assignment.band} at ${assignment.sourceTokensFromNewest} source token(s) from newest`,
        ...assignment.reasons,
      ]),
      candidates,
    };
  });
  return { units: output, assignments };
}
