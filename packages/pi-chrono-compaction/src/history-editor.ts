import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { candidateEstimatedCost } from "./planner.js";
import { renderCompressionPlan } from "./render.js";
import type {
  CompressionPlan,
  HistoricalBlock,
  PlannedUnit,
  RepresentationCandidate,
} from "./types.js";
import { estimateTokensFromText, hasFailureLanguage, hasUnresolvedLanguage, unique } from "./utils.js";
import { validatePlan } from "./validate.js";

export const HISTORY_EDITOR_SCHEMA_VERSION = 2;
export const DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS = 50_000;
export const MIN_HISTORY_EDITOR_SAVINGS_TOKENS = 100;
export type HistoryImportance = "critical" | "high" | "normal" | "low";
export type RetentionTreatment = "light" | "moderate" | "aggressive";
export type HistoryTreatmentAction = "keep" | "compress";

export interface HistoryEditorTreatment {
  readonly candidateId: string;
  readonly treatment: RepresentationCandidate["level"];
  readonly tokens: number;
  readonly savings: number;
}

export interface HistoryEditorItem {
  readonly unitId: string;
  readonly label: string;
  readonly kind: PlannedUnit["kind"];
  readonly text: string;
  readonly textWasBounded: boolean;
  readonly protectedExact: boolean;
  readonly requiredExactEvidence: boolean;
  readonly mustKeepCurrent: boolean;
  readonly age: number;
  readonly goalRelevance: number;
  readonly importance: number;
  readonly retentionTreatment: RetentionTreatment;
  readonly current: {
    readonly treatment: RepresentationCandidate["level"];
    readonly tokens: number;
  };
  readonly compress: HistoryEditorTreatment | null;
}

export interface HistoryEditorRequest {
  readonly schemaVersion: 2;
  readonly maxOutputTokens: number;
  readonly preferredOutputTokens: number;
  readonly retentionHints: string;
  readonly items: readonly HistoryEditorItem[];
}

export interface HistoryEditorResponse {
  readonly text: string;
  readonly model?: string;
  readonly usage?: unknown;
}

export interface HistoryEditor {
  edit(request: HistoryEditorRequest, signal?: AbortSignal): Promise<HistoryEditorResponse | undefined>;
}

export interface HistoryEditorObservation {
  readonly status: "disabled" | "skipped" | "applied" | "fallback";
  readonly calls: 0 | 1;
  readonly model?: string;
  readonly inputItems: number;
  readonly outputDecisions?: number;
  readonly rejectedDecisions?: number;
  readonly missingDecisions?: number;
  readonly changedItems?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reason?: string;
}

interface ParsedDecision {
  readonly unitId: string;
  readonly importance: HistoryImportance;
  readonly confidence: number;
  readonly action: HistoryTreatmentAction;
}

interface ParsedDecisions {
  readonly decisions: readonly ParsedDecision[];
  readonly rejected: number;
  readonly missing: number;
}

export interface HistoryEditorBudget {
  readonly maxOutputTokens: number;
  readonly preferredOutputTokens: number;
  readonly expandedForHighValueHistory: boolean;
}

function sourceBlocks(unit: PlannedUnit, blocks: readonly HistoricalBlock[]): HistoricalBlock[] {
  return blocks.filter((block) =>
    unit.sourceRefs.some(
      (ref) => ref.entryId === block.entryId && (ref.blockIndex === undefined || ref.blockIndex === block.blockIndex),
    ),
  );
}

