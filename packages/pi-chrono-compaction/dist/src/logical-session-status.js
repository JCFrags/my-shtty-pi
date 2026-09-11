const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const metricKeys = ["sourceBytes", "records", "compactions", "estimatedTokens"];
const safeCount = (value, optional = false) => (optional && value === undefined) || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Evaluate configured thresholds without initiating rollover. Empty thresholds keep automatic rollover disabled. */
export function evaluateLogicalRolloverThresholds(measurements, thresholds) {
    if (!metricKeys.every(key => safeCount(measurements[key], key === "estimatedTokens")))
        return fail("logical-session-status-invalid");
    const reached = [];
    const remaining = {};
    for (const key of metricKeys) {
        const threshold = thresholds[key];
        if (threshold === undefined)
            continue;
        if (!Number.isSafeInteger(threshold) || threshold < 1)
            return fail("logical-session-threshold-invalid");
        const observed = measurements[key];
        if (observed === undefined)
            continue;
        if (observed >= threshold)
            reached.push(key);
        else
            remaining[key] = threshold - observed;
    }
    return { eligible: reached.length > 0, reached, remaining };
}
/** Safe operator status. Source paths, Pi session IDs and private continuation text are omitted. */
export function logicalSessionStatus(manifest, branchId, measurements, thresholds = {}) {
    const branch = manifest.branches.find(value => value.branchId === branchId) ?? fail("logical-session-branch-scope-mismatch");
    const active = manifest.shards.find(value => value.shardId === branch.activeShardId) ?? fail("logical-session-shard-missing");
    return { logicalSessionId: manifest.logicalSessionId, revision: manifest.revision, branchId,
        activeShardId: active.shardId, activeShardOrdinal: active.ordinal, shardCount: branch.shardIds.length,
        totalManifestShards: manifest.shards.length, pendingPhase: manifest.pendingRollover?.phase ?? null,
        pendingKind: manifest.pendingRollover?.kind ?? (manifest.pendingRollover ? "rollover" : null),
        rolloverMode: "manual", thresholds: measurements ? evaluateLogicalRolloverThresholds(measurements, thresholds) : null,
        composerCanaryInherited: false };
}
//# sourceMappingURL=logical-session-status.js.map