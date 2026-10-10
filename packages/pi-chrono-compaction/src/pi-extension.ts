import { sessionEntryToContextMessages, VERSION as PI_HOST_VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { collectContext } from "@context-kit/protocol/collect";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";
import { showChronoReport } from "./chrono-ui.js";
import { Type } from "typebox";
import { env } from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HistorySearchAdapter, isSearchReference, encodeCompositionRecovery } from "./history-search-adapter.js";
import { logicalBootstrapBytes, persistNewShardBootstrap } from "./logical-session-persistence.js";
import { captureLogicalStateCheckpointsAsync, type LogicalStateCheckpoint } from "./logical-session-checkpoints.js";
import { previewStoredCompaction, composeStoredCompactionForNormalReturn, captureContextCompilation } from "./composition-preview.js";
import { compileContext, freezeContextInput, contextReceiptLocator, CONTEXT_COMPILER_LIMITS, type CompiledContext, type ContextReceiptLocator, type FrozenContextInput } from "./context-compiler.js";
import { composeBoundedMemory } from "./bounded-memory.js";
import { captureChronologicalReplay } from "./chronological-replay.js";
import {
  SESSION_AGENT_SUMMARY_CUSTOM_TYPE, SESSION_AGENT_SUMMARY_LIMITS, SESSION_AGENT_SUMMARY_TOOL,
  createSessionAgentSummaryRequest, renderSessionAgentSummaryRequest, parseSessionAgentSummarySubmission,
  consumeSessionAgentSummaryRequest, acceptSessionAgentSummary, settleSessionAgentSummary, validateSessionAgentSummary, validateDeferredSessionSummaryIntent,
  bindSessionAgentSummaryInput, identifyFailedSessionAgentSummary,
  type SessionAgentSummaryScope, type SessionAgentSummaryRequest, type SessionAgentSummaryConsumedRequest,
  type SessionAgentSummaryAccepted, type SessionAgentSummaryReady,
} from "./session-agent-summary.js";
import { SessionCanary } from "./session-canary.js";
import { sessionMigrationStatus } from "./session-migration.js";
import { readSessionRollout, writeSessionRollout } from "./session-rollout.js";
import { startAuthorizedWorkerRuntime, startupAuthorizationPath, type WorkerStartupStatus } from "./worker-runtime-startup-client.js";
import { CatalogShadowScheduler } from "./catalog-shadow.js";
import { createContainedCapsuleShadow } from "./capsule-shadow-worker.js";
import type { CapsuleShadowTarget } from "./capsule-shadow.js";
import { runCatalogWorker } from "./catalog-worker-client.js";
import { createHistoryRuntimeTransport } from "./history-runtime-transport.js";
import { runtimeHostStatus } from "./worker-runtime.js";
import { runtimeAdmissionStatusText } from "./worker-runtime-status.js";
import { verifyLegacyAdmissionGate } from "./worker-runtime-legacy-gate.js";
import {
  cachePathForSession,
  hashCompactionConfig,
  nextCacheGeneration,
  readCompactionCache,
  writeCompactionCache,
} from "./cache.js";
import {
  compactEntries,
  CompactionValidationError,
  computeGenerationHash,
  computeSummaryBudget,
  HARD_REPLAY_CAP_TOKENS,
  resolveCompactorConfig,
  selectReplayTarget,
} from "./compactor.js";
import { parseHistoricalBlocks } from "./blocks.js";
import {
  projectToolResultContext,
  projectionSourcesFromBranch,
  type ContextMessageLike,
  type ToolResultProjectionMetrics,
  type ToolResultProjectionMode,
  type ToolResultProjectionSnapshot,
} from "./context-projection.js";
import {
  createCandidateSegmentStore,
  loadCandidateRecordsForBranch,
  loadCandidateSegmentManifest,
  updateCandidateSegmentStore,
  type CandidateSegmentStore,
} from "./candidate-segment-store.js";
import { getSourceEntriesBefore, readSessionJsonl } from "./jsonl.js";
import { loadSourceLedger, sourceLedgerIsBusy, sourceLedgerMatchesSource, sourceLedgerPath, type SourceLedger } from "./source-ledger.js";
import {
  createPiRegularSummary,
  prepareAdaptiveChronoTail,
  previousRegularPiSummary,
  regularSummaryMessagesForCut,
  renderHybridCompaction,
} from "./pi-hybrid.js";
import { DEFAULT_VALUE_WORKER_SETTINGS, type ValueWorkerSettings } from "./value-worker-types.js";
import { selectHistoryHelperRole, clearHistoryHelperRole, validateHistoryModelSelection } from "./history-helper-config.js";
import { historyHelperModelCompatibility } from "./history-helper-model.js";
import { createIntervalHelperRuntime } from "./interval-helper-runtime.js";
import {
  INTERVAL_CONTINUATION_RECORD, continuationRecord, hasContinuationDispatch,
  projectCommittedIntervalRestart, correlatedBoundaryCompaction, intervalRestartContentMessages, committedIntervalRestartReceipt,
  type IntervalBoundaryEvent, type IntervalTurnBoundaryEvent, type IntervalBoundaryResult, type IntervalContinuationRecord,
} from "./interval-runtime.js";
import { buildDeterministicRecoveryHandoff, IntervalRecoveryRefusal } from "./interval-recovery.js";
import { planIntervalContext } from "./interval-compiler.js";
import { deriveIntervalBudget, classifyPressure, intervalResponseReserveTokens, INTERVAL_POLICY } from "./interval-policy.js";
import { captureIntervalSource, revalidateIntervalSource, type IntervalSourceSnapshot } from "./interval-source.js";
import { repinLogicalIntervalSource, type LogicalIntervalSourceManifest, type LogicalIntervalSourcePin } from "./interval-logical-source.js";
import { runValueWorker, loadCompatibleAdvice, valueWorkerConfigurationHash, type ValueWorkerRunResult } from "./value-worker.js";
import { readValueAdviceManifest, resetAdviceCircuit, valueAdviceStorePath } from "./value-advice-store.js";
import {
  historyGetFromLedger,
  historyRangeFromLedger,
} from "./retrieval.js";
import { dispatchHistoryWorker, historyWorkerToolResult, historySearchIndexCacheStatus, createHistoryFeedbackAdmission } from "./history-worker-dispatch.js";
import { LEGACY_HISTORY_MAX_BYTES, type HistoryWorkerTransport } from "./history-worker-contract.js";
export { LEGACY_HISTORY_MAX_BYTES, SEARCH_INDEX_SOURCE_MAX_BYTES } from "./history-worker-contract.js";
export { historySearchIndexCacheStatus } from "./history-worker-dispatch.js";
import {
  appendMemoryEvent,
  listMemories,
  memorySidecarPath,
  readMemoryEvents,
  renderPinnedMemory,
  searchMemories,
  type MemoryAction,
} from "./memory-store.js";
import { buildDeterministicSummaryRebase, decideRegularSummaryRebase } from "./summary-rebase.js";
import {
  RAW_TAIL_PRESET_TOKENS,
  isSafeCompactionCut,
  selectDynamicRawTail,
  selectRawTail,
  selectRawTailWithinMaximum,
  type RawTailMode,
  type RawTailSelection,
} from "./tail-selection.js";
import { decideCompactionTrigger } from "./trigger.js";
import type { CompactorConfig, CompressionResult, SessionEntryLike } from "./types.js";
import {
  applyConfigCommand,
  defaultUserConfigPath,
  loadUserConfig,
  saveUserConfig,
  VALUE_WORKER_PRESETS,
  type ValueWorkerPreset,
  validateMemoryOwner,
  validateContextCompiler,
  type MemoryOwner,
  type ContextCompiler,
  type UserConfig,
} from "./user-config.js";
import { emptyRetrievalFeedback, recordRetrievalFeedback, type RetrievalFeedback } from "./telemetry.js";
import { estimateTokensFromText, hashText, safeErrorMessage, stableStringify, truncateToTokens } from "./utils.js";
import { replayWorkerDiagnosticPath, runCompactionWorker, type WorkerClientResult } from "./compaction-worker-client.js";
import { defaultSchedulerDirectory, schedulerArtifactCounts } from "./host-worker-scheduler.js";
import type { CandidateUpdateWorkerRequest, ReplayWorkerRequest, RollupShadowWorkerRequest, WorkerSourceExpectation } from "./compaction-worker-protocol.js";
import { getRollupShadowStatus } from "./history-rollup-shadow.js";
import { returnAuthoritativeAfterShadowSchedule } from "./post-result-shadow.js";
import { LogicalSessionStore } from "./logical-session-store.js";
import { ManualLogicalRollover, adoptExistingSessionAsShardZero, type SessionCommandPort, type SessionSetupPort } from "./logical-session-rollover.js";
import { resolveLogicalActivation, resolveAdoptedLogicalActivation, type LogicalActivationGrant } from "./logical-session-routing.js";
import {
  buildManualContinuationCandidate,
  buildBoundedContinuationCandidate,
  consumeProvisionalLogicalReplacement,
  markProvisionalLogicalReplacement,
  recordedLogicalBinding,
  recordedLogicalAdoptionBinding,
  logicalAdoptionBinding,
  replacementContainsOnlyContinuation,
  replacementContainsOnlyBootstrap,
} from "./logical-session-integration.js";
import { logicalSessionStatus } from "./logical-session-status.js";
import { CHRONO_VERSION, captureRuntimeIdentity } from "./runtime-identity.js";
import { MAX_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS, DEFAULT_RESPONSE_RESERVE_TOKENS, resolveContextCeiling, captureContextBudget, chargeRawTail, estimateCurrentRequestBudget, estimateCurrentRequestTokens, CONTEXT_ESTIMATOR, type ContextBudget } from "./context-budget.js";

const EXTENSION_VERSION = CHRONO_VERSION;
const LOADED_RUNTIME_IDENTITY = captureRuntimeIdentity(import.meta.url);
/** Default only. Each operation uses the configured, model-validated ceiling. */
export const HARD_COMBINED_CONTEXT_CAP_TOKENS = DEFAULT_CONTEXT_TOKENS;
const RETENTION_HINT_CUSTOM_TYPE = "chrono-compact-retention-hint";
const CONTEXT_WARNING_CUSTOM_TYPE = "chrono-compact-context-warning";
const CONTEXT_RESUME_CUSTOM_TYPE = "chrono-compact-resume";
const CONTEXT_WARNING_PERCENT = 75;
const CONTEXT_URGENT_PERCENT = 85;
const CONTEXT_CIRCUIT_BREAKER_PERCENT = 90;

/** Use the loaded public package identity, not the development SDK pin. Unknown
 * hosts refuse. Registering a handler does not prove proposal support. */
const intervalHostVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(PI_HOST_VERSION);
const intervalHostVersionSupported = !!intervalHostVersion
  && (Number(intervalHostVersion[1]) > 1 || Number(intervalHostVersion[1]) === 1 && Number(intervalHostVersion[2]) >= 1);
function requireIntervalHost(ctx: ExtensionContext): void {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildSessionProjection?: unknown };
  if (!intervalHostVersionSupported || typeof manager.buildSessionProjection !== "function") {
    throw new Error("context-v4-interval-host-api-unavailable");
  }
}
function requireIntervalBoundary(ctx: ExtensionContext, event: IntervalBoundaryEvent): void {
  requireIntervalHost(ctx);
  if (!Array.isArray(event.entries) || typeof event.continue !== "boolean"
    || !["completed", "aborted", "error"].includes(event.outcome)
    || !Array.isArray(event.context?.pendingMessages) || typeof event.context?.canContinue !== "boolean") {
    throw new Error("context-v4-interval-host-boundary-unavailable");
  }
}

/** Public Pi 1.1 proposal contracts. Check the loaded host and actual event shape. */
interface ActionableSettlementAPI {
  on(event: "turn_end", handler: (event: IntervalTurnBoundaryEvent, ctx: ExtensionContext) =>
    IntervalBoundaryResult | undefined | Promise<IntervalBoundaryResult | undefined>): unknown;
  on(event: "agent_before_settle", handler: (event: IntervalBoundaryEvent, ctx: ExtensionContext) =>
    IntervalBoundaryResult | undefined | Promise<IntervalBoundaryResult | undefined>): unknown;
}

export interface RuntimeSettings {
  readonly memoryOwner: MemoryOwner;
  readonly contextCompiler: ContextCompiler;
  readonly targetContextTokens: number;
  readonly replayTargetTokens?: number;
  readonly triggerThresholdTokens?: number;
  readonly triggerMinimumGrowthTokens: number;
  readonly minSummaryTokens: number;
  readonly maxSummaryTokens: number;
  readonly contextReserveTokens: number;
  readonly rawTailMode: RawTailMode;
  readonly rawTailTokens?: number;
  readonly dynamicRawTailMinTokens: number;
  readonly dynamicRawTailMaxTokens: number;
  readonly hybridSummaryEnabled: boolean;
  readonly legacyPiSummaryDisabled: boolean;
  readonly hybridSummaryTargetTokens: number;
  readonly sessionSummaryTargetTokens: number;
  readonly legacyHistoryEditorEnabled: boolean;
  /** Always false. The extension history editor is retired. */
  readonly historyEditorEnabled: false;
  readonly valueWorker: ValueWorkerSettings;
  readonly incrementalPrecomputeEnabled: boolean;
  readonly isolatedWorkerEnabled: boolean;
  readonly rollupShadowEnabled: boolean;
  readonly catalogShadowEnabled: boolean;
  readonly searchIndexEnabled: boolean;
  readonly memoryEngineEnabled: boolean;
  readonly automaticRolloverEnabled: boolean;
  readonly rolloverSourceBytes: number;
  readonly hostWorkerSlots: number;
  readonly workerTimeoutSeconds: number;
  readonly workerNiceLevel: number;
  readonly toolResultProjectionMode: ToolResultProjectionMode;
  readonly cacheEnabled: boolean;
  readonly rankedSearchEnabled: boolean;
  readonly editableMemoryEnabled: boolean;
  readonly summaryRebaseInterval: number;
  readonly config: Omit<Partial<CompactorConfig>, "targetTokens" | "minSummaryTokens" | "maxSummaryTokens">;
}

function configuredValue(name: string, override: unknown): unknown {
  return env[name] === undefined ? override : env[name];
}

function numberSetting(name: string, fallback: number, min: number, max: number, override?: unknown): number {
  const raw = configuredValue(name, override);
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function optionalNumberSetting(name: string, min: number, max: number, override?: unknown): number | undefined {
  const raw = String(configuredValue(name, override) ?? "").trim().toLowerCase();
  if (!raw || raw === "pi" || raw === "off" || raw === "disabled" || raw === "null") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : undefined;
}

function booleanSetting(name: string, fallback: boolean, override?: unknown): boolean {
  const raw = String(configuredValue(name, override) ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function stringSetting(name: string, fallback: string, override?: unknown): string {
  const raw = String(configuredValue(name, override) ?? "").trim();
  return raw || fallback;
}

function projectionModeSetting(override?: unknown): ToolResultProjectionMode {
  const raw = String(configuredValue("PI_CHRONO_TOOL_RESULT_PROJECTION", override) ?? "").trim().toLowerCase();
  return raw === "safe" || raw === "aggressive" ? raw : "off";
}

function rawTailSetting(override?: unknown): { mode: RawTailMode; tokens?: number } {
  const raw = String(configuredValue("PI_CHRONO_RAW_TAIL", override) ?? "").trim().toLowerCase();
  if (!raw || raw === "dynamic") return { mode: "dynamic" };
  if (raw === "pi") return { mode: "pi" };
  if (raw === "short" || raw === "medium" || raw === "long") {
    return { mode: raw, tokens: RAW_TAIL_PRESET_TOKENS[raw] };
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return { mode: "fixed", tokens: Math.min(200_000, Math.max(1_000, Math.floor(numeric))) };
  return { mode: "pi" };
}

export function resolveExtensionSettings(overrides: UserConfig = {}): RuntimeSettings {
  const rawTail = rawTailSetting(overrides.rawTail);
  const triggerThresholdTokens = optionalNumberSetting("PI_CHRONO_TRIGGER_TOKENS", 8_000, 250_000, overrides.triggerThresholdTokens);
  const replayTargetTokens = optionalNumberSetting("PI_CHRONO_REPLAY_TARGET", 256, 25_000, overrides.replayTargetTokens);
  return {
    memoryOwner: validateMemoryOwner(configuredValue("PI_CHRONO_MEMORY_OWNER", overrides.memoryOwner) ?? "chrono"),
    contextCompiler: validateContextCompiler(configuredValue("PI_CHRONO_CONTEXT_COMPILER", overrides.contextCompiler) ?? "v3"),
    targetContextTokens: numberSetting("PI_CHRONO_TARGET_CONTEXT", 32_000, 8_000, 250_000, overrides.targetContextTokens),
    ...(replayTargetTokens === undefined ? {} : { replayTargetTokens }),
    ...(triggerThresholdTokens === undefined ? {} : { triggerThresholdTokens }),
    triggerMinimumGrowthTokens: numberSetting("PI_CHRONO_TRIGGER_MIN_GROWTH", 4_000, 0, 100_000, overrides.triggerMinimumGrowthTokens),
    minSummaryTokens: numberSetting("PI_CHRONO_MIN_SUMMARY", 4_000, 512, 100_000),
    maxSummaryTokens: numberSetting("PI_CHRONO_MAX_SUMMARY", 20_000, 1_000, 25_000),
    contextReserveTokens: numberSetting("PI_CHRONO_CONTEXT_RESERVE", 1_500, 0, 32_000),
    rawTailMode: rawTail.mode,
    ...(rawTail.tokens === undefined ? {} : { rawTailTokens: rawTail.tokens }),
    dynamicRawTailMinTokens: numberSetting("PI_CHRONO_RAW_TAIL_MIN", 3_000, 1_000, 200_000, overrides.dynamicRawTailMinTokens),
    dynamicRawTailMaxTokens: numberSetting("PI_CHRONO_RAW_TAIL_MAX", 6_000, 1_000, 200_000, overrides.dynamicRawTailMaxTokens),
    // Independent Pi summary is optional. Deterministic history remains usable without it.
    hybridSummaryEnabled: booleanSetting("PI_CHRONO_PI_SUMMARY", false, overrides.hybridSummaryEnabled),
    legacyPiSummaryDisabled: false,
    hybridSummaryTargetTokens: numberSetting("PI_CHRONO_PI_SUMMARY_TOKENS", 2_500, 512, 16_000, overrides.hybridSummaryTargetTokens),
    sessionSummaryTargetTokens: Math.floor(numberSetting("PI_CHRONO_SESSION_SUMMARY_TOKENS", 3_000, 256, 8_000, overrides.sessionSummaryTargetTokens)),
    legacyHistoryEditorEnabled: booleanSetting("PI_CHRONO_HISTORY_EDITOR", false, overrides.historyEditorEnabled),
    historyEditorEnabled: false,
    valueWorker: {
      mode: (["shadow", "advisory"].includes(String(env.PI_CHRONO_VALUE_WORKER_MODE ?? overrides.valueWorkerMode)) ? (env.PI_CHRONO_VALUE_WORKER_MODE ?? overrides.valueWorkerMode) : "off") as ValueWorkerSettings["mode"],
      model: stringSetting("PI_CHRONO_VALUE_WORKER_MODEL", DEFAULT_VALUE_WORKER_SETTINGS.model, overrides.valueWorkerModel),
      thinking: (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(env.PI_CHRONO_VALUE_WORKER_THINKING ?? overrides.valueWorkerThinking)) ? (env.PI_CHRONO_VALUE_WORKER_THINKING ?? overrides.valueWorkerThinking) : "inherit") as ValueWorkerSettings["thinking"],
      maxInputTokensPerJob: numberSetting("PI_CHRONO_VALUE_WORKER_JOB_INPUT", 6_000, 1_000, 12_000, overrides.valueWorkerMaxInputTokensPerJob),
      maxOutputTokensPerJob: numberSetting("PI_CHRONO_VALUE_WORKER_JOB_OUTPUT", 1_500, 256, 4_000, overrides.valueWorkerMaxOutputTokensPerJob),
      maxItemsPerJob: numberSetting("PI_CHRONO_VALUE_WORKER_JOB_ITEMS", 40, 5, 100, overrides.valueWorkerMaxItemsPerJob),
      timeoutSeconds: numberSetting("PI_CHRONO_VALUE_WORKER_TIMEOUT", 90, 10, 600, overrides.valueWorkerTimeoutSeconds),
      retries: numberSetting("PI_CHRONO_VALUE_WORKER_RETRIES", 1, 0, 2, overrides.valueWorkerRetries),
      hostSlots: numberSetting("PI_CHRONO_VALUE_WORKER_SLOTS", 1, 1, 4, overrides.valueWorkerHostSlots),
      maxCallsPerSession: numberSetting("PI_CHRONO_VALUE_WORKER_SESSION_CALLS", 100, 1, 2_000, overrides.valueWorkerMaxCallsPerSession),
      maxInputTokensPerSession: numberSetting("PI_CHRONO_VALUE_WORKER_SESSION_INPUT", 250_000, 1_000, 10_000_000, overrides.valueWorkerMaxInputTokensPerSession),
      maxOutputTokensPerSession: numberSetting("PI_CHRONO_VALUE_WORKER_SESSION_OUTPUT", 50_000, 1_000, 2_000_000, overrides.valueWorkerMaxOutputTokensPerSession),
      ...(() => { const raw = env.PI_CHRONO_VALUE_WORKER_COST; if (raw && ["off", "disabled", "none"].includes(raw.trim().toLowerCase())) return {}; const usd = raw === undefined || raw.trim() === "" ? overrides.valueWorkerMaxEstimatedCostUsd : Number(raw); if (usd === undefined || usd === null) return {}; if (!Number.isFinite(usd) || usd < 0.01 || usd > 1000) throw new Error("PI_CHRONO_VALUE_WORKER_COST must be off or 0.01 through 1000."); return { maxEstimatedCostMicroUsd: Math.ceil(usd * 1_000_000) }; })(),
      circuitFailureLimit: numberSetting("PI_CHRONO_VALUE_WORKER_CIRCUIT_FAILURES", 3, 1, 20, overrides.valueWorkerCircuitFailureLimit),
      circuitCooldownSeconds: numberSetting("PI_CHRONO_VALUE_WORKER_CIRCUIT_COOLDOWN", 1_800, 30, 86_400, overrides.valueWorkerCircuitCooldownSeconds),
    },
    incrementalPrecomputeEnabled: booleanSetting("PI_CHRONO_INCREMENTAL_PRECOMPUTE", false, overrides.incrementalPrecomputeEnabled),
    isolatedWorkerEnabled: booleanSetting("PI_CHRONO_ISOLATED_WORKER", false, overrides.isolatedWorkerEnabled),
    rollupShadowEnabled: booleanSetting("PI_CHRONO_ROLLUP_SHADOW", false, overrides.rollupShadowEnabled),
    searchIndexEnabled: booleanSetting("PI_CHRONO_SEARCH_INDEX", false, overrides.searchIndexEnabled),
    memoryEngineEnabled: booleanSetting("PI_CHRONO_MEMORY_ENGINE", true, overrides.memoryEngineEnabled),
    automaticRolloverEnabled: booleanSetting("PI_CHRONO_AUTOMATIC_ROLLOVER", true, overrides.automaticRolloverEnabled),
    rolloverSourceBytes: numberSetting("PI_CHRONO_ROLLOVER_BYTES", 8 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024, overrides.rolloverSourceBytes),
    catalogShadowEnabled: booleanSetting("PI_CHRONO_CATALOG_SHADOW", false, overrides.catalogShadowEnabled),
    hostWorkerSlots: numberSetting("PI_CHRONO_HOST_WORKER_SLOTS", 1, 1, 4, overrides.hostWorkerSlots),
    workerTimeoutSeconds: numberSetting("PI_CHRONO_WORKER_TIMEOUT_SECONDS", 900, 30, 3_600, overrides.workerTimeoutSeconds),
    workerNiceLevel: numberSetting("PI_CHRONO_WORKER_NICE", 10, 0, 19, overrides.workerNiceLevel),
    toolResultProjectionMode: projectionModeSetting(overrides.toolResultProjectionMode),
    cacheEnabled: booleanSetting("PI_CHRONO_CACHE", true),
    rankedSearchEnabled: booleanSetting("PI_CHRONO_RANKED_SEARCH", true, overrides.rankedSearchEnabled),
    editableMemoryEnabled: booleanSetting("PI_CHRONO_EDITABLE_MEMORY", true, overrides.editableMemoryEnabled),
    summaryRebaseInterval: numberSetting("PI_CHRONO_SUMMARY_REBASE_INTERVAL", 8, 2, 1_000, overrides.summaryRebaseInterval),
    config: {
      recentExactBiasFraction: numberSetting("PI_CHRONO_RECENT_EXACT_FRACTION", 0.2, 0, 0.95),
      minMarginalUtilityPerToken: numberSetting("PI_CHRONO_MIN_MARGINAL_UTILITY", 0.06, 0, 100),
      mergeEpisodes: booleanSetting("PI_CHRONO_MERGE_EPISODES", true),
      mergeBeforeFraction: numberSetting("PI_CHRONO_MERGE_BEFORE_FRACTION", 0.55, 0.05, 0.95),
      maxIndividualUnits: numberSetting("PI_CHRONO_MAX_UNITS", 600, 20, 10_000),
      minEpisodeRawTokens: numberSetting("PI_CHRONO_MIN_EPISODE_TOKENS", 1_200, 200, 100_000),
      maxEpisodeTokens: numberSetting("PI_CHRONO_MAX_EPISODE_TOKENS", 420, 80, 4_000),
      semanticMaxTokens: numberSetting("PI_CHRONO_SEMANTIC_BLOCK_TOKENS", 180, 48, 2_000),
      enableSemanticCompression: false,
      includeHeader: true,
      emergencyAllowAbsent: true,
      hotSourceTokens: numberSetting("PI_CHRONO_HOT_SOURCE_TOKENS", 10_000, 1_000, 100_000, overrides.hotSourceTokens),
      warmSourceTokens: numberSetting("PI_CHRONO_WARM_SOURCE_TOKENS", 75_000, 1_000, 500_000, overrides.warmSourceTokens),
      coldCueTokens: numberSetting("PI_CHRONO_COLD_CUE_TOKENS", 56, 24, 160),
    },
  };
}

async function workerSourceExpectation(sessionPath: string): Promise<WorkerSourceExpectation> {
  const before = await stat(sessionPath);
  if (!before.isFile()) throw new Error("source-changed");
  const prefixBytes = Math.min(before.size, 65_536);
  const bytes = Buffer.alloc(prefixBytes);
  const handle = await open(sessionPath, "r");
  try { if (prefixBytes > 0) { const read = await handle.read(bytes, 0, prefixBytes, before.size - prefixBytes); if (read.bytesRead !== prefixBytes) throw new Error("source-changed"); } }
  finally { await handle.close(); }
  const after = await stat(sessionPath);
  if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("source-changed");
  return { deviceId: String(before.dev), inodeId: String(before.ino), size: before.size, mtimeMs: before.mtimeMs, prefixHash: createHash("sha256").update(bytes).digest("hex"), prefixBytes };
}

export function effectiveContextCeiling(ctx: ExtensionContext, settings: RuntimeSettings, responseReserveTokens = DEFAULT_RESPONSE_RESERVE_TOKENS): number {
  const window = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
  const systemTokens = estimateTokensFromText(ctx.getSystemPrompt?.() ?? "");
  return resolveContextCeiling(settings.targetContextTokens, window ?? 0,
    systemTokens + settings.contextReserveTokens, responseReserveTokens);
}

/** Cap the field already selected by Pi. Codex and other APIs are unchanged. */
function capIntervalProviderPayload(model: ExtensionContext["model"], payload: unknown): unknown {
  if (model?.api !== "openai-completions") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("context-v4-interval-output-cap-unavailable");
  }
  const body = payload as Record<string, unknown>;
  const fields = ["max_tokens", "max_completion_tokens"].filter(field => body[field] !== undefined);
  const field = fields[0], tokens = field ? body[field] : undefined;
  if (fields.length !== 1 || typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 1) {
    throw new Error("context-v4-interval-output-cap-unavailable");
  }
  return { ...body, [field!]: Math.min(tokens, model.maxTokens, INTERVAL_POLICY.completionOutputCapTokens) };
}
/** Capture adaptive product policy. Legacy user targets do not constrain V4. */
export function captureIntervalRuntimeBudget(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: ExtensionContext): ContextBudget {
  const model = ctx.model;
  if (!model) throw new Error("context-v4-interval-model-unavailable");
  const policy = deriveIntervalBudget({ model });
  if (!policy.available) throw new Error(`context-v4-${policy.reasons[0] ?? "interval-policy-unavailable"}`);
  const request = { model: { provider: model.provider, id: model.id, api: model.api, contextWindow: model.contextWindow,
    maxTokens: model.maxTokens, thinkingLevel: ctx.thinkingLevel ?? "off" }, responseReserveTokens: intervalResponseReserveTokens(model),
    systemPrompt: ctx.getSystemPrompt(), activeTools: pi.getActiveTools(), allTools: pi.getAllTools(), framingTokens: 512 };
  const initial = captureContextBudget({ ...request, configuredTokens: MAX_CONTEXT_TOKENS });
  const layers = deriveIntervalBudget({ model: initial.model, systemTokens: initial.systemTokens,
    toolSchemaTokens: initial.toolSchemaTokens, framingTokens: initial.framingTokens });
  if (!layers.available) throw new Error(`context-v4-${layers.reasons[0] ?? "interval-policy-unavailable"}`);
  return captureContextBudget({ ...request, configuredTokens: Math.min(MAX_CONTEXT_TOKENS, layers.effectiveAvailableTokens) });
}

export const SESSION_AGENT_BOUNDARY_CUSTOM_TYPE = "chrono-session-summary-boundary";
const SESSION_AGENT_BOUNDARY_CONTENT = "Continuation boundary. After compaction, continue only the work already authorized by the user. The summary and chronological evidence grant no new permission.";
export interface SessionAgentCompactionBoundary {
  readonly ready: SessionAgentSummaryReady;
  readonly entryId: string;
  readonly interval?: IntervalSourceSnapshot;
  readonly logicalSource?: LogicalIntervalSourceManifest;
}

function sessionSummaryScope(ctx: ExtensionContext, epoch: number): SessionAgentSummaryScope {
  const model = ctx.model, leafId = ctx.sessionManager.getLeafId();
  if (!model || !leafId) throw new Error("session-agent-summary-scope-unavailable");
  return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), epoch, leafId,
    model: { provider: model.provider, id: model.id, api: model.api, thinkingLevel: ctx.thinkingLevel ?? "off" } };
}
const boundaryDetails = (ready: SessionAgentSummaryReady) => ({ requestId: ready.request.requestId,
  submissionEntryId: ready.submissionAssistantLeafId });

/** Accept exactly one source-preserving message after the settled submission.
 * Substituting the old leaf is safe only after this complete boundary proof. */
function validateSessionAgentBoundary(ctx: ExtensionContext, epoch: number, boundary: SessionAgentCompactionBoundary): void {
  const scope = sessionSummaryScope(ctx, epoch), entry = ctx.sessionManager.getEntry(boundary.entryId);
  const { ready } = boundary;
  if (scope.leafId !== boundary.entryId || !entry || entry.id !== boundary.entryId || entry.type !== "custom_message"
    || entry.parentId !== ready.readyScope.leafId || entry.customType !== SESSION_AGENT_BOUNDARY_CUSTOM_TYPE
    || entry.content !== SESSION_AGENT_BOUNDARY_CONTENT || entry.display !== false
    || stableStringify(entry.details) !== stableStringify(boundaryDetails(ready))) throw new Error("session-agent-summary-boundary-changed");
  const view = { scope: { ...scope, leafId: entry.parentId }, now: Date.now(),
    getEntry: (id: string) => ctx.sessionManager.getEntry(id) as SessionEntryLike | undefined };
  validateSessionAgentSummary(ready, view);
  if (settleSessionAgentSummary(ready, view).submissionResultLeafId !== ready.submissionResultLeafId) {
    throw new Error("session-agent-summary-boundary-changed");
  }
}

/** Public sendMessage appends synchronously at idle. nextTurn only queues.
 * The ordinary CompactionResult uses a kept-entry ID, so keep one verified
 * technical boundary and project exact C separately from the restart receipt. */
export function appendSessionAgentCompactionBoundary(pi: Pick<ExtensionAPI, "sendMessage">, ctx: ExtensionContext,
  ready: SessionAgentSummaryReady, epoch: number, interval?: IntervalSourceSnapshot,
  logicalSource?: LogicalIntervalSourceManifest): SessionAgentCompactionBoundary {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("session-agent-summary-session-busy");
  validateSessionAgentSummary(ready, { scope: sessionSummaryScope(ctx, epoch), now: Date.now() });
  pi.sendMessage({ customType: SESSION_AGENT_BOUNDARY_CUSTOM_TYPE, content: SESSION_AGENT_BOUNDARY_CONTENT,
    details: boundaryDetails(ready), display: false }, { triggerTurn: false });
  const entryId = ctx.sessionManager.getLeafId();
  if (!entryId || entryId === ready.readyScope.leafId) throw new Error("session-agent-summary-boundary-not-appended");
  const boundary = Object.freeze({ ready, entryId, ...(interval ? { interval } : {}), ...(logicalSource ? { logicalSource } : {}) });
  validateSessionAgentBoundary(ctx, epoch, boundary);
  return boundary;
}

/** Public-hook preparation shared with isolated preview. No request or append
 * occurs here. The caller must supply a fresh, validated session-agent result. */
export async function capturePreparedV4Context(
  pi: Pick<ExtensionAPI, "events" | "getActiveTools" | "getAllTools">,
  ctx: ExtensionContext,
  event: { readonly branchEntries: readonly SessionEntryLike[];
    readonly preparation: { readonly settings: Pick<Parameters<typeof prepareAdaptiveChronoTail>[1]["settings"], "reserveTokens"> };
    readonly signal?: AbortSignal },
  options: { readonly settings: () => RuntimeSettings; readonly memoryOwner: MemoryOwner; readonly epoch: () => number;
    readonly boundary: SessionAgentCompactionBoundary;
    readonly readyHistory?: (snapshot: IntervalSourceSnapshot, budget: ContextBudget) => import("./interval-compiler.js").IntervalReadyHistory;
    readonly historyConfig?: () => unknown;
    readonly refreshSource?: () => Promise<void>;
    readonly revalidateSource?: () => void },
): Promise<{ input: FrozenContextInput; tail: RawTailSelection; revalidate(): void }> {
  const settings = options.settings(), settingsKey = stableStringify(settings), epoch = options.epoch();
  const historyConfigKey = stableStringify(options.historyConfig?.() ?? null);
  const sessionId = ctx.sessionManager.getSessionId(), leafId = ctx.sessionManager.getLeafId() ?? null;
  const sourcePath = ctx.sessionManager.getSessionFile();
  if (!leafId || event.branchEntries.at(-1)?.id !== leafId) throw new Error("context-v4-branch-leaf-mismatch");
  const captureBudget = () => captureIntervalRuntimeBudget(pi, ctx);
  const budget = captureBudget(), budgetKey = stableStringify(budget);
  const revalidate = () => {
    if (event.signal?.aborted || options.epoch() !== epoch || ctx.sessionManager.getSessionId() !== sessionId
      || ctx.sessionManager.getLeafId() !== leafId || ctx.sessionManager.getSessionFile() !== sourcePath
      || stableStringify(options.settings()) !== settingsKey || stableStringify(captureBudget()) !== budgetKey
      || stableStringify(options.historyConfig?.() ?? null) !== historyConfigKey) throw new Error("context-v4-input-changed");
    validateSessionAgentBoundary(ctx, epoch, options.boundary);
    if (!options.boundary.interval) throw new Error("context-v4-interval-source-required");
    if (options.revalidateSource) options.revalidateSource();
    else revalidateIntervalSource(options.boundary.interval, ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[]);
  };
  await options.refreshSource?.();
  revalidate();
  const { ready, entryId, interval } = options.boundary, cutIndex = event.branchEntries.length - 1;
  const technicalParentId = event.branchEntries[cutIndex - 1]?.id;
  if (!interval || leafId !== entryId || technicalParentId !== ready.readyScope.leafId
    || event.branchEntries[cutIndex]?.parentId !== technicalParentId
    || !isSafeCompactionCut(event.branchEntries.slice(-2), 1)) throw new Error("context-v4-history-cut-invalid");
  const sourceCutEntryId = interval.endEntryId;
  const rawTail = { ...chargeRawTail(event.branchEntries.slice(cutIndex)), toolPairSafe: true };
  const tail: RawTailSelection = { mode: "dynamic", cutIndex, firstKeptEntryId: entryId, actualTokens: rawTail.tokens,
    reason: "technical native boundary only; original exact C and immediate continuation are receipt-bound context projections" };
  if (!ready.submission.continuation) throw new Error("session-agent-summary-fresh-continuation-required");
  const sessionSummary = { text: ready.submission.handoff, handoff: ready.submission.handoff,
    continuation: ready.submission.continuation, authorship: "current-agent" as const,
    requestId: ready.request.requestId, requestLeafId: ready.request.scope.leafId,
    consumedBoundaryLeafId: ready.consumedBoundaryLeafId, submissionEntryId: ready.submissionAssistantLeafId,
    submissionToolCallId: ready.submissionToolCallId, relevanceHints: ready.submission.relevanceHints };
  const input = await captureContextCompilation(pi, { scope: { sessionId, leafId }, sourceCutEntryId,
    firstKeptEntryId: entryId, memoryOwner: options.memoryOwner, budget, rawTail, sessionSummary, interval,
    readyHistory: options.readyHistory, logicalSource: options.boundary.logicalSource },
    { getScope: () => ({ sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? null }),
      epoch: options.epoch, signal: event.signal, revalidate });
  await options.refreshSource?.();
  revalidate();
  return { input, tail, revalidate };
}

function safeCompositionFailureCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  const code = value?.code ?? value?.message;
  if (typeof code === "string" && /^(?:catalog|capsule|search-v3|worker|bounded-memory|context-v4|context-provider|context-projection|interval-source|session-agent-summary)-[a-z0-9-]{1,80}$/.test(code)) return code;
  const preparationErrors: Record<string, string> = {
    "Pi compaction preparation omitted firstKeptEntryId or tokensBefore.": "pi-preparation-incomplete",
    "Pi prepared boundary is unavailable.": "pi-boundary-unavailable",
    "No complete tool-safe raw tail fits the dynamic maximum.": "raw-tail-unavailable",
    "Selected model context capacity or reserved token budget is unavailable.": "context-budget-unavailable",
  };
  return typeof value?.message === "string" && Object.hasOwn(preparationErrors, value.message)
    ? preparationErrors[value.message]! : "composition-operation-failed";
}

function isOptionalCompositionUnavailable(error: unknown): boolean {
  // A first catalog pin can precede creation of the optional state file, which
  // reports state-storage-io. Fallback reads no bytes from that unavailable store.
  const code = (error as { code?: unknown; message?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof code === "string" && ["search-v3-index-not-ready", "search-v3-state-not-ready",
    "search-v3-state-store-missing", "search-v3-state-storage-io", "search-v3-rollup-store-missing", "search-v3-rollup-not-ready",
    "catalog-event-missing", "search-v3-worker-timeout", "catalog-worker-timeout", "worker-timeout",
    "scheduler-queue-full", "search-v3-output-budget"].includes(code);
}

function rawTailDescription(settings: RuntimeSettings): string {
  if (settings.rawTailMode === "dynamic") {
    return `dynamic ${settings.dynamicRawTailMinTokens.toLocaleString()}–${settings.dynamicRawTailMaxTokens.toLocaleString()}`;
  }
  if (settings.rawTailTokens !== undefined) return `${settings.rawTailMode} ${settings.rawTailTokens.toLocaleString()}`;
  return "Pi prepared tail";
}

type SaveConfig = (config: UserConfig) => void;

function valueModel(ctx: ExtensionCommandContext, specification: string) {
  if (specification === "main") return ctx.model;
  const slash = specification.indexOf("/");
  return slash > 0 ? ctx.modelRegistry.find(specification.slice(0, slash), specification.slice(slash + 1)) : undefined;
}

function applyValuePreset(ctx: ExtensionCommandContext, config: UserConfig, preset: Exclude<ValueWorkerPreset, "custom">): UserConfig {
  const values = VALUE_WORKER_PRESETS[preset];
  const model = valueModel(ctx, config.valueWorkerModel ?? "main");
  const supported = model ? getSupportedThinkingLevels(model) : ["off" as const];
  const preferred = values.valueWorkerThinking as "off" | "low" | "medium";
  const thinking = supported.includes(preferred) ? preferred : supported[0] ?? "off";
  return { ...config, ...values, valueWorkerThinking: thinking, valueWorkerPreset: preset };
}

async function pickValueModel(ctx: ExtensionCommandContext, config: UserConfig): Promise<UserConfig> {
  const available = ctx.scopedModels?.length
    ? ctx.scopedModels.map(item => item.model)
    : ctx.modelRegistry.getAvailable();
  const providers = [...new Set(available.map(model => model.provider))].sort();
  const provider = await ctx.ui.select("Background LLM model", ["Use current main model", ...providers, "Back"]);
  if (!provider || provider === "Back") return config;
  let specification = "main";
  if (provider !== "Use current main model") {
    const models = available.filter(model => model.provider === provider);
    const labels = models.map(model => `${model.name} (${model.id})`);
    const selected = await ctx.ui.select("Select background model", [...labels, "Back"]);
    const model = models[labels.indexOf(selected ?? "")];
    if (!model) return config;
    specification = `${model.provider}/${model.id}`;
  }
  const next = { ...config, valueWorkerModel: specification };
  const preset = next.valueWorkerPreset;
  return preset && preset !== "custom" ? applyValuePreset(ctx, next, preset) : next;
}

async function configInput(ctx: ExtensionCommandContext, title: string, current: string, command: string, config: UserConfig): Promise<UserConfig> {
  let error = "";
  while (true) {
    const value = await ctx.ui.input(`${title}${error ? `\nInvalid value: ${error}` : ""}`, current);
    if (value === undefined) return config;
    try { return applyConfigCommand(config, `${command} ${value.trim()}`).config; }
    catch (cause) { error = safeErrorMessage(cause); current = value; }
  }
}

async function customValueSettings(ctx: ExtensionCommandContext, initial: UserConfig, save: SaveConfig): Promise<UserConfig> {
  let draft = initial;
  let saved = initial;
  let error = "";
  while (true) {
    try { if (draft !== saved) { save(draft); saved = draft; error = ""; } }
    catch (cause) { error = `Not saved: ${safeErrorMessage(cause)}`; }
    const worker = resolveExtensionSettings(draft).valueWorker;
    const fields = [
      ["Input tokens per job", "value-worker-job-input", worker.maxInputTokensPerJob],
      ["Output tokens per job", "value-worker-job-output", worker.maxOutputTokensPerJob],
      ["Items per job", "value-worker-job-items", worker.maxItemsPerJob],
      ["Job timeout (seconds)", "value-worker-timeout", worker.timeoutSeconds],
      ["Retries", "value-worker-retries", worker.retries],
      ["Concurrent model calls", "value-worker-slots", worker.hostSlots],
      ["Calls per session", "value-worker-session-calls", worker.maxCallsPerSession],
      ["Input tokens per session", "value-worker-session-input", worker.maxInputTokensPerSession],
      ["Output tokens per session", "value-worker-session-output", worker.maxOutputTokensPerSession],
      ["Estimated USD per session (or off)", "value-worker-cost", worker.maxEstimatedCostMicroUsd === undefined ? "off" : worker.maxEstimatedCostMicroUsd / 1_000_000],
      ["Failures before pause", "value-worker-circuit-failures", worker.circuitFailureLimit],
      ["Failure pause (seconds)", "value-worker-circuit-cooldown", worker.circuitCooldownSeconds],
    ] as const;
    const labels = fields.map(([label, , value]) => `${label} · ${value}`);
    const choice = await ctx.ui.select(`Background LLM: Custom\n${error || "Valid changes save immediately."}`, [
      `Mode · ${worker.mode}`, `Model · ${worker.model}`, `Thinking · ${worker.thinking}`, ...labels,
      ...(draft !== saved ? ["Discard unsaved changes"] : []), "Back",
    ]);
    if (choice === "Discard unsaved changes") { draft = saved; error = ""; continue; }
    if (!choice || choice === "Back") { if (draft === saved) return draft; continue; }
    try {
      if (choice.startsWith("Mode")) {
        const mode = await ctx.ui.select("Background LLM mode", ["off", "advisory", "shadow"]);
        if (mode && (worker.mode !== "off" || mode === "off" || await confirmValueEnable(ctx))) {
          draft = { ...draft, valueWorkerMode: mode as ValueWorkerSettings["mode"], valueWorkerPreset: "custom",
            ...(mode === "off" ? {} : { incrementalPrecomputeEnabled: true }) };
        }
      } else if (choice.startsWith("Model")) draft = await pickValueModel(ctx, draft);
      else if (choice.startsWith("Thinking")) {
        const model = valueModel(ctx, worker.model);
        const thinking = await ctx.ui.select("Background model thinking", ["inherit", ...(model ? getSupportedThinkingLevels(model) : ["off"])]);
        if (thinking) draft = { ...applyConfigCommand(draft, `value-worker-thinking ${thinking}`).config, valueWorkerPreset: "custom" };
      } else {
        const field = fields[labels.indexOf(choice)];
        if (field) {
          const next = await configInput(ctx, field[0], String(field[2]), field[1], draft);
          if (next !== draft) draft = { ...next, valueWorkerPreset: "custom" };
        }
      }
    } catch (cause) { error = safeErrorMessage(cause); }
  }
}

function confirmValueEnable(ctx: ExtensionCommandContext): Promise<boolean> {
  return ctx.ui.confirm("Enable background LLM?", "This sends bounded assistant and tool excerpts to the selected model and can incur charges. User messages and protected instruction text are excluded. Local precompute is also enabled. Compaction never waits for this work.");
}

async function backgroundSettings(ctx: ExtensionCommandContext, initial: UserConfig, save: SaveConfig): Promise<UserConfig> {
  let draft = initial;
  let saved = initial;
  let error = "";
  while (true) {
    try { if (draft !== saved) { save(draft); saved = draft; error = ""; } }
    catch (cause) { error = `Not saved: ${safeErrorMessage(cause)}`; }
    const runtime = resolveExtensionSettings(draft);
    const worker = runtime.valueWorker;
    const availability = runtime.memoryEngineEnabled ? "Compatibility worker is paused while the V3 memory engine is enabled." : "Valid changes save immediately. Environment overrides take priority.";
    const choice = await ctx.ui.select(`Background LLM\n${error || availability}`, [
      `Enabled · ${worker.mode === "off" ? "no" : "yes"}`,
      `Usage · ${draft.valueWorkerPreset ?? (worker.mode === "off" ? "lite (on enable)" : "custom")}`,
      `Model · ${worker.model}`,
      "Custom controls",
      ...(draft !== saved ? ["Discard unsaved changes"] : []), "Back",
    ]);
    if (choice === "Discard unsaved changes") { draft = saved; error = ""; continue; }
    if (!choice || choice === "Back") { if (draft === saved) return draft; continue; }
    try {
      if (choice.startsWith("Enabled")) {
        if (worker.mode !== "off") draft = { ...draft, valueWorkerMode: "off" };
        else if (await confirmValueEnable(ctx)) {
          const preset = draft.valueWorkerPreset ?? "lite";
          if (preset !== "custom") draft = applyValuePreset(ctx, draft, preset);
          draft = { ...draft, valueWorkerMode: "advisory", incrementalPrecomputeEnabled: true };
        }
      } else if (choice.startsWith("Model")) draft = await pickValueModel(ctx, draft);
      else if (choice === "Custom controls") draft = await customValueSettings(ctx, draft, save);
      else if (choice.startsWith("Usage")) {
        const selected = await ctx.ui.select("Background LLM usage\nPer-session ceilings, not guaranteed bill totals. Model prices determine actual cost.", [
          "lite · recommended · up to 20 calls / $0.25 estimated",
          "medium · up to 100 calls / $2 estimated",
          "max · up to 400 calls / $10 estimated",
          "custom · edit individual limits",
        ]);
        const preset = selected?.split(" · ")[0] as ValueWorkerPreset | undefined;
        if (preset === "custom") draft = await customValueSettings(ctx, { ...draft, valueWorkerPreset: "custom" }, save);
        else if (preset) draft = applyValuePreset(ctx, draft, preset);
      }
    } catch (cause) { error = safeErrorMessage(cause); }
  }
}

async function tokenInput(
  ctx: ExtensionCommandContext,
  title: string,
  current: number,
  command: string,
  config: UserConfig,
): Promise<UserConfig> {
  return configInput(ctx, title, current.toString(), command, config);
}

async function openIntervalCompactionSettings(ctx: ExtensionCommandContext, initial: UserConfig, save: SaveConfig): Promise<UserConfig> {
  let config = initial;
  const roles = ["activePrefix", "event", "archive"] as const;
  const labels = { activePrefix: "Active-prefix synopsis", event: "Optional event alternatives", archive: "Optional full-interval archive" };
  while (true) {
    const choices = roles.map(role => {
      const route = config.historyHelpers?.[role];
      return `${labels[role]} · ${route ? `${route.provider}/${route.model}` : "unselected"}`;
    });
    const choice = await ctx.ui.select("Chrono compaction: Automatic policy\nBudget and scheduling controls are product-owned. Legacy configuration remains preserved for rollback.",
      ["Automatic policy and capability status", ...choices, "Back"]);
    if (!choice || choice === "Back") return config;
    if (choice === "Automatic policy and capability status") {
      await showChronoReport(ctx, "Chrono automatic compaction", [
        "The current agent submits its task handoff and separate immediate continuation in one response.",
        "Advance notice permits short state preparation. A bounded freeze protects the original interval before the generated exchange.",
        "Deterministic history is the baseline. History routes are unselected unless the user selects and confirms them.",
        "Unavailable or stale optional work never selects another provider. Exact recent interactions remain native messages.",
        `Main route: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable"}. Context capability: ${ctx.model?.contextWindow ?? "unknown"}. Output capability: ${ctx.model?.maxTokens ?? "unknown"}.`,
        "Status and diagnostics report the live interval, budget estimates, refusals, commit correlation, and continuation dispatch separately.",
        "Legacy token targets, tail presets, trigger thresholds, and background-value knobs do not control this interval policy.",
      ].join("\n\n"));
      continue;
    }
    const role = roles[choices.indexOf(choice)];
    if (!role) continue;
    const action = await ctx.ui.select(labels[role], ["Select an explicit provider/model route", "Clear only this role", "Back"]);
    if (!action || action === "Back") continue;
    let next: UserConfig;
    if (action === "Clear only this role") {
      next = { ...config, historyHelpers: clearHistoryHelperRole(config.historyHelpers, role) };
    } else {
      const available = ctx.scopedModels?.length ? ctx.scopedModels.map(item => item.model) : ctx.modelRegistry.getAvailable();
      const providers = [...new Set(available.map(model => model.provider))].sort();
      if (!providers.length) { await showChronoReport(ctx, "History route unavailable", "No authenticated model route is available. No role was selected."); continue; }
      const provider = await ctx.ui.select("Select history inference destination", [...providers, "Back"]);
      if (!provider || provider === "Back") continue;
      const models = available.filter(model => model.provider === provider);
      const modelLabels = models.map(model => `${model.name} (${model.id})${historyHelperModelCompatibility(model).status === "ready" ? "" : " · unavailable"}`);
      const selected = await ctx.ui.select(`Select history model${ctx.scopedModels?.length ? " · your scoped models" : " · available models"}`, [...modelLabels, "Back"]);
      const model = models[modelLabels.indexOf(selected ?? "")];
      if (!model) continue;
      const compatibility = historyHelperModelCompatibility(model);
      if (compatibility.status !== "ready") {
        await showChronoReport(ctx, "History route unavailable", `${compatibility.reason}\nNo role was changed. The main conversation model is unchanged.`);
        continue;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        await showChronoReport(ctx, "History route unavailable", "This route has no configured authentication. No role was changed.");
        continue;
      }
      try { validateHistoryModelSelection({ provider: model.provider, model: model.id }); }
      catch (error) { await showChronoReport(ctx, "History route unavailable", safeErrorMessage(error)); continue; }
      if (!await ctx.ui.confirm("Allow this history route?", `${labels[role]} can send eligible original current-interval history, including user text and tool evidence, to ${model.provider}/${model.id}. A process on this computer can still use a remote provider. Calls can incur charges and provider retention terms apply. Prior packets are excluded. There is no silent provider substitution. This selects only this role, not a current-agent writer or new task authority.`)) continue;
      next = { ...config, historyHelpers: selectHistoryHelperRole(config.historyHelpers, role,
        { provider: model.provider, model: model.id }, { selectedForHistory: true }) };
    }
    try { save(next); config = next; }
    catch (error) { await showChronoReport(ctx, "History route was not saved", safeErrorMessage(error)); }
  }
}

async function openChronoCompactSettings(
  ctx: ExtensionCommandContext,
  initial: UserConfig,
  save: SaveConfig,
): Promise<UserConfig> {
  if (resolveExtensionSettings(initial).contextCompiler === "v4") return openIntervalCompactionSettings(ctx, initial, save);
  let draft = initial;
  let saved = initial;
  let custom = false;
  let error = "";
  while (true) {
    try { if (draft !== saved) { effectiveContextCeiling(ctx, resolveExtensionSettings(draft)); save(draft); saved = draft; error = ""; } }
    catch (cause) { error = `Not saved: ${safeErrorMessage(cause)}`; }
    const settings = resolveExtensionSettings(draft);
    const timing = settings.triggerThresholdTokens === undefined
      ? "Pi context pressure"
      : `proactive at ${settings.triggerThresholdTokens.toLocaleString()} tokens`;
    const choice = await ctx.ui.select(`Chrono settings${custom ? ": Custom" : ""}\n${error || "Valid changes save immediately. Environment overrides take priority."}`, custom ? [
      `Loaded version · ${EXTENSION_VERSION}`,
      `Compaction timing · ${timing}`,
      "Pi pressure safeguard · managed by Pi settings",
      `Threshold retry growth · ${settings.triggerMinimumGrowthTokens.toLocaleString()} tokens`,
      `Raw history retained · ${rawTailDescription(settings)}`,
      `Dynamic tail bounds · ${settings.dynamicRawTailMinTokens.toLocaleString()}–${settings.dynamicRawTailMaxTokens.toLocaleString()} tokens`,
      `Combined context hard limit · ${settings.targetContextTokens.toLocaleString()} tokens (model headroom can lower it)`,
      `Chronological replay maximum · ${settings.replayTargetTokens === undefined ? "automatic" : `${settings.replayTargetTokens.toLocaleString()} tokens`}`,
      `V4 session-agent summary target · ${settings.sessionSummaryTargetTokens.toLocaleString()} tokens${settings.contextCompiler === "v4" ? "" : " (inactive in V3)"}`,
      `V3 regular Pi summary · ${settings.hybridSummaryEnabled ? `${settings.hybridSummaryTargetTokens.toLocaleString()} tokens` : "disabled"}${settings.contextCompiler === "v3" ? "" : " (inactive in V4)"}`,
      `Automatic physical-shard rollover · ${settings.automaticRolloverEnabled ? `${settings.rolloverSourceBytes.toLocaleString()} source bytes at safe idle` : "disabled"}`,
      `Background LLM · ${settings.valueWorker.mode}`,
      `Segmented incremental deterministic precompute · ${settings.incrementalPrecomputeEnabled ? "enabled" : "disabled"}`,
      `Isolated local compaction worker · ${settings.isolatedWorkerEnabled ? `enabled · ${settings.hostWorkerSlots} host slot(s) · nice ${settings.workerNiceLevel}` : "disabled"}`,
      `Hierarchical rollup shadow evaluation · ${settings.rollupShadowEnabled ? "enabled · output does not reach the model · current replay authoritative · local isolated low-priority worker · metrics only" : "disabled"}`,
      `Tool-result shortening at compaction · ${settings.toolResultProjectionMode}`,
      `Ranked local history search · ${settings.rankedSearchEnabled ? "enabled" : "disabled"}`,
      `Editable working memory · ${settings.editableMemoryEnabled ? "enabled" : "disabled"}`,
      `Source retention bands · hot ${settings.config.hotSourceTokens?.toLocaleString()} + warm ${settings.config.warmSourceTokens?.toLocaleString()}`,
      `Regular-summary rebase · every ${settings.summaryRebaseInterval} generations`,
      `Programmatic memory engine · ${settings.memoryEngineEnabled ? "enabled" : "disabled"}`,
      `Indexed history default · ${settings.searchIndexEnabled ? "enabled" : "disabled"}`,
      `Source catalog shadow · ${settings.catalogShadowEnabled ? "enabled" : "disabled"}`,
      "Reset all to defaults",
      "Discard unsaved changes",
      "Back",
    ] : [
      `Background LLM · ${settings.valueWorker.mode === "off" ? "off" : `${draft.valueWorkerPreset ?? "custom"} · ${settings.valueWorker.model}`}`,
      `Compaction timing · ${timing}`,
      `Combined context hard limit · ${settings.targetContextTokens.toLocaleString()} tokens`,
      ...(settings.contextCompiler === "v4" ? [`V4 session-agent summary target · ${settings.sessionSummaryTargetTokens.toLocaleString()} tokens`] : []),
      `Tool-result shortening at compaction · ${settings.toolResultProjectionMode}`,
      "Custom settings (all options)",
      "Back",
    ]);
    if (choice === undefined || choice === "Back") {
      if (draft !== saved) continue;
      if (custom) { custom = false; continue; }
      return draft;
    }
    if (choice === "Custom settings (all options)") { custom = true; continue; }
    if (choice === "Discard unsaved changes") { draft = saved; error = ""; continue; }
    try {
    if (choice.startsWith("Loaded version")) {
      await showChronoReport(ctx, "Chrono version", `Chrono ${EXTENSION_VERSION} is loaded. Compatibility replay cap: ${HARD_REPLAY_CAP_TOKENS.toLocaleString()} tokens. Effective combined cap: ${effectiveContextCeiling(ctx, settings).toLocaleString()} tokens.`);
      continue;
    }
    if (choice.startsWith("Compaction timing")) {
      const selected = await ctx.ui.select("When should ChronoCompact request compaction?", [
        "Use Pi context pressure only",
        "Use a proactive token threshold",
      ]);
      if (selected === "Use Pi context pressure only") draft = applyConfigCommand(draft, "trigger pi").config;
      if (selected === "Use a proactive token threshold") {
        draft = await tokenInput(ctx, "Proactive threshold in tokens", settings.triggerThresholdTokens ?? 48_000, "trigger", draft);
      }
      continue;
    }
    if (choice.startsWith("Pi pressure safeguard")) {
      const usage = ctx.getContextUsage();
      await showChronoReport(ctx, "Pi pressure safeguard",
        [
          "Pi pressure compaction is separate from the proactive ChronoCompact threshold.",
          "Pi default trigger: context window minus 16,384 reserved tokens.",
          "Pi default preparation tail: 20,000 tokens.",
          usage ? `Current reported context: ${usage.tokens?.toLocaleString() ?? "unknown"}/${usage.contextWindow.toLocaleString()} tokens.` : "Current context usage is unavailable.",
          "Pi pressure can trigger earlier than a higher ChronoCompact threshold and remains the final safeguard.",
        ].join("\n"),
      );
      continue;
    }
    if (choice.startsWith("Threshold retry growth")) {
      draft = await tokenInput(ctx, "Growth required before another threshold attempt", settings.triggerMinimumGrowthTokens, "trigger-growth", draft);
      continue;
    }
    if (choice.startsWith("Raw history retained")) {
      const selected = await ctx.ui.select("How much recent history should remain raw?", [
        "Use Pi prepared tail",
        "Dynamic bounded tail",
        "Short · 8,000 tokens",
        "Medium · 16,000 tokens",
        "Long · 24,000 tokens",
        "Fixed token amount",
      ]);
      if (selected === "Use Pi prepared tail") draft = applyConfigCommand(draft, "raw-tail pi").config;
      else if (selected === "Dynamic bounded tail") draft = applyConfigCommand(draft, "raw-tail dynamic").config;
      else if (selected?.startsWith("Short")) draft = applyConfigCommand(draft, "raw-tail short").config;
      else if (selected?.startsWith("Medium")) draft = applyConfigCommand(draft, "raw-tail medium").config;
      else if (selected?.startsWith("Long")) draft = applyConfigCommand(draft, "raw-tail long").config;
      else if (selected === "Fixed token amount") {
        draft = await tokenInput(ctx, "Raw-tail token amount", settings.rawTailTokens ?? 16_000, "raw-tail", draft);
      }
      continue;
    }
    if (choice.startsWith("Dynamic tail bounds")) {
      draft = await configInput(ctx, "Dynamic raw-tail bounds: minimum maximum", `${settings.dynamicRawTailMinTokens} ${settings.dynamicRawTailMaxTokens}`, "raw-tail-bounds", draft);
      continue;
    }
    if (choice.startsWith("Combined context hard limit")) {
      draft = await tokenInput(ctx, "Hard combined context tokens (limited by selected model capacity)", settings.targetContextTokens, "target-context", draft);
      continue;
    }
    if (choice.startsWith("Chronological replay maximum")) {
      const selected = await ctx.ui.select("Chronological replay budget", ["Derive automatically", "Use a fixed maximum"]);
      if (selected === "Derive automatically") draft = applyConfigCommand(draft, "replay-target auto").config;
      if (selected === "Use a fixed maximum") {
        draft = await tokenInput(ctx, "Maximum replay tokens", settings.replayTargetTokens ?? 10_000, "replay-target", draft);
      }
      continue;
    }
    if (choice.startsWith("Automatic physical-shard rollover")) {
      const selected = await ctx.ui.select("Automatic physical-shard rollover", ["Enabled", "Disabled"]);
      if (selected) draft = applyConfigCommand(draft, `automatic-rollover ${selected === "Enabled" ? "on" : "off"}`).config;
      if (selected === "Enabled") draft = await tokenInput(ctx, "Source bytes before safe-idle rollover", settings.rolloverSourceBytes, "rollover-bytes", draft);
      continue;
    }
    if (choice.startsWith("V4 session-agent summary target")) {
      draft = await tokenInput(ctx, "V4 session-agent summary target tokens (256–8,000; soft target)", settings.sessionSummaryTargetTokens, "session-summary-tokens", draft);
      continue;
    }
    if (choice.startsWith("V3 regular Pi summary")) {
      const selected = await ctx.ui.select("V3 regular Pi summary (not the V4 session-agent summary)", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "hybrid off").config;
      if (selected === "Enabled") {
        draft = applyConfigCommand(draft, "hybrid on").config;
        draft = await tokenInput(ctx, "V3 regular Pi summary target tokens", settings.hybridSummaryTargetTokens, "hybrid-tokens", draft);
      }
      continue;
    }
    if (choice.startsWith("Background LLM")) {
      draft = await backgroundSettings(ctx, draft, save);
      saved = draft;
      continue;
    }
    if (choice.startsWith("Segmented incremental deterministic precompute")) {
      const selected = await ctx.ui.select("Incremental deterministic precompute", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "incremental-precompute off").config;
      if (selected === "Enabled") draft = applyConfigCommand(draft, "incremental-precompute on").config;
      continue;
    }
    if (choice.startsWith("Hierarchical rollup shadow evaluation")) {
      const selected = await ctx.ui.select("Hierarchical rollup shadow evaluation", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "rollup-shadow off").config;
      if (selected === "Enabled") draft = applyConfigCommand(draft, "rollup-shadow on").config;
      continue;
    }
    if (choice.startsWith("Isolated local compaction worker")) {
      const selected = await ctx.ui.select("Isolated local compaction worker", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "isolated-worker off").config;
      if (selected === "Enabled") {
        draft = applyConfigCommand(draft, "isolated-worker on").config;
        draft = await tokenInput(ctx, "Host-wide ChronoCompact worker slots (one prevents simultaneous CPU jobs by default)", settings.hostWorkerSlots, "worker-slots", draft);
        draft = await tokenInput(ctx, "Local worker timeout in seconds", settings.workerTimeoutSeconds, "worker-timeout", draft);
        draft = await tokenInput(ctx, "Local worker nice level (the worker does not call a model)", settings.workerNiceLevel, "worker-nice", draft);
      }
      continue;
    }
    if (choice.startsWith("Tool-result shortening at compaction")) {
      const selected = await ctx.ui.select("Shorten old tool results only at compaction boundaries\nLater turns keep the same shortened text. New results stay exact until the next compaction.", ["Off", "Safe", "Aggressive"]);
      if (selected) draft = applyConfigCommand(draft, `tool-result-projection ${selected.toLowerCase()}`).config;
      continue;
    }
    if (choice.startsWith("Ranked local history search")) {
      const selected = await ctx.ui.select("Ranked local history search", ["Enabled", "Disabled"]);
      if (selected) draft = applyConfigCommand(draft, `ranked-search ${selected.toLowerCase() === "enabled" ? "on" : "off"}`).config;
      continue;
    }
    if (choice.startsWith("Editable working memory")) {
      const selected = await ctx.ui.select("Editable working memory", ["Enabled", "Disabled"]);
      if (selected) draft = applyConfigCommand(draft, `memory ${selected.toLowerCase() === "enabled" ? "on" : "off"}`).config;
      continue;
    }
    if (choice.startsWith("Source retention bands")) {
      draft = await tokenInput(ctx, "Hot source-history tokens", settings.config.hotSourceTokens ?? 10_000, "hot-source-tokens", draft);
      draft = await tokenInput(ctx, "Warm source-history tokens after hot history", settings.config.warmSourceTokens ?? 75_000, "warm-source-tokens", draft);
      continue;
    }
    if (choice.startsWith("Regular-summary rebase")) {
      draft = await tokenInput(ctx, "Regular-summary rebase interval", settings.summaryRebaseInterval, "summary-rebase-interval", draft);
      continue;
    }
    const toggles: Array<[string, string]> = [["Programmatic memory engine", "memory-engine"], ["Indexed history default", "search-index"], ["Source catalog shadow", "catalog-shadow"]];
    const toggle = toggles.find(([label]) => choice.startsWith(label));
    if (toggle) {
      const selected = await ctx.ui.select(toggle[0], ["Enabled", "Disabled"]);
      if (selected) draft = applyConfigCommand(draft, `${toggle[1]} ${selected === "Enabled" ? "on" : "off"}`).config;
    }
    if (choice === "Reset all to defaults") {
      if (await ctx.ui.confirm("Reset Chrono settings?", "This removes all persistent overrides. Background LLM stays off by default.")) draft = {};
    }
    } catch (cause) { error = safeErrorMessage(cause); }
  }
}

function asEntries(value: unknown): SessionEntryLike[] {
  if (!Array.isArray(value)) throw new Error("Pi did not provide branchEntries as an array.");
  return value.filter((entry): entry is SessionEntryLike => entry !== null && typeof entry === "object" && typeof (entry as SessionEntryLike).type === "string");
}

function hasUnresolvedTurn(entries: readonly SessionEntryLike[]): boolean {
  let latestUserIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const message = entry?.type === "message" && entry.message !== null && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : undefined;
    if (message?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return false;

  for (let index = entries.length - 1; index > latestUserIndex; index -= 1) {
    const entry = entries[index];
    const message = entry?.type === "message" && entry.message !== null && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : undefined;
    if (message?.role === "assistant") return message.stopReason !== "stop";
  }
  return true;
}

function retentionHintsFromBranch(entries: readonly SessionEntryLike[], customInstructions: unknown): string {
  const hints: string[] = [];
  if (typeof customInstructions === "string" && customInstructions.trim()) {
    hints.push(`Manual compaction instructions:\n${customInstructions.trim()}`);
  }
  for (const entry of entries.slice(-2_000)) {
    if (entry.type !== "custom" || entry.customType !== RETENTION_HINT_CUSTOM_TYPE) continue;
    hints.push(`Primary-model retention hint:\n${stableStringify(entry.data, 2)}`);
  }
  return hints.slice(-8).join("\n\n");
}

function estimateEntryTokens(entries: readonly SessionEntryLike[]): number {
  const blocks = parseHistoricalBlocks(entries, { includeHistoricalCompactions: false, includeMetadata: false });
  if (blocks.length > 0) return blocks.reduce((sum, block) => sum + block.rawTokens, 0);
  return estimateTokensFromText(entries.map((entry) => stableStringify(entry)).join("\n"));
}

function createTailTokenEstimator(entries: readonly SessionEntryLike[]): (tail: readonly SessionEntryLike[]) => number {
  const blocks = parseHistoricalBlocks(entries, { includeHistoricalCompactions: false, includeMetadata: false });
  if (blocks.length === 0) return estimateEntryTokens;
  const tokensByEntry = Array.from({ length: entries.length }, () => 0);
  for (const block of blocks) tokensByEntry[block.entryIndex] = (tokensByEntry[block.entryIndex] ?? 0) + block.rawTokens;
  const suffixTokens = Array.from({ length: entries.length + 1 }, () => 0);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] = (suffixTokens[index + 1] ?? 0) + (tokensByEntry[index] ?? 0);
  }
  return (tail) => {
    const startIndex = entries.length - tail.length;
    return startIndex >= 0 && startIndex <= entries.length ? (suffixTokens[startIndex] ?? 0) : estimateEntryTokens(tail);
  };
}

function boundedBranchEntries(ctx: ExtensionContext, maximum = 256): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [], seen = new Set<string>();
  let id = ctx.sessionManager.getLeafId();
  while (id && entries.length < maximum) {
    if (seen.has(id)) throw new Error("source-changed");
    seen.add(id);
    const entry = ctx.sessionManager.getEntry(id);
    if (!entry || entry.id !== id) throw new Error("source-changed");
    entries.push(entry as unknown as SessionEntryLike);
    id = entry.parentId;
  }
  return entries.reverse();
}

function unmatchedToolCallCount(entries: readonly SessionEntryLike[]): number {
  const pending = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") pending.delete(message.toolCallId);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const value = block as Record<string, unknown>;
      if (value.type === "toolCall" && typeof value.id === "string") pending.add(value.id);
    }
  }
  return pending.size;
}

function logicalErrorCode(error: unknown): string {
  const candidate = (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  if (typeof candidate === "string" && candidate.startsWith("Usage: /Chrono logical-session ")) return candidate;
  return typeof candidate === "string" && /^(logical-session|search-v3|source-changed)[a-z0-9-]*$/.test(candidate)
    ? candidate : "logical-session-unavailable";
}

function validLogicalCommandId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function commandSessionPort(ctx: ExtensionCommandContext, checkpoints: readonly LogicalStateCheckpoint[] = []): SessionCommandPort {
  const sourceSessionId = ctx.sessionManager.getSessionId(), sourceLeafId = ctx.sessionManager.getLeafId();
  const identity = (manager: ExtensionCommandContext["sessionManager"]): SessionCommandPort["sessionManager"] => ({
    getSessionId: () => manager.getSessionId(),
    getSessionFile: () => manager.getSessionFile(),
    getHeader: () => manager.getHeader() ?? {},
  });
  const setup = (manager: SessionManager): SessionSetupPort => ({ ...identity(manager),
    appendCustomMessageEntry: (customType, content, display, details) => manager.appendCustomMessageEntry(customType, content, display, details),
    persistNewShardBootstrap: (expectedParentSession, continuationEntryId) =>
      persistNewShardBootstrap(manager, expectedParentSession, continuationEntryId, sourceSessionId),
  });
  return {
    sessionManager: identity(ctx.sessionManager),
    newSession: async options => {
      if (ctx.sessionManager.getSessionId() !== sourceSessionId || ctx.sessionManager.getLeafId() !== sourceLeafId
        || ctx.sessionManager.getSessionFile() !== options.parentSession) throw new Error("source-changed");
      const clearProvisional = markProvisionalLogicalReplacement(options.parentSession);
      try {
        return await ctx.newSession({ parentSession: options.parentSession,
          setup: manager => {
            for (const checkpoint of checkpoints) manager.appendCustomEntry(checkpoint.customType, checkpoint.data);
            return options.setup(setup(manager));
          },
          withSession: replacement => options.withSession({
            sessionManager: identity(replacement.sessionManager),
            reload: () => replacement.reload(),
          }) });
      } finally { clearProvisional(); }
    },
    switchSession: (path, options) => ctx.switchSession(path, {
      withSession: replacement => options.withSession({
        sessionManager: identity(replacement.sessionManager),
        reload: () => replacement.reload(),
      }),
    }),
  };
}

async function historySourceState(path: string): Promise<{ deviceId: string; inodeId: string; size: number; mtimeMs: number }> {
  const value = await stat(path);
  if (!value.isFile()) throw new Error("history-source-unsafe-type");
  return { deviceId: String(value.dev), inodeId: String(value.ino), size: value.size, mtimeMs: value.mtimeMs };
}
function toolText(text: string, details: Record<string, unknown> = {}): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details };
}

function feedbackKey(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionFile() ?? undefined;
}

function updateRetrievalFeedback(
  store: Map<string, RetrievalFeedback>,
  ctx: ExtensionContext,
  observation: Parameters<typeof recordRetrievalFeedback>[1],
): void {
  const key = feedbackKey(ctx);
  if (!key) return;
  const previous = store.get(key) ?? emptyRetrievalFeedback(observation.generationHash);
  const recorded = recordRetrievalFeedback(previous, observation);
  // Bound retained feedback across repeated calls as well as each child result.
  const boundedCounts = (values: Readonly<Record<string, number>>) => Object.fromEntries(Object.entries(values).slice(-256));
  store.set(key, { ...recorded, readsByResource: boundedCounts(recorded.readsByResource), readsByBlockId: boundedCounts(recorded.readsByBlockId), queryCounts: boundedCounts(recorded.queryCounts) });
  while (store.size > 8) store.delete(store.keys().next().value!);
}