function requiredSnippets(unit: PlannedUnit): string[] {
  if (unit.protectedExact || unit.kind === "user" || unit.kind === "custom_message") return [unit.selected.text];
  const selectedText = unit.selected.text;
  const selectedLines = selectedText.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < selectedLines.length; index += 1) {
    const expected = selectedLines[index]!;
    if (!/\bexpected\b/i.test(expected)) continue;
    const actual = selectedLines.slice(index + 1, index + 5).find((line) => /\b(?:actual|received)\b/i.test(line));
    if (actual) candidates.push(expected, actual);
  }
  // Keep decisive user-facing failure and unresolved evidence exact. Routine
  // reasoning and tool detail can use prevalidated local candidates with exact recovery.
  if (unit.kind === "assistant_text" && hasFailureLanguage(selectedText)) {
    candidates.push(...selectedLines.filter((line) => hasFailureLanguage(line)).slice(0, 2));
  }
  if (unit.kind === "assistant_text" && hasUnresolvedLanguage(selectedText)) {
    candidates.push(...selectedLines.filter((line) => hasUnresolvedLanguage(line)).slice(0, 2));
  }

  const snippets: string[] = [];
  let tokens = 0;
  for (const candidate of unique(candidates)) {
    if (snippets.length >= 6 || tokens >= 160) break;
    const remaining = 160 - tokens;
    const snippet = estimateTokensFromText(candidate) <= Math.min(40, remaining)
      ? candidate
      : candidate.slice(0, Math.min(40, remaining) * 4).trimEnd();
    if (!snippet) continue;
    const snippetTokens = estimateTokensFromText(snippet);
    if (tokens + snippetTokens > 160) continue;
    snippets.push(snippet);
    tokens += snippetTokens;
  }
  return snippets;
}

function bounded(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000) / 1_000;
}

function goalRelevance(unit: PlannedUnit, blocks: readonly HistoricalBlock[], retentionHints: string): number {
  const sources = sourceBlocks(unit, blocks);
  if (unit.protectedExact) return 1;
  let relevance = unit.kind === "user" || unit.kind === "custom_message" ? 0.55 : 0.1;
  if (sources.some((block) => block.unresolved)) relevance = Math.max(relevance, 0.9);
  if (sources.some((block) => block.isError || hasFailureLanguage(block.exactText))) relevance = Math.max(relevance, 0.75);
  if (unit.importanceReasons.some((reason) => /current execution|outcome changed|cited/i.test(reason))) {
    relevance = Math.max(relevance, 0.7);
  }
  const terms = retentionHints
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length >= 5)
    .slice(0, 80);
  if (terms.some((term) => sources.some((block) => block.exactText.toLowerCase().includes(term)))) {
    relevance = Math.max(relevance, 0.85);
  }
  return bounded(relevance);
}

function treatmentFor(unit: PlannedUnit, age: number, relevance: number, importance: number): RetentionTreatment {
  if (unit.protectedExact) return "light";
  const value = Math.max(relevance, importance);
  const noisyOutput = unit.kind === "tool_result"
    || unit.kind === "bash_execution"
    || unit.kind === "assistant_reasoning"
    || unit.kind === "episode";
  const pressure = age * 0.5 + (1 - value) * 0.35 + (noisyOutput ? 0.2 : 0);
  if (pressure >= 0.72) return "aggressive";
  if (pressure >= 0.42) return "moderate";
  return "light";
}

export function selectHistoryEditorBudget(
  plan: CompressionPlan,
  baselineTokens: number,
  configuredMaximumTokens: number,
  hardMaximumTokens: number,
): HistoryEditorBudget {
  const hardBound = Math.max(
    256,
    Math.min(
      Math.floor(configuredMaximumTokens),
      Math.floor(hardMaximumTokens),
      Math.max(256, Math.floor(baselineTokens) - 1),
    ),
  );
  const representedCost = plan.units.reduce((sum, unit) => sum + candidateEstimatedCost(unit, unit.selected), 0);
  const highValueCost = plan.units
    .filter((unit) => unit.protectedExact || unit.importance >= 160)
    .reduce((sum, unit) => sum + candidateEstimatedCost(unit, unit.selected), 0);
  const highValueShare = representedCost === 0 ? 0 : highValueCost / representedCost;
  const expandedForHighValueHistory =
    baselineTokens > 10_000 && hardBound > 8_000 && (highValueCost >= 2_000 || highValueShare >= 0.3);
  const maxOutputTokens = expandedForHighValueHistory ? hardBound : Math.min(8_000, hardBound);
  const preferredOutputTokens = Math.min(
    maxOutputTokens,
    Math.max(512, Math.floor(baselineTokens * (expandedForHighValueHistory ? 0.6 : 0.45))),
  );
  return { maxOutputTokens, preferredOutputTokens, expandedForHighValueHistory };
}

