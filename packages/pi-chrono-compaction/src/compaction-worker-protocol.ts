import type { CompactorConfig, CompressionDetails, ValidationReport } from "./types.js";
import type { CandidateStoreMetrics } from "./candidate-segment-store.js";
import type { RetrievalFeedback } from "./telemetry.js";
import type { HistoryDynamicContext } from "./history-value.js";
import type { RollupShadowPayload, RollupShadowQualityMetrics } from "./history-rollup-shadow.js";
import {
  ROLLUP_SHADOW_FAILURE_CODES,
  ROLLUP_SHADOW_FAILURE_STAGES,
  type RollupShadowFailureCode,
  type RollupShadowFailureContext,
  type RollupShadowFailureStage,
} from "./rollup-shadow-failure.js";

export const COMPACTION_WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_WORKER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_WORKER_TEXT_BYTES = 512 * 1024;
const MAX_WORKER_RESPONSE_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_WORKER_STDERR_BYTES = 16 * 1024;

export type WorkerFailureCode = "worker-disabled" | "no-session-file" | "branch-not-persisted" | "branch-parent-missing" | "branch-cycle" | "branch-source-order" | "invalid-cut" | "source-changed" | "scheduler-timeout" | "worker-timeout" | "worker-aborted" | "worker-crashed" | "worker-protocol-error" | "worker-response-too-large" | "candidate-store-unavailable" | "replay-validation-rejected" | RollupShadowFailureCode;
export type WorkerJobType = "replay-compaction" | "candidate-store-update" | "rollup-shadow";
export interface WorkerSourceExpectation { readonly deviceId: string; readonly inodeId: string; readonly size: number; readonly mtimeMs: number; }
export interface WorkerBaseRequest { readonly schemaVersion: 1; readonly jobId: string; readonly jobType: WorkerJobType; readonly sessionPath: string; readonly expectedSource: WorkerSourceExpectation; readonly deadlineMs: number; readonly niceLevel: number; }
export interface ReplayWorkerRequest extends WorkerBaseRequest {
  readonly jobType: "replay-compaction"; readonly branchLeafId: string; readonly firstKeptEntryId: string;
  readonly config: CompactorConfig; readonly hardOutputTokens: number; readonly retentionHints: string; readonly pinnedMemoryText: string;
  readonly retrievalFeedback?: RetrievalFeedback; readonly candidateStoreEnabled: boolean; readonly cacheEnabled: boolean;
  readonly valueWorkerMode?: "off" | "shadow" | "advisory"; readonly valueWorkerConfigurationHash?: string;
  readonly deterministicRebase?: { readonly targetTokens: number; readonly combinedTargetTokens: number; readonly historicalCeilingTokens: number };
}
export interface RollupShadowWorkerRequest extends WorkerBaseRequest {
  readonly jobType: "rollup-shadow";
  readonly branchLeafId: string;
  readonly firstKeptEntryId: string;
  readonly currentReplayText: string;
  readonly hardTokenBound: number;
  readonly targetTokenBound: number;
  readonly retentionHints: string;
  readonly dynamicContext?: Omit<HistoryDynamicContext, "retentionHints" | "retrievalEntryIds">;
}
export interface CandidateUpdateWorkerRequest extends WorkerBaseRequest {
  readonly jobType: "candidate-store-update"; readonly config: CompactorConfig;
  readonly storeSettings?: { readonly targetSourceBytes?: number; readonly targetEntries?: number; readonly targetRecords?: number };
}
export type CompactionWorkerRequest = ReplayWorkerRequest | CandidateUpdateWorkerRequest | RollupShadowWorkerRequest;
export interface WorkerRuntimeMetrics { readonly workerPid: number; readonly totalWallMs: number; readonly compactionMs: number; readonly cpuUserMicros: number; readonly cpuSystemMicros: number; readonly peakRssKiB: number; readonly priorityApplied: boolean; readonly cacheState: "disabled" | "hit" | "miss" | "write-failed"; readonly modelCalls: 0; readonly networkCalls: 0; readonly secretSentinelPresent: false; readonly sourceLedgerTransition: string; readonly ledgerColdLoadMs: number; readonly branchResolveMs: number; readonly branchReadMs: number; readonly branchEntryCount: number; readonly branchSourceBytes: number; readonly sourceRangeCount: number; readonly sourceBytesRead: number; readonly sourceByteAvoidanceRate: number; readonly completeSessionReadAvoided: boolean; readonly candidateLedgerReused: boolean; }
export interface ReplayWorkerPayload { readonly summary: string; readonly deterministicRebaseText?: string; readonly rawTokens: number; readonly renderedTokens: number; readonly targetTokens: number; readonly validation: ValidationReport; readonly details: CompressionDetails; readonly generationHash: string; readonly planSources: readonly { readonly unitId: string; readonly sourceRefs: readonly { readonly entryId: string; readonly blockIndex?: number }[] }[]; readonly sourceEntryCount: number; }
export interface WorkerSuccessResponse {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly status: "ok";
  readonly jobType: WorkerJobType;
  readonly replay?: ReplayWorkerPayload;
  readonly candidateUpdate?: CandidateStoreMetrics;
  readonly shadow?: RollupShadowPayload;
  readonly shadowWarning?: { readonly stage: "shadow-sidecar-write"; readonly code: "shadow-sidecar-write-failed" };
  readonly metrics: WorkerRuntimeMetrics;
}
export interface WorkerFailureResponse {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly status: "failed";
  readonly jobType: WorkerJobType;
  readonly failureCode: WorkerFailureCode;
  readonly failureStage?: RollupShadowFailureStage;
  readonly failureContext?: RollupShadowFailureContext;
  readonly metrics: WorkerRuntimeMetrics;
}
export type CompactionWorkerResponse = WorkerSuccessResponse | WorkerFailureResponse;

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function boundedText(value: unknown, max = MAX_WORKER_TEXT_BYTES): value is string { return typeof value === "string" && Buffer.byteLength(value) <= max; }
function boundedId(value:unknown,max:number):value is string{return boundedText(value,max)&&value.length>0;}
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max; }
function validExpectation(value: unknown): value is WorkerSourceExpectation { return object(value) && exactKeys(value,["deviceId","inodeId","size","mtimeMs"]) && boundedId(value.deviceId,64) && boundedId(value.inodeId,64) && integer(value.size,0,Number.MAX_SAFE_INTEGER) && typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs); }
const CONFIG_KEYS=["targetTokens","minSummaryTokens","maxSummaryTokens","recentExactBiasFraction","minMarginalUtilityPerToken","mergeEpisodes","mergeBeforeFraction","maxIndividualUnits","minEpisodeRawTokens","maxEpisodeTokens","semanticMaxTokens","enableSemanticCompression","includeHeader","emergencyAllowAbsent","hotSourceTokens","warmSourceTokens","coldCueTokens"] as const;
function validConfig(value:unknown):value is CompactorConfig{if(!object(value)||!exactKeys(value,CONFIG_KEYS))return false;for(const key of CONFIG_KEYS){const item=value[key];if(["mergeEpisodes","enableSemanticCompression","includeHeader","emergencyAllowAbsent"].includes(key)){if(typeof item!=="boolean")return false;}else if(["recentExactBiasFraction","minMarginalUtilityPerToken","mergeBeforeFraction"].includes(key)){if(typeof item!=="number"||!Number.isFinite(item)||item<0||item>1)return false;}else if(!integer(item,0,1_000_000))return false;}return true;}
const FAILURE_CODES:readonly WorkerFailureCode[]=["worker-disabled","no-session-file","branch-not-persisted","branch-parent-missing","branch-cycle","branch-source-order","invalid-cut","source-changed","scheduler-timeout","worker-timeout","worker-aborted","worker-crashed","worker-protocol-error","worker-response-too-large","candidate-store-unavailable","replay-validation-rejected",...ROLLUP_SHADOW_FAILURE_CODES];
const FAILURE_CONTEXT_KEYS = ["sourceFileBytes", "sourceLedgerEntries", "branchEntries", "treeLevels", "leafCount", "rollupCount", "reachableNodeBytes", "currentMemoryBytes", "sourceBytesRead", "nodeBytesRead", "nodeBytes", "nodeTypeCode", "responseBytes"] as const;
function validFailureContext(value: unknown): value is RollupShadowFailureContext {
  return object(value) && exactKeys(value, FAILURE_CONTEXT_KEYS) && Object.values(value).every(item => integer(item, 0, Number.MAX_SAFE_INTEGER));
}
const METRIC_KEYS=["workerPid","totalWallMs","compactionMs","cpuUserMicros","cpuSystemMicros","peakRssKiB","priorityApplied","cacheState","modelCalls","networkCalls","secretSentinelPresent","sourceLedgerTransition","ledgerColdLoadMs","branchResolveMs","branchReadMs","branchEntryCount","branchSourceBytes","sourceRangeCount","sourceBytesRead","sourceByteAvoidanceRate","completeSessionReadAvoided","candidateLedgerReused"] as const;
function validMetrics(value:unknown):value is WorkerRuntimeMetrics{return object(value)&&exactKeys(value,METRIC_KEYS)&&integer(value.workerPid,0,Number.MAX_SAFE_INTEGER)&&["totalWallMs","compactionMs","cpuUserMicros","cpuSystemMicros","peakRssKiB"].every(k=>typeof value[k]==="number"&&Number.isFinite(value[k] as number)&&(value[k] as number)>=0)&&typeof value.priorityApplied==="boolean"&&["disabled","hit","miss","write-failed"].includes(String(value.cacheState))&&value.modelCalls===0&&value.networkCalls===0&&value.secretSentinelPresent===false&&typeof value.sourceLedgerTransition==="string"&&["ledgerColdLoadMs","branchResolveMs","branchReadMs","branchEntryCount","branchSourceBytes","sourceRangeCount","sourceBytesRead","sourceByteAvoidanceRate"].every(k=>typeof value[k]==="number"&&Number.isFinite(value[k] as number)&&(value[k] as number)>=0)&&typeof value.completeSessionReadAvoided==="boolean"&&typeof value.candidateLedgerReused==="boolean";}
function validValidation(value:unknown):value is ValidationReport{return object(value)&&exactKeys(value,["ok","issues"])&&typeof value.ok==="boolean"&&Array.isArray(value.issues)&&value.issues.length<=100_000&&value.issues.every(issue=>object(issue)&&exactKeys(issue,["severity","code","message","unitId"])&&(issue.severity==="error"||issue.severity==="warning")&&boundedText(issue.code,256)&&boundedText(issue.message,4096)&&(issue.unitId===undefined||boundedText(issue.unitId,1024)));}
const CANDIDATE_METRIC_KEYS=["transition","sourceLedgerTransition","sourceBytesRead","ledgerBytesRead","ledgerBytesWritten","entriesParsed","blocksParsed","segmentsCreated","segmentsReused","segmentsLoaded","segmentBytesRead","segmentBytesWritten","persistentCandidateRecordsCreated","persistentCandidateRecordsReused","persistentCandidateRecordsLoaded","candidateHits","candidateMisses","candidateIntegrityRejections","futureSensitiveCandidatesComputed","protectedBlocksSkipped","updateElapsedMs","maximumUpdateTimerDelayMs","manifestGeneration","sourceBytePositionCovered","staleSourceEntries"] as const;
function validCandidateMetrics(value:unknown):value is CandidateStoreMetrics{const transitions=["new","exact-hit","append","rebuild-source-replacement","rebuild-source-truncation","rebuild-source-tail-rewrite","rebuild-config-change","rebuild-reducer-change","rebuild-store-corruption","recover-orphan-segments","stale-ready-snapshot"],ledgerTransitions=["new","exact-hit","append","rebuild-truncation","rebuild-replacement","rebuild-tail-rewrite","recover-incomplete-ledger-tail"];return object(value)&&exactKeys(value,CANDIDATE_METRIC_KEYS)&&transitions.includes(String(value.transition))&&ledgerTransitions.includes(String(value.sourceLedgerTransition))&&CANDIDATE_METRIC_KEYS.slice(2).every(key=>typeof value[key]==="number"&&Number.isFinite(value[key] as number)&&(value[key] as number)>=0);}
function optionalIntegers(value:Record<string,unknown>,keys:readonly string[]):boolean{return keys.every(key=>value[key]===undefined||integer(value[key],0,Number.MAX_SAFE_INTEGER));}
function validDetails(value:unknown,generationHash:unknown):value is CompressionDetails{return object(value)&&exactKeys(value,["schemaVersion","generationHash","sourceEntryIds","sourceRange","rawTokens","renderedTokens","targetTokens","reducerVersions","plan","validation","v2","historyEditor"])&&value.schemaVersion===2&&value.generationHash===generationHash&&Array.isArray(value.sourceEntryIds)&&value.sourceEntryIds.every(id=>boundedId(id,1024))&&(value.sourceRange===undefined||(object(value.sourceRange)&&exactKeys(value.sourceRange,["start","end"])&&boundedId(value.sourceRange.start,1024)&&boundedId(value.sourceRange.end,1024)))&&integer(value.rawTokens,0,Number.MAX_SAFE_INTEGER)&&integer(value.renderedTokens,0,30_000)&&integer(value.targetTokens,0,30_000)&&object(value.reducerVersions)&&Object.entries(value.reducerVersions).every(([key,item])=>boundedId(key,256)&&boundedId(item,256))&&Array.isArray(value.plan)&&value.plan.length<=1_000_000&&value.plan.every(item=>object(item)&&exactKeys(item,["unitId","level","sourceRefs","rawTokens","renderedTokens","importance","importanceReasons"])&&boundedId(item.unitId,1024)&&boundedId(item.level,64)&&Array.isArray(item.sourceRefs)&&item.sourceRefs.every(ref=>object(ref)&&exactKeys(ref,["entryId","blockIndex"])&&boundedId(ref.entryId,1024)&&(ref.blockIndex===undefined||integer(ref.blockIndex,0,Number.MAX_SAFE_INTEGER)))&&integer(item.rawTokens,0,Number.MAX_SAFE_INTEGER)&&integer(item.renderedTokens,0,Number.MAX_SAFE_INTEGER)&&typeof item.importance==="number"&&Number.isFinite(item.importance)&&Array.isArray(item.importanceReasons)&&item.importanceReasons.every(reason=>boundedText(reason,4096)))&&validValidation(value.validation)&&(value.v2===undefined||(object(value.v2)&&exactKeys(value.v2,["resourceGenerationHash","causalGenerationHash","pinnedMemoryTokens","retentionBands","tokenTelemetry"])&&boundedId(value.v2.resourceGenerationHash,256)&&boundedId(value.v2.causalGenerationHash,256)&&integer(value.v2.pinnedMemoryTokens,0,30_000)&&object(value.v2.retentionBands)&&exactKeys(value.v2.retentionBands,["hot","warm","cold"])&&Object.values(value.v2.retentionBands).every(item=>integer(item,0,Number.MAX_SAFE_INTEGER))&&object(value.v2.tokenTelemetry)))&&(value.historyEditor===undefined||(object(value.historyEditor)&&exactKeys(value.historyEditor,["status","calls","model","inputItems","outputDecisions","rejectedDecisions","missingDecisions","changedItems","inputTokens","outputTokens","reason"])&&["disabled","skipped","applied","fallback"].includes(String(value.historyEditor.status))&&(value.historyEditor.calls===0||value.historyEditor.calls===1)&&integer(value.historyEditor.inputItems,0,Number.MAX_SAFE_INTEGER)&&optionalIntegers(value.historyEditor,["outputDecisions","rejectedDecisions","missingDecisions","changedItems","inputTokens","outputTokens"])&&(value.historyEditor.model===undefined||boundedText(value.historyEditor.model,1024))&&(value.historyEditor.reason===undefined||boundedText(value.historyEditor.reason,4096))));}
function validReplay(value:unknown):value is ReplayWorkerPayload{return object(value)&&exactKeys(value,["summary","deterministicRebaseText","rawTokens","renderedTokens","targetTokens","validation","details","generationHash","planSources","sourceEntryCount"])&&boundedText(value.summary,MAX_WORKER_RESPONSE_TEXT_BYTES)&&(value.deterministicRebaseText===undefined||boundedText(value.deterministicRebaseText,MAX_WORKER_RESPONSE_TEXT_BYTES))&&integer(value.rawTokens,0,Number.MAX_SAFE_INTEGER)&&integer(value.renderedTokens,0,30_000)&&integer(value.targetTokens,0,30_000)&&validValidation(value.validation)&&validDetails(value.details,value.generationHash)&&boundedId(value.generationHash,256)&&Array.isArray(value.planSources)&&value.planSources.length<=1_000_000&&value.planSources.every(unit=>object(unit)&&exactKeys(unit,["unitId","sourceRefs"])&&boundedText(unit.unitId,1024)&&Array.isArray(unit.sourceRefs)&&unit.sourceRefs.every(ref=>object(ref)&&exactKeys(ref,["entryId","blockIndex"])&&boundedText(ref.entryId,1024)&&(ref.blockIndex===undefined||integer(ref.blockIndex,0,Number.MAX_SAFE_INTEGER))))&&integer(value.sourceEntryCount,0,Number.MAX_SAFE_INTEGER);}
export function validateWorkerRequest(value: unknown): CompactionWorkerRequest {
  if (!object(value) || value.schemaVersion !== 1 || !["replay-compaction", "candidate-store-update", "rollup-shadow"].includes(String(value.jobType))) throw new Error("worker-protocol-error");
  const common=["schemaVersion","jobId","jobType","sessionPath","expectedSource","deadlineMs","niceLevel"];
  const allowed = value.jobType === "replay-compaction"
    ? [...common, "branchLeafId", "firstKeptEntryId", "config", "hardOutputTokens", "retentionHints", "pinnedMemoryText", "retrievalFeedback", "candidateStoreEnabled", "cacheEnabled", "valueWorkerMode", "valueWorkerConfigurationHash", "deterministicRebase"]
    : value.jobType === "candidate-store-update"
      ? [...common, "config", "storeSettings"]
      : [...common, "branchLeafId", "firstKeptEntryId", "currentReplayText", "hardTokenBound", "targetTokenBound", "retentionHints", "dynamicContext"];
  if (!exactKeys(value, allowed) || !boundedId(value.jobId, 256) || !boundedId(value.sessionPath, 4096) || !validExpectation(value.expectedSource) || !integer(value.deadlineMs, Date.now() - 1, Date.now() + 3_600_000) || !integer(value.niceLevel, 0, 19)) throw new Error("worker-protocol-error");
  if (value.jobType !== "rollup-shadow" && !validConfig(value.config)) throw new Error("worker-protocol-error");
  if (value.jobType==="replay-compaction") {
    if (!boundedId(value.branchLeafId,1024)||!boundedId(value.firstKeptEntryId,1024)||!integer(value.hardOutputTokens,128,30_000)||!boundedText(value.retentionHints)||!boundedText(value.pinnedMemoryText)||typeof value.candidateStoreEnabled!=="boolean"||typeof value.cacheEnabled!=="boolean" || (value.valueWorkerMode !== undefined && !["off","shadow","advisory"].includes(String(value.valueWorkerMode))) || (value.valueWorkerConfigurationHash !== undefined && (typeof value.valueWorkerConfigurationHash !== "string" || !/^[a-f0-9]{64}$/.test(value.valueWorkerConfigurationHash)))) throw new Error("worker-protocol-error");
    if (value.retrievalFeedback!==undefined && (!object(value.retrievalFeedback)||Buffer.byteLength(JSON.stringify(value.retrievalFeedback))>MAX_WORKER_TEXT_BYTES)) throw new Error("worker-protocol-error");
    if (value.deterministicRebase!==undefined && (!object(value.deterministicRebase)||!exactKeys(value.deterministicRebase,["targetTokens","combinedTargetTokens","historicalCeilingTokens"])||!integer(value.deterministicRebase.targetTokens,256,16_000)||!integer(value.deterministicRebase.combinedTargetTokens,256,30_000)||!integer(value.deterministicRebase.historicalCeilingTokens,256,30_000))) throw new Error("worker-protocol-error");
  } else if (value.jobType === "rollup-shadow") {
    if (!boundedId(value.branchLeafId, 1024) || !boundedId(value.firstKeptEntryId, 1024) ||
      !boundedText(value.currentReplayText, MAX_WORKER_TEXT_BYTES) || !boundedText(value.retentionHints) ||
      !integer(value.hardTokenBound, 128, 25_000) || !integer(value.targetTokenBound, 128, value.hardTokenBound as number) ||
      (value.dynamicContext !== undefined && (!object(value.dynamicContext) || Buffer.byteLength(JSON.stringify(value.dynamicContext)) > MAX_WORKER_TEXT_BYTES))) {
      throw new Error("worker-protocol-error");
    }
  } else if (value.storeSettings!==undefined && (!object(value.storeSettings)||!exactKeys(value.storeSettings,["targetSourceBytes","targetEntries","targetRecords"])||Object.values(value.storeSettings).some(item=>item!==undefined&&!integer(item,1,100_000_000)))) throw new Error("worker-protocol-error");
  const bytes=Buffer.byteLength(JSON.stringify(value)); if(bytes>MAX_WORKER_REQUEST_BYTES) throw new Error("worker-protocol-error"); return value as unknown as CompactionWorkerRequest;
}
const SHADOW_QUALITY_KEYS = ["restrictionCueCoverage", "blockerCoverage", "unresolvedFailureCoverage", "currentResourceCoverage", "invalidReferences", "invalidRanges", "cutLines", "falseCompletions", "unsupportedIdentifiers", "unsupportedQuotations", "unsupportedNumbers", "missingRecoveryRoutes"] as const;
function validShadowQuality(value: unknown): value is RollupShadowQualityMetrics {
  return object(value) && exactKeys(value, SHADOW_QUALITY_KEYS) && SHADOW_QUALITY_KEYS.every(key =>
    typeof value[key] === "number" && Number.isFinite(value[key] as number) && (value[key] as number) >= 0);
}
function validShadow(value: unknown): value is RollupShadowPayload {
  const keys = ["schemaVersion", "generation", "sourceTokenCount", "currentReplayTokenCount", "rollupTokenCount", "currentQuality", "rollupQuality", "updateTimeMs", "renderTimeMs", "sourceBytesRead", "nodeBytesRead", "queryNodes", "workerTimerDelayMs", "validationIssueCounts", "currentReplayHash", "rollupOutputHash", "safeStatus", "modelCalls", "networkCalls"];
  return object(value) && exactKeys(value, keys) && value.schemaVersion === 2 &&
    ["generation", "sourceTokenCount", "currentReplayTokenCount", "rollupTokenCount", "sourceBytesRead", "nodeBytesRead", "queryNodes"].every(key => integer(value[key], 0, Number.MAX_SAFE_INTEGER)) &&
    ["updateTimeMs", "renderTimeMs", "workerTimerDelayMs"].every(key => typeof value[key] === "number" && Number.isFinite(value[key] as number) && (value[key] as number) >= 0) &&
    validShadowQuality(value.currentQuality) && validShadowQuality(value.rollupQuality) &&
    object(value.validationIssueCounts) && Object.entries(value.validationIssueCounts).every(([key, count]) => /^[a-z0-9-]{1,64}$/.test(key) && integer(count, 0, Number.MAX_SAFE_INTEGER)) &&
    typeof value.currentReplayHash === "string" && /^[a-f0-9]{64}$/.test(value.currentReplayHash) &&
    typeof value.rollupOutputHash === "string" && /^[a-f0-9]{64}$/.test(value.rollupOutputHash) &&
    ["ok", "validation-failed", "store-busy-snapshot", "empty-prefix"].includes(String(value.safeStatus)) &&
    value.modelCalls === 0 && value.networkCalls === 0;
}

