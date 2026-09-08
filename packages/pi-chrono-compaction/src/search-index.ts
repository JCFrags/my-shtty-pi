import { parseHistoricalBlocks } from "./blocks.js";
import { buildResourceLineage, type ResourceKind, type ResourceLineageIndex } from "./resource-lineage.js";
import type { BlockKind, HistoricalBlock, ParsedSession, SourceRef } from "./types.js";
import { estimateTokensFromText, hashText, stableStringify, unique } from "./utils.js";

export type SearchMode = "ranked" | "exact" | "regex";
export type SearchStage = "cues" | "snippets";

export interface SearchFilters {
  readonly kinds?: readonly BlockKind[];
  readonly toolNames?: readonly string[];
  readonly error?: boolean;
  readonly unresolved?: boolean;
  readonly protected?: boolean;
  readonly resourceKinds?: readonly ResourceKind[];
  readonly resourceKey?: string;
  readonly currentState?: "current" | "superseded" | "any";
  readonly fromTimestamp?: string;
  readonly toTimestamp?: string;
}

export interface RankedSearchOptions {
  readonly mode?: SearchMode;
  readonly stage?: SearchStage;
  readonly limit?: number;
  readonly tokenBudget?: number;
  readonly cursor?: string;
  readonly caseSensitive?: boolean;
  readonly fuzzyPath?: boolean;
  readonly includeNeighbors?: boolean;
  readonly filters?: SearchFilters;
}

export interface SearchDocument {
  readonly key: string;
  readonly block: HistoricalBlock;
  readonly ordinal: number;
  readonly bodyTerms: ReadonlyMap<string, number>;
  readonly identifierTerms: ReadonlySet<string>;
  readonly pathTerms: ReadonlySet<string>;
  readonly exactHash: string;
  readonly normalizedHash: string;
  readonly length: number;
  readonly resourceKey?: string;
  readonly resourceKind?: ResourceKind;
  readonly resourceState: "current" | "superseded" | "unversioned";
}

export interface LocalSearchIndex {
  readonly schemaVersion: 2;
  readonly generationHash: string;
  readonly documents: readonly SearchDocument[];
  readonly documentByKey: ReadonlyMap<string, SearchDocument>;
  readonly postings: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly averageLength: number;
  readonly resourceLineage: ResourceLineageIndex;
}

export interface SearchHit {
  readonly key: string;
  readonly sourceRef: SourceRef;
  readonly kind: BlockKind;
  readonly label: string;
  readonly score: number;
  readonly hitReason: string;
  readonly snippet: string;
  readonly timestamp?: string;
  readonly toolName?: string;
  readonly resourceKey?: string;
  readonly resourceState: SearchDocument["resourceState"];
  readonly duplicateCount: number;
  readonly context: boolean;
  readonly recoveryCursor?: string;
}

export interface RankedSearchResult {
  readonly generationHash: string;
  readonly mode: SearchMode;
  readonly query: string;
  readonly totalCandidates: number;
  readonly tokenBudget: number;
  readonly returnedTokens: number;
  readonly hits: readonly SearchHit[];
  readonly nextCursor?: string;
  readonly indexStatus: "ready" | "rebuilt";
  readonly cacheHit: boolean;
}

const TOKEN = /[\p{L}\p{N}_./:@+\-]{2,}/gu;
const PATH = /(?:\.?\.?\/|\/)[\w@.+\-~]+(?:\/[\w@.+\-~]+)+|[\w@.+\-]+(?:\/[\w@.+\-]+)+/g;
const HASH = /\b[a-f0-9]{7,64}\b/gi;
const MAX_RESULTS = 50;
const MAX_RESULT_TOKENS = 2_000;
const DEFAULT_RESULT_TOKENS = 1_000;
export const MAX_SEARCH_RESULT_CACHE_ENTRIES = 64;
const cache = new WeakMap<LocalSearchIndex, Map<string, RankedSearchResult>>();

export function searchResultCacheStatus(index: LocalSearchIndex): { entries: number; limit: number } {
  return { entries: cache.get(index)?.size ?? 0, limit: MAX_SEARCH_RESULT_CACHE_ENTRIES };
}

function splitCamel(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_./:@+\-]+|\s+/).filter((part) => part.length >= 2);
}

