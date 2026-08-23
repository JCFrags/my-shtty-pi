import { parseHistoricalBlocks } from "./blocks.js";
import {
  applyHistoryEditor,
  DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS,
  type HistoryEditor,
  type HistoryEditorObservation,
} from "./history-editor.js";
import { buildCandidateUnits, type CandidatePrecomputeRecord } from "./candidates.js";
import { buildCausalMemory, renderCurrentStateRegisterWithinTokens } from "./causal-memory.js";
import { mergeOldCompletedEpisodes, mergeRoutineActivitySegments } from "./episodes.js";
import { planCompression } from "./planner.js";
import { addRepeatedObservationCandidates } from "./repeated-observations.js";
import { addNearDuplicateFactoringCandidates, applyResourceEvolutionCandidates, buildResourceLineage } from "./resource-lineage.js";
import { applyRetentionGradient } from "./retention-gradient.js";
import { REDUCER_VERSIONS } from "./reducers/index.js";
import { renderCompressionPlan } from "./render.js";
import type {
  CandidateUnit,
  CompressionDetails,
  CompressionPlan,
  CompressionResult,
  CompactorConfig,
  SemanticCompressor,
  SessionEntryLike,
  ValidationIssue,
  ValidationReport,
} from "./types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./types.js";
import { measureTokenTelemetry, retentionSignalsFromFeedback, type RetrievalFeedback } from "./telemetry.js";
import { estimateTokensFromText, hashText, stableStringify, truncateToTokens } from "./utils.js";
import { buildValidationIndex, pruneUnsafeCandidates, validatePlan } from "./validate.js";
import { applyValueAdvice } from "./value-advice-application.js";
import type { StoredValueAdvice } from "./value-advice-store.js";

const RENDER_OVERHEAD_RESERVE = 180;
const MAX_BUDGET_REPLANS = 8;
export const HARD_REPLAY_CAP_TOKENS = 25_000;

export interface CompactEntriesOptions {
  readonly config?: Partial<CompactorConfig>;
  readonly semanticCompressor?: SemanticCompressor;
  readonly signal?: AbortSignal;
  readonly retentionHints?: string;
  readonly futureEntries?: readonly SessionEntryLike[];
  readonly historyEditor?: HistoryEditor;
  readonly historyEditorMaxInputTokens?: number;
  readonly historyEditorMaxOutputTokens?: number;
  /** Last complete non-authoritative advice snapshot. Never starts or waits for a model call. */
  readonly valueAdvice?: ReadonlyMap<string, StoredValueAdvice>;
  readonly valueWorkerMode?: "off" | "shadow" | "advisory";
  readonly hardOutputTokens?: number;
  /** Validated deterministic candidates from the request-local incremental checkpoint. */
  readonly precomputedCandidates?: ReadonlyMap<string, CandidatePrecomputeRecord>;
  /** Append-only editable memory materialized by the extension. */
  readonly pinnedMemoryText?: string;
  /** Generation-bound search and recall use that refreshes later retention. */
  readonly retrievalFeedback?: RetrievalFeedback;
}

export class CompactionValidationError extends Error {
  readonly report: ValidationReport;

  constructor(message: string, report: ValidationReport) {
    super(message);
    this.name = "CompactionValidationError";
    this.report = report;
  }
}

