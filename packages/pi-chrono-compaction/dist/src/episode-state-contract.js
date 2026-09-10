import { isCapsuleCatalogView, isScopedBodySourceRef, sourceRefWithinViewBounds, } from "./capsule-contract.js";
import { isSearchV3Identity } from "./search-v3-contract.js";
/** Pure M07 protocol. Importing this module performs no I/O and loads no worker. */
export const EPISODE_STATE_PROTOCOL_VERSION = 1;
export const EPISODE_STATE_SCHEMA_VERSION = 2;
export const EPISODE_STATE_RULESET_VERSION = "episode-state-exact-v2";
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
export function isEpisodeStateRequest(value) {
    if (!byteSizeWithin(value) || !object(value) || value.v !== 1 || !path(value.catalogDirectory) || !path(value.capsuleDirectory)
        || !path(value.searchDirectory) || value.catalogDirectory === value.capsuleDirectory || value.catalogDirectory === value.searchDirectory
        || value.capsuleDirectory === value.searchDirectory || !isSearchV3Identity(value.identity) || !isCapsuleCatalogView(value.view)
        || !identityMatchesView(value.identity, value.view))
        return false;
    const common = (value.limit === undefined || positive(value.limit) && value.limit <= EPISODE_STATE_LIMITS.page)
        && (value.after === undefined || after(value.after));
    if (!common)
        return false;
    switch (value.op) {
        case "materializeState": return true;
        case "stateStatus": return value.limit === undefined && value.after === undefined;
        case "recallState": return (value.query === undefined || typeof value.query === "string" && value.query.trim().length > 0
            && value.query.length <= EPISODE_STATE_LIMITS.queryUnits)
            && (value.source === undefined || isScopedBodySourceRef(value.source) && sourceRefWithinViewBounds(value.source, value.view))
            && (value.level === undefined || value.level === "episode" || value.level === "resource" || value.level === "state");
        default: return false;
    }
}
//# sourceMappingURL=episode-state-contract.js.map