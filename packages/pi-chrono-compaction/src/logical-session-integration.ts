import { createHash } from "node:crypto";
import type { CapsuleCatalogView, ScopedBodySourceRef, ScopedRawSourceRef } from "./capsule-contract.js";
import { composeStoredSelection } from "./context-composer.js";
import { composeBoundedMemory } from "./bounded-memory.js";
import { LOGICAL_CHECKPOINT_TYPE, validateLogicalStateCheckpoints } from "./logical-session-checkpoints.js";
import type { EpisodeStateSelection, EpisodeStateSelectionItem, EpisodeStateSelectionProposition } from "./episode-state-contract.js";
import type { LogicalActivationBinding } from "./logical-session-routing.js";
import { resolveLogicalShardRoutes } from "./logical-session-routing.js";
import type { ContinuationCandidate } from "./logical-session-rollover.js";
import type { LogicalSessionManifest } from "./logical-session-contract.js";
import type { SessionEntryLike } from "./types.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const provisionalReplacementKey = Symbol.for("pi-chrono-compact.provisional-logical-replacements.v1");
function provisionalReplacements(): Set<string> {
  const processState = globalThis as typeof globalThis & { [provisionalReplacementKey]?: Set<string> };
  return processState[provisionalReplacementKey] ??= new Set<string>();
}

/** Mark only the parent of an in-process manual logical replacement. The global
 * symbol survives Pi's fresh extension module instance during session replacement. */
export function markProvisionalLogicalReplacement(parentSession: string): () => void {
  const replacements = provisionalReplacements();
  if (!parentSession.startsWith("/") || replacements.size >= 8 || replacements.has(parentSession)) {
    throw new Error("logical-session-provisional-replacement-invalid");
  }
  replacements.add(parentSession);
  return () => { replacements.delete(parentSession); };
}

/** Consume the one-shot marker before Pi 0.85.1 setup appends the continuation. */
export function consumeProvisionalLogicalReplacement(parentSession: string): boolean {
  const replacements = provisionalReplacements();
  if (!replacements.has(parentSession)) return false;
  replacements.delete(parentSession);
  return true;
}

export interface RecordedLogicalAdoptionBinding {
  readonly schemaVersion: 1;
  readonly logicalSessionId: string;
  readonly branchId: string;
  readonly shardId: string;
}

export function logicalAdoptionBinding(manifest: LogicalSessionManifest, branchId: string): RecordedLogicalAdoptionBinding {
  const branch = manifest.branches.find(value => value.branchId === branchId);
  const shard = branch && manifest.shards.find(value => value.shardId === branch.activeShardId);
  if (!branch || branch.parent || branch.shardIds.length !== 1 || !shard || shard.ordinal !== 0 || shard.state !== "active") {
    throw new Error("logical-session-adoption-invalid");
  }
  return { schemaVersion: 1, logicalSessionId: manifest.logicalSessionId, branchId, shardId: shard.shardId };
}

/** Read the one non-model adoption marker persisted in shard zero. */
export function recordedLogicalAdoptionBinding(entries: readonly SessionEntryLike[]): RecordedLogicalAdoptionBinding | undefined {
  const matches = entries.filter(entry => entry.type === "custom" && (entry as Record<string, unknown>).customType === "chrono-logical-adoption");
  if (matches.length !== 1) return undefined;
  const data = record((matches[0] as Record<string, unknown>).data);
  if (!data || data.schemaVersion !== 1 || !validUuid(data.logicalSessionId) || typeof data.branchId !== "string"
    || !validUuid(data.shardId)) return undefined;
  return { schemaVersion: 1, logicalSessionId: data.logicalSessionId, branchId: data.branchId, shardId: data.shardId };
}

export interface RecordedLogicalBinding extends LogicalActivationBinding {
  readonly operationId: string;
  readonly fromShardId: string;
  readonly summaryHash: string;
}

/** Accept only the one model-visible continuation whose content and manifest binding agree exactly. */
export function recordedLogicalBinding(entries: readonly SessionEntryLike[]): RecordedLogicalBinding | undefined {
  const matches = entries.filter(entry => entry.type === "custom_message" && (entry as unknown as Record<string, unknown>).customType === "chrono-logical-continuation");
  if (matches.length !== 1) return undefined;
  const entry = matches[0] as unknown as Record<string, unknown>;
  const details = record(entry.details);
  const content = entry.content;
  if (!details || typeof content !== "string" || details.schemaVersion !== 1 || !validUuid(details.operationId)
    || !validUuid(details.logicalSessionId) || typeof details.branchId !== "string" || !validUuid(details.fromShardId) || !validUuid(details.toShardId)
    || !validHash(details.continuationHash) || !validHash(details.summaryHash) || hash(content) !== details.summaryHash) return undefined;
  return { schemaVersion: 1, operationId: details.operationId, logicalSessionId: details.logicalSessionId,
    branchId: details.branchId, fromShardId: details.fromShardId, shardId: details.toShardId, continuationHash: details.continuationHash,
    summaryHash: details.summaryHash };
}

