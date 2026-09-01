import type { CausalMemoryModel } from "./causal-memory.js";
import { searchLocalHistory, type LocalSearchIndex, type RankedSearchOptions, type SearchHit } from "./search-index.js";
import { estimateTokensFromText, truncateToTokens, unique } from "./utils.js";

export type RecallLevel = "cue" | "episode" | "resource" | "block";

export interface RecallOptions {
  readonly level?: RecallLevel;
  readonly limit?: number;
  readonly tokenBudget?: number;
  readonly search?: RankedSearchOptions;
}

export interface RecallItem {
  readonly level: RecallLevel;
  readonly title: string;
  readonly timeRange?: string;
  readonly hitReason: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly related: readonly string[];
  readonly exactRecovery: string;
}

export interface RecallResult {
  readonly generationHash: string;
  readonly query: string;
  readonly level: RecallLevel;
  readonly items: readonly RecallItem[];
  readonly tokenBudget: number;
  readonly renderedTokens: number;
}

function sourceId(hit: SearchHit): string {
  return hit.sourceRef.blockIndex === undefined ? hit.sourceRef.entryId : `${hit.sourceRef.entryId}:${hit.sourceRef.blockIndex}`;
}

function historyGetRecovery(entryId: string, blockIndex?: number): string {
  const entry = JSON.stringify(entryId);
  return blockIndex === undefined ? `history_get(${entry})` : `history_get(${entry}, blockIndex=${blockIndex})`;
}

function historyRangeRecovery(startEntryId: string, endEntryId: string): string {
  return `history_range(${JSON.stringify(startEntryId)}, ${JSON.stringify(endEntryId)})`;
}

function relatedIds(model: CausalMemoryModel, blockId: string): string[] {
  return unique(model.edges.flatMap((edge) => edge.fromBlockId === blockId ? [edge.toBlockId] : edge.toBlockId === blockId ? [edge.fromBlockId] : [])).slice(0, 6);
}

function cue(hit: SearchHit, model: CausalMemoryModel): RecallItem {
  const source = sourceId(hit);
  return {
    level: "cue",
    title: `${hit.label}${hit.resourceKey ? ` · ${hit.resourceKey}` : ""}`,
    ...(hit.timestamp === undefined ? {} : { timeRange: hit.timestamp }),
    hitReason: hit.hitReason,
    text: truncateToTokens(hit.snippet, 80, "…"),
    sourceIds: [source],
    related: relatedIds(model, hit.key),
    exactRecovery: historyGetRecovery(hit.sourceRef.entryId, hit.sourceRef.blockIndex),
  };
}

function episodeItem(hit: SearchHit, model: CausalMemoryModel): RecallItem {
  const episode = model.episodes.find((candidate) => candidate.blockIds.includes(hit.key) || candidate.sourceRange.start.entryId === hit.sourceRef.entryId)
    ?? model.episodes.find((candidate) => candidate.blockIds.some((id) => id.startsWith(hit.sourceRef.entryId)));
  if (!episode) return cue(hit, model);
  const start = episode.sourceRange.start.entryId;
  const end = episode.sourceRange.end.entryId;
  const certificate = episode.certificate;
  return {
    level: "episode",
    title: `${episode.open ? "Open" : "Completed"} episode · ${episode.episodeId}`,
    hitReason: hit.hitReason,
    text: [
      `Objective: ${episode.objective}`,
      episode.outcome ? `Outcome: ${episode.outcome}` : "Outcome: unresolved",
      certificate ? `Certificate: ${certificate.certificateHash}` : "Certificate: none; episode remains open",
      certificate?.changedResources.length ? `Changed resources: ${certificate.changedResources.map((resource) => resource.key).join(", ")}` : "",
      certificate?.unresolvedExceptions.length ? `Exceptions: ${certificate.unresolvedExceptions.join(" | ")}` : "",
    ].filter(Boolean).join("\n"),
    sourceIds: unique([start, end]),
    related: episode.blockIds.slice(0, 8),
    exactRecovery: historyRangeRecovery(start, end),
  };
}

function resourceItem(hit: SearchHit, index: LocalSearchIndex, model: CausalMemoryModel): RecallItem {
  if (!hit.resourceKey) return cue(hit, model);
  const resource = index.resourceLineage.resources.get(hit.resourceKey);
  if (!resource) return cue(hit, model);
  const sources = resource.versions.flatMap((version) => version.observations.map((observation) => observation.entryId));
  const current = resource.versions.find((version) => version.versionHash === resource.currentVersionHash)!;
  return {
    level: "resource",
    title: `${resource.kind} · ${resource.displayName}`,
    hitReason: `${hit.hitReason}; current resource version preferred`,
    text: [
      `Versions: ${resource.versions.length}. Volatility: ${resource.volatility.toFixed(3)}.`,
      `Current version: ${resource.currentVersionHash}.`,
      `Current observations: ${current.observations.map((observation) => observation.entryId).join(", ")}.`,
      ...resource.versions.filter((version) => version.superseded).slice(-5).map((version) => `Superseded ${version.versionHash}: ${version.observations.map((observation) => observation.entryId).join(", ")}`),
    ].join("\n"),
    sourceIds: unique(sources).slice(-20),
    related: relatedIds(model, hit.key),
    exactRecovery: current.observations.length === 1
      ? historyGetRecovery(current.observations[0]!.entryId)
      : historyRangeRecovery(current.observations[0]!.entryId, current.observations[current.observations.length - 1]!.entryId),
  };
}