function terms(text: string): string[] {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ");
  const raw = clean.match(TOKEN) ?? [];
  return raw.flatMap((term) => [term.toLowerCase(), ...splitCamel(term).map((part) => part.toLowerCase())]);
}

function termFrequency(values: readonly string[], cap = 12): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const value of values) frequencies.set(value, Math.min(cap, (frequencies.get(value) ?? 0) + 1));
  return frequencies;
}

function normalizedForDuplicate(text: string): string {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n").split("\n");
  const deduped = lines.filter((line, index) => line !== lines[index - 1]);
  return deduped.join("\n")
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\b/g, "<time>")
    .replace(/\b(?:pid|process)\s*[=:]?\s*\d+\b/gi, "pid=<n>")
    .replace(/\/tmp\/[\w./-]+/g, "/tmp/<path>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function paths(text: string): string[] {
  return unique([...(text.match(PATH) ?? [])].map((path) => path.replaceAll("\\", "/").toLowerCase()));
}

function blockKey(block: HistoricalBlock): string {
  return block.blockIndex === undefined ? block.entryId : `${block.entryId}:${block.blockIndex}`;
}

function sourceRef(block: HistoricalBlock): SourceRef {
  return block.blockIndex === undefined ? { entryId: block.entryId } : { entryId: block.entryId, blockIndex: block.blockIndex };
}

function resourceState(
  block: HistoricalBlock,
  lineage: ResourceLineageIndex,
): Pick<SearchDocument, "resourceKey" | "resourceKind" | "resourceState"> {
  const observation = lineage.observationByBlockId.get(block.id);
  if (!observation) return { resourceState: "unversioned" };
  const resource = lineage.resources.get(observation.resourceKey);
  const state = resource?.currentVersionHash === observation.versionHash ? "current" : "superseded";
  return { resourceKey: observation.resourceKey, resourceKind: observation.resourceKind, resourceState: state };
}

export function buildLocalSearchIndex(
  sessionOrBlocks: ParsedSession | readonly HistoricalBlock[],
  existingLineage?: ResourceLineageIndex,
): LocalSearchIndex {
  const blocks = Array.isArray(sessionOrBlocks)
    ? sessionOrBlocks as readonly HistoricalBlock[]
    : parseHistoricalBlocks((sessionOrBlocks as ParsedSession).entries, { includeHistoricalCompactions: false, includeMetadata: false });
  const lineage = existingLineage ?? buildResourceLineage(blocks);
  const documents: SearchDocument[] = blocks
    .filter((block) => block.kind !== "historical_compaction")
    .map((block, ordinal) => {
      const bodyTerms = termFrequency(terms(block.exactText));
      const identifierTerms = new Set(block.exactIdentifiers.flatMap((identifier) => terms(identifier)));
      const pathTerms = new Set(paths(`${block.exactText}\n${Object.values(block.toolArguments ?? {}).join(" ")}`));
      const resource = resourceState(block, lineage);
      return {
        key: blockKey(block),
        block,
        ordinal,
        bodyTerms,
        identifierTerms,
        pathTerms,
        exactHash: hashText(block.exactText),
        normalizedHash: hashText(normalizedForDuplicate(block.exactText)),
        length: Math.max(1, [...bodyTerms.values()].reduce((sum, value) => sum + value, 0)),
        ...resource,
      };
    });
  const postings = new Map<string, Map<string, number>>();
  for (const document of documents) {
    for (const [term, frequency] of document.bodyTerms) {
      const posting = postings.get(term) ?? new Map<string, number>();
      posting.set(document.key, frequency);
      postings.set(term, posting);
    }
  }
  const generationHash = hashText(stableStringify({
    schemaVersion: 2,
    documents: documents.map((document) => ({
      key: document.key,
      exactHash: document.exactHash,
      resourceKey: document.resourceKey,
      resourceState: document.resourceState,
    })),
    lineage: lineage.generationHash,
  }));
  return Object.freeze({
    schemaVersion: 2 as const,
    generationHash,
    documents: Object.freeze(documents),
    documentByKey: new Map(documents.map((document) => [document.key, document])),
    postings,
    documentFrequency: new Map([...postings].map(([term, posting]) => [term, posting.size])),
    averageLength: documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length),
    resourceLineage: lineage,
  });
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

