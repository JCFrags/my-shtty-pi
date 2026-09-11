import { createHash, randomUUID } from "node:crypto";
import type { LogicalCatalogCut, LogicalContinuation, LogicalSessionManifest, LogicalShard } from "./logical-session-contract.js";
import { logicalContinuationHash } from "./logical-session-contract.js";
import { resolveLogicalShardRoutes } from "./logical-session-routing.js";
import { LogicalSessionStore } from "./logical-session-store.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export interface RolloverEligibility {
  readonly persisted: boolean;
  readonly idle: boolean;
  readonly streaming: boolean;
  readonly activeToolCalls: number;
  readonly unmatchedToolPairs: number;
  readonly pendingMessages: boolean;
  readonly compactionActive: boolean;
  readonly sessionSwitchActive: boolean;
  readonly catalogCaughtUp: boolean;
  readonly incompleteSourceTail: boolean;
  readonly sourceLeafEntryId: string;
  readonly trigger: "manual" | "threshold";
}
export interface ContinuationCandidate {
  readonly logicalSessionId: string;
  readonly branchId: string;
  readonly fromShardId: string;
  readonly source: LogicalCatalogCut;
  readonly coveredShards: LogicalContinuation["coveredShards"];
  readonly summary: string;
  readonly composition: {
    readonly schemaVersion: 1;
    readonly payloadHash: string;
    readonly artifactHash: string;
    readonly combinedTokens: number;
    readonly combinedCeilingTokens: number;
    readonly validation: {
      readonly safeTail: boolean;
      readonly withinCombinedCeiling: boolean;
      readonly protectedCoverageComplete: boolean;
      readonly openWorkCoverageComplete: boolean;
    };
  };
  /** Counts come from the selected, source-validated composer rows, not a caller preference. */
  readonly mandatory: {
    readonly protectedEligible: number;
    readonly protectedCovered: number;
    readonly openWorkEligible: number;
    readonly openWorkCovered: number;
    readonly omittedMandatory: readonly string[];
  };
}
export interface SessionSetupPort {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getHeader(): { parentSession?: string };
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
}
export interface ReplacementContextPort { readonly sessionManager: SessionSetupPort }
export interface SessionCommandPort {
  readonly sessionManager: SessionSetupPort;
  newSession(options: { parentSession: string; setup: (manager: SessionSetupPort) => Promise<void>; withSession: (ctx: ReplacementContextPort) => Promise<void> }): Promise<{ cancelled: boolean }>;
  switchSession(path: string, options: { withSession: (ctx: ReplacementContextPort) => Promise<void> }): Promise<{ cancelled: boolean }>;
}

function sameCut(a: LogicalCatalogCut | undefined, b: LogicalCatalogCut): boolean {
  return !!a && a.catalogStoreKey === b.catalogStoreKey && a.catalogGeneration === b.catalogGeneration && a.sessionKey === b.sessionKey
    && a.branchKey === b.branchKey && a.eventCut === b.eventCut && a.entryId === b.entryId;
}
function withoutIntegrity(manifest: LogicalSessionManifest): Omit<LogicalSessionManifest, "revision" | "integrityHash"> {
  const { revision: _revision, integrityHash: _integrityHash, ...body } = manifest;
  return body;
}
export function createInitialLogicalManifest(input: { logicalSessionId?: string; ownerKey: string; branchId: string;
  piSessionId: string; sourcePath: string; createdAt?: string }): Omit<LogicalSessionManifest, "revision" | "integrityHash"> {
  if (!/^[a-f0-9]{64}$/.test(input.ownerKey) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.branchId)
    || !input.piSessionId || !input.sourcePath.startsWith("/")) return fail("logical-session-adoption-invalid");
  const logicalSessionId = input.logicalSessionId ?? randomUUID(), shardId = randomUUID(), createdAt = input.createdAt ?? new Date().toISOString();
  return { schemaVersion: 1, logicalSessionId, ownerKey: input.ownerKey, createdAt,
    branches: [{ branchId: input.branchId, shardIds: [shardId], activeShardId: shardId, createdAt }],
    shards: [{ shardId, branchId: input.branchId, ordinal: 0, piSessionId: input.piSessionId,
      sourcePath: input.sourcePath, state: "active", openedAt: createdAt }] };
}

function currentShard(manifest: LogicalSessionManifest, branchId: string): LogicalShard {
  const branch = manifest.branches.find(value => value.branchId === branchId) ?? fail("logical-session-branch-scope-mismatch");
  return manifest.shards.find(value => value.shardId === branch.activeShardId) ?? fail("logical-session-shard-missing");
}

