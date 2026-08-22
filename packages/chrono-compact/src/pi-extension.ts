import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { env } from "node:process";
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
import { buildCausalMemory } from "./causal-memory.js";
import {
  projectToolResultContext,
  projectionSourcesFromBranch,
  type ContextMessageLike,
  type ToolResultProjectionMetrics,
  type ToolResultProjectionMode,
} from "./context-projection.js";
import {
  createCandidateSegmentStore,
  loadCandidateRecordsForBranch,
  loadCandidateSegmentManifest,
  updateCandidateSegmentStore,
  type CandidateSegmentStore,
} from "./candidate-segment-store.js";
import { getSourceEntriesBefore, parseBranchEntries, readSessionJsonl } from "./jsonl.js";
import { loadSourceLedger } from "./source-ledger.js";
import {
  createPiRegularSummary,
  previousRegularPiSummary,
  regularSummaryMessagesForCut,
  renderHybridCompaction,
} from "./pi-hybrid.js";
import { createPiHistoryEditor, DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS } from "./history-editor.js";
import {
  historyGet,
  historyRange,
  historySearch,
} from "./retrieval.js";
import { buildLocalSearchIndex, renderRankedSearch, searchLocalHistory, type LocalSearchIndex } from "./search-index.js";
import { recallHistory, renderRecall } from "./recall.js";
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
import type { CompactorConfig, ParsedSession, SessionEntryLike } from "./types.js";
import {
  applyConfigCommand,
  defaultUserConfigPath,
  loadUserConfig,
  saveUserConfig,
  type UserConfig,
} from "./user-config.js";
import { emptyRetrievalFeedback, recordRetrievalFeedback, type RetrievalFeedback } from "./telemetry.js";
import { estimateTokensFromText, hashText, safeErrorMessage, stableStringify, truncateToTokens } from "./utils.js";

const EXTENSION_VERSION = "2.0.0";
export const HARD_COMBINED_CONTEXT_CAP_TOKENS = 30_000;
const MAX_RAW_TAIL_WITH_HISTORY_TOKENS = 27_000;
const RETENTION_HINT_CUSTOM_TYPE = "chrono-compact-retention-hint";
const CONTEXT_WARNING_CUSTOM_TYPE = "chrono-compact-context-warning";
const CONTEXT_RESUME_CUSTOM_TYPE = "chrono-compact-resume";
const CONTEXT_WARNING_PERCENT = 75;
const CONTEXT_URGENT_PERCENT = 85;
const CONTEXT_CIRCUIT_BREAKER_PERCENT = 95;