export function resolveCompactorConfig(config: Partial<CompactorConfig> = {}): CompactorConfig {
  const merged: CompactorConfig = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
  const targetTokens = Math.max(256, Math.floor(merged.targetTokens));
  return {
    ...merged,
    targetTokens,
    minSummaryTokens: Math.max(128, Math.floor(merged.minSummaryTokens)),
    maxSummaryTokens: Math.max(targetTokens, Math.floor(merged.maxSummaryTokens)),
    recentExactBiasFraction: Math.min(0.95, Math.max(0, merged.recentExactBiasFraction)),
    minMarginalUtilityPerToken: Math.min(100, Math.max(0, merged.minMarginalUtilityPerToken)),
    mergeBeforeFraction: Math.min(0.95, Math.max(0.05, merged.mergeBeforeFraction)),
    maxIndividualUnits: Math.max(20, Math.floor(merged.maxIndividualUnits)),
    minEpisodeRawTokens: Math.max(200, Math.floor(merged.minEpisodeRawTokens)),
    maxEpisodeTokens: Math.max(80, Math.floor(merged.maxEpisodeTokens)),
    semanticMaxTokens: Math.max(48, Math.floor(merged.semanticMaxTokens)),
    hotSourceTokens: Math.max(1_000, Math.floor(merged.hotSourceTokens)),
    warmSourceTokens: Math.max(1_000, Math.floor(merged.warmSourceTokens)),
    coldCueTokens: Math.max(24, Math.min(160, Math.floor(merged.coldCueTokens))),
  };
}

function generationRelevantEntries(entries: readonly SessionEntryLike[]): readonly SessionEntryLike[] {
  return entries.filter((entry) => entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary");
}

export function computeGenerationHash(
  entries: readonly SessionEntryLike[],
  config: CompactorConfig,
  retentionHints = "",
  futureEntries: readonly SessionEntryLike[] = [],
  pinnedMemoryText = "",
  retrievalFeedback?: RetrievalFeedback,
): string {
  return hashText(
    stableStringify({
      schema: 20,
      entries: generationRelevantEntries(entries),
      futureEntries: generationRelevantEntries(futureEntries),
      config: {
        targetTokens: config.targetTokens,
        recentExactBiasFraction: config.recentExactBiasFraction,
        minMarginalUtilityPerToken: config.minMarginalUtilityPerToken,
        mergeEpisodes: config.mergeEpisodes,
        mergeBeforeFraction: config.mergeBeforeFraction,
        maxIndividualUnits: config.maxIndividualUnits,
        minEpisodeRawTokens: config.minEpisodeRawTokens,
        maxEpisodeTokens: config.maxEpisodeTokens,
        semanticMaxTokens: config.semanticMaxTokens,
        enableSemanticCompression: config.enableSemanticCompression,
        includeHeader: config.includeHeader,
        emergencyAllowAbsent: config.emergencyAllowAbsent,
        hotSourceTokens: config.hotSourceTokens,
        warmSourceTokens: config.warmSourceTokens,
        coldCueTokens: config.coldCueTokens,
      },
      hardReplayCapTokens: HARD_REPLAY_CAP_TOKENS,
      reducerVersions: REDUCER_VERSIONS,
      retentionHints,
      pinnedMemoryHash: hashText(pinnedMemoryText),
      retrievalFeedback: retrievalFeedback ? {
        searches: retrievalFeedback.searches,
        misses: retrievalFeedback.misses,
        repeatedQueries: retrievalFeedback.repeatedQueries,
        readsByResource: retrievalFeedback.readsByResource,
        readsByBlockId: retrievalFeedback.readsByBlockId,
      } : undefined,
    }),
  );
}

function shouldMergeEpisodes(units: readonly CandidateUnit[], rawTokens: number, targetTokens: number, config: CompactorConfig): boolean {
  if (!config.mergeEpisodes) return false;
  if (units.length > config.maxIndividualUnits) return true;
  if (rawTokens > targetTokens * 5 && units.length > 60) return true;
  return false;
}

function appendIssues(report: ValidationReport, additional: readonly ValidationIssue[]): ValidationReport {
  const issues = [...report.issues, ...additional];
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

function buildDetails(
  entries: readonly SessionEntryLike[],
  generationHash: string,
  result: {
    rawTokens: number;
    renderedTokens: number;
    targetTokens: number;
    plan: CompressionPlan;
    validation: ValidationReport;
    historyEditor?: HistoryEditorObservation;
    v2?: CompressionDetails["v2"];
  },
): CompressionDetails {
  const sourceEntryIds = entries.flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : []));
  const first = sourceEntryIds[0];
  const last = sourceEntryIds[sourceEntryIds.length - 1];
  return {
    schemaVersion: 2,
    generationHash,
    sourceEntryIds,
    ...(first === undefined || last === undefined ? {} : { sourceRange: { start: first, end: last } }),
    rawTokens: result.rawTokens,
    renderedTokens: result.renderedTokens,
    targetTokens: result.targetTokens,
    reducerVersions: REDUCER_VERSIONS,
    plan: result.plan.units.map((unit) => ({
      unitId: unit.id,
      level: unit.selected.level,
      sourceRefs: unit.sourceRefs,
      rawTokens: unit.rawTokens,
      renderedTokens: unit.selected.tokens,
      importance: unit.importance,
      importanceReasons: unit.importanceReasons,
    })),
    validation: result.validation,
    ...(result.v2 === undefined ? {} : { v2: result.v2 }),
    ...(result.historyEditor === undefined ? {} : { historyEditor: result.historyEditor }),
  };
}