function fuzzyPathScore(queryTerms: readonly string[], document: SearchDocument): number {
  if (queryTerms.length === 0 || document.pathTerms.size === 0) return 0;
  let score = 0;
  for (const query of queryTerms) {
    if (query.length < 3) continue;
    for (const path of document.pathTerms) {
      if (path === query) score = Math.max(score, 5);
      else if (path.includes(query)) score = Math.max(score, 3.5);
      else {
        const segments = path.split("/");
        if (segments.some((segment) => query.length >= 5 && editDistanceAtMostOne(query, segment))) score = Math.max(score, 2);
      }
    }
  }
  return score;
}

function applies(document: SearchDocument, filters: SearchFilters | undefined): boolean {
  if (!filters) return true;
  const block = document.block;
  if (filters.kinds && !filters.kinds.includes(block.kind)) return false;
  if (filters.toolNames && !filters.toolNames.includes(block.toolName ?? "")) return false;
  if (filters.error !== undefined && block.isError !== filters.error) return false;
  if (filters.unresolved !== undefined && block.unresolved !== filters.unresolved) return false;
  if (filters.protected !== undefined && block.protectedExact !== filters.protected) return false;
  if (filters.resourceKinds && (!document.resourceKind || !filters.resourceKinds.includes(document.resourceKind))) return false;
  if (filters.resourceKey !== undefined && document.resourceKey !== filters.resourceKey) return false;
  if (filters.currentState && filters.currentState !== "any" && document.resourceState !== filters.currentState) return false;
  if (filters.fromTimestamp && (!block.timestamp || block.timestamp < filters.fromTimestamp)) return false;
  if (filters.toTimestamp && (!block.timestamp || block.timestamp > filters.toTimestamp)) return false;
  return true;
}

interface ScoredDocument {
  document: SearchDocument;
  score: number;
  exactClass: number;
  reason: string;
}

function bm25(index: LocalSearchIndex, document: SearchDocument, queryTerms: readonly string[]): number {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of unique(queryTerms)) {
    const tf = document.bodyTerms.get(term) ?? 0;
    if (tf === 0) continue;
    const df = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (index.documents.length - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * document.length / Math.max(1, index.averageLength))));
  }
  return score;
}

function scoreDocuments(index: LocalSearchIndex, query: string, options: RankedSearchOptions): ScoredDocument[] {
  const queryTerms = terms(query);
  const lower = query.toLowerCase();
  const idMatch = query.match(/^([a-z0-9-]{6,})(?::(\d+))?$/i);
  const scored: ScoredDocument[] = [];
  for (const document of index.documents) {
    if (!applies(document, options.filters)) continue;
    const block = document.block;
    const blockLower = block.exactText.toLowerCase();
    let exactClass = 0;
    let reason = "BM25 lexical match";
    let score = bm25(index, document, queryTerms);
    if (idMatch && (document.key === query || block.entryId === idMatch[1])) {
      score += 1_000;
      exactClass = 4;
      reason = "direct source ID";
    }
    if (lower.length >= 2 && blockLower.includes(lower)) {
      score += 12;
      exactClass = Math.max(exactClass, 3);
      reason = "exact phrase and BM25";
    }
    if (block.exactIdentifiers.some((identifier) => identifier.toLowerCase() === lower)) {
      score += 20;
      exactClass = Math.max(exactClass, 3);
      reason = "exact identifier";
    }
    const exactPath = [...document.pathTerms].some((path) => path === lower || path.endsWith(`/${lower}`));
    if (exactPath) {
      score += 16;
      exactClass = Math.max(exactClass, 2);
      reason = "exact path";
    }
    if (options.fuzzyPath !== false) {
      const fuzzy = fuzzyPathScore(queryTerms, document);
      score += fuzzy;
      if (fuzzy > 0 && score === fuzzy) reason = "fuzzy path";
    }
    if (block.kind === "user" || block.kind === "custom_message") score += Math.min(3, score * 0.2);
    if (block.unresolved) score += Math.min(4, score * 0.25);
    if (block.isError) score += Math.min(3, score * 0.2);
    if (document.resourceState === "current") score += Math.min(3, score * 0.15);
    if (document.resourceState === "superseded") score *= 0.78;
    if (block.kind === "branch_summary") score *= 0.6;
    if (score <= 0) continue;
    const recency = index.documents.length <= 1 ? 0 : document.ordinal / (index.documents.length - 1);
    score += Math.min(score * 0.05, score * 0.05 * recency);
    scored.push({ document, score: Math.round(score * 1_000_000), exactClass, reason });
  }
  return scored.sort((a, b) =>
    b.score - a.score
    || b.exactClass - a.exactClass
    || b.document.ordinal - a.document.ordinal
    || (a.document.block.blockIndex ?? -1) - (b.document.block.blockIndex ?? -1)
    || a.document.block.entryId.localeCompare(b.document.block.entryId));
}

