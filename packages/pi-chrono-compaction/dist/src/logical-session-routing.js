import { createHash } from "node:crypto";
import { canonicalJson } from "./capsule-segment.js";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
function branch(manifest, id) {
    return manifest.branches.find(candidate => candidate.branchId === id) ?? fail("logical-session-branch-scope-mismatch");
}
function ancestryShardIds(manifest, branchId, seen = new Set()) {
    if (seen.has(branchId))
        return fail("logical-session-branch-cycle");
    seen.add(branchId);
    const current = branch(manifest, branchId);
    const own = [...current.shardIds];
    if (!current.parent)
        return own;
    const parentIds = ancestryShardIds(manifest, current.parent.branchId, seen);
    const through = parentIds.indexOf(current.parent.throughShardId);
    if (through < 0 || !current.parent.throughCut)
        return fail("logical-session-branch-scope-mismatch");
    return [...parentIds.slice(0, through + 1), ...own];
}
/** Ordered oldest-to-newest routes for this branch and its ancestors. Siblings are never included. */
export function resolveLogicalShardRoutes(manifest, branchId) {
    const cuts = new Map();
    let cursor = branch(manifest, branchId);
    while (cursor?.parent) {
        cuts.set(cursor.parent.throughShardId, cursor.parent.throughCut);
        cursor = branch(manifest, cursor.parent.branchId);
    }
    return ancestryShardIds(manifest, branchId).map(shardId => {
        const shard = manifest.shards.find(candidate => candidate.shardId === shardId) ?? fail("logical-session-shard-missing");
        return { logicalSessionId: manifest.logicalSessionId, manifestRevision: manifest.revision, branchId,
            shardId, piSessionId: shard.piSessionId, sourcePath: shard.sourcePath, ordinal: shard.ordinal,
            catalog: cuts.has(shardId) ? cuts.get(shardId) : shard.finalCut };
    });
}
export function resolveExactLogicalRoute(manifest, branchId, shardId) {
    return resolveLogicalShardRoutes(manifest, branchId).find(route => route.shardId === shardId)
        ?? fail("logical-session-branch-scope-mismatch");
}
/** A replacement session gets cross-shard tools only from its exact injected binding.
 * This grant does not enable or inherit any composer canary or global setting. */
/** Activate an adopted shard zero only from its explicit session-local binding. */
export function resolveAdoptedLogicalActivation(manifest, active, binding) {
    const branch = manifest.branches.find(value => value.branchId === binding.branchId) ?? fail("logical-session-activation-invalid");
    const shard = manifest.shards.find(value => value.shardId === binding.shardId) ?? fail("logical-session-activation-invalid");
    if (binding.schemaVersion !== 1 || binding.logicalSessionId !== manifest.logicalSessionId || manifest.pendingRollover
        || branch.parent || branch.shardIds.length !== 1 || branch.activeShardId !== shard.shardId || shard.ordinal !== 0
        || shard.state !== "active" || shard.continuationHash !== undefined
        || shard.piSessionId !== active.piSessionId || shard.sourcePath !== active.sourcePath)
        return fail("logical-session-activation-invalid");
    return { logicalSessionId: manifest.logicalSessionId, manifestRevision: manifest.revision,
        manifestHash: manifest.integrityHash, branchId: branch.branchId, activeShardId: shard.shardId,
        searchRoutes: resolveLogicalShardRoutes(manifest, branch.branchId), composerCanaryInherited: false };
}
export function resolveLogicalActivation(manifest, active, binding) {
    if (binding.schemaVersion !== 1 || binding.logicalSessionId !== manifest.logicalSessionId || !/^[a-f0-9]{64}$/.test(binding.continuationHash)) {
        return fail("logical-session-activation-invalid");
    }
    const branch = manifest.branches.find(value => value.branchId === binding.branchId) ?? fail("logical-session-activation-invalid");
    const shard = manifest.shards.find(value => value.shardId === branch.activeShardId) ?? fail("logical-session-activation-invalid");
    if (binding.shardId !== shard.shardId || shard.piSessionId !== active.piSessionId || shard.sourcePath !== active.sourcePath
        || shard.continuationHash !== binding.continuationHash || shard.state !== "active")
        return fail("logical-session-activation-invalid");
    return { logicalSessionId: manifest.logicalSessionId, manifestRevision: manifest.revision,
        manifestHash: manifest.integrityHash, branchId: branch.branchId, activeShardId: shard.shardId,
        searchRoutes: resolveLogicalShardRoutes(manifest, branch.branchId), composerCanaryInherited: false };
}
function cursorHash(value) {
    return createHash("sha256").update("chrono-logical-search-cursor-v1\0").update(canonicalJson(value)).digest("hex");
}
export function createLogicalSearchCursor(manifest, branchId, routeIndex, storeCursor) {
    const routes = resolveLogicalShardRoutes(manifest, branchId);
    if (!Number.isSafeInteger(routeIndex) || routeIndex < 0 || routeIndex >= routes.length || (storeCursor !== undefined && storeCursor.length > 16_384)) {
        return fail("logical-session-cursor-invalid");
    }
    const body = { v: 1, logicalSessionId: manifest.logicalSessionId, manifestRevision: manifest.revision,
        manifestHash: manifest.integrityHash, branchId, routeIndex, ...(storeCursor === undefined ? {} : { storeCursor }) };
    return { ...body, integrityHash: cursorHash(body) };
}
export function validateLogicalSearchCursor(manifest, branchId, value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail("logical-session-cursor-invalid");
    const cursor = value;
    const { integrityHash, ...body } = cursor;
    if (cursor.v !== 1 || cursor.logicalSessionId !== manifest.logicalSessionId || cursor.manifestRevision !== manifest.revision
        || cursor.manifestHash !== manifest.integrityHash || cursor.branchId !== branchId || !/^[a-f0-9]{64}$/.test(String(integrityHash))
        || cursorHash(body) !== integrityHash || !Number.isSafeInteger(cursor.routeIndex)
        || cursor.routeIndex < 0 || cursor.routeIndex >= resolveLogicalShardRoutes(manifest, branchId).length
        || (cursor.storeCursor !== undefined && (typeof cursor.storeCursor !== "string" || cursor.storeCursor.length > 16_384)))
        return fail("logical-session-cursor-invalid");
    return cursor;
}
/** Fan out through already-existing per-shard stores. Newest history is searched first. */
export async function searchLogicalAncestors(manifest, branchId, execute, limit, cursor) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
        return fail("logical-session-search-limit");
    const routes = resolveLogicalShardRoutes(manifest, branchId).reverse();
    let index = cursor ? validateLogicalSearchCursor(manifest, branchId, cursor).routeIndex : 0;
    let storeCursor = cursor?.storeCursor;
    const items = [];
    while (index < routes.length && items.length < limit) {
        const page = await execute(routes[index], storeCursor);
        if (!Array.isArray(page.items) || page.items.length > limit - items.length || (page.nextCursor !== undefined && page.nextCursor.length > 16_384)) {
            return fail("logical-session-store-response-invalid");
        }
        items.push(...page.items);
        if (page.nextCursor !== undefined)
            return { items, nextCursor: createLogicalSearchCursor(manifest, branchId, index, page.nextCursor) };
        index += 1;
        storeCursor = undefined;
    }
    return { items, ...(index < routes.length ? { nextCursor: createLogicalSearchCursor(manifest, branchId, index) } : {}) };
}
//# sourceMappingURL=logical-session-routing.js.map