function capPlanToRecentSuffix(
  plan: CompressionPlan,
  generationHash: string,
  includeHeader: boolean,
  maximumTokens = HARD_REPLAY_CAP_TOKENS,
): { readonly plan: CompressionPlan; readonly rendered: ReturnType<typeof renderCompressionPlan>; readonly omittedUnits: number } {
  const hardMaximum = Math.min(HARD_REPLAY_CAP_TOKENS, Math.max(128, Math.floor(maximumTokens)));
  const initial = renderCompressionPlan(plan, generationHash, includeHeader);
  if (initial.tokens <= hardMaximum || plan.units.length === 0) {
    return { plan, rendered: initial, omittedUnits: 0 };
  }

  const makePlan = (start: number): CompressionPlan => {
    const kept = plan.units.slice(start);
    const firstRef = plan.units[0]?.sourceRefs[0];
    const omitted = plan.units.slice(0, start);
    const lastOmitted = omitted[omitted.length - 1];
    const lastRef = lastOmitted?.sourceRefs[lastOmitted.sourceRefs.length - 1];
    const recovery = firstRef && lastRef
      ? ` Exact omitted prefix: history_range("${firstRef.entryId}", "${lastRef.entryId}").`
      : "";
    return {
      ...plan,
      units: kept,
      estimatedTokens: kept.reduce((sum, unit) => sum + unit.selected.tokens, 0),
      warnings: [
        ...plan.warnings,
        `Hard replay cap applied: omitted the earliest ${start} chronological unit(s) and retained the newest replay suffix.${recovery}`,
      ],
    };
  };

  let low = 1;
  let high = plan.units.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = makePlan(middle);
    if (renderCompressionPlan(candidate, generationHash, includeHeader).tokens > hardMaximum) low = middle + 1;
    else high = middle;
  }
  let start = low;
  let cappedPlan = makePlan(start);
  let rendered = renderCompressionPlan(cappedPlan, generationHash, includeHeader);
  while (rendered.tokens > hardMaximum && start < plan.units.length) {
    start += 1;
    cappedPlan = makePlan(start);
    rendered = renderCompressionPlan(cappedPlan, generationHash, includeHeader);
  }
  while (start > 1) {
    const expandedPlan = makePlan(start - 1);
    const expanded = renderCompressionPlan(expandedPlan, generationHash, includeHeader);
    if (expanded.tokens > hardMaximum) break;
    start -= 1;
    cappedPlan = expandedPlan;
    rendered = expanded;
  }
  return { plan: cappedPlan, rendered, omittedUnits: start };
}

