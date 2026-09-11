import { isCapsuleCatalogView, isScopedBodySourceRef, sourceRefWithinViewBounds, } from "./capsule-contract.js";
import { isSearchV3Identity } from "./search-v3-contract.js";
/** Pure M07 protocol. Importing this module performs no I/O and loads no worker. */
export const EPISODE_STATE_PROTOCOL_VERSION = 1;
export const EPISODE_STATE_SCHEMA_VERSION = 4;
export const EPISODE_STATE_RULESET_VERSION = "episode-state-exact-v4";
export const EPISODE_STATE_LIMITS = Object.freeze({
    requestBytes: 48 * 1024,
    responseBytes: 96 * 1024,
    sourceBytesPerJob: 8 * 1024 * 1024,
    nativeSqliteBytes: 64 * 1024 * 1024,
    materializeCapsules: 8,
    wholeBodyUtf16Units: 32_768,
    clauseUtf16Units: 1_024,
    recallUtf8Bytes: 8 * 1024,
    page: 12,
    queryUnits: 256,
    rollupFanout: 8,
    rollupLeafMembers: 8,
    rollupLeavesPerJob: 8,
    rollupProtectedPerNode: 32,
    rollupMetadataPerNode: 16,
    rollupNodeUtf8Bytes: 64 * 1024,
    rollupNodesPerRecall: 24,
    rollupNodesPerJob: 64,
    rollupTreeLevels: 32,
    composeProtected: 24,
    composeRestrictions: 16,
    composeOpenWork: 8,
    composeScanPage: 32,
    composeScanPages: 8,
    composeScannedPerCategory: 256,
    largeBodyOverlapUnits: 8 * 1024,
    contextSideUnits: 8 * 1024,
    composeState: 12,
    composeRecentMembers: 12,
    composeUtf8Bytes: 80 * 1024,
});
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (x) => Number.isSafeInteger(x) && Number(x) >= 0;
const positive = (x) => integer(x) && x > 0;
const path = (x) => typeof x === "string" && x.startsWith("/") && x.length <= 4096 && !x.includes("\0") && !/[\ud800-\udfff]/u.test(x);
const byteSizeWithin = (x) => { try {
    return Buffer.byteLength(JSON.stringify(x)) <= EPISODE_STATE_LIMITS.requestBytes;
}
catch {
    return false;
} };
function identityMatchesView(identity, view) {
    return identity.capsule.sessionKey === view.sessionKey && identity.capsule.catalogStoreKey === view.storeKey
        && identity.capsule.catalogGeneration === view.generation;
}
function after(value) {
    return object(value) && positive(value.eventSeq) && integer(value.descriptor)
        && (value.stableKey === undefined || typeof value.stableKey === "string" && value.stableKey.length <= 128)
        && (value.generation === undefined || positive(value.generation));
}
function rollupAfter(value) {
    return object(value) && typeof value.nodeId === "string" && /^[a-f0-9]{64}$/u.test(value.nodeId)
        && integer(value.itemIndex) && value.itemIndex <= EPISODE_STATE_LIMITS.rollupNodesPerRecall && positive(value.generation)
        && (value.level === "root" || value.level === "child" || value.level === "episode" || value.level === "source")
        && typeof value.queryHash === "string" && /^[a-f0-9]{64}$/u.test(value.queryHash);
}
function rollupHandle(value) {
    return object(value) && value.schemaVersion === 1 && value.ruleset === "episode-rollup-exact-v3"
        && typeof value.branchKey === "string" && value.branchKey.length > 0 && value.branchKey.length <= 256
        && integer(value.eventCut) && positive(value.stateGeneration) && positive(value.rollupGeneration)
        && typeof value.rootNodeId === "string" && /^[a-f0-9]{64}$/u.test(value.rootNodeId);
}
export function isEpisodeStateRequest(value) {
    if (!byteSizeWithin(value) || !object(value) || value.v !== 1 || !path(value.catalogDirectory) || !path(value.capsuleDirectory)
        || !path(value.searchDirectory) || value.catalogDirectory === value.capsuleDirectory || value.catalogDirectory === value.searchDirectory
        || value.capsuleDirectory === value.searchDirectory || !isSearchV3Identity(value.identity) || !isCapsuleCatalogView(value.view)
        || !identityMatchesView(value.identity, value.view))
        return false;
    const stateCommon = (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page)
        && (value.after === undefined || after(value.after));
    switch (value.op) {
        case "materializeState": return stateCommon;
        case "stateStatus": return value.limit === undefined && value.after === undefined;
        case "composeStateSelection": return value.limit === undefined && value.after === undefined;
        case "recallState": return stateCommon && (value.query === undefined || typeof value.query === "string" && value.query.trim().length > 0
            && value.query.length <= EPISODE_STATE_LIMITS.queryUnits)
            && (value.source === undefined || isScopedBodySourceRef(value.source) && sourceRefWithinViewBounds(value.source, value.view))
            && (value.level === undefined || value.level === "episode" || value.level === "resource" || value.level === "state");
        case "materializeRollup": return value.after === undefined
            && (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.rollupLeavesPerJob);
        case "rollupStatus": return value.limit === undefined && value.after === undefined;
        case "recallRollup": return (positive(value.generation) || rollupHandle(value.handle))
            && (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page)
            && (value.query === undefined || typeof value.query === "string" && value.query.trim().length > 0 && value.query.length <= EPISODE_STATE_LIMITS.queryUnits)
            && (value.nodeId === undefined || typeof value.nodeId === "string" && /^[a-f0-9]{64}$/u.test(value.nodeId))
            && (value.path === undefined || Array.isArray(value.path) && value.path.length <= EPISODE_STATE_LIMITS.rollupTreeLevels
                && value.path.every(item => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item)))
            && (value.level === undefined || value.level === "root" || value.level === "child" || value.level === "episode" || value.level === "source")
            && (value.generation === undefined || positive(value.generation)) && (value.after === undefined || rollupAfter(value.after))
            && (value.handle === undefined || rollupHandle(value.handle) && value.handle.branchKey === value.view.branchKey && value.handle.eventCut <= value.view.eventCut)
            && (value.generation === undefined || value.handle === undefined || value.generation === value.handle.rollupGeneration)
            && (value.after === undefined || value.generation === undefined || value.after.generation === value.generation);
        default: return false;
    }
}
//# sourceMappingURL=episode-state-contract.js.map