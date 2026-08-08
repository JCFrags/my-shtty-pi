import type {
  CandidateUnit,
  CompressionPlan,
  HistoricalBlock,
  RepresentationCandidate,
  ValidationIssue,
  ValidationReport,
} from "./types.js";
import {
  directInstructionText,
  extractIdentifiers,
  hasFailureLanguage,
  hasSuccessLanguage,
  orderedIncludes,
  unique,
} from "./utils.js";

function refKey(entryId: string, blockIndex?: number): string {
  return `${entryId}:${blockIndex ?? "*"}`;
}

function sourceTextForCandidate(candidate: RepresentationCandidate, blocks: readonly HistoricalBlock[]): string {
  const pieces: string[] = [];
  for (const ref of candidate.sourceRefs) {
    const exact = blocks.find(
      (block) => block.entryId === ref.entryId && (ref.blockIndex === undefined || block.blockIndex === ref.blockIndex),
    );
    if (exact) pieces.push(exact.exactText);
  }
  return pieces.join("\n");
}

function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{5,})`|“([^”\n]{5,})”|"([^"\n]{8,})"/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) spans.push(value);
  }
  return unique(spans);
}

function numericFacts(text: string): string[] {
  const facts: string[] = [];
  // Numeric outcomes are particularly easy for a semantic compressor to invent.
  // Normalize common formatting differences while keeping fractions and units distinct.
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])[-+]?\d[\d,_]*(?:\.\d+)?(?:\/\d[\d,_]*(?:\.\d+)?)?(?:\s*(?:ms|s|sec|secs|seconds?|minutes?|hours?|tokens?|tests?|files?|entries|lines?|bytes?|%))?/gi)) {
    const value = match[0]?.toLowerCase().replace(/[,_\s]+/g, "");
    if (value) facts.push(value);
  }
  return unique(facts);
}

function candidateIssues(
  unit: CandidateUnit,
  candidate: RepresentationCandidate,
  blocks: readonly HistoricalBlock[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sourceText = sourceTextForCandidate(candidate, blocks);
  if (unit.protectedExact && candidate.level !== "raw") {
    const directTextIsExact =
      candidate.metadata.protectedDirectText === true && candidate.text === directInstructionText(sourceText);
    if (!directTextIsExact) {
      issues.push({
        severity: "error",
        code: "protected-exact",
        message: "Direct user restriction/correction text was not retained exactly.",
        unitId: unit.id,
      });
    }
  }
  if (candidate.lossy && candidate.level !== "absent" && candidate.omissions.length === 0) {
    issues.push({
      severity: "error",
      code: "loss-without-notice",
      message: "Lossy representation does not report what was omitted.",
      unitId: unit.id,
    });
  }
  if (candidate.reducer === "llm-semantic" || candidate.reducer === "llm-history-editor-v1") {
    for (const identifier of extractIdentifiers(candidate.text)) {
      if (!sourceText.includes(identifier)) {
        issues.push({
          severity: "error",
          code: "unsupported-identifier",
          message: `Semantic compression introduced identifier ${identifier}.`,
          unitId: unit.id,
        });
      }
    }
    for (const quote of quotedSpans(candidate.text)) {
      if (!sourceText.includes(quote)) {
        issues.push({
          severity: "error",
          code: "unsupported-quote",
          message: `Semantic compression introduced an exact-looking quotation not found in source: ${quote}`,
          unitId: unit.id,
        });
      }
    }
    const sourceNumbers = new Set(numericFacts(sourceText));
    for (const fact of numericFacts(candidate.text)) {
      if (!sourceNumbers.has(fact)) {
        issues.push({
          severity: "error",
          code: "unsupported-number",
          message: `Semantic compression introduced numeric fact ${fact} that does not occur in source.`,
          unitId: unit.id,
        });
      }
    }
  }
  const sourceUnresolved = blocks.some(
    (block) => candidate.sourceRefs.some((ref) => ref.entryId === block.entryId) && block.unresolved,
  );
  if (sourceUnresolved && hasSuccessLanguage(candidate.text) && !hasSuccessLanguage(sourceText)) {
    issues.push({
      severity: "error",
      code: "unresolved-became-complete",
      message: "Compression describes unresolved work as completed.",
      unitId: unit.id,
    });
  }
  const sourceFailed = blocks.some(
    (block) => candidate.sourceRefs.some((ref) => ref.entryId === block.entryId) && (block.isError || hasFailureLanguage(block.exactText)),
  );
  if (sourceFailed && hasSuccessLanguage(candidate.text) && !hasFailureLanguage(candidate.text) && !hasSuccessLanguage(sourceText)) {
    issues.push({
      severity: "error",
      code: "failure-became-success",
      message: "Compression rewrites a failed or abandoned event as successful.",
      unitId: unit.id,
    });
  }
  return issues;
}

export interface PrunedCandidatesResult {
  readonly units: readonly CandidateUnit[];
  readonly rejectedIssues: readonly ValidationIssue[];
}

export function pruneUnsafeCandidates(
  units: readonly CandidateUnit[],
  blocks: readonly HistoricalBlock[],
): PrunedCandidatesResult {
  const rejectedIssues: ValidationIssue[] = [];
  const safeUnits = units.map((unit) => {
    const safe = unit.candidates.filter((candidate) => {
      const issues = candidateIssues(unit, candidate, blocks);
      if (issues.length > 0) rejectedIssues.push(...issues);
      return issues.length === 0;
    });
    if (safe.length > 0) return { ...unit, candidates: safe };
    const raw = unit.candidates.find((candidate) => candidate.level === "raw");
    if (!raw) throw new Error(`Validation removed every candidate for unit ${unit.id}, and no raw fallback exists.`);
    return { ...unit, candidates: [raw] };
  });
  return { units: safeUnits, rejectedIssues };
}

export function validatePlan(
  plan: CompressionPlan,
  blocks: readonly HistoricalBlock[],
  targetTokens = plan.targetTokens,
  options: { readonly allowOmittedPrefix?: boolean } = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const validRefs = new Set<string>();
  const validEntries = new Set<string>();
  for (const block of blocks) {
    validEntries.add(block.entryId);
    validRefs.add(refKey(block.entryId, block.blockIndex));
    validRefs.add(refKey(block.entryId));
  }

  let previousStart = -1;
  let previousEnd = -1;
  for (const unit of plan.units) {
    if (unit.startEntryIndex < previousStart || unit.endEntryIndex < unit.startEntryIndex) {
      issues.push({
        severity: "error",
        code: "chronology",
        message: `Unit ${unit.id} is out of chronological order or overlaps a previous unit.`,
        unitId: unit.id,
      });
    }
    previousStart = unit.startEntryIndex;
    previousEnd = Math.max(previousEnd, unit.endEntryIndex);
    for (const ref of unit.sourceRefs) {
      if (!validEntries.has(ref.entryId) || !validRefs.has(refKey(ref.entryId, ref.blockIndex))) {
        issues.push({
          severity: "error",
          code: "invalid-source-ref",
          message: `Unit ${unit.id} references missing source ${ref.entryId}:${ref.blockIndex ?? "*"}.`,
          unitId: unit.id,
        });
      }
    }
    issues.push(...candidateIssues(unit, unit.selected, blocks));
  }

  const firstRepresentedEntryIndex = plan.units[0]?.startEntryIndex ?? Number.POSITIVE_INFINITY;
  const originalCallIds = new Map<string, { call: boolean; result: boolean; latestEntryIndex: number }>();
  for (const block of blocks) {
    if (!block.toolCallId) continue;
    const state = originalCallIds.get(block.toolCallId) ?? { call: false, result: false, latestEntryIndex: -1 };
    if (block.kind === "tool_call") state.call = true;
    if (block.kind === "tool_result") state.result = true;
    state.latestEntryIndex = Math.max(state.latestEntryIndex, block.entryIndex);
    originalCallIds.set(block.toolCallId, state);
  }
  for (const [toolCallId, pair] of originalCallIds) {
    if (!pair.call || !pair.result) continue;
    const represented = plan.units.filter((unit) => unit.toolCallIds.includes(toolCallId));
    if (represented.length === 0 || represented.every((unit) => unit.selected.level === "absent")) {
      if (options.allowOmittedPrefix === true && pair.latestEntryIndex < firstRepresentedEntryIndex) continue;
      issues.push({
        severity: "error",
        code: "tool-pair-missing",
        message: `Tool interaction ${toolCallId} disappeared from the compacted replay.`,
      });
    }
  }

  const entryOrder = blocks.map((block) => block.entryId);
  const renderedOrder = plan.units.flatMap((unit) => unit.sourceRefs.map((ref) => ref.entryId));
  if (!orderedIncludes(entryOrder, unique(renderedOrder))) {
    issues.push({
      severity: "error",
      code: "source-order",
      message: "Rendered source references are not in original chronological order.",
    });
  }
  if (plan.estimatedTokens > targetTokens) {
    issues.push({
      severity: "warning",
      code: "budget-estimate",
      message: `Estimated rendered context is ${plan.estimatedTokens} tokens, above target ${targetTokens}.`,
    });
  }

  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}