function exactDocuments(index: LocalSearchIndex, query: string, options: RankedSearchOptions): ScoredDocument[] {
  let pattern: RegExp;
  try {
    const source = options.mode === "regex" ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new Error(`Invalid history search pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  return index.documents.flatMap((document) => {
    if (!applies(document, options.filters)) return [];
    pattern.lastIndex = 0;
    return pattern.test(document.block.exactText)
      ? [{ document, score: 1_000_000, exactClass: 3, reason: options.mode === "regex" ? "regular expression" : "literal text" }]
      : [];
  });
}

function snippet(text: string, query: string, stage: SearchStage, caseSensitive = false): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const maximum = stage === "cues" ? 160 : 520;
  const source = caseSensitive ? clean : clean.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const at = source.indexOf(needle);
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(maximum * 0.35));
  const end = Math.min(clean.length, start + maximum);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).replace(/\s+/g, " ").trim()}${end < clean.length ? "…" : ""}`;
}

function hitFrom(scored: ScoredDocument, query: string, stage: SearchStage, duplicateCount: number, context = false): SearchHit {
  const block = scored.document.block;
  return {
    key: scored.document.key,
    sourceRef: sourceRef(block),
    kind: block.kind,
    label: block.label,
    score: context ? 0 : scored.score,
    hitReason: context ? "bounded neighboring context" : scored.reason,
    snippet: snippet(block.exactText, query, stage),
    ...(block.timestamp === undefined ? {} : { timestamp: block.timestamp }),
    ...(block.toolName === undefined ? {} : { toolName: block.toolName }),
    ...(scored.document.resourceKey === undefined ? {} : { resourceKey: scored.document.resourceKey }),
    resourceState: scored.document.resourceState,
    duplicateCount,
    context,
  };
}

function encodeCursor(generationHash: string, queryHash: string, offset: number): string {
  return Buffer.from(stableStringify({ generationHash, queryHash, offset })).toString("base64url");
}

function decodeCursor(cursor: string, generationHash: string, queryHash: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.generationHash !== generationHash || parsed.queryHash !== queryHash || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error("stale or invalid cursor");
    }
    return Number(parsed.offset);
  } catch (error) {
    throw new Error(`History search cursor rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function addNeighbors(index: LocalSearchIndex, hits: readonly SearchHit[], query: string, stage: SearchStage): SearchHit[] {
  const selectedKeys = new Set(hits.map((hit) => hit.key));
  const output: SearchHit[] = [];
  for (const hit of hits) {
    output.push(hit);
    const document = index.documentByKey.get(hit.key);
    if (!document) continue;
    const candidates = [index.documents[document.ordinal - 1], index.documents[document.ordinal + 1]].filter((value): value is SearchDocument => value !== undefined);
    const paired = document.block.toolCallId
      ? index.documents.find((candidate) => candidate.block.toolCallId === document.block.toolCallId && candidate.key !== document.key)
      : undefined;
    for (const neighbor of [...candidates, ...(paired ? [paired] : [])]) {
      if (selectedKeys.has(neighbor.key)) continue;
      selectedKeys.add(neighbor.key);
      output.push(hitFrom({ document: neighbor, score: 0, exactClass: 0, reason: "context" }, query, stage, 1, true));
      if (output.length >= hits.length * 3) break;
    }
  }
  return output;
}

export function searchLocalHistory(index: LocalSearchIndex, query: string, options: RankedSearchOptions = {}): RankedSearchResult {
  if (!query.trim()) throw new Error("history_search query must not be empty");
  const mode = options.mode ?? "ranked";
  const stage = options.stage ?? "cues";
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(options.limit ?? 10)));
  const tokenBudget = Math.min(MAX_RESULT_TOKENS, Math.max(120, Math.floor(options.tokenBudget ?? DEFAULT_RESULT_TOKENS)));
  const queryHash = hashText(stableStringify({ query, mode, stage, limit, tokenBudget, options: { ...options, cursor: undefined } }));
  const offset = options.cursor ? decodeCursor(options.cursor, index.generationHash, queryHash) : 0;
  const cacheKey = stableStringify({ queryHash, offset });
  const indexCache = cache.get(index) ?? new Map<string, RankedSearchResult>();
  cache.set(index, indexCache);
  const cached = indexCache.get(cacheKey);
  if (cached) {
    indexCache.delete(cacheKey);
    indexCache.set(cacheKey, cached);
    const cacheHit = { ...cached, cacheHit: true };
    return { ...cacheHit, returnedTokens: estimateTokensFromText(renderRankedSearch(cacheHit)) };
  }

  const ranked = mode === "ranked" ? scoreDocuments(index, query, options) : exactDocuments(index, query, options);
  const duplicateCounts = new Map<string, number>();
  for (const scored of ranked) duplicateCounts.set(scored.document.normalizedHash, (duplicateCounts.get(scored.document.normalizedHash) ?? 0) + 1);
  const seenHashes = new Set<string>();
  const perEntry = new Map<string, number>();
  const perResource = new Map<string, number>();
  const diverse: ScoredDocument[] = [];
  for (const scored of ranked) {
    const document = scored.document;
    if (seenHashes.has(document.normalizedHash)) continue;
    if ((perEntry.get(document.block.entryId) ?? 0) >= 2) continue;
    if (document.resourceKey && (perResource.get(document.resourceKey) ?? 0) >= 3) continue;
    seenHashes.add(document.normalizedHash);
    perEntry.set(document.block.entryId, (perEntry.get(document.block.entryId) ?? 0) + 1);
    if (document.resourceKey) perResource.set(document.resourceKey, (perResource.get(document.resourceKey) ?? 0) + 1);
    diverse.push(scored);
  }

  const baseResult = (hits: readonly SearchHit[], nextOffset: number, includeNext = true): RankedSearchResult => ({
    generationHash: index.generationHash,
    mode,
    query,
    totalCandidates: diverse.length,
    tokenBudget,
    returnedTokens: 0,
    hits,
    ...(includeNext && nextOffset < diverse.length ? { nextCursor: encodeCursor(index.generationHash, queryHash, nextOffset) } : {}),
    indexStatus: "ready",
    cacheHit: false,
  });

  let selected: SearchHit[] = [];
  for (const [relativeOffset, scored] of diverse.slice(offset, offset + limit).entries()) {
    const hit: SearchHit = {
      ...hitFrom(scored, query, stage, duplicateCounts.get(scored.document.normalizedHash) ?? 1),
      recoveryCursor: encodeCursor(index.generationHash, queryHash, offset + relativeOffset),
    };
    const tentative = [...selected, hit];
    const tentativeResult = baseResult(tentative, offset + tentative.length);
    if (!renderBoundedSearch(tentativeResult).complete) break;
    selected = tentative;
  }

  if (selected.length === 0 && offset < diverse.length) {
    const scored = diverse[offset]!;
    selected = [{
      ...hitFrom(scored, query, stage, duplicateCounts.get(scored.document.normalizedHash) ?? 1),
      recoveryCursor: encodeCursor(index.generationHash, queryHash, offset),
    }];
    if (!renderBoundedSearch(baseResult(selected, offset + 1)).complete) {
      const failClosed = baseResult(selected, offset + 1, false);
      if (!renderBoundedSearch(failClosed).complete) throw new Error("History search recovery cue cannot fit the supported response budget");
    }
  }

  const nextOffset = offset + selected.length;
  let bounded: SearchHit[] = [...selected];
  if (options.includeNeighbors && selected.length > 0) {
    const contextCandidates = addNeighbors(index, selected, query, stage).filter((hit) => !selected.some((selectedHit) => selectedHit.key === hit.key));
    for (const context of contextCandidates) {
      const tentative = [...bounded, context];
      if (!renderBoundedSearch(baseResult(tentative, nextOffset)).complete) break;
      bounded = tentative;
    }
  }

  let preliminary = baseResult(bounded, nextOffset);
  if (!renderBoundedSearch(preliminary).complete) preliminary = baseResult(bounded, nextOffset, false);
  const rendered = renderBoundedSearch(preliminary);
  if (!rendered.complete) throw new Error("History search response cannot fit the supported response budget");
  const result = { ...preliminary, returnedTokens: estimateTokensFromText(rendered.text) };
  indexCache.set(cacheKey, result);
  while (indexCache.size > MAX_SEARCH_RESULT_CACHE_ENTRIES) indexCache.delete(indexCache.keys().next().value!);
  return result;
}

function exactRecovery(hit: SearchHit): string {
  const entry = JSON.stringify(hit.sourceRef.entryId);
  return hit.sourceRef.blockIndex === undefined
    ? `history_get(${entry})`
    : `history_get(${entry}, blockIndex=${hit.sourceRef.blockIndex})`;
}

function compactOptional(text: string, maximumCharacters = 72): string {
  const characters = [...text];
  return characters.length <= maximumCharacters ? text : `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

function renderSearchHit(hit: SearchHit): string {
  return [
    `${hit.context ? "Context" : "Hit"}: ${hit.label} · ${hit.resourceState} · ${hit.hitReason}${hit.context ? "" : ` · score ${hit.score}`}`,
    hit.resourceKey ? `Resource: ${hit.resourceKey}` : "",
    `Exact recovery: ${exactRecovery(hit)}${hit.duplicateCount > 1 ? ` · ${hit.duplicateCount} near-duplicate occurrence(s)` : ""}`,
    hit.snippet,
  ].filter(Boolean).join("\n");
}

function compactSearchHit(hit: SearchHit): string {
  return [
    `${hit.context ? "Context" : "Hit"}: ${compactOptional(hit.label)}`,
    `Exact recovery: ${exactRecovery(hit)}`,
  ].join("\n");
}

interface BoundedSearchRendering {
  readonly text: string;
  readonly complete: boolean;
}

function renderBoundedSearch(result: RankedSearchResult): BoundedSearchRendering {
  const joins = (sections: readonly string[]): string => sections.filter(Boolean).join("\n\n");
  const fits = (sections: readonly string[]): boolean => estimateTokensFromText(joins(sections)) <= result.tokenBudget;
  let next = result.nextCursor ? `More: use cursor ${result.nextCursor}` : "";

  if (result.hits.length === 0) {
    const required = ["History search: no matches."];
    const optional = [
      `History search · ${result.mode} · 0/${result.totalCandidates} hit(s) · response budget ${result.tokenBudget} estimated token(s)`,
      `Index generation: ${result.generationHash}`,
    ];
    for (const section of optional) if (fits([...required, section])) required.push(section);
    return { text: joins(required), complete: true };
  }

  let hitSections = result.hits.map((hit) => `Exact recovery: ${exactRecovery(hit)}`);
  let ordered = (): string[] => [...hitSections, ...(next ? [next] : [])];
  if (!fits(ordered())) {
    if (result.hits.length !== 1) return { text: "", complete: false };
    const retry = "Recovery: repeat the same history_search query and filters with tokenBudget=2000 and no cursor.";
    hitSections = [retry];
    next = "";
    if (!fits(ordered())) return { text: "", complete: false };
  }

  let header = "";
  let generation = "";
  let instruction = "";
  const compose = (): string[] => [header, generation, ...hitSections, ...(next ? [next] : []), instruction].filter(Boolean);
  const tryValue = (set: (value: string) => void, value: string): void => {
    set(value);
    if (!fits(compose())) set("");
  };

  tryValue((value) => { header = value; }, `History search · ${result.mode} · ${result.hits.filter((hit) => !hit.context).length}/${result.totalCandidates} hit(s) · response budget ${result.tokenBudget} estimated token(s)`);
  for (let index = 0; index < result.hits.length; index += 1) {
    const previous = hitSections[index]!;
    hitSections[index] = compactSearchHit(result.hits[index]!);
    if (!fits(compose())) hitSections[index] = previous;
  }
  for (let index = 0; index < result.hits.length; index += 1) {
    const previous = hitSections[index]!;
    hitSections[index] = renderSearchHit(result.hits[index]!);
    if (!fits(compose())) hitSections[index] = previous;
  }
  tryValue((value) => { generation = value; }, `Index generation: ${result.generationHash}`);
  tryValue((value) => { instruction = value; }, "Expand exact bytes with history_get(entryId, blockIndex?).");
  return { text: joins(compose()), complete: true };
}

export function renderRankedSearch(result: RankedSearchResult): string {
  const rendered = renderBoundedSearch(result);
  if (!rendered.complete) throw new Error("History search response cannot fit the supported response budget");
  return rendered.text;
}