export interface RuntimeSettings {
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
  readonly hybridSummaryTargetTokens: number;
  readonly historyEditorEnabled: boolean;
  readonly historyEditorMaxInputTokens: number;
  readonly historyEditorMaxOutputTokens: number;
  readonly incrementalPrecomputeEnabled: boolean;
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
    hybridSummaryEnabled: booleanSetting("PI_CHRONO_PI_SUMMARY", true, overrides.hybridSummaryEnabled),
    hybridSummaryTargetTokens: numberSetting("PI_CHRONO_PI_SUMMARY_TOKENS", 2_500, 512, 16_000, overrides.hybridSummaryTargetTokens),
    historyEditorEnabled: booleanSetting("PI_CHRONO_HISTORY_EDITOR", false, overrides.historyEditorEnabled),
    historyEditorMaxInputTokens: numberSetting("PI_CHRONO_HISTORY_EDITOR_MAX_INPUT", DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS, 1_000, 50_000),
    historyEditorMaxOutputTokens: numberSetting("PI_CHRONO_HISTORY_EDITOR_MAX_OUTPUT", 16_000, 256, 25_000),
    incrementalPrecomputeEnabled: booleanSetting("PI_CHRONO_INCREMENTAL_PRECOMPUTE", false, overrides.incrementalPrecomputeEnabled),
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

function rawTailDescription(settings: RuntimeSettings): string {
  if (settings.rawTailMode === "dynamic") {
    return `dynamic ${settings.dynamicRawTailMinTokens.toLocaleString()}–${settings.dynamicRawTailMaxTokens.toLocaleString()}`;
  }
  if (settings.rawTailTokens !== undefined) return `${settings.rawTailMode} ${settings.rawTailTokens.toLocaleString()}`;
  return "Pi prepared tail";
}

async function tokenInput(
  ctx: ExtensionCommandContext,
  title: string,
  current: number,
  command: string,
  config: UserConfig,
): Promise<UserConfig> {
  const value = await ctx.ui.input(title, current.toString());
  if (value === undefined) return config;
  try {
    return applyConfigCommand(config, `${command} ${value.trim()}`).config;
  } catch (error) {
    ctx.ui.notify(safeErrorMessage(error), "warning");
    return config;
  }
}

async function openChronoCompactSettings(
  ctx: ExtensionCommandContext,
  initial: UserConfig,
): Promise<UserConfig | undefined> {
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
      `Experimental LLM history classifier · ${settings.historyEditorEnabled ? "enabled" : "disabled"}`,
      `Segmented incremental deterministic precompute · ${settings.incrementalPrecomputeEnabled ? "enabled" : "disabled"}`,
      `Request-local tool-result projection · ${settings.toolResultProjectionMode}`,
      `Ranked local history search · ${settings.rankedSearchEnabled ? "enabled" : "disabled"}`,
      `Editable working memory · ${settings.editableMemoryEnabled ? "enabled" : "disabled"}`,
      `Source retention bands · hot ${settings.config.hotSourceTokens?.toLocaleString()} + warm ${settings.config.warmSourceTokens?.toLocaleString()}`,
      `Regular-summary rebase · every ${settings.summaryRebaseInterval} generations`,
      "Reset all to defaults",
      "Save and close",
      "Cancel",
    ]);
    if (choice === undefined || choice === "Cancel") return undefined;
    if (choice === "Save and close") return draft;
    if (choice.startsWith("Loaded version")) {
      ctx.ui.notify(`ChronoCompact ${EXTENSION_VERSION} is loaded. Hard replay cap: ${HARD_REPLAY_CAP_TOKENS.toLocaleString()} tokens. Hard combined cap: ${HARD_COMBINED_CONTEXT_CAP_TOKENS.toLocaleString()} tokens.`, "info");
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
      ctx.ui.notify(
        [
          "Pi pressure compaction is separate from the proactive ChronoCompact threshold.",
          "Pi default trigger: context window minus 16,384 reserved tokens.",
          "Pi default preparation tail: 20,000 tokens.",
          usage ? `Current reported context: ${usage.tokens?.toLocaleString() ?? "unknown"}/${usage.contextWindow.toLocaleString()} tokens.` : "Current context usage is unavailable.",
          "Pi pressure can trigger earlier than a higher ChronoCompact threshold and remains the final safeguard.",
        ].join("\n"),
        "info",
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
      const minimum = await ctx.ui.input("Dynamic raw-tail minimum", settings.dynamicRawTailMinTokens.toString());
      if (minimum === undefined) continue;
      const maximum = await ctx.ui.input("Dynamic raw-tail maximum", settings.dynamicRawTailMaxTokens.toString());
      if (maximum === undefined) continue;
      try {
        draft = applyConfigCommand(draft, `raw-tail-bounds ${minimum.trim()} ${maximum.trim()}`).config;
      } catch (error) {
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
      if (selected === "Derive automatically") draft = applyConfigCommand(draft, "replay-target auto").config;
      if (selected === "Use a fixed maximum") {
        draft = await tokenInput(ctx, "Maximum replay tokens", settings.replayTargetTokens ?? 10_000, "replay-target", draft);
      }
      continue;
    }
    if (choice.startsWith("Regular Pi summary")) {
      const selected = await ctx.ui.select("Regular Pi summary", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "hybrid off").config;
      if (selected === "Enabled") {
        draft = applyConfigCommand(draft, "hybrid on").config;
        draft = await tokenInput(ctx, "Regular Pi summary target tokens", settings.hybridSummaryTargetTokens, "hybrid-tokens", draft);
      }
      continue;
    }
    if (choice.startsWith("Experimental LLM history classifier")) {
      const selected = await ctx.ui.select("Experimental LLM history classifier", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "history-classifier off").config;
      if (selected === "Enabled") draft = applyConfigCommand(draft, "history-classifier on").config;
      continue;
    }
    if (choice.startsWith("Incremental deterministic precompute")) {
      const selected = await ctx.ui.select("Incremental deterministic precompute", ["Enabled", "Disabled"]);
      if (selected === "Disabled") draft = applyConfigCommand(draft, "incremental-precompute off").config;
      if (selected === "Enabled") draft = applyConfigCommand(draft, "incremental-precompute on").config;
      continue;
    }
    if (choice.startsWith("Request-local tool-result projection")) {
      const selected = await ctx.ui.select("Request-local tool-result projection", ["Off", "Safe", "Aggressive"]);
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
    if (choice === "Reset all to defaults") {
      if (await ctx.ui.confirm("Reset ChronoCompact settings?", "This removes all persistent overrides.")) draft = {};
    }
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

async function loadSession(ctx: ExtensionContext): Promise<ParsedSession> {
  const path = ctx.sessionManager.getSessionFile();
  if (path) return readSessionJsonl(path);
  const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
  return parseBranchEntries(asEntries(entries));
}

function toolText(text: string, details: Record<string, unknown> = {}): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details };
}

const SEARCH_INDEX_CACHE_LIMIT = 4;
const searchIndexes = new Map<string, LocalSearchIndex>();

function indexedSession(session: ParsedSession): LocalSearchIndex {
  const built = buildLocalSearchIndex(session);
  const cached = searchIndexes.get(built.generationHash);
  if (cached) return cached;
  searchIndexes.set(built.generationHash, built);
  while (searchIndexes.size > SEARCH_INDEX_CACHE_LIMIT) searchIndexes.delete(searchIndexes.keys().next().value!);
  return built;
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
  store.set(key, recordRetrievalFeedback(previous, observation));
  while (store.size > 8) store.delete(store.keys().next().value!);
}

function registerHistoryTools(
  pi: ExtensionAPI,
  settings: () => RuntimeSettings,
  retrievalFeedback: Map<string, RetrievalFeedback>,
): void {
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
      const session = await loadSession(ctx);
      const text = historyGet(session, params.entryId, {
        blockIndex: params.blockIndex,
        contextBefore: params.contextBefore,
        contextAfter: params.contextAfter,
        startChar: params.startChar,
        maxChars: params.maxChars,
      });
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
      const session = await loadSession(ctx);
      const selectedMode = params.regex ? "regex" : params.mode;
      if (!settings().rankedSearchEnabled && selectedMode === undefined) {
        const text = historySearch(session, params.query, {
          limit: params.limit,
          startMatch: params.startMatch,
          caseSensitive: params.caseSensitive,
          regex: params.regex,
          contextChars: params.contextChars,
        });
        return toolText(text, { query: params.query, mode: "legacy-exact" });
      }
      const index = indexedSession(session);
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
          ...(params.kind === undefined ? {} : { kinds: [params.kind as never] }),
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
      const session = await loadSession(ctx);
      const index = indexedSession(session);
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
      let promotionWarning: string | undefined;
      if (settings().editableMemoryEnabled && ctx.sessionManager.getSessionFile()) {
        try {
          const path = memoryPathForContext(ctx);
          const memory = await readMemoryEvents(path);
          if (memory.status !== "ready") throw new Error(memory.error ?? "memory integrity failure");
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
            const event = updated.events[updated.events.length - 1]!;
            pi.appendEntry("chrono-memory-v2-event", event);
            promotedMemories += 1;
          }
        } catch (error) {
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
      const session = await loadSession(ctx);
      const text = historyRange(session, params.startEntryId, params.endEntryId, { maxEntries: params.maxEntries });
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

export default function chronoCompactExtension(pi: ExtensionAPI): void {
  const userConfigPath = defaultUserConfigPath();
  const loadedUserConfig = loadUserConfig(userConfigPath);
  let userConfig = loadedUserConfig.config;
  let userConfigWarning = loadedUserConfig.warning;
  const retrievalFeedback = new Map<string, RetrievalFeedback>();
  registerHistoryTools(pi, () => resolveExtensionSettings(userConfig), retrievalFeedback);
  registerMemoryTools(pi, () => resolveExtensionSettings(userConfig));
  registerRetentionHintTool(pi);
  let triggerPending = false;
  let lastTriggerAttemptTokens: number | undefined;
  let forcedCompactionReason: string | undefined;
  let forcedContinuationPending = false;
  let continueAfterSuccessfulCompaction = false;
  let warningLevel = 0;
  let incrementalStore: CandidateSegmentStore | undefined;
  let incrementalAbort: AbortController | undefined;
  let incrementalTimer: ReturnType<typeof setTimeout> | undefined;
  let incrementalGeneration = 0;
  let incrementalStatus: Record<string, unknown> = { state: "disabled" };
  let projectionSeenToolCallIds = new Set<string>();
  let lastProjectionMetrics: ToolResultProjectionMetrics | undefined;

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

  const scheduleIncrementalWork = (ctx: ExtensionContext): void => {
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
          if (!store.manifest) await loadCandidateSegmentManifest(store);
          const metrics = await updateCandidateSegmentStore(store, config, { signal: controller.signal });
          if (controller.signal.aborted || generation !== incrementalGeneration) return;
          incrementalStore = store;
          incrementalStatus = { state: "ready", ...metrics };
        } catch (error) {
          if (!controller.signal.aborted) incrementalStatus = { state: "fallback", reason: safeErrorMessage(error) };
        } finally {
          if (incrementalAbort === controller) incrementalAbort = undefined;
        }
      })();
    }, 35);
  };

  const launchCompaction = (ctx: ExtensionContext, reason: string, currentTokens?: number, resumeAfter = false): void => {
    if (triggerPending) return;
    triggerPending = true;
    forcedContinuationPending = resumeAfter;
    if (currentTokens !== undefined) lastTriggerAttemptTokens = currentTokens;
    if (ctx.hasUI) ctx.ui.notify(`ChronoCompact trigger: ${reason}.`, "info");
    ctx.compact({
      customInstructions: `ChronoCompact trigger: ${reason}. Preserve direct user restrictions, decisive failures, and unresolved work.`,
      onComplete: () => {
        triggerPending = false;
      },
      onError: (error) => {
        triggerPending = false;
        forcedContinuationPending = false;
        continueAfterSuccessfulCompaction = false;
        if (ctx.hasUI) ctx.ui.notify(`ChronoCompact request failed: ${error.message}`, "warning");
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
    if (settings.toolResultProjectionMode === "off") return undefined;
    try {
      const branchEntries = asEntries(ctx.sessionManager.getBranch());
      const result = await projectToolResultContext(
        event.messages as unknown as readonly ContextMessageLike[],
        {
          mode: settings.toolResultProjectionMode,
          seenToolCallIds: projectionSeenToolCallIds,
          sourceByToolCallId: projectionSourcesFromBranch(branchEntries),
        },
      );
      projectionSeenToolCallIds = new Set([...projectionSeenToolCallIds, ...result.newlySeenToolCallIds]);
      lastProjectionMetrics = result.metrics;
      if (result.metrics.projectedToolResults === 0) return undefined;
      return { messages: result.messages as unknown as typeof event.messages };
    } catch (error) {
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
    projectionSeenToolCallIds = new Set();
    lastProjectionMetrics = undefined;
    scheduleIncrementalWork(ctx);
  });

  pi.on("session_before_switch", () => {
    cancelIncrementalWork(true);
    projectionSeenToolCallIds = new Set();
  });

  pi.on("session_before_fork", () => {
    cancelIncrementalWork(true);
    projectionSeenToolCallIds = new Set();
  });

  pi.on("session_shutdown", () => {
    cancelIncrementalWork(true);
    projectionSeenToolCallIds = new Set();
  });

  pi.on("turn_end", (event, ctx) => {
    const usage = ctx.getContextUsage();
    const reportedTokens = event.message.role === "assistant" ? (event.message.usage?.totalTokens ?? 0) : 0;
    const currentTokens = Math.max(usage?.tokens ?? 0, reportedTokens);
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const percent = contextWindow > 0 ? (currentTokens / contextWindow) * 100 : 0;

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
  });

  pi.on("session_compact", (event) => {
    cancelIncrementalWork(true);
    projectionSeenToolCallIds = new Set();
    const shouldContinue = continueAfterSuccessfulCompaction && !event.willRetry;
    triggerPending = false;
    forcedCompactionReason = undefined;
    forcedContinuationPending = false;
    continueAfterSuccessfulCompaction = false;
    warningLevel = 0;
    if (shouldContinue) {
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
      if (preparedCutIndex < 0) throw new Error(`Pi prepared cut entry ${preparedFirstKeptEntryId} was not present on the active branch.`);
      const estimateTailTokens = createTailTokenEstimator(branchEntries);
      const preparedTailTokens = estimateTailTokens(branchEntries.slice(preparedCutIndex));
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
      if (tailSelection.actualTokens > MAX_RAW_TAIL_WITH_HISTORY_TOKENS) {
        const bounded = selectRawTailWithinMaximum(
          branchEntries,
          MAX_RAW_TAIL_WITH_HISTORY_TOKENS,
          estimateTailTokens,
        );
        if (!bounded) throw new Error("No valid raw-tail cut can satisfy the 30,000-token combined ceiling.");
        tailSelection = { ...bounded, mode: tailSelection.mode };
      }
      if (!isSafeCompactionCut(branchEntries, tailSelection.cutIndex)) {
        const repaired = selectRawTailWithinMaximum(
          branchEntries,
          Math.min(MAX_RAW_TAIL_WITH_HISTORY_TOKENS, tailSelection.actualTokens),
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
      const historicalCeilingTokens = HARD_COMBINED_CONTEXT_CAP_TOKENS - retainedTailTokens;
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
      const generationHash = computeGenerationHash(sourceEntries, config, retentionHints, retainedEntries, pinnedMemoryText, currentRetrievalFeedback);
      const configHash = hashCompactionConfig({
        extensionVersion: EXTENSION_VERSION,
        config,
        retentionHints,
        historyEditorEnabled: settings.historyEditorEnabled,
        historyEditorMaxInputTokens: settings.historyEditorMaxInputTokens,
        historyEditorMaxOutputTokens: settings.historyEditorMaxOutputTokens,
        historyEditorModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        hardCombinedContextCapTokens: HARD_COMBINED_CONTEXT_CAP_TOKENS,
        rawTailMode: settings.rawTailMode,
        rawTailTokens: settings.rawTailTokens,
        dynamicRawTailMinTokens: settings.dynamicRawTailMinTokens,
        dynamicRawTailMaxTokens: settings.dynamicRawTailMaxTokens,
        hybridSummaryEnabled: settings.hybridSummaryEnabled,
        hybridSummaryTargetTokens: settings.hybridSummaryTargetTokens,
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

      if (settings.cacheEnabled && cachePath) {
        const cached = await readCompactionCache(cachePath);
        if (
          cached?.sourceHash === generationHash &&
          cached.configHash === configHash &&
          cached.renderedTokens + retainedTailTokens <= HARD_COMBINED_CONTEXT_CAP_TOKENS
        ) {
          ctx.ui.notify(
            `ChronoCompact reused generation ${cached.generation}: ${cached.rawTokens.toLocaleString()}→${cached.renderedTokens.toLocaleString()} estimated tokens.`,
            "info",
          );
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

      let piSummary: Awaited<ReturnType<typeof createPiRegularSummary>>;
      if (settings.hybridSummaryEnabled) {
        try {
          const piSummaryTargetTokens = Math.min(
            settings.hybridSummaryTargetTokens,
            Math.max(512, targetTokens - 512),
          );
          if (summaryRebase.rebase) {
            const text = buildDeterministicSummaryRebase(
              parseHistoricalBlocks(sourceEntries, { includeHistoricalCompactions: false, includeMetadata: false }),
              undefined,
              piSummaryTargetTokens,
            );
            piSummary = {
              text,
              tokens: estimateTokensFromText(text),
              model: "deterministic-local-rebase",
            };
          } else {
            piSummary = await createPiRegularSummary(ctx, event.preparation, {
              targetTokens: piSummaryTargetTokens,
              customInstructions: event.customInstructions,
              signal: event.signal,
              previousSummary: previousPiSummary,
              messages: regularSummaryMessagesForCut(branchEntries, firstKeptEntryId, false),
            });
          }
          if (piSummary && piSummary.tokens > piSummaryTargetTokens) {
            const text = truncateToTokens(
              piSummary.text,
              piSummaryTargetTokens,
              "\n\n[Regular Pi summary deterministically bounded for the 30,000-token combined ceiling.]",
            );
            piSummary = { ...piSummary, text, tokens: estimateTokensFromText(text) };
          }
          if (!piSummary && ctx.hasUI) {
            ctx.ui.notify("Regular Pi hybrid summary was unavailable; deterministic replay will be used alone.", "warning");
          }
        } catch (hybridError) {
          if (!event.signal?.aborted && ctx.hasUI) {
            ctx.ui.notify(`Regular Pi hybrid summary failed; deterministic replay will continue: ${safeErrorMessage(hybridError)}`, "warning");
          }
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
      if (settings.incrementalPrecomputeEnabled && sessionPath) {
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
      const historyEditor = settings.historyEditorEnabled && ctx.model ? createPiHistoryEditor(ctx) : undefined;
      const result = await compactEntries(sourceEntries, {
        config: replayConfig,
        ...(precomputedCandidates === undefined ? {} : { precomputedCandidates }),
        historyEditor,
        historyEditorMaxInputTokens: settings.historyEditorMaxInputTokens,
        historyEditorMaxOutputTokens: settings.historyEditorMaxOutputTokens,
        hardOutputTokens: replayCeilingTokens,
        signal: event.signal,
        retentionHints,
        futureEntries: retainedEntries,
        pinnedMemoryText,
        retrievalFeedback: currentRetrievalFeedback,
      });
      const combinedSummary = piSummary
        ? renderHybridCompaction(piSummary.text, result.summary)
        : result.summary;
      const combinedTokens = estimateTokensFromText(combinedSummary);
      const combinedContextTokens = combinedTokens + retainedTailTokens;
      if (combinedContextTokens > HARD_COMBINED_CONTEXT_CAP_TOKENS) {
        throw new Error(
          `Combined context ${combinedContextTokens} exceeds the hard ${HARD_COMBINED_CONTEXT_CAP_TOKENS}-token ceiling.`,
        );
      }

      let generation: number | undefined;
      if (settings.cacheEnabled && cachePath) {
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
        } catch (cacheError) {
          ctx.ui.notify(`ChronoCompact cache write failed: ${safeErrorMessage(cacheError)}`, "warning");
        }
      }

      const editorStatus = result.details.historyEditor;
      ctx.ui.notify(
        `ChronoCompact 2.0.0 candidate: ${result.rawTokens.toLocaleString()}→${combinedTokens.toLocaleString()} historical tokens; ${combinedContextTokens.toLocaleString()}/${HARD_COMBINED_CONTEXT_CAP_TOKENS.toLocaleString()} combined; editor ${editorStatus?.status ?? "disabled"} (${editorStatus?.calls ?? 0} job).`,
        "info",
      );
      return {
        compaction: {
          summary: combinedSummary,
          firstKeptEntryId,
          tokensBefore,
          ...(piSummary?.usage === undefined ? {} : { usage: piSummary.usage }),
          details: {
            kind: "chrono-compact-event-stream-context-compaction",
            version: EXTENSION_VERSION,
            cache: { hit: false, generation, sourceHash: generationHash },
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
    } catch (error) {
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

  pi.registerCommand("chrono-compact-settings", {
    description: "Open interactive ChronoCompact settings",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (userConfigWarning) ctx.ui.notify(userConfigWarning, "warning");
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
        projectionSeenToolCallIds = new Set();
        const settings = resolveExtensionSettings(userConfig);
        scheduleIncrementalWork(ctx);
        const cachePath = ctx.sessionManager.getSessionFile();
        const cache = cachePath ? await readCompactionCache(cachePathForSession(cachePath)) : undefined;
        ctx.ui.notify(
          [
            `Saved ChronoCompact settings to ${userConfigPath}.`,
            `Timing: ${settings.triggerThresholdTokens === undefined ? "Pi context pressure" : `${settings.triggerThresholdTokens.toLocaleString()} tokens`}`,
            `Raw tail: ${rawTailDescription(settings)}`,
            `Active target: ${settings.targetContextTokens.toLocaleString()} tokens`,
            `Replay maximum: ${settings.replayTargetTokens === undefined ? "automatic" : settings.replayTargetTokens.toLocaleString()}`,
            `Regular Pi summary: ${settings.hybridSummaryEnabled ? `${settings.hybridSummaryTargetTokens.toLocaleString()} tokens` : "disabled"}`,
            `Experimental LLM history classifier: ${settings.historyEditorEnabled ? "enabled" : "disabled"}`,
            `Segmented incremental deterministic precompute: ${settings.incrementalPrecomputeEnabled ? "enabled" : "disabled"}`,
            `Request-local tool-result projection: ${settings.toolResultProjectionMode}`,
            `Ranked local history search: ${settings.rankedSearchEnabled ? "enabled" : "disabled"}`,
            `Editable working memory: ${settings.editableMemoryEnabled ? "enabled" : "disabled"}`,
            `Source retention bands: hot ${settings.config.hotSourceTokens?.toLocaleString()} + warm ${settings.config.warmSourceTokens?.toLocaleString()}`,
            `Regular-summary rebase: every ${settings.summaryRebaseInterval} generations`,
            cache ? `Latest cache generation: ${cache.generation}` : "Latest cache generation: none",
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Could not save ChronoCompact settings: ${safeErrorMessage(error)}`, "error");
      }
    },
  });
}
