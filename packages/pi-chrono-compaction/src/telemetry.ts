import type { CompressionPlan, HistoricalBlock } from "./types.js";
import { hashText, stableStringify } from "./utils.js";

export type TokenCategory = "authority" | "assistant" | "file" | "diff" | "test" | "search" | "terminal" | "json" | "tool-call" | "episode" | "control" | "other";

export interface CategoryTokenCost {
  readonly category: TokenCategory;
  readonly sourceTokens: number;
  readonly renderedTokens: number;
  readonly savedTokens: number;
  readonly sourceBlocks: number;
}

export interface TokenTelemetry {
  readonly schemaVersion: 2;
  readonly generationHash: string;
  readonly sourceTokens: number;
  readonly renderedTokens: number;
  readonly savedTokens: number;
  readonly categories: readonly CategoryTokenCost[];
  readonly reducers: Readonly<Record<string, { readonly blocks: number; readonly sourceTokens: number; readonly renderedTokens: number }>>;
}

export interface RetrievalFeedback {
  readonly schemaVersion: 2;
  readonly generationHash: string;
  readonly searches: number;
  readonly misses: number;
  readonly repeatedQueries: number;
  readonly retrievedTokens: number;
  readonly expandedItems: number;
  readonly readsByResource: Readonly<Record<string, number>>;
  readonly readsByBlockId: Readonly<Record<string, number>>;
  readonly queryCounts: Readonly<Record<string, number>>;
}

export interface RetrievalObservation {
  readonly generationHash: string;
  readonly query: string;
  readonly resultCount: number;
  readonly retrievedTokens: number;
  readonly expandedItems?: number;
  readonly resourceKeys?: readonly string[];
  readonly blockIds?: readonly string[];
}

export function emptyRetrievalFeedback(generationHash: string): RetrievalFeedback {
  return {
    schemaVersion: 2,
    generationHash,
    searches: 0,
    misses: 0,
    repeatedQueries: 0,
    retrievedTokens: 0,
    expandedItems: 0,
    readsByResource: {},
    readsByBlockId: {},
    queryCounts: {},
  };
}

export function recordRetrievalFeedback(previous: RetrievalFeedback, observation: RetrievalObservation): RetrievalFeedback {
  const normalizedQuery = observation.query.trim().toLowerCase().replace(/\s+/g, " ");
  const oldCount = previous.queryCounts[normalizedQuery] ?? 0;
  const queryCounts = { ...previous.queryCounts, [normalizedQuery]: oldCount + 1 };
  const readsByResource = { ...previous.readsByResource };
  for (const resource of observation.resourceKeys ?? []) readsByResource[resource] = (readsByResource[resource] ?? 0) + 1;
  const readsByBlockId = { ...previous.readsByBlockId };
  for (const blockId of observation.blockIds ?? []) readsByBlockId[blockId] = (readsByBlockId[blockId] ?? 0) + 1;
  return {
    ...previous,
    generationHash: observation.generationHash,
    searches: previous.searches + 1,
    misses: previous.misses + (observation.resultCount === 0 ? 1 : 0),
    repeatedQueries: previous.repeatedQueries + (oldCount > 0 ? 1 : 0),
    retrievedTokens: previous.retrievedTokens + observation.retrievedTokens,
    expandedItems: previous.expandedItems + (observation.expandedItems ?? 0),
    readsByResource,
    readsByBlockId,
    queryCounts,
  };
}