function registerHistoryTools(
  pi: ExtensionAPI,
  settings: () => RuntimeSettings,
  retrievalFeedback: Map<string, RetrievalFeedback>,
  availableLedger: (ctx: ExtensionContext) => Promise<{ sessionPath: string; ledger: SourceLedger } | undefined>,
  transport: HistoryWorkerTransport | undefined,
  reserveFeedback: () => boolean,
  search: HistorySearchAdapter,
): void {
  pi.registerTool({
    name: "history_get",
    label: "Get Exact History",
    description: "Return an exact immutable Pi JSONL entry or one exact content block, with nearby context.",
    parameters: Type.Object({
      entryId: Type.String({ description: "Pi session entry ID or indexed source handle" }),
      shardId: Type.Optional(Type.String({ description: "Logical shard ID reported by logical history search" })),
      startByte: Type.Optional(Type.Number({ minimum: 0, description: "Continue exact raw byte recovery at nextByte" })),
      blockIndex: Type.Optional(Type.Number({ minimum: 0 })),
      contextBefore: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      contextAfter: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      startChar: Type.Optional(Type.Number({ minimum: 0 })),
      maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 12_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (settings().searchIndexEnabled) {
        if (isSearchReference(params.entryId)) {
          if (params.blockIndex !== undefined || params.contextBefore || params.contextAfter || params.startByte !== undefined) return toolText("A source handle already selects a decoded block; byte offsets and neighbors are not supported here.", { status: "unavailable", code: "search-v3-option-unsupported" });
          return search.recall(params.entryId, params.startChar, params.maxChars, _signal);
        }
        if (params.blockIndex !== undefined) {
          if (params.contextBefore || params.contextAfter || params.startByte !== undefined) return toolText("Indexed block recovery uses decoded character coordinates without neighbors.", { status: "unavailable", code: "search-v3-option-unsupported" });
          return search.getBlock(params.entryId, params.blockIndex, params.startChar, params.maxChars, _signal, params.shardId);
        }
        return search.getRaw(params.entryId, params, _signal, params.shardId);
      }
      const options = {
        blockIndex: params.blockIndex,
        contextBefore: params.contextBefore,
        contextAfter: params.contextAfter,
        startChar: params.startChar,
        maxChars: params.maxChars,
      };
      const ledger = await availableLedger(ctx);
      let text: string;
      try {
      if (ledger) {
        try { text = await historyGetFromLedger(ledger.sessionPath, ledger.ledger, params.entryId, options); }
        catch {
          return historyWorkerToolResult(await dispatchHistoryWorker(ctx.sessionManager.getSessionFile(), { kind: "get", entryId: params.entryId, options }, transport, _signal), true);
        }
      } else {
        return historyWorkerToolResult(await dispatchHistoryWorker(ctx.sessionManager.getSessionFile(), { kind: "get", entryId: params.entryId, options }, transport, _signal), true);
      }
      } catch (error) {
        if ((error as Error).message === "history-load-memory-limit") return toolText("History unavailable: the bounded load could not be admitted within the local memory budget.", { status: "unavailable", code: "history-load-memory-limit" });
        throw error;
      }
      return toolText(text, { entryId: params.entryId, blockIndex: params.blockIndex });
    },
  });

  pi.registerTool({
    name: "history_search",
    label: "Search History",
    description: "Search source-linked history with bounded relevance, exact or supported regex matching, filters, practical path matching, and bounded snippets. Indexed pages may be smaller than limit to fit tokenBudget; use continuation and reported coverage.",
    parameters: Type.Object({
      query: Type.String({ description: "Terms, literal text, source ID, path, or regular expression" }),
      mode: Type.Optional(Type.Union([Type.Literal("ranked"), Type.Literal("exact"), Type.Literal("regex")])),
      stage: Type.Optional(Type.Union([Type.Literal("cues"), Type.Literal("snippets")])),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      tokenBudget: Type.Optional(Type.Number({ minimum: 120, maximum: 2_000 })),
      cursor: Type.Optional(Type.String()),
      caseSensitive: Type.Optional(Type.Boolean()),
      regex: Type.Optional(Type.Boolean({ description: "Compatibility alias for mode=regex" })),
      fuzzyPath: Type.Optional(Type.Boolean()),
      includeNeighbors: Type.Optional(Type.Boolean()),
      kind: Type.Optional(Type.String()),
      toolName: Type.Optional(Type.String()),
      error: Type.Optional(Type.Boolean()),
      unresolved: Type.Optional(Type.Boolean()),
      currentState: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("superseded"), Type.Literal("any")])),
      scan: Type.Optional(Type.Boolean({ description: "Explicit bounded resumable lexical or supported regex scan; inspect coverage limits" })),
      startMatch: Type.Optional(Type.Number({ minimum: 0, description: "Legacy exact-scan cursor" })),
      contextChars: Type.Optional(Type.Number({ minimum: 40, maximum: 200, description: "Legacy exact-scan context" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (settings().searchIndexEnabled) return search.search(params, _signal);
      if (!reserveFeedback()) return historyWorkerToolResult({ status: "refused", code: "history-feedback-memory-limit" });
      const selectedMode = params.regex ? "regex" : params.mode;
      const indexed = settings().rankedSearchEnabled || selectedMode !== undefined;
      const operation = indexed ? {
        kind: "search" as const, query: params.query, options: {
          mode: selectedMode, stage: params.stage, limit: params.limit, tokenBudget: params.tokenBudget,
          cursor: params.cursor, caseSensitive: params.caseSensitive, fuzzyPath: params.fuzzyPath,
          includeNeighbors: params.includeNeighbors,
          filters: {
            ...(params.kind === undefined ? {} : { kinds: [params.kind as never] }),
            ...(params.toolName === undefined ? {} : { toolNames: [params.toolName] }),
            ...(params.error === undefined ? {} : { error: params.error }),
            ...(params.unresolved === undefined ? {} : { unresolved: params.unresolved }),
            ...(params.currentState === undefined ? {} : { currentState: params.currentState }),
          },
        },
      } : {
        kind: "legacy-search" as const, query: params.query, options: {
          limit: params.limit, startMatch: params.startMatch, caseSensitive: params.caseSensitive,
          regex: params.regex, contextChars: params.contextChars,
        },
      };
      const response = await dispatchHistoryWorker(ctx.sessionManager.getSessionFile(), operation, transport, _signal);
      if (response.status === "ok" && response.feedback) updateRetrievalFeedback(retrievalFeedback, ctx, response.feedback);
      return historyWorkerToolResult(response);
    },
  });

  pi.registerTool({
    name: "history_recall",
    label: "Expand Historical Memory",
    description: "Recall a cue, episode, resource evolution, source-backed state, rollup, or exact block. Coverage is pinned and partial. Rollup: empty query reads the root; pass expand/nextCursor as query with level=rollup. Use recovery handles with history_get.",
    parameters: Type.Object({
      query: Type.String(),
      level: Type.Optional(Type.Union([Type.Literal("cue"), Type.Literal("episode"), Type.Literal("resource"), Type.Literal("state"), Type.Literal("rollup"), Type.Literal("block")])),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      tokenBudget: Type.Optional(Type.Number({ minimum: 120, maximum: 2_000 })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (settings().searchIndexEnabled) {
        if (params.level === "rollup") return search.recallRollup(params.query, params.tokenBudget ?? 2000, _signal);
        if (params.level === "episode" || params.level === "resource" || params.level === "state") return search.recallState(params.query, params.level, params.tokenBudget ?? 2000, _signal);
        if (isSearchReference(params.query)) return search.recall(params.query, undefined, Math.min(2048, (params.tokenBudget ?? 1000) * 2), _signal, params.tokenBudget ?? 2000);
        return search.search({ query: params.query, limit: params.limit, tokenBudget: params.tokenBudget, stage: params.level === "cue" ? "cues" : "snippets" }, _signal);
      }
      if (!reserveFeedback()) return historyWorkerToolResult({ status: "refused", code: "history-feedback-memory-limit" });
      if (params.level === "state" || params.level === "rollup") return toolText("Source-backed state and rollups require the indexed memory path.", { status: "unavailable", code: "search-v3-option-unsupported" });
      const path = ctx.sessionManager.getSessionFile();
      const response = await dispatchHistoryWorker(path, {
        kind: "recall", query: params.query, options: { level: params.level, limit: params.limit, tokenBudget: params.tokenBudget },
        ...(path && settings().memoryOwner === "chrono" && settings().editableMemoryEnabled ? { promotion: { toolCallId, leafId: ctx.sessionManager.getLeafId?.() } } : {}),
      }, transport, _signal);
      // A refusal can include bounded receipts for earlier committed promotions.
      // Mirror those once without retrying the failed recall or sidecar append.
      if (settings().memoryOwner === "chrono") {
        for (const event of response.promotionEvents ?? []) pi.appendEntry("chrono-memory-v2-event", event);
      }
      if (response.status === "ok" && response.feedback) updateRetrievalFeedback(retrievalFeedback, ctx, response.feedback);
      return historyWorkerToolResult(response);
    },
  });

  pi.registerTool({
    name: "history_range",
    label: "Get Exact History Range",
    description: "Return an exact chronological JSONL range, preferring the parent-chain path when the start is an ancestor of the end.",
    parameters: Type.Object({
      startEntryId: Type.String(),
      endEntryId: Type.String(),
      maxEntries: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      cursor: Type.Optional(Type.String({ description: "Pinned indexed range continuation" })),
      shardId: Type.Optional(Type.String({ description: "Exact logical shard ID; ranges never cross shard boundaries" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (settings().searchIndexEnabled) return search.range(params.startEntryId, params.endEntryId, params.maxEntries, params.cursor, _signal, params.shardId);
      const options = { maxEntries: params.maxEntries };
      const ledger = await availableLedger(ctx);
      let text: string;
      try {
      if (ledger) {
        try { text = await historyRangeFromLedger(ledger.sessionPath, ledger.ledger, params.startEntryId, params.endEntryId, options); }
        catch {
          return historyWorkerToolResult(await dispatchHistoryWorker(ctx.sessionManager.getSessionFile(), { kind: "range", startEntryId: params.startEntryId, endEntryId: params.endEntryId, options }, transport, _signal), true);
        }
      } else {
        return historyWorkerToolResult(await dispatchHistoryWorker(ctx.sessionManager.getSessionFile(), { kind: "range", startEntryId: params.startEntryId, endEntryId: params.endEntryId, options }, transport, _signal), true);
      }
      } catch (error) {
        if ((error as Error).message === "history-load-memory-limit") return toolText("History unavailable: the bounded load could not be admitted within the local memory budget.", { status: "unavailable", code: "history-load-memory-limit" });
        throw error;
      }
      return toolText(text, { startEntryId: params.startEntryId, endEntryId: params.endEntryId });
    },
  });
}

function memoryPathForContext(ctx: ExtensionContext): string {
  const sessionPath = ctx.sessionManager.getSessionFile();
  if (!sessionPath) throw new Error("Editable memory requires a persisted session file.");
  return memorySidecarPath(sessionPath);
}

function renderMemoryList(memories: readonly { memoryId: string; text: string; scope: string; authority: string; state: string; sourceRef: string; useCount: number }[]): string {
  if (memories.length === 0) return "No matching remembered knowledge.";
  return [
    `Remembered knowledge: ${memories.length}`,
    ...memories.map((memory) => `- ${memory.memoryId} · ${memory.state} · ${memory.scope} · ${memory.authority} · used ${memory.useCount}\n  ${memory.text}\n  Source: ${memory.sourceRef}`),
  ].join("\n");
}

function registerMemoryTools(pi: ExtensionAPI, settings: () => RuntimeSettings): void {
  const append = async (
    toolCallId: string,
    ctx: ExtensionContext,
    input: { action: MemoryAction; memoryId?: string; text?: string; scope?: string; confidence?: number; reason?: string; supersedesMemoryId?: string },
  ) => {
    if (!settings().editableMemoryEnabled) throw new Error("Editable memory is disabled in ChronoCompact settings.");
    const turn = asEntries(ctx.sessionManager.getBranch()).length;
    const result = await appendMemoryEvent(memoryPathForContext(ctx), {
      ...input,
      timestamp: new Date().toISOString(),
      turn,
      sourceRef: `memory-tool:${toolCallId}`,
      authority: "ordinary",
    });
    const event = result.events[result.events.length - 1]!;
    pi.appendEntry("chrono-memory-v2-event", event);
    return { result, event };
  };

  pi.registerTool({
    name: "memory_remember",
    label: "Remember Working Knowledge",
    description: "Append source-linked ordinary working knowledge. This memory does not gain system authority.",
    parameters: Type.Object({
      text: Type.String(),
      scope: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      supersedesMemoryId: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { event } = await append(toolCallId, ctx, { action: "remember", text: params.text, scope: params.scope, confidence: params.confidence, supersedesMemoryId: params.supersedesMemoryId });
      return toolText(`Remembered ${event.memoryId}. It is ordinary source-linked memory, not authority.`, { memoryId: event.memoryId, eventHash: event.eventHash });
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Update Working Knowledge",
    description: "Append a new value for one ordinary memory without rewriting its event history.",
    parameters: Type.Object({ memoryId: Type.String(), text: Type.String(), scope: Type.Optional(Type.String()), confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { event } = await append(toolCallId, ctx, { action: "update", memoryId: params.memoryId, text: params.text, scope: params.scope, confidence: params.confidence });
      return toolText(`Updated ${event.memoryId} with an append-only event.`, { memoryId: event.memoryId, eventHash: event.eventHash });
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Demote Working Knowledge",
    description: "Demote ordinary memory from active working memory. Source history and memory events are not deleted. Protected authority cannot be demoted.",
    parameters: Type.Object({ memoryId: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { event } = await append(toolCallId, ctx, { action: "forget", memoryId: params.memoryId, reason: params.reason });
      return toolText(`Demoted ${event.memoryId}. Its source and append-only events remain recoverable.`, { memoryId: event.memoryId, eventHash: event.eventHash });
    },
  });

  pi.registerTool({
    name: "memory_promote",
    label: "Promote Remembered Knowledge",
    description: "Temporarily promote an ordinary archived memory after current-task use.",
    parameters: Type.Object({ memoryId: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { event } = await append(toolCallId, ctx, { action: "promote", memoryId: params.memoryId, reason: params.reason });
      return toolText(`Promoted ${event.memoryId} for the next eight turns.`, { memoryId: event.memoryId, eventHash: event.eventHash });
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "List Remembered Knowledge",
    description: "List current or archived source-linked memories.",
    parameters: Type.Object({ scope: Type.Optional(Type.String()), state: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("superseded"), Type.Literal("demoted")])) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await readMemoryEvents(memoryPathForContext(ctx));
      if (result.status !== "ready") throw new Error(`Memory store is unavailable: ${result.error ?? "integrity failure"}`);
      const memories = listMemories(result, { scope: params.scope, state: params.state });
      return toolText(renderMemoryList(memories), { count: memories.length, generationHash: result.generationHash });
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Get Remembered Knowledge",
    description: "Get one current or archived memory with provenance and state.",
    parameters: Type.Object({ memoryId: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await readMemoryEvents(memoryPathForContext(ctx));
      if (result.status !== "ready") throw new Error(`Memory store is unavailable: ${result.error ?? "integrity failure"}`);
      const memory = result.memories.find((candidate) => candidate.memoryId === params.memoryId);
      if (!memory) throw new Error(`Unknown memory: ${params.memoryId}`);
      return toolText(renderMemoryList([memory]), { memoryId: memory.memoryId, generationHash: result.generationHash });
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Search Remembered Knowledge",
    description: "Search active and optional archived remembered knowledge by terms and scope.",
    parameters: Type.Object({ query: Type.String(), scope: Type.Optional(Type.String()), includeDemoted: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await readMemoryEvents(memoryPathForContext(ctx));
      if (result.status !== "ready") throw new Error(`Memory store is unavailable: ${result.error ?? "integrity failure"}`);
      const memories = searchMemories(result, params.query, { scope: params.scope, includeDemoted: params.includeDemoted, limit: params.limit });
      return toolText(renderMemoryList(memories), { query: params.query, count: memories.length, generationHash: result.generationHash });
    },
  });
}

function registerRetentionHintTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "history_retention_hint",
    label: "Record Compaction Retention Hint",
    description: "Record advisory retention priorities before a future ChronoCompact generation. This is metadata, not authoritative history or memory.",
    parameters: Type.Object({
      currentUnresolvedWork: Type.Optional(Type.String()),
      preserveExact: Type.Optional(Type.String()),
      olderEvidenceLikelyNeeded: Type.Optional(Type.String()),
      completedRangesSafeToCompress: Type.Optional(Type.String()),
      abandonedApproaches: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      pi.appendEntry(RETENTION_HINT_CUSTOM_TYPE, params);
      return toolText(
        "Recorded an advisory retention hint for the next ChronoCompact generation. The immutable session JSONL remains authoritative.",
        { recorded: true },
      );
    },
  });
}

/** Private capture after the shared summary and boundary guards pass at idle.
 * The callback owns artifact writes. No compaction entry or resume turn is sent.
 * revalidate() is valid during the callback, including after awaited writes. */
export interface SessionAgentPreviewCapture {
  readonly input: FrozenContextInput;
  readonly compiled: CompiledContext;
  readonly tail: RawTailSelection;
  readonly exactTail: readonly SessionEntryLike[];
  readonly ready: SessionAgentSummaryReady;
  readonly boundary: SessionAgentCompactionBoundary;
  revalidate(): void;
}

/** Explicit load with at most one callback delivery. Requires V4 at factory load.
 * Pin candidate settings so a private loader can restore its environment for the
 * retained old tools. This does not authorize activation or claim cache reuse. */
export interface SessionAgentPreviewOptions {
  readonly sessionId: string;
  readonly sessionFile: string;
  /** Use the intended Pi compaction reserve, not a synthetic prepared summary. */
  readonly reserveTokens: number;
  readonly onReady: (capture: SessionAgentPreviewCapture) => void | Promise<void>;
  readonly onError?: (code: string) => void;
}

export interface HistoryRuntimeAdapters {
  /** Private temporary integration only. Registers request_compaction and its
   * guards, with a native-compaction veto for the entire loaded instance. */
  readonly sessionAgentPreview?: SessionAgentPreviewOptions;
  readonly historyTransport?: HistoryWorkerTransport;
  /** Owner-only rollout sidecars; explicit override for isolated integration. */
  readonly sessionRolloutDirectory?: string;
  /** Explicit isolated namespace for synthetic integration callers only. */
  readonly schedulerDirectory?: string;
  /** Synthetic startup fixture only. Requires schedulerDirectory and starts
   * pending instead of bypassing startup. No runtime configuration can set it. */
  readonly readOnlyStartupVerifier?: () => Promise<boolean>;
  /** Synthetic-only, synchronous prepared target. Caller retains the physical
   * identity and actual pinned M04 view; this callback must not ingest or read
   * source bodies. Requires an explicit isolated schedulerDirectory. */
  readonly capsuleShadowTarget?: (context: ExtensionContext) => CapsuleShadowTarget | undefined;
  /** Synthetic hook fixture only. It requires schedulerDirectory and cannot enable
   * the installed/runtime-configured path. */
  readonly normalCompositionFixture?: {
    readonly createPiSummary: typeof createPiRegularSummary;
    readonly compose: typeof composeStoredCompactionForNormalReturn;
  };
}
export default function chronoCompactExtension(pi: ExtensionAPI, adapters: HistoryRuntimeAdapters = {}): void {
  const preview = adapters.sessionAgentPreview ? Object.freeze({ ...adapters.sessionAgentPreview }) : undefined;
  let previewDelivered = false;
  if (!preview) pi.registerFlag?.("chrono-canary-session", { type: "string", description: "Authorize guarded composition only in this exact fresh session ID. No inherited activation." });
  // CLI flag values are assigned after extension factories finish loading.
  let canary = new SessionCanary(undefined);
  let canaryControlInitialized = false;
  const userConfigPath = defaultUserConfigPath();
  const loadedUserConfig = loadUserConfig(userConfigPath);
  let userConfig = loadedUserConfig.config;
  let userConfigWarning = loadedUserConfig.warning;
  // Registration, promotion dispatch/mirroring and pinned reads share ONE owner.
  // Settings changes cannot hand this ownership over until extension reload.
  const initialSettings = resolveExtensionSettings(userConfig);
  const memoryOwner = initialSettings.memoryOwner;
  const previewSettings = preview ? Object.freeze({ ...initialSettings,
    editableMemoryEnabled: memoryOwner === "chrono" && initialSettings.editableMemoryEnabled }) : undefined;
  const validatePreview = (ctx: ExtensionContext): void => {
    if (!preview) return;
    if (!preview.sessionId || !preview.sessionFile || typeof preview.onReady !== "function"
      || !Number.isSafeInteger(preview.reserveTokens) || preview.reserveTokens <= 0
      || previewSettings?.contextCompiler !== "v4") throw new Error("session-agent-summary-preview-options-invalid");
    if (ctx.sessionManager.getSessionId() !== preview.sessionId || ctx.sessionManager.getSessionFile() !== preview.sessionFile) {
      throw new Error("session-agent-summary-preview-target-mismatch");
    }
  };
  const search = new HistorySearchAdapter({ schedulerDirectory: adapters.schedulerDirectory, slots: resolveExtensionSettings(userConfig).hostWorkerSlots });
  // Only an exact session/source sidecar can opt this session in persistently.
  // Ordinary extension loading reads it; history queries never read or write it.
  const sessionRolloutDirectory = adapters.sessionRolloutDirectory ?? join(dirname(userConfigPath), "chrono-session-rollouts");
  const logicalSessionRoot = join(dirname(userConfigPath), "chrono-logical-sessions");
  const intervalHelpers = createIntervalHelperRuntime({ getConfig: () => userConfig.historyHelpers,
    archiveDirectory: join(dirname(userConfigPath), "chrono-interval-archives") });
  let helperPreparationKey: string | undefined;
  let intervalBudgetStatus: unknown;
  // Content-free, source-bound observation. A prepared plan is not a committed packet.
  let intervalLastPlan: { snapshotId: string; partition: ReturnType<typeof planIntervalContext>["partition"] } | undefined;
  let intervalHelperFailure: string | undefined;
  let logicalGrant: LogicalActivationGrant | undefined;
  let logicalSwitchActive = false;
  let automaticRolloverStatus: Record<string, unknown> = { state: "idle" };
  let lastCompositionFailure: { stage: string; code: string } | undefined;
  let committedReceipt: ContextReceiptLocator | undefined;
  let receiptLookupEntries = 0, receiptLookupComplete = false;
  let compilerTerminal: { state: "returned" | "committed" | "failed" | "uncorrelated"; receiptId?: string; code?: string } | undefined;
  let pendingCompiler: { epoch: number; sessionId: string; sourcePath: string | undefined; leafId: string | null;
    receiptId: string; summaryHash: string; signal?: AbortSignal; interval?: IntervalSourceSnapshot; historyConfigKey?: string;
    summaryEpoch?: number; budgetKey?: string; expectedReceipt?: CompiledContext["receipt"] } | undefined;
  const restoreReceiptLocator = (ctx: ExtensionContext): void => {
    committedReceipt = undefined;
    receiptLookupEntries = 0;
    let id = ctx.sessionManager.getLeafId();
    while (id && receiptLookupEntries < CONTEXT_COMPILER_LIMITS.locatorEntries) {
      receiptLookupEntries++;
      const entry = ctx.sessionManager.getEntry(id);
      if (!entry) break;
      committedReceipt = contextReceiptLocator(entry, ctx.sessionManager.getSessionId());
      if (committedReceipt) break;
      id = entry.parentId;
    }
    receiptLookupComplete = !!committedReceipt || !id;
  };
  let automaticRolloverTimer: ReturnType<typeof setTimeout> | undefined;
  let automaticRolloverTicket: { nonce: string; sessionId: string; sourcePath: string; leafId: string; epoch: number } | undefined;
  let automaticRolloverAttemptedLeaf: string | undefined;
  let automaticRolloverBootstrapBytes = 0;
  let sessionSearchOverride: boolean | undefined;
  let sessionRolloutPersisted = false;
  let rolloutEpoch = 0;
  let rolloutError: string | undefined;
  const readOnlyStartupVerifier = adapters.schedulerDirectory ? adapters.readOnlyStartupVerifier : undefined;
  let startupStatus: WorkerStartupStatus = { state: adapters.schedulerDirectory && !readOnlyStartupVerifier ? "ready" : "pending" };
  let startupContext: ExtensionContext | undefined;
  let deferredCompactionSearch: { epoch: number; sessionId: string; sourcePath: string | undefined } | undefined;
  const usesStoredComposition = (ctx: ExtensionContext): boolean => resolveExtensionSettings(userConfig).contextCompiler === "v4" || resolveExtensionSettings(userConfig).memoryEngineEnabled
    || canary.requested(ctx.sessionManager.getSessionId()) || !!(adapters.schedulerDirectory && adapters.normalCompositionFixture);
  const searchSettings = (): ReturnType<typeof resolveExtensionSettings> => {
    if (previewSettings) return previewSettings;
    const settings = resolveExtensionSettings(userConfig);
    // An explicit environment/config disable takes precedence over rollout.
    const explicit = configuredValue("PI_CHRONO_SEARCH_INDEX", userConfig.searchIndexEnabled);
    const disabled = explicit !== undefined && !booleanSetting("PI_CHRONO_SEARCH_INDEX", false, userConfig.searchIndexEnabled);
    return { ...settings, memoryOwner, editableMemoryEnabled: memoryOwner === "chrono" && settings.editableMemoryEnabled,
      searchIndexEnabled: disabled ? false : (sessionSearchOverride ?? (settings.memoryEngineEnabled || settings.searchIndexEnabled)) };
  };
  const searchStatus = (): Record<string, unknown> => ({ ...search.status(),
    migration: sessionMigrationStatus({ enabled: searchSettings().memoryEngineEnabled,
      searchEnabled: searchSettings().searchIndexEnabled, startup: startupStatus.state,
      unsafe: !!rolloutError, progress: search.status() }),
    composition: { mode: searchSettings().contextCompiler === "v4" ? "v4" : searchSettings().memoryEngineEnabled ? "v3" : "compatibility",
      memoryOwner: { captured: memoryOwner, configured: resolveExtensionSettings(userConfig).memoryOwner,
        reloadRequired: resolveExtensionSettings(userConfig).memoryOwner !== memoryOwner },
      lastRefusal: canary.refusal ?? null, lastFailure: lastCompositionFailure ?? null,
      committedReceipt: committedReceipt ?? null, terminal: compilerTerminal ?? null,
      sessionSummary: sessionSummary ? { state: sessionSummary.boundary ? "ready" : sessionSummary.accepted ? "accepted"
        : sessionSummary.consumed ? "consumed" : sessionSummary.delivery, requestId: sessionSummary.request.requestId,
        expiresAt: sessionSummary.request.expiresAt } : { state: "idle" },
      ...(searchSettings().contextCompiler === "v4" ? {
        interval: { policyIdentity: INTERVAL_POLICY.identity,
          host: { loadedVersion: PI_HOST_VERSION, minimumVersion: "1.1.0", versionSupported: intervalHostVersionSupported },
          budget: intervalBudgetStatus ?? null, lastPreparedPlan: intervalLastPlan ?? null,
          snapshotId: sessionSummary?.interval.identity ?? pendingRecovery?.interval.identity ?? null,
          preparation: intervalPreparation ? { startedAt: intervalPreparation.startedAt, turns: intervalPreparation.turns } : null,
          recovery: pendingRecovery ? { state: "proposed", operationId: pendingRecovery.operationId,
            authorship: pendingRecovery.authorship,
            receiptId: pendingRecovery.compiled.receipt.receiptId, nativeContinue: pendingRecovery.nativeContinue }
            : recoveryIntent ? { state: "awaiting-public-boundary", reason: recoveryIntent.reason } : { state: "idle", used: recoveryUsed },
          continuation: compactionResume?.record ?? null, helpers: intervalHelpers.status(), helperFailure: intervalHelperFailure ?? null },
        providerBarrier: { state: pendingRecovery || recoveryIntent ? "recovery-only" : sessionSummary ? "summary-only" : compactionRetryPaused ? "paused" : "open",
          retryPaused: compactionRetryPaused, recoveryRequested: summaryRecoveryRequested,
          release: "correlated-commit", recovery: "direct user input, explicit /compact, or freshly admitted request_compaction({})" },
      } : {}),
      receiptLookup: { entries: receiptLookupEntries, complete: receiptLookupComplete } },
    automaticRollover: { ...automaticRolloverStatus, enabled: searchSettings().automaticRolloverEnabled,
      sourceByteThreshold: searchSettings().rolloverSourceBytes, bootstrapBytes: automaticRolloverBootstrapBytes,
      effectiveSourceByteThreshold: automaticRolloverBootstrapBytes + searchSettings().rolloverSourceBytes },
    loaded: LOADED_RUNTIME_IDENTITY,
    enabled: searchSettings().searchIndexEnabled,
    canary: { active: startupContext ? canary.active(startupContext.sessionManager.getSessionId(), startupContext.sessionManager.getSessionFile()) : false, refusal: canary.refusal },
    rollout: { persisted: sessionRolloutPersisted, enabled: searchSettings().searchIndexEnabled },
    startup: { ...startupStatus },
    ...((rolloutError ?? startupStatus.errorCode) ? { lastSafeError: rolloutError ?? startupStatus.errorCode } : {}) });
  const canRetryReadOnlyStartup = (ctx: ExtensionContext): boolean => startupStatus.state === "unavailable"
    && startupStatus.errorCode === "worker-legacy-transition-required"
    && !canary.requested(ctx.sessionManager.getSessionId())
    && !!logicalGrant?.searchRoutes.some(route => route.shardId === logicalGrant?.activeShardId && route.ordinal > 0);
  const scheduleSearch = (ctx: ExtensionContext): void => {
    if (!searchSettings().searchIndexEnabled) { search.disable(); return; }
    if (startupStatus.state !== "ready") {
      // A follower can observe admission established after its initial check.
      // Pending replacements, canaries, and other startup refusals cannot retry.
      if (canRetryReadOnlyStartup(ctx)) beginStartup(ctx);
      search.cancel();
      return;
    }
    const sourcePath = ctx.sessionManager.getSessionFile();
    const leafId = ctx.sessionManager.getLeafId?.();
    if (!sourcePath || !leafId) { search.cancel(); return; }
    // Keep the validated maintained target until this V3 request settles.
    if (deferredCompactionSearch?.epoch === rolloutEpoch) return;
    const sessionKey = createHash("sha256").update("pi-session-v1\0").update(ctx.sessionManager.getSessionId()).digest("hex");
    const shardKey = createHash("sha256").update("pi-jsonl-v1\0").update(sourcePath).digest("hex");
    search.schedule({ sourcePath, sessionKey, shardKey, leafId, catalogDirectory: join(dirname(sourcePath), ".chrono-catalog", sessionKey) });
    if (logicalGrant) search.scheduleLogical(logicalGrant);
  };
  const beginStartup = (ctx: ExtensionContext): void => {
    startupContext = ctx;
    if (startupStatus.state !== "pending" && !canRetryReadOnlyStartup(ctx)) return;
    startupStatus = { state: "running" };
    // A logical replacement or isolated canary can reuse an existing host policy.
    // Neither path initializes a second pool or recovers admission state as a load side effect.
    const readOnlyStartup = !!logicalGrant?.searchRoutes.some(route => route.shardId === logicalGrant?.activeShardId && route.ordinal > 0)
      || canary.requested(ctx.sessionManager.getSessionId());
    const startup: Promise<WorkerStartupStatus> = readOnlyStartup
      ? (readOnlyStartupVerifier ?? verifyLegacyAdmissionGate)().then(ready => ready
        ? { state: "ready", changed: false }
        : { state: "unavailable", errorCode: "worker-legacy-transition-required" })
      : startAuthorizedWorkerRuntime(startupAuthorizationPath(userConfigPath));
    // Do not await this from a Pi hook: the child has its own bounded deadline.
    void startup.then(status => {
      startupStatus = status;
      if (status.state === "ready" && startupContext) scheduleSearch(startupContext);
    });
  };
  const capsuleShadow = createContainedCapsuleShadow({ schedulerDirectory: adapters.schedulerDirectory });
  let capsuleTargetRefused = false;
  const scheduleCapsuleShadow = (ctx: ExtensionContext): void => {
    capsuleTargetRefused = false;
    if (!adapters.schedulerDirectory || !adapters.capsuleShadowTarget) { capsuleShadow.disable(); return; }
    try {
      const target = adapters.capsuleShadowTarget(ctx);
      if (target) capsuleShadow.schedule(target, true);
      else capsuleShadow.cancel();
    } catch {
      search.cancel();
    capsuleShadow.cancel();
      capsuleTargetRefused = true;
    }
  };
  const capsuleStatusText = (): string => {
    const status = capsuleShadow.status();
    const readiness = status.readiness;
    return `Capsule shadow: ${capsuleTargetRefused ? "target-refused" : status.state}. Synthetic prepared targets only; no model-facing change.`
      + (readiness ? ` Capsules: ${readiness.capsules.state} (${readiness.capsules.ready}/${readiness.capsules.eligible}); chunks: ${readiness.chunks.state} (${readiness.chunks.ready}/${readiness.chunks.eligible}).` : "")
      + (status.errorCode ? ` Safe refusal: ${status.errorCode}.` : "");
  };
  const catalogShadow = new CatalogShadowScheduler(async (target, signal) => {
    const response = await runCatalogWorker({ v: 1, op: "ingestStep", ...target, branchKey: "pi-session", shardOrdinal: 0 }, {
      signal, slots: resolveExtensionSettings(userConfig).hostWorkerSlots, schedulerDirectory: adapters.schedulerDirectory,
    });
    if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code });
    if (typeof response.result.error === "string") throw Object.assign(new Error("catalog-ingest-refused"), { code: response.result.error });
    if (typeof response.result.caughtUp !== "boolean" || !Number.isSafeInteger(response.result.records)) throw new Error("catalog-response-invalid");
    return { complete: response.result.caughtUp, events: response.result.records as number, sourceBytesRead: response.sourceBytes, waitingForAppend: response.result.incompleteTail === true };
  });
  const scheduleCatalogShadow = (ctx: ExtensionContext): void => {
    const settings = resolveExtensionSettings(userConfig);
    if (searchSettings().searchIndexEnabled || !settings.catalogShadowEnabled) { catalogShadow.disable(); return; }
    const sourcePath = ctx.sessionManager.getSessionFile();
    if (!sourcePath) { catalogShadow.cancel(); return; }
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionKey = createHash("sha256").update("pi-session-v1\0").update(sessionId).digest("hex");
    const shardKey = createHash("sha256").update("pi-jsonl-v1\0").update(sourcePath).digest("hex");
    catalogShadow.schedule({ sourcePath, sessionKey, shardKey, catalogDirectory: join(dirname(sourcePath), ".chrono-catalog", sessionKey) }, true);
  };
  const retrievalFeedback = new Map<string, RetrievalFeedback>();
  const feedbackAdmission = createHistoryFeedbackAdmission();
  let triggerPending = false;
  let lastTriggerAttemptTokens: number | undefined;
  let forcedCompactionReason: string | undefined;
  let forcedContinuationPending = false;
  let continueAfterSuccessfulCompaction = false;
  let ownedCompaction: { epoch: number; sessionId: string; sourcePath: string | undefined; leafId: string | null | undefined;
    resumeAfter: boolean; signal?: AbortSignal; succeeded?: boolean; failure?: { stage: string; code: string } } | undefined;
  // V4 failures suspend ordinary provider work, including throughout recovery.
  // Only a correlated commit releases this latch. V3 keeps its retry-pause policy.
  let compactionRetryPaused = false;
  let summaryRecoveryRequested = false;
  let summaryInputIntent: { scope: SessionAgentSummaryScope; createdAt: number; expiresAt: number } | undefined;
  // No aborted-run summary intent is restored or retried automatically.
  let providerAdmission: { scope: SessionAgentSummaryScope; requestId?: string } | undefined;
  let summaryEpoch = 0;
  type ActiveSessionSummary = { request: SessionAgentSummaryRequest; delivery: "deferred" | "sent"; deferrals: number; resumeAfter: boolean;
    interval: IntervalSourceSnapshot; logicalSource?: LogicalIntervalSourceManifest; historyConfigKey: string;
    consumed?: SessionAgentSummaryConsumedRequest; accepted?: SessionAgentSummaryAccepted;
    boundary?: SessionAgentCompactionBoundary; signal?: AbortSignal; removeAbortListener?: () => void; previewCapturing?: boolean };
  let sessionSummary: ActiveSessionSummary | undefined;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  let summaryDeferral: { epoch: number; requestId?: string; reason: string; signal: AbortSignal; awaitingInput?: boolean } | undefined;
  let compactionResume: { scope: SessionAgentSummaryScope; expiresAt: number; signal?: AbortSignal;
    receiptId: string; summaryHash: string; record: IntervalContinuationRecord } | undefined;
  // Only observed live work can supply V4 continuation eligibility. This state
  // is not reconstructed from old assistant output or open native task records.
  let originalRun: { binding: string; inLoop: boolean; hasInput: boolean; unresolved: boolean } | undefined;
  let inputPending = false;
  let intervalSourcePin: LogicalIntervalSourcePin | undefined;
  let intervalSourceSnapshot: IntervalSourceSnapshot | undefined;
  let intervalPreparation: { binding: string; startedAt: number; turns: number } | undefined;
  let intervalGrowthTokens = 0;
  let lastIntervalRequestTokens: number | undefined;
  let recoveryUsed = false;
  let recoveryIntent: { scope: SessionAgentSummaryScope; createdAt: number; expiresAt: number; reason: string } | undefined;
  let pendingRecovery: { scope: SessionAgentSummaryScope; parentId: string; operationId: string; expiresAt: number;
    interval: IntervalSourceSnapshot; compiled: CompiledContext; historyConfigKey: string;
    authorship: "current-agent" | "deterministic-recovery";
    resumeAfter: boolean; nativeContinue: boolean; allowArchive: boolean; signal?: AbortSignal } | undefined;
  const originalRunBinding = (ctx: ExtensionContext): string => stableStringify({
    sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), epoch: summaryEpoch,
    model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api, thinkingLevel: ctx.thinkingLevel ?? "off" },
  });
  const captureOriginalContinuation = (ctx: ExtensionContext, reason: SessionAgentSummaryRequest["reason"]): boolean => {
    if (inputPending || ctx.hasPendingMessages() || ctx.signal?.aborted) return false;
    // The currently executing model-issued request interrupts its own turn.
    if (reason === "tool") return true;
    return !ctx.isIdle() && originalRun?.binding === originalRunBinding(ctx)
      && originalRun.hasInput && originalRun.unresolved;
  };
  const observeOriginalTurn = (ctx: ExtensionContext, message: { role: string; stopReason?: string }): void => {
    if (sessionSummary || !originalRun || originalRun.binding !== originalRunBinding(ctx) || message.role !== "assistant") return;
    // A stop in the one runtime-requested preparation response is not a task
    // completion signal. Preserve only the previously observed unfinished run.
    // Aborts, new input, and scope changes still invalidate continuation.
    const preparationStop = message.stopReason === "stop" && intervalPreparation?.binding === originalRun.binding
      && intervalPreparation.turns < INTERVAL_POLICY.maxPreparationTurns;
    if (!preparationStop) originalRun.unresolved = ["toolUse", "length", "error", "deferred"].includes(message.stopReason ?? "");
  };
  let warningLevel = 0;
  let incrementalStore: CandidateSegmentStore | undefined;
  let historyLedger: { sessionPath: string; ledger: SourceLedger } | undefined;
  let incrementalAbort: AbortController | undefined;
  let incrementalTimer: ReturnType<typeof setTimeout> | undefined;
  let incrementalGeneration = 0;
  let incrementalStatus: Record<string, unknown> = { state: "disabled" };
  let shadowAbort: AbortController | undefined;
  let shadowTimer: ReturnType<typeof setTimeout> | undefined;
  let shadowGeneration = 0;
  let shadowStatus: Record<string, unknown> = { state: "disabled" };
  let valueWorkerAbort: AbortController | undefined;
  let valueWorkerStatus: ValueWorkerRunResult | { status: string } = { status: "off" };
  let valueWorkerActive = false;
  let valueWorkerRerun = false;
  let valueWorkerCompactionGate = false;
  let legacyHistoryEditorWarningShown = false;
  let projectionSeenToolCallIds = new Set<string>();
  let projectionState: { pending: boolean; snapshot?: ToolResultProjectionSnapshot } = { pending: false };
  let lastProjectionMetrics: ToolResultProjectionMetrics | undefined;
  let replayWorkerStatus: Record<string, unknown> = { state: "idle" };

  const availableHistoryLedger = async (ctx: ExtensionContext): Promise<{ sessionPath: string; ledger: SourceLedger } | undefined> => {
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) { historyLedger = undefined; return undefined; }
    const sidecar = sourceLedgerPath(sessionPath);
    if (await sourceLedgerIsBusy(sidecar)) return undefined;
    const candidateLedger = incrementalStore?.sessionPath === sessionPath ? incrementalStore.ledger : undefined;
    if (candidateLedger && await sourceLedgerMatchesSource(sessionPath, candidateLedger)) return historyLedger = { sessionPath, ledger: candidateLedger };
    if (historyLedger?.sessionPath === sessionPath && await sourceLedgerMatchesSource(sessionPath, historyLedger.ledger)) return historyLedger;
    try {
      const ledger = await loadSourceLedger(sessionPath, sidecar);
      if (!await sourceLedgerMatchesSource(sessionPath, ledger)) return undefined;
      return historyLedger = { sessionPath, ledger };
    } catch { return undefined; }
  };
  if (!preview) {
    registerHistoryTools(pi, searchSettings, retrievalFeedback, availableHistoryLedger, adapters.historyTransport ?? createHistoryRuntimeTransport({ slots: () => resolveExtensionSettings(userConfig).hostWorkerSlots, schedulerDirectory: adapters.schedulerDirectory }), feedbackAdmission.reserve, search);
    if (memoryOwner === "chrono") registerMemoryTools(pi, searchSettings);
    registerRetentionHintTool(pi);
  }

  const incrementalConfig = (settings: RuntimeSettings): CompactorConfig => resolveCompactorConfig({
    ...settings.config,
    targetTokens: 4_000,
    minSummaryTokens: settings.minSummaryTokens,
    maxSummaryTokens: settings.maxSummaryTokens,
    enableSemanticCompression: false,
  });

  const cancelIncrementalWork = (clearCheckpoint: boolean): void => {
    incrementalGeneration += 1;
    if (incrementalTimer) clearTimeout(incrementalTimer);
    incrementalTimer = undefined;
    incrementalAbort?.abort(new Error("ChronoCompact incremental work was cancelled for session state replacement."));
    incrementalAbort = undefined;
    if (clearCheckpoint) incrementalStore = undefined;
  };

  const cancelValueWorker = (): void => {
    valueWorkerRerun = false;
    valueWorkerAbort?.abort(new Error("Value worker cancelled for session state replacement."));
    valueWorkerAbort = undefined;
  };

  const scheduleValueWorker = (ctx: ExtensionContext, store: CandidateSegmentStore): void => {
    const settings = resolveExtensionSettings(userConfig);
    if (valueWorkerCompactionGate) { valueWorkerStatus = { status: "paused-for-compaction" }; return; }
    if (settings.valueWorker.mode === "off") { cancelValueWorker(); valueWorkerStatus = { status: "off" }; return; }
    if (!settings.incrementalPrecomputeEnabled) { valueWorkerStatus = { status: "candidate-store-required" }; return; }
    if (valueWorkerActive) { valueWorkerRerun = true; return; }
    valueWorkerActive = true; valueWorkerStatus = { status: "scheduled" };
    const controller = new AbortController(); valueWorkerAbort = controller;
    queueMicrotask(() => {
      if (valueWorkerCompactionGate || controller.signal.aborted) { valueWorkerActive = false; if (valueWorkerAbort === controller) valueWorkerAbort = undefined; return; }
      void runValueWorker({ ctx, settings: settings.valueWorker, store, signal: controller.signal }).then((result) => { valueWorkerStatus = result; }).catch(() => { if (!controller.signal.aborted) valueWorkerStatus = { status: "unknown-value-worker-failure" }; }).finally(() => { valueWorkerActive = false; if (valueWorkerAbort === controller) valueWorkerAbort = undefined; if (valueWorkerRerun && !controller.signal.aborted && !valueWorkerCompactionGate) { valueWorkerRerun = false; scheduleValueWorker(ctx, store); } });
    });
  };

  const scheduleIncrementalWork = (ctx: ExtensionContext): void => {
    const settings = resolveExtensionSettings(userConfig);
    // V3 maintains checkpointed derived stores through the indexed scheduler.
    // Do not also reconstruct the legacy candidate store for the same session.
    if (settings.contextCompiler === "v4" || settings.memoryEngineEnabled || !settings.incrementalPrecomputeEnabled) {
      cancelIncrementalWork(true);
      incrementalStatus = { state: "disabled" };
      return;
    }
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) {
      incrementalStatus = { state: "refused", reason: "session path unavailable" };
      return;
    }
    cancelIncrementalWork(false);
    const generation = incrementalGeneration;
    const controller = new AbortController();
    incrementalAbort = controller;
    const config = incrementalConfig(settings);
    const store = incrementalStore?.sessionPath === sessionPath ? incrementalStore : createCandidateSegmentStore(sessionPath);
    incrementalStore = store;
    incrementalStatus = { state: "scheduled" };
    incrementalTimer = setTimeout(() => {
      incrementalTimer = undefined;
      void (async () => {
        try {
          if (!store.manifest) await loadCandidateSegmentManifest(store);
          if (settings.isolatedWorkerEnabled) {
            const request: CandidateUpdateWorkerRequest = { schemaVersion: 1, jobId: randomUUID(), jobType: "candidate-store-update", sessionPath,
              expectedSource: await workerSourceExpectation(sessionPath), deadlineMs: Date.now() + settings.workerTimeoutSeconds * 1_000,
              niceLevel: settings.workerNiceLevel, config };
            const worker = await runCompactionWorker(request, { schedulerDirectory: adapters.schedulerDirectory, slots: settings.hostWorkerSlots, workerTimeoutMs: settings.workerTimeoutSeconds * 1_000,
              schedulerTimeoutMs: settings.workerTimeoutSeconds * 1_000, signal: controller.signal, priority: "low" });
            if (controller.signal.aborted || generation !== incrementalGeneration) return;
            if (worker.response.status !== "ok" || !worker.response.candidateUpdate) {
              incrementalStatus = { state: "fallback", failureCode: worker.response.status === "failed" ? worker.response.failureCode : "worker-protocol-error", worker: worker.clientMetrics };
              return;
            }
            await loadCandidateSegmentManifest(store); incrementalStore = store;
            incrementalStatus = { state: "ready", ...worker.response.candidateUpdate, worker: worker.clientMetrics, workerRuntime: worker.response.metrics };
            scheduleValueWorker(ctx, store);
          } else {
            const metrics = await updateCandidateSegmentStore(store, config, { signal: controller.signal });
            if (controller.signal.aborted || generation !== incrementalGeneration) return;
            incrementalStore = store; incrementalStatus = { state: "ready", ...metrics };
            scheduleValueWorker(ctx, store);
          }
        } catch (error) {
          if (!controller.signal.aborted) incrementalStatus = { state: "fallback", reason: safeErrorMessage(error) };
        } finally {
          if (incrementalAbort === controller) incrementalAbort = undefined;
        }
      })();
    }, 35);
  };

  const cancelShadowWork = (): void => {
    shadowGeneration += 1;
    if (shadowTimer) clearTimeout(shadowTimer);
    shadowTimer = undefined;
    shadowAbort?.abort(new Error("ChronoCompact shadow work was cancelled for session state replacement."));
    shadowAbort = undefined;
  };

  const scheduleRollupShadow = (input: {
    sessionPath: string;
    branchLeafId: string;
    firstKeptEntryId: string;
    currentReplayText: string;
    hardTokenBound: number;
    targetTokenBound: number;
    retentionHints: string;
    settings: RuntimeSettings;
  }): void => {
    if (!input.settings.rollupShadowEnabled) {
      cancelShadowWork();
      shadowStatus = { state: "disabled" };
      return;
    }
    cancelShadowWork();
    const generation = shadowGeneration;
    const controller = new AbortController();
    shadowAbort = controller;
    shadowStatus = { state: "pending" };
    shadowTimer = setTimeout(() => {
      shadowTimer = undefined;
      void (async () => {
        try {
          const request: RollupShadowWorkerRequest = {
            schemaVersion: 1,
            jobId: randomUUID(),
            jobType: "rollup-shadow",
            sessionPath: input.sessionPath,
            expectedSource: await workerSourceExpectation(input.sessionPath),
            deadlineMs: Date.now() + input.settings.workerTimeoutSeconds * 1_000,
            niceLevel: input.settings.workerNiceLevel,
            branchLeafId: input.branchLeafId,
            firstKeptEntryId: input.firstKeptEntryId,
            currentReplayText: input.currentReplayText,
            hardTokenBound: input.hardTokenBound,
            targetTokenBound: input.targetTokenBound,
            retentionHints: input.retentionHints,
          };
          const execution = await runCompactionWorker(request, {
            schedulerDirectory: adapters.schedulerDirectory,
            slots: input.settings.hostWorkerSlots,
            workerTimeoutMs: input.settings.workerTimeoutSeconds * 1_000,
            schedulerTimeoutMs: input.settings.workerTimeoutSeconds * 1_000,
            signal: controller.signal,
            priority: "low",
          });
          if (controller.signal.aborted || generation !== shadowGeneration) return;
          if (execution.response.status !== "ok" || !execution.response.shadow) {
            shadowStatus = {
              state: "failed",
              failureCode: execution.response.status === "failed" ? execution.response.failureCode : "worker-protocol-error",
            };
            return;
          }
          shadowStatus = {
            state: "ready",
            safeStatus: execution.response.shadow.safeStatus,
            generation: execution.response.shadow.generation,
            client: execution.clientMetrics,
          };
        } catch (error) {
          if (!controller.signal.aborted) shadowStatus = { state: "failed", reason: safeErrorMessage(error) };
        } finally {
          if (shadowAbort === controller) shadowAbort = undefined;
        }
      })();
    }, 0);
  };

  const clearSessionSummary = (preserveValidatedSource = false): void => {
    summaryEpoch++;
    const ownedSummaryGate = !!sessionSummary || !!summaryInputIntent || !!pendingRecovery || !!recoveryIntent;
    sessionSummary?.removeAbortListener?.();
    sessionSummary = undefined;
    summaryInputIntent = undefined;
    if (!preserveValidatedSource) {
      intervalSourcePin = undefined;
      intervalSourceSnapshot = undefined;
    }
    pendingRecovery = undefined;
    recoveryIntent = undefined;
    intervalPreparation = undefined;
    summaryRecoveryRequested = false;
    providerAdmission = undefined;
    summaryDeferral = undefined;
    if (ownedSummaryGate) {
      valueWorkerCompactionGate = false;
      intervalHelpers.invalidate();
      helperPreparationKey = undefined;
    }
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    compactionResume = undefined;
    originalRun = undefined;
  };
  const refuseSessionSummary = (ctx: ExtensionContext, error: unknown): void => {
    const code = safeCompositionFailureCode(error);
    clearSessionSummary();
    compactionRetryPaused = true;
    lastCompositionFailure = { stage: "session-summary", code };
    compilerTerminal = { state: "failed", code };
    if (preview) {
      // A private observer failure must not cause a native fallback or a retry.
      try { preview.onError?.(code); } catch { /* No public output or fallback. */ }
    } else if (ctx.hasUI) ctx.ui.notify(`Session-agent compaction refused (${code}). Source history is unchanged. Ordinary model work is paused. Direct user input or /compact can request one freshly admitted summary-only retry.`, "warning");
    if (!ctx.isIdle()) ctx.abort();
  };
  const summaryObservation = (ctx: ExtensionContext) => {
    validatePreview(ctx);
    return { scope: sessionSummaryScope(ctx, summaryEpoch), now: Date.now(),
      getEntry: (id: string) => ctx.sessionManager.getEntry(id) as SessionEntryLike | undefined };
  };
  const watchSummaryAbort = (ctx: ExtensionContext, state: NonNullable<typeof sessionSummary>, signal: AbortSignal | undefined): void => {
    if (!signal || state.signal === signal) return;
    state.removeAbortListener?.();
    state.signal = signal;
    const onAbort = () => { if (sessionSummary === state) refuseSessionSummary(ctx, new Error("session-agent-summary-request-interrupted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    state.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  };
  const summaryRequestLayers = (ctx: ExtensionContext) => {
    const budget = captureIntervalRuntimeBudget(pi, ctx);
    const layers = deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
      toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens });
    if (!layers.available) throw new Error(`context-v4-${layers.reasons[0] ?? "interval-policy-unavailable"}`);
    return layers;
  };
  const summaryTriggerLimit = (ctx: ExtensionContext): number =>
    summaryRequestLayers(ctx).requestBoundTokens - Math.ceil(SESSION_AGENT_SUMMARY_LIMITS.promptBytes / 4) - 32;
  const currentRequestBudget = (ctx: ExtensionContext, messages?: readonly unknown[], observedTokens = 0) => {
    // Ask Pi for its current compaction-aware projection only. Do not read the
    // source file, lifetime bodies or native-state stores to estimate a request.
    const model = ctx.model;
    if (!model || !Number.isFinite(observedTokens) || observedTokens < 0) throw new Error("session-agent-summary-headroom-unavailable");
    // Use the public edit-aware projection. The loaded-host guard rejects hosts
    // that cannot provide it before V4 admission.
    const manager = ctx.sessionManager as typeof ctx.sessionManager & { buildSessionProjection?: () => { messages: readonly unknown[] } };
    const nativeMessages = manager.buildSessionProjection?.().messages ?? manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
    const budget = estimateCurrentRequestBudget({ messages: messages ?? nativeMessages, nativeMessages,
      systemPrompt: ctx.getSystemPrompt(), activeTools: pi.getActiveTools(), allTools: pi.getAllTools(), nativeTokens: ctx.getContextUsage()?.tokens });
    return { ...budget, tokens: Math.max(budget.tokens, observedTokens) };
  };
  const requireExpandedRestartBudget = (ctx: ExtensionContext, compiled: CompiledContext): void => {
    const restart = compiled.receipt.restart, model = ctx.model;
    if (!restart || !model) throw new Error("context-v4-restart-binding-invalid");
    // This is a would-be public packet, not an actual compaction entry. Reuse
    // the exact C/continuation conversion, and never calibrate against old-prefix
    // usage. System, active schemas and framing are charged in this one estimate.
    const messages = [{ role: "compactionSummary", summary: compiled.summary, tokensBefore: 0, timestamp: 0 },
      ...intervalRestartContentMessages(restart)];
    const tokens = estimateCurrentRequestTokens({ messages,
      systemPrompt: ctx.getSystemPrompt(), activeTools: pi.getActiveTools(), allTools: pi.getAllTools() });
    const budget = compiled.receipt.budget;
    const layers = deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
      toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens,
      effectiveAvailableTokens: budget.effectiveCeilingTokens });
    if (!layers.available) throw new Error(`context-v4-${layers.reasons[0] ?? "interval-policy-unavailable"}`);
    const overhead = budget.systemTokens + budget.toolSchemaTokens + budget.framingTokens;
    const bound = Math.min(layers.requestBoundTokens, layers.effectiveAvailableTokens + overhead);
    intervalBudgetStatus = { ...layers, expandedRestartAdmission: { tokens, bound,
      estimator: CONTEXT_ESTIMATOR, nativeUsageAnchor: false } };
    if (tokens > bound) throw new Error("context-v4-restart-projection-budget-exceeded");
  };
  const currentRequestTokens = (ctx: ExtensionContext, messages?: readonly unknown[], observedTokens = 0): number =>
    currentRequestBudget(ctx, messages, observedTokens).tokens;
  const requireSummaryReadiness = (ctx: ExtensionContext, observedTokens?: number): void => {
    // A summary must be submitted immediately. Do not activate a managed tool
    // here: reactivation can rewrite an earlier deferred-schema position.
    if (!pi.getActiveTools().includes(SESSION_AGENT_SUMMARY_TOOL)) throw new Error("session-agent-summary-tool-unavailable");
    summaryRequestLayers(ctx); // Keep model and restart-capacity validation.
    const tokens = observedTokens ?? currentRequestTokens(ctx);
    if (!Number.isFinite(tokens) || tokens <= 0) throw new Error("session-agent-summary-headroom-unavailable");
    // Planning thresholds suspend ordinary work, not this summary-only attempt.
    // A real provider size failure still uses the correlated recovery path.
  };
  const refreshIntervalSource = async (ctx: ExtensionContext,
    snapshot?: Pick<IntervalSourceSnapshot, "source" | "endEntryId" | "bounds" | "controlIdentities"> & { readonly identity: string },
    expected?: LogicalIntervalSourceManifest, signal: AbortSignal | undefined = ctx.signal?.aborted ? undefined : ctx.signal,
    allowOriginalSuffix = false, generatedSuffixEntryIds: readonly string[] = []): Promise<void> => {
    if (!logicalGrant) {
      if (snapshot?.source.logicalSessionId || expected
        || recordedLogicalBinding(ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[])
        || recordedLogicalAdoptionBinding(ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[])) {
        throw new Error("context-v4-interval-logical-source-grant-unavailable");
      }
      intervalSourcePin = undefined;
      intervalSourceSnapshot = undefined;
      return;
    }
    const scope = sessionSummaryScope(ctx, summaryEpoch), grant = logicalGrant;
    const grantKey = stableStringify(grant), historyKey = stableStringify(userConfig.historyHelpers ?? null);
    const settingsKey = stableStringify(searchSettings()), modelKey = stableStringify(ctx.model);
    const sourcePath = ctx.sessionManager.getSessionFile();
    if (!sourcePath) throw new Error("context-v4-interval-logical-source-path-unavailable");
    const manifest = await new LogicalSessionStore(logicalSessionRoot, grant.logicalSessionId).read();
    if (signal?.aborted || stableStringify(scope) !== stableStringify(sessionSummaryScope(ctx, summaryEpoch))
      || stableStringify(logicalGrant) !== grantKey || stableStringify(userConfig.historyHelpers ?? null) !== historyKey) {
      throw new Error("context-v4-interval-logical-source-changed");
    }
    if (stableStringify(searchSettings()) !== settingsKey || stableStringify(ctx.model) !== modelKey) {
      throw new Error("context-v4-interval-logical-source-changed");
    }
    if (!manifest) throw new Error("context-v4-interval-logical-source-manifest-unavailable");
    const pin = await repinLogicalIntervalSource({ logicalGrant: grant, manifest,
      current: { sessionId: scope.sessionId, sourcePath, branchEntries: ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[] },
      endEntryId: snapshot?.endEntryId ?? scope.leafId,
      ...(snapshot?.source.shardId ? { anchor: { sessionId: snapshot.source.sessionId, shardId: snapshot.source.shardId,
        endEntryId: snapshot.endEntryId } } : {}), expected, signal,
      ...(allowOriginalSuffix ? { allowOriginalSuffix: true as const } : {}), generatedSuffixEntryIds,
      executeCatalog: async request => {
        const response = await runCatalogWorker(request, { signal, slots: resolveExtensionSettings(userConfig).hostWorkerSlots,
          schedulerDirectory: adapters.schedulerDirectory });
        if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code });
        return response.result;
      } });
    const captured = captureIntervalSource({ ...pin.source, branchEntries: pin.branchEntries, endEntryId: pin.endEntryId,
      routedSegments: pin.routedSegments, bounds: snapshot?.bounds, controlIdentities: snapshot?.controlIdentities });
    if (signal?.aborted || stableStringify(scope) !== stableStringify(sessionSummaryScope(ctx, summaryEpoch))
      || stableStringify(logicalGrant) !== grantKey || stableStringify(userConfig.historyHelpers ?? null) !== historyKey
      || stableStringify(searchSettings()) !== settingsKey || stableStringify(ctx.model) !== modelKey
      || snapshot && captured.identity !== snapshot.identity) throw new Error("context-v4-interval-logical-source-changed");
    intervalSourcePin = pin;
    intervalSourceSnapshot = captured;
  };
  const revalidateRuntimeInterval = (ctx: ExtensionContext, snapshot: IntervalSourceSnapshot): void => {
    if (!snapshot.source.logicalSessionId) {
      revalidateIntervalSource(snapshot, ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[]);
      return;
    }
    if (!intervalSourcePin || intervalSourceSnapshot?.identity !== snapshot.identity
      || !logicalGrant || intervalSourcePin.validationManifest.logicalSessionId !== logicalGrant.logicalSessionId
      || intervalSourcePin.validationManifest.branchId !== logicalGrant.branchId) throw new Error("context-v4-interval-logical-source-pin-unavailable");
    revalidateIntervalSource(snapshot, intervalSourcePin.branchEntries, intervalSourcePin.routedSegments);
  };
  const captureCurrentInterval = (ctx: ExtensionContext): IntervalSourceSnapshot => {
    const endEntryId = ctx.sessionManager.getLeafId();
    if (!endEntryId) throw new Error("context-v4-interval-source-unavailable");
    if (logicalGrant) {
      if (!intervalSourcePin || intervalSourcePin.endEntryId !== endEntryId || intervalSourcePin.source.sessionId !== ctx.sessionManager.getSessionId()
        || !intervalSourceSnapshot) throw new Error("context-v4-interval-logical-source-pin-unavailable");
      return intervalSourceSnapshot;
    }
    return captureIntervalSource({ sessionId: ctx.sessionManager.getSessionId(),
      branchEntries: ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[], endEntryId });
  };
  const prepareIntervalHelpers = (ctx: ExtensionContext, snapshot: IntervalSourceSnapshot, budget: ContextBudget,
    signal?: AbortSignal): void => {
    if (preview) return;
    try {
      const { partition, layers } = planIntervalContext(snapshot, budget);
      intervalBudgetStatus = layers;
      intervalLastPlan = { snapshotId: snapshot.identity, partition };
      const key = stableStringify({ source: snapshot.origin, a: snapshot.events.slice(0, partition.compressedStart)
        .map(event => [event.source, event.entryId, event.projectionHash]), b: snapshot.units.filter(unit => unit.start >= partition.compressedStart
          && unit.end <= partition.rawStart).map(unit => unit.id), route: userConfig.historyHelpers ?? null });
      if (key === helperPreparationKey) return;
      helperPreparationKey = key;
      intervalHelpers.prepare({ snapshot, partition, ctx, signal });
      intervalHelperFailure = undefined;
    } catch (error) { intervalHelperFailure = safeCompositionFailureCode(error); }
  };
  const readyIntervalHistory = (ctx: ExtensionContext, snapshot: IntervalSourceSnapshot, budget: ContextBudget,
    signal?: AbortSignal) => intervalHelpers.ready({ snapshot, partition: planIntervalContext(snapshot, budget).partition, ctx, signal });
  const beginSessionSummary = (ctx: ExtensionContext, reason: SessionAgentSummaryRequest["reason"],
    delivery: "deferred" | "sent", customInstructions?: string, requestToolCallId?: string, observedTokens?: number, deliberateRecovery = false,
    resumeAfter = captureOriginalContinuation(ctx, reason), frozenInterval?: IntervalSourceSnapshot, requestScope?: SessionAgentSummaryScope) => {
    requireIntervalHost(ctx);
    validatePreview(ctx);
    if (previewDelivered) throw new Error("session-agent-summary-preview-already-delivered");
    if (sessionSummary || (compactionRetryPaused && !deliberateRecovery) || ctx.hasPendingMessages()) throw new Error("session-agent-summary-session-busy");
    const budget = captureIntervalRuntimeBudget(pi, ctx);
    const layers = deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
      toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens, effectiveAvailableTokens: budget.effectiveCeilingTokens });
    if (!layers.available) throw new Error(`context-v4-${layers.reasons[0] ?? "interval-policy-unavailable"}`);
    const request = createSessionAgentSummaryRequest({ requestId: randomUUID(), scope: requestScope ?? sessionSummaryScope(ctx, summaryEpoch), reason,
      now: Date.now(), targetTokens: layers.handoffTokens, handoffTokens: layers.handoffTokens, continuationTokens: layers.continuationTokens,
      ...(customInstructions?.trim() ? { customInstructions } : {}), ...(requestToolCallId ? { requestToolCallId } : {}) });
    const tokens = currentRequestTokens(ctx, undefined, observedTokens);
    requireSummaryReadiness(ctx, tokens);
    // Pin eligibility before the summary toolUse can mask a completed turn.
    const interval = frozenInterval ?? captureCurrentInterval(ctx);
    revalidateRuntimeInterval(ctx, interval);
    prepareIntervalHelpers(ctx, interval, budget);
    const state: ActiveSessionSummary = { request, delivery, deferrals: 0, resumeAfter, interval,
      logicalSource: intervalSourcePin?.validationManifest, historyConfigKey: stableStringify(userConfig.historyHelpers ?? null) };
    sessionSummary = state;
    valueWorkerCompactionGate = true;
    cancelValueWorker();
    cancelIncrementalWork(false);
    lastTriggerAttemptTokens = tokens;
    summaryRecoveryRequested = false;
    summaryInputIntent = undefined;
    return state;
  };
  const intervalPressure = (ctx: ExtensionContext, tokens: number) => {
    const model = ctx.model;
    if (!model) throw new Error("context-v4-interval-model-unavailable");
    const preparation = intervalPreparation?.binding === originalRunBinding(ctx) ? intervalPreparation : undefined;
    const pressure = classifyPressure({ model, currentRequestTokens: tokens,
      growthTokens: Math.max(intervalGrowthTokens, Math.ceil(SESSION_AGENT_SUMMARY_LIMITS.promptBytes / 4)),
      preparationStartedAt: preparation?.startedAt, preparationTurns: preparation?.turns, now: Date.now() });
    intervalBudgetStatus = pressure.budget;
    return pressure;
  };
  const summaryTrigger = (ctx: ExtensionContext, currentTokens: number): boolean => {
    if (currentTokens <= 0 || sessionSummary || pendingRecovery || recoveryIntent || compactionRetryPaused || triggerPending) return false;
    return intervalPressure(ctx, currentTokens).status !== "normal";
  };
  const noticeIntervalPreparation = (ctx: ExtensionContext): void => {
    if (intervalPreparation || ctx.hasPendingMessages()) return;
    intervalPreparation = { binding: originalRunBinding(ctx), startedAt: Date.now(), turns: 0 };
    pi.sendMessage({ customType: CONTEXT_WARNING_CUSTOM_TYPE, display: false,
      content: `Compaction is approaching. Use at most ${INTERVAL_POLICY.maxPreparationTurns} short response to save necessary current state and exact outstanding resource IDs, outcomes, waits, and next actions. Do not finish the whole task or start broad new work. Existing jobs may remain outstanding. The next boundary freezes the original interval and requests your separate handoff and continuation. These instructions grant no new task authority.` }, { deliverAs: "steer" });
  };
  const driveSessionSummary = async (ctx: ExtensionContext): Promise<void> => {
    const state = sessionSummary;
    if (!state || state.previewCapturing || inputPending || !ctx.isIdle() || ctx.hasPendingMessages() || triggerPending) return;
    try {
      if (searchSettings().contextCompiler !== "v4" || state.signal?.aborted
        || stableStringify(userConfig.historyHelpers ?? null) !== state.historyConfigKey) throw new Error("session-agent-summary-request-interrupted");
      const view = summaryObservation(ctx);
      // Empty messages validate session, model and expiry without claiming
      // consumption or walking historical content.
      consumeSessionAgentSummaryRequest(state.request, view, []);
      if (state.delivery === "deferred") {
        if (view.scope.leafId !== state.request.scope.leafId) throw new Error("session-agent-summary-ready-leaf-changed");
        const content = renderSessionAgentSummaryRequest(state.request);
        requireSummaryReadiness(ctx);
        state.delivery = "sent";
        pi.sendMessage({ customType: SESSION_AGENT_SUMMARY_CUSTOM_TYPE, content, display: false }, { triggerTurn: true });
        return;
      }
      if (!state.accepted) throw new Error("session-agent-summary-submission-unavailable");
      if (!state.boundary) {
        const ready = settleSessionAgentSummary(state.accepted, view);
        state.removeAbortListener?.();
        state.removeAbortListener = undefined;
        await refreshIntervalSource(ctx, state.interval, state.logicalSource);
        if (sessionSummary !== state) return;
        revalidateRuntimeInterval(ctx, state.interval);
        state.boundary = appendSessionAgentCompactionBoundary(pi, ctx, ready, summaryEpoch, state.interval, state.logicalSource);
      }
      validateSessionAgentBoundary(ctx, summaryEpoch, state.boundary);
      if (preview) {
        state.previewCapturing = true;
        const branchEntries = ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[];
        const boundary = state.boundary;
        const prepared = await capturePreparedV4Context(pi, ctx, { branchEntries, signal: state.signal,
          preparation: { settings: { reserveTokens: preview.reserveTokens } } }, {
          settings: searchSettings, memoryOwner, epoch: () => summaryEpoch, boundary,
          historyConfig: () => userConfig.historyHelpers ?? null,
          refreshSource: () => refreshIntervalSource(ctx, boundary.interval, boundary.logicalSource),
          revalidateSource: () => revalidateRuntimeInterval(ctx, state.interval),
        });
        const revalidate = () => {
          prepared.revalidate();
          validatePreview(ctx);
          if (sessionSummary !== state || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("session-agent-summary-session-busy");
        };
        revalidate();
        const compiled = compileContext(prepared.input);
        requireExpandedRestartBudget(ctx, compiled);
        // Detach the one verified boundary. Callback edits cannot alter source.
        const exactTail = Object.freeze(structuredClone(branchEntries.slice(prepared.tail.cutIndex)));
        revalidate();
        previewDelivered = true;
        await preview.onReady({ input: prepared.input, compiled, tail: prepared.tail, exactTail,
          ready: boundary.ready, boundary, revalidate });
        if (sessionSummary === state) clearSessionSummary();
        return;
      }
      launchCompaction(ctx, "the session agent submitted its continuation summary", ctx.getContextUsage()?.tokens ?? undefined, state.resumeAfter);
    } catch (error) { if (sessionSummary === state) refuseSessionSummary(ctx, error); }
  };
  const scheduleSessionSummary = (ctx: ExtensionContext): void => {
    if (summaryTimer || !sessionSummary) return;
    const epoch = summaryEpoch;
    // Hooks unwind before a new agent turn or ctx.compact(). If still busy,
    // agent_settled provides the next safe opportunity. There is no polling loop.
    summaryTimer = setTimeout(() => { summaryTimer = undefined; if (epoch === summaryEpoch) void driveSessionSummary(ctx); }, 0);
  };
  const takeCompactionResume = (ctx: ExtensionContext) => {
    const resume = compactionResume;
    if (!resume) return undefined;
    try {
      const scope = sessionSummaryScope(ctx, summaryEpoch);
      // Bind to the exact commit, not the mutable native leaf. Only a bounded
      // suffix of context-invisible metadata may follow it on this branch.
      const seen = new Set<string>();
      let id: string | null | undefined = scope.leafId;
      while (id !== resume.scope.leafId) {
        if (!id || seen.has(id) || seen.size >= SESSION_AGENT_SUMMARY_LIMITS.ancestryEntries) throw new Error("compaction-resume-source-changed");
        seen.add(id);
        const child = ctx.sessionManager.getEntry(id);
        if (child?.id !== id || (!(["custom", "label", "session_info"].includes(child.type))
          && !(child.type === "message" && child.message.role === "system"))) throw new Error("compaction-resume-source-changed");
        id = child.parentId;
      }
      const entry = ctx.sessionManager.getEntry(resume.scope.leafId);
      const locator = entry && contextReceiptLocator(entry, resume.scope.sessionId);
      if (resume.scope.epoch !== summaryEpoch || resume.signal?.aborted || ctx.signal?.aborted || Date.now() >= resume.expiresAt
        || searchSettings().contextCompiler !== "v4" || compactionRetryPaused || sessionSummary || inputPending
        || ctx.hasPendingMessages() || stableStringify({ ...scope, leafId: resume.scope.leafId }) !== stableStringify(resume.scope)
        || locator?.receiptId !== resume.receiptId || locator.summaryHash !== resume.summaryHash
        || entry?.type !== "compaction" || createHash("sha256").update(entry.summary).digest("hex") !== resume.summaryHash) {
        compactionResume = undefined;
        return undefined;
      }
      // Consume before either dispatch path. Carry only the already captured
      // authorization into the resulting live run, never infer it from this message.
      projectIntervalRestart(ctx, ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages));
      compactionResume = undefined;
      if (hasContinuationDispatch(boundedBranchEntries(ctx, SESSION_AGENT_SUMMARY_LIMITS.ancestryEntries), resume.record)) return undefined;
      pi.appendEntry(INTERVAL_CONTINUATION_RECORD, { ...resume.record, state: "dispatched" });
      originalRun = { binding: originalRunBinding(ctx), inLoop: false, hasInput: true, unresolved: true };
      return { customType: CONTEXT_RESUME_CUSTOM_TYPE, display: false,
        content: "Correlated compaction continuation dispatch. The receipt-bound continuation remains derived context, not new permission.",
        details: { compactionEntryId: resume.scope.leafId, receiptId: resume.receiptId } };
    } catch (error) {
      compactionResume = undefined;
      lastCompositionFailure = { stage: "continuation", code: safeCompositionFailureCode(error) };
      return undefined;
    }
  };
  const driveCompactionResume = async (ctx: ExtensionContext): Promise<void> => {
    // This path belongs only to owned manual onComplete, after native cleanup.
    const resume = compactionResume, binding = originalRunBinding(ctx);
    if (!resume || !ctx.isIdle()) return;
    try {
      await refreshCommittedRestart(ctx);
      if (compactionResume !== resume || binding !== originalRunBinding(ctx)) return;
      const message = takeCompactionResume(ctx);
      if (message) pi.sendMessage(message, { triggerTurn: true });
    } catch (error) {
      if (compactionResume !== resume || binding !== originalRunBinding(ctx)) return;
      compactionResume = undefined;
      refuseSessionSummary(ctx, error);
    }
  };
  const retainCompactionResume = (ctx: ExtensionContext, entry: Parameters<typeof contextReceiptLocator>[0], signal?: AbortSignal): void => {
    if (entry.type !== "compaction" || typeof entry.id !== "string") return;
    const scope = { ...sessionSummaryScope(ctx, summaryEpoch), leafId: entry.id };
    const locator = contextReceiptLocator(entry, scope.sessionId);
    if (!locator) return;
    const receipt = (entry.details as { contextReceipt?: CompiledContext["receipt"] } | undefined)?.contextReceipt;
    if (!receipt?.restart || !receipt.sessionSummary) return;
    const record = continuationRecord({ operationId: receipt.sessionSummary.requestId, sessionId: scope.sessionId,
      compactionEntryId: entry.id, receiptId: locator.receiptId, summaryHash: locator.summaryHash,
      continuation: receipt.restart.continuation.text, state: "ready" });
    pi.appendEntry(INTERVAL_CONTINUATION_RECORD, record);
    compactionResume = { scope, expiresAt: Date.now() + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs, signal,
      receiptId: locator.receiptId, summaryHash: locator.summaryHash, record };
  };

  const launchCompaction = (ctx: ExtensionContext, reason: string, currentTokens?: number, resumeAfter = false): void => {
    if (preview) throw new Error("session-agent-summary-preview-native-compaction-forbidden");
    if (triggerPending || (compactionRetryPaused && !(searchSettings().contextCompiler === "v4" && sessionSummary?.boundary))) return;
    triggerPending = true;
    forcedContinuationPending = resumeAfter;
    const attempt: NonNullable<typeof ownedCompaction> = { epoch: rolloutEpoch,
      sessionId: ctx.sessionManager.getSessionId(), sourcePath: ctx.sessionManager.getSessionFile(),
      leafId: ctx.sessionManager.getLeafId?.(), resumeAfter };
    ownedCompaction = attempt;
    if (currentTokens !== undefined) lastTriggerAttemptTokens = currentTokens;
    if (ctx.hasUI) ctx.ui.notify(`ChronoCompact trigger: ${reason}.`, "info");
    const deferred = usesStoredComposition(ctx) ? { epoch: rolloutEpoch,
      sessionId: ctx.sessionManager.getSessionId(), sourcePath: ctx.sessionManager.getSessionFile() } : undefined;
    if (deferred) deferredCompactionSearch = deferred;
    const resumeSearch = (): void => {
      if (!deferred || deferredCompactionSearch !== deferred) return;
      deferredCompactionSearch = undefined;
      if (deferred.epoch === rolloutEpoch && deferred.sessionId === ctx.sessionManager.getSessionId()
        && deferred.sourcePath === ctx.sessionManager.getSessionFile()) scheduleSearch(ctx);
    };
    ctx.compact({
      customInstructions: `ChronoCompact trigger: ${reason}. Preserve direct user restrictions, decisive failures, and unresolved work.`,
      onComplete: () => {
        if (ownedCompaction !== attempt) return;
        ownedCompaction = undefined;
        triggerPending = false;
        resumeSearch();
        // Native manual compaction has cleared its flags before this callback.
        driveCompactionResume(ctx);
        refreshAutomaticRolloverStatus(ctx);
      },
      onError: (error) => {
        if (ownedCompaction !== attempt) return;
        ownedCompaction = undefined;
        triggerPending = false;
        forcedCompactionReason = undefined;
        forcedContinuationPending = false;
        continueAfterSuccessfulCompaction = false;
        resumeSearch();
        const unchanged = attempt.epoch === rolloutEpoch && attempt.sessionId === ctx.sessionManager.getSessionId()
          && attempt.sourcePath === ctx.sessionManager.getSessionFile() && attempt.leafId === ctx.sessionManager.getLeafId?.();
        // Pi labels extension refusals as aborted too. Only the actual hook signal
        // distinguishes a user abort from our non-user cancel:true result.
        const cancelled = attempt.signal?.aborted === true || (!attempt.failure
          && (error.name === "AbortError" || error.message === "Compaction cancelled"));
        if (unchanged && !cancelled && !attempt.succeeded) {
          const failure = attempt.failure ?? { stage: "compaction", code: safeCompositionFailureCode(error) };
          if (ctx.hasUI) ctx.ui.notify(`ChronoCompact request failed (${failure.stage}: ${failure.code}); current context is unchanged.`, "warning");
          if (searchSettings().contextCompiler !== "v4" && attempt.resumeAfter && attempt.signal && attempt.failure && ctx.isIdle?.() && !ctx.hasPendingMessages?.()) {
            compactionRetryPaused = true;
            pi.sendMessage({ customType: CONTEXT_RESUME_CUSTOM_TYPE, display: false,
              content: `Compaction failed (${failure.stage}: ${failure.code}). Current context is unchanged. Continue the unresolved task from the existing context. Do not retry compaction in this continuation. If context capacity prevents safe progress, report the blocker and wait for user input.`,
            }, { triggerTurn: true });
          }
        }
        if (unchanged && searchSettings().contextCompiler === "v4" && !sessionSummary && !attempt.succeeded && !compactionRetryPaused) {
          refuseSessionSummary(ctx, new Error("session-agent-summary-compaction-failed"));
        }
        refreshAutomaticRolloverStatus(ctx);
      },
    });
  };

  pi.on("tool_call", (event, ctx) => {
    if (searchSettings().contextCompiler !== "v4") return undefined;
    try {
      const state = sessionSummary;
      if (state) {
        if (!state.consumed || state.accepted || event.toolName !== SESSION_AGENT_SUMMARY_TOOL) {
          throw new Error("session-agent-summary-original-tool-suspended");
        }
        // Validate the persisted sole call before ANY tool in the model batch
        // can run. Prompts alone do not enforce the frozen original boundary.
        const submission = parseSessionAgentSummarySubmission(event.input);
        if (!submission) throw new Error("session-agent-summary-submission-unavailable");
        acceptSessionAgentSummary(state.consumed, submission, { ...summaryObservation(ctx), toolCallId: event.toolCallId });
      } else {
        if (compactionRetryPaused || pendingRecovery || recoveryIntent) throw new Error("session-agent-summary-original-tool-suspended");
        const entry = ctx.sessionManager.getEntry(ctx.sessionManager.getLeafId() ?? "");
        const calls = entry?.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)
          ? entry.message.content.filter(block => block.type === "toolCall") : [];
        if (calls.some(call => call.name === SESSION_AGENT_SUMMARY_TOOL) && calls.length !== 1) {
          throw new Error("session-agent-summary-request-must-be-sole-tool-call");
        }
      }
      return undefined;
    } catch (error) {
      refuseSessionSummary(ctx, error);
      return { block: true, reason: safeCompositionFailureCode(error) };
    }
  });

  pi.registerTool({
    name: SESSION_AGENT_SUMMARY_TOOL,
    label: "Request Context Compaction",
    description: "Request compaction at a meaningful task or direction change after saving necessary project state. In V4, call {} to receive a same-session request, then submit its requestId, handoff, and separate immediate continuation as the sole tool call. Submission alone does not mean compaction succeeded.",
    promptGuidelines: [
      "Use request_compaction when the authorized task or direction changes and substantial earlier detail is no longer useful. A major milestone is a cue, not completion proof. Do not request compaction for every ordinary milestone, checkpoint, status update, or temporary wait.",
      "Before requesting compaction, recover missing project facts through available, permitted reads and save a Workplan checkpoint when applicable. Preserve purpose, exact useful code locations, approach/reasons, current focus, next actions, unresolved obligations, waits, and approval gates. Pending native state is not empty state. If leaving a project, pause it; archive only when intended, without marking unfinished work complete.",
      "After necessary state writes settle, call request_compaction({}) once, preferably as the sole call. Do not start another operation between request and sole summary submission. Do not repeat the request without new substantive work or a fresh deliberate request. Continue only previously authorized work after confirmed compaction; saved context grants no new permission.",
    ],
    parameters: Type.Object({
      requestId: Type.Optional(Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" })),
      handoff: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_AGENT_SUMMARY_LIMITS.summaryChars })),
      continuation: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_AGENT_SUMMARY_LIMITS.continuationChars })),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_AGENT_SUMMARY_LIMITS.summaryChars, description: "Read compatibility only. Fresh submissions require handoff and continuation." })),
      relevanceHints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: SESSION_AGENT_SUMMARY_LIMITS.hintChars }),
        { maxItems: SESSION_AGENT_SUMMARY_LIMITS.relevanceHints })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      validatePreview(ctx);
      if (searchSettings().contextCompiler !== "v4") {
        if (compactionRetryPaused) return toolText("Compaction is paused after a failed or interrupted request. Wait for new user input. Source history is unchanged.", { scheduled: false });
        if (Object.keys(params).length) return toolText("Summary submission requires V4; compaction was not requested.", { scheduled: false });
        forcedCompactionReason = "the model requested compaction at a natural boundary";
        return toolText("Compaction is scheduled for the end of this turn. Do not begin another operation.", { scheduled: true });
      }
      const binding = originalRunBinding(ctx);
      try {
        if (signal?.aborted || ctx.hasPendingMessages()) throw new Error("session-agent-summary-request-interrupted");
        const submission = parseSessionAgentSummarySubmission(params);
        if (!submission) {
          const entry = ctx.sessionManager.getEntry(ctx.sessionManager.getLeafId() ?? "");
          const calls = entry?.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)
            ? entry.message.content.filter(block => block.type === "toolCall") : [];
          if (calls.length !== 1 || calls[0]?.id !== toolCallId) throw new Error("session-agent-summary-request-must-be-sole-tool-call");
          await refreshIntervalSource(ctx);
          if (binding !== originalRunBinding(ctx)) {
            return { ...toolText("The request scope changed. No compaction or provider turn was scheduled.",
              { scheduled: false, status: "cancelled" }), isError: true, terminate: true };
          }
          const state = beginSessionSummary(ctx, "tool", "sent", undefined, toolCallId, undefined, true);
          watchSummaryAbort(ctx, state, signal);
          return toolText(renderSessionAgentSummaryRequest(state.request), { requestId: state.request.requestId, status: "summary-requested" });
        }
        const state = sessionSummary;
        if (!state?.consumed || state.accepted) throw new Error("session-agent-summary-request-unavailable");
        state.accepted = acceptSessionAgentSummary(state.consumed, submission, { ...summaryObservation(ctx), toolCallId });
        watchSummaryAbort(ctx, state, signal);
        return { ...toolText("Summary accepted. Compaction will be validated at the next native boundary; it has not completed. Do not start another operation.",
          { requestId: state.request.requestId, status: "accepted" }), terminate: true };
      } catch (error) {
        if (binding !== originalRunBinding(ctx)) {
          return { ...toolText("The request scope changed. No compaction or provider turn was scheduled.",
            { scheduled: false, status: "cancelled" }), isError: true, terminate: true };
        }
        refuseSessionSummary(ctx, error);
        return { ...toolText(`Compaction refused (${safeCompositionFailureCode(error)}). Source history is unchanged. Ordinary model work remains paused. Request one fresh summary-only recovery with direct user input or /compact.`,
          { scheduled: false, status: "refused", code: safeCompositionFailureCode(error) }), isError: true, terminate: true };
      }
    },
  });

  const projectIntervalRestart = (ctx: ExtensionContext, messages: readonly unknown[]) => {
    // The selected native context identifies its latest compaction directly.
    // Never pick a receipt from a different branch or older packet by time.
    const compaction = ctx.sessionManager.buildContextEntries().find(entry => entry.type === "compaction") as SessionEntryLike | undefined;
    if (!compaction) return undefined;
    return projectCommittedIntervalRestart({ messages, compaction, sessionId: ctx.sessionManager.getSessionId(),
      getEntry: id => ctx.sessionManager.getEntry(id) as SessionEntryLike | undefined,
      wakeCustomType: CONTEXT_RESUME_CUSTOM_TYPE, validateSources: receipt => {
        const restart = receipt.restart;
        if (!restart) throw new Error("context-v4-restart-binding-invalid");
        const manifest = restart.source;
        if (!manifest || (!manifest.source.logicalSessionId && manifest.source.sessionId !== ctx.sessionManager.getSessionId())
          || manifest.endEntryId !== receipt.sourceCutEntryId) throw new Error("context-v4-restart-source-binding-invalid");
        if (manifest.segments.length !== 1 && !manifest.source.logicalSessionId) throw new Error("context-v4-interval-routed-source-unavailable");
        const captured = manifest.source.logicalSessionId ? intervalSourceSnapshot : captureIntervalSource({ ...manifest.source,
          branchEntries: ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[], endEntryId: manifest.endEntryId,
          controlIdentities: manifest.controlIdentities, bounds: manifest.bounds });
        if (!captured || manifest.source.logicalSessionId && (!intervalSourcePin || !restart.logicalSource
          || intervalSourcePin.validationManifest.identity !== restart.logicalSource.identity)) {
          throw new Error("context-v4-interval-logical-source-pin-unavailable");
        }
        if (captured.identity !== restart.snapshotId || captured.sourceHash !== manifest.sourceHash
          || captured.projectionHash !== manifest.projectionHash || stableStringify(captured.origin) !== stableStringify(manifest.origin)
          || stableStringify(captured.segments) !== stableStringify(manifest.segments)
          || stableStringify(captured.events.slice(restart.partition.rawStart, restart.partition.endExclusive))
            !== stableStringify(restart.exactTail)) throw new Error("context-v4-restart-source-changed");
      } });
  };
  const refreshCommittedRestart = async (ctx: ExtensionContext): Promise<void> => {
    const compaction = ctx.sessionManager.buildContextEntries().find(entry => entry.type === "compaction") as SessionEntryLike | undefined;
    const receipt = compaction ? committedIntervalRestartReceipt(compaction, ctx.sessionManager.getSessionId()) : undefined;
    const restart = receipt?.restart;
    if (!restart?.source.source.logicalSessionId) return;
    if (!restart.logicalSource) throw new Error("context-v4-interval-logical-source-manifest-unavailable");
    await refreshIntervalSource(ctx, { ...restart.source, identity: restart.snapshotId }, restart.logicalSource,
      ctx.signal?.aborted ? undefined : ctx.signal, true);
  };
  const queueIntervalRecovery = (ctx: ExtensionContext, reason: string): void => {
    if (preview || recoveryUsed || recoveryIntent || pendingRecovery || ctx.hasPendingMessages()) {
      refuseSessionSummary(ctx, new Error(recoveryUsed ? "context-v4-recovery-attempt-exhausted" : reason));
      return;
    }
    clearSessionSummary();
    const now = Date.now();
    recoveryIntent = { scope: sessionSummaryScope(ctx, summaryEpoch), createdAt: now,
      expiresAt: now + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs, reason };
    compactionRetryPaused = true;
    valueWorkerCompactionGate = true;
    providerAdmission = undefined;
    cancelValueWorker();
    cancelIncrementalWork(false);
    // Public Pi emits turn_end for the aborted attempt. The abort cause is not
    // distinguishable from user cancellation, so this repair never auto-resumes.
    if (!ctx.isIdle()) ctx.abort();
  };
  const reportRecoveryRefusal = (ctx: ExtensionContext, error: unknown): void => {
    const detail = error instanceof IntervalRecoveryRefusal ? { sourceEntryId: error.sourceEntryId,
      requiredTokens: error.requiredTokens, availableTokens: error.availableTokens } : undefined;
    refuseSessionSummary(ctx, error);
    if (detail && ctx.hasUI) ctx.ui.notify(`Recovery bound: ${JSON.stringify(detail)}. Protected source is unchanged.`, "warning");
  };
  // Native manual compaction can refuse before its hook when the retained
  // projection is short. Commit the accepted writer result at this public
  // boundary instead. The same persisted-commit gate owns continuation.
  const prepareAcceptedSummaryProposal = async (ctx: ExtensionContext, event: IntervalTurnBoundaryEvent,
    state: ActiveSessionSummary): Promise<IntervalBoundaryResult> => {
    requireIntervalBoundary(ctx, event);
    if (preview || sessionSummary !== state || !state.accepted || pendingRecovery || event.outcome !== "completed"
      || event.continue || event.entries.length || event.context.pendingMessages.length || inputPending || ctx.hasPendingMessages()
      || state.signal?.aborted || ctx.signal?.aborted) throw new Error("session-agent-summary-boundary-unavailable");
    const ready = settleSessionAgentSummary(state.accepted, summaryObservation(ctx));
    if (event.messageEntryId !== ready.submissionAssistantLeafId || event.toolResultEntryIds.length !== 1
      || event.toolResultEntryIds[0] !== ready.submissionResultLeafId) throw new Error("session-agent-summary-boundary-changed");
    const scope = sessionSummaryScope(ctx, summaryEpoch), operationId = ready.request.requestId;
    const budget = captureIntervalRuntimeBudget(pi, ctx), budgetKey = stableStringify(budget);
    const settingsKey = stableStringify(searchSettings());
    const revalidate = () => {
      if (sessionSummary !== state || state.signal?.aborted || ctx.signal?.aborted || inputPending || ctx.hasPendingMessages()
        || stableStringify(scope) !== stableStringify(sessionSummaryScope(ctx, summaryEpoch))
        || stableStringify(searchSettings()) !== settingsKey || stableStringify(captureIntervalRuntimeBudget(pi, ctx)) !== budgetKey
        || stableStringify(userConfig.historyHelpers ?? null) !== state.historyConfigKey) throw new Error("context-v4-input-changed");
      validateSessionAgentSummary(ready, summaryObservation(ctx));
      if (settleSessionAgentSummary(ready, summaryObservation(ctx)).submissionResultLeafId !== ready.submissionResultLeafId) {
        throw new Error("session-agent-summary-boundary-changed");
      }
      revalidateRuntimeInterval(ctx, state.interval);
    };
    await refreshIntervalSource(ctx, state.interval, state.logicalSource, state.signal);
    revalidate();
    if (!ready.submission.continuation) throw new Error("session-agent-summary-fresh-continuation-required");
    const retainNoneIntent = `retain-none:${operationId}`;
    const input = await captureContextCompilation(pi, {
      scope: { sessionId: scope.sessionId, leafId: scope.leafId }, sourceCutEntryId: state.interval.endEntryId,
      firstKeptEntryId: retainNoneIntent, nativeRetention: { kind: "none", operationId },
      memoryOwner, budget, rawTail: { tokens: 0, messages: 0, toolPairSafe: true }, interval: state.interval,
      logicalSource: state.logicalSource,
      sessionSummary: { text: ready.submission.handoff, handoff: ready.submission.handoff, continuation: ready.submission.continuation,
        authorship: "current-agent", requestId: operationId, requestLeafId: ready.request.scope.leafId,
        consumedBoundaryLeafId: ready.consumedBoundaryLeafId, submissionEntryId: ready.submissionAssistantLeafId,
        submissionToolCallId: ready.submissionToolCallId, relevanceHints: ready.submission.relevanceHints },
      readyHistory: (snapshot, currentBudget) => readyIntervalHistory(ctx, snapshot, currentBudget, state.signal),
    }, { getScope: () => ({ sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? null }),
      epoch: () => summaryEpoch, signal: state.signal, revalidate });
    const compiled = compileContext(input);
    await refreshIntervalSource(ctx, state.interval, state.logicalSource, state.signal);
    revalidate();
    requireExpandedRestartBudget(ctx, compiled);
    revalidate();
    state.removeAbortListener?.();
    sessionSummary = undefined;
    summaryInputIntent = undefined;
    summaryRecoveryRequested = false;
    intervalPreparation = undefined;
    providerAdmission = undefined;
    compactionRetryPaused = true;
    valueWorkerCompactionGate = true;
    pendingRecovery = { scope, parentId: scope.leafId, operationId, expiresAt: ready.request.expiresAt,
      interval: state.interval, compiled, historyConfigKey: state.historyConfigKey, authorship: "current-agent",
      resumeAfter: state.resumeAfter, nativeContinue: state.resumeAfter, allowArchive: true, signal: state.signal };
    compilerTerminal = { state: "returned", receiptId: compiled.receipt.receiptId };
    return { entries: [{ type: "compaction", summary: compiled.summary, firstKeptEntryId: null,
      details: { kind: "chrono-v4-current-agent", contextReceipt: compiled.receipt,
        summaryOperation: { schemaVersion: 1, operationId, retention: "none", retainNoneIntent,
          sourceSnapshotId: state.interval.identity, submissionResultEntryId: ready.submissionResultLeafId, authority: "derived" } } }],
      continue: pendingRecovery.nativeContinue };
  };
  const prepareRecoveryProposal = async (ctx: ExtensionContext, event: IntervalBoundaryEvent,
    reason: string, resumeAfter: boolean, failedSummaryEntryId?: string): Promise<IntervalBoundaryResult | undefined> => {
    requireIntervalBoundary(ctx, event);
    if (preview || pendingRecovery || recoveryUsed || event.entries.length || event.context.pendingMessages.length
      || inputPending || ctx.hasPendingMessages()) throw new Error("context-v4-recovery-boundary-unavailable");
    const intent = recoveryIntent;
    if (intent) validateDeferredSessionSummaryIntent(intent, summaryObservation(ctx));
    const scope = sessionSummaryScope(ctx, summaryEpoch), operationId = randomUUID(), now = Date.now();
    const priorInterval = sessionSummary?.interval;
    const logicalSource = sessionSummary?.logicalSource;
    if (priorInterval && !failedSummaryEntryId) throw new Error("context-v4-recovery-summary-correlation-unavailable");
    const generatedSuffixEntryIds = failedSummaryEntryId ? [failedSummaryEntryId] : [];
    const recoveryControls = priorInterval ? { ...priorInterval.controlIdentities,
      entryIds: [...priorInterval.controlIdentities.entryIds ?? [], ...generatedSuffixEntryIds] } : undefined;
    await refreshIntervalSource(ctx, priorInterval && { ...priorInterval, controlIdentities: recoveryControls! }, logicalSource,
      event.outcome === "aborted" ? undefined : ctx.signal, false, generatedSuffixEntryIds);
    const interval = priorInterval ? captureIntervalSource({ ...priorInterval.source,
      branchEntries: intervalSourcePin?.branchEntries ?? ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[],
      routedSegments: intervalSourcePin?.routedSegments, endEntryId: priorInterval.endEntryId,
      bounds: priorInterval.bounds, controlIdentities: recoveryControls }) : captureCurrentInterval(ctx);
    if (priorInterval && interval.identity !== priorInterval.identity) throw new Error("context-v4-recovery-source-changed");
    intervalSourceSnapshot = interval;
    const budget = captureIntervalRuntimeBudget(pi, ctx);
    const budgetKey = stableStringify(budget), historyConfigKey = stableStringify(userConfig.historyHelpers ?? null);
    let plan: ReturnType<typeof planIntervalContext>;
    try { plan = planIntervalContext(interval, budget); }
    catch (error) {
      if (safeCompositionFailureCode(error) === "context-v4-interval-required-unit-oversized") {
        const layers = deriveIntervalBudget({ model: budget.model, systemTokens: budget.systemTokens,
          toolSchemaTokens: budget.toolSchemaTokens, framingTokens: budget.framingTokens,
          effectiveAvailableTokens: budget.effectiveCeilingTokens });
        const unit = interval.units.at(-1)!;
        const required = chargeRawTail(unit.eventIndexes.map(index => interval.events[index]!.projectedEntry)).tokens;
        throw new IntervalRecoveryRefusal("context-v4-interval-required-unit-oversized",
          interval.events[unit.start]!.entryId, required,
          Math.max(0, layers.effectiveAvailableTokens - layers.handoffTokens - layers.continuationTokens - 1536));
      }
      throw error;
    }
    const { partition, layers } = plan;
    const signal = event.outcome === "aborted" ? undefined : ctx.signal;
    const revalidate = () => {
      if (Date.now() >= now + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs || signal?.aborted || inputPending || ctx.hasPendingMessages()
        || stableStringify(scope) !== stableStringify(sessionSummaryScope(ctx, summaryEpoch))
        || stableStringify(captureIntervalRuntimeBudget(pi, ctx)) !== budgetKey
        || stableStringify(userConfig.historyHelpers ?? null) !== historyConfigKey) throw new Error("context-v4-recovery-input-changed");
      revalidateRuntimeInterval(ctx, interval);
    };
    revalidate();
    const native = await collectContext(pi, { records: 16, scan: 128, providerBytes: 16384, maxBytes: 32768, waitMs: 150 }, {
      getScope: () => ({ sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? null }),
      epoch: () => summaryEpoch, signal });
    revalidate();
    const earlier = interval.origin.entryId ? ctx.sessionManager.getEntry(interval.origin.entryId) : undefined;
    const earlierReceipt = (earlier?.type === "compaction" ? earlier.details as { contextReceipt?: CompiledContext["receipt"] } | undefined : undefined)?.contextReceipt;
    const checkpointText = earlierReceipt?.sessionSummary?.handoff ?? earlierReceipt?.sessionSummary?.text
      ?? (earlier?.type === "compaction" ? earlier.summary : undefined);
    const recovery = buildDeterministicRecoveryHandoff({ intervalEndEntryId: interval.endEntryId,
      projectedOriginalEntries: interval.events.map(item => item.projectedEntry),
      exactTailEntryIds: new Set(interval.events.slice(partition.rawStart, partition.endExclusive).map(item => item.entryId)),
      ...(earlier?.id && checkpointText ? { checkpoint: { entryId: earlier.id, text: checkpointText } } : {}),
      stateReferences: native.providers.flatMap(provider => (provider.page?.cards ?? []).map(card => ({
        providerId: provider.providerId, id: card.id, revision: card.revision, status: card.status, recovery: card.recovery }))),
      stateCoverage: native.providers.map(provider => `${provider.providerId}: ${provider.status}, ${provider.page?.readiness ?? "unavailable"}`),
      handoffBudgetTokens: layers.handoffTokens });
    // Native null retention gets its own ID only at commit. This intent marker
    // is explicitly not a fabricated source ID and cannot retain a source tail.
    const retainNoneIntent = `retain-none:${operationId}`;
    const input = freezeContextInput({ scope: { sessionId: scope.sessionId, leafId: scope.leafId }, sourceCutEntryId: interval.endEntryId,
      firstKeptEntryId: retainNoneIntent, nativeRetention: { kind: "none", operationId },
      memoryOwner, budget, rawTail: { tokens: 0, messages: 0, toolPairSafe: true }, native, interval,
      logicalSource: intervalSourcePin?.validationManifest,
      sessionSummary: { text: recovery.handoff, handoff: recovery.handoff, continuation: recovery.continuation,
        authorship: recovery.authorship, requestId: operationId, requestLeafId: scope.leafId, consumedBoundaryLeafId: scope.leafId,
        submissionEntryId: scope.leafId, submissionToolCallId: `runtime:${operationId}`, relevanceHints: [] },
      history: { kind: "interval", relevance: [] } });
    const compiled = compileContext(input);
    await refreshIntervalSource(ctx, interval, input.logicalSource, signal, false, generatedSuffixEntryIds);
    revalidate();
    requireExpandedRestartBudget(ctx, compiled);
    revalidate();
    recoveryUsed = true;
    recoveryIntent = undefined;
    sessionSummary?.removeAbortListener?.();
    sessionSummary = undefined;
    summaryInputIntent = undefined;
    summaryRecoveryRequested = false;
    intervalPreparation = undefined;
    providerAdmission = undefined;
    compactionRetryPaused = true;
    valueWorkerCompactionGate = true;
    pendingRecovery = { scope, parentId: scope.leafId, operationId, expiresAt: now + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs,
      interval, compiled, historyConfigKey, authorship: "deterministic-recovery",
      resumeAfter: resumeAfter && event.outcome !== "aborted" && !signal?.aborted,
      nativeContinue: resumeAfter && event.outcome === "completed", allowArchive: event.outcome !== "aborted", signal };
    compilerTerminal = { state: "returned", receiptId: compiled.receipt.receiptId };
    return { entries: [{ type: "compaction", summary: compiled.summary, firstKeptEntryId: null,
      details: { kind: "chrono-v4-deterministic-recovery", contextReceipt: compiled.receipt,
        recoveryOperation: { schemaVersion: 1, operationId, reason, retention: "none", retainNoneIntent,
          sourceSnapshotId: interval.identity, protectedEntryIds: recovery.protectedEntryIds, authority: "derived" } } }],
      continue: pendingRecovery.nativeContinue };
  };
  const verifyRecoveryCommit = (ctx: ExtensionContext): boolean => {
    const pending = pendingRecovery;
    if (!pending) return false;
    const scope = sessionSummaryScope(ctx, summaryEpoch);
    if (pending.scope.epoch !== summaryEpoch || pending.scope.sessionId !== scope.sessionId
      || pending.scope.sessionFile !== scope.sessionFile || stableStringify(pending.scope.model) !== stableStringify(scope.model)
      || inputPending || ctx.hasPendingMessages() || Date.now() >= pending.expiresAt
      || stableStringify(userConfig.historyHelpers ?? null) !== pending.historyConfigKey) throw new Error("context-v4-recovery-commit-stale");
    const entry = correlatedBoundaryCompaction({ entries: ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[],
      sessionId: scope.sessionId, parentId: pending.parentId, operationId: pending.operationId,
      receiptId: pending.compiled.receipt.receiptId, summaryHash: pending.compiled.receipt.summaryHash,
      expectedReceipt: pending.compiled.receipt });
    if (!entry) throw new Error("context-v4-recovery-commit-unobserved");
    projectIntervalRestart(ctx, ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages));
    const eligible = pending.resumeAfter && !pending.signal?.aborted && !ctx.signal?.aborted;
    clearSessionSummary(true);
    compactionRetryPaused = pending.authorship === "current-agent"
      ? !!pending.signal?.aborted || !!ctx.signal?.aborted : !eligible;
    compilerTerminal = { state: "committed", receiptId: pending.compiled.receipt.receiptId };
    committedReceipt = contextReceiptLocator(entry, scope.sessionId);
    receiptLookupEntries = 1;
    receiptLookupComplete = true;
    valueWorkerCompactionGate = false;
    triggerPending = false;
    lastTriggerAttemptTokens = undefined;
    if (eligible) retainCompactionResume(ctx, entry, pending.signal);
    if (pending.allowArchive && !pending.signal?.aborted) {
      intervalHelpers.archiveVerified({ snapshot: pending.interval, commitId: entry.id!, verified: true, ctx });
    }
    return pending.nativeContinue && eligible;
  };
  pi.on("context", async (event, ctx) => {
    let contextBinding = originalRunBinding(ctx);
    const project = async (): Promise<{ messages: typeof event.messages } | undefined> => {
    const seenToolCallIds = projectionSeenToolCallIds;
    projectionSeenToolCallIds = new Set();
    for (const message of event.messages) {
      if (message.role === "toolResult") projectionSeenToolCallIds.add(message.toolCallId);
    }
    const state = projectionState;
    if (!state.pending && !state.snapshot) return undefined;
    const boundary = state.pending;
    state.pending = false;
    const settings = resolveExtensionSettings(userConfig);
    // Settings apply at the next compaction, not to an already-sent prefix.
    if (!state.snapshot && settings.toolResultProjectionMode === "off") return undefined;
    try {
      const branchEntries = asEntries(ctx.sessionManager.getBranch());
      const result = await projectToolResultContext(
        event.messages as unknown as readonly ContextMessageLike[],
        {
          mode: settings.toolResultProjectionMode,
          seenToolCallIds,
          sourceByToolCallId: projectionSourcesFromBranch(branchEntries),
          snapshot: state.snapshot,
        },
      );
      if (projectionState !== state) return undefined;
      if (boundary && result.metrics.projectedToolResults > 0) state.snapshot = result.snapshot;
      lastProjectionMetrics = result.metrics;
      if (result.metrics.projectedToolResults === 0) return undefined;
      return { messages: result.messages as unknown as typeof event.messages };
    } catch (error) {
      if (projectionState !== state) return undefined;
      lastProjectionMetrics = {
        mode: state.snapshot?.mode ?? settings.toolResultProjectionMode,
        sourceTokens: 0,
        projectedTokens: 0,
        removedTokens: 0,
        totalToolResults: 0,
        projectedToolResults: 0,
        exactRecoveryCovered: 0,
        keptRecent: 0,
        keptFirstConsumption: 0,
        protectedResults: 0,
        tooSmallResults: 0,
        refusedResults: 0,
        reducerFamilies: {},
        refusalReason: safeErrorMessage(error),
      };
      return undefined;
    }
    };
    let projected: { messages: typeof event.messages } | undefined;
    if (!preview && searchSettings().contextCompiler === "v4") {
      try {
        requireIntervalHost(ctx);
        await refreshCommittedRestart(ctx);
        if (contextBinding !== originalRunBinding(ctx)) return undefined;
        if (pendingRecovery) {
          if (verifyRecoveryCommit(ctx)) takeCompactionResume(ctx);
          contextBinding = originalRunBinding(ctx);
        }
        const expanded = projectIntervalRestart(ctx, event.messages);
        if (expanded) projected = { messages: expanded as typeof event.messages };
      } catch (error) {
        if (contextBinding === originalRunBinding(ctx)) refuseSessionSummary(ctx, error);
        return undefined;
      }
    } else if (!preview) projected = await project();
    if (contextBinding !== originalRunBinding(ctx)) return undefined;
    providerAdmission = undefined;
    if (searchSettings().contextCompiler === "v4") {
      try {
        requireIntervalHost(ctx);
        let messages = projected?.messages ?? event.messages;
        let { tokens } = currentRequestBudget(ctx, messages);
        let state = sessionSummary;
        if (state) {
          if (state.delivery !== "sent" || state.consumed || state.accepted || triggerPending) throw new Error("session-agent-summary-provider-suspended");
          watchSummaryAbort(ctx, state, ctx.signal);
          if (sessionSummary !== state) return projected;
          const consumed = consumeSessionAgentSummaryRequest(state.request, summaryObservation(ctx), messages);
          if (!consumed) throw new Error("session-agent-summary-request-unavailable");
          requireSummaryReadiness(ctx, tokens);
          state.consumed = consumed;
        } else if (pendingRecovery || recoveryIntent || (compactionRetryPaused && !summaryRecoveryRequested)) {
          if (!ctx.isIdle()) ctx.abort();
          return projected;
        } else {
          const directRecovery = summaryRecoveryRequested;
          const pressure = directRecovery ? undefined : intervalPressure(ctx, tokens);
          if (pressure && !pressure.budget.available) throw new Error(`context-v4-${pressure.reasons[0] ?? "interval-policy-unavailable"}`);
          if (pressure?.status === "recovery") {
            queueIntervalRecovery(ctx, pressure.reasons[0] ?? "context-v4-recovery-admission-unavailable");
            return projected;
          }
          if (directRecovery || pressure?.status === "freeze" || tokens >= summaryTriggerLimit(ctx)) {
            const intent = summaryInputIntent;
            if (inputPending || ctx.signal?.aborted || (directRecovery && !intent)) throw new Error("session-agent-summary-direct-input-unavailable");
            const requestScope = directRecovery ? bindSessionAgentSummaryInput(intent!, summaryObservation(ctx), messages)
              : sessionSummaryScope(ctx, summaryEpoch);
            await refreshIntervalSource(ctx);
            if (contextBinding !== originalRunBinding(ctx) || (directRecovery && summaryInputIntent !== intent)) return undefined;
            // Use this same request for the handoff when direct input recovers
            // a paused session or estimated pressure freezes ordinary work.
            const reason = directRecovery ? "manual" : "threshold";
            state = beginSessionSummary(ctx, reason, "sent", undefined, undefined, tokens, directRecovery,
              captureOriginalContinuation(ctx, reason), undefined, requestScope);
            const content = renderSessionAgentSummaryRequest(state.request);
            const requestMessage = { role: "custom" as const, customType: SESSION_AGENT_SUMMARY_CUSTOM_TYPE,
              content, display: false, timestamp: state.request.createdAt,
              details: { requestId: state.request.requestId, authority: "derived",
                ...(directRecovery ? { userEntryId: requestScope.leafId } : { sourceEntryId: requestScope.leafId }) } };
            messages = [...messages, requestMessage];
            ({ tokens } = currentRequestBudget(ctx, messages));
            requireSummaryReadiness(ctx, tokens);
            if (directRecovery) pi.appendEntry("chrono-summary-input-operation", { schemaVersion: 1, requestId: state.request.requestId,
              userEntryId: requestScope.leafId, sourceSnapshotId: state.interval.identity, authority: "derived" });
            watchSummaryAbort(ctx, state, ctx.signal);
            if (sessionSummary !== state) return undefined;
            state.consumed = consumeSessionAgentSummaryRequest(state.request, summaryObservation(ctx), messages);
            if (!state.consumed) throw new Error("session-agent-summary-request-unavailable");
            projected = { messages };
          } else {
            if (lastIntervalRequestTokens !== undefined) intervalGrowthTokens = Math.max(0, tokens - lastIntervalRequestTokens);
            lastIntervalRequestTokens = tokens;
          }
        }
        providerAdmission = { scope: sessionSummaryScope(ctx, summaryEpoch),
          ...(state ? { requestId: state.request.requestId } : {}) };
      } catch (error) {
        if (contextBinding !== originalRunBinding(ctx)) return undefined;
        if (!sessionSummary && !summaryRecoveryRequested && safeCompositionFailureCode(error) === "session-agent-summary-headroom-unavailable") {
          queueIntervalRecovery(ctx, "context-v4-recovery-admission-unavailable");
        } else refuseSessionSummary(ctx, error);
      }
    }
    return projected;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (searchSettings().contextCompiler !== "v4") return;
    let payload = event.payload;
    try {
      requireIntervalHost(ctx);
      payload = capIntervalProviderPayload(ctx.model, payload);
      const admission = providerAdmission, state = sessionSummary;
      if (!admission || stableStringify(admission.scope) !== stableStringify(sessionSummaryScope(ctx, summaryEpoch))
        || pendingRecovery || recoveryIntent || state?.accepted || (compactionRetryPaused && !state)
        || admission.requestId !== state?.request.requestId || (state && !state.consumed)) {
        throw new Error("session-agent-summary-provider-suspended");
      }
      // The context hook owns the token estimate. This hook only preserves
      // request lifecycle guards and the supported completion output cap.
    } catch (error) {
      refuseSessionSummary(ctx, error);
    }
    // Preserve the request apart from its supported, budget-bound output cap.
    return payload === event.payload ? undefined : payload;
  });

  const resolveStartedLogicalSession = async (ctx: ExtensionContext): Promise<LogicalActivationGrant | undefined> => {
    const entries = asEntries(ctx.sessionManager.getBranch());
    const binding = recordedLogicalBinding(entries);
    automaticRolloverBootstrapBytes = binding ? logicalBootstrapBytes(ctx.sessionManager.getHeader(), entries) : 0;
    const sourcePath = ctx.sessionManager.getSessionFile();
    if (!sourcePath) return undefined;
    if (!binding) {
      const adoption = recordedLogicalAdoptionBinding(entries);
      if (adoption) {
        const manifest = await new LogicalSessionStore(logicalSessionRoot, adoption.logicalSessionId).read();
        if (!manifest) throw new Error("logical-session-manifest-missing");
        return resolveAdoptedLogicalActivation(manifest, { piSessionId: ctx.sessionManager.getSessionId(), sourcePath }, adoption);
      }
      if (entries.some(entry => ["chrono-logical-adoption", "chrono-logical-continuation"].includes(String((entry as unknown as Record<string, unknown>).customType)))) {
        throw new Error("logical-session-binding-invalid");
      }
      return undefined;
    }
    const store = new LogicalSessionStore(logicalSessionRoot, binding.logicalSessionId);
    const rollover = new ManualLogicalRollover(store);
    let manifest = await store.read();
    if (!manifest) throw new Error("logical-session-manifest-missing");
    if (manifest.pendingRollover?.operationId === binding.operationId) {
      if (binding.logicalSessionId !== manifest.logicalSessionId || binding.branchId !== manifest.pendingRollover.branchId
        || binding.fromShardId !== manifest.pendingRollover.oldShardId || binding.shardId !== manifest.pendingRollover.newShardId) {
        throw new Error("logical-session-recovery-binding-mismatch");
      }
      if (manifest.pendingRollover.phase === "close-prepared") {
        await rollover.bindRecordedNewShard(binding.operationId, ctx.sessionManager as unknown as SessionSetupPort, binding.continuationHash);
      }
      manifest = await store.read();
      if (manifest?.pendingRollover?.operationId === binding.operationId && manifest.pendingRollover.phase === "new-shard-bound") {
        await rollover.activateNewShard(binding.operationId, ctx.sessionManager as unknown as SessionSetupPort);
      }
      manifest = await store.read();
    }
    if (!manifest) throw new Error("logical-session-manifest-missing");
    return resolveLogicalActivation(manifest, { piSessionId: ctx.sessionManager.getSessionId(), sourcePath }, binding);
  };

  const adoptStartedSession = async (ctx: ExtensionContext, branchId: string): Promise<LogicalActivationGrant> => {
    const sessionId = ctx.sessionManager.getSessionId(), sourcePath = ctx.sessionManager.getSessionFile(), epoch = rolloutEpoch;
    if (!sourcePath) throw new Error("logical-session-adoption-invalid");
    // A retry after manifest publication uses the same store, not a second shard.
    const key = createHash("sha256").update("pi-logical-adoption-v1\0").update(sessionId).update("\0").update(sourcePath).digest("hex");
    const logicalSessionId = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
    const store = new LogicalSessionStore(logicalSessionRoot, logicalSessionId);
    const manifest = await adoptExistingSessionAsShardZero(store, { ownerKey: key, branchId, piSessionId: sessionId, sourcePath });
    if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sourcePath) {
      throw new Error("logical-session-adoption-session-changed");
    }
    const adoption = logicalAdoptionBinding(manifest, branchId);
    pi.appendEntry("chrono-logical-adoption", adoption);
    return resolveAdoptedLogicalActivation(manifest, { piSessionId: sessionId, sourcePath }, adoption);
  };

  pi.on("session_start", async (event, ctx) => {
    inputPending = false;
    recoveryUsed = false;
    intervalGrowthTokens = 0;
    lastIntervalRequestTokens = undefined;
    intervalHelpers.invalidate();
    helperPreparationKey = undefined;
    if (searchSettings().contextCompiler !== "v4") compactionRetryPaused = false;
    else if (sessionSummary || pendingRecovery || recoveryIntent) compactionRetryPaused = true;
    clearSessionSummary();
    if (preview) return;
    // Snapshots are in-memory only. Reload/resume starts exact and waits for a
    // new successful compaction rather than reconstructing a sent projection.
    projectionState = { pending: false };
    projectionSeenToolCallIds = new Set();
    lastProjectionMetrics = undefined;
    const epoch = ++rolloutEpoch;
    pendingCompiler = undefined;
    compilerTerminal = undefined;
    restoreReceiptLocator(ctx);
    const nextSearchSessionId = ctx.sessionManager.getSessionId();
    const sourcePath = ctx.sessionManager.getSessionFile();
    if (!canaryControlInitialized) {
      canary = new SessionCanary(pi.getFlag?.("chrono-canary-session"));
      canaryControlInitialized = true;
    }
    const canaryRequested = canary.requested(nextSearchSessionId);
    const parentSession = event.reason === "new"
      ? (ctx.sessionManager as unknown as { getHeader?: () => { parentSession?: unknown } }).getHeader?.()?.parentSession
      : undefined;
    const markedProvisionalReplacement = typeof parentSession === "string"
      && consumeProvisionalLogicalReplacement(parentSession);
    const branchEntries = markedProvisionalReplacement || canaryRequested
      ? asEntries(ctx.sessionManager.getBranch())
      : undefined;
    canary.start(nextSearchSessionId, sourcePath, canaryRequested ? branchEntries ?? [] : []);
    sessionSearchOverride = undefined;
    sessionRolloutPersisted = false;
    logicalGrant = undefined;
    rolloutError = undefined;
    search.cancel();
    let provisionalLogicalReplacement = false;
    if (markedProvisionalReplacement && branchEntries) {
      // Pi creates model/thinking bootstrap entries before session_start. Reuse
      // the fresh-canary policy: at most 16 model/thinking/session-info entries,
      // with all conversation, tool, compaction, and custom entries rejected.
      const freshness = new SessionCanary(nextSearchSessionId);
      freshness.start(nextSearchSessionId, sourcePath, branchEntries);
      provisionalLogicalReplacement = freshness.active(nextSearchSessionId, sourcePath);
    }
    if (provisionalLogicalReplacement) {
      // Pi 0.85.1 can bind and start the replacement extension before setup.
      // The post-activation reload performs normal startup from the recorded binding.
      startupContext = undefined;
      capsuleShadow.cancel();
      catalogShadow.cancel();
      cancelIncrementalWork(true);
      cancelShadowWork();
      cancelValueWorker();
      historyLedger = undefined;
      return;
    }
    try {
      const enabled = sourcePath ? await readSessionRollout(sessionRolloutDirectory, { sessionId: nextSearchSessionId, sourcePath }) : undefined;
      if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== nextSearchSessionId) return;
      sessionRolloutPersisted = enabled !== undefined;
      logicalGrant = await resolveStartedLogicalSession(ctx);
      if (!logicalGrant && sourcePath && searchSettings().memoryEngineEnabled && enabled !== false
        && (configuredValue("PI_CHRONO_SEARCH_INDEX", userConfig.searchIndexEnabled) === undefined
          || booleanSetting("PI_CHRONO_SEARCH_INDEX", false, userConfig.searchIndexEnabled))) {
        logicalGrant = await adoptStartedSession(ctx, "main");
      }
      if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== nextSearchSessionId) return;
      // A persisted exclusion takes precedence over a continuation grant.
      sessionSearchOverride = enabled ?? (logicalGrant || canary.active(nextSearchSessionId, sourcePath) ? true : undefined);
    } catch {
      if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== nextSearchSessionId) return;
      sessionSearchOverride = false;
      rolloutError = "search-v3-rollout-unsafe";
    }
    beginStartup(ctx);
    capsuleShadow.cancel();
    scheduleCapsuleShadow(ctx);
    catalogShadow.cancel();
    scheduleCatalogShadow(ctx);
    scheduleSearch(ctx);
    cancelIncrementalWork(true);
    cancelShadowWork();
    cancelValueWorker();
    historyLedger = undefined;
    const settings = resolveExtensionSettings(userConfig);
    if (settings.legacyHistoryEditorEnabled && !legacyHistoryEditorWarningShown && ctx.hasUI) { legacyHistoryEditorWarningShown = true; ctx.ui.notify("The old ChronoCompact history-classifier setting is retired and cannot start a model call. Use the background value-worker settings for explicit opt-in.", "warning"); }
    scheduleIncrementalWork(ctx);
  });

  const invalidateSummaryScope = (ctx: ExtensionContext): void => {
    inputPending = false;
    intervalHelpers.invalidate();
    helperPreparationKey = undefined;
    intervalGrowthTokens = 0;
    lastIntervalRequestTokens = undefined;
    if (sessionSummary || pendingRecovery || recoveryIntent) refuseSessionSummary(ctx, new Error("session-agent-summary-session-changed"));
    else clearSessionSummary();
  };
  pi.on("session_before_tree", (_event, ctx) => { invalidateSummaryScope(ctx); });
  pi.on("model_select", (_event, ctx) => { invalidateSummaryScope(ctx); });
  pi.on("thinking_level_select", (_event, ctx) => { invalidateSummaryScope(ctx); });
  pi.on("input", (event, ctx) => {
    const interrupted = !!sessionSummary || !!pendingRecovery || !!recoveryIntent;
    intervalHelpers.invalidate();
    helperPreparationKey = undefined;
    if (event.source === "interactive" || event.source === "rpc") recoveryUsed = false;
    clearSessionSummary();
    // Pi may compact the old projection before it persists this new prompt.
    // Fence both summary delivery and hidden continuation at input receipt.
    inputPending = true;
    if (searchSettings().contextCompiler === "v4") {
      compactionRetryPaused ||= interrupted;
      // Input from extensions is not deliberate recovery. Pin the new native
      // user leaf later in context, after Pi has persisted the direct input.
      summaryRecoveryRequested = compactionRetryPaused && (event.source === "interactive" || event.source === "rpc");
      if (summaryRecoveryRequested) {
        try {
          requireIntervalHost(ctx);
          const now = Date.now();
          summaryInputIntent = { scope: sessionSummaryScope(ctx, summaryEpoch), createdAt: now,
            expiresAt: now + SESSION_AGENT_SUMMARY_LIMITS.lifetimeMs };
        } catch (error) { refuseSessionSummary(ctx, error); }
      }
    } else compactionRetryPaused = false;
    if (compactionRetryPaused) lastTriggerAttemptTokens = undefined;
    return { action: "continue" };
  });

  pi.on("session_tree", (_event, ctx) => {
    if (sessionSummary || pendingRecovery || recoveryIntent) compactionRetryPaused = true;
    clearSessionSummary();
    if (preview) return;
    // A native tree move replaces the active branch, not the logical session.
    // Fence old requests before retargeting the existing derived-store scheduler.
    rolloutEpoch++;
    pendingCompiler = undefined;
    compilerTerminal = undefined;
    restoreReceiptLocator(ctx);
    ownedCompaction = undefined;
    deferredCompactionSearch = undefined;
    triggerPending = false;
    forcedCompactionReason = undefined;
    forcedContinuationPending = false;
    continueAfterSuccessfulCompaction = false;
    // Navigation fences the old ticket. It does not prove a recovered V4 context.
    if (searchSettings().contextCompiler !== "v4") compactionRetryPaused = false;
    valueWorkerCompactionGate = false;
    if (automaticRolloverTimer) clearTimeout(automaticRolloverTimer);
    automaticRolloverTimer = undefined;
    automaticRolloverTicket = undefined;
    automaticRolloverStatus = { state: "idle" };
    search.cancel();
    capsuleShadow.cancel();
    catalogShadow.cancel();
    cancelIncrementalWork(true);
    cancelShadowWork();
    cancelValueWorker();
    historyLedger = undefined;
    projectionState = { pending: false };
    projectionSeenToolCallIds = new Set();
    lastProjectionMetrics = undefined;
    scheduleSearch(ctx);
    scheduleCapsuleShadow(ctx);
    scheduleCatalogShadow(ctx);
    scheduleIncrementalWork(ctx);
  });

  pi.on("session_before_switch", (_event, ctx) => {
    invalidateSummaryScope(ctx);
    if (preview) return;
    ownedCompaction = undefined;
    canary.stop();
    startupContext = undefined;
    logicalGrant = undefined;
    rolloutEpoch++;
    search.cancel();
    capsuleShadow.cancel();
    catalogShadow.cancel();
    cancelIncrementalWork(true);
    cancelShadowWork();
    cancelValueWorker();
    historyLedger = undefined;
    projectionSeenToolCallIds = new Set();
  });

  pi.on("session_before_fork", (_event, ctx) => {
    invalidateSummaryScope(ctx);
    if (preview) return;
    ownedCompaction = undefined;
    canary.stop();
    startupContext = undefined;
    logicalGrant = undefined;
    rolloutEpoch++;
    search.cancel();
    capsuleShadow.cancel();
    catalogShadow.cancel();
    cancelIncrementalWork(true);
    cancelShadowWork();
    cancelValueWorker();
    historyLedger = undefined;
    projectionSeenToolCallIds = new Set();
  });

  pi.on("session_shutdown", () => {
    clearSessionSummary();
    intervalHelpers.close();
    if (preview) return;
    ownedCompaction = undefined;
    if (automaticRolloverTimer) clearTimeout(automaticRolloverTimer);
    automaticRolloverTimer = undefined;
    automaticRolloverTicket = undefined;
    startupContext = undefined;
    logicalGrant = undefined;
    rolloutEpoch++;
    search.dispose();
    capsuleShadow.dispose();
    catalogShadow.dispose();
    retrievalFeedback.clear();
    feedbackAdmission.release();
    cancelIncrementalWork(true);
    cancelShadowWork();
    cancelValueWorker();
    historyLedger = undefined;
    projectionState = { pending: false };
    projectionSeenToolCallIds = new Set();
    lastProjectionMetrics = undefined;
  });

  // Neither a new agent run nor an extension-generated turn proves recovery.
  pi.on("before_agent_start", () => { if (searchSettings().contextCompiler !== "v4") compactionRetryPaused = false; });

  pi.on("agent_start", (_event, ctx) => {
    if (sessionSummary) return;
    const binding = originalRunBinding(ctx);
    if (originalRun?.binding !== binding) originalRun = { binding, inLoop: true, hasInput: false, unresolved: false };
    else originalRun.inLoop = true;
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role === "user") inputPending = false;
    if (message.role !== "user" && message.role !== "custom") return;
    if (message.role === "custom" && [SESSION_AGENT_SUMMARY_CUSTOM_TYPE, SESSION_AGENT_BOUNDARY_CUSTOM_TYPE,
      CONTEXT_RESUME_CUSTOM_TYPE, CONTEXT_WARNING_CUSTOM_TYPE].includes(message.customType)) return;
    if (sessionSummary || pendingRecovery || recoveryIntent) {
      refuseSessionSummary(ctx, new Error("session-agent-summary-request-interrupted"));
      return;
    }
    compactionResume = undefined;
    // Passive stored messages are not work. Only input actually delivered into
    // an observed agent loop counts, including a live custom-message-origin run.
    if (originalRun?.inLoop && originalRun.binding === originalRunBinding(ctx)) {
      originalRun.hasInput = true;
      originalRun.unresolved = true;
    }
  });
  pi.on("agent_end", (_event, ctx) => {
    if (!originalRun) return;
    originalRun.inLoop = false;
    if (!sessionSummary && ctx.signal?.aborted) originalRun.unresolved = false;
  });

  (pi as unknown as ActionableSettlementAPI).on("turn_end", async (event, ctx) => {
    if (preview && !sessionSummary) return undefined;
    const binding = originalRunBinding(ctx);
    observeOriginalTurn(ctx, event.message);
    const usage = ctx.getContextUsage(), message = event.message;
    // Only a successful same-model observation may anchor current admission.
    const validObservation = message.role === "assistant" && !["error", "aborted", "pending"].includes(message.stopReason ?? "")
      && message.provider === ctx.model?.provider && message.model === ctx.model?.id && message.api === ctx.model?.api;
    const reportedTokens = validObservation && Number.isFinite(message.usage?.totalTokens)
      && (message.usage?.totalTokens ?? 0) > 0 ? message.usage!.totalTokens! : 0;
    const currentTokens = Math.max(usage?.tokens ?? 0, reportedTokens);
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const percent = contextWindow > 0 ? (currentTokens / contextWindow) * 100 : 0;

    if (searchSettings().contextCompiler === "v4") {
      try {
        requireIntervalBoundary(ctx, event);
        const sameModel = message.role === "assistant" && message.provider === ctx.model?.provider
          && message.model === ctx.model?.id && message.api === ctx.model?.api;
        const assistant = message as Parameters<typeof isContextOverflow>[0];
        const sizeFailure = sameModel && (isContextOverflow(assistant, ctx.model?.contextWindow)
          || isRecoverableLength(assistant, ctx.model?.maxTokens ?? 0));
        if (recoveryIntent || sizeFailure) {
          const state = sessionSummary;
          const failedSummaryEntryId = state?.consumed
            ? identifyFailedSessionAgentSummary(state.consumed, summaryObservation(ctx), event.messageEntryId) : undefined;
          const resumeAfter = !recoveryIntent && (state ? state.resumeAfter : captureOriginalContinuation(ctx, "threshold"));
          return await prepareRecoveryProposal(ctx, event, recoveryIntent?.reason ?? "context-v4-provider-size-failure", resumeAfter,
            failedSummaryEntryId);
        }
        if (pendingRecovery) throw new Error("context-v4-recovery-commit-unobserved");
        if (compactionRetryPaused && !sessionSummary) return undefined;
        const state = sessionSummary;
        if (state) {
          if (stableStringify(userConfig.historyHelpers ?? null) !== state.historyConfigKey) throw new Error("session-agent-summary-request-interrupted");
          const view = summaryObservation(ctx);
          consumeSessionAgentSummaryRequest(state.request, view, []);
          if (state.accepted) {
            if (!preview) return await prepareAcceptedSummaryProposal(ctx, event, state);
            settleSessionAgentSummary(state.accepted, view);
          } else if (state.consumed) throw new Error("session-agent-summary-submission-unavailable");
          else requireSummaryReadiness(ctx, currentRequestTokens(ctx, undefined, currentTokens));
          return undefined;
        }
        if (event.outcome !== "completed" || event.entries.length || event.context.pendingMessages.length
          || inputPending || ctx.hasPendingMessages()) return undefined;
        if (intervalPreparation?.binding === originalRunBinding(ctx)) intervalPreparation.turns++;
        const tokens = currentRequestTokens(ctx, undefined, reportedTokens);
        const pressure = intervalPressure(ctx, tokens);
        if (!pressure.budget.available) throw new Error(`context-v4-${pressure.reasons[0] ?? "interval-policy-unavailable"}`);
        if ((userConfig.historyHelpers?.activePrefix || userConfig.historyHelpers?.event)
          && (pressure.status === "notice" || event.toolResults.some(result => !result.isError && ["workplan", "todo"].includes(result.toolName ?? "")))) {
          await refreshIntervalSource(ctx);
          if (binding !== originalRunBinding(ctx)) return undefined;
          prepareIntervalHelpers(ctx, captureCurrentInterval(ctx), captureIntervalRuntimeBudget(pi, ctx));
        }
        if (pressure.status === "recovery") {
          return await prepareRecoveryProposal(ctx, event, pressure.reasons[0] ?? "context-v4-recovery-admission-unavailable",
            captureOriginalContinuation(ctx, "threshold"));
        }
        if (pressure.status === "freeze" || tokens >= summaryTriggerLimit(ctx)) {
          await refreshIntervalSource(ctx);
          if (binding !== originalRunBinding(ctx)) return undefined;
          const request = beginSessionSummary(ctx, "threshold", "sent", undefined, undefined, tokens);
          return { entries: [{ type: "custom_message", customType: SESSION_AGENT_SUMMARY_CUSTOM_TYPE,
            content: renderSessionAgentSummaryRequest(request.request), display: false }], continue: true };
        }
        if (pressure.status === "notice") noticeIntervalPreparation(ctx);
      } catch (error) { if (binding === originalRunBinding(ctx)) reportRecoveryRefusal(ctx, error); }
      return undefined;
    }
    if (compactionRetryPaused) return undefined;

    if (forcedCompactionReason) {
      if (!ctx.isIdle()) ctx.abort();
      return;
    }
    if (percent >= CONTEXT_CIRCUIT_BREAKER_PERCENT) {
      forcedCompactionReason = `the ${CONTEXT_CIRCUIT_BREAKER_PERCENT}% turn-boundary circuit breaker activated`;
      if (ctx.hasUI) ctx.ui.notify(`ChronoCompact circuit breaker at ${percent.toFixed(1)}%; stopping the autonomous run before compaction.`, "warning");
      if (!ctx.isIdle()) ctx.abort();
      return;
    }

    const nextWarningLevel = percent >= CONTEXT_URGENT_PERCENT ? 2 : percent >= CONTEXT_WARNING_PERCENT ? 1 : 0;
    if (nextWarningLevel <= warningLevel) return;
    warningLevel = nextWarningLevel;
    const content = nextWarningLevel === 2
      ? `Context is ${percent.toFixed(1)}% full. Compaction is approaching. Finish the current atomic operation, preserve unresolved state, and call request_compaction at the next safe boundary. Do not begin broad new work.`
      : `Context is ${percent.toFixed(1)}% full. At the next natural checkpoint, consider preserving unresolved state and calling request_compaction. Continue the current atomic operation if interruption would be unsafe.`;
    pi.sendMessage({ customType: CONTEXT_WARNING_CUSTOM_TYPE, content, display: false }, { deliverAs: "steer" });
  });

  const automaticRolloverBlockers = (ctx: ExtensionContext): string[] => {
    const blockers: string[] = [];
    if (!ctx.isIdle() || ctx.hasPendingMessages()) blockers.push("session-busy");
    if (ctx.hasUI && ctx.ui.getEditorText().length > 0) blockers.push("editor-draft");
    if (triggerPending || valueWorkerCompactionGate || logicalSwitchActive || forcedCompactionReason || sessionSummary || compactionResume
      || pendingRecovery || recoveryIntent || intervalPreparation) blockers.push("compaction-or-switch-active");
    if (compactionRetryPaused) blockers.push("compaction-retry-paused");
    let processGuardPresent = false;
    pi.events.emit("grounded:session-transition-readiness:v1", { protocolVersion: 1, accept: (reply: unknown) => {
      const value = reply as { protocolVersion?: unknown; runningProcesses?: unknown; openSessions?: unknown };
      if (value?.protocolVersion !== 1 || !Number.isSafeInteger(value.runningProcesses) || Number(value.runningProcesses) < 0
        || !Number.isSafeInteger(value.openSessions) || Number(value.openSessions) < 0) return;
      processGuardPresent = true;
      if (Number(value.runningProcesses) > 0 || Number(value.openSessions) > 0) blockers.push("grounded-process-active");
    } });
    if (pi.getAllTools().some(tool => tool.name === "process" || tool.name === "session") && !processGuardPresent) {
      blockers.push("process-safety-guard-unavailable");
    }
    return blockers;
  };
  const refreshAutomaticRolloverStatus = (ctx: ExtensionContext): void => {
    if (automaticRolloverStatus.state !== "deferred") return;
    const blockers = automaticRolloverBlockers(ctx);
    automaticRolloverStatus = blockers.length ? { state: "deferred", blockers } : { state: "idle" };
  };
  const scheduleAutomaticRollover = (ctx: ExtensionContext): void => {
    const settings = resolveExtensionSettings(userConfig);
    if (!settings.memoryEngineEnabled || !settings.automaticRolloverEnabled || !logicalGrant || automaticRolloverTimer || automaticRolloverTicket) return;
    const sourcePath = ctx.sessionManager.getSessionFile(), sessionId = ctx.sessionManager.getSessionId();
    const epoch = rolloutEpoch, leafId = ctx.sessionManager.getLeafId();
    if (!sourcePath || !leafId || automaticRolloverAttemptedLeaf === leafId) return;
    const deadline = Date.now() + 60_000;
    const check = async (): Promise<void> => {
      automaticRolloverTimer = undefined;
      if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) return;
      const blockers = automaticRolloverBlockers(ctx);
      if (blockers.length) { automaticRolloverStatus = { state: "deferred", blockers }; return; }
      const source = await historySourceState(sourcePath);
      if (source.size < automaticRolloverBootstrapBytes + settings.rolloverSourceBytes) {
        automaticRolloverStatus = { state: "below-threshold", sourceBytes: source.size }; return;
      }
      // Poll only cached readiness, with one finite deadline. The command pins
      // the exact catalog cut and may use bounded fallback if optional state lags.
      if (!search.status().requestedViewValidated) {
        automaticRolloverStatus = { state: "waiting-for-catalog", sourceBytes: source.size };
        if (Date.now() < deadline) automaticRolloverTimer = setTimeout(() => { void check().catch(() => { automaticRolloverStatus = { state: "source-unavailable" }; }); }, 1000);
        return;
      }
      if (epoch !== rolloutEpoch || ctx.sessionManager.getLeafId() !== leafId || automaticRolloverBlockers(ctx).length) return;
      if (!pi.getCommands().some(command => command.name === "Chrono" && command.source === "extension")) {
        automaticRolloverStatus = { state: "dispatch-unavailable" }; return;
      }
      automaticRolloverAttemptedLeaf = leafId;
      automaticRolloverTicket = { nonce: randomUUID(), sessionId, sourcePath, leafId, epoch };
      automaticRolloverStatus = { state: "dispatched", sourceBytes: source.size };
      // Pi 0.85.1 dispatches extension commands before model preflight when this
      // option is true. This never writes editor text or sends a model prompt.
      pi.sendUserMessage(`/Chrono _auto-rollover ${automaticRolloverTicket.nonce}`, { expandPromptTemplates: true });
    };
    automaticRolloverTimer = setTimeout(() => { void check().catch(() => { automaticRolloverStatus = { state: "source-unavailable" }; }); }, 0);
  };

  // Native retry and queued work run first. This boundary is actionable even
  // though ctx.isIdle() is false for the surrounding AgentSession run.
  (pi as unknown as ActionableSettlementAPI).on("agent_before_settle", async (event, ctx) => {
    if (preview) return undefined;
    const binding = originalRunBinding(ctx);
    if (pendingRecovery || compactionResume) {
      try {
        requireIntervalBoundary(ctx, event);
        await refreshCommittedRestart(ctx);
        if (binding !== originalRunBinding(ctx)) return undefined;
      } catch (error) {
        if (binding === originalRunBinding(ctx)) reportRecoveryRefusal(ctx, error);
        return undefined;
      }
    }
    const recovery = pendingRecovery?.authorship === "deterministic-recovery";
    if (pendingRecovery) {
      try { verifyRecoveryCommit(ctx); }
      catch (error) { reportRecoveryRefusal(ctx, error); return undefined; }
    }
    if (!compactionResume) return undefined;
    if ((event.outcome !== "completed" && !(recovery && event.outcome === "error"))
      || event.continue || event.entries.length || event.context.pendingMessages.length) {
      compactionResume = undefined;
      return undefined;
    }
    const message = takeCompactionResume(ctx);
    return message ? { entries: [...event.entries, { type: "custom_message", ...message }], continue: true } : undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (preview) {
      originalRun = undefined;
      if (sessionSummary) scheduleSessionSummary(ctx);
      return;
    }
    let binding = originalRunBinding(ctx);
    if (pendingRecovery) {
      try {
        await refreshCommittedRestart(ctx);
        if (binding !== originalRunBinding(ctx)) return;
        verifyRecoveryCommit(ctx);
        binding = originalRunBinding(ctx);
      } catch (error) {
        if (binding !== originalRunBinding(ctx)) return;
        reportRecoveryRefusal(ctx, error);
        binding = originalRunBinding(ctx);
      }
    }
    originalRun = undefined;
    // Notification-only settlement cannot supply an automatic continuation.
    // Owned manual compaction still drains its intent from onComplete.
    if (!ownedCompaction) compactionResume = undefined;
    scheduleCapsuleShadow(ctx);
    scheduleCatalogShadow(ctx);
    const storedComposition = usesStoredComposition(ctx);
    // Compatibility precomputation keeps its existing pre-trigger ordering.
    if (!storedComposition) scheduleSearch(ctx);
    if (!sessionSummary) scheduleIncrementalWork(ctx);
    try {
      const usage = ctx.getContextUsage();
      if (searchSettings().contextCompiler === "v4") {
        if (compactionResume) return;
        try {
          if (!_event.aborted && !sessionSummary && !compactionRetryPaused && !ctx.hasPendingMessages()) {
            const tokens = currentRequestTokens(ctx);
            if (summaryTrigger(ctx, tokens)) {
              await refreshIntervalSource(ctx);
              if (binding !== originalRunBinding(ctx)) return;
              beginSessionSummary(ctx, "threshold", "deferred", undefined, undefined, tokens);
            }
          }
          scheduleSessionSummary(ctx);
        } catch (error) { if (binding === originalRunBinding(ctx)) refuseSessionSummary(ctx, error); }
        return;
      }
      if (compactionRetryPaused) return;
      if (forcedCompactionReason) {
        const reason = forcedCompactionReason;
        forcedCompactionReason = undefined;
        launchCompaction(ctx, reason, usage?.tokens ?? undefined, true);
        return;
      }

      const settings = resolveExtensionSettings(userConfig);
      if (!usage || usage.tokens === null) return;
      const decision = decideCompactionTrigger({
        currentTokens: usage.tokens,
        thresholdTokens: settings.triggerThresholdTokens,
        minimumGrowthTokens: settings.triggerMinimumGrowthTokens,
        lastAttemptTokens: lastTriggerAttemptTokens,
        pending: triggerPending,
      });
      if (!decision.trigger) return;
      launchCompaction(ctx, decision.reason, usage.tokens);
    } finally {
      // A pending V3 request defers this retarget until onComplete or onError.
      if (binding === originalRunBinding(ctx)) {
        if (storedComposition) scheduleSearch(ctx);
        if (storedComposition) scheduleAutomaticRollover(ctx);
      }
    }
  });

  pi.on("session_compact_failed", (event, ctx) => {
    // Preview vetoes native compaction without discarding a valid summary turn.
    // Abort, input and source guards still invalidate that turn independently.
    if (preview) return;
    const deferred = summaryDeferral;
    summaryDeferral = undefined;
    if (deferred?.awaitingInput && deferred.epoch === summaryEpoch && deferred.reason === event.reason
      && event.aborted && !deferred.signal.aborted && inputPending) {
      // The incoming prompt supersedes the old projection. Admission and any
      // paused barrier are checked later against its actual persisted context.
      return;
    }
    if (deferred && sessionSummary && deferred.epoch === summaryEpoch && deferred.requestId === sessionSummary.request.requestId
      && deferred.reason === event.reason && event.aborted && !deferred.signal.aborted) {
      // Pi reports our intentional threshold/manual deferral as a failed
      // compaction. It is not a failed summary and must not discard the ticket.
      scheduleSessionSummary(ctx);
      return;
    }
    if (sessionSummary || searchSettings().contextCompiler === "v4") {
      const failure = lastCompositionFailure;
      refuseSessionSummary(ctx, new Error(failure?.code ?? "session-agent-summary-compaction-failed"));
      if (failure) lastCompositionFailure = failure;
    }
    if (pendingCompiler && pendingCompiler.epoch === rolloutEpoch && pendingCompiler.sessionId === ctx.sessionManager.getSessionId()
      && pendingCompiler.sourcePath === ctx.sessionManager.getSessionFile()) {
      compilerTerminal = { state: "failed", receiptId: pendingCompiler.receiptId, code: lastCompositionFailure?.code ?? "pi-compaction-failed" };
    }
    pendingCompiler = undefined;
    valueWorkerCompactionGate = false;
    triggerPending = false;
    forcedContinuationPending = false;
    continueAfterSuccessfulCompaction = false;
  });

  pi.on("session_compact", async (event, ctx) => {
    if (preview) {
      refuseSessionSummary(ctx, new Error("session-agent-summary-preview-native-compaction-observed"));
      return;
    }
    const v4 = searchSettings().contextCompiler === "v4", binding = originalRunBinding(ctx);
    const compactionSignal = pendingCompiler?.signal;
    const archiveSource = pendingCompiler?.interval;
    let correlated = !v4;
    if (pendingCompiler) {
      const locator = contextReceiptLocator(event.compactionEntry, ctx.sessionManager.getSessionId());
      let policyCurrent = !v4;
      try { policyCurrent = !v4 || (!pendingCompiler.signal?.aborted && pendingCompiler.summaryEpoch === summaryEpoch
        && pendingCompiler.budgetKey === stableStringify(captureIntervalRuntimeBudget(pi, ctx))
        && pendingCompiler.historyConfigKey === stableStringify(userConfig.historyHelpers ?? null)); }
      catch (error) { lastCompositionFailure = { stage: "commit-policy", code: safeCompositionFailureCode(error) }; }
      correlated = policyCurrent && pendingCompiler.epoch === rolloutEpoch && pendingCompiler.sessionId === ctx.sessionManager.getSessionId()
        && pendingCompiler.sourcePath === ctx.sessionManager.getSessionFile() && event.compactionEntry.parentId === pendingCompiler.leafId
        && locator?.receiptId === pendingCompiler.receiptId && locator.summaryHash === pendingCompiler.summaryHash
        && createHash("sha256").update(event.compactionEntry.summary).digest("hex") === pendingCompiler.summaryHash && event.fromExtension
        && (!v4 || !!pendingCompiler.expectedReceipt && stableStringify((event.compactionEntry.details as {
          contextReceipt?: CompiledContext["receipt"] } | undefined)?.contextReceipt) === stableStringify(pendingCompiler.expectedReceipt));
      compilerTerminal = { state: correlated ? "committed" : "uncorrelated", receiptId: pendingCompiler.receiptId };
      if (correlated) { committedReceipt = locator; receiptLookupEntries = 1; receiptLookupComplete = true; }
      pendingCompiler = undefined;
    }
    if (correlated && v4) {
      try {
        await refreshCommittedRestart(ctx);
        if (binding !== originalRunBinding(ctx)) return;
        projectIntervalRestart(ctx, ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages));
      }
      catch (error) {
        if (binding !== originalRunBinding(ctx)) return;
        correlated = false;
        lastCompositionFailure = { stage: "commit-source", code: safeCompositionFailureCode(error) };
      }
    }
    if (ownedCompaction) ownedCompaction.succeeded = correlated;
    valueWorkerCompactionGate = false;
    cancelIncrementalWork(true);
    projectionState = { pending: correlated };
    lastProjectionMetrics = undefined;
    const shouldContinue = correlated && continueAfterSuccessfulCompaction && !event.willRetry;
    // A successful V4 commit starts a new context cycle, not a failed retry.
    // Keeping the old high-water count can defer the next summary past admission.
    if (correlated && v4) {
      lastTriggerAttemptTokens = undefined;
      compactionRetryPaused = false;
    }
    if (v4 && !correlated) refuseSessionSummary(ctx, new Error("session-agent-summary-commit-uncorrelated"));
    else clearSessionSummary();
    triggerPending = false;
    forcedCompactionReason = undefined;
    forcedContinuationPending = false;
    continueAfterSuccessfulCompaction = false;
    warningLevel = 0;
    if (correlated && v4 && archiveSource) intervalHelpers.archiveVerified({ snapshot: archiveSource,
      commitId: event.compactionEntry.id, verified: true, ctx });
    if (shouldContinue && searchSettings().contextCompiler === "v4") {
      // Retain the exact event receipt. Other session_compact handlers can
      // append metadata before or after this handler. Dispatch only from the
      // actionable automatic boundary or the owned manual completion callback.
      retainCompactionResume(ctx, event.compactionEntry, compactionSignal);
    } else if (shouldContinue) {
      pi.sendMessage(
        {
          customType: CONTEXT_RESUME_CUSTOM_TYPE,
          content: "Compaction completed. Continue the unresolved task from the preserved state. Do not stop merely to report that compaction occurred.",
          display: false,
        },
        { triggerTurn: true },
      );
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (preview) return { cancel: true };
    if (inputPending && searchSettings().contextCompiler === "v4" && !sessionSummary?.boundary && !event.signal.aborted) {
      // Pre-prompt native compaction sees the previous leaf. Wait for the new
      // input to reach context before capturing its source and authorized run.
      summaryDeferral = { epoch: summaryEpoch, reason: event.reason, signal: event.signal, awaitingInput: true };
      return { cancel: true };
    }
    if (compactionRetryPaused && event.reason !== "manual" && !sessionSummary?.boundary) return { cancel: true };
    if (searchSettings().contextCompiler !== "v4") compactionRetryPaused = false;
    const compositionEpoch = rolloutEpoch, captureEpoch = summaryEpoch;
    const attempt = event.reason === "manual" ? ownedCompaction : undefined;
    if (attempt) attempt.signal = event.signal;
    let failureStage = "preparation";
    const recordFailure = (error: unknown): { stage: string; code: string } => {
      const failure = { stage: failureStage, code: safeCompositionFailureCode(error) };
      lastCompositionFailure = failure;
      if (attempt) attempt.failure = failure;
      return failure;
    };
    valueWorkerCompactionGate = true;
    cancelValueWorker();
    cancelIncrementalWork(false);
    let settings: RuntimeSettings;
    try { settings = searchSettings(); }
    catch (error) { recordFailure(error); valueWorkerCompactionGate = false; return { cancel: true }; }
    try {
      // Pi already owns this branch array. The default path must not copy or
      // parse lifetime entries before selecting its bounded suffix.
      const branchEntries = event.branchEntries as unknown as readonly SessionEntryLike[];
      if (event.signal?.aborted) return { cancel: true };
      if (settings.contextCompiler === "v4" && !sessionSummary?.boundary) {
        failureStage = "session-summary";
        if (event.reason === "overflow") throw new Error("session-agent-summary-overflow-unavailable");
        requireIntervalHost(ctx);
        if (!sessionSummary) {
          // A live provider run cannot be aborted and silently retried as a
          // summary. Native /compact must reach its settled public boundary.
          if (ctx.signal && !ctx.signal.aborted) throw new Error("session-agent-summary-active-run-unsupported");
          await refreshIntervalSource(ctx, undefined, undefined, event.signal);
          if (captureEpoch !== summaryEpoch || compositionEpoch !== rolloutEpoch) return { cancel: true };
          beginSessionSummary(ctx, event.reason, "deferred", event.customInstructions, undefined, undefined, event.reason === "manual", false);
        }
        const state = sessionSummary;
        if (!state) throw new Error("session-agent-summary-request-interrupted");
        consumeSessionAgentSummaryRequest(state.request, summaryObservation(ctx), []);
        if (++state.deferrals > 4) throw new Error("session-agent-summary-deferral-limit");
        summaryDeferral = { epoch: summaryEpoch, requestId: state.request.requestId, reason: event.reason, signal: event.signal };
        scheduleSessionSummary(ctx);
        return { cancel: true };
      }
      continueAfterSuccessfulCompaction = !event.willRetry && (settings.contextCompiler === "v4"
        ? sessionSummary?.resumeAfter === true
        : forcedContinuationPending || hasUnresolvedTurn(branchEntries.slice(-256)));
      if (attempt) attempt.resumeAfter ||= continueAfterSuccessfulCompaction;
      const preparedFirstKeptEntryId = event.preparation?.firstKeptEntryId;
      const tokensBefore = event.preparation?.tokensBefore;
      if (typeof preparedFirstKeptEntryId !== "string" || typeof tokensBefore !== "number") {
        throw new Error("Pi compaction preparation omitted firstKeptEntryId or tokensBefore.");
      }

      const canaryRequested = canary.requested(ctx.sessionManager.getSessionId());
      if (canaryRequested && !canary.active(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile())) return canary.refuse("session-ineligible");
      if (settings.contextCompiler === "v4") {
        failureStage = "v4-capture";
        pendingCompiler = undefined;
        const boundary = sessionSummary?.boundary;
        if (!boundary || stableStringify(userConfig.historyHelpers ?? null) !== sessionSummary?.historyConfigKey) {
          throw new Error("session-agent-summary-request-unavailable");
        }
        const prepared = await capturePreparedV4Context(pi, ctx, { branchEntries, preparation: event.preparation, signal: event.signal }, {
          settings: searchSettings, memoryOwner, epoch: () => summaryEpoch, boundary,
          historyConfig: () => userConfig.historyHelpers ?? null,
          refreshSource: () => refreshIntervalSource(ctx, boundary.interval, boundary.logicalSource, event.signal),
          revalidateSource: () => revalidateRuntimeInterval(ctx, boundary.interval!),
          readyHistory: (snapshot, budget) => readyIntervalHistory(ctx, snapshot, budget, event.signal),
        });
        failureStage = "v4-compile";
        prepared.revalidate();
        const compiled = compileContext(prepared.input);
        prepared.revalidate();
        requireExpandedRestartBudget(ctx, compiled);
        prepared.revalidate();
        pendingCompiler = { epoch: rolloutEpoch, sessionId: prepared.input.scope.sessionId,
          sourcePath: ctx.sessionManager.getSessionFile(), leafId: prepared.input.scope.leafId,
          receiptId: compiled.receipt.receiptId, summaryHash: compiled.receipt.summaryHash, signal: event.signal,
          interval: prepared.input.interval, historyConfigKey: stableStringify(userConfig.historyHelpers ?? null),
          summaryEpoch, budgetKey: stableStringify(prepared.input.budget), expectedReceipt: compiled.receipt };
        compilerTerminal = { state: "returned", receiptId: compiled.receipt.receiptId };
        lastCompositionFailure = undefined;
        return { compaction: { summary: compiled.summary, firstKeptEntryId: compiled.firstKeptEntryId, tokensBefore,
          details: { kind: "chrono-v4-composed-context", contextReceipt: compiled.receipt, retainedTail: prepared.tail } } };
      }
      const normalFixture = adapters.schedulerDirectory ? adapters.normalCompositionFixture : undefined;
      // V3 adapts only Pi's bounded prepared tail. Never construct the
      // compatibility lifetime-body estimator on the snapshot path.
      const estimateTailTokens = settings.memoryEngineEnabled || canaryRequested || normalFixture
        ? estimateEntryTokens : createTailTokenEstimator(branchEntries);

      if (settings.memoryEngineEnabled || canaryRequested || normalFixture) {
        failureStage = "context-budget";
        const combinedCeilingTokens = effectiveContextCeiling(ctx, settings, event.preparation.settings.reserveTokens);
        failureStage = "raw-tail-selection";
        const maximumTailTokens = Math.min(settings.dynamicRawTailMaxTokens, combinedCeilingTokens - 3_000);
        const adaptive = prepareAdaptiveChronoTail(branchEntries, event.preparation,
          Math.min(settings.dynamicRawTailMinTokens, maximumTailTokens), maximumTailTokens, settings.hybridSummaryEnabled);
        const selectedEntry = branchEntries[adaptive.tail.cutIndex];
        const sourceCutEntryId = branchEntries[adaptive.tail.cutIndex - 1]?.id;
        const availableSummaryTokens = combinedCeilingTokens - adaptive.tail.actualTokens;
        if (typeof sourceCutEntryId !== "string" || selectedEntry?.parentId !== sourceCutEntryId
          || availableSummaryTokens < 512) {
          recordFailure({ code: "search-v3-composition-boundary-invalid" });
          if (ctx.hasUI) ctx.ui.notify("Stored composition refused the adaptive boundary; compaction was cancelled.", "warning");
          return { cancel: true };
        }
        const sessionId = ctx.sessionManager.getSessionId(), epoch = rolloutEpoch;
        const sourcePath = ctx.sessionManager.getSessionFile(), branchLeaf = ctx.sessionManager.getLeafId();
        const identityChanged = () => epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== sessionId
          || ctx.sessionManager.getSessionFile() !== sourcePath || ctx.sessionManager.getLeafId() !== branchLeaf;
        const fallback = (reason: string) => {
          if (identityChanged() || event.signal?.aborted) return { cancel: true as const };
          failureStage = "bounded-fallback";
          const result = composeBoundedMemory({ branchEntries, cutIndex: adaptive.tail.cutIndex,
            firstKeptEntryId: adaptive.tail.firstKeptEntryId, rawTailTokens: adaptive.tail.actualTokens,
            combinedCeilingTokens, previousSummary: event.preparation.previousSummary, reason });
          if (ctx.hasUI) ctx.ui.notify(`ChronoCompact used bounded programmatic memory (${reason}); coverage is incomplete.`, "info");
          return { compaction: { summary: result.summary, firstKeptEntryId: adaptive.tail.firstKeptEntryId, tokensBefore,
            details: { kind: "chrono-v3-composed-context", fallback: result.receipt, retainedTail: adaptive.tail } } };
        };
        if (!normalFixture && (!searchSettings().searchIndexEnabled || startupStatus.state !== "ready" || rolloutError)) {
          return fallback("indexed memory unavailable; only the active Pi branch was used");
        }
        let pinnedSelection: Awaited<ReturnType<HistorySearchAdapter["compositionSelection"]>> | undefined;
        if (!normalFixture) {
          try {
            failureStage = "selection";
            pinnedSelection = await search.compositionSelection(sourceCutEntryId, event.signal);
            if (identityChanged() || event.signal?.aborted) return { cancel: true };
            if (pinnedSelection.stateGeneration === 0) return fallback("no committed memory generation is available");
          } catch (error) {
            if (isOptionalCompositionUnavailable(error)) return fallback("indexed memory is not ready");
            throw error;
          }
        }
        let regularPiSummary: Awaited<ReturnType<typeof createPiRegularSummary>>;
        try {
          regularPiSummary = settings.hybridSummaryEnabled && adaptive.summaryInputComplete ? await (normalFixture?.createPiSummary ?? createPiRegularSummary)(ctx, adaptive.preparation, {
            targetTokens: Math.min(settings.hybridSummaryTargetTokens, availableSummaryTokens),
            customInstructions: event.customInstructions,
            signal: event.signal,
            previousSummary: previousRegularPiSummary(branchEntries, event.preparation.previousSummary),
            messages: adaptive.preparation.messagesToSummarize,
          }) : undefined;
        } catch (error) {
          if (!event.signal?.aborted && ctx.hasUI) {
            ctx.ui.notify(`Regular Pi summary unavailable; deterministic history will continue: ${safeErrorMessage(error)}`, "warning");
          }
        }
        if (identityChanged() || event.signal?.aborted) {
          return { cancel: true };
        }
        try {
          failureStage = "composition";
          const composed = await (normalFixture?.compose ?? composeStoredCompactionForNormalReturn)({
            regularPiSummary: regularPiSummary?.text ?? "", sourceCutEntryId,
            firstKeptEntryId: adaptive.tail.firstKeptEntryId, rawTailTokens: adaptive.tail.actualTokens, toolPairSafe: true,
          }, {
            getEntry: entryId => ctx.sessionManager.getEntry(entryId) as SessionEntryLike | undefined,
            select: entryId => pinnedSelection && entryId === sourceCutEntryId ? Promise.resolve(pinnedSelection) : search.compositionSelection(entryId, event.signal),
            pin: async entryId => (await search.compositionTarget(entryId, event.signal)).view,
            recovery: encodeCompositionRecovery,
          }, join(dirname(userConfigPath), "chrono-compositions", createHash("sha256").update(sessionId).digest("hex")),
          combinedCeilingTokens);
          if (identityChanged() || event.signal?.aborted) return { cancel: true };
          return { compaction: { summary: composed.summary, firstKeptEntryId: composed.firstKeptEntryId, tokensBefore,
            ...(regularPiSummary?.usage === undefined ? {} : { usage: regularPiSummary.usage }),
            details: { kind: "chrono-v3-composed-context", composition: composed.envelope,
              ...(regularPiSummary ? { piSummary: regularPiSummary.text } : {}), retainedTail: adaptive.tail } } };
        } catch (error) {
          if (event.signal?.aborted || identityChanged()) {
            return { cancel: true };
          }
          if (isOptionalCompositionUnavailable(error)) return fallback("optional composition detail is unavailable");
          const failure = recordFailure(error);
          if (ctx.hasUI) {
            ctx.ui.notify(`Stored composition refused (${failure.stage}: ${failure.code}); current context is unchanged.`, "warning");
          }
          return canary.refuse("composition-refused");
        }
      }
      const preparedCutIndex = branchEntries.findIndex(entry => entry.id === preparedFirstKeptEntryId);
      if (preparedCutIndex < 0) throw new Error("Pi prepared cut entry was not present on the active branch.");
      const preparedTailTokens = estimateTailTokens(branchEntries.slice(preparedCutIndex));
      const combinedCeilingTokens = ctx.model ? effectiveContextCeiling(ctx, settings, event.preparation.settings.reserveTokens) : settings.targetContextTokens;
      const maximumRawTailTokens = Math.max(256, combinedCeilingTokens - 3_000);
      let tailSelection: RawTailSelection = {
        mode: "pi",
        actualTokens: preparedTailTokens,
        firstKeptEntryId: preparedFirstKeptEntryId,
        cutIndex: preparedCutIndex,
        reason: "used Pi's prepared keepRecentTokens cut point",
      };
      if (settings.rawTailMode === "dynamic") {
        const selected = selectDynamicRawTail(
          branchEntries,
          settings.dynamicRawTailMinTokens,
          settings.dynamicRawTailMaxTokens,
          estimateTailTokens,
        );
        if (selected) tailSelection = selected;
      } else if (settings.rawTailTokens !== undefined) {
        const selected = selectRawTail(branchEntries, settings.rawTailTokens, estimateTailTokens);
        if (selected) tailSelection = { ...selected, mode: settings.rawTailMode };
      }
      if (tailSelection.actualTokens > maximumRawTailTokens) {
        const bounded = selectRawTailWithinMaximum(
          branchEntries,
          maximumRawTailTokens,
          estimateTailTokens,
        );
        if (!bounded) throw new Error("No valid raw-tail cut can satisfy the configured combined ceiling.");
        tailSelection = { ...bounded, mode: tailSelection.mode };
      }
      if (!isSafeCompactionCut(branchEntries, tailSelection.cutIndex)) {
        const repaired = selectRawTailWithinMaximum(
          branchEntries,
          Math.min(maximumRawTailTokens, tailSelection.actualTokens),
          estimateTailTokens,
        );
        if (!repaired) throw new Error("No raw-tail cut can exclude an orphan function output.");
        tailSelection = {
          ...repaired,
          mode: tailSelection.mode,
          reason: `${tailSelection.reason}; moved the cut after an orphan function output`,
        };
      }

      const firstKeptEntryId = tailSelection.firstKeptEntryId;
      const sourceEntries = getSourceEntriesBefore(branchEntries, firstKeptEntryId);
      const retainedEntries = branchEntries.slice(tailSelection.cutIndex);
      const retainedTailTokens = tailSelection.actualTokens;
      const derivedTargetTokens = computeSummaryBudget({
        targetActiveContextTokens: settings.targetContextTokens,
        retainedTailTokens,
        minSummaryTokens: settings.minSummaryTokens,
        maxSummaryTokens: settings.maxSummaryTokens,
        contextReserveTokens: settings.contextReserveTokens,
      });
      const historicalCeilingTokens = combinedCeilingTokens - retainedTailTokens;
      const targetTokens = Math.min(
        historicalCeilingTokens,
        selectReplayTarget({
          derivedTargetTokens,
          fixedTargetTokens: settings.replayTargetTokens,
          maximumTokens: settings.maxSummaryTokens,
        }),
      );
      if (targetTokens < 256) throw new Error("The retained raw tail leaves no safe historical-context budget.");
      const config = resolveCompactorConfig({
        ...settings.config,
        targetTokens,
        minSummaryTokens: settings.minSummaryTokens,
        maxSummaryTokens: settings.maxSummaryTokens,
      });
      const retentionHints = retentionHintsFromBranch(branchEntries, event.customInstructions);
      const sessionPath = ctx.sessionManager.getSessionFile();
      const useIsolatedWorker = settings.isolatedWorkerEnabled && !!sessionPath;
      const currentRetrievalFeedback = sessionPath ? retrievalFeedback.get(sessionPath) : undefined;
      const memory = memoryOwner === "chrono" && settings.editableMemoryEnabled && sessionPath
        ? await readMemoryEvents(memorySidecarPath(sessionPath))
        : undefined;
      if (memory?.status === "corrupt-rebuild-required" && ctx.hasUI) {
        ctx.ui.notify(`ChronoCompact ignored corrupt editable memory and continued from immutable history: ${memory.error ?? "integrity failure"}`, "warning");
      }
      const pinnedMemoryText = memory?.status === "ready" ? renderPinnedMemory(memory.memories, branchEntries.length) : "";
      const previousPiSummary = previousRegularPiSummary(branchEntries, event.preparation.previousSummary);
      const summaryRebase = decideRegularSummaryRebase(branchEntries, previousPiSummary, { intervalGenerations: settings.summaryRebaseInterval });
      let generationHash: string | undefined = useIsolatedWorker
        ? undefined
        : computeGenerationHash(sourceEntries, config, retentionHints, retainedEntries, pinnedMemoryText, currentRetrievalFeedback);
      const configHash = hashCompactionConfig({
        extensionVersion: EXTENSION_VERSION,
        config,
        retentionHints,
        historyEditorEnabled: false,
        historyEditorMaxInputTokens: 0,
        historyEditorMaxOutputTokens: 0,
        historyEditorModel: undefined,
        hardCombinedContextCapTokens: combinedCeilingTokens,
        rawTailMode: settings.rawTailMode,
        rawTailTokens: settings.rawTailTokens,
        dynamicRawTailMinTokens: settings.dynamicRawTailMinTokens,
        dynamicRawTailMaxTokens: settings.dynamicRawTailMaxTokens,
        hybridSummaryEnabled: settings.hybridSummaryEnabled,
        hybridSummaryTargetTokens: settings.hybridSummaryTargetTokens,
        piSummaryModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
        piSummaryThinkingLevel: ctx.thinkingLevel,
        previousPiSummaryHash: previousPiSummary ? hashText(previousPiSummary) : undefined,
        rankedSearchEnabled: settings.rankedSearchEnabled,
        editableMemoryEnabled: settings.editableMemoryEnabled,
        memoryGenerationHash: memory?.generationHash,
        summaryRebase,
        retrievalFeedback: currentRetrievalFeedback ? {
          searches: currentRetrievalFeedback.searches,
          misses: currentRetrievalFeedback.misses,
          repeatedQueries: currentRetrievalFeedback.repeatedQueries,
          readsByResource: currentRetrievalFeedback.readsByResource,
          readsByBlockId: currentRetrievalFeedback.readsByBlockId,
        } : undefined,
      });
      const cachePath = sessionPath ? cachePathForSession(sessionPath) : undefined;

      if (!useIsolatedWorker && settings.cacheEnabled && settings.valueWorker.mode !== "advisory" && cachePath) {
        const cached = await readCompactionCache(cachePath);
        if (
          cached && cached.sourceHash === generationHash &&
          cached.configHash === configHash &&
          cached.renderedTokens + retainedTailTokens <= combinedCeilingTokens
        ) {
          ctx.ui.notify(
            `ChronoCompact reused generation ${cached.generation}: ${cached.rawTokens.toLocaleString()}→${cached.renderedTokens.toLocaleString()} estimated tokens.`,
            "info",
          );
          const cachedShadowLeafId = sourceEntries.at(-1)?.id;
          if (settings.rollupShadowEnabled && sessionPath && typeof cachedShadowLeafId === "string") {
            scheduleRollupShadow({
              sessionPath,
              branchLeafId: cachedShadowLeafId,
              firstKeptEntryId,
              currentReplayText: cached.summary,
              hardTokenBound: Math.min(HARD_REPLAY_CAP_TOKENS, historicalCeilingTokens),
              targetTokenBound: targetTokens,
              retentionHints,
              settings,
            });
          }
          return {
            compaction: {
              summary: cached.summary,
              firstKeptEntryId,
              tokensBefore,
              details: {
                kind: "chrono-compact-event-stream-context-compaction",
                version: EXTENSION_VERSION,
                cache: { hit: true, generation: cached.generation, sourceHash: generationHash! },
                ...(cached.piSummary === undefined ? {} : { piSummary: cached.piSummary }),
                retainedTail: tailSelection,
                replayTargetMode: settings.replayTargetTokens === undefined ? "derived-active-context" : "fixed",
                targetActiveContextTokens: settings.targetContextTokens,
                layers: {
                  regularPiSummaryTokens: cached.piSummary ? estimateTokensFromText(cached.piSummary) : 0,
                  chronoHistoryTokens: cached.details.renderedTokens,
                  rawTailTokens: retainedTailTokens,
                  combinedContextTokens: cached.renderedTokens + retainedTailTokens,
                  hardCeilingTokens: combinedCeilingTokens,
                },
                hybrid: {
                  enabled: settings.hybridSummaryEnabled,
                  cacheReused: true,
                  combinedTokens: cached.renderedTokens,
                  replayTokens: cached.details.renderedTokens,
                },
                compaction: cached.details,
              },
            },
          };
        }
      }

      let piSummary: Awaited<ReturnType<typeof createPiRegularSummary>>;
      try {
        const piSummaryTargetTokens = Math.min(
          settings.hybridSummaryTargetTokens,
          Math.max(512, targetTokens - 512),
        );
        piSummary = settings.hybridSummaryEnabled ? await createPiRegularSummary(ctx, event.preparation, {
          targetTokens: piSummaryTargetTokens,
          customInstructions: event.customInstructions,
          signal: event.signal,
          ...(summaryRebase.rebase ? {} : { previousSummary: previousPiSummary }),
          messages: regularSummaryMessagesForCut(branchEntries, firstKeptEntryId, summaryRebase.rebase),
        }) : undefined;
          if (piSummary && piSummary.tokens > piSummaryTargetTokens) {
            const text = truncateToTokens(
              piSummary.text,
              piSummaryTargetTokens,
              "\n\n[Regular Pi summary deterministically bounded for the configured combined ceiling.]",
            );
            piSummary = { ...piSummary, text, tokens: estimateTokensFromText(text) };
          }
          if (!piSummary && ctx.hasUI) {
            ctx.ui.notify("Regular Pi hybrid summary was unavailable; deterministic replay will be used alone.", "warning");
          }
      } catch (hybridError) {
        if (!event.signal?.aborted && ctx.hasUI) {
          ctx.ui.notify(`Regular Pi summary failed; deterministic replay will continue in degraded mode: ${safeErrorMessage(hybridError)}`, "warning");
        }
      }

      const hybridWrapperTokens = piSummary
        ? estimateTokensFromText(renderHybridCompaction(piSummary.text, "")) - piSummary.tokens
        : 0;
      const replayCeilingTokens = Math.max(
        128,
        historicalCeilingTokens - (piSummary?.tokens ?? 0) - Math.max(0, hybridWrapperTokens),
      );
      const replayTargetTokens = Math.min(
        replayCeilingTokens,
        piSummary
          ? Math.max(256, targetTokens - piSummary.tokens - Math.max(0, hybridWrapperTokens))
          : targetTokens,
      );
      const replayConfig = resolveCompactorConfig({ ...config, targetTokens: replayTargetTokens });
      let precomputedCandidates: ReadonlyMap<string, import("./candidates.js").CandidatePrecomputeRecord> | undefined;
      let officialIncremental: Record<string, unknown> = { state: "disabled" };
      if (!useIsolatedWorker && settings.incrementalPrecomputeEnabled && sessionPath) {
        try {
          const store = incrementalStore?.sessionPath === sessionPath ? incrementalStore : createCandidateSegmentStore(sessionPath);
          incrementalStore = store; if (!store.manifest) await loadCandidateSegmentManifest(store);
          if (!store.ledger && store.manifest) store.ledger = await loadSourceLedger(sessionPath, store.ledgerPath);
          const branchIds = sourceEntries.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
          const candidates = await loadCandidateRecordsForBranch(store, branchIds);
          if (candidates.size > 0) precomputedCandidates = candidates;
          officialIncremental = { state: candidates.size > 0 ? "validated-hit" : "stale-fallback", cachedCandidates: candidates.size,
            background: incrementalStatus, metrics: store.metrics };
        } catch (error) {
          officialIncremental = { state: "stale-fallback", reason: safeErrorMessage(error), background: incrementalStatus };
        }
      }
      const validAdviceRecordHashes = precomputedCandidates ? new Map([...precomputedCandidates].map(([blockId, record]) => [blockId, record.integrityHash])) : undefined;
      const valueAdvice = sessionPath ? await loadCompatibleAdvice(sessionPath, settings.valueWorker, validAdviceRecordHashes) : new Map();
      let result: CompressionResult; let workerExecution: WorkerClientResult | undefined;
      if (useIsolatedWorker && sessionPath) {
        const leafId = branchEntries.at(-1)?.id; if (typeof leafId !== "string") throw new Error("Isolated worker failed: branch-not-persisted");
        const request: ReplayWorkerRequest = { schemaVersion: 1, jobId: randomUUID(), jobType: "replay-compaction", sessionPath,
          expectedSource: await workerSourceExpectation(sessionPath), deadlineMs: Date.now() + settings.workerTimeoutSeconds * 1_000,
          niceLevel: settings.workerNiceLevel, branchLeafId: leafId, firstKeptEntryId, config: replayConfig,
          hardOutputTokens: replayCeilingTokens, retentionHints, pinnedMemoryText,
          ...(currentRetrievalFeedback === undefined ? {} : { retrievalFeedback: currentRetrievalFeedback }),
          candidateStoreEnabled: settings.incrementalPrecomputeEnabled, cacheEnabled: settings.cacheEnabled,
          valueWorkerMode: settings.valueWorker.mode, valueWorkerConfigurationHash: valueWorkerConfigurationHash(settings.valueWorker) };
        replayWorkerStatus = { state: "running", jobId: request.jobId, startedAt: new Date().toISOString() };
        workerExecution = await runCompactionWorker(request, { schedulerDirectory: adapters.schedulerDirectory, slots: settings.hostWorkerSlots,
          workerTimeoutMs: settings.workerTimeoutSeconds * 1_000, schedulerTimeoutMs: settings.workerTimeoutSeconds * 1_000,
          signal: event.signal, priority: "high" });
        replayWorkerStatus = { state: workerExecution.response.status, jobId: request.jobId,
          ...(workerExecution.response.status === "failed" ? { failureCode: workerExecution.response.failureCode } : {}),
          totalWallMs: workerExecution.clientMetrics.workerTotalWallMs, responseBytes: workerExecution.clientMetrics.responseBytes };
        if (workerExecution.response.status !== "ok" || !workerExecution.response.replay) {
          const code = workerExecution.response.status === "failed" ? workerExecution.response.failureCode : "worker-protocol-error";
          throw new Error(`Isolated worker failed: ${code}`);
        }
        const replay = workerExecution.response.replay; generationHash = replay.generationHash;
        result = { summary: replay.summary, rawTokens: replay.rawTokens, renderedTokens: replay.renderedTokens,
          targetTokens: replay.targetTokens, validation: replay.validation,
          plan: { targetTokens: replay.targetTokens, estimatedTokens: replay.renderedTokens, rawTokens: replay.rawTokens, units: [], warnings: [] },
          details: replay.details };
        officialIncremental = settings.incrementalPrecomputeEnabled
          ? { state: "worker-snapshot", background: incrementalStatus, cacheState: workerExecution.response.metrics.cacheState }
          : { state: "disabled" };
      } else {
        result = await compactEntries(sourceEntries, {
          config: replayConfig, ...(precomputedCandidates === undefined ? {} : { precomputedCandidates }),
          valueAdvice, valueWorkerMode: settings.valueWorker.mode,
          hardOutputTokens: replayCeilingTokens, signal: event.signal, retentionHints, futureEntries: retainedEntries,
          pinnedMemoryText, retrievalFeedback: currentRetrievalFeedback,
        });
        generationHash ??= result.details.generationHash;
      }
      const combinedSummary = piSummary
        ? renderHybridCompaction(piSummary.text, result.summary)
        : result.summary;
      const combinedTokens = estimateTokensFromText(combinedSummary);
      const combinedContextTokens = combinedTokens + retainedTailTokens;
      if (combinedContextTokens > combinedCeilingTokens) {
        throw new Error(
          `Combined context ${combinedContextTokens} exceeds the hard ${combinedCeilingTokens}-token ceiling.`,
        );
      }

      let generation: number | undefined;
      if (!useIsolatedWorker && settings.cacheEnabled && settings.valueWorker.mode !== "advisory" && cachePath) {
        try {
          generation = await nextCacheGeneration(cachePath);
          await writeCompactionCache(cachePath, {
            schemaVersion: 4,
            generation,
            sourceHash: generationHash!,
            configHash,
            summary: combinedSummary,
            ...(piSummary === undefined ? {} : { piSummary: piSummary.text }),
            rawTokens: result.rawTokens,
            renderedTokens: combinedTokens,
            targetTokens,
            details: result.details,
            createdAt: new Date().toISOString(),
          });
        } catch (cacheError) {
          ctx.ui.notify(`ChronoCompact cache write failed: ${safeErrorMessage(cacheError)}`, "warning");
        }
      }

      ctx.ui.notify(
        `ChronoCompact ${EXTENSION_VERSION} candidate: ${result.rawTokens.toLocaleString()}→${combinedTokens.toLocaleString()} historical tokens; ${combinedContextTokens.toLocaleString()}/${combinedCeilingTokens.toLocaleString()} combined; background value worker ${settings.valueWorker.mode}; compaction model jobs 0.`,
        "info",
      );
      const shadowBranchLeafId = sourceEntries.at(-1)?.id;
      const authoritativeResponse = {
        compaction: {
          summary: combinedSummary,
          firstKeptEntryId,
          tokensBefore,
          ...(piSummary?.usage === undefined ? {} : { usage: piSummary.usage }),
          details: {
            kind: "chrono-compact-event-stream-context-compaction",
            version: EXTENSION_VERSION,
            cache: { hit: useIsolatedWorker ? workerExecution?.response.metrics.cacheState === "hit" : false, generation, sourceHash: generationHash! },
            retainedTail: tailSelection,
            retainedTailTokens,
            replayTargetMode: settings.replayTargetTokens === undefined ? "derived-active-context" : "fixed",
            targetActiveContextTokens: settings.targetContextTokens,
            layers: {
              regularPiSummaryTokens: piSummary?.tokens ?? 0,
              chronoHistoryTokens: result.renderedTokens,
              rawTailTokens: retainedTailTokens,
              combinedContextTokens,
              hardCeilingTokens: combinedCeilingTokens,
            },
            historyEditor: result.details.historyEditor,
            summaryRebase,
            editableMemory: { owner: memoryOwner, enabled: memoryOwner === "chrono" && settings.editableMemoryEnabled, status: memory?.status ?? "unavailable", generationHash: memory?.generationHash, pinnedTokens: estimateTokensFromText(pinnedMemoryText) },
            incrementalPrecompute: officialIncremental,
            isolatedWorker: workerExecution === undefined ? { enabled: settings.isolatedWorkerEnabled, used: false }
              : { enabled: true, used: true, client: workerExecution.clientMetrics, runtime: workerExecution.response.metrics },
            toolResultProjection: lastProjectionMetrics ?? { mode: settings.toolResultProjectionMode, state: "no request metrics" },
            ...(piSummary === undefined ? {} : { piSummary: piSummary.text }),
            hybrid: piSummary
              ? {
                  enabled: true,
                  cacheReused: false,
                  model: piSummary.model,
                  summaryTokens: piSummary.tokens,
                  replayTokens: result.renderedTokens,
                  combinedTokens,
                  source: "raw messages ending at the final ChronoCompact cut; never the prior replay",
                  order: "regular Pi summary first, ChronoCompact event replay second",
                }
              : { enabled: false, requested: settings.hybridSummaryEnabled },
            compaction: result.details,
          },
        },
      };
      return returnAuthoritativeAfterShadowSchedule(authoritativeResponse, () => {
        if (settings.rollupShadowEnabled && sessionPath && typeof shadowBranchLeafId === "string") {
          scheduleRollupShadow({
            sessionPath,
            branchLeafId: shadowBranchLeafId,
            firstKeptEntryId,
            currentReplayText: result.summary,
            hardTokenBound: Math.min(HARD_REPLAY_CAP_TOKENS, replayCeilingTokens),
            targetTokenBound: replayTargetTokens,
            retentionHints,
            settings,
          });
        }
      });
    } catch (error) {
      if (event.signal?.aborted || compositionEpoch !== rolloutEpoch || captureEpoch !== summaryEpoch) return { cancel: true };
      if (settings.contextCompiler === "v4" || settings.memoryEngineEnabled || canary.requested(ctx.sessionManager.getSessionId())) {
        const failure = recordFailure(error);
        if (settings.contextCompiler === "v4") {
          compilerTerminal = { state: "failed", code: failure.code };
          pendingCompiler = undefined;
          clearSessionSummary();
          compactionRetryPaused = true;
          if (!ctx.isIdle()) ctx.abort();
        }
        if (ctx.hasUI) ctx.ui.notify(`Guarded composition failed (${failure.stage}: ${failure.code}); current context is unchanged.`, "warning");
        return canary.refuse("operation-failed");
      }
      const noSavings =
        error instanceof CompactionValidationError && error.report.issues.some((issue) => issue.code === "no-net-savings");
      if (noSavings && event.reason === "manual") {
        ctx.ui.notify("ChronoCompact stopped because it would not reduce the selected historical prefix.", "info");
        return { cancel: true };
      }
      if (!event.signal?.aborted) {
        ctx.ui.notify(`ChronoCompact rejected the replay; using Pi's default compactor: ${safeErrorMessage(error)}`, "warning");
      }
      return undefined;
    }
  });

  // Preview leaves history providers, status and user commands to its loader.
  if (preview) return;

  pi.registerTool({
    name: "history_status", label: "History status",
    description: "Read bounded indexed-history readiness, requested/indexed cuts, lag and safe error. No ingestion or archive reads.",
    parameters: Type.Object({}),
    async execute() { const status = searchStatus(); return toolText(JSON.stringify(status), status); },
  });
  const runLogicalSessionCommand = async (args: string, ctx: ExtensionCommandContext, automatic = false): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];
      const sourcePath = ctx.sessionManager.getSessionFile();
      try {
        if (action === "adopt") {
          const branchId = parts[1] ?? "main";
          if (!sourcePath || parts.length > 2) throw new Error("Usage: /Chrono logical-session adopt [branch-id]");
          const existing = await resolveStartedLogicalSession(ctx);
          if (existing && existing.branchId !== branchId) throw new Error("logical-session-adoption-conflict");
          logicalGrant = existing ?? await adoptStartedSession(ctx, branchId);
          ctx.ui.notify(`Logical session adopted: ${logicalGrant.logicalSessionId} on branch ${branchId}. No rollover occurred.`, "info");
          return;
        }
        if (!sourcePath || !validLogicalCommandId(parts[1])) throw new Error("Usage: /Chrono logical-session status|rollover|fork|recover|rollback <logical-session-id> [branch-id]");
        const store = new LogicalSessionStore(logicalSessionRoot, parts[1]!);
        const rollover = new ManualLogicalRollover(store);
        const manifest = await store.read();
        if (!manifest) throw new Error("logical-session-manifest-missing");
        if (action === "status") {
          const branch = manifest.branches.find(value => value.activeShardId && manifest.shards.some(shard => shard.shardId === value.activeShardId && shard.piSessionId === ctx.sessionManager.getSessionId() && shard.sourcePath === sourcePath));
          if (!branch) throw new Error("logical-session-branch-scope-mismatch");
          const entries = ctx.sessionManager.getBranch();
          const measurements = { sourceBytes: (await stat(sourcePath)).size, records: entries.length,
            compactions: entries.reduce((count, entry) => count + (entry.type === "compaction" ? 1 : 0), 0) };
          ctx.ui.notify(JSON.stringify({ ...logicalSessionStatus(manifest, branch.branchId, measurements), measurements }), "info");
          return;
        }
        if (action === "recover") {
          const pending = manifest.pendingRollover;
          if (!pending) throw new Error("logical-session-recovery-unavailable");
          const old = manifest.shards.find(value => value.shardId === pending.oldShardId);
          if (pending.phase === "close-prepared" && old?.piSessionId === ctx.sessionManager.getSessionId() && old.sourcePath === sourcePath) {
            await rollover.abortPrepared(pending.operationId);
            ctx.ui.notify("Prepared rollover was reopened. No shard was deleted.", "info");
            return;
          }
          const recoveryEntries = asEntries(ctx.sessionManager.getBranch());
          if (pending.phase === "close-prepared" && replacementContainsOnlyBootstrap(recoveryEntries)) {
            logicalSwitchActive = true;
            try { await rollover.reopenPreparedFromEmptyReplacement(commandSessionPort(ctx), true); }
            finally { logicalSwitchActive = false; }
            return;
          }
          const binding = recordedLogicalBinding(recoveryEntries);
          if (!binding || binding.operationId !== pending.operationId || binding.logicalSessionId !== manifest.logicalSessionId
            || binding.branchId !== pending.branchId || binding.fromShardId !== pending.oldShardId || binding.shardId !== pending.newShardId) {
            throw new Error("logical-session-recovery-binding-missing");
          }
          if (pending.phase === "close-prepared") await rollover.bindRecordedNewShard(pending.operationId, ctx.sessionManager as unknown as SessionSetupPort, binding.continuationHash);
          await rollover.activateNewShard(pending.operationId, ctx.sessionManager as unknown as SessionSetupPort);
          return;
        }
        if (action === "rollback") {
          const binding = recordedLogicalBinding(asEntries(ctx.sessionManager.getBranch()));
          if (!binding || binding.logicalSessionId !== manifest.logicalSessionId) throw new Error("logical-session-rollback-ineligible");
          logicalSwitchActive = true;
          try { await rollover.rollbackLast(commandSessionPort(ctx), replacementContainsOnlyContinuation(asEntries(ctx.sessionManager.getBranch()), binding)); }
          finally { logicalSwitchActive = false; }
          return;
        }
        if (!["rollover", "fork"].includes(action ?? "") || !parts[2]
          || parts.length !== (action === "fork" ? 4 : 3)) {
          throw new Error("Usage: /Chrono logical-session rollover <logical-session-id> <branch-id>; fork <logical-session-id> <source-branch-id> <new-branch-id>");
        }
        const branchEntries = automatic ? boundedBranchEntries(ctx) : asEntries(ctx.sessionManager.getBranch());
        const leafId = ctx.sessionManager.getLeafId?.();
        if (!leafId || !ctx.isIdle()) throw new Error("logical-session-rollover-ineligible");
        const before = await historySourceState(sourcePath);
        const pinned = await search.compositionTarget(leafId);
        let selection: Awaited<ReturnType<HistorySearchAdapter["compositionSelection"]>> | undefined;
        try { selection = await search.compositionSelection(leafId); }
        catch (error) { if (!isOptionalCompositionUnavailable(error)) throw error; }
        const regularPiSummary = previousRegularPiSummary(branchEntries, undefined) ?? "";
        if (selection && (pinned.view.eventCut !== selection.requestedCut || pinned.view.eventCut !== selection.sourceView.eventCut
          || pinned.view.storeKey !== selection.sourceView.storeKey || pinned.view.generation !== selection.sourceView.generation)) {
          throw new Error("logical-session-continuation-evidence-invalid");
        }
        const unmatched = unmatchedToolCallCount(branchEntries);
        const combinedCeilingTokens = effectiveContextCeiling(ctx, resolveExtensionSettings(userConfig));
        const candidate = selection && selection.stateGeneration > 0
          ? buildManualContinuationCandidate({ manifest, branchId: parts[2], sourceLeafEntryId: leafId,
            regularPiSummary, selection, recover: encodeCompositionRecovery, combinedCeilingTokens, toolPairSafe: unmatched === 0 })
          : buildBoundedContinuationCandidate({ manifest, branchId: parts[2], sourceLeafEntryId: leafId,
            sourceView: pinned.view, entries: branchEntries.slice(-256), combinedCeilingTokens,
            previousSummary: branchEntries.slice(-256).reverse().find(entry => entry.type === "compaction")?.summary as string | undefined });
        const after = await historySourceState(sourcePath);
        if (stableStringify(before) !== stableStringify(after) || ctx.sessionManager.getSessionFile() !== sourcePath
          || ctx.sessionManager.getLeafId?.() !== leafId) throw new Error("source-changed");
        if (automatic && automaticRolloverBlockers(ctx).length) throw new Error("logical-session-rollover-ineligible");
        const idle = ctx.isIdle();
        const eligibility = { persisted: true, idle, streaming: !idle,
          activeToolCalls: idle ? 0 : unmatched, unmatchedToolPairs: unmatched, pendingMessages: hasUnresolvedTurn(branchEntries),
          compactionActive: triggerPending || valueWorkerCompactionGate, sessionSwitchActive: logicalSwitchActive,
          // Both reads above require the lifecycle to be caught up to this exact leaf. A partial JSONL tail cannot produce that pin.
          catalogCaughtUp: true, incompleteSourceTail: false, sourceLeafEntryId: leafId, trigger: automatic ? "threshold" as const : "manual" as const };
        const checkpoints = await captureLogicalStateCheckpointsAsync(pi, ctx, { includeMemory: memoryOwner === "context-kit" });
        const port = commandSessionPort(ctx, checkpoints);
        logicalSwitchActive = true;
        try {
          const result = action === "fork"
            ? await rollover.fork({ sourceBranchId: parts[2], targetBranchId: parts[3]! }, candidate, eligibility, port)
            : await rollover.rollover(candidate, eligibility, port);
          if (result.cancelled) {
            // A later before-switch guard or user cancellation can run after
            // this instance released its old target. Restore that exact source.
            logicalGrant = await resolveStartedLogicalSession(ctx);
            beginStartup(ctx);
            scheduleSearch(ctx);
            if (automatic) automaticRolloverStatus = { state: "cancelled" };
          }
        } finally { logicalSwitchActive = false; }
      } catch (error) {
        if (automatic) automaticRolloverStatus = { state: "refused", code: logicalErrorCode(error) };
        try { ctx.ui.notify(`Logical session command refused: ${logicalErrorCode(error)}`, "warning"); }
        catch { throw error; } // Do not hide an original replacement failure behind a stale UI context.
      }
  };
  const chronoActions = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const registerChronoAction = (name: string, action: Parameters<ExtensionAPI["registerCommand"]>[1]) => { chronoActions.set(name, action); };
  registerChronoAction("logical-session", {
    description: "Adopt, inspect, roll over, fork, recover, or roll back one owner-only logical session",
    handler: (args, ctx) => runLogicalSessionCommand(args, ctx),
  });
  registerChronoAction("archive", {
    description: "Read one source-bound derived interval archive: <commit-id> [item-offset]. No model call or Memory change.",
    handler: async (args, ctx) => {
      const binding = originalRunBinding(ctx), leafId = ctx.sessionManager.getLeafId();
      try {
        const parts = args.trim().split(/\s+/), commitId = parts[0], offsetText = parts[1] ?? "0";
        if (parts.length > 2 || !commitId || !/^[A-Za-z0-9_-]{1,128}$/.test(commitId)
          || !/^(0|[1-9][0-9]{0,6})$/.test(offsetText)) throw new Error("Usage: /Chrono archive <commit-id> [item-offset]");
        if (!ctx.isIdle() || sessionSummary || pendingRecovery || recoveryIntent || triggerPending) {
          throw new Error("context-v4-archive-read-session-busy");
        }
        // Only an exact commit on the loaded selected ancestry is eligible.
        // Bound metadata lookup. Do not scan stores, siblings, or archive files.
        let id = leafId;
        const seen = new Set<string>();
        while (id !== commitId) {
          if (!id || seen.has(id) || seen.size >= 8192) throw new Error("context-v4-archive-commit-outside-bounded-ancestry");
          seen.add(id);
          const entry = ctx.sessionManager.getEntry(id);
          if (!entry || entry.id !== id) throw new Error("context-v4-archive-commit-unavailable");
          id = entry.parentId;
        }
        const entry = ctx.sessionManager.getEntry(commitId) as SessionEntryLike | undefined;
        const receipt = entry ? committedIntervalRestartReceipt(entry, ctx.sessionManager.getSessionId()) : undefined;
        const restart = receipt?.restart;
        if (!entry || entry.type !== "compaction" || !receipt || !restart
          || !contextReceiptLocator(entry, ctx.sessionManager.getSessionId()) || typeof entry.summary !== "string"
          || createHash("sha256").update(entry.summary).digest("hex") !== receipt.summaryHash
          || receipt.sourceCutEntryId !== restart.source.endEntryId
          || (receipt.nativeRetention?.kind === "none" ? entry.firstKeptEntryId !== entry.id
            : entry.firstKeptEntryId !== receipt.firstKeptEntryId)) throw new Error("context-v4-archive-commit-unverified");
        const revalidate = () => {
          if (binding !== originalRunBinding(ctx) || leafId !== ctx.sessionManager.getLeafId()
            || ctx.sessionManager.getEntry(commitId) !== entry || !ctx.isIdle()) throw new Error("context-v4-archive-read-source-changed");
        };
        let snapshot: IntervalSourceSnapshot;
        if (restart.source.source.logicalSessionId) {
          if (!restart.logicalSource) throw new Error("context-v4-interval-logical-source-manifest-unavailable");
          await refreshIntervalSource(ctx, { ...restart.source, identity: restart.snapshotId }, restart.logicalSource, undefined, true);
          if (!intervalSourceSnapshot) throw new Error("context-v4-interval-logical-source-pin-unavailable");
          snapshot = intervalSourceSnapshot;
        } else {
          snapshot = captureIntervalSource({ ...restart.source.source,
            branchEntries: ctx.sessionManager.getBranch() as unknown as readonly SessionEntryLike[], endEntryId: restart.source.endEntryId,
            controlIdentities: restart.source.controlIdentities, bounds: restart.source.bounds });
        }
        revalidate();
        if (snapshot.identity !== restart.snapshotId || snapshot.sourceHash !== restart.source.sourceHash
          || snapshot.projectionHash !== restart.source.projectionHash || stableStringify(snapshot.origin) !== stableStringify(restart.source.origin)
          || stableStringify(snapshot.segments) !== stableStringify(restart.source.segments)) throw new Error("context-v4-archive-read-source-changed");
        const archive = await intervalHelpers.recoverArchive({ snapshot, commitId });
        revalidate();
        if (!archive) {
          ctx.ui.notify("No source-compatible archive is available. This read did not select or call a model.", "info");
          return;
        }
        const offset = Number(offsetText), artifact = archive.artifact;
        if (offset > artifact.items.length) throw new Error("context-v4-archive-read-offset-invalid");
        const header = { kind: archive.kind, commitId, integrityHash: archive.integrityHash, source: archive.source,
          authority: "derived", acceptedMemory: false, quality: artifact.quality, coverage: artifact.coverage,
          derivation: artifact.derivation, notices: artifact.notices.slice(0, 32), totalNotices: artifact.notices.length,
          itemOffset: offset, totalItems: artifact.items.length };
        const items: typeof artifact.items[number][] = [];
        const renderPage = (pageItems: readonly typeof artifact.items[number][], next: number): string => JSON.stringify({ ...header,
          items: pageItems, nextItemOffset: next < artifact.items.length ? next : null,
          ...(next < artifact.items.length ? { continuation: `/Chrono archive ${commitId} ${next}` } : {}) });
        let next = offset;
        for (; next < artifact.items.length && items.length < 16; next++) {
          const candidate = artifact.items[next]!;
          if (Buffer.byteLength(renderPage([...items, candidate], next + 1)) > 30 * 1024) break;
          items.push(candidate);
        }
        const text = renderPage(items, next);
        if (Buffer.byteLength(text) > 30 * 1024 || next === offset && next < artifact.items.length) {
          throw new Error("context-v4-archive-read-item-bound-exceeded");
        }
        ctx.ui.notify(text, "info");
      } catch (error) {
        if (binding === originalRunBinding(ctx)) ctx.ui.notify(`Archive read refused (${safeErrorMessage(error)}). Source history and Memory are unchanged. No model was called.`, "warning");
      }
    },
  });
  registerChronoAction("_auto-rollover", {
    description: "Internal one-shot safe-idle logical rollover dispatch",
    handler: async (args, ctx) => {
      const ticket = automaticRolloverTicket;
      automaticRolloverTicket = undefined;
      const settings = resolveExtensionSettings(userConfig);
      if (!ticket || args !== ticket.nonce || ticket.epoch !== rolloutEpoch
        || ticket.sessionId !== ctx.sessionManager.getSessionId() || ticket.sourcePath !== ctx.sessionManager.getSessionFile()
        || ticket.leafId !== ctx.sessionManager.getLeafId() || !logicalGrant
        || !settings.memoryEngineEnabled || !settings.automaticRolloverEnabled) return;
      const blockers = automaticRolloverBlockers(ctx);
      if (blockers.length) { automaticRolloverStatus = { state: "deferred", blockers }; return; }
      await runLogicalSessionCommand(`rollover ${logicalGrant.logicalSessionId} ${logicalGrant.branchId}`, ctx, true);
    },
  });

  registerChronoAction("rollup-repair", {
    description: "Run one bounded rollup repair transition: start, step, status, or publish.",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/u), action = parts[0], repairId = parts[1], expected = parts[2];
      if (!action || !["start", "step", "status", "publish"].includes(action) || !repairId
        || !/^[A-Za-z0-9_.:-]{1,64}$/u.test(repairId) || (action === "publish"
          ? parts.length !== 3 || !expected || expected !== "legacy" && !/^[a-f0-9]{64}$/u.test(expected)
          : parts.length !== 2)) {
        ctx.ui.notify("Usage: /Chrono rollup-repair start|step|status <repairId> OR publish <repairId> <legacy|expected-store-id>", "info"); return;
      }
      const leaf = ctx.sessionManager.getLeafId();
      if (!leaf) { ctx.ui.notify("Rollup repair requires a persisted branch leaf.", "warning"); return; }
      try {
        const value = await search.repairRollup(leaf, action as "start" | "step" | "status" | "publish", repairId,
          action === "publish" ? expected === "legacy" ? null : expected! : undefined, ctx.signal);
        ctx.ui.notify(`Rollup repair ${action}: ${JSON.stringify(value)}`, "info");
      } catch (error) { ctx.ui.notify(`Rollup repair refused: ${logicalErrorCode(error)}`, "warning"); }
    },
  });

  registerChronoAction("composition-preview", {
    description: "Save a bounded private shadow comparison for a recorded compaction ID, or the nearest compaction. Does not activate compaction.",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested && !/^[a-f0-9]{8}$/.test(requested)) {
        ctx.ui.notify("Usage: /Chrono composition-preview [compaction-entry-id]", "info"); return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const epoch = rolloutEpoch;
      const branchLeaf = ctx.sessionManager.getLeafId();
      let id = branchLeaf;
      let selected = requested ? ctx.sessionManager.getEntry(requested) as SessionEntryLike | undefined : undefined;
      // Only nearest-compaction discovery walks parents. An explicit target is
      // authorized below through catalog membership and verified selected bytes.
      for (let visited = 0; !requested && id && visited < 256; visited++) {
        const entry = ctx.sessionManager.getEntry(id);
        if (!entry) break;
        if (entry.type === "compaction" && (!requested || entry.id === requested)) {
          selected = entry as unknown as SessionEntryLike; break;
        }
        id = entry.parentId;
      }
      if (!selected && !requested) { ctx.ui.notify("No matching compaction within the bounded current-branch lookup.", "warning"); return; }
      try {
        const targetId = requested || selected?.id;
        if (!targetId) throw new Error("composition-target-id-missing");
        selected = await search.compositionEntry(targetId, selected, ctx.signal);
        if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== branchLeaf) return;
        const preview = await previewStoredCompaction(selected, {
          getEntry: entryId => ctx.sessionManager.getEntry(entryId) as SessionEntryLike | undefined,
          select: entryId => search.compositionSelection(entryId, ctx.signal),
          pin: async entryId => (await search.compositionTarget(entryId, ctx.signal)).view,
          recovery: encodeCompositionRecovery,
        }, join(dirname(userConfigPath), "chrono-compositions", createHash("sha256").update(sessionId).digest("hex")), effectiveContextCeiling(ctx, resolveExtensionSettings(userConfig)));
        if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== branchLeaf) return;
        // UI-only receipt: neither comparison prose nor a replacement context is appended.
        ctx.ui.notify(JSON.stringify({ artifactRef: preview.artifactRef, ...preview.envelope }), "info");
      } catch (error) {
        ctx.ui.notify(`Shadow preview unavailable: ${safeErrorMessage(error)}`, "warning");
      }
    },
  });
  registerChronoAction("search-status", {
    description: "Read cached search readiness without ingestion or archive scans",
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(searchStatus()), "info"); },
  });
  registerChronoAction("search", {
    description: "Persistently enable or disable indexed history for only this session: on|off. Normal startup needs no command.",
    handler: async (args, ctx) => {
      if (args !== "on" && args !== "off") { ctx.ui.notify("Usage: /Chrono search on|off. This changes only this session's persistent rollout.", "info"); return; }
      const sourcePath = ctx.sessionManager.getSessionFile();
      if (!sourcePath) { ctx.ui.notify("Search rollout requires a saved session.", "warning"); return; }
      const epoch = rolloutEpoch, sessionId = ctx.sessionManager.getSessionId();
      try { await writeSessionRollout(sessionRolloutDirectory, { sessionId, sourcePath }, args === "on"); }
      catch { ctx.ui.notify("Search rollout was not changed: unsafe sidecar state.", "warning"); return; }
      if (epoch !== rolloutEpoch || ctx.sessionManager.getSessionId() !== sessionId) return;
      rolloutError = undefined;
      sessionSearchOverride = args === "on";
      scheduleCatalogShadow(ctx);
      scheduleSearch(ctx);
      ctx.ui.notify(JSON.stringify(searchStatus()), "info");
    },
  });

  registerChronoAction("worker-status", {
    description: "Show bounded isolated-worker and scheduler status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const settings = resolveExtensionSettings(userConfig);
      const artifacts = await schedulerArtifactCounts(adapters.schedulerDirectory ?? defaultSchedulerDirectory());
      const host = await runtimeHostStatus({ schedulerDirectory: adapters.schedulerDirectory });
      const memory = historySearchIndexCacheStatus();
      ctx.ui.notify([
        `Isolated replay worker: ${settings.isolatedWorkerEnabled ? "enabled" : "disabled"}`,
        `Last replay state: ${String(replayWorkerStatus.state ?? "idle")}`,
        `Last safe failure code: ${String(replayWorkerStatus.failureCode ?? "none")}`,
        `Host slots: ${settings.hostWorkerSlots}; admitted policy ${host.configuredSlots ?? "not initialized"}`,
        `Kernel containment: ${host.containmentAvailable ? "available" : "unavailable; unsafe jobs refused"}`,
        `Legacy admission inhibitor: ${host.legacyAdmissionBlocked ? "verified" : "not verified; transition required"}`,
        `Host jobs: ${host.active} active, ${host.queued} queued; malformed artifacts ${host.malformedArtifacts}`,
        runtimeAdmissionStatusText(host),
        `Host memory limit: ${host.limits.hostMemoryBytes} bytes; source-read ceiling ${host.limits.sourceBytes} bytes`,
        `Host progress: ${host.jobs.map((job) => `${job.category}:${job.stage}`).join(", ") || "idle"}`,
        `Scheduler artifacts: ${artifacts.slots} slot(s), ${artifacts.tickets} ticket(s)`,
        `Worker timeout: ${settings.workerTimeoutSeconds}s`,
        `History memory admission: ${memory.admission.totalBytes}/${memory.admission.byteLimit} bytes; ${memory.admission.reservations} reservation(s)`,
        `History memory components: load ${memory.admission.components.pendingLoad}, build ${memory.admission.components.pendingBuild}, index ${memory.admission.components.liveIndex}, query ${memory.admission.components.queryResults}, references ${memory.admission.components.retainedReferences}`,
      ].join("\n"), "info");
    },
  });

  registerChronoAction("doctor", {
    description: "Run read-only bounded ChronoCompact safety checks",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const settings = resolveExtensionSettings(userConfig);
      const sessionPath = ctx.sessionManager.getSessionFile();
      const source = sessionPath ? await historySourceState(sessionPath).then((value) => ({ state: "ready", bytes: value.size, legacyHistory: value.size <= LEGACY_HISTORY_MAX_BYTES ? "allowed" : "refused" })).catch(() => ({ state: "unavailable", bytes: 0, legacyHistory: "refused" })) : { state: "ephemeral", bytes: 0, legacyHistory: "refused; unpersisted source" };
      const ledger = await availableHistoryLedger(ctx);
      const artifacts = await schedulerArtifactCounts(adapters.schedulerDirectory ?? defaultSchedulerDirectory());
      const host = await runtimeHostStatus({ schedulerDirectory: adapters.schedulerDirectory });
      const diagnosticBytes = sessionPath ? await stat(replayWorkerDiagnosticPath(sessionPath)).then((value) => value.size).catch(() => 0) : 0;
      const memory = historySearchIndexCacheStatus();
      ctx.ui.notify([
        `Session source: ${source.state}; bytes ${source.bytes}`,
        `Legacy whole-file history: ${source.legacyHistory}; limit ${LEGACY_HISTORY_MAX_BYTES}`,
        `Verified source ledger: ${ledger ? "ready" : "unavailable"}`,
        `Replay worker diagnostics: ${diagnosticBytes > 0 ? "owner-only records present" : "none"}`,
        `Scheduler artifacts: ${artifacts.slots} slot(s), ${artifacts.tickets} ticket(s)`,
        `Isolated worker configured: ${settings.isolatedWorkerEnabled ? "yes" : "no"}`,
        `Kernel containment: ${host.containmentAvailable ? "available" : "unavailable; unsafe jobs refused"}`,
        `Legacy admission inhibitor: ${host.legacyAdmissionBlocked ? "verified" : "not verified; transition required"}`,
        `Host jobs: ${host.active} active, ${host.queued} queued; memory ceiling ${host.limits.hostMemoryBytes} bytes`,
        runtimeAdmissionStatusText(host),
        "History indexes: child-only; no full index retained by Pi.",
        `History memory admission: ${memory.admission.totalBytes}/${memory.admission.byteLimit} bytes`,
        `History retained accounting: index ${memory.admission.components.liveIndex}, query ${memory.admission.components.queryResults}, references ${memory.admission.components.retainedReferences}`,
        "Doctor mode: read-only; no session content or private path emitted.",
      ].join("\n"), source.state === "unavailable" ? "warning" : "info");
    },
  });

  registerChronoAction("capsules-status", {
    description: "Show cached synthetic M05 capsule/chunk progress; no storage reads",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(capsuleStatusText(), "info");
    },
  });

  registerChronoAction("catalog-status", {
    description: "Show local M04 catalog shadow state; no database or archive scan",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const enabled = resolveExtensionSettings(userConfig).catalogShadowEnabled;
      const status = catalogShadow.status();
      ctx.ui.notify(`Source catalog shadow: ${enabled ? status.state : "disabled"}. Ingestion only; model context and history tools unchanged.${status.errorCode ? ` Safe refusal: ${status.errorCode}.` : ""}`, "info");
    },
  });

  registerChronoAction("rollup-shadow-status", {
    description: "Show aggregate hierarchical rollup shadow metrics",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const settings = resolveExtensionSettings(userConfig);
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath) {
        ctx.ui.notify("Hierarchical rollup shadow evaluation has no active persisted session.", "info");
        return;
      }
      const status = await getRollupShadowStatus(sessionPath);
      ctx.ui.notify([
        `Hierarchical rollup shadow evaluation: ${settings.rollupShadowEnabled ? "enabled" : "disabled"}`,
        `Pending state: ${String(shadowStatus.state ?? "none")}`,
        `Last safe status: ${status.lastSafeStatus}`,
        `Recorded generations: ${status.records}`,
        `Failure stages: ${JSON.stringify(status.failureStageCounts)}`,
        `Failure codes: ${JSON.stringify(status.failureCodeCounts)}`,
        `Current replay tokens: p50 ${status.currentReplayTokens.p50}, maximum ${status.currentReplayTokens.maximum}`,
        `Rollup tokens: p50 ${status.rollupTokens.p50}, maximum ${status.rollupTokens.maximum}`,
        `Restriction cue coverage: current ${status.currentRestrictionCueCoverage}, rollup ${status.rollupRestrictionCueCoverage}`,
        `Blocker coverage: current ${status.currentBlockerCoverage}, rollup ${status.rollupBlockerCoverage}`,
        `Unresolved-failure coverage: current ${status.currentUnresolvedFailureCoverage}, rollup ${status.rollupUnresolvedFailureCoverage}`,
        `Resource coverage: current ${status.currentResourceCoverage}, rollup ${status.rollupResourceCoverage}`,
        `Invalid references: ${status.invalidReferenceCount}; cut lines: ${status.cutLineCount}; false completions: ${status.falseCompletionCount}; unsupported facts: ${status.unsupportedFactCount}`,
        `Update time ms: p50 ${status.updateTimeMs.p50}, maximum ${status.updateTimeMs.maximum}`,
        `Render time ms: p50 ${status.renderTimeMs.p50}, maximum ${status.renderTimeMs.maximum}`,
        `Worker timer delay ms: p50 ${status.workerTimerDelayMs.p50}, maximum ${status.workerTimerDelayMs.maximum}`,
      ].join("\n"), "info");
    },
  });

  registerChronoAction("history-helper-status", {
    description: "Show V4 history roles, finite helper work, and reservation counters without model calls",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const status = intervalHelpers.status();
      const roles = ["activePrefix", "event", "archive"] as const;
      ctx.ui.notify([
        `Compiler: ${searchSettings().contextCompiler}. History helpers belong to the V4 interval policy.`,
        `Current-agent writer: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable"}; separate from history helpers.`,
        ...roles.map(role => {
          const route = userConfig.historyHelpers?.[role];
          return `${role}: ${route ? `${route.provider}/${route.model}; ${status.roles[role]}` : "unselected"}`;
        }),
        "Unselected, unavailable, or unready A uses labeled deterministic history. Optional B work never blocks compaction. C stays exact.",
        "Counters cover this process only. Reserved tokens are admission ceilings, not measured usage or billed cost.",
        JSON.stringify({ policy: status.policyIdentity, prefix: status.prefix, restart: status.restart,
          archiveLane: status.archiveLane, archive: status.archive, archivePersistence: status.archivePersistence }, null, 2),
        "No provider call or store reset occurs here. Select or clear roles in Settings. Legacy value-worker controls do not govern V4.",
      ].join("\n"), "info");
    },
  });

  registerChronoAction("value-worker-status", {
    description: "Show legacy V3 value-worker status; not the V4 history helpers",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const settings = resolveExtensionSettings(userConfig);
      if (settings.contextCompiler === "v4") {
        ctx.ui.notify("The legacy value worker does not govern V4. Use /Chrono history-helper-status for current history roles and finite helper work.", "info");
        return;
      }
      const sessionPath = ctx.sessionManager.getSessionFile();
      const manifest = sessionPath ? await readValueAdviceManifest(valueAdviceStorePath(sessionPath)) : undefined;
      const adviceStoreState = manifest ? "ready" : sessionPath ? await stat(join(valueAdviceStorePath(sessionPath), "manifest.json")).then(() => "corrupt" as const).catch(() => "none" as const) : "none";
      const candidateManifest = incrementalStore && incrementalStore.sessionPath === sessionPath ? incrementalStore.manifest : undefined;
      const pendingSegments = candidateManifest ? candidateManifest.segments.filter((segment) => !manifest?.processedSegmentIdentities.includes(segment.segmentContentHash)).length : 0;
      const budgetState = manifest && (manifest.usage.calls >= settings.valueWorker.maxCallsPerSession || manifest.usage.inputTokens >= settings.valueWorker.maxInputTokensPerSession || manifest.usage.outputTokens >= settings.valueWorker.maxOutputTokensPerSession || (settings.valueWorker.maxEstimatedCostMicroUsd !== undefined && manifest.usage.costMicroUsd >= settings.valueWorker.maxEstimatedCostMicroUsd)) ? "exhausted" : "available";
      ctx.ui.notify([
        `Mode: ${settings.valueWorker.mode}`, `Configured model: ${settings.valueWorker.model}`, `Resolved model: ${manifest?.resolvedModelIdentity ?? "none"}`, `Thinking: ${settings.valueWorker.thinking}`,
        `Candidate store: ${String(incrementalStatus.state ?? "unknown")}`, `Advice store: ${adviceStoreState}`, `Pending segments: ${pendingSegments}`, `Pending batches: ${pendingSegments === 0 ? 0 : "bounded at run time"}`, `Active job: ${valueWorkerActive ? "running" : "idle"}`, `Model slot limit: ${settings.valueWorker.hostSlots}`, `Budget state: ${budgetState}`, `Last safe status: ${String((valueWorkerStatus as {status:string}).status)}`,
        `Completed segments: ${manifest?.processedSegmentIdentities.length ?? 0}`, `Valid advice records: ${manifest?.adviceFiles.filter((item) => item.configurationHash === valueWorkerConfigurationHash(settings.valueWorker)).reduce((n,x)=>n+x.records,0) ?? 0}`, `Ignored advice records: ${manifest?.adviceFiles.filter((item) => item.configurationHash !== valueWorkerConfigurationHash(settings.valueWorker)).reduce((n,x)=>n+x.records,0) ?? 0}`, `Calls: ${manifest?.usage.calls ?? 0}`, `Repair calls: ${manifest?.usage.repairCalls ?? 0}`,
        `Input tokens: ${manifest?.usage.inputTokens ?? 0}`, `Output tokens: ${manifest?.usage.outputTokens ?? 0}`, `Cache-read tokens: ${manifest?.usage.cacheReadTokens ?? 0}`, `Cache-write tokens: ${manifest?.usage.cacheWriteTokens ?? 0}`, `Estimated cost: ${manifest?.usage.costAvailable ? `$${((manifest.usage.costMicroUsd ?? 0) / 1_000_000).toFixed(6)}` : "unavailable"}`, `Provider attempts: ${valueWorkerStatus && "providerAttempts" in valueWorkerStatus ? valueWorkerStatus.providerAttempts ?? 0 : 0}`,
        `Consecutive failures: ${manifest?.consecutiveFailures ?? 0}`, `Circuit: ${manifest?.circuitState ?? "closed"}`, `Circuit reopen time: ${manifest?.circuitReopenTime ?? "none"}`, `Last successful update: ${manifest?.lastSuccessTime ?? "none"}`,
      ].join("\n"), "info");
    },
  });

  registerChronoAction("value-worker-reset", {
    description: "Reset the legacy V3 value-worker circuit; unavailable in V4",
    handler: async (_args, ctx) => {
      if (searchSettings().contextCompiler === "v4") {
        ctx.ui.notify("No V4 helper circuit was reset. Legacy value-worker controls do not govern V4. Select or clear history roles in Settings.", "info");
        return;
      }
      cancelValueWorker();
      const sessionPath = ctx.sessionManager.getSessionFile();
      const reset = sessionPath ? await resetAdviceCircuit(valueAdviceStorePath(sessionPath)).catch(() => false) : false;
      valueWorkerStatus = { status: "off" };
      ctx.ui.notify(`${reset ? "Reset the persisted circuit. " : "No compatible persisted circuit was found. "}Pending legacy value work was cancelled. Stored advice and source files were preserved.`, "info");
    },
  });

  registerChronoAction("settings", {
    description: "Automatic compaction status and explicit history-role provider/model selection",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (userConfigWarning) await showChronoReport(ctx, "Configuration warning", userConfigWarning);
      await openChronoCompactSettings(ctx, userConfig, selected => {
        if (stableStringify(selected) === stableStringify(userConfig)) return;
        saveUserConfig(selected, userConfigPath);
        userConfig = selected;
        intervalHelpers.invalidate();
        helperPreparationKey = undefined;
        if (sessionSummary || summaryInputIntent || pendingRecovery || recoveryIntent) {
          refuseSessionSummary(ctx, new Error("context-v4-history-route-changed"));
        }
        userConfigWarning = undefined;
        lastTriggerAttemptTokens = undefined;
        cancelIncrementalWork(true);
        cancelShadowWork();
        cancelValueWorker();
        scheduleCatalogShadow(ctx);
        scheduleSearch(ctx);
        scheduleIncrementalWork(ctx);
      });
    },
  });

  const invokeChronoAction = async (name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> => {
    const action = chronoActions.get(name);
    if (!action) { await showChronoReport(ctx, "Chrono", "Unknown action. Open /Chrono to select Settings, Status, or Maintenance."); return true; }
    if (ctx.mode !== "tui" || name === "settings" || name === "_auto-rollover") {
      await action.handler(args, ctx);
      return true;
    }
    const reports: string[] = [];
    const epoch = rolloutEpoch;
    // Capture existing UI-only command output instead of adding it to the transcript.
    const reportContext: ExtensionCommandContext = { ...ctx, ui: { ...ctx.ui, notify: message => { reports.push(message); } } };
    try { await action.handler(args, reportContext); }
    catch (error) { reports.push(safeErrorMessage(error)); }
    if (epoch !== rolloutEpoch) return false; // A session replacement owns the next UI.
    if (reports.length) {
      const text = reports.map(report => {
        try { return JSON.stringify(JSON.parse(report), null, 2); } catch { return report; }
      }).join("\n\n");
      await showChronoReport(ctx, `Chrono: ${name}`, text);
    }
    return true;
  };

  const statusMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const v4 = searchSettings().contextCompiler === "v4";
    const entries: readonly (readonly [string, string])[] = [
      ["Overview and search readiness", "search-status"],
      v4 ? ["History helper roles and activity", "history-helper-status"] : ["Legacy value-worker usage", "value-worker-status"],
      ["Local workers", "worker-status"],
      ["Read-only health check", "doctor"],
      ...(!v4 ? [
        ["Source catalog shadow", "catalog-status"],
        ["Capsule shadow", "capsules-status"],
        ["Rollup shadow", "rollup-shadow-status"],
      ] as const : []),
    ];
    while (true) {
      const choice = await ctx.ui.select("Chrono: Status and diagnostics", [...entries.map(([label]) => label), "Back"]);
      const entry = entries.find(([label]) => label === choice);
      if (!entry) return;
      await invokeChronoAction(entry[1], "", ctx);
    }
  };

  const maintenanceMenu = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    while (true) {
      const choice = await ctx.ui.select("Chrono: Maintenance", [
        "Search for this session", "Preview a compaction", "Read an interval archive", "Logical session", "Repair a rollup",
        ...(searchSettings().contextCompiler === "v4" ? [] : ["Reset legacy value-worker circuit"]), "Back",
      ]);
      if (!choice || choice === "Back") return true;
      if (choice === "Search for this session") {
        const mode = await ctx.ui.select("Persist indexed history for this session", ["on", "off", "Back"]);
        if (mode === "on" || mode === "off") await invokeChronoAction("search", mode, ctx);
      } else if (choice === "Preview a compaction") {
        const id = await ctx.ui.input("Compaction entry ID (leave blank for nearest). Saves a private preview without changing context.");
        if (id !== undefined) await invokeChronoAction("composition-preview", id.trim(), ctx);
      } else if (choice === "Read an interval archive") {
        const args = await ctx.ui.input("Exact committed compaction entry ID and optional item offset. Read-only derived archive, not accepted Memory. No model call.");
        if (args !== undefined) await invokeChronoAction("archive", args.trim(), ctx);
      } else if (choice === "Reset legacy value-worker circuit") {
        if (await ctx.ui.confirm("Reset legacy value-worker circuit?", "This cancels pending legacy work and clears its failure pause. If enabled, legacy model calls can resume. Stored advice and history are preserved. This is not a V4 history-helper control.")) {
          await invokeChronoAction("value-worker-reset", "", ctx);
        }
      } else {
        const logical = choice === "Logical session";
        const args = await ctx.ui.input(logical
          ? "Logical session action and IDs: adopt [branch]; status|recover|rollback <session>; rollover <session> <branch>; fork <session> <branch> <new-branch>"
          : "Rollup repair: start|step|status <repair-id>; publish <repair-id> <legacy|expected-store-id>");
        if (args !== undefined && !await invokeChronoAction(logical ? "logical-session" : "rollup-repair", args.trim(), ctx)) return false;
      }
    }
  };

  pi.registerCommand("Chrono", {
    description: "Chrono automatic compaction, history roles, status, and maintenance",
    getArgumentCompletions: prefix => {
      const legacyOnly = new Set(["value-worker-status", "value-worker-reset", "catalog-status", "capsules-status", "rollup-shadow-status"]);
      const values = [...chronoActions.keys()].filter(name => !name.startsWith("_") && name.startsWith(prefix)
        && (searchSettings().contextCompiler !== "v4" || !legacyOnly.has(name)));
      return values.length ? values.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const [name, ...rest] = args.trim().split(/\s+/);
      if (name) {
        if (!await invokeChronoAction(name, rest.join(" "), ctx)) return;
        if (name === "_auto-rollover" || ctx.mode !== "tui") return;
      }
      if (!ctx.hasUI) return;
      while (true) {
        const choice = await ctx.ui.select("Chrono", ["Settings", "Status and diagnostics", "Maintenance", "About", "Close"]);
        if (!choice || choice === "Close") return;
        try {
          if (choice === "Settings") await invokeChronoAction("settings", "", ctx);
          else if (choice === "Status and diagnostics") await statusMenu(ctx);
          else if (choice === "Maintenance") { if (!await maintenanceMenu(ctx)) return; }
          else if (choice === "About") await showChronoReport(ctx, "Chrono", [
            `Version ${EXTENSION_VERSION}`,
            "V4 uses one automatic interval policy. History-model roles start unselected and require explicit disclosure confirmation.",
            "Legacy configuration remains readable for rollback. Its timing, target, and tail knobs do not tune the V4 interval policy.",
            "Reports stay here. Enter or Esc returns to the menu. Settings save after each valid change.",
            "Source history is preserved. Background model work is optional and can incur charges.",
          ].join("\n\n"));
        } catch (error) { await showChronoReport(ctx, "Chrono: action failed", safeErrorMessage(error)); }
      }
    },
  });
}