function emptyResult(
  entries: readonly SessionEntryLike[],
  config: CompactorConfig,
  retentionHints = "",
  futureEntries: readonly SessionEntryLike[] = [],
): CompressionResult {
  const generationHash = computeGenerationHash(entries, config, retentionHints, futureEntries);
  const summary = [
    "# CHRONOCOMPACT CHRONOLOGICAL REPLAY",
    "",
    "No model-facing historical blocks were present in the selected source range. The immutable JSONL remains authoritative.",
    `Generation source hash: ${generationHash}`,
  ].join("\n");
  const renderedTokens = estimateTokensFromText(summary);
  const plan: CompressionPlan = {
    targetTokens: config.targetTokens,
    estimatedTokens: renderedTokens,
    rawTokens: 0,
    units: [],
    warnings: [],
  };
  const validation: ValidationReport = { ok: true, issues: [] };
  const details = buildDetails(entries, generationHash, {
    rawTokens: 0,
    renderedTokens,
    targetTokens: config.targetTokens,
    plan,
    validation,
  });
  return { summary, rawTokens: 0, renderedTokens, targetTokens: config.targetTokens, plan, validation, details };
}

export async function compactEntries(
  entries: readonly SessionEntryLike[],
  options: CompactEntriesOptions = {},
): Promise<CompressionResult> {
  const config = resolveCompactorConfig(options.config);
  const blocks = parseHistoricalBlocks(entries, {
    includeHistoricalCompactions: false,
    includeMetadata: false,
  });
  if (blocks.length === 0) return emptyResult(entries, config, options.retentionHints, options.futureEntries);

  const hardOutputTokens = Math.min(
    HARD_REPLAY_CAP_TOKENS,
    Math.max(128, Math.floor(options.hardOutputTokens ?? HARD_REPLAY_CAP_TOKENS)),
  );
  const currentStateTokenBudget = Math.max(128, Math.min(5_000, Math.floor(hardOutputTokens * 0.2)));
  const lineage = buildResourceLineage(blocks);
  const causal = buildCausalMemory(blocks, lineage);
  const derivedState = renderCurrentStateRegisterWithinTokens(causal, 250, currentStateTokenBudget);
  const pinnedMemoryText = [options.pinnedMemoryText?.trim(), derivedState.trim()].filter(Boolean).join("\n\n");
  const pinnedMemoryTokens = estimateTokensFromText(pinnedMemoryText);
  const generationHash = computeGenerationHash(entries, config, options.retentionHints, options.futureEntries, pinnedMemoryText, options.retrievalFeedback);
  const rawTokens = blocks.reduce((sum, block) => sum + block.rawTokens, 0);
  const analysisBlocks = options.futureEntries?.length
    ? parseHistoricalBlocks([...entries, ...options.futureEntries], {
        includeHistoricalCompactions: false,
        includeMetadata: false,
      })
    : blocks;
  let candidateUnits = await buildCandidateUnits(
    blocks,
    config,
    options.semanticCompressor,
    options.signal,
    options.retentionHints ?? "",
    analysisBlocks,
    options.precomputedCandidates,
  );
  const resourceAware = applyResourceEvolutionCandidates(candidateUnits, blocks, lineage);
  const factored = addNearDuplicateFactoringCandidates(resourceAware, blocks);
  const retentionSignals = retentionSignalsFromFeedback(options.retrievalFeedback, blocks.map((block) => block.id));
  const gradient = applyRetentionGradient(factored, blocks, {
    hotSourceTokens: config.hotSourceTokens,
    warmSourceTokens: config.warmSourceTokens,
    coldCueTokens: config.coldCueTokens,
    ...retentionSignals,
  });
  const validationIndex = buildValidationIndex(blocks);
  const initialPruned = pruneUnsafeCandidates(gradient.units, blocks, validationIndex);
  const repeatPruned = pruneUnsafeCandidates(addRepeatedObservationCandidates(initialPruned.units, blocks), blocks, validationIndex);
  candidateUnits = [...repeatPruned.units];

  // Pi has already selected this prefix for compaction. Do not spend a large
  // configured budget by simply replaying the prefix at full size. Reserve a
  // useful reduction target even when the configured context budget is large.
  const usefulSavingsTarget = Math.max(128, Math.floor(rawTokens * (rawTokens >= 4_000 ? 0.82 : 0.88)));
  const renderedTarget = Math.min(config.targetTokens, usefulSavingsTarget);
  const replayRenderedTarget = Math.max(128, renderedTarget - pinnedMemoryTokens);
  const planningTarget = Math.max(32, replayRenderedTarget - (config.includeHeader ? RENDER_OVERHEAD_RESERVE : 24));
  const advised = applyValueAdvice(candidateUnits, options.valueAdvice ?? new Map(), options.valueWorkerMode ?? "off");
  candidateUnits = [...advised.units];
  let plan = planCompression(candidateUnits, planningTarget, config);
  if (shouldMergeEpisodes(candidateUnits, rawTokens, renderedTarget, config) || plan.estimatedTokens > planningTarget) {
    const merged = mergeOldCompletedEpisodes(candidateUnits, blocks, config);
    if (merged.length < candidateUnits.length) {
      candidateUnits = [...pruneUnsafeCandidates(merged, blocks, validationIndex).units];
      plan = planCompression(candidateUnits, planningTarget, config);
    }
  }
  if (candidateUnits.length > config.maxIndividualUnits || plan.estimatedTokens > planningTarget) {
    const segmented = mergeRoutineActivitySegments(candidateUnits, blocks, config, planningTarget);
    if (segmented.length < candidateUnits.length) {
      candidateUnits = [...pruneUnsafeCandidates(segmented, blocks, validationIndex).units];
      plan = planCompression(candidateUnits, planningTarget, config);
    }
  }

  let rendered = renderCompressionPlan(plan, generationHash, config.includeHeader);
  let replanTarget = planningTarget;
  for (let attempt = 0; rendered.tokens > replayRenderedTarget && attempt < MAX_BUDGET_REPLANS; attempt += 1) {
    const overflow = rendered.tokens - replayRenderedTarget;
    const nextTarget = Math.max(32, replanTarget - Math.max(32, overflow + 24));
    if (nextTarget >= replanTarget) break;
    replanTarget = nextTarget;
    plan = planCompression(candidateUnits, replanTarget, config);
    rendered = renderCompressionPlan(plan, generationHash, config.includeHeader);
  }

  const hardCap = capPlanToRecentSuffix(plan, generationHash, config.includeHeader, Math.max(128, hardOutputTokens - pinnedMemoryTokens));
  plan = hardCap.plan;
  rendered = hardCap.rendered;

  const edited = await applyHistoryEditor(
    plan,
    blocks,
    generationHash,
    config.includeHeader,
    options.historyEditor,
    {
      maxInputTokens: Math.max(512, Math.floor(options.historyEditorMaxInputTokens ?? DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS)),
      maxOutputTokens: Math.min(
        hardOutputTokens,
        Math.max(256, Math.floor(options.historyEditorMaxOutputTokens ?? hardOutputTokens)),
      ),
      retentionHints: options.retentionHints,
      signal: options.signal,
    },
  );
  plan = edited.plan;
  rendered = renderCompressionPlan(plan, generationHash, config.includeHeader);
  const summary = pinnedMemoryText ? `${pinnedMemoryText}\n\n${rendered.text}` : rendered.text;
  const combinedRenderedTokens = estimateTokensFromText(summary);

  let validation = validatePlan(plan, blocks, Math.min(replayRenderedTarget, Math.max(128, hardOutputTokens - pinnedMemoryTokens)), {
    allowOmittedPrefix: hardCap.omittedUnits > 0,
    validationIndex,
  });
  const additionalIssues: ValidationIssue[] = [
    ...initialPruned.rejectedIssues.map((issue) => ({ ...issue, severity: "warning" as const })),
    ...repeatPruned.rejectedIssues.map((issue) => ({ ...issue, severity: "warning" as const })),
  ];
  if (hardCap.omittedUnits > 0) {
    additionalIssues.push({
      severity: "warning",
      code: "hard-replay-cap",
      message: `Hard replay cap omitted the earliest ${hardCap.omittedUnits} chronological unit(s); the regular Pi summary, recovery range, and newest replay suffix remain.`,
    });
  }
  if (combinedRenderedTokens > hardOutputTokens) {
    additionalIssues.push({
      severity: "error",
      code: "hard-output-cap",
      message: `Rendered memory and replay exceed the hard ${hardOutputTokens}-token output cap.`,
    });
  }
  if (combinedRenderedTokens > renderedTarget) {
    additionalIssues.push({
      severity: "warning",
      code: "rendered-budget",
      message: `Rendered memory and replay are ${combinedRenderedTokens} tokens, above effective target ${renderedTarget}; protected exact content or minimum safe markers prevented further reduction.`,
    });
  }
  if (combinedRenderedTokens >= rawTokens) {
    additionalIssues.push({
      severity: "error",
      code: "no-net-savings",
      message: `Rendered memory and replay require ${combinedRenderedTokens} estimated tokens for ${rawTokens} estimated source tokens. Compaction would not reduce the historical prefix.`,
    });
  }
  validation = appendIssues(validation, additionalIssues);
  if (!validation.ok) {
    throw new CompactionValidationError("ChronoCompact failed structural or factual validation.", validation);
  }

  const telemetry = measureTokenTelemetry(blocks, plan, generationHash);
  const retentionBands = [...gradient.assignments.values()].reduce<Record<"hot" | "warm" | "cold", number>>(
    (counts, assignment) => ({ ...counts, [assignment.band]: counts[assignment.band] + 1 }),
    { hot: 0, warm: 0, cold: 0 },
  );
  const details = buildDetails(entries, generationHash, {
    rawTokens,
    renderedTokens: combinedRenderedTokens,
    targetTokens: config.targetTokens,
    plan,
    validation,
    historyEditor: edited.observation,
    v2: {
      resourceGenerationHash: lineage.generationHash,
      causalGenerationHash: causal.generationHash,
      pinnedMemoryTokens,
      retentionBands,
      tokenTelemetry: telemetry as unknown as Readonly<Record<string, unknown>>,
    },
  });
  return {
    summary,
    rawTokens,
    renderedTokens: combinedRenderedTokens,
    targetTokens: config.targetTokens,
    plan,
    validation,
    details,
  };
}