export function replacementContainsOnlyBootstrap(entries: readonly SessionEntryLike[]): boolean {
  return entries.every(entry => ["model_change", "thinking_level_change", "session_info"].includes(entry.type));
}

export function replacementContainsOnlyContinuation(entries: readonly SessionEntryLike[], binding: RecordedLogicalBinding): boolean {
  let continuationCount = 0;
  const checkpoints: unknown[] = [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === LOGICAL_CHECKPOINT_TYPE && continuationCount === 0) {
      checkpoints.push({ customType: entry.customType, data: entry.data });
      continue;
    }
    if (entry.type === "custom_message" && (entry as unknown as Record<string, unknown>).customType === "chrono-logical-continuation") {
      continuationCount += 1;
      continue;
    }
    if (!["model_change", "thinking_level_change", "session_info"].includes(entry.type)) return false;
  }
  try { validateLogicalStateCheckpoints(checkpoints); } catch { return false; }
  return continuationCount === 1 && recordedLogicalBinding(entries)?.continuationHash === binding.continuationHash;
}

const mandatory = (item: Pick<EpisodeStateSelectionItem, "kind">): boolean => ["restriction", "openwork", "blocker", "goal"].includes(item.kind);
const coveredPropositions = (item: EpisodeStateSelectionItem): readonly (EpisodeStateSelectionItem | EpisodeStateSelectionProposition)[] => {
  if (!item.coveredPropositions) return [item];
  if (!item.representationKey || item.coveredPropositions.length < 1
    || item.coveredPropositions.some(value => value.representationKey !== item.representationKey)) {
    throw new Error("logical-session-continuation-evidence-invalid");
  }
  return [item, ...item.coveredPropositions];
};

/** Reuse the existing M10 continuation contract when optional derived stores lag.
 * The caller must still independently pin the exact source leaf and safe idle. */
export function buildBoundedContinuationCandidate(input: {
  readonly manifest: LogicalSessionManifest; readonly branchId: string; readonly sourceLeafEntryId: string;
  readonly sourceView: CapsuleCatalogView; readonly entries: readonly SessionEntryLike[];
  readonly previousSummary?: string; readonly combinedCeilingTokens: number;
}): ContinuationCandidate {
  const branch = input.manifest.branches.find(value => value.branchId === input.branchId);
  const shard = branch && input.manifest.shards.find(value => value.shardId === branch.activeShardId);
  if (!shard || input.entries.at(-1)?.id !== input.sourceLeafEntryId) throw new Error("logical-session-continuation-evidence-invalid");
  const firstKeptEntryId = "chrono-logical-new-shard";
  const bounded = composeBoundedMemory({ branchEntries: [...input.entries,
    { type: "message", id: firstKeptEntryId, parentId: input.sourceLeafEntryId }], cutIndex: input.entries.length,
    firstKeptEntryId, rawTailTokens: 0, combinedCeilingTokens: input.combinedCeilingTokens,
    previousSummary: input.previousSummary, reason: "derived memory unavailable; exact catalog cut retained" });
  const source = { catalogStoreKey: input.sourceView.storeKey, catalogGeneration: input.sourceView.generation,
    sessionKey: input.sourceView.sessionKey, branchKey: input.sourceView.branchKey,
    eventCut: input.sourceView.eventCut, entryId: input.sourceLeafEntryId };
  const coveredShards = resolveLogicalShardRoutes(input.manifest, input.branchId).map(route => ({ shardId: route.shardId,
    ...(route.shardId === shard.shardId ? source : route.catalog ?? (() => { throw new Error("logical-session-route-unpinned"); })()) }));
  const payloadHash = hash(JSON.stringify(bounded.receipt));
  return { logicalSessionId: input.manifest.logicalSessionId, branchId: input.branchId, fromShardId: shard.shardId,
    source, coveredShards, summary: bounded.summary, composition: { schemaVersion: 1, payloadHash, artifactHash: payloadHash,
      combinedTokens: bounded.receipt.combinedTokens, combinedCeilingTokens: input.combinedCeilingTokens,
      validation: { safeTail: true, withinCombinedCeiling: true, protectedCoverageComplete: false, openWorkCoverageComplete: false } },
    mandatory: { protectedEligible: 0, protectedCovered: 0, openWorkEligible: 0, openWorkCovered: 0, omittedMandatory: [] } };
}

