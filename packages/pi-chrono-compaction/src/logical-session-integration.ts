import { createHash } from "node:crypto";
import type { CapsuleCatalogView, ScopedBodySourceRef, ScopedRawSourceRef } from "./capsule-contract.js";
import { canonicalJson } from "./capsule-segment.js";
import { composeStoredSelection } from "./context-composer.js";
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

export function replacementContainsOnlyContinuation(entries: readonly SessionEntryLike[], binding: RecordedLogicalBinding): boolean {
  let continuationCount = 0;
  for (const entry of entries) {
    if (entry.type === "custom_message" && (entry as unknown as Record<string, unknown>).customType === "chrono-logical-continuation") {
      continuationCount += 1;
      continue;
    }
    if (!["model_change", "thinking_level_change", "session_info"].includes(entry.type)) return false;
  }
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
  if (!shard || input.selection.sourceView.eventCut !== input.selection.requestedCut || !input.regularPiSummary.trim()
    || input.selection.coverage.restrictionsComplete !== true || input.selection.coverage.openWorkComplete !== true
    || input.selection.coverage.restrictionsScanComplete !== true || input.selection.coverage.openWorkScanComplete !== true
    || input.selection.omissions.protectedAtLeastOne || input.selection.omissions.openWorkAtLeastOne
    || input.selection.omissions.restrictionWorkExhausted || input.selection.omissions.openWorkExhausted
    || input.selection.omissions.renderedOverflowAtLeastOne || input.selection.omissions.responseBudgetAtLeastOne) {
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
      artifactHash: hash(canonicalJson(composed.artifact)), combinedTokens: composed.envelope.combinedTokens,
      combinedCeilingTokens: input.combinedCeilingTokens, validation: { ...composed.envelope.validation } },
    mandatory: { protectedEligible: restrictions.length, protectedCovered: restrictions.filter(item => item.covered).length,
      openWorkEligible: openWork.length, openWorkCovered: openWork.filter(item => item.covered).length,
      omittedMandatory } };
}
