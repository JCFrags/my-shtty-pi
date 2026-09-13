import { createHash } from "node:crypto";
import { composeStoredSelection } from "./context-composer.js";
import { composeBoundedMemory } from "./bounded-memory.js";
import { LOGICAL_CHECKPOINT_TYPE, validateLogicalStateCheckpoints } from "./logical-session-checkpoints.js";
import { resolveLogicalShardRoutes } from "./logical-session-routing.js";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const provisionalReplacementKey = Symbol.for("pi-chrono-compact.provisional-logical-replacements.v1");
function provisionalReplacements() {
    const processState = globalThis;
    return processState[provisionalReplacementKey] ??= new Set();
}
/** Mark only the parent of an in-process manual logical replacement. The global
 * symbol survives Pi's fresh extension module instance during session replacement. */
export function markProvisionalLogicalReplacement(parentSession) {
    const replacements = provisionalReplacements();
    if (!parentSession.startsWith("/") || replacements.size >= 8 || replacements.has(parentSession)) {
        throw new Error("logical-session-provisional-replacement-invalid");
    }
    replacements.add(parentSession);
    return () => { replacements.delete(parentSession); };
}
/** Consume the one-shot marker before Pi 0.85.1 setup appends the continuation. */
export function consumeProvisionalLogicalReplacement(parentSession) {
    const replacements = provisionalReplacements();
    if (!replacements.has(parentSession))
        return false;
    replacements.delete(parentSession);
    return true;
}
export function logicalAdoptionBinding(manifest, branchId) {
    const branch = manifest.branches.find(value => value.branchId === branchId);
    const shard = branch && manifest.shards.find(value => value.shardId === branch.activeShardId);
    if (!branch || branch.parent || branch.shardIds.length !== 1 || !shard || shard.ordinal !== 0 || shard.state !== "active") {
        throw new Error("logical-session-adoption-invalid");
    }
    return { schemaVersion: 1, logicalSessionId: manifest.logicalSessionId, branchId, shardId: shard.shardId };
}
/** Read the one non-model adoption marker persisted in shard zero. */
export function recordedLogicalAdoptionBinding(entries) {
    const matches = entries.filter(entry => entry.type === "custom" && entry.customType === "chrono-logical-adoption");
    if (matches.length !== 1)
        return undefined;
    const data = record(matches[0].data);
    if (!data || data.schemaVersion !== 1 || !validUuid(data.logicalSessionId) || typeof data.branchId !== "string"
        || !validUuid(data.shardId))
        return undefined;
    return { schemaVersion: 1, logicalSessionId: data.logicalSessionId, branchId: data.branchId, shardId: data.shardId };
}
/** Accept only the one model-visible continuation whose content and manifest binding agree exactly. */
export function recordedLogicalBinding(entries) {
    const matches = entries.filter(entry => entry.type === "custom_message" && entry.customType === "chrono-logical-continuation");
    if (matches.length !== 1)
        return undefined;
    const entry = matches[0];
    const details = record(entry.details);
    const content = entry.content;
    if (!details || typeof content !== "string" || details.schemaVersion !== 1 || !validUuid(details.operationId)
        || !validUuid(details.logicalSessionId) || typeof details.branchId !== "string" || !validUuid(details.fromShardId) || !validUuid(details.toShardId)
        || !validHash(details.continuationHash) || !validHash(details.summaryHash) || hash(content) !== details.summaryHash)
        return undefined;
    return { schemaVersion: 1, operationId: details.operationId, logicalSessionId: details.logicalSessionId,
        branchId: details.branchId, fromShardId: details.fromShardId, shardId: details.toShardId, continuationHash: details.continuationHash,
        summaryHash: details.summaryHash };
}
export function replacementContainsOnlyBootstrap(entries) {
    return entries.every(entry => ["model_change", "thinking_level_change", "session_info"].includes(entry.type));
}
export function replacementContainsOnlyContinuation(entries, binding) {
    let continuationCount = 0;
    const checkpoints = [];
    for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === LOGICAL_CHECKPOINT_TYPE && continuationCount === 0) {
            checkpoints.push({ customType: entry.customType, data: entry.data });
            continue;
        }
        if (entry.type === "custom_message" && entry.customType === "chrono-logical-continuation") {
            continuationCount += 1;
            continue;
        }
        if (!["model_change", "thinking_level_change", "session_info"].includes(entry.type))
            return false;
    }
    try {
        validateLogicalStateCheckpoints(checkpoints);
    }
    catch {
        return false;
    }
    return continuationCount === 1 && recordedLogicalBinding(entries)?.continuationHash === binding.continuationHash;
}
const mandatory = (item) => ["restriction", "openwork", "blocker", "goal"].includes(item.kind);
const coveredPropositions = (item) => {
    if (!item.coveredPropositions)
        return [item];
    if (!item.representationKey || item.coveredPropositions.length < 1
        || item.coveredPropositions.some(value => value.representationKey !== item.representationKey)) {
        throw new Error("logical-session-continuation-evidence-invalid");
    }
    return [item, ...item.coveredPropositions];
};
/** Reuse the existing M10 continuation contract when optional derived stores lag.
 * The caller must still independently pin the exact source leaf and safe idle. */
export function buildBoundedContinuationCandidate(input) {
    const branch = input.manifest.branches.find(value => value.branchId === input.branchId);
    const shard = branch && input.manifest.shards.find(value => value.shardId === branch.activeShardId);
    if (!shard || input.entries.at(-1)?.id !== input.sourceLeafEntryId)
        throw new Error("logical-session-continuation-evidence-invalid");
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
export function buildManualContinuationCandidate(input) {
    const branch = input.manifest.branches.find(value => value.branchId === input.branchId);
    if (!branch)
        throw new Error("logical-session-branch-scope-mismatch");
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
    const propositionMap = new Map();
    for (const item of all) {
        const represented = selectedMandatory.has(item.stableKey)
            || item.representationKey !== undefined && selectedRepresentations.has(item.representationKey);
        for (const proposition of coveredPropositions(item).filter(mandatory)) {
            const prior = propositionMap.get(proposition.stableKey);
            if (prior && prior.kind !== proposition.kind)
                throw new Error("logical-session-continuation-evidence-invalid");
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
//# sourceMappingURL=logical-session-integration.js.map