export function historyEditorStructuralHeadroom(maxOutputTokens: number, itemCount: number): number {
  return Math.min(
    Math.max(0, maxOutputTokens - 128),
    Math.floor(maxOutputTokens * 0.4),
    96 + Math.max(0, itemCount) * 56,
  );
}

function boundedExcerpt(text: string, maximumCharacters = 900): string {
  if (text.length <= maximumCharacters) return text;
  const tailCharacters = Math.floor(maximumCharacters * 0.28);
  const headCharacters = maximumCharacters - tailCharacters;
  return `${text.slice(0, headCharacters).trimEnd()}\n…[bounded middle omitted from classifier payload]…\n${text.slice(-tailCharacters).trimStart()}`;
}

function compressionCandidate(unit: PlannedUnit): RepresentationCandidate | undefined {
  if (unit.protectedExact) return undefined;
  return unit.candidates
    .filter((candidate) => candidate.level !== "absent" && candidate.tokens < unit.selected.tokens)
    .sort((left, right) => right.tokens - left.tokens || right.utility - left.utility)[0];
}

function firstLargeDuplicateIds(units: readonly PlannedUnit[]): Set<string> {
  const counts = new Map<string, number>();
  for (const unit of units) {
    if (estimateTokensFromText(unit.selected.text) < 128) continue;
    counts.set(unit.selected.text, (counts.get(unit.selected.text) ?? 0) + 1);
  }
  const first = new Set<string>();
  const seen = new Set<string>();
  for (const unit of units) {
    if ((counts.get(unit.selected.text) ?? 0) < 2 || seen.has(unit.selected.text)) continue;
    seen.add(unit.selected.text);
    first.add(unit.id);
  }
  return first;
}

function buildRequest(
  plan: CompressionPlan,
  blocks: readonly HistoricalBlock[],
  budget: HistoryEditorBudget,
  retentionHints: string,
): HistoryEditorRequest {
  const visibleUnits = plan.units.filter((unit) => unit.selected.level !== "absent");
  const firstDuplicates = firstLargeDuplicateIds(visibleUnits);
  const items = visibleUnits.map((unit, index) => {
    const age = bounded(visibleUnits.length <= 1 ? 0 : 1 - index / (visibleUnits.length - 1));
    const relevance = goalRelevance(unit, blocks, retentionHints);
    const importance = bounded(unit.importance / 200);
    const exactEvidence = requiredSnippets(unit).length > 0;
    const mustKeepCurrent = unit.protectedExact || exactEvidence || firstDuplicates.has(unit.id);
    const compressed = mustKeepCurrent ? undefined : compressionCandidate(unit);
    const text = unit.protectedExact ? unit.selected.text : boundedExcerpt(unit.selected.text);
    return {
      unitId: unit.id,
      label: unit.label,
      kind: unit.kind,
      text,
      textWasBounded: text !== unit.selected.text,
      protectedExact: unit.protectedExact,
      requiredExactEvidence: exactEvidence,
      mustKeepCurrent,
      age,
      goalRelevance: relevance,
      importance,
      retentionTreatment: treatmentFor(unit, age, relevance, importance),
      current: { treatment: unit.selected.level, tokens: unit.selected.tokens },
      compress: compressed
        ? {
            candidateId: compressed.id,
            treatment: compressed.level,
            tokens: compressed.tokens,
            savings: unit.selected.tokens - compressed.tokens,
          }
        : null,
    };
  });
  const structuralHeadroom = historyEditorStructuralHeadroom(budget.maxOutputTokens, items.length);
  const maxOutputTokens = Math.max(128, budget.maxOutputTokens - structuralHeadroom);
  return {
    schemaVersion: HISTORY_EDITOR_SCHEMA_VERSION,
    maxOutputTokens,
    preferredOutputTokens: Math.min(
      maxOutputTokens,
      Math.max(128, budget.preferredOutputTokens - structuralHeadroom),
    ),
    retentionHints,
    items,
  };
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  return JSON.parse(fenced ?? trimmed);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000");
}