export function retentionSignalsFromFeedback(
  feedback: RetrievalFeedback | undefined,
  blockIds: readonly string[],
): { readonly reuseByBlockId: ReadonlyMap<string, number>; readonly noveltyByBlockId: ReadonlyMap<string, number> } {
  if (!feedback) return { reuseByBlockId: new Map(), noveltyByBlockId: new Map() };
  const reuseByBlockId = new Map(Object.entries(feedback.readsByBlockId));
  const missRate = feedback.misses / Math.max(1, feedback.searches);
  const repeatRate = feedback.repeatedQueries / Math.max(1, feedback.searches);
  const baseNovelty = Math.min(1, 0.5 + missRate * 0.3 + repeatRate * 0.15);
  const noveltyByBlockId = new Map(blockIds.map((blockId) => [
    blockId,
    Math.min(1, baseNovelty + Math.min(0.2, (feedback.readsByBlockId[blockId] ?? 0) * 0.04)),
  ]));
  return { reuseByBlockId, noveltyByBlockId };
}

function category(block: HistoricalBlock): TokenCategory {
  if (block.kind === "user" || block.kind === "custom_message") return "authority";
  if (block.kind === "assistant_reasoning" || block.kind === "assistant_text" || block.kind === "branch_summary") return "assistant";
  if (block.kind === "tool_call") return "tool-call";
  if (block.kind === "historical_compaction" || block.kind === "metadata" || block.kind === "model_change" || block.kind === "thinking_level_change") return "control";
  const name = block.toolName ?? "";
  const text = block.exactText;
  if (/^(?:read|cat|head|tail|view|open)$/i.test(name)) return "file";
  if (/diff|patch/i.test(name) || /^(?:diff --git |@@ )/m.test(text)) return "diff";
  if (/test|tap|jest|vitest/i.test(name) || /(?:^|\n)(?:ok|not ok)\s+\d+/m.test(text)) return "test";
  if (/grep|search|find|rg/i.test(name)) return "search";
  if (/^\s*[\[{]/.test(text)) return "json";
  if (block.kind === "tool_result" || block.kind === "bash_execution") return "terminal";
  return "other";
}

export function measureTokenTelemetry(blocks: readonly HistoricalBlock[], plan: CompressionPlan, generationHash: string): TokenTelemetry {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const sourceByCategory = new Map<TokenCategory, { tokens: number; blocks: number }>();
  for (const block of blocks) {
    const key = category(block);
    const current = sourceByCategory.get(key) ?? { tokens: 0, blocks: 0 };
    current.tokens += block.rawTokens;
    current.blocks += 1;
    sourceByCategory.set(key, current);
  }
  const renderedByCategory = new Map<TokenCategory, number>();
  const reducers: Record<string, { blocks: number; sourceTokens: number; renderedTokens: number }> = {};
  for (const unit of plan.units) {
    const block = blocksById.get(unit.id);
    const key = unit.kind === "episode" ? "episode" : block ? category(block) : "other";
    renderedByCategory.set(key, (renderedByCategory.get(key) ?? 0) + unit.selected.tokens);
    const reducer = unit.selected.reducer ?? unit.selected.level;
    const current = reducers[reducer] ?? { blocks: 0, sourceTokens: 0, renderedTokens: 0 };
    current.blocks += 1;
    current.sourceTokens += unit.rawTokens;
    current.renderedTokens += unit.selected.tokens;
    reducers[reducer] = current;
  }
  const categories = [...new Set([...sourceByCategory.keys(), ...renderedByCategory.keys()])].sort().map((key) => {
    const source = sourceByCategory.get(key) ?? { tokens: 0, blocks: 0 };
    const rendered = renderedByCategory.get(key) ?? 0;
    return { category: key, sourceTokens: source.tokens, renderedTokens: rendered, savedTokens: source.tokens - rendered, sourceBlocks: source.blocks };
  });
  const sourceTokens = blocks.reduce((sum, block) => sum + block.rawTokens, 0);
  const renderedTokens = plan.units.reduce((sum, unit) => sum + unit.selected.tokens, 0);
  return {
    schemaVersion: 2,
    generationHash: hashText(stableStringify({ sourceGeneration: generationHash, categories, reducers })),
    sourceTokens,
    renderedTokens,
    savedTokens: sourceTokens - renderedTokens,
    categories,
    reducers,
  };
}
