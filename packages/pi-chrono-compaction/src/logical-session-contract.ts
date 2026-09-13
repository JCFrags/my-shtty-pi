import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalJson } from "./capsule-segment.js";

export const LOGICAL_SESSION_SCHEMA_VERSION = 1 as const;
export const LOGICAL_SESSION_LIMITS = Object.freeze({ branches: 256, shards: 1024, continuationBytes: 256 * 1024 });

export interface LogicalCatalogCut {
  readonly catalogStoreKey: string;
  readonly catalogGeneration: number;
  readonly sessionKey: string;
  readonly branchKey: string;
  readonly eventCut: number;
  readonly entryId: string;
}
export interface LogicalShard {
  readonly shardId: string;
  readonly branchId: string;
  readonly ordinal: number;
  readonly piSessionId: string;
  readonly sourcePath: string;
  readonly state: "active" | "closing" | "closed";
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly finalCut?: LogicalCatalogCut;
  readonly continuationHash?: string;
}
export interface LogicalBranch {
  readonly branchId: string;
  readonly parent?: {
    readonly branchId: string;
    readonly throughShardId: string;
    /** Immutable parent cut shared by this branch. Required for newly created forks. */
    readonly throughCut?: LogicalCatalogCut;
  };
  readonly shardIds: readonly string[];
  readonly activeShardId: string;
  readonly createdAt: string;
}
export interface LogicalContinuationCoverage extends LogicalCatalogCut { readonly shardId: string }
export interface LogicalContinuation {
  readonly schemaVersion: 1;
  readonly logicalSessionId: string;
  readonly branchId: string;
  readonly fromShardId: string;
  readonly source: LogicalCatalogCut;
  readonly coveredShards: readonly LogicalContinuationCoverage[];
  readonly summary: string;
  readonly summaryHash: string;
  readonly composition: {
    readonly schemaVersion: 1;
    readonly payloadHash: string;
    readonly artifactHash: string;
    readonly combinedTokens: number;
    readonly combinedCeilingTokens: number;
    /** Historical in-context coverage disclosure, not a source-integrity verdict. */
    readonly mandatoryCoverageComplete: boolean;
    readonly safeTail: true;
  };
}
export interface LogicalRolloverOperation {
  readonly operationId: string;
  readonly phase: "close-prepared" | "new-shard-bound";
  /** Absent on old manifests and equivalent to rollover. */
  readonly kind?: "rollover" | "fork";
  readonly branchId: string;
  readonly sourceBranchId?: string;
  readonly oldShardId: string;
  readonly newShardId?: string;
  readonly continuation: LogicalContinuation;
  readonly createdAt: string;
}
export interface LogicalRolloverReceipt {
  readonly operationId: string;
  readonly kind?: "rollover" | "fork";
  readonly branchId: string;
  readonly oldShardId: string;
  readonly newShardId: string;
  readonly continuationHash: string;
  readonly activatedAt: string;
}
export interface LogicalSessionManifest {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly logicalSessionId: string;
  readonly ownerKey: string;
  readonly createdAt: string;
  readonly branches: readonly LogicalBranch[];
  readonly shards: readonly LogicalShard[];
  readonly pendingRollover?: LogicalRolloverOperation;
  readonly lastRollover?: LogicalRolloverReceipt;
  readonly integrityHash: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => integer(value) && Number(value) > 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const path = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && value.length <= 4096 && !value.includes("\0") && !/[\ud800-\udfff]/u.test(value);

export function logicalManifestHash(value: Omit<LogicalSessionManifest, "integrityHash">): string {
  return createHash("sha256").update("chrono-logical-session-manifest-v1\0").update(canonicalJson(value)).digest("hex");
}
export function logicalContinuationHash(value: Omit<LogicalContinuation, "summaryHash"> & { readonly summaryHash?: string }): string {
  const copy = { ...value, summaryHash: createHash("sha256").update(value.summary).digest("hex") };
  return createHash("sha256").update("chrono-logical-continuation-v1\0").update(canonicalJson(copy)).digest("hex");
}
function isCut(value: unknown): value is LogicalCatalogCut {
  return object(value) && uuid(value.catalogStoreKey) && positive(value.catalogGeneration) && key(value.sessionKey)
    && key(value.branchKey) && positive(value.eventCut) && typeof value.entryId === "string" && value.entryId.length > 0 && value.entryId.length <= 1024;
}
export function isLogicalContinuation(value: unknown): value is LogicalContinuation {
  if (!object(value) || value.schemaVersion !== 1 || !uuid(value.logicalSessionId) || !key(value.branchId) || !uuid(value.fromShardId)
    || !isCut(value.source) || !Array.isArray(value.coveredShards) || value.coveredShards.length < 1
    || value.coveredShards.length > LOGICAL_SESSION_LIMITS.shards || typeof value.summary !== "string" || value.summary.length < 1
    || Buffer.byteLength(value.summary) > LOGICAL_SESSION_LIMITS.continuationBytes || !hash(value.summaryHash)
    || createHash("sha256").update(value.summary).digest("hex") !== value.summaryHash || !object(value.composition)
    || value.composition.schemaVersion !== 1 || !hash(value.composition.payloadHash) || !hash(value.composition.artifactHash)
    || !positive(value.composition.combinedTokens) || !positive(value.composition.combinedCeilingTokens)
    || Number(value.composition.combinedTokens) > Number(value.composition.combinedCeilingTokens)
    || typeof value.composition.mandatoryCoverageComplete !== "boolean" || value.composition.safeTail !== true) return false;
  const seen = new Set<string>();
  return value.coveredShards.every(item => object(item) && uuid(item.shardId) && !seen.has(item.shardId as string)
    && (seen.add(item.shardId as string), true) && isCut(item));
}
export function isLogicalSessionManifest(value: unknown): value is LogicalSessionManifest {
  if (!object(value) || value.schemaVersion !== 1 || !positive(value.revision) || !uuid(value.logicalSessionId) || !hash(value.ownerKey)
    || !timestamp(value.createdAt) || !Array.isArray(value.branches) || value.branches.length < 1 || value.branches.length > LOGICAL_SESSION_LIMITS.branches
    || !Array.isArray(value.shards) || value.shards.length < 1 || value.shards.length > LOGICAL_SESSION_LIMITS.shards || !hash(value.integrityHash)) return false;
  const branches = value.branches as unknown[], shards = value.shards as unknown[];
  const branchIds = new Set<string>(), shardIds = new Set<string>();
  for (const branch of branches) {
    if (!object(branch) || !key(branch.branchId) || branchIds.has(branch.branchId) || !timestamp(branch.createdAt)
      || !Array.isArray(branch.shardIds) || branch.shardIds.length < 1 || !uuid(branch.activeShardId)
      || !branch.shardIds.every(id => uuid(id))) return false;
    branchIds.add(branch.branchId);
    if (branch.parent !== undefined && (!object(branch.parent) || !key(branch.parent.branchId) || !uuid(branch.parent.throughShardId)
      || (branch.parent.throughCut !== undefined && !isCut(branch.parent.throughCut)))) return false;
  }
  for (const shard of shards) {
    if (!object(shard) || !uuid(shard.shardId) || shardIds.has(shard.shardId) || !key(shard.branchId) || !integer(shard.ordinal)
      || !key(shard.piSessionId) || !path(shard.sourcePath) || !["active", "closing", "closed"].includes(String(shard.state))
      || !timestamp(shard.openedAt) || (shard.closedAt !== undefined && !timestamp(shard.closedAt))
      || (shard.finalCut !== undefined && !isCut(shard.finalCut)) || (shard.continuationHash !== undefined && !hash(shard.continuationHash))) return false;
    shardIds.add(shard.shardId);
  }
  for (const branch of branches as LogicalBranch[]) {
    if (branch.parent && (!branchIds.has(branch.parent.branchId) || !shardIds.has(branch.parent.throughShardId))) return false;
    if (!branch.shardIds.every(id => shardIds.has(id)) || !branch.shardIds.includes(branch.activeShardId)) return false;
    const owned = (shards as LogicalShard[]).filter(shard => shard.branchId === branch.branchId).map(shard => shard.shardId);
    if (owned.length !== branch.shardIds.length || owned.some((id, index) => id !== branch.shardIds[index])) return false;
    const ordered = branch.shardIds.map(id => (shards as LogicalShard[]).find(shard => shard.shardId === id)!);
    if (ordered.some((shard, index) => shard.ordinal !== index)) return false;
    const active = ordered.find(shard => shard.shardId === branch.activeShardId);
    const pending = object(value.pendingRollover) ? value.pendingRollover : undefined;
    const preparingRollover = !!pending && (pending.kind ?? "rollover") === "rollover" && pending.phase === "close-prepared"
      && pending.branchId === branch.branchId && pending.oldShardId === active?.shardId;
    if (!active || (preparingRollover ? active.state !== "closing" : active.state !== "active")
      || ordered.filter(shard => shard.state === "active").length !== (preparingRollover ? 0 : 1)) return false;
    if (branch.parent) {
      const parentShard = (shards as LogicalShard[]).find(shard => shard.shardId === branch.parent!.throughShardId)!;
      if (parentShard.branchId !== branch.parent.branchId || !branch.parent.throughCut) return false;
    }
  }
  for (const start of branches as LogicalBranch[]) {
    const seen = new Set<string>(); let cursor: LogicalBranch | undefined = start;
    while (cursor?.parent) {
      if (seen.has(cursor.branchId)) return false;
      seen.add(cursor.branchId);
      cursor = (branches as LogicalBranch[]).find(branch => branch.branchId === cursor!.parent!.branchId);
    }
  }
  if (value.pendingRollover !== undefined) {
    const op = value.pendingRollover;
    if (!object(op) || !uuid(op.operationId) || !["close-prepared", "new-shard-bound"].includes(String(op.phase)) || !key(op.branchId)
      || (op.kind !== undefined && !["rollover", "fork"].includes(String(op.kind)))
      || (op.sourceBranchId !== undefined && !key(op.sourceBranchId))
      || !uuid(op.oldShardId) || !uuid(op.newShardId) || !timestamp(op.createdAt)
      || !isLogicalContinuation(op.continuation) || op.continuation.logicalSessionId !== value.logicalSessionId
      || op.continuation.branchId !== op.branchId || op.continuation.fromShardId !== op.oldShardId
      || ((op.kind ?? "rollover") === "rollover" ? !branchIds.has(op.branchId)
        : (op.phase === "close-prepared") === branchIds.has(op.branchId) || !branchIds.has(op.sourceBranchId as string))
      || !shardIds.has(op.oldShardId)
      || (op.phase === "new-shard-bound") !== shardIds.has(op.newShardId)) return false;
  }
  if (value.lastRollover !== undefined) {
    const receipt = value.lastRollover;
    if (!object(receipt) || !uuid(receipt.operationId) || (receipt.kind !== undefined && !["rollover", "fork"].includes(String(receipt.kind)))
      || !key(receipt.branchId) || !uuid(receipt.oldShardId)
      || !uuid(receipt.newShardId) || !hash(receipt.continuationHash) || !timestamp(receipt.activatedAt)
      || !branchIds.has(receipt.branchId) || !shardIds.has(receipt.oldShardId) || !shardIds.has(receipt.newShardId)) return false;
  }
  const { integrityHash, ...body } = value as unknown as LogicalSessionManifest;
  return logicalManifestHash(body) === integrityHash;
}

export function sealLogicalManifest(value: Omit<LogicalSessionManifest, "integrityHash">): LogicalSessionManifest {
  return { ...value, integrityHash: logicalManifestHash(value) };
}
