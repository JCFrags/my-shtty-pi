import { createHash, randomUUID } from "node:crypto";
import { logicalContinuationHash } from "./logical-session-contract.js";
import { resolveLogicalShardRoutes } from "./logical-session-routing.js";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
function sameCut(a, b) {
    return !!a && a.catalogStoreKey === b.catalogStoreKey && a.catalogGeneration === b.catalogGeneration && a.sessionKey === b.sessionKey
        && a.branchKey === b.branchKey && a.eventCut === b.eventCut && a.entryId === b.entryId;
}
function withoutIntegrity(manifest) {
    const { revision: _revision, integrityHash: _integrityHash, ...body } = manifest;
    return body;
}
export function createInitialLogicalManifest(input) {
    if (!/^[a-f0-9]{64}$/.test(input.ownerKey) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.branchId)
        || !input.piSessionId || !input.sourcePath.startsWith("/"))
        return fail("logical-session-adoption-invalid");
    const logicalSessionId = input.logicalSessionId ?? randomUUID(), shardId = randomUUID(), createdAt = input.createdAt ?? new Date().toISOString();
    return { schemaVersion: 1, logicalSessionId, ownerKey: input.ownerKey, createdAt,
        branches: [{ branchId: input.branchId, shardIds: [shardId], activeShardId: shardId, createdAt }],
        shards: [{ shardId, branchId: input.branchId, ordinal: 0, piSessionId: input.piSessionId,
                sourcePath: input.sourcePath, state: "active", openedAt: createdAt }] };
}
function currentShard(manifest, branchId) {
    const branch = manifest.branches.find(value => value.branchId === branchId) ?? fail("logical-session-branch-scope-mismatch");
    return manifest.shards.find(value => value.shardId === branch.activeShardId) ?? fail("logical-session-shard-missing");
}
export function assertRolloverEligible(value) {
    if (!value.persisted || !value.idle || value.streaming || value.activeToolCalls !== 0 || value.unmatchedToolPairs !== 0
        || value.pendingMessages || value.compactionActive || value.sessionSwitchActive || !value.catalogCaughtUp
        || value.incompleteSourceTail || !value.sourceLeafEntryId || !["manual", "threshold"].includes(value.trigger)) {
        fail("logical-session-rollover-ineligible");
    }
}
export function buildLogicalContinuation(manifest, candidate) {
    const shard = currentShard(manifest, candidate.branchId);
    if (manifest.pendingRollover || candidate.logicalSessionId !== manifest.logicalSessionId || candidate.fromShardId !== shard.shardId
        || shard.state !== "active" || candidate.source.entryId.length < 1 || candidate.summary.length < 1
        || candidate.composition.schemaVersion !== 1 || !Number.isSafeInteger(candidate.composition.combinedTokens)
        || !Number.isSafeInteger(candidate.composition.combinedCeilingTokens) || candidate.composition.combinedTokens < 1
        || candidate.composition.combinedCeilingTokens < 1 || candidate.composition.combinedCeilingTokens > 30_000
        || candidate.composition.combinedTokens > candidate.composition.combinedCeilingTokens
        || !candidate.composition.validation.safeTail || !candidate.composition.validation.withinCombinedCeiling
        || !candidate.composition.validation.protectedCoverageComplete || !candidate.composition.validation.openWorkCoverageComplete
        || candidate.mandatory.protectedEligible !== candidate.mandatory.protectedCovered
        || candidate.mandatory.openWorkEligible !== candidate.mandatory.openWorkCovered || candidate.mandatory.omittedMandatory.length !== 0) {
        return fail("logical-session-continuation-incomplete");
    }
    const routes = resolveLogicalShardRoutes(manifest, candidate.branchId);
    if (candidate.coveredShards.length !== routes.length)
        return fail("logical-session-continuation-incomplete");
    for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index], coverage = candidate.coveredShards[index];
        if (coverage.shardId !== route.shardId)
            return fail("logical-session-continuation-incomplete");
        if (route.shardId === shard.shardId) {
            if (!sameCut(coverage, candidate.source))
                return fail("logical-session-continuation-incomplete");
        }
        else if (!sameCut(route.catalog, coverage))
            return fail("logical-session-continuation-incomplete");
    }
    const summaryHash = createHash("sha256").update(candidate.summary).digest("hex");
    return { schemaVersion: 1, logicalSessionId: manifest.logicalSessionId, branchId: candidate.branchId,
        fromShardId: shard.shardId, source: candidate.source, coveredShards: candidate.coveredShards.map(value => ({ ...value })),
        summary: candidate.summary, summaryHash, composition: { schemaVersion: 1, payloadHash: candidate.composition.payloadHash,
            artifactHash: candidate.composition.artifactHash, combinedTokens: candidate.composition.combinedTokens,
            combinedCeilingTokens: candidate.composition.combinedCeilingTokens, mandatoryCoverageComplete: true, safeTail: true } };
}
export class ManualLogicalRollover {
    store;
    constructor(store) {
        this.store = store;
    }
    async prepare(candidate, eligibility) {
        assertRolloverEligible(eligibility);
        const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
        if (candidate.source.entryId !== eligibility.sourceLeafEntryId)
            return fail("logical-session-source-cut-mismatch");
        const continuation = buildLogicalContinuation(manifest, candidate);
        const operationId = randomUUID(), newShardId = randomUUID(), createdAt = new Date().toISOString();
        return this.store.update(manifest.revision, current => {
            const shards = current.shards.map(shard => shard.shardId === candidate.fromShardId
                ? { ...shard, state: "closing", finalCut: candidate.source } : shard);
            return { ...withoutIntegrity(current), shards, pendingRollover: { operationId, phase: "close-prepared", branchId: candidate.branchId,
                    oldShardId: candidate.fromShardId, newShardId, continuation, createdAt } };
        });
    }
    async rollover(candidate, eligibility, command) {
        const current = await this.store.read() ?? fail("logical-session-manifest-missing");
        const expected = currentShard(current, candidate.branchId);
        if (command.sessionManager.getSessionId() !== expected.piSessionId || command.sessionManager.getSessionFile() !== expected.sourcePath) {
            return fail("logical-session-active-shard-mismatch");
        }
        const prepared = await this.prepare(candidate, eligibility);
        const operation = prepared.pendingRollover;
        const oldShard = prepared.shards.find(value => value.shardId === operation.oldShardId);
        const result = await command.newSession({ parentSession: oldShard.sourcePath,
            setup: manager => this.bindNewShard(operation.operationId, manager),
            withSession: async (context) => {
                await this.activateNewShard(operation.operationId, context.sessionManager);
                // Pi 0.85.1 can emit session_start before setup. Reload only after the
                // manifest is active so the replacement instance can resolve its grant.
                await context.reload();
                return;
            },
        });
        if (result.cancelled)
            await this.abortPrepared(operation.operationId);
        return result;
    }
    async bindNewShard(operationId, manager) {
        const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
        const operation = manifest.pendingRollover;
        if (!operation || operation.operationId !== operationId || operation.phase !== "close-prepared" || !operation.newShardId)
            return fail("logical-session-operation-mismatch");
        const old = manifest.shards.find(value => value.shardId === operation.oldShardId) ?? fail("logical-session-shard-missing");
        const sourcePath = manager.getSessionFile();
        if (!sourcePath || manager.getHeader().parentSession !== old.sourcePath)
            return fail("logical-session-parent-mismatch");
        const continuationHash = logicalContinuationHash(operation.continuation);
        manager.appendCustomMessageEntry("chrono-logical-continuation", operation.continuation.summary, true, { schemaVersion: 1, operationId, logicalSessionId: manifest.logicalSessionId, branchId: operation.branchId, fromShardId: old.shardId,
            toShardId: operation.newShardId, continuationHash, summaryHash: operation.continuation.summaryHash,
            source: operation.continuation.source, coveredShards: operation.continuation.coveredShards,
            composition: operation.continuation.composition });
        await this.bindRecordedNewShard(operationId, manager, continuationHash);
    }
    /** Recover setup after the continuation was appended but manifest binding did not finish. */
    async bindRecordedNewShard(operationId, manager, continuationHash) {
        const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
        const operation = manifest.pendingRollover;
        if (!operation || operation.operationId !== operationId || operation.phase !== "close-prepared"
            || logicalContinuationHash(operation.continuation) !== continuationHash)
            return fail("logical-session-operation-mismatch");
        const old = manifest.shards.find(value => value.shardId === operation.oldShardId) ?? fail("logical-session-shard-missing");
        const sourcePath = manager.getSessionFile();
        if (!sourcePath || manager.getHeader().parentSession !== old.sourcePath)
            return fail("logical-session-parent-mismatch");
        await this.store.update(manifest.revision, current => {
            if (current.pendingRollover?.operationId !== operationId)
                return fail("logical-session-operation-mismatch");
            const branch = current.branches.find(value => value.branchId === operation.branchId) ?? fail("logical-session-branch-scope-mismatch");
            const next = { shardId: operation.newShardId, branchId: operation.branchId, ordinal: branch.shardIds.length,
                piSessionId: manager.getSessionId(), sourcePath, state: "active", openedAt: new Date().toISOString(), continuationHash };
            return { ...withoutIntegrity(current), branches: current.branches.map(value => value.branchId === branch.branchId
                    ? { ...value, shardIds: [...value.shardIds, next.shardId], activeShardId: next.shardId } : value),
                shards: [...current.shards.map(value => value.shardId === old.shardId
                        ? { ...value, state: "closed", closedAt: new Date().toISOString() } : value), next],
                pendingRollover: { ...current.pendingRollover, phase: "new-shard-bound" } };
        });
    }
    async activateNewShard(operationId, manager) {
        const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
        const operation = manifest.pendingRollover;
        if (!operation || operation.operationId !== operationId || operation.phase !== "new-shard-bound" || !operation.newShardId)
            return fail("logical-session-operation-mismatch");
        const next = manifest.shards.find(value => value.shardId === operation.newShardId) ?? fail("logical-session-shard-missing");
        if (manager.getSessionId() !== next.piSessionId || manager.getSessionFile() !== next.sourcePath)
            return fail("logical-session-active-shard-mismatch");
        await this.store.update(manifest.revision, current => {
            const pending = current.pendingRollover;
            const { pendingRollover: _pending, ...body } = withoutIntegrity(current);
            return { ...body, lastRollover: { operationId, branchId: pending.branchId, oldShardId: pending.oldShardId,
                    newShardId: pending.newShardId, continuationHash: logicalContinuationHash(pending.continuation), activatedAt: new Date().toISOString() } };
        });
    }
    async abortPrepared(operationId) {
        const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
        const operation = manifest.pendingRollover;
        if (!operation || operation.operationId !== operationId || operation.phase !== "close-prepared")
            return fail("logical-session-operation-mismatch");
        await this.store.update(manifest.revision, current => {
            const { pendingRollover: _pending, ...body } = withoutIntegrity(current);
            return { ...body, shards: current.shards.map(value => value.shardId === operation.oldShardId
                    ? { ...value, state: "active", finalCut: undefined } : value) };
        });
    }
    /** Exact reversal is allowed only while the replacement contains its injected continuation and no user work. */
    async rollbackLast(command, replacementHasOnlyContinuation) {
        if (!replacementHasOnlyContinuation)
            return fail("logical-session-rollback-ineligible");
        const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
        if (manifest.pendingRollover || !manifest.lastRollover)
            return fail("logical-session-rollback-unavailable");
        const receipt = manifest.lastRollover;
        const old = manifest.shards.find(value => value.shardId === receipt.oldShardId) ?? fail("logical-session-shard-missing");
        const replacement = manifest.shards.find(value => value.shardId === receipt.newShardId) ?? fail("logical-session-shard-missing");
        if (command.sessionManager.getSessionId() !== replacement.piSessionId || command.sessionManager.getSessionFile() !== replacement.sourcePath) {
            return fail("logical-session-active-shard-mismatch");
        }
        const result = await command.switchSession(old.sourcePath, { withSession: async (context) => {
                if (context.sessionManager.getSessionId() !== old.piSessionId || context.sessionManager.getSessionFile() !== old.sourcePath)
                    return fail("logical-session-active-shard-mismatch");
                const latest = await this.store.read() ?? fail("logical-session-manifest-missing");
                if (latest.lastRollover?.operationId !== receipt.operationId)
                    return fail("logical-session-operation-mismatch");
                await this.store.update(latest.revision, current => {
                    const branch = current.branches.find(value => value.branchId === receipt.branchId) ?? fail("logical-session-branch-scope-mismatch");
                    const { lastRollover: _last, ...body } = withoutIntegrity(current);
                    return { ...body, branches: current.branches.map(value => value.branchId === branch.branchId ? { ...value, activeShardId: old.shardId } : value),
                        shards: current.shards.map(value => value.shardId === old.shardId ? { ...value, state: "active", closedAt: undefined }
                            : value.shardId === replacement.shardId ? { ...value, state: "closed", closedAt: new Date().toISOString() } : value) };
                });
            } });
        return result;
    }
}
//# sourceMappingURL=logical-session-rollover.js.map