import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalJson } from "./capsule-segment.js";
export const LOGICAL_SESSION_SCHEMA_VERSION = 1;
export const LOGICAL_SESSION_LIMITS = Object.freeze({ branches: 256, shards: 1024, continuationBytes: 256 * 1024 });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value) => integer(value) && Number(value) > 0;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const path = (value) => typeof value === "string" && isAbsolute(value) && value.length <= 4096 && !value.includes("\0") && !/[\ud800-\udfff]/u.test(value);
export function logicalManifestHash(value) {
    return createHash("sha256").update("chrono-logical-session-manifest-v1\0").update(canonicalJson(value)).digest("hex");
}
export function logicalContinuationHash(value) {
    const copy = { ...value, summaryHash: createHash("sha256").update(value.summary).digest("hex") };
    return createHash("sha256").update("chrono-logical-continuation-v1\0").update(canonicalJson(copy)).digest("hex");
}
function isCut(value) {
    return object(value) && uuid(value.catalogStoreKey) && positive(value.catalogGeneration) && key(value.sessionKey)
        && key(value.branchKey) && positive(value.eventCut) && typeof value.entryId === "string" && value.entryId.length > 0 && value.entryId.length <= 1024;
}
export function isLogicalContinuation(value) {
    if (!object(value) || value.schemaVersion !== 1 || !uuid(value.logicalSessionId) || !key(value.branchId) || !uuid(value.fromShardId)
        || !isCut(value.source) || !Array.isArray(value.coveredShards) || value.coveredShards.length < 1
        || value.coveredShards.length > LOGICAL_SESSION_LIMITS.shards || typeof value.summary !== "string" || value.summary.length < 1
        || Buffer.byteLength(value.summary) > LOGICAL_SESSION_LIMITS.continuationBytes || !hash(value.summaryHash)
        || createHash("sha256").update(value.summary).digest("hex") !== value.summaryHash || !object(value.composition)
        || value.composition.schemaVersion !== 1 || !hash(value.composition.payloadHash) || !hash(value.composition.artifactHash)
        || !positive(value.composition.combinedTokens) || !positive(value.composition.combinedCeilingTokens)
        || Number(value.composition.combinedTokens) > Number(value.composition.combinedCeilingTokens)
        || value.composition.mandatoryCoverageComplete !== true || value.composition.safeTail !== true)
        return false;
    const seen = new Set();
    return value.coveredShards.every(item => object(item) && uuid(item.shardId) && !seen.has(item.shardId)
        && (seen.add(item.shardId), true) && isCut(item));
}
export function isLogicalSessionManifest(value) {
    if (!object(value) || value.schemaVersion !== 1 || !positive(value.revision) || !uuid(value.logicalSessionId) || !hash(value.ownerKey)
        || !timestamp(value.createdAt) || !Array.isArray(value.branches) || value.branches.length < 1 || value.branches.length > LOGICAL_SESSION_LIMITS.branches
        || !Array.isArray(value.shards) || value.shards.length < 1 || value.shards.length > LOGICAL_SESSION_LIMITS.shards || !hash(value.integrityHash))
        return false;
    const branches = value.branches, shards = value.shards;
    const branchIds = new Set(), shardIds = new Set();
    for (const branch of branches) {
        if (!object(branch) || !key(branch.branchId) || branchIds.has(branch.branchId) || !timestamp(branch.createdAt)
            || !Array.isArray(branch.shardIds) || branch.shardIds.length < 1 || !uuid(branch.activeShardId)
            || !branch.shardIds.every(id => uuid(id)))
            return false;
        branchIds.add(branch.branchId);
        if (branch.parent !== undefined && (!object(branch.parent) || !key(branch.parent.branchId) || !uuid(branch.parent.throughShardId)))
            return false;
    }
    for (const shard of shards) {
        if (!object(shard) || !uuid(shard.shardId) || shardIds.has(shard.shardId) || !key(shard.branchId) || !integer(shard.ordinal)
            || !key(shard.piSessionId) || !path(shard.sourcePath) || !["active", "closing", "closed"].includes(String(shard.state))
            || !timestamp(shard.openedAt) || (shard.closedAt !== undefined && !timestamp(shard.closedAt))
            || (shard.finalCut !== undefined && !isCut(shard.finalCut)) || (shard.continuationHash !== undefined && !hash(shard.continuationHash)))
            return false;
        shardIds.add(shard.shardId);
    }
    for (const branch of branches) {
        if (branch.parent && (!branchIds.has(branch.parent.branchId) || !shardIds.has(branch.parent.throughShardId)))
            return false;
        if (!branch.shardIds.every(id => shardIds.has(id)) || !branch.shardIds.includes(branch.activeShardId))
            return false;
        const owned = shards.filter(shard => shard.branchId === branch.branchId).map(shard => shard.shardId);
        if (owned.length !== branch.shardIds.length || owned.some((id, index) => id !== branch.shardIds[index]))
            return false;
    }
    if (value.pendingRollover !== undefined) {
        const op = value.pendingRollover;
        if (!object(op) || !uuid(op.operationId) || !["close-prepared", "new-shard-bound"].includes(String(op.phase)) || !key(op.branchId)
            || !uuid(op.oldShardId) || !uuid(op.newShardId) || !timestamp(op.createdAt)
            || !isLogicalContinuation(op.continuation) || op.continuation.logicalSessionId !== value.logicalSessionId
            || op.continuation.branchId !== op.branchId || op.continuation.fromShardId !== op.oldShardId
            || !branchIds.has(op.branchId) || !shardIds.has(op.oldShardId)
            || (op.phase === "new-shard-bound") !== shardIds.has(op.newShardId))
            return false;
    }
    if (value.lastRollover !== undefined) {
        const receipt = value.lastRollover;
        if (!object(receipt) || !uuid(receipt.operationId) || !key(receipt.branchId) || !uuid(receipt.oldShardId)
            || !uuid(receipt.newShardId) || !hash(receipt.continuationHash) || !timestamp(receipt.activatedAt)
            || !branchIds.has(receipt.branchId) || !shardIds.has(receipt.oldShardId) || !shardIds.has(receipt.newShardId))
            return false;
    }
    const { integrityHash, ...body } = value;
    return logicalManifestHash(body) === integrityHash;
}
export function sealLogicalManifest(value) {
    return { ...value, integrityHash: logicalManifestHash(value) };
}
//# sourceMappingURL=logical-session-contract.js.map