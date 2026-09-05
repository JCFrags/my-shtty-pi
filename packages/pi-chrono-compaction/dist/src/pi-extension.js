import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { env } from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { cachePathForSession, hashCompactionConfig, nextCacheGeneration, readCompactionCache, writeCompactionCache, } from "./cache.js";
import { compactEntries, CompactionValidationError, computeGenerationHash, computeSummaryBudget, HARD_REPLAY_CAP_TOKENS, resolveCompactorConfig, selectReplayTarget, } from "./compactor.js";
import { parseHistoricalBlocks } from "./blocks.js";
import { buildCausalMemory } from "./causal-memory.js";
import { projectToolResultContext, projectionSourcesFromBranch, } from "./context-projection.js";
import { createCandidateSegmentStore, loadCandidateRecordsForBranch, loadCandidateSegmentManifest, updateCandidateSegmentStore, } from "./candidate-segment-store.js";
import { getSourceEntriesBefore, parseBranchEntries, readBoundedSessionJsonl } from "./jsonl.js";
import { loadSourceLedger, sourceLedgerIsBusy, sourceLedgerMatchesSource, sourceLedgerPath } from "./source-ledger.js";
import { createPiRegularSummary, previousRegularPiSummary, regularSummaryMessagesForCut, renderHybridCompaction, } from "./pi-hybrid.js";
import { DEFAULT_VALUE_WORKER_SETTINGS } from "./value-worker-types.js";
import { runValueWorker, loadCompatibleAdvice, valueWorkerConfigurationHash } from "./value-worker.js";
import { readValueAdviceManifest, resetAdviceCircuit, valueAdviceStorePath } from "./value-advice-store.js";
import { historyGet, historyGetFromLedger, historyRange, historyRangeFromLedger, historySearch, } from "./retrieval.js";
import { buildLocalSearchIndex, renderRankedSearch, searchLocalHistory } from "./search-index.js";
import { recallHistory, renderRecall } from "./recall.js";
import { appendMemoryEvent, listMemories, memorySidecarPath, readMemoryEvents, renderPinnedMemory, searchMemories, } from "./memory-store.js";
import { decideRegularSummaryRebase } from "./summary-rebase.js";
import { RAW_TAIL_PRESET_TOKENS, isSafeCompactionCut, selectDynamicRawTail, selectRawTail, selectRawTailWithinMaximum, } from "./tail-selection.js";
import { decideCompactionTrigger } from "./trigger.js";
import { applyConfigCommand, defaultUserConfigPath, loadUserConfig, saveUserConfig, } from "./user-config.js";
import { emptyRetrievalFeedback, recordRetrievalFeedback } from "./telemetry.js";
import { estimateTokensFromText, hashText, safeErrorMessage, stableStringify, truncateToTokens } from "./utils.js";
import { replayWorkerDiagnosticPath, runCompactionWorker } from "./compaction-worker-client.js";
import { defaultSchedulerDirectory, schedulerArtifactCounts } from "./host-worker-scheduler.js";
import { getRollupShadowStatus } from "./history-rollup-shadow.js";
import { returnAuthoritativeAfterShadowSchedule } from "./post-result-shadow.js";
const EXTENSION_VERSION = "2.0.2";
export const HARD_COMBINED_CONTEXT_CAP_TOKENS = 30_000;
const MAX_RAW_TAIL_WITH_HISTORY_TOKENS = 27_000;
const RETENTION_HINT_CUSTOM_TYPE = "chrono-compact-retention-hint";
const CONTEXT_WARNING_CUSTOM_TYPE = "chrono-compact-context-warning";
const CONTEXT_RESUME_CUSTOM_TYPE = "chrono-compact-resume";
const CONTEXT_WARNING_PERCENT = 75;
const CONTEXT_URGENT_PERCENT = 85;
const CONTEXT_CIRCUIT_BREAKER_PERCENT = 95;
function configuredValue(name, override) {
    return env[name] === undefined ? override : env[name];
}
function numberSetting(name, fallback, min, max, override) {
    const raw = configuredValue(name, override);
    if (raw === undefined || raw === null || raw === "")
        return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function optionalNumberSetting(name, min, max, override) {
    const raw = String(configuredValue(name, override) ?? "").trim().toLowerCase();
    if (!raw || raw === "pi" || raw === "off" || raw === "disabled" || raw === "null")
        return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : undefined;
}
function booleanSetting(name, fallback, override) {
    const raw = String(configuredValue(name, override) ?? "").trim().toLowerCase();
    if (!raw)
        return fallback;
    if (["1", "true", "yes", "on"].includes(raw))
        return true;
    if (["0", "false", "no", "off"].includes(raw))
        return false;
    return fallback;
}
function stringSetting(name, fallback, override) {
    const raw = String(configuredValue(name, override) ?? "").trim();
    return raw || fallback;
}
function projectionModeSetting(override) {
    const raw = String(configuredValue("PI_CHRONO_TOOL_RESULT_PROJECTION", override) ?? "").trim().toLowerCase();
    return raw === "safe" || raw === "aggressive" ? raw : "off";
}
function rawTailSetting(override) {
    const raw = String(configuredValue("PI_CHRONO_RAW_TAIL", override) ?? "").trim().toLowerCase();
    if (!raw || raw === "dynamic")
        return { mode: "dynamic" };
    if (raw === "pi")
        return { mode: "pi" };
    if (raw === "short" || raw === "medium" || raw === "long") {
        return { mode: raw, tokens: RAW_TAIL_PRESET_TOKENS[raw] };
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric))
        return { mode: "fixed", tokens: Math.min(200_000, Math.max(1_000, Math.floor(numeric))) };
    return { mode: "pi" };
}
export function resolveExtensionSettings(overrides = {}) {
    const rawTail = rawTailSetting(overrides.rawTail);
    const triggerThresholdTokens = optionalNumberSetting("PI_CHRONO_TRIGGER_TOKENS", 8_000, 250_000, overrides.triggerThresholdTokens);
    const replayTargetTokens = optionalNumberSetting("PI_CHRONO_REPLAY_TARGET", 256, 25_000, overrides.replayTargetTokens);
    return {
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
        // Retained as a compatibility-shaped field. The regular Pi summary is required.
        hybridSummaryEnabled: true,
        legacyPiSummaryDisabled: !booleanSetting("PI_CHRONO_PI_SUMMARY", true, overrides.hybridSummaryEnabled),
        hybridSummaryTargetTokens: numberSetting("PI_CHRONO_PI_SUMMARY_TOKENS", 2_500, 512, 16_000, overrides.hybridSummaryTargetTokens),
        legacyHistoryEditorEnabled: booleanSetting("PI_CHRONO_HISTORY_EDITOR", false, overrides.historyEditorEnabled),
        historyEditorEnabled: false,
        valueWorker: {
            mode: (["shadow", "advisory"].includes(String(env.PI_CHRONO_VALUE_WORKER_MODE ?? overrides.valueWorkerMode)) ? (env.PI_CHRONO_VALUE_WORKER_MODE ?? overrides.valueWorkerMode) : "off"),
            model: stringSetting("PI_CHRONO_VALUE_WORKER_MODEL", DEFAULT_VALUE_WORKER_SETTINGS.model, overrides.valueWorkerModel),
            thinking: (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(env.PI_CHRONO_VALUE_WORKER_THINKING ?? overrides.valueWorkerThinking)) ? (env.PI_CHRONO_VALUE_WORKER_THINKING ?? overrides.valueWorkerThinking) : "inherit"),
            maxInputTokensPerJob: numberSetting("PI_CHRONO_VALUE_WORKER_JOB_INPUT", 6_000, 1_000, 12_000, overrides.valueWorkerMaxInputTokensPerJob),
            maxOutputTokensPerJob: numberSetting("PI_CHRONO_VALUE_WORKER_JOB_OUTPUT", 1_500, 256, 4_000, overrides.valueWorkerMaxOutputTokensPerJob),
            maxItemsPerJob: numberSetting("PI_CHRONO_VALUE_WORKER_JOB_ITEMS", 40, 5, 100, overrides.valueWorkerMaxItemsPerJob),
            timeoutSeconds: numberSetting("PI_CHRONO_VALUE_WORKER_TIMEOUT", 90, 10, 600, overrides.valueWorkerTimeoutSeconds),
            retries: numberSetting("PI_CHRONO_VALUE_WORKER_RETRIES", 1, 0, 2, overrides.valueWorkerRetries),
            hostSlots: numberSetting("PI_CHRONO_VALUE_WORKER_SLOTS", 1, 1, 4, overrides.valueWorkerHostSlots),
            maxCallsPerSession: numberSetting("PI_CHRONO_VALUE_WORKER_SESSION_CALLS", 100, 1, 2_000, overrides.valueWorkerMaxCallsPerSession),
            maxInputTokensPerSession: numberSetting("PI_CHRONO_VALUE_WORKER_SESSION_INPUT", 250_000, 1_000, 10_000_000, overrides.valueWorkerMaxInputTokensPerSession),
            maxOutputTokensPerSession: numberSetting("PI_CHRONO_VALUE_WORKER_SESSION_OUTPUT", 50_000, 1_000, 2_000_000, overrides.valueWorkerMaxOutputTokensPerSession),
            ...(() => { const raw = env.PI_CHRONO_VALUE_WORKER_COST; if (raw && ["off", "disabled", "none"].includes(raw.trim().toLowerCase()))
                return {}; const usd = raw === undefined || raw.trim() === "" ? overrides.valueWorkerMaxEstimatedCostUsd : Number(raw); if (usd === undefined || usd === null)
                return {}; if (!Number.isFinite(usd) || usd < 0.01 || usd > 1000)
                throw new Error("PI_CHRONO_VALUE_WORKER_COST must be off or 0.01 through 1000."); return { maxEstimatedCostMicroUsd: Math.ceil(usd * 1_000_000) }; })(),
            circuitFailureLimit: numberSetting("PI_CHRONO_VALUE_WORKER_CIRCUIT_FAILURES", 3, 1, 20, overrides.valueWorkerCircuitFailureLimit),
            circuitCooldownSeconds: numberSetting("PI_CHRONO_VALUE_WORKER_CIRCUIT_COOLDOWN", 1_800, 30, 86_400, overrides.valueWorkerCircuitCooldownSeconds),
        },
        incrementalPrecomputeEnabled: booleanSetting("PI_CHRONO_INCREMENTAL_PRECOMPUTE", false, overrides.incrementalPrecomputeEnabled),
        isolatedWorkerEnabled: booleanSetting("PI_CHRONO_ISOLATED_WORKER", false, overrides.isolatedWorkerEnabled),
        rollupShadowEnabled: booleanSetting("PI_CHRONO_ROLLUP_SHADOW", false, overrides.rollupShadowEnabled),
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
async function workerSourceExpectation(sessionPath) {
    const before = await stat(sessionPath);
    if (!before.isFile())
        throw new Error("source-changed");
    const prefixBytes = Math.min(before.size, 65_536);
    const bytes = Buffer.alloc(prefixBytes);
    const handle = await open(sessionPath, "r");
    try {
        if (prefixBytes > 0) {
            const read = await handle.read(bytes, 0, prefixBytes, before.size - prefixBytes);
            if (read.bytesRead !== prefixBytes)
                throw new Error("source-changed");
        }
    }
    finally {
        await handle.close();
    }
    const after = await stat(sessionPath);
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino) || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error("source-changed");
    return { deviceId: String(before.dev), inodeId: String(before.ino), size: before.size, mtimeMs: before.mtimeMs, prefixHash: createHash("sha256").update(bytes).digest("hex"), prefixBytes };
}
function rawTailDescription(settings) {
    if (settings.rawTailMode === "dynamic") {
        return `dynamic ${settings.dynamicRawTailMinTokens.toLocaleString()}–${settings.dynamicRawTailMaxTokens.toLocaleString()}`;
    }
    if (settings.rawTailTokens !== undefined)
        return `${settings.rawTailMode} ${settings.rawTailTokens.toLocaleString()}`;
    return "Pi prepared tail";
}
async function tokenInput(ctx, title, current, command, config) {
    const value = await ctx.ui.input(title, current.toString());
    if (value === undefined)
        return config;
    try {
        return applyConfigCommand(config, `${command} ${value.trim()}`).config;
    }
    catch (error) {
        ctx.ui.notify(safeErrorMessage(error), "warning");
        return config;
    }
}
async function openChronoCompactSettings(ctx, initial) {
    let draft = initial;
    while (true) {
        const settings = resolveExtensionSettings(draft);
        const timing = settings.triggerThresholdTokens === undefined
            ? "Pi context pressure"
            : `proactive at ${settings.triggerThresholdTokens.toLocaleString()} tokens`;
        const choice = await ctx.ui.select("ChronoCompact settings", [
            `Loaded version · ${EXTENSION_VERSION}`,
            `Compaction timing · ${timing}`,
            "Pi pressure safeguard · managed by Pi settings",
            `Threshold retry growth · ${settings.triggerMinimumGrowthTokens.toLocaleString()} tokens`,
            `Raw history retained · ${rawTailDescription(settings)}`,
            `Dynamic tail bounds · ${settings.dynamicRawTailMinTokens.toLocaleString()}–${settings.dynamicRawTailMaxTokens.toLocaleString()} tokens`,
            `Active context target · ${settings.targetContextTokens.toLocaleString()} tokens`,
            `Chronological replay maximum · ${settings.replayTargetTokens === undefined ? "automatic" : `${settings.replayTargetTokens.toLocaleString()} tokens`}`,
            `Regular Pi summary · ${settings.hybridSummaryEnabled ? `${settings.hybridSummaryTargetTokens.toLocaleString()} tokens` : "disabled"}`,
            `Background value worker · ${settings.valueWorker.mode} · ${settings.valueWorker.model} · thinking ${settings.valueWorker.thinking}`,
            "Retrospective only. Bounded assistant and tool excerpts can be sent only after enablement. Protected exact, user, and project instruction text is never sent. Final replay remains deterministic. Compaction never waits. Shadow does not change replay.",
            `Segmented incremental deterministic precompute · ${settings.incrementalPrecomputeEnabled ? "enabled" : "disabled"}`,
            `Isolated local compaction worker · ${settings.isolatedWorkerEnabled ? `enabled · ${settings.hostWorkerSlots} host slot(s) · nice ${settings.workerNiceLevel}` : "disabled"}`,
            `Hierarchical rollup shadow evaluation · ${settings.rollupShadowEnabled ? "enabled · output does not reach the model · current replay authoritative · local isolated low-priority worker · metrics only" : "disabled"}`,
            `Request-local tool-result projection · ${settings.toolResultProjectionMode}`,
            `Ranked local history search · ${settings.rankedSearchEnabled ? "enabled" : "disabled"}`,
            `Editable working memory · ${settings.editableMemoryEnabled ? "enabled" : "disabled"}`,
            `Source retention bands · hot ${settings.config.hotSourceTokens?.toLocaleString()} + warm ${settings.config.warmSourceTokens?.toLocaleString()}`,
            `Regular-summary rebase · every ${settings.summaryRebaseInterval} generations`,
            "Reset all to defaults",
            "Save and close",
            "Cancel",
        ]);
        if (choice === undefined || choice === "Cancel")
            return undefined;
        if (choice === "Save and close")
            return draft;
        if (choice.startsWith("Loaded version")) {
            ctx.ui.notify(`ChronoCompact ${EXTENSION_VERSION} is loaded. Hard replay cap: ${HARD_REPLAY_CAP_TOKENS.toLocaleString()} tokens. Hard combined cap: ${HARD_COMBINED_CONTEXT_CAP_TOKENS.toLocaleString()} tokens.`, "info");
            continue;
        }
        if (choice.startsWith("Compaction timing")) {
            const selected = await ctx.ui.select("When should ChronoCompact request compaction?", [
                "Use Pi context pressure only",
                "Use a proactive token threshold",
            ]);
            if (selected === "Use Pi context pressure only")
                draft = applyConfigCommand(draft, "trigger pi").config;
            if (selected === "Use a proactive token threshold") {
                draft = await tokenInput(ctx, "Proactive threshold in tokens", settings.triggerThresholdTokens ?? 48_000, "trigger", draft);
            }
            continue;
        }
        if (choice.startsWith("Pi pressure safeguard")) {
            const usage = ctx.getContextUsage();
            ctx.ui.notify([
                "Pi pressure compaction is separate from the proactive ChronoCompact threshold.",
                "Pi default trigger: context window minus 16,384 reserved tokens.",
                "Pi default preparation tail: 20,000 tokens.",
                usage ? `Current reported context: ${usage.tokens?.toLocaleString() ?? "unknown"}/${usage.contextWindow.toLocaleString()} tokens.` : "Current context usage is unavailable.",
                "Pi pressure can trigger earlier than a higher ChronoCompact threshold and remains the final safeguard.",
            ].join("\n"), "info");
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
            if (selected === "Use Pi prepared tail")
                draft = applyConfigCommand(draft, "raw-tail pi").config;
            else if (selected === "Dynamic bounded tail")
                draft = applyConfigCommand(draft, "raw-tail dynamic").config;
            else if (selected?.startsWith("Short"))
                draft = applyConfigCommand(draft, "raw-tail short").config;
            else if (selected?.startsWith("Medium"))
                draft = applyConfigCommand(draft, "raw-tail medium").config;
            else if (selected?.startsWith("Long"))
                draft = applyConfigCommand(draft, "raw-tail long").config;
            else if (selected === "Fixed token amount") {
                draft = await tokenInput(ctx, "Raw-tail token amount", settings.rawTailTokens ?? 16_000, "raw-tail", draft);
            }
            continue;
        }
        if (choice.startsWith("Dynamic tail bounds")) {
            const minimum = await ctx.ui.input("Dynamic raw-tail minimum", settings.dynamicRawTailMinTokens.toString());
            if (minimum === undefined)
                continue;
            const maximum = await ctx.ui.input("Dynamic raw-tail maximum", settings.dynamicRawTailMaxTokens.toString());
            if (maximum === undefined)
                continue;
            try {
                draft = applyConfigCommand(draft, `raw-tail-bounds ${minimum.trim()} ${maximum.trim()}`).config;
            }
            catch (error) {
                ctx.ui.notify(safeErrorMessage(error), "warning");
            }
            continue;
        }
        if (choice.startsWith("Active context target")) {
            draft = await tokenInput(ctx, "Target active context after compaction", settings.targetContextTokens, "target-context", draft);
            continue;
        }
        if (choice.startsWith("Chronological replay maximum")) {
            const selected = await ctx.ui.select("Chronological replay budget", ["Derive automatically", "Use a fixed maximum"]);
            if (selected === "Derive automatically")
                draft = applyConfigCommand(draft, "replay-target auto").config;
            if (selected === "Use a fixed maximum") {
                draft = await tokenInput(ctx, "Maximum replay tokens", settings.replayTargetTokens ?? 10_000, "replay-target", draft);
            }
            continue;
        }
        if (choice.startsWith("Regular Pi summary")) {
            const selected = await ctx.ui.select("Regular Pi summary", ["Enabled", "Disabled"]);
            if (selected === "Disabled")
                draft = applyConfigCommand(draft, "hybrid off").config;
            if (selected === "Enabled") {
                draft = applyConfigCommand(draft, "hybrid on").config;
                draft = await tokenInput(ctx, "Regular Pi summary target tokens", settings.hybridSummaryTargetTokens, "hybrid-tokens", draft);
            }
            continue;
        }
        if (choice.startsWith("Background value worker")) {
            const mode = await ctx.ui.select("Background value-worker mode", ["off", "shadow", "advisory"]);
            if (!mode)
                continue;
            draft = applyConfigCommand(draft, `value-worker-mode ${mode}`).config;
            const model = await ctx.ui.input("Value model: main or provider/model", settings.valueWorker.model);
            if (model !== undefined)
                draft = applyConfigCommand(draft, `value-worker-model ${model.trim()}`).config;
            const selectedModel = settings.valueWorker.model === "main" ? ctx.model : (() => { const slash = settings.valueWorker.model.indexOf("/"); return slash > 0 ? ctx.modelRegistry.find(settings.valueWorker.model.slice(0, slash), settings.valueWorker.model.slice(slash + 1)) : undefined; })();
            const thinkingOptions = selectedModel ? ["inherit", ...getSupportedThinkingLevels(selectedModel)] : ["inherit"];
            const thinking = await ctx.ui.select("Value-model thinking level", thinkingOptions);
            if (thinking)
                draft = applyConfigCommand(draft, `value-worker-thinking ${thinking}`).config;
            draft = await tokenInput(ctx, "Maximum input tokens per value job", settings.valueWorker.maxInputTokensPerJob, "value-worker-job-input", draft);
            draft = await tokenInput(ctx, "Maximum output tokens per value job", settings.valueWorker.maxOutputTokensPerJob, "value-worker-job-output", draft);
            draft = await tokenInput(ctx, "Maximum items per value job", settings.valueWorker.maxItemsPerJob, "value-worker-job-items", draft);
            draft = await tokenInput(ctx, "Value-job timeout seconds", settings.valueWorker.timeoutSeconds, "value-worker-timeout", draft);
            draft = await tokenInput(ctx, "Value-job retries", settings.valueWorker.retries, "value-worker-retries", draft);
            draft = await tokenInput(ctx, "Host-wide value-model slots", settings.valueWorker.hostSlots, "value-worker-slots", draft);
            draft = await tokenInput(ctx, "Maximum value calls per session", settings.valueWorker.maxCallsPerSession, "value-worker-session-calls", draft);
            draft = await tokenInput(ctx, "Maximum value input tokens per session", settings.valueWorker.maxInputTokensPerSession, "value-worker-session-input", draft);
            draft = await tokenInput(ctx, "Maximum value output tokens per session", settings.valueWorker.maxOutputTokensPerSession, "value-worker-session-output", draft);
            const cost = await ctx.ui.input("Maximum estimated value cost in USD, or off", draft.valueWorkerMaxEstimatedCostUsd == null ? "off" : String(draft.valueWorkerMaxEstimatedCostUsd));
            if (cost !== undefined)
                draft = applyConfigCommand(draft, `value-worker-cost ${cost.trim()}`).config;
            draft = await tokenInput(ctx, "Circuit failure limit", settings.valueWorker.circuitFailureLimit, "value-worker-circuit-failures", draft);
            draft = await tokenInput(ctx, "Circuit cooldown seconds", settings.valueWorker.circuitCooldownSeconds, "value-worker-circuit-cooldown", draft);
            continue;
        }
        if (choice.startsWith("Segmented incremental deterministic precompute")) {
            const selected = await ctx.ui.select("Incremental deterministic precompute", ["Enabled", "Disabled"]);
            if (selected === "Disabled")
                draft = applyConfigCommand(draft, "incremental-precompute off").config;
            if (selected === "Enabled")
                draft = applyConfigCommand(draft, "incremental-precompute on").config;
            continue;
        }
        if (choice.startsWith("Hierarchical rollup shadow evaluation")) {
            const selected = await ctx.ui.select("Hierarchical rollup shadow evaluation", ["Enabled", "Disabled"]);
            if (selected === "Disabled")
                draft = applyConfigCommand(draft, "rollup-shadow off").config;
            if (selected === "Enabled")
                draft = applyConfigCommand(draft, "rollup-shadow on").config;
            continue;
        }
        if (choice.startsWith("Isolated local compaction worker")) {
            const selected = await ctx.ui.select("Isolated local compaction worker", ["Enabled", "Disabled"]);
            if (selected === "Disabled")
                draft = applyConfigCommand(draft, "isolated-worker off").config;
            if (selected === "Enabled") {
                draft = applyConfigCommand(draft, "isolated-worker on").config;
                draft = await tokenInput(ctx, "Host-wide ChronoCompact worker slots (one prevents simultaneous CPU jobs by default)", settings.hostWorkerSlots, "worker-slots", draft);
                draft = await tokenInput(ctx, "Local worker timeout in seconds", settings.workerTimeoutSeconds, "worker-timeout", draft);
                draft = await tokenInput(ctx, "Local worker nice level (the worker does not call a model)", settings.workerNiceLevel, "worker-nice", draft);
            }
            continue;
        }
        if (choice.startsWith("Request-local tool-result projection")) {
            const selected = await ctx.ui.select("Request-local tool-result projection", ["Off", "Safe", "Aggressive"]);
            if (selected)
                draft = applyConfigCommand(draft, `tool-result-projection ${selected.toLowerCase()}`).config;
            continue;
        }
        if (choice.startsWith("Ranked local history search")) {
            const selected = await ctx.ui.select("Ranked local history search", ["Enabled", "Disabled"]);
            if (selected)
                draft = applyConfigCommand(draft, `ranked-search ${selected.toLowerCase() === "enabled" ? "on" : "off"}`).config;
            continue;
        }
        if (choice.startsWith("Editable working memory")) {
            const selected = await ctx.ui.select("Editable working memory", ["Enabled", "Disabled"]);
            if (selected)
                draft = applyConfigCommand(draft, `memory ${selected.toLowerCase() === "enabled" ? "on" : "off"}`).config;
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
        if (choice === "Reset all to defaults") {
            if (await ctx.ui.confirm("Reset ChronoCompact settings?", "This removes all persistent overrides."))
                draft = {};
        }
    }
}
function asEntries(value) {
    if (!Array.isArray(value))
        throw new Error("Pi did not provide branchEntries as an array.");
    return value.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.type === "string");
}
function hasUnresolvedTurn(entries) {
    let latestUserIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const message = entry?.type === "message" && entry.message !== null && typeof entry.message === "object"
            ? entry.message
            : undefined;
        if (message?.role === "user") {
            latestUserIndex = index;
            break;
        }
    }
    if (latestUserIndex < 0)
        return false;
    for (let index = entries.length - 1; index > latestUserIndex; index -= 1) {
        const entry = entries[index];
        const message = entry?.type === "message" && entry.message !== null && typeof entry.message === "object"
            ? entry.message
            : undefined;
        if (message?.role === "assistant")
            return message.stopReason !== "stop";
    }
    return true;
}
function retentionHintsFromBranch(entries, customInstructions) {
    const hints = [];
    if (typeof customInstructions === "string" && customInstructions.trim()) {
        hints.push(`Manual compaction instructions:\n${customInstructions.trim()}`);
    }
    for (const entry of entries.slice(-2_000)) {
        if (entry.type !== "custom" || entry.customType !== RETENTION_HINT_CUSTOM_TYPE)
            continue;
        hints.push(`Primary-model retention hint:\n${stableStringify(entry.data, 2)}`);
    }
    return hints.slice(-8).join("\n\n");
}
function estimateEntryTokens(entries) {
    const blocks = parseHistoricalBlocks(entries, { includeHistoricalCompactions: false, includeMetadata: false });
    if (blocks.length > 0)
        return blocks.reduce((sum, block) => sum + block.rawTokens, 0);
    return estimateTokensFromText(entries.map((entry) => stableStringify(entry)).join("\n"));
}
function createTailTokenEstimator(entries) {
    const blocks = parseHistoricalBlocks(entries, { includeHistoricalCompactions: false, includeMetadata: false });
    if (blocks.length === 0)
        return estimateEntryTokens;
    const tokensByEntry = Array.from({ length: entries.length }, () => 0);
    for (const block of blocks)
        tokensByEntry[block.entryIndex] = (tokensByEntry[block.entryIndex] ?? 0) + block.rawTokens;
    const suffixTokens = Array.from({ length: entries.length + 1 }, () => 0);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        suffixTokens[index] = (suffixTokens[index + 1] ?? 0) + (tokensByEntry[index] ?? 0);
    }
    return (tail) => {
        const startIndex = entries.length - tail.length;
        return startIndex >= 0 && startIndex <= entries.length ? (suffixTokens[startIndex] ?? 0) : estimateEntryTokens(tail);
    };
}
export const LEGACY_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
const SEARCH_INDEX_CACHE_BYTE_LIMIT = 128 * 1024 * 1024;
export const SEARCH_INDEX_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const SEARCH_INDEX_MINIMUM_CHARGE_BYTES = 1024 * 1024;
const SEARCH_INDEX_SOURCE_CHARGE_MULTIPLIER = 8;
const LARGE_HISTORY_UNAVAILABLE = "History unavailable: this session exceeds the 64 MiB legacy-load limit. history_search and history_recall refuse it before reading session content; exact retrieval requires an existing verified source ledger.";
const INDEX_HISTORY_UNAVAILABLE = "Ranked history unavailable: this session exceeds the conservative 16 MiB search-index admission limit. Exact retrieval remains available through an existing verified source ledger.";
const pendingHistoryLoads = new Map();
async function historySourceState(path) {
    const value = await stat(path);
    if (!value.isFile())
        throw new Error("history-source-unsafe-type");
    return { deviceId: String(value.dev), inodeId: String(value.ino), size: value.size, mtimeMs: value.mtimeMs };
}
function sameHistorySource(left, right) {
    return left.deviceId === right.deviceId && left.inodeId === right.inodeId && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
async function loadSession(ctx, maximumBytes = LEGACY_HISTORY_MAX_BYTES) {
    const path = ctx.sessionManager.getSessionFile();
    if (path) {
        const before = await historySourceState(path);
        if (before.size > maximumBytes)
            throw new Error("history-source-too-large");
        const generationKey = `${before.deviceId}:${before.inodeId}:${before.size}:${before.mtimeMs}`;
        const pendingKey = `${path}\u0000${generationKey}\u0000${maximumBytes}`;
        const pending = pendingHistoryLoads.get(pendingKey);
        if (pending)
            return pending;
        const promise = (async () => {
            const loaded = await readBoundedSessionJsonl(path, maximumBytes);
            if (!sameHistorySource(before, loaded.source))
                throw new Error("history-source-changed");
            return { session: loaded.session, sessionKey: path, generationKey, sourceBytes: loaded.source.size };
        })();
        pendingHistoryLoads.set(pendingKey, promise);
        try {
            return await promise;
        }
        finally {
            if (pendingHistoryLoads.get(pendingKey) === promise)
                pendingHistoryLoads.delete(pendingKey);
        }
    }
    const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
    const session = parseBranchEntries(asEntries(entries));
    const serialized = stableStringify(session.entries);
    return { session, sessionKey: "ephemeral", generationKey: hashText(serialized), sourceBytes: Buffer.byteLength(serialized) };
}
async function historySourceWithin(ctx, maximumBytes) {
    const path = ctx.sessionManager.getSessionFile();
    if (!path)
        return true;
    return (await historySourceState(path)).size <= maximumBytes;
}
async function legacyHistoryAllowed(ctx) {
    return historySourceWithin(ctx, LEGACY_HISTORY_MAX_BYTES);
}
function toolText(text, details = {}) {
    return { content: [{ type: "text", text }], details };
}
const searchIndexes = new Map();
const pendingSearchIndexes = new Map();
let searchIndexCacheBytes = 0;
let searchIndexPendingBytes = 0;
let searchIndexBuildTail = Promise.resolve();
let searchIndexBuildCount = 0;
let searchIndexHitCount = 0;
let searchIndexCoalescedCount = 0;
export function historySearchIndexCacheStatus() {
    return { entries: searchIndexes.size, bytes: searchIndexCacheBytes, byteLimit: SEARCH_INDEX_CACHE_BYTE_LIMIT, pendingEntries: pendingSearchIndexes.size, pendingBytes: searchIndexPendingBytes, sourceMaximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES, sourceChargeMultiplier: SEARCH_INDEX_SOURCE_CHARGE_MULTIPLIER, builds: searchIndexBuildCount, hits: searchIndexHitCount, coalesced: searchIndexCoalescedCount };
}
function searchIndexCharge(sourceBytes) {
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 || sourceBytes > SEARCH_INDEX_SOURCE_MAX_BYTES)
        throw new Error("history-index-memory-limit");
    return Math.max(SEARCH_INDEX_MINIMUM_CHARGE_BYTES, sourceBytes * SEARCH_INDEX_SOURCE_CHARGE_MULTIPLIER);
}
function evictSearchIndex(sessionKey) {
    const previous = searchIndexes.get(sessionKey);
    if (!previous)
        return;
    searchIndexCacheBytes -= previous.bytes;
    searchIndexes.delete(sessionKey);
}
function reserveSearchIndexCharge(sessionKey, charge) {
    evictSearchIndex(sessionKey);
    while (searchIndexCacheBytes + searchIndexPendingBytes + charge > SEARCH_INDEX_CACHE_BYTE_LIMIT && searchIndexes.size > 0) {
        evictSearchIndex(searchIndexes.keys().next().value);
    }
    if (searchIndexCacheBytes + searchIndexPendingBytes + charge > SEARCH_INDEX_CACHE_BYTE_LIMIT)
        throw new Error("history-index-memory-limit");
    searchIndexPendingBytes += charge;
}
async function indexedSession(loaded) {
    const cached = searchIndexes.get(loaded.sessionKey);
    if (cached?.generationKey === loaded.generationKey) {
        searchIndexHitCount++;
        searchIndexes.delete(loaded.sessionKey);
        searchIndexes.set(loaded.sessionKey, cached);
        return cached.index;
    }
    const pendingKey = `${loaded.sessionKey}\u0000${loaded.generationKey}`;
    const pending = pendingSearchIndexes.get(pendingKey);
    if (pending) {
        searchIndexCoalescedCount++;
        return pending;
    }
    const charge = searchIndexCharge(loaded.sourceBytes);
    reserveSearchIndexCharge(loaded.sessionKey, charge);
    searchIndexBuildCount++;
    const prior = searchIndexBuildTail;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    searchIndexBuildTail = prior.then(() => gate);
    const promise = prior.then(() => new Promise((resolve) => setImmediate(resolve))).then(() => buildLocalSearchIndex(loaded.session));
    pendingSearchIndexes.set(pendingKey, promise);
    let charged = true;
    try {
        const built = await promise;
        searchIndexPendingBytes -= charge;
        charged = false;
        evictSearchIndex(loaded.sessionKey);
        while (searchIndexCacheBytes + charge > SEARCH_INDEX_CACHE_BYTE_LIMIT && searchIndexes.size > 0)
            evictSearchIndex(searchIndexes.keys().next().value);
        searchIndexes.set(loaded.sessionKey, { generationKey: loaded.generationKey, index: built, bytes: charge });
        searchIndexCacheBytes += charge;
        return built;
    }
    finally {
        if (pendingSearchIndexes.get(pendingKey) === promise)
            pendingSearchIndexes.delete(pendingKey);
        if (charged)
            searchIndexPendingBytes -= charge;
        release();
    }
}
function feedbackKey(ctx) {
    return ctx.sessionManager.getSessionFile() ?? undefined;
}
function updateRetrievalFeedback(store, ctx, observation) {
    const key = feedbackKey(ctx);
    if (!key)
        return;
    const previous = store.get(key) ?? emptyRetrievalFeedback(observation.generationHash);
    store.set(key, recordRetrievalFeedback(previous, observation));
    while (store.size > 8)
        store.delete(store.keys().next().value);
}
function registerHistoryTools(pi, settings, retrievalFeedback, availableLedger) {
    pi.registerTool({
        name: "history_get",
        label: "Get Exact History",
        description: "Return an exact immutable Pi JSONL entry or one exact content block, with nearby context.",
        parameters: Type.Object({
            entryId: Type.String({ description: "Pi session entry ID" }),
            blockIndex: Type.Optional(Type.Number({ minimum: 0 })),
            contextBefore: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
            contextAfter: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
            startChar: Type.Optional(Type.Number({ minimum: 0 })),
            maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 12_000 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const options = {
                blockIndex: params.blockIndex,
                contextBefore: params.contextBefore,
                contextAfter: params.contextAfter,
                startChar: params.startChar,
                maxChars: params.maxChars,
            };
            const ledger = await availableLedger(ctx);
            let text;
            if (ledger) {
                try {
                    text = await historyGetFromLedger(ledger.sessionPath, ledger.ledger, params.entryId, options);
                }
                catch {
                    if (!await legacyHistoryAllowed(ctx))
                        return toolText(LARGE_HISTORY_UNAVAILABLE, { status: "unavailable", code: "verified-source-ledger-required" });
                    text = historyGet((await loadSession(ctx)).session, params.entryId, options);
                }
            }
            else {
                if (!await legacyHistoryAllowed(ctx))
                    return toolText(LARGE_HISTORY_UNAVAILABLE, { status: "unavailable", code: "verified-source-ledger-required" });
                text = historyGet((await loadSession(ctx)).session, params.entryId, options);
            }
            return toolText(text, { entryId: params.entryId, blockIndex: params.blockIndex });
        },
    });
    pi.registerTool({
        name: "history_search",
        label: "Search History",
        description: "Search normalized immutable history with deterministic BM25, exact or regex matching, filters, fuzzy paths, diversity, and bounded exact snippets.",
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
            startMatch: Type.Optional(Type.Number({ minimum: 0, description: "Legacy exact-scan cursor" })),
            contextChars: Type.Optional(Type.Number({ minimum: 40, maximum: 200, description: "Legacy exact-scan context" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!await legacyHistoryAllowed(ctx))
                return toolText(LARGE_HISTORY_UNAVAILABLE, { status: "refused", code: "legacy-history-size-limit", maximumBytes: LEGACY_HISTORY_MAX_BYTES });
            const selectedMode = params.regex ? "regex" : params.mode;
            const indexed = settings().rankedSearchEnabled || selectedMode !== undefined;
            if (indexed && !await historySourceWithin(ctx, SEARCH_INDEX_SOURCE_MAX_BYTES))
                return toolText(INDEX_HISTORY_UNAVAILABLE, { status: "refused", code: "history-index-memory-limit", maximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES });
            let loaded;
            try {
                loaded = await loadSession(ctx, indexed ? SEARCH_INDEX_SOURCE_MAX_BYTES : LEGACY_HISTORY_MAX_BYTES);
            }
            catch (error) {
                if (error.message === "history-source-too-large")
                    return toolText(indexed ? INDEX_HISTORY_UNAVAILABLE : LARGE_HISTORY_UNAVAILABLE, { status: "refused", code: indexed ? "history-index-memory-limit" : "legacy-history-size-limit", maximumBytes: indexed ? SEARCH_INDEX_SOURCE_MAX_BYTES : LEGACY_HISTORY_MAX_BYTES });
                if (error.message === "history-source-changed")
                    return toolText("History unavailable: the source changed during bounded loading.", { status: "refused", code: "history-source-changed" });
                throw error;
            }
            if (!settings().rankedSearchEnabled && selectedMode === undefined) {
                const text = historySearch(loaded.session, params.query, {
                    limit: params.limit,
                    startMatch: params.startMatch,
                    caseSensitive: params.caseSensitive,
                    regex: params.regex,
                    contextChars: params.contextChars,
                });
                return toolText(text, { query: params.query, mode: "legacy-exact" });
            }
            let index;
            try {
                index = await indexedSession(loaded);
            }
            catch (error) {
                if (error.message === "history-index-memory-limit")
                    return toolText(INDEX_HISTORY_UNAVAILABLE, { status: "refused", code: "history-index-memory-limit", maximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES });
                throw error;
            }
            const result = searchLocalHistory(index, params.query, {
                mode: selectedMode,
                stage: params.stage,
                limit: params.limit,
                tokenBudget: params.tokenBudget,
                cursor: params.cursor,
                caseSensitive: params.caseSensitive,
                fuzzyPath: params.fuzzyPath,
                includeNeighbors: params.includeNeighbors,
                filters: {
                    ...(params.kind === undefined ? {} : { kinds: [params.kind] }),
                    ...(params.toolName === undefined ? {} : { toolNames: [params.toolName] }),
                    ...(params.error === undefined ? {} : { error: params.error }),
                    ...(params.unresolved === undefined ? {} : { unresolved: params.unresolved }),
                    ...(params.currentState === undefined ? {} : { currentState: params.currentState }),
                },
            });
            updateRetrievalFeedback(retrievalFeedback, ctx, {
                generationHash: result.generationHash,
                query: params.query,
                resultCount: result.hits.filter((hit) => !hit.context).length,
                retrievedTokens: result.returnedTokens,
                resourceKeys: result.hits.flatMap((hit) => hit.resourceKey ? [hit.resourceKey] : []),
                blockIds: result.hits.flatMap((hit) => {
                    const blockId = index.documentByKey.get(hit.key)?.block.id;
                    return blockId ? [blockId] : [];
                }),
            });
            return toolText(renderRankedSearch(result), { query: params.query, mode: result.mode, generationHash: result.generationHash, hits: result.hits.length, tokenBudget: result.tokenBudget, returnedTokens: result.returnedTokens });
        },
    });
    pi.registerTool({
        name: "history_recall",
        label: "Expand Historical Memory",
        description: "Recall history in stages: compact cue, episode, resource evolution, or source block snippet. Exact bytes remain in history_get and history_range.",
        parameters: Type.Object({
            query: Type.String(),
            level: Type.Optional(Type.Union([Type.Literal("cue"), Type.Literal("episode"), Type.Literal("resource"), Type.Literal("block")])),
            limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
            tokenBudget: Type.Optional(Type.Number({ minimum: 120, maximum: 2_000 })),
        }),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            if (!await legacyHistoryAllowed(ctx))
                return toolText(LARGE_HISTORY_UNAVAILABLE, { status: "refused", code: "legacy-history-size-limit", maximumBytes: LEGACY_HISTORY_MAX_BYTES });
            if (!await historySourceWithin(ctx, SEARCH_INDEX_SOURCE_MAX_BYTES))
                return toolText(INDEX_HISTORY_UNAVAILABLE, { status: "refused", code: "history-index-memory-limit", maximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES });
            let loaded;
            try {
                loaded = await loadSession(ctx, SEARCH_INDEX_SOURCE_MAX_BYTES);
            }
            catch (error) {
                if (error.message === "history-source-too-large")
                    return toolText(INDEX_HISTORY_UNAVAILABLE, { status: "refused", code: "history-index-memory-limit", maximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES });
                if (error.message === "history-source-changed")
                    return toolText("History unavailable: the source changed during bounded loading.", { status: "refused", code: "history-source-changed" });
                throw error;
            }
            let index;
            try {
                index = await indexedSession(loaded);
            }
            catch (error) {
                if (error.message === "history-index-memory-limit")
                    return toolText(INDEX_HISTORY_UNAVAILABLE, { status: "refused", code: "history-index-memory-limit", maximumBytes: SEARCH_INDEX_SOURCE_MAX_BYTES });
                throw error;
            }
            const model = buildCausalMemory(index.documents.map((document) => document.block), index.resourceLineage);
            const result = recallHistory(index, model, params.query, { level: params.level, limit: params.limit, tokenBudget: params.tokenBudget });
            const recalledKeys = result.items.flatMap((item) => item.sourceIds);
            const recalledDocuments = index.documents
                .filter((document) => recalledKeys.includes(document.key) || recalledKeys.includes(document.block.entryId));
            const recalledResources = recalledDocuments.flatMap((document) => document.resourceKey ? [document.resourceKey] : []);
            updateRetrievalFeedback(retrievalFeedback, ctx, {
                generationHash: result.generationHash,
                query: params.query,
                resultCount: result.items.length,
                retrievedTokens: result.renderedTokens,
                expandedItems: result.items.length,
                resourceKeys: recalledResources,
                blockIds: recalledDocuments.map((document) => document.block.id),
            });
            let promotedMemories = 0;
            let promotionWarning;
            if (settings().editableMemoryEnabled && ctx.sessionManager.getSessionFile()) {
                try {
                    const path = memoryPathForContext(ctx);
                    const memory = await readMemoryEvents(path);
                    if (memory.status !== "ready")
                        throw new Error(memory.error ?? "memory integrity failure");
                    const turn = asEntries(ctx.sessionManager.getBranch()).length;
                    const recalledMemories = searchMemories(memory, params.query, { includeDemoted: true, limit: 3 })
                        .filter((candidate) => !candidate.protected && candidate.state !== "superseded");
                    for (const recalled of recalledMemories) {
                        const updated = await appendMemoryEvent(path, {
                            action: recalled.state === "demoted" ? "promote" : "touch",
                            memoryId: recalled.memoryId,
                            timestamp: new Date().toISOString(),
                            turn,
                            sourceRef: `history-recall:${toolCallId}`,
                            reason: `history_recall matched query ${params.query}`,
                        });
                        const event = updated.events[updated.events.length - 1];
                        pi.appendEntry("chrono-memory-v2-event", event);
                        promotedMemories += 1;
                    }
                }
                catch (error) {
                    promotionWarning = safeErrorMessage(error);
                }
            }
            return toolText(renderRecall(result), {
                query: params.query,
                level: result.level,
                generationHash: result.generationHash,
                items: result.items.length,
                tokenBudget: result.tokenBudget,
                renderedTokens: result.renderedTokens,
                promotedMemories,
                ...(promotionWarning === undefined ? {} : { promotionWarning }),
            });
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
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const options = { maxEntries: params.maxEntries };
            const ledger = await availableLedger(ctx);
            let text;
            if (ledger) {
                try {
                    text = await historyRangeFromLedger(ledger.sessionPath, ledger.ledger, params.startEntryId, params.endEntryId, options);
                }
                catch {
                    if (!await legacyHistoryAllowed(ctx))
                        return toolText(LARGE_HISTORY_UNAVAILABLE, { status: "unavailable", code: "verified-source-ledger-required" });
                    text = historyRange((await loadSession(ctx)).session, params.startEntryId, params.endEntryId, options);
                }
            }
            else {
                if (!await legacyHistoryAllowed(ctx))
                    return toolText(LARGE_HISTORY_UNAVAILABLE, { status: "unavailable", code: "verified-source-ledger-required" });
                text = historyRange((await loadSession(ctx)).session, params.startEntryId, params.endEntryId, options);
            }
            return toolText(text, { startEntryId: params.startEntryId, endEntryId: params.endEntryId });
        },
    });
}
function memoryPathForContext(ctx) {
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath)
        throw new Error("Editable memory requires a persisted session file.");
    return memorySidecarPath(sessionPath);
}
function renderMemoryList(memories) {
    if (memories.length === 0)
        return "No matching remembered knowledge.";
    return [
        `Remembered knowledge: ${memories.length}`,
        ...memories.map((memory) => `- ${memory.memoryId} · ${memory.state} · ${memory.scope} · ${memory.authority} · used ${memory.useCount}\n  ${memory.text}\n  Source: ${memory.sourceRef}`),
    ].join("\n");
}
function registerMemoryTools(pi, settings) {
    const append = async (toolCallId, ctx, input) => {
        if (!settings().editableMemoryEnabled)
            throw new Error("Editable memory is disabled in ChronoCompact settings.");
        const turn = asEntries(ctx.sessionManager.getBranch()).length;
        const result = await appendMemoryEvent(memoryPathForContext(ctx), {
            ...input,
            timestamp: new Date().toISOString(),
            turn,
            sourceRef: `memory-tool:${toolCallId}`,
            authority: "ordinary",
        });
        const event = result.events[result.events.length - 1];
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
            if (result.status !== "ready")
                throw new Error(`Memory store is unavailable: ${result.error ?? "integrity failure"}`);
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
            if (result.status !== "ready")
                throw new Error(`Memory store is unavailable: ${result.error ?? "integrity failure"}`);
            const memory = result.memories.find((candidate) => candidate.memoryId === params.memoryId);
            if (!memory)
                throw new Error(`Unknown memory: ${params.memoryId}`);
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
            if (result.status !== "ready")
                throw new Error(`Memory store is unavailable: ${result.error ?? "integrity failure"}`);
            const memories = searchMemories(result, params.query, { scope: params.scope, includeDemoted: params.includeDemoted, limit: params.limit });
            return toolText(renderMemoryList(memories), { query: params.query, count: memories.length, generationHash: result.generationHash });
        },
    });
}
function registerRetentionHintTool(pi) {
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
            return toolText("Recorded an advisory retention hint for the next ChronoCompact generation. The immutable session JSONL remains authoritative.", { recorded: true });
        },
    });
}
export default function chronoCompactExtension(pi) {
    const userConfigPath = defaultUserConfigPath();
    const loadedUserConfig = loadUserConfig(userConfigPath);
    let userConfig = loadedUserConfig.config;
    let userConfigWarning = loadedUserConfig.warning;
    const retrievalFeedback = new Map();
    let triggerPending = false;
    let lastTriggerAttemptTokens;
    let forcedCompactionReason;
    let forcedContinuationPending = false;
    let continueAfterSuccessfulCompaction = false;
    let warningLevel = 0;
    let incrementalStore;
    let historyLedger;
    let incrementalAbort;
    let incrementalTimer;
    let incrementalGeneration = 0;
    let incrementalStatus = { state: "disabled" };
    let shadowAbort;
    let shadowTimer;
    let shadowGeneration = 0;
    let shadowStatus = { state: "disabled" };
    let valueWorkerAbort;
    let valueWorkerStatus = { status: "off" };
    let valueWorkerActive = false;
    let valueWorkerRerun = false;
    let valueWorkerCompactionGate = false;
    let legacyHistoryEditorWarningShown = false;
    let legacyPiSummaryWarningShown = false;
    let projectionSeenToolCallIds = new Set();
    let lastProjectionMetrics;
    let replayWorkerStatus = { state: "idle" };
    const availableHistoryLedger = async (ctx) => {
        const sessionPath = ctx.sessionManager.getSessionFile();
        if (!sessionPath) {
            historyLedger = undefined;
            return undefined;
        }
        const sidecar = sourceLedgerPath(sessionPath);
        if (await sourceLedgerIsBusy(sidecar))
            return undefined;
        const candidateLedger = incrementalStore?.sessionPath === sessionPath ? incrementalStore.ledger : undefined;
        if (candidateLedger && await sourceLedgerMatchesSource(sessionPath, candidateLedger))
            return historyLedger = { sessionPath, ledger: candidateLedger };
        if (historyLedger?.sessionPath === sessionPath && await sourceLedgerMatchesSource(sessionPath, historyLedger.ledger))
            return historyLedger;
        try {
            const ledger = await loadSourceLedger(sessionPath, sidecar);
            if (!await sourceLedgerMatchesSource(sessionPath, ledger))
                return undefined;
            return historyLedger = { sessionPath, ledger };
        }
        catch {
            return undefined;
        }
    };
    registerHistoryTools(pi, () => resolveExtensionSettings(userConfig), retrievalFeedback, availableHistoryLedger);
    registerMemoryTools(pi, () => resolveExtensionSettings(userConfig));
    registerRetentionHintTool(pi);
    const incrementalConfig = (settings) => resolveCompactorConfig({
        ...settings.config,
        targetTokens: 4_000,
        minSummaryTokens: settings.minSummaryTokens,
        maxSummaryTokens: settings.maxSummaryTokens,
        enableSemanticCompression: false,
    });
    const cancelIncrementalWork = (clearCheckpoint) => {
        incrementalGeneration += 1;
        if (incrementalTimer)
            clearTimeout(incrementalTimer);
        incrementalTimer = undefined;
        incrementalAbort?.abort(new Error("ChronoCompact incremental work was cancelled for session state replacement."));
        incrementalAbort = undefined;
        if (clearCheckpoint)
            incrementalStore = undefined;
    };
    const cancelValueWorker = () => {
        valueWorkerRerun = false;
        valueWorkerAbort?.abort(new Error("Value worker cancelled for session state replacement."));
        valueWorkerAbort = undefined;
    };
    const scheduleValueWorker = (ctx, store) => {
        const settings = resolveExtensionSettings(userConfig);
        if (valueWorkerCompactionGate) {
            valueWorkerStatus = { status: "paused-for-compaction" };
            return;
        }
        if (settings.valueWorker.mode === "off") {
            cancelValueWorker();
            valueWorkerStatus = { status: "off" };
            return;
        }
        if (!settings.incrementalPrecomputeEnabled) {
            valueWorkerStatus = { status: "candidate-store-required" };
            return;
        }
        if (valueWorkerActive) {
            valueWorkerRerun = true;
            return;
        }
        valueWorkerActive = true;
        valueWorkerStatus = { status: "scheduled" };
        const controller = new AbortController();
        valueWorkerAbort = controller;
        queueMicrotask(() => {
            if (valueWorkerCompactionGate || controller.signal.aborted) {
                valueWorkerActive = false;
                if (valueWorkerAbort === controller)
                    valueWorkerAbort = undefined;
                return;
            }
            void runValueWorker({ ctx, settings: settings.valueWorker, store, signal: controller.signal }).then((result) => { valueWorkerStatus = result; }).catch(() => { if (!controller.signal.aborted)
                valueWorkerStatus = { status: "unknown-value-worker-failure" }; }).finally(() => { valueWorkerActive = false; if (valueWorkerAbort === controller)
                valueWorkerAbort = undefined; if (valueWorkerRerun && !controller.signal.aborted && !valueWorkerCompactionGate) {
                valueWorkerRerun = false;
                scheduleValueWorker(ctx, store);
            } });
        });
    };
    const scheduleIncrementalWork = (ctx) => {
        const settings = resolveExtensionSettings(userConfig);
        if (!settings.incrementalPrecomputeEnabled) {
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
                    if (!store.manifest)
                        await loadCandidateSegmentManifest(store);
                    if (settings.isolatedWorkerEnabled) {
                        const request = { schemaVersion: 1, jobId: randomUUID(), jobType: "candidate-store-update", sessionPath,
                            expectedSource: await workerSourceExpectation(sessionPath), deadlineMs: Date.now() + settings.workerTimeoutSeconds * 1_000,
                            niceLevel: settings.workerNiceLevel, config };
                        const worker = await runCompactionWorker(request, { slots: settings.hostWorkerSlots, workerTimeoutMs: settings.workerTimeoutSeconds * 1_000,
                            schedulerTimeoutMs: settings.workerTimeoutSeconds * 1_000, signal: controller.signal, priority: "low" });
                        if (controller.signal.aborted || generation !== incrementalGeneration)
                            return;
                        if (worker.response.status !== "ok" || !worker.response.candidateUpdate) {
                            incrementalStatus = { state: "fallback", failureCode: worker.response.status === "failed" ? worker.response.failureCode : "worker-protocol-error", worker: worker.clientMetrics };
                            return;
                        }
                        await loadCandidateSegmentManifest(store);
                        incrementalStore = store;
                        incrementalStatus = { state: "ready", ...worker.response.candidateUpdate, worker: worker.clientMetrics, workerRuntime: worker.response.metrics };
                        scheduleValueWorker(ctx, store);
                    }
                    else {
                        const metrics = await updateCandidateSegmentStore(store, config, { signal: controller.signal });
                        if (controller.signal.aborted || generation !== incrementalGeneration)
                            return;
                        incrementalStore = store;
                        incrementalStatus = { state: "ready", ...metrics };
                        scheduleValueWorker(ctx, store);
                    }
                }
                catch (error) {
                    if (!controller.signal.aborted)
                        incrementalStatus = { state: "fallback", reason: safeErrorMessage(error) };
                }
                finally {
                    if (incrementalAbort === controller)
                        incrementalAbort = undefined;
                }
            })();
        }, 35);
    };
    const cancelShadowWork = () => {
        shadowGeneration += 1;
        if (shadowTimer)
            clearTimeout(shadowTimer);
        shadowTimer = undefined;
        shadowAbort?.abort(new Error("ChronoCompact shadow work was cancelled for session state replacement."));
        shadowAbort = undefined;
    };
    const scheduleRollupShadow = (input) => {
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
                    const request = {
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
                        slots: input.settings.hostWorkerSlots,
                        workerTimeoutMs: input.settings.workerTimeoutSeconds * 1_000,
                        schedulerTimeoutMs: input.settings.workerTimeoutSeconds * 1_000,
                        signal: controller.signal,
                        priority: "low",
                    });
                    if (controller.signal.aborted || generation !== shadowGeneration)
                        return;
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
                }
                catch (error) {
                    if (!controller.signal.aborted)
                        shadowStatus = { state: "failed", reason: safeErrorMessage(error) };
                }
                finally {
                    if (shadowAbort === controller)
                        shadowAbort = undefined;
                }
            })();
        }, 0);
    };
    const launchCompaction = (ctx, reason, currentTokens, resumeAfter = false) => {
        if (triggerPending)
            return;
        triggerPending = true;
        forcedContinuationPending = resumeAfter;
        if (currentTokens !== undefined)
            lastTriggerAttemptTokens = currentTokens;
        if (ctx.hasUI)
            ctx.ui.notify(`ChronoCompact trigger: ${reason}.`, "info");
        ctx.compact({
            customInstructions: `ChronoCompact trigger: ${reason}. Preserve direct user restrictions, decisive failures, and unresolved work.`,
            onComplete: () => {
                triggerPending = false;
            },
            onError: (error) => {
                triggerPending = false;
                forcedContinuationPending = false;
                continueAfterSuccessfulCompaction = false;
                if (ctx.hasUI)
                    ctx.ui.notify(`ChronoCompact request failed: ${error.message}`, "warning");
            },
        });
    };
    pi.registerTool({
        name: "request_compaction",
        label: "Request Context Compaction",
        description: "Request ChronoCompact at a natural work boundary. Use when context warnings appear or when the current atomic operation is complete; record any important retention hint first.",
        parameters: Type.Object({}),
        async execute() {
            forcedCompactionReason = "the model requested compaction at a natural boundary";
            return toolText("Compaction is scheduled for the end of this turn. Do not begin another operation.", { scheduled: true });
        },
    });
    pi.on("context", async (event, ctx) => {
        const settings = resolveExtensionSettings(userConfig);
        if (settings.toolResultProjectionMode === "off")
            return undefined;
        try {
            const branchEntries = asEntries(ctx.sessionManager.getBranch());
            const result = await projectToolResultContext(event.messages, {
                mode: settings.toolResultProjectionMode,
                seenToolCallIds: projectionSeenToolCallIds,
                sourceByToolCallId: projectionSourcesFromBranch(branchEntries),
            });
            projectionSeenToolCallIds = new Set([...projectionSeenToolCallIds, ...result.newlySeenToolCallIds]);
            lastProjectionMetrics = result.metrics;
            if (result.metrics.projectedToolResults === 0)
                return undefined;
            return { messages: result.messages };
        }
        catch (error) {
            lastProjectionMetrics = {
                mode: settings.toolResultProjectionMode,
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
    });
    pi.on("session_start", (_event, ctx) => {
        cancelIncrementalWork(true);
        cancelShadowWork();
        cancelValueWorker();
        historyLedger = undefined;
        projectionSeenToolCallIds = new Set();
        lastProjectionMetrics = undefined;
        const settings = resolveExtensionSettings(userConfig);
        if (settings.legacyHistoryEditorEnabled && !legacyHistoryEditorWarningShown && ctx.hasUI) {
            legacyHistoryEditorWarningShown = true;
            ctx.ui.notify("The old ChronoCompact history-classifier setting is retired and cannot start a model call. Use the background value-worker settings for explicit opt-in.", "warning");
        }
        if (settings.legacyPiSummaryDisabled && !legacyPiSummaryWarningShown && ctx.hasUI) {
            legacyPiSummaryWarningShown = true;
            ctx.ui.notify("PI_CHRONO_PI_SUMMARY=false is retired. The required regular Pi summary remains active; no configuration was changed.", "warning");
        }
        scheduleIncrementalWork(ctx);
    });
    pi.on("session_before_switch", () => {
        cancelIncrementalWork(true);
        cancelShadowWork();
        cancelValueWorker();
        historyLedger = undefined;
        projectionSeenToolCallIds = new Set();
    });
    pi.on("session_before_fork", () => {
        cancelIncrementalWork(true);
        cancelShadowWork();
        cancelValueWorker();
        historyLedger = undefined;
        projectionSeenToolCallIds = new Set();
    });
    pi.on("session_shutdown", () => {
        cancelIncrementalWork(true);
        cancelShadowWork();
        cancelValueWorker();
        historyLedger = undefined;
        projectionSeenToolCallIds = new Set();
    });
    pi.on("turn_end", (event, ctx) => {
        const usage = ctx.getContextUsage();
        const reportedTokens = event.message.role === "assistant" ? (event.message.usage?.totalTokens ?? 0) : 0;
        const currentTokens = Math.max(usage?.tokens ?? 0, reportedTokens);
        const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = contextWindow > 0 ? (currentTokens / contextWindow) * 100 : 0;
        if (forcedCompactionReason) {
            if (!ctx.isIdle())
                ctx.abort();
            return;
        }
        if (percent >= CONTEXT_CIRCUIT_BREAKER_PERCENT) {
            forcedCompactionReason = `the ${CONTEXT_CIRCUIT_BREAKER_PERCENT}% turn-boundary circuit breaker activated`;
            if (ctx.hasUI)
                ctx.ui.notify(`ChronoCompact circuit breaker at ${percent.toFixed(1)}%; stopping the autonomous run before compaction.`, "warning");
            if (!ctx.isIdle())
                ctx.abort();
            return;
        }
        const nextWarningLevel = percent >= CONTEXT_URGENT_PERCENT ? 2 : percent >= CONTEXT_WARNING_PERCENT ? 1 : 0;
        if (nextWarningLevel <= warningLevel)
            return;
        warningLevel = nextWarningLevel;
        const content = nextWarningLevel === 2
            ? `Context is ${percent.toFixed(1)}% full. Compaction is approaching. Finish the current atomic operation, preserve unresolved state, and call request_compaction at the next safe boundary. Do not begin broad new work.`
            : `Context is ${percent.toFixed(1)}% full. At the next natural checkpoint, consider preserving unresolved state and calling request_compaction. Continue the current atomic operation if interruption would be unsafe.`;
        pi.sendMessage({ customType: CONTEXT_WARNING_CUSTOM_TYPE, content, display: false }, { deliverAs: "steer" });
    });
    pi.on("agent_settled", (_event, ctx) => {
        scheduleIncrementalWork(ctx);
        const usage = ctx.getContextUsage();
        if (forcedCompactionReason) {
            const reason = forcedCompactionReason;
            forcedCompactionReason = undefined;
            launchCompaction(ctx, reason, usage?.tokens ?? undefined, true);
            return;
        }
        const settings = resolveExtensionSettings(userConfig);
        if (!usage || usage.tokens === null)
            return;
        const decision = decideCompactionTrigger({
            currentTokens: usage.tokens,
            thresholdTokens: settings.triggerThresholdTokens,
            minimumGrowthTokens: settings.triggerMinimumGrowthTokens,
            lastAttemptTokens: lastTriggerAttemptTokens,
            pending: triggerPending,
        });
        if (!decision.trigger)
            return;
        launchCompaction(ctx, decision.reason, usage.tokens);
    });
    pi.on("session_compact", (event) => {
        valueWorkerCompactionGate = false;
        cancelIncrementalWork(true);
        projectionSeenToolCallIds = new Set();
        const shouldContinue = continueAfterSuccessfulCompaction && !event.willRetry;
        triggerPending = false;
        forcedCompactionReason = undefined;
        forcedContinuationPending = false;
        continueAfterSuccessfulCompaction = false;
        warningLevel = 0;
        if (shouldContinue) {
            pi.sendMessage({
                customType: CONTEXT_RESUME_CUSTOM_TYPE,
                content: "Compaction completed. Continue the unresolved task from the preserved state. Do not stop merely to report that compaction occurred.",
                display: false,
            }, { triggerTurn: true });
        }
    });
    pi.on("session_before_compact", async (event, ctx) => {
        valueWorkerCompactionGate = true;
        cancelValueWorker();
        cancelIncrementalWork(false);
        const settings = resolveExtensionSettings(userConfig);
        try {
            const branchEntries = asEntries(event.branchEntries);
            continueAfterSuccessfulCompaction =
                !event.willRetry && (forcedContinuationPending || hasUnresolvedTurn(branchEntries));
            const preparedFirstKeptEntryId = event.preparation?.firstKeptEntryId;
            const tokensBefore = event.preparation?.tokensBefore;
            if (typeof preparedFirstKeptEntryId !== "string" || typeof tokensBefore !== "number") {
                throw new Error("Pi compaction preparation omitted firstKeptEntryId or tokensBefore.");
            }
            const preparedCutIndex = branchEntries.findIndex((entry) => entry.id === preparedFirstKeptEntryId);
            if (preparedCutIndex < 0)
                throw new Error(`Pi prepared cut entry ${preparedFirstKeptEntryId} was not present on the active branch.`);
            const estimateTailTokens = createTailTokenEstimator(branchEntries);
            const preparedTailTokens = estimateTailTokens(branchEntries.slice(preparedCutIndex));
            let tailSelection = {
                mode: "pi",
                actualTokens: preparedTailTokens,
                firstKeptEntryId: preparedFirstKeptEntryId,
                cutIndex: preparedCutIndex,
                reason: "used Pi's prepared keepRecentTokens cut point",
            };
            if (settings.rawTailMode === "dynamic") {
                const selected = selectDynamicRawTail(branchEntries, settings.dynamicRawTailMinTokens, settings.dynamicRawTailMaxTokens, estimateTailTokens);
                if (selected)
                    tailSelection = selected;
            }
            else if (settings.rawTailTokens !== undefined) {
                const selected = selectRawTail(branchEntries, settings.rawTailTokens, estimateTailTokens);
                if (selected)
                    tailSelection = { ...selected, mode: settings.rawTailMode };
            }
            if (tailSelection.actualTokens > MAX_RAW_TAIL_WITH_HISTORY_TOKENS) {
                const bounded = selectRawTailWithinMaximum(branchEntries, MAX_RAW_TAIL_WITH_HISTORY_TOKENS, estimateTailTokens);
                if (!bounded)
                    throw new Error("No valid raw-tail cut can satisfy the 30,000-token combined ceiling.");
                tailSelection = { ...bounded, mode: tailSelection.mode };
            }
            if (!isSafeCompactionCut(branchEntries, tailSelection.cutIndex)) {
                const repaired = selectRawTailWithinMaximum(branchEntries, Math.min(MAX_RAW_TAIL_WITH_HISTORY_TOKENS, tailSelection.actualTokens), estimateTailTokens);
                if (!repaired)
                    throw new Error("No raw-tail cut can exclude an orphan function output.");
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
            const historicalCeilingTokens = HARD_COMBINED_CONTEXT_CAP_TOKENS - retainedTailTokens;
            const targetTokens = Math.min(historicalCeilingTokens, selectReplayTarget({
                derivedTargetTokens,
                fixedTargetTokens: settings.replayTargetTokens,
                maximumTokens: settings.maxSummaryTokens,
            }));
            if (targetTokens < 256)
                throw new Error("The retained raw tail leaves no safe historical-context budget.");
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
            const memory = settings.editableMemoryEnabled && sessionPath
                ? await readMemoryEvents(memorySidecarPath(sessionPath))
                : undefined;
            if (memory?.status === "corrupt-rebuild-required" && ctx.hasUI) {
                ctx.ui.notify(`ChronoCompact ignored corrupt editable memory and continued from immutable history: ${memory.error ?? "integrity failure"}`, "warning");
            }
            const pinnedMemoryText = memory?.status === "ready" ? renderPinnedMemory(memory.memories, branchEntries.length) : "";
            const previousPiSummary = previousRegularPiSummary(branchEntries, event.preparation.previousSummary);
            const summaryRebase = decideRegularSummaryRebase(branchEntries, previousPiSummary, { intervalGenerations: settings.summaryRebaseInterval });
            let generationHash = useIsolatedWorker
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
                hardCombinedContextCapTokens: HARD_COMBINED_CONTEXT_CAP_TOKENS,
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
                if (cached && cached.sourceHash === generationHash &&
                    cached.configHash === configHash &&
                    cached.renderedTokens + retainedTailTokens <= HARD_COMBINED_CONTEXT_CAP_TOKENS) {
                    ctx.ui.notify(`ChronoCompact reused generation ${cached.generation}: ${cached.rawTokens.toLocaleString()}→${cached.renderedTokens.toLocaleString()} estimated tokens.`, "info");
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
                                cache: { hit: true, generation: cached.generation, sourceHash: generationHash },
                                ...(cached.piSummary === undefined ? {} : { piSummary: cached.piSummary }),
                                retainedTail: tailSelection,
                                replayTargetMode: settings.replayTargetTokens === undefined ? "derived-active-context" : "fixed",
                                targetActiveContextTokens: settings.targetContextTokens,
                                layers: {
                                    regularPiSummaryTokens: cached.piSummary ? estimateTokensFromText(cached.piSummary) : 0,
                                    chronoHistoryTokens: cached.details.renderedTokens,
                                    rawTailTokens: retainedTailTokens,
                                    combinedContextTokens: cached.renderedTokens + retainedTailTokens,
                                    hardCeilingTokens: HARD_COMBINED_CONTEXT_CAP_TOKENS,
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
            let piSummary;
            try {
                const piSummaryTargetTokens = Math.min(settings.hybridSummaryTargetTokens, Math.max(512, targetTokens - 512));
                piSummary = await createPiRegularSummary(ctx, event.preparation, {
                    targetTokens: piSummaryTargetTokens,
                    customInstructions: event.customInstructions,
                    signal: event.signal,
                    ...(summaryRebase.rebase ? {} : { previousSummary: previousPiSummary }),
                    messages: regularSummaryMessagesForCut(branchEntries, firstKeptEntryId, summaryRebase.rebase),
                });
                if (piSummary && piSummary.tokens > piSummaryTargetTokens) {
                    const text = truncateToTokens(piSummary.text, piSummaryTargetTokens, "\n\n[Regular Pi summary deterministically bounded for the 30,000-token combined ceiling.]");
                    piSummary = { ...piSummary, text, tokens: estimateTokensFromText(text) };
                }
                if (!piSummary && ctx.hasUI) {
                    ctx.ui.notify("Regular Pi hybrid summary was unavailable; deterministic replay will be used alone.", "warning");
                }
            }
            catch (hybridError) {
                if (!event.signal?.aborted && ctx.hasUI) {
                    ctx.ui.notify(`Regular Pi summary failed; deterministic replay will continue in degraded mode: ${safeErrorMessage(hybridError)}`, "warning");
                }
            }
            const hybridWrapperTokens = piSummary
                ? estimateTokensFromText(renderHybridCompaction(piSummary.text, "")) - piSummary.tokens
                : 0;
            const replayCeilingTokens = Math.max(128, historicalCeilingTokens - (piSummary?.tokens ?? 0) - Math.max(0, hybridWrapperTokens));
            const replayTargetTokens = Math.min(replayCeilingTokens, piSummary
                ? Math.max(256, targetTokens - piSummary.tokens - Math.max(0, hybridWrapperTokens))
                : targetTokens);
            const replayConfig = resolveCompactorConfig({ ...config, targetTokens: replayTargetTokens });
            let precomputedCandidates;
            let officialIncremental = { state: "disabled" };
            if (!useIsolatedWorker && settings.incrementalPrecomputeEnabled && sessionPath) {
                try {
                    const store = incrementalStore?.sessionPath === sessionPath ? incrementalStore : createCandidateSegmentStore(sessionPath);
                    incrementalStore = store;
                    if (!store.manifest)
                        await loadCandidateSegmentManifest(store);
                    if (!store.ledger && store.manifest)
                        store.ledger = await loadSourceLedger(sessionPath, store.ledgerPath);
                    const branchIds = sourceEntries.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
                    const candidates = await loadCandidateRecordsForBranch(store, branchIds);
                    if (candidates.size > 0)
                        precomputedCandidates = candidates;
                    officialIncremental = { state: candidates.size > 0 ? "validated-hit" : "stale-fallback", cachedCandidates: candidates.size,
                        background: incrementalStatus, metrics: store.metrics };
                }
                catch (error) {
                    officialIncremental = { state: "stale-fallback", reason: safeErrorMessage(error), background: incrementalStatus };
                }
            }
            const validAdviceRecordHashes = precomputedCandidates ? new Map([...precomputedCandidates].map(([blockId, record]) => [blockId, record.integrityHash])) : undefined;
            const valueAdvice = sessionPath ? await loadCompatibleAdvice(sessionPath, settings.valueWorker, validAdviceRecordHashes) : new Map();
            let result;
            let workerExecution;
            if (useIsolatedWorker && sessionPath) {
                const leafId = branchEntries.at(-1)?.id;
                if (typeof leafId !== "string")
                    throw new Error("Isolated worker failed: branch-not-persisted");
                const request = { schemaVersion: 1, jobId: randomUUID(), jobType: "replay-compaction", sessionPath,
                    expectedSource: await workerSourceExpectation(sessionPath), deadlineMs: Date.now() + settings.workerTimeoutSeconds * 1_000,
                    niceLevel: settings.workerNiceLevel, branchLeafId: leafId, firstKeptEntryId, config: replayConfig,
                    hardOutputTokens: replayCeilingTokens, retentionHints, pinnedMemoryText,
                    ...(currentRetrievalFeedback === undefined ? {} : { retrievalFeedback: currentRetrievalFeedback }),
                    candidateStoreEnabled: settings.incrementalPrecomputeEnabled, cacheEnabled: settings.cacheEnabled,
                    valueWorkerMode: settings.valueWorker.mode, valueWorkerConfigurationHash: valueWorkerConfigurationHash(settings.valueWorker) };
                replayWorkerStatus = { state: "running", jobId: request.jobId, startedAt: new Date().toISOString() };
                workerExecution = await runCompactionWorker(request, { slots: settings.hostWorkerSlots,
                    workerTimeoutMs: settings.workerTimeoutSeconds * 1_000, schedulerTimeoutMs: settings.workerTimeoutSeconds * 1_000,
                    signal: event.signal, priority: "high" });
                replayWorkerStatus = { state: workerExecution.response.status, jobId: request.jobId,
                    ...(workerExecution.response.status === "failed" ? { failureCode: workerExecution.response.failureCode } : {}),
                    totalWallMs: workerExecution.clientMetrics.workerTotalWallMs, responseBytes: workerExecution.clientMetrics.responseBytes };
                if (workerExecution.response.status !== "ok" || !workerExecution.response.replay) {
                    const code = workerExecution.response.status === "failed" ? workerExecution.response.failureCode : "worker-protocol-error";
                    throw new Error(`Isolated worker failed: ${code}`);
                }
                const replay = workerExecution.response.replay;
                generationHash = replay.generationHash;
                result = { summary: replay.summary, rawTokens: replay.rawTokens, renderedTokens: replay.renderedTokens,
                    targetTokens: replay.targetTokens, validation: replay.validation,
                    plan: { targetTokens: replay.targetTokens, estimatedTokens: replay.renderedTokens, rawTokens: replay.rawTokens, units: [], warnings: [] },
                    details: replay.details };
                officialIncremental = settings.incrementalPrecomputeEnabled
                    ? { state: "worker-snapshot", background: incrementalStatus, cacheState: workerExecution.response.metrics.cacheState }
                    : { state: "disabled" };
            }
            else {
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
            if (combinedContextTokens > HARD_COMBINED_CONTEXT_CAP_TOKENS) {
                throw new Error(`Combined context ${combinedContextTokens} exceeds the hard ${HARD_COMBINED_CONTEXT_CAP_TOKENS}-token ceiling.`);
            }
            let generation;
            if (!useIsolatedWorker && settings.cacheEnabled && settings.valueWorker.mode !== "advisory" && cachePath) {
                try {
                    generation = await nextCacheGeneration(cachePath);
                    await writeCompactionCache(cachePath, {
                        schemaVersion: 4,
                        generation,
                        sourceHash: generationHash,
                        configHash,
                        summary: combinedSummary,
                        ...(piSummary === undefined ? {} : { piSummary: piSummary.text }),
                        rawTokens: result.rawTokens,
                        renderedTokens: combinedTokens,
                        targetTokens,
                        details: result.details,
                        createdAt: new Date().toISOString(),
                    });
                }
                catch (cacheError) {
                    ctx.ui.notify(`ChronoCompact cache write failed: ${safeErrorMessage(cacheError)}`, "warning");
                }
            }
            ctx.ui.notify(`ChronoCompact 2.0.2 candidate: ${result.rawTokens.toLocaleString()}→${combinedTokens.toLocaleString()} historical tokens; ${combinedContextTokens.toLocaleString()}/${HARD_COMBINED_CONTEXT_CAP_TOKENS.toLocaleString()} combined; background value worker ${settings.valueWorker.mode}; compaction model jobs 0.`, "info");
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
                        cache: { hit: useIsolatedWorker ? workerExecution?.response.metrics.cacheState === "hit" : false, generation, sourceHash: generationHash },
                        retainedTail: tailSelection,
                        retainedTailTokens,
                        replayTargetMode: settings.replayTargetTokens === undefined ? "derived-active-context" : "fixed",
                        targetActiveContextTokens: settings.targetContextTokens,
                        layers: {
                            regularPiSummaryTokens: piSummary?.tokens ?? 0,
                            chronoHistoryTokens: result.renderedTokens,
                            rawTailTokens: retainedTailTokens,
                            combinedContextTokens,
                            hardCeilingTokens: HARD_COMBINED_CONTEXT_CAP_TOKENS,
                        },
                        historyEditor: result.details.historyEditor,
                        summaryRebase,
                        editableMemory: { enabled: settings.editableMemoryEnabled, status: memory?.status ?? "unavailable", generationHash: memory?.generationHash, pinnedTokens: estimateTokensFromText(pinnedMemoryText) },
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
        }
        catch (error) {
            const noSavings = error instanceof CompactionValidationError && error.report.issues.some((issue) => issue.code === "no-net-savings");
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
    pi.registerCommand("chrono-worker-status", {
        description: "Show bounded isolated-worker and scheduler status",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI)
                return;
            const settings = resolveExtensionSettings(userConfig);
            const artifacts = await schedulerArtifactCounts(defaultSchedulerDirectory());
            ctx.ui.notify([
                `Isolated replay worker: ${settings.isolatedWorkerEnabled ? "enabled" : "disabled"}`,
                `Last replay state: ${String(replayWorkerStatus.state ?? "idle")}`,
                `Last safe failure code: ${String(replayWorkerStatus.failureCode ?? "none")}`,
                `Host slots: ${settings.hostWorkerSlots}`,
                `Scheduler artifacts: ${artifacts.slots} slot(s), ${artifacts.tickets} ticket(s)`,
                `Worker timeout: ${settings.workerTimeoutSeconds}s`,
            ].join("\n"), "info");
        },
    });
    pi.registerCommand("chrono-doctor", {
        description: "Run read-only bounded ChronoCompact safety checks",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI)
                return;
            const settings = resolveExtensionSettings(userConfig);
            const sessionPath = ctx.sessionManager.getSessionFile();
            const source = sessionPath ? await historySourceState(sessionPath).then((value) => ({ state: "ready", bytes: value.size, legacyHistory: value.size <= LEGACY_HISTORY_MAX_BYTES ? "allowed" : "refused" })).catch(() => ({ state: "unavailable", bytes: 0, legacyHistory: "refused" })) : { state: "ephemeral", bytes: 0, legacyHistory: "in-memory" };
            const ledger = await availableHistoryLedger(ctx);
            const artifacts = await schedulerArtifactCounts(defaultSchedulerDirectory());
            const diagnosticBytes = sessionPath ? await stat(replayWorkerDiagnosticPath(sessionPath)).then((value) => value.size).catch(() => 0) : 0;
            ctx.ui.notify([
                `Session source: ${source.state}; bytes ${source.bytes}`,
                `Legacy whole-file history: ${source.legacyHistory}; limit ${LEGACY_HISTORY_MAX_BYTES}`,
                `Verified source ledger: ${ledger ? "ready" : "unavailable"}`,
                `Replay worker diagnostics: ${diagnosticBytes > 0 ? "owner-only records present" : "none"}`,
                `Scheduler artifacts: ${artifacts.slots} slot(s), ${artifacts.tickets} ticket(s)`,
                `Isolated worker configured: ${settings.isolatedWorkerEnabled ? "yes" : "no"}`,
                "Doctor mode: read-only; no session content or private path emitted.",
            ].join("\n"), source.state === "unavailable" ? "warning" : "info");
        },
    });
    pi.registerCommand("chrono-rollup-shadow-status", {
        description: "Show aggregate hierarchical rollup shadow metrics",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI)
                return;
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
    pi.registerCommand("chrono-value-worker-status", {
        description: "Show aggregate background value-worker status",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI)
                return;
            const settings = resolveExtensionSettings(userConfig);
            const sessionPath = ctx.sessionManager.getSessionFile();
            const manifest = sessionPath ? await readValueAdviceManifest(valueAdviceStorePath(sessionPath)) : undefined;
            const adviceStoreState = manifest ? "ready" : sessionPath ? await stat(join(valueAdviceStorePath(sessionPath), "manifest.json")).then(() => "corrupt").catch(() => "none") : "none";
            const candidateManifest = incrementalStore && incrementalStore.sessionPath === sessionPath ? incrementalStore.manifest : undefined;
            const pendingSegments = candidateManifest ? candidateManifest.segments.filter((segment) => !manifest?.processedSegmentIdentities.includes(segment.segmentContentHash)).length : 0;
            const budgetState = manifest && (manifest.usage.calls >= settings.valueWorker.maxCallsPerSession || manifest.usage.inputTokens >= settings.valueWorker.maxInputTokensPerSession || manifest.usage.outputTokens >= settings.valueWorker.maxOutputTokensPerSession || (settings.valueWorker.maxEstimatedCostMicroUsd !== undefined && manifest.usage.costMicroUsd >= settings.valueWorker.maxEstimatedCostMicroUsd)) ? "exhausted" : "available";
            ctx.ui.notify([
                `Mode: ${settings.valueWorker.mode}`, `Configured model: ${settings.valueWorker.model}`, `Resolved model: ${manifest?.resolvedModelIdentity ?? "none"}`, `Thinking: ${settings.valueWorker.thinking}`,
                `Candidate store: ${String(incrementalStatus.state ?? "unknown")}`, `Advice store: ${adviceStoreState}`, `Pending segments: ${pendingSegments}`, `Pending batches: ${pendingSegments === 0 ? 0 : "bounded at run time"}`, `Active job: ${valueWorkerActive ? "running" : "idle"}`, `Model slot limit: ${settings.valueWorker.hostSlots}`, `Budget state: ${budgetState}`, `Last safe status: ${String(valueWorkerStatus.status)}`,
                `Completed segments: ${manifest?.processedSegmentIdentities.length ?? 0}`, `Valid advice records: ${manifest?.adviceFiles.filter((item) => item.configurationHash === valueWorkerConfigurationHash(settings.valueWorker)).reduce((n, x) => n + x.records, 0) ?? 0}`, `Ignored advice records: ${manifest?.adviceFiles.filter((item) => item.configurationHash !== valueWorkerConfigurationHash(settings.valueWorker)).reduce((n, x) => n + x.records, 0) ?? 0}`, `Calls: ${manifest?.usage.calls ?? 0}`, `Repair calls: ${manifest?.usage.repairCalls ?? 0}`,
                `Input tokens: ${manifest?.usage.inputTokens ?? 0}`, `Output tokens: ${manifest?.usage.outputTokens ?? 0}`, `Cache-read tokens: ${manifest?.usage.cacheReadTokens ?? 0}`, `Cache-write tokens: ${manifest?.usage.cacheWriteTokens ?? 0}`, `Estimated cost: ${manifest?.usage.costAvailable ? `$${((manifest.usage.costMicroUsd ?? 0) / 1_000_000).toFixed(6)}` : "unavailable"}`, `Provider attempts: ${valueWorkerStatus && "providerAttempts" in valueWorkerStatus ? valueWorkerStatus.providerAttempts ?? 0 : 0}`,
                `Consecutive failures: ${manifest?.consecutiveFailures ?? 0}`, `Circuit: ${manifest?.circuitState ?? "closed"}`, `Circuit reopen time: ${manifest?.circuitReopenTime ?? "none"}`, `Last successful update: ${manifest?.lastSuccessTime ?? "none"}`,
            ].join("\n"), "info");
        },
    });
    pi.registerCommand("chrono-value-worker-reset", {
        description: "Cancel pending value work and reset its persisted circuit",
        handler: async (_args, ctx) => { cancelValueWorker(); const sessionPath = ctx.sessionManager.getSessionFile(); const reset = sessionPath ? await resetAdviceCircuit(valueAdviceStorePath(sessionPath)).catch(() => false) : false; valueWorkerStatus = { status: "off" }; ctx.ui.notify(`${reset ? "Reset the persisted circuit. " : "No compatible persisted circuit was found. "}Pending value work was cancelled. Stored advice and source files were preserved.`, "info"); },
    });
    pi.registerCommand("chrono-compact-settings", {
        description: "Open interactive ChronoCompact settings",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI)
                return;
            if (userConfigWarning)
                ctx.ui.notify(userConfigWarning, "warning");
            const selected = await openChronoCompactSettings(ctx, userConfig);
            if (selected === undefined) {
                ctx.ui.notify("ChronoCompact settings were not changed.", "info");
                return;
            }
            try {
                saveUserConfig(selected, userConfigPath);
                userConfig = selected;
                userConfigWarning = undefined;
                lastTriggerAttemptTokens = undefined;
                cancelIncrementalWork(true);
                cancelShadowWork();
                cancelValueWorker();
                projectionSeenToolCallIds = new Set();
                const settings = resolveExtensionSettings(userConfig);
                scheduleIncrementalWork(ctx);
                const cachePath = ctx.sessionManager.getSessionFile();
                const cache = cachePath ? await readCompactionCache(cachePathForSession(cachePath)) : undefined;
                ctx.ui.notify([
                    `Saved ChronoCompact settings to ${userConfigPath}.`,
                    `Timing: ${settings.triggerThresholdTokens === undefined ? "Pi context pressure" : `${settings.triggerThresholdTokens.toLocaleString()} tokens`}`,
                    `Raw tail: ${rawTailDescription(settings)}`,
                    `Active target: ${settings.targetContextTokens.toLocaleString()} tokens`,
                    `Replay maximum: ${settings.replayTargetTokens === undefined ? "automatic" : settings.replayTargetTokens.toLocaleString()}`,
                    `Regular Pi summary: ${settings.hybridSummaryEnabled ? `${settings.hybridSummaryTargetTokens.toLocaleString()} tokens` : "disabled"}`,
                    `Background value worker: ${settings.valueWorker.mode}; model ${settings.valueWorker.model}; thinking ${settings.valueWorker.thinking}`,
                    ...(settings.legacyHistoryEditorEnabled ? ["Warning: the old history classifier setting is retired and cannot start a model call. Use the value-worker controls."] : []),
                    `Segmented incremental deterministic precompute: ${settings.incrementalPrecomputeEnabled ? "enabled" : "disabled"}`,
                    `Isolated local compaction worker: ${settings.isolatedWorkerEnabled ? `enabled, ${settings.hostWorkerSlots} host slot(s), ${settings.workerTimeoutSeconds}s timeout, nice ${settings.workerNiceLevel}; local deterministic work only, no model` : "disabled"}`,
                    `Hierarchical rollup shadow evaluation: ${settings.rollupShadowEnabled ? "enabled; output does not reach the model; current replay is authoritative; local isolated low-priority worker; metrics only" : "disabled"}`,
                    `Request-local tool-result projection: ${settings.toolResultProjectionMode}`,
                    `Ranked local history search: ${settings.rankedSearchEnabled ? "enabled" : "disabled"}`,
                    `Editable working memory: ${settings.editableMemoryEnabled ? "enabled" : "disabled"}`,
                    `Source retention bands: hot ${settings.config.hotSourceTokens?.toLocaleString()} + warm ${settings.config.warmSourceTokens?.toLocaleString()}`,
                    `Regular-summary rebase: every ${settings.summaryRebaseInterval} generations`,
                    cache ? `Latest cache generation: ${cache.generation}` : "Latest cache generation: none",
                ].join("\n"), "info");
            }
            catch (error) {
                ctx.ui.notify(`Could not save ChronoCompact settings: ${safeErrorMessage(error)}`, "error");
            }
        },
    });
}
//# sourceMappingURL=pi-extension.js.map