import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  precomputeCandidateRepresentations,
  type CandidatePrecomputeRecord,
} from "./candidates.js";
import { parseHistoricalBlocks } from "./blocks.js";
import { REDUCER_VERSIONS } from "./reducers/index.js";
import type { CompactorConfig, HistoricalBlock, SessionEntryLike } from "./types.js";
import { hashText, stableStringify } from "./utils.js";

export const INCREMENTAL_CACHE_SCHEMA_VERSION = 2;
export const DEFAULT_INCREMENTAL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_INCREMENTAL_CACHE_MAX_ENTRIES = 20_000;

export interface IncrementalCacheIdentity {
  readonly sessionPath: string;
  readonly sessionId?: string;
  readonly configHash: string;
  readonly reducerHash: string;
}

export interface IncrementalSourceDescriptor {
  readonly id: string;
  readonly parentId: string | null;
  readonly sourceHash: string;
}

export type IncrementalTransition =
  | "new"
  | "exact-hit"
  | "append"
  | "session-replacement"
  | "config-change"
  | "reducer-change"
  | "truncation"
  | "rewrite-or-branch-switch";

export interface IncrementalCheckpointMetrics {
  readonly transition: IncrementalTransition;
  readonly sourceEntries: number;
  readonly appendedEntries: number;
  readonly parsedEntries: number;
  readonly sourceBlocks: number;
  readonly reusedCandidates: number;
  readonly recomputedCandidates: number;
  readonly skippedProtectedBlocks: number;
}

export interface PersistedIncrementalCheckpoint {
  readonly schemaVersion: 2;
  readonly identity: IncrementalCacheIdentity;
  readonly leafId: string | null;
  readonly orderedSourceHash: string;
  readonly sourceEntries: readonly IncrementalSourceDescriptor[];
  readonly candidates: readonly CandidatePrecomputeRecord[];
  readonly metrics: IncrementalCheckpointMetrics;
}

export interface IncrementalRuntimeCheckpoint extends PersistedIncrementalCheckpoint {
  readonly blocks: readonly HistoricalBlock[];
}

export interface IncrementalCheckpointOptions {
  readonly previous?: PersistedIncrementalCheckpoint | IncrementalRuntimeCheckpoint;
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
}

export interface ValidatedIncrementalCandidates {
  readonly ok: boolean;
  readonly reason: string;
  readonly candidates: ReadonlyMap<string, CandidatePrecomputeRecord>;
}

export function incrementalCachePathForSession(sessionPath: string): string {
  return `${sessionPath}.chrono-incremental-v2.json`;
}

export function incrementalReducerHash(): string {
  return hashText(stableStringify({
    schema: INCREMENTAL_CACHE_SCHEMA_VERSION,
    reducers: REDUCER_VERSIONS,
    candidatePrecomputeSchema: 2,
  }));
}

export function incrementalConfigHash(config: CompactorConfig): string {
  return hashText(stableStringify({
    semanticMaxTokens: config.semanticMaxTokens,
    enableSemanticCompression: config.enableSemanticCompression,
    emergencyAllowAbsent: config.emergencyAllowAbsent,
  }));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Incremental preprocessing aborted");
}

function sourceDescriptors(entries: readonly SessionEntryLike[]): IncrementalSourceDescriptor[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`Incremental preprocessing refused source entry ${index} without an ID.`);
    }
    if (seen.has(entry.id)) throw new Error(`Incremental preprocessing refused duplicate source entry ID ${entry.id}.`);
    seen.add(entry.id);
    const expectedParent = index === 0 ? undefined : entries[index - 1]?.id;
    if (index > 0 && entry.parentId !== expectedParent) {
      throw new Error(`Incremental preprocessing refused a non-branch sequence at entry ${entry.id}.`);
    }
    return {
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      sourceHash: hashText(stableStringify(entry)),
    };
  });
}

function sameDescriptor(left: IncrementalSourceDescriptor | undefined, right: IncrementalSourceDescriptor | undefined): boolean {
  return left?.id === right?.id && left?.parentId === right?.parentId && left?.sourceHash === right?.sourceHash;
}

function prefixMatches(
  prefix: readonly IncrementalSourceDescriptor[],
  complete: readonly IncrementalSourceDescriptor[],
): boolean {
  return prefix.length <= complete.length && prefix.every((entry, index) => sameDescriptor(entry, complete[index]));
}

function transitionFor(
  previous: PersistedIncrementalCheckpoint | IncrementalRuntimeCheckpoint | undefined,
  identity: IncrementalCacheIdentity,
  current: readonly IncrementalSourceDescriptor[],
): IncrementalTransition {
  if (!previous) return "new";
  if (previous.schemaVersion !== INCREMENTAL_CACHE_SCHEMA_VERSION) return "rewrite-or-branch-switch";
  if (previous.identity.sessionPath !== identity.sessionPath || previous.identity.sessionId !== identity.sessionId) {
    return "session-replacement";
  }
  if (previous.identity.configHash !== identity.configHash) return "config-change";
  if (previous.identity.reducerHash !== identity.reducerHash) return "reducer-change";
  if (previous.sourceEntries.length === current.length && prefixMatches(previous.sourceEntries, current)) return "exact-hit";
  if (prefixMatches(previous.sourceEntries, current)) return "append";
  if (prefixMatches(current, previous.sourceEntries)) return "truncation";
  return "rewrite-or-branch-switch";
}

function withoutPairing(attributes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output = { ...attributes };
  delete output.pairedCallEntryId;
  delete output.pairedCallBlockIndex;
  delete output.pairedArguments;
  delete output.pairedCallText;
  delete output.pairedResultEntryId;
  delete output.pairedResultBlockIndex;
  delete output.pairedResultIsError;
  return output;
}

function reconcilePairing(blocks: readonly HistoricalBlock[]): HistoricalBlock[] {
  const mutable = blocks.map((block) => ({ ...block, attributes: withoutPairing(block.attributes) }));
  const callsById = new Map<string, number>();
  mutable.forEach((block, index) => {
    if (block.kind === "tool_call" && block.toolCallId) callsById.set(block.toolCallId, index);
  });
  mutable.forEach((block, index) => {
    if (block.kind !== "tool_result" || !block.toolCallId) return;
    const callIndex = callsById.get(block.toolCallId);
    if (callIndex === undefined) return;
    const call = mutable[callIndex];
    if (!call) return;
    mutable[index] = {
      ...block,
      toolName: !block.toolName || block.toolName === "unknown" ? call.toolName : block.toolName,
      toolArguments: call.toolArguments,
      attributes: {
        ...block.attributes,
        pairedCallEntryId: call.entryId,
        pairedCallBlockIndex: call.blockIndex,
        pairedArguments: call.toolArguments,
        pairedCallText: call.exactText,
      },
    };
    mutable[callIndex] = {
      ...call,
      attributes: {
        ...call.attributes,
        pairedResultEntryId: block.entryId,
        pairedResultBlockIndex: block.blockIndex,
        pairedResultIsError: block.isError,
      },
    };
  });
  return mutable.map((block) => Object.freeze({ ...block, sourceRefs: Object.freeze([...block.sourceRefs]) }));
}

function hasRuntimeBlocks(
  value: PersistedIncrementalCheckpoint | IncrementalRuntimeCheckpoint | undefined,
): value is IncrementalRuntimeCheckpoint {
  return value !== undefined && Array.isArray((value as Partial<IncrementalRuntimeCheckpoint>).blocks);
}

function appendBlocks(
  previous: IncrementalRuntimeCheckpoint,
  entries: readonly SessionEntryLike[],
  start: number,
): HistoricalBlock[] {
  const suffix = parseHistoricalBlocks(entries.slice(start), {
    includeHistoricalCompactions: false,
    includeMetadata: false,
  }).map((block) => Object.freeze({ ...block, entryIndex: block.entryIndex + start }));
  return reconcilePairing([...previous.blocks, ...suffix]);
}

function candidateMap(
  checkpoint: PersistedIncrementalCheckpoint | IncrementalRuntimeCheckpoint | undefined,
): ReadonlyMap<string, CandidatePrecomputeRecord> {
  return new Map((checkpoint?.candidates ?? []).map((record) => [record.blockId, record]));
}

export async function buildIncrementalCheckpoint(
  entries: readonly SessionEntryLike[],
  identity: IncrementalCacheIdentity,
  config: CompactorConfig,
  options: IncrementalCheckpointOptions = {},
): Promise<IncrementalRuntimeCheckpoint> {
  throwIfAborted(options.signal);
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_INCREMENTAL_CACHE_MAX_ENTRIES));
  if (entries.length > maxEntries) {
    throw new Error(`Incremental preprocessing refused ${entries.length} entries above the ${maxEntries}-entry bound.`);
  }
  const descriptors = sourceDescriptors(entries);
  const transition = transitionFor(options.previous, identity, descriptors);
  const appendStart = transition === "append" ? options.previous?.sourceEntries.length ?? 0 : entries.length;
  let blocks: HistoricalBlock[];
  let parsedEntries: number;
  if (transition === "append" && hasRuntimeBlocks(options.previous)) {
    blocks = appendBlocks(options.previous, entries, appendStart);
    parsedEntries = entries.length - appendStart;
  } else if (transition === "exact-hit" && hasRuntimeBlocks(options.previous)) {
    blocks = [...options.previous.blocks];
    parsedEntries = 0;
  } else {
    blocks = parseHistoricalBlocks(entries, {
      includeHistoricalCompactions: false,
      includeMetadata: false,
    });
    parsedEntries = entries.length;
  }
  throwIfAborted(options.signal);

  const priorCandidates = ["append", "exact-hit"].includes(transition)
    ? candidateMap(options.previous)
    : new Map<string, CandidatePrecomputeRecord>();
  const precomputed = await precomputeCandidateRepresentations(blocks, config, priorCandidates, options.signal);
  const leafId = descriptors[descriptors.length - 1]?.id ?? null;
  const persistedCandidates = [...precomputed.records.values()];
  const metrics: IncrementalCheckpointMetrics = {
    transition,
    sourceEntries: entries.length,
    appendedEntries: transition === "append" ? entries.length - appendStart : 0,
    parsedEntries,
    sourceBlocks: blocks.length,
    reusedCandidates: precomputed.reused,
    recomputedCandidates: precomputed.recomputed,
    skippedProtectedBlocks: precomputed.skippedProtected,
  };
  return {
    schemaVersion: INCREMENTAL_CACHE_SCHEMA_VERSION,
    identity,
    leafId,
    orderedSourceHash: hashText(stableStringify(descriptors)),
    sourceEntries: descriptors,
    candidates: persistedCandidates,
    metrics,
    blocks,
  };
}

export function persistedIncrementalCheckpoint(
  checkpoint: IncrementalRuntimeCheckpoint,
): PersistedIncrementalCheckpoint {
  const { blocks: _blocks, ...persisted } = checkpoint;
  return persisted;
}

function isCandidateRecord(value: unknown): value is CandidatePrecomputeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CandidatePrecomputeRecord>;
  return typeof record.blockId === "string"
    && typeof record.key === "string"
    && typeof record.integrityHash === "string"
    && Array.isArray(record.candidates)
    && record.candidates.every((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const item = candidate as { level?: unknown; text?: unknown; sourceRefs?: unknown };
      return item.level !== "raw"
        && item.level !== "normalized"
        && typeof item.text === "string"
        && Array.isArray(item.sourceRefs);
    });
}

function isPersistedCheckpoint(value: unknown): value is PersistedIncrementalCheckpoint {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedIncrementalCheckpoint>;
  return record.schemaVersion === INCREMENTAL_CACHE_SCHEMA_VERSION
    && typeof record.identity?.sessionPath === "string"
    && typeof record.identity?.configHash === "string"
    && typeof record.identity?.reducerHash === "string"
    && (record.leafId === null || typeof record.leafId === "string")
    && typeof record.orderedSourceHash === "string"
    && Array.isArray(record.sourceEntries)
    && record.sourceEntries.every((entry) => typeof entry.id === "string" && typeof entry.sourceHash === "string")
    && Array.isArray(record.candidates)
    && record.candidates.every(isCandidateRecord)
    && record.metrics !== undefined;
}

export async function readIncrementalCheckpoint(
  path: string,
  maxBytes = DEFAULT_INCREMENTAL_CACHE_MAX_BYTES,
): Promise<PersistedIncrementalCheckpoint | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPersistedCheckpoint(parsed)) return undefined;
    if (hashText(stableStringify(parsed.sourceEntries)) !== parsed.orderedSourceHash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeIncrementalCheckpoint(
  path: string,
  checkpoint: PersistedIncrementalCheckpoint | IncrementalRuntimeCheckpoint,
  maxBytes = DEFAULT_INCREMENTAL_CACHE_MAX_BYTES,
): Promise<void> {
  const persisted = "blocks" in checkpoint ? persistedIncrementalCheckpoint(checkpoint) : checkpoint;
  const text = `${stableStringify(persisted, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error(`Incremental checkpoint exceeds the ${maxBytes}-byte storage bound.`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function validateIncrementalCheckpoint(
  checkpoint: PersistedIncrementalCheckpoint | IncrementalRuntimeCheckpoint | undefined,
  entries: readonly SessionEntryLike[],
  identity: IncrementalCacheIdentity,
): ValidatedIncrementalCandidates {
  if (!checkpoint) return { ok: false, reason: "missing checkpoint", candidates: new Map() };
  if (checkpoint.schemaVersion !== INCREMENTAL_CACHE_SCHEMA_VERSION) {
    return { ok: false, reason: "schema changed", candidates: new Map() };
  }
  if (checkpoint.identity.sessionPath !== identity.sessionPath || checkpoint.identity.sessionId !== identity.sessionId) {
    return { ok: false, reason: "session changed", candidates: new Map() };
  }
  if (checkpoint.identity.configHash !== identity.configHash) {
    return { ok: false, reason: "configuration changed", candidates: new Map() };
  }
  if (checkpoint.identity.reducerHash !== identity.reducerHash) {
    return { ok: false, reason: "reducer version changed", candidates: new Map() };
  }
  let descriptors: IncrementalSourceDescriptor[];
  try {
    descriptors = sourceDescriptors(entries);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), candidates: new Map() };
  }
  if (!prefixMatches(checkpoint.sourceEntries, descriptors) || checkpoint.sourceEntries.length !== descriptors.length) {
    return { ok: false, reason: "ordered source IDs or hashes changed", candidates: new Map() };
  }
  if (hashText(stableStringify(descriptors)) !== checkpoint.orderedSourceHash) {
    return { ok: false, reason: "ordered source hash changed", candidates: new Map() };
  }
  return { ok: true, reason: "validated exact checkpoint", candidates: candidateMap(checkpoint) };
}