/** Build continuation evidence from the exact pinned selection and rendered artifact. No caller supplies completeness flags or counts. */
export function buildManualContinuationCandidate(input: {
  readonly manifest: LogicalSessionManifest;
  readonly branchId: string;
  readonly sourceLeafEntryId: string;
  readonly regularPiSummary: string;
  readonly selection: EpisodeStateSelection;
  readonly recover: (view: CapsuleCatalogView, source: ScopedBodySourceRef | ScopedRawSourceRef) => string;
  readonly combinedCeilingTokens: number;
  readonly toolPairSafe: boolean;
}): ContinuationCandidate {
  const branch = input.manifest.branches.find(value => value.branchId === input.branchId);
  if (!branch) throw new Error("logical-session-branch-scope-mismatch");
  const shard = input.manifest.shards.find(value => value.shardId === branch.activeShardId);
  if (!shard || input.selection.sourceView.eventCut !== input.selection.requestedCut) {
    throw new Error("logical-session-continuation-evidence-invalid");
  }
  const composed = composeStoredSelection({ regularPiSummary: input.regularPiSummary, combinedCeilingTokens: input.combinedCeilingTokens,
    cut: { sourceCutEntryId: input.sourceLeafEntryId, sourceCutSeq: input.selection.requestedCut,
      firstKeptEntryId: "chrono-logical-new-shard", firstKeptSeq: input.selection.requestedCut + 1,
      rawTailTokens: 0, toolPairSafe: input.toolPairSafe } }, input.selection, source => input.recover(input.selection.sourceView, source));
  const selectedMandatory = new Set(composed.artifact.selectedRows
    .filter(value => value.section === "protected" || value.section === "open-work").map(value => value.row.id));
  const all = [...input.selection.protected, ...input.selection.current,
    ...(input.selection.delta?.protected ?? []), ...(input.selection.delta?.current ?? [])].filter(mandatory);
  const selectedRepresentations = new Set(all.filter(item => selectedMandatory.has(item.stableKey))
    .flatMap(item => item.representationKey ? [item.representationKey] : []));
  const propositionMap = new Map<string, { kind: EpisodeStateSelectionItem["kind"]; covered: boolean }>();
  for (const item of all) {
    const represented = selectedMandatory.has(item.stableKey)
      || item.representationKey !== undefined && selectedRepresentations.has(item.representationKey);
    for (const proposition of coveredPropositions(item).filter(mandatory)) {
      const prior = propositionMap.get(proposition.stableKey);
      if (prior && prior.kind !== proposition.kind) throw new Error("logical-session-continuation-evidence-invalid");
      propositionMap.set(proposition.stableKey, { kind: proposition.kind, covered: represented || prior?.covered === true });
    }
  }
  const propositions = [...propositionMap.entries()].map(([stableKey, value]) => ({ stableKey, ...value }));
  const restrictions = propositions.filter(item => item.kind === "restriction");
  const openWork = propositions.filter(item => item.kind !== "restriction");
  const omittedMandatory = propositions.filter(item => !item.covered).map(item => item.stableKey);
  const source = { catalogStoreKey: input.selection.sourceView.storeKey,
    catalogGeneration: input.selection.sourceView.generation, sessionKey: input.selection.sourceView.sessionKey,
    branchKey: input.selection.sourceView.branchKey, eventCut: input.selection.requestedCut, entryId: input.sourceLeafEntryId };
  const coveredShards = resolveLogicalShardRoutes(input.manifest, input.branchId).map(route => route.shardId === shard.shardId
    ? { shardId: route.shardId, ...source }
    : route.catalog ? { shardId: route.shardId, ...route.catalog }
    : (() => { throw new Error("logical-session-continuation-evidence-invalid"); })());
  return { logicalSessionId: input.manifest.logicalSessionId, branchId: input.branchId, fromShardId: shard.shardId,
    source, coveredShards, summary: composed.text,
    composition: { schemaVersion: 1, payloadHash: composed.envelope.payloadHash,
      artifactHash: composed.envelope.artifactHash, combinedTokens: composed.envelope.combinedTokens,
      combinedCeilingTokens: input.combinedCeilingTokens, validation: { ...composed.envelope.validation } },
    mandatory: { protectedEligible: restrictions.length, protectedCovered: restrictions.filter(item => item.covered).length,
      openWorkEligible: openWork.length, openWorkCovered: openWork.filter(item => item.covered).length,
      omittedMandatory } };
}