function parseDecisions(responseText: string, request: HistoryEditorRequest): ParsedDecisions {
  if (estimateTokensFromText(responseText) > request.maxOutputTokens) {
    throw new Error("history editor output exceeds its token bound");
  }
  const value = parseJsonText(responseText);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("history editor output is not an object");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["version", "decisions"]) || record.version !== HISTORY_EDITOR_SCHEMA_VERSION || !Array.isArray(record.decisions)) {
    throw new Error("history editor output has the wrong schema version or fields");
  }

  const itemById = new Map(request.items.map((item, index) => [item.unitId, { item, index }]));
  const decisions: ParsedDecision[] = [];
  const seen = new Set<string>();
  let previousIndex = -1;
  let rejected = 0;
  for (const raw of record.decisions) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      rejected += 1;
      continue;
    }
    const decision = raw as Record<string, unknown>;
    if (!exactKeys(decision, ["unitId", "importance", "confidence", "action"]) || typeof decision.unitId !== "string") {
      rejected += 1;
      continue;
    }
    const known = itemById.get(decision.unitId);
    if (!known || seen.has(decision.unitId)) {
      rejected += 1;
      continue;
    }
    seen.add(decision.unitId);
    if (known.index <= previousIndex) {
      rejected += 1;
      continue;
    }
    previousIndex = known.index;
    if (!(["critical", "high", "normal", "low"] as const).includes(decision.importance as HistoryImportance)
      || typeof decision.confidence !== "number"
      || !Number.isFinite(decision.confidence)
      || decision.confidence < 0
      || decision.confidence > 1
      || !(["keep", "compress"] as const).includes(decision.action as HistoryTreatmentAction)
      || (decision.action === "compress" && (known.item.mustKeepCurrent || known.item.compress === null))) {
      rejected += 1;
      continue;
    }
    decisions.push({
      unitId: decision.unitId,
      importance: decision.importance as HistoryImportance,
      confidence: decision.confidence,
      action: decision.action as HistoryTreatmentAction,
    });
  }
  return { decisions, rejected, missing: request.items.length - decisions.length };
}

function editedPlan(
  plan: CompressionPlan,
  request: HistoryEditorRequest,
  parsed: ParsedDecisions,
): { readonly plan: CompressionPlan; readonly changedItems: number } {
  const decisions = new Map(parsed.decisions.map((decision) => [decision.unitId, decision]));
  const items = new Map(request.items.map((item) => [item.unitId, item]));
  let changedItems = 0;
  const units = plan.units.map((unit) => {
    const decision = decisions.get(unit.id);
    const item = items.get(unit.id);
    if (decision?.action !== "compress" || !item?.compress) return unit;
    const selected = unit.candidates.find((candidate) => candidate.id === item.compress?.candidateId);
    if (!selected || selected.level === "absent" || selected.tokens >= unit.selected.tokens) return unit;
    changedItems += 1;
    return { ...unit, selected };
  });
  return {
    changedItems,
    plan: {
      ...plan,
      units,
      estimatedTokens: units.reduce((sum, unit) => sum + candidateEstimatedCost(unit, unit.selected), 0),
      warnings: [
        ...plan.warnings,
        "One V1.1 LLM classification job advised typed per-item treatment. Deterministic code selected and rendered only prebuilt local candidates.",
      ],
    },
  };
}