function blockItem(hit: SearchHit, model: CausalMemoryModel): RecallItem {
  return {
    ...cue(hit, model),
    level: "block",
    text: hit.snippet,
  };
}

export function recallHistory(
  index: LocalSearchIndex,
  model: CausalMemoryModel,
  query: string,
  options: RecallOptions = {},
): RecallResult {
  const level = options.level ?? "cue";
  const tokenBudget = Math.min(2_000, Math.max(120, Math.floor(options.tokenBudget ?? (level === "cue" ? 600 : 1_200))));
  const search = searchLocalHistory(index, query, {
    ...options.search,
    stage: level === "cue" ? "cues" : "snippets",
    limit: Math.min(20, Math.max(1, options.limit ?? 8)),
    tokenBudget,
    includeNeighbors: false,
  });
  const primaryHits = search.hits.filter((hit) => !hit.context);
  const expanded = primaryHits.map((hit) => {
    if (level === "episode") return episodeItem(hit, model);
    if (level === "resource") return resourceItem(hit, index, model);
    if (level === "block") return blockItem(hit, model);
    return cue(hit, model);
  });
  let items: RecallItem[] = [];
  for (const item of expanded) {
    const tentative = [...items, item];
    const tentativeResult: RecallResult = { generationHash: index.generationHash, query, level, items: tentative, tokenBudget, renderedTokens: 0 };
    if (!renderBoundedRecall(tentativeResult).complete) break;
    items = tentative;
  }
  if (items.length === 0 && expanded.length > 0) {
    items = [expanded[0]!];
    const failClosed: RecallResult = { generationHash: index.generationHash, query, level, items, tokenBudget, renderedTokens: 0 };
    if (!renderBoundedRecall(failClosed).complete) throw new Error("History recall recovery cue cannot fit the supported response budget");
  }
  const preliminary: RecallResult = { generationHash: index.generationHash, query, level, items, tokenBudget, renderedTokens: 0 };
  const rendered = renderBoundedRecall(preliminary);
  if (!rendered.complete) throw new Error("History recall response cannot fit the supported response budget");
  return { ...preliminary, renderedTokens: estimateTokensFromText(rendered.text) };
}

function renderRecallItem(item: RecallItem): string {
  return [
    `${item.level.toUpperCase()} · ${item.title}`,
    item.timeRange ? `Time: ${item.timeRange}` : "",
    `Reason: ${item.hitReason}`,
    item.text,
    item.related.length ? `Related: ${item.related.join(", ")}` : "",
    `Exact recovery: ${item.exactRecovery}`,
  ].filter(Boolean).join("\n");
}

function compactOptional(text: string, maximumCharacters = 72): string {
  const characters = [...text];
  return characters.length <= maximumCharacters ? text : `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

function compactRecallItem(item: RecallItem): string {
  return [
    `${item.level.toUpperCase()}: ${compactOptional(item.title)}`,
    `Exact recovery: ${item.exactRecovery}`,
  ].join("\n");
}

interface BoundedRecallRendering {
  readonly text: string;
  readonly complete: boolean;
}

function renderBoundedRecall(result: RecallResult): BoundedRecallRendering {
  const joins = (sections: readonly string[]): string => sections.filter(Boolean).join("\n\n");
  const fits = (sections: readonly string[]): boolean => estimateTokensFromText(joins(sections)) <= result.tokenBudget;

  if (result.items.length === 0) {
    const sections = [`Staged recall · ${result.level}: no matching items.`];
    const generation = `Generation: ${result.generationHash}`;
    if (fits([...sections, generation])) sections.push(generation);
    return { text: joins(sections), complete: true };
  }

  let itemSections = result.items.map((item) => `Exact recovery: ${item.exactRecovery}`);
  if (!fits(itemSections)) {
    if (result.items.length !== 1) return { text: "", complete: false };
    itemSections = [`Recovery: repeat the same history_recall query with level=${result.level} and tokenBudget=2000.`];
    if (!fits(itemSections)) return { text: "", complete: false };
  }

  let header = "";
  let generation = "";
  let instruction = "";
  const compose = (): string[] => [header, generation, ...itemSections, instruction].filter(Boolean);
  const tryValue = (set: (value: string) => void, value: string): void => {
    set(value);
    if (!fits(compose())) set("");
  };

  tryValue((value) => { header = value; }, `Staged recall · ${result.level} · ${result.items.length} item(s) · response budget ${result.tokenBudget} estimated token(s)`);
  for (let index = 0; index < result.items.length; index += 1) {
    const previous = itemSections[index]!;
    itemSections[index] = compactRecallItem(result.items[index]!);
    if (!fits(compose())) itemSections[index] = previous;
  }
  for (let index = 0; index < result.items.length; index += 1) {
    const previous = itemSections[index]!;
    itemSections[index] = renderRecallItem(result.items[index]!);
    if (!fits(compose())) itemSections[index] = previous;
  }
  tryValue((value) => { generation = value; }, `Generation: ${result.generationHash}`);
  if (result.level === "cue") {
    tryValue((value) => { instruction = value; }, "Expand one item with history_recall level=episode, resource, or block. Use history_get for exact bytes.");
  }
  return { text: joins(compose()), complete: true };
}

export function renderRecall(result: RecallResult): string {
  const rendered = renderBoundedRecall(result);
  if (!rendered.complete) throw new Error("History recall response cannot fit the supported response budget");
  return rendered.text;
}