export function assertRolloverEligible(value: RolloverEligibility): void {
  if (!value.persisted || !value.idle || value.streaming || value.activeToolCalls !== 0 || value.unmatchedToolPairs !== 0
    || value.pendingMessages || value.compactionActive || value.sessionSwitchActive || !value.catalogCaughtUp
    || value.incompleteSourceTail || !value.sourceLeafEntryId || !["manual", "threshold"].includes(value.trigger)) {
    fail("logical-session-rollover-ineligible");
  }
}
export function buildLogicalContinuation(manifest: LogicalSessionManifest, candidate: ContinuationCandidate): LogicalContinuation {
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
  if (candidate.coveredShards.length !== routes.length) return fail("logical-session-continuation-incomplete");
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]!, coverage = candidate.coveredShards[index]!;
    if (coverage.shardId !== route.shardId) return fail("logical-session-continuation-incomplete");
    if (route.shardId === shard.shardId) {
      if (!sameCut(coverage, candidate.source)) return fail("logical-session-continuation-incomplete");
    } else if (!sameCut(route.catalog, coverage)) return fail("logical-session-continuation-incomplete");
  }
  const summaryHash = createHash("sha256").update(candidate.summary).digest("hex");
  return { schemaVersion: 1, logicalSessionId: manifest.logicalSessionId, branchId: candidate.branchId,
    fromShardId: shard.shardId, source: candidate.source, coveredShards: candidate.coveredShards.map(value => ({ ...value })),
    summary: candidate.summary, summaryHash, composition: { schemaVersion: 1, payloadHash: candidate.composition.payloadHash,
      artifactHash: candidate.composition.artifactHash, combinedTokens: candidate.composition.combinedTokens,
      combinedCeilingTokens: candidate.composition.combinedCeilingTokens, mandatoryCoverageComplete: true, safeTail: true } };
}

export class ManualLogicalRollover {
  constructor(readonly store: LogicalSessionStore) {}

  async prepare(candidate: ContinuationCandidate, eligibility: RolloverEligibility): Promise<LogicalSessionManifest> {
    assertRolloverEligible(eligibility);
    const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
    if (candidate.source.entryId !== eligibility.sourceLeafEntryId) return fail("logical-session-source-cut-mismatch");
    const continuation = buildLogicalContinuation(manifest, candidate);
    const operationId = randomUUID(), newShardId = randomUUID(), createdAt = new Date().toISOString();
    return this.store.update(manifest.revision, current => {
      const shards = current.shards.map(shard => shard.shardId === candidate.fromShardId
        ? { ...shard, state: "closing" as const, finalCut: candidate.source } : shard);
      return { ...withoutIntegrity(current), shards, pendingRollover: { operationId, phase: "close-prepared", branchId: candidate.branchId,
        oldShardId: candidate.fromShardId, newShardId, continuation, createdAt } };
    });
  }

  async rollover(candidate: ContinuationCandidate, eligibility: RolloverEligibility, command: SessionCommandPort): Promise<{ cancelled: boolean }> {
    const current = await this.store.read() ?? fail("logical-session-manifest-missing");
    const expected = currentShard(current, candidate.branchId);
    if (command.sessionManager.getSessionId() !== expected.piSessionId || command.sessionManager.getSessionFile() !== expected.sourcePath) {
      return fail("logical-session-active-shard-mismatch");
    }
    const prepared = await this.prepare(candidate, eligibility);
    const operation = prepared.pendingRollover!;
    const oldShard = prepared.shards.find(value => value.shardId === operation.oldShardId)!;
    const result = await command.newSession({ parentSession: oldShard.sourcePath,
      setup: manager => this.bindNewShard(operation.operationId, manager),
      withSession: context => this.activateNewShard(operation.operationId, context.sessionManager),
    });
    if (result.cancelled) await this.abortPrepared(operation.operationId);
    return result;
  }

  async bindNewShard(operationId: string, manager: SessionSetupPort): Promise<void> {
    const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
    const operation = manifest.pendingRollover;
    if (!operation || operation.operationId !== operationId || operation.phase !== "close-prepared" || !operation.newShardId) return fail("logical-session-operation-mismatch");
    const old = manifest.shards.find(value => value.shardId === operation.oldShardId) ?? fail("logical-session-shard-missing");
    const sourcePath = manager.getSessionFile();
    if (!sourcePath || manager.getHeader().parentSession !== old.sourcePath) return fail("logical-session-parent-mismatch");
    const continuationHash = logicalContinuationHash(operation.continuation);
    manager.appendCustomMessageEntry("chrono-logical-continuation", operation.continuation.summary, true,
      { schemaVersion: 1, operationId, logicalSessionId: manifest.logicalSessionId, branchId: operation.branchId, fromShardId: old.shardId,
        toShardId: operation.newShardId, continuationHash, summaryHash: operation.continuation.summaryHash,
        source: operation.continuation.source, coveredShards: operation.continuation.coveredShards,
        composition: operation.continuation.composition });
    await this.bindRecordedNewShard(operationId, manager, continuationHash);
  }