export interface SummaryBudgetInput {
  readonly targetActiveContextTokens: number;
  readonly retainedTailTokens: number;
  readonly minSummaryTokens?: number;
  readonly maxSummaryTokens?: number;
  readonly contextReserveTokens?: number;
}

export function computeSummaryBudget(input: SummaryBudgetInput): number {
  const min = Math.max(256, Math.floor(input.minSummaryTokens ?? DEFAULT_COMPACTOR_CONFIG.minSummaryTokens));
  const max = Math.max(min, Math.floor(input.maxSummaryTokens ?? DEFAULT_COMPACTOR_CONFIG.maxSummaryTokens));
  const reserve = Math.max(0, Math.floor(input.contextReserveTokens ?? 1_500));
  const available = Math.floor(input.targetActiveContextTokens - input.retainedTailTokens - reserve);
  return Math.min(max, Math.max(min, available));
}

export interface ReplayTargetInput {
  readonly derivedTargetTokens: number;
  readonly fixedTargetTokens?: number;
  readonly maximumTokens: number;
}

export function selectReplayTarget(input: ReplayTargetInput): number {
  const maximum = Math.max(256, Math.floor(input.maximumTokens));
  const selected = input.fixedTargetTokens ?? input.derivedTargetTokens;
  return Math.min(maximum, Math.max(256, Math.floor(selected)));
}