export function validateWorkerResponse(value: unknown, expectedJobId?: string): CompactionWorkerResponse {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    (value.status !== "ok" && value.status !== "failed") ||
    !["replay-compaction", "candidate-store-update", "rollup-shadow"].includes(String(value.jobType)) ||
    !boundedId(value.jobId, 256) ||
    (expectedJobId !== undefined && value.jobId !== expectedJobId) ||
    !validMetrics(value.metrics)
  ) {
    throw new Error("worker-protocol-error");
  }
  if (value.status === "failed") {
    if (
      !exactKeys(value, ["schemaVersion", "jobId", "status", "jobType", "failureCode", "failureStage", "failureContext", "metrics"]) ||
      !FAILURE_CODES.includes(value.failureCode as WorkerFailureCode) ||
      (value.jobType === "rollup-shadow" &&
        (!ROLLUP_SHADOW_FAILURE_STAGES.includes(value.failureStage as RollupShadowFailureStage) ||
          !ROLLUP_SHADOW_FAILURE_CODES.includes(value.failureCode as RollupShadowFailureCode))) ||
      (value.failureStage !== undefined && !ROLLUP_SHADOW_FAILURE_STAGES.includes(value.failureStage as RollupShadowFailureStage)) ||
      (value.failureContext !== undefined && !validFailureContext(value.failureContext))
    ) {
      throw new Error("worker-protocol-error");
    }
  } else {
    if (!exactKeys(value, ["schemaVersion", "jobId", "status", "jobType", "replay", "candidateUpdate", "shadow", "shadowWarning", "metrics"])) {
      throw new Error("worker-protocol-error");
    }
    if (
      value.jobType === "replay-compaction" &&
      (!validReplay(value.replay) || value.candidateUpdate !== undefined || value.shadow !== undefined || value.shadowWarning !== undefined)
    ) {
      throw new Error("worker-protocol-error");
    }
    if (
      value.jobType === "candidate-store-update" &&
      (!validCandidateMetrics(value.candidateUpdate) || value.replay !== undefined || value.shadow !== undefined || value.shadowWarning !== undefined)
    ) {
      throw new Error("worker-protocol-error");
    }
    if (
      value.jobType === "rollup-shadow" &&
      (!validShadow(value.shadow) || value.replay !== undefined || value.candidateUpdate !== undefined ||
        (value.shadowWarning !== undefined && (!object(value.shadowWarning) ||
          !exactKeys(value.shadowWarning, ["stage", "code"]) ||
          value.shadowWarning.stage !== "shadow-sidecar-write" || value.shadowWarning.code !== "shadow-sidecar-write-failed")))
    ) {
      throw new Error("worker-protocol-error");
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_WORKER_RESPONSE_BYTES) {
    throw new Error("worker-response-too-large");
  }
  return value as unknown as CompactionWorkerResponse;
}