  /** Recover setup after the continuation was appended but manifest binding did not finish. */
  async bindRecordedNewShard(operationId: string, manager: SessionSetupPort, continuationHash: string): Promise<void> {
    const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
    const operation = manifest.pendingRollover;
    if (!operation || operation.operationId !== operationId || operation.phase !== "close-prepared"
      || logicalContinuationHash(operation.continuation) !== continuationHash) return fail("logical-session-operation-mismatch");
    const old = manifest.shards.find(value => value.shardId === operation.oldShardId) ?? fail("logical-session-shard-missing");
    const sourcePath = manager.getSessionFile();
    if (!sourcePath || manager.getHeader().parentSession !== old.sourcePath) return fail("logical-session-parent-mismatch");
    await this.store.update(manifest.revision, current => {
      if (current.pendingRollover?.operationId !== operationId) return fail("logical-session-operation-mismatch");
      const branch = current.branches.find(value => value.branchId === operation.branchId) ?? fail("logical-session-branch-scope-mismatch");
      const next: LogicalShard = { shardId: operation.newShardId!, branchId: operation.branchId, ordinal: branch.shardIds.length,
        piSessionId: manager.getSessionId(), sourcePath, state: "active", openedAt: new Date().toISOString(), continuationHash };
      return { ...withoutIntegrity(current), branches: current.branches.map(value => value.branchId === branch.branchId
        ? { ...value, shardIds: [...value.shardIds, next.shardId], activeShardId: next.shardId } : value),
        shards: [...current.shards.map(value => value.shardId === old.shardId
          ? { ...value, state: "closed" as const, closedAt: new Date().toISOString() } : value), next],
        pendingRollover: { ...current.pendingRollover!, phase: "new-shard-bound" as const } };
    });
  }

  async activateNewShard(operationId: string, manager: SessionSetupPort): Promise<void> {
    const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
    const operation = manifest.pendingRollover;
    if (!operation || operation.operationId !== operationId || operation.phase !== "new-shard-bound" || !operation.newShardId) return fail("logical-session-operation-mismatch");
    const next = manifest.shards.find(value => value.shardId === operation.newShardId) ?? fail("logical-session-shard-missing");
    if (manager.getSessionId() !== next.piSessionId || manager.getSessionFile() !== next.sourcePath) return fail("logical-session-active-shard-mismatch");
    await this.store.update(manifest.revision, current => {
      const pending = current.pendingRollover!;
      const { pendingRollover: _pending, ...body } = withoutIntegrity(current);
      return { ...body, lastRollover: { operationId, branchId: pending.branchId, oldShardId: pending.oldShardId,
        newShardId: pending.newShardId!, continuationHash: logicalContinuationHash(pending.continuation), activatedAt: new Date().toISOString() } };
    });
  }

  async abortPrepared(operationId: string): Promise<void> {
    const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
    const operation = manifest.pendingRollover;
    if (!operation || operation.operationId !== operationId || operation.phase !== "close-prepared") return fail("logical-session-operation-mismatch");
    await this.store.update(manifest.revision, current => {
      const { pendingRollover: _pending, ...body } = withoutIntegrity(current);
      return { ...body, shards: current.shards.map(value => value.shardId === operation.oldShardId
        ? { ...value, state: "active" as const, finalCut: undefined } : value) };
    });
  }

  /** Exact reversal is allowed only while the replacement contains its injected continuation and no user work. */
  async rollbackLast(command: SessionCommandPort, replacementHasOnlyContinuation: boolean): Promise<{ cancelled: boolean }> {
    if (!replacementHasOnlyContinuation) return fail("logical-session-rollback-ineligible");
    const manifest = await this.store.read() ?? fail("logical-session-manifest-missing");
    if (manifest.pendingRollover || !manifest.lastRollover) return fail("logical-session-rollback-unavailable");
    const receipt = manifest.lastRollover;
    const old = manifest.shards.find(value => value.shardId === receipt.oldShardId) ?? fail("logical-session-shard-missing");
    const replacement = manifest.shards.find(value => value.shardId === receipt.newShardId) ?? fail("logical-session-shard-missing");
    if (command.sessionManager.getSessionId() !== replacement.piSessionId || command.sessionManager.getSessionFile() !== replacement.sourcePath) {
      return fail("logical-session-active-shard-mismatch");
    }
    const result = await command.switchSession(old.sourcePath, { withSession: async context => {
      if (context.sessionManager.getSessionId() !== old.piSessionId || context.sessionManager.getSessionFile() !== old.sourcePath) return fail("logical-session-active-shard-mismatch");
      const latest = await this.store.read() ?? fail("logical-session-manifest-missing");
      if (latest.lastRollover?.operationId !== receipt.operationId) return fail("logical-session-operation-mismatch");
      await this.store.update(latest.revision, current => {
        const branch = current.branches.find(value => value.branchId === receipt.branchId) ?? fail("logical-session-branch-scope-mismatch");
        const { lastRollover: _last, ...body } = withoutIntegrity(current);
        return { ...body, branches: current.branches.map(value => value.branchId === branch.branchId ? { ...value, activeShardId: old.shardId } : value),
          shards: current.shards.map(value => value.shardId === old.shardId ? { ...value, state: "active" as const, closedAt: undefined }
            : value.shardId === replacement.shardId ? { ...value, state: "closed" as const, closedAt: new Date().toISOString() } : value) };
      });
    } });
    return result;
  }
}