export async function applyHistoryEditor(
  plan: CompressionPlan,
  blocks: readonly HistoricalBlock[],
  generationHash: string,
  includeHeader: boolean,
  editor: HistoryEditor | undefined,
  options: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly retentionHints?: string;
    readonly signal?: AbortSignal;
  },
): Promise<{ readonly plan: CompressionPlan; readonly observation: HistoryEditorObservation }> {
  if (!editor) return { plan, observation: { status: "disabled", calls: 0, inputItems: 0 } };
  const baseline = renderCompressionPlan(plan, generationHash, includeHeader);
  const budget = selectHistoryEditorBudget(plan, baseline.tokens, options.maxOutputTokens, options.maxOutputTokens);
  const request = buildRequest(plan, blocks, budget, options.retentionHints ?? "");
  if (request.items.length < 2) {
    return { plan, observation: { status: "skipped", calls: 0, inputItems: request.items.length, reason: "fewer than two history items were eligible" } };
  }
  if (!request.items.some((item) => item.compress !== null)) {
    return { plan, observation: { status: "skipped", calls: 0, inputItems: request.items.length, reason: "no deterministic smaller candidate was eligible" } };
  }
  const prompt = historyEditorPrompt(request);
  const inputTokens = estimateTokensFromText(prompt);
  if (inputTokens > options.maxInputTokens) {
    return { plan, observation: { status: "skipped", calls: 0, inputItems: request.items.length, inputTokens, reason: "bounded editor input would exceed the configured maximum" } };
  }

  try {
    const response = await editor.edit(request, options.signal);
    if (!response?.text.trim()) throw new Error("history editor returned no text");
    const parsed = parseDecisions(response.text, request);
    const edited = editedPlan(plan, request, parsed);
    if (edited.changedItems === 0) throw new Error("history editor selected no eligible deterministic compression");
    const report = validatePlan(edited.plan, blocks, budget.maxOutputTokens);
    if (!report.ok) throw new Error(report.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code).join(", "));
    const rendered = renderCompressionPlan(edited.plan, generationHash, includeHeader);
    if (rendered.tokens > budget.maxOutputTokens) throw new Error("rendered history editor output exceeds its adaptive hard bound");
    const savings = baseline.tokens - rendered.tokens;
    if (savings < MIN_HISTORY_EDITOR_SAVINGS_TOKENS) {
      throw new Error(`history editor saved ${savings} tokens, below the ${MIN_HISTORY_EDITOR_SAVINGS_TOKENS}-token minimum benefit`);
    }
    return {
      plan: edited.plan,
      observation: {
        status: "applied",
        calls: 1,
        ...(response.model === undefined ? {} : { model: response.model }),
        inputItems: request.items.length,
        outputDecisions: parsed.decisions.length,
        rejectedDecisions: parsed.rejected,
        missingDecisions: parsed.missing,
        changedItems: edited.changedItems,
        inputTokens,
        outputTokens: rendered.tokens,
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      plan,
      observation: {
        status: "fallback",
        calls: 1,
        inputItems: request.items.length,
        inputTokens,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function historyEditorPrompt(request: HistoryEditorRequest): string {
  return [
    "You are ChronoCompact V1.1. Classify history importance and advise bounded treatment decisions.",
    "You do not write, summarize, or copy the final replay. Deterministic code owns all final text, exact bytes, chronology, recovery references, validation, and token limits.",
    "Return only JSON with this exact shape: {\"version\":2,\"decisions\":[{\"unitId\":\"...\",\"importance\":\"critical|high|normal|low\",\"confidence\":0.0,\"action\":\"keep|compress\"}]}",
    "Return any ordered subset of input items. Omitted items deterministically keep their current treatment. Include an item only when you have useful confidence.",
    "Use each unitId at most once and preserve input order. Add no fields.",
    "Protected text is visible for context. For mustKeepCurrent=true or compress=null, use action=keep. Deterministic code will keep those current bytes even if your decision is invalid or missing.",
    "For action=compress, deterministic code selects only the listed prebuilt local candidate. Your output text is never rendered.",
    "Compress low-value, duplicate, routine, or noisy history when exact recovery is sufficient. Keep restrictions, corrections, decisive evidence, causal changes, failures, identifiers, and unresolved work visible.",
    "Age is advisory. Goal relevance and importance outrank age.",
    "Each item has bounded 0–1 metadata. age=1 is oldest. goalRelevance and importance=1 are highest value.",
    `Keep the JSON response within ${request.maxOutputTokens} estimated tokens. Prefer at most ${request.preferredOutputTokens} tokens.`,
    request.retentionHints ? `Advisory retention hints:\n${request.retentionHints}` : "",
    "<items-json>",
    JSON.stringify(request.items),
    "</items-json>",
  ].filter(Boolean).join("\n");
}

export function createPiHistoryEditor(ctx: ExtensionContext): HistoryEditor {
  let used = false;
  return {
    async edit(request, signal) {
      if (used) throw new Error("V1.1 history editor permits only one model job per compaction");
      used = true;
      const model = ctx.model;
      if (!model) return undefined;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return undefined;
      const prompt = historyEditorPrompt(request);
      const response = await complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: Math.max(512, Math.ceil(request.maxOutputTokens * 1.35)),
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
        },
      );
      const text = response.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n").trim();
      return { text, model: `${model.provider}/${model.id}`, usage: response.usage };
    },
  };
}
