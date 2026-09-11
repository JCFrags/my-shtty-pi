import { createHash } from "node:crypto";
import { canonicalJson } from "./capsule-segment.js";
import type { LogicalBranch, LogicalSessionManifest, LogicalShard } from "./logical-session-contract.js";

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export interface LogicalShardRoute {
  readonly logicalSessionId: string;
  readonly manifestRevision: number;
  readonly branchId: string;
  readonly shardId: string;
  readonly piSessionId: string;
  readonly sourcePath: string;
  readonly ordinal: number;
  readonly catalog: LogicalShard["finalCut"];
}
export interface LogicalActivationBinding {
  readonly schemaVersion: 1;
  readonly logicalSessionId: string;
  readonly branchId: string;
  readonly shardId: string;
  readonly continuationHash: string;
}
export interface LogicalActivationGrant {
  readonly logicalSessionId: string;
  readonly branchId: string;
  readonly activeShardId: string;
  readonly searchRoutes: readonly LogicalShardRoute[];
  /** Session-scoped composer canaries never carry across a replacement. */
  readonly composerCanaryInherited: false;
}
export interface LogicalSearchCursor {
  readonly v: 1;
  readonly logicalSessionId: string;
  readonly manifestRevision: number;
  readonly manifestHash: string;
  readonly branchId: string;
  readonly routeIndex: number;
  readonly storeCursor?: string;
  readonly integrityHash: string;
}

function branch(manifest: LogicalSessionManifest, id: string): LogicalBranch {
  return manifest.branches.find(candidate => candidate.branchId === id) ?? fail("logical-session-branch-scope-mismatch");
}
function ancestryShardIds(manifest: LogicalSessionManifest, branchId: string, seen = new Set<string>()): string[] {
  if (seen.has(branchId)) return fail("logical-session-branch-cycle");
  seen.add(branchId);
  const current = branch(manifest, branchId);
  const own = [...current.shardIds];
  if (!current.parent) return own;
  const parentIds = ancestryShardIds(manifest, current.parent.branchId, seen);
  const through = parentIds.indexOf(current.parent.throughShardId);
  if (through < 0) return fail("logical-session-branch-scope-mismatch");
  return [...parentIds.slice(0, through + 1), ...own];
}

/** Ordered oldest-to-newest routes for this branch and its ancestors. Siblings are never included. */
export function resolveLogicalShardRoutes(manifest: LogicalSessionManifest, branchId: string): LogicalShardRoute[] {
  return ancestryShardIds(manifest, branchId).map(shardId => {
    const shard = manifest.shards.find(candidate => candidate.shardId === shardId) ?? fail("logical-session-shard-missing");
    return { logicalSessionId: manifest.logicalSessionId, manifestRevision: manifest.revision, branchId,
      shardId, piSessionId: shard.piSessionId, sourcePath: shard.sourcePath, ordinal: shard.ordinal, catalog: shard.finalCut };
  });
}
export function resolveExactLogicalRoute(manifest: LogicalSessionManifest, branchId: string, shardId: string): LogicalShardRoute {
  return resolveLogicalShardRoutes(manifest, branchId).find(route => route.shardId === shardId)
    ?? fail("logical-session-branch-scope-mismatch");
}
/** A replacement session gets cross-shard tools only from its exact injected binding.
 * This grant does not enable or inherit any composer canary or global setting. */
export function resolveLogicalActivation(manifest: LogicalSessionManifest, active: { readonly piSessionId: string; readonly sourcePath: string },
  binding: LogicalActivationBinding): LogicalActivationGrant {
  if (binding.schemaVersion !== 1 || binding.logicalSessionId !== manifest.logicalSessionId || !/^[a-f0-9]{64}$/.test(binding.continuationHash)) {
    return fail("logical-session-activation-invalid");
  }
  const branch = manifest.branches.find(value => value.branchId === binding.branchId) ?? fail("logical-session-activation-invalid");
  const shard = manifest.shards.find(value => value.shardId === branch.activeShardId) ?? fail("logical-session-activation-invalid");
  if (binding.shardId !== shard.shardId || shard.piSessionId !== active.piSessionId || shard.sourcePath !== active.sourcePath
    || shard.continuationHash !== binding.continuationHash || shard.state !== "active") return fail("logical-session-activation-invalid");
  return { logicalSessionId: manifest.logicalSessionId, branchId: branch.branchId, activeShardId: shard.shardId,
    searchRoutes: resolveLogicalShardRoutes(manifest, branch.branchId), composerCanaryInherited: false };
}
function cursorHash(value: Omit<LogicalSearchCursor, "integrityHash">): string {
  return createHash("sha256").update("chrono-logical-search-cursor-v1\0").update(canonicalJson(value)).digest("hex");
}
export function createLogicalSearchCursor(manifest: LogicalSessionManifest, branchId: string, routeIndex: number, storeCursor?: string): LogicalSearchCursor {
  const routes = resolveLogicalShardRoutes(manifest, branchId);
  if (!Number.isSafeInteger(routeIndex) || routeIndex < 0 || routeIndex >= routes.length || (storeCursor !== undefined && storeCursor.length > 16_384)) {
    return fail("logical-session-cursor-invalid");
  }
  const body = { v: 1 as const, logicalSessionId: manifest.logicalSessionId, manifestRevision: manifest.revision,
    manifestHash: manifest.integrityHash, branchId, routeIndex, ...(storeCursor === undefined ? {} : { storeCursor }) };
  return { ...body, integrityHash: cursorHash(body) };
}
export function validateLogicalSearchCursor(manifest: LogicalSessionManifest, branchId: string, value: unknown): LogicalSearchCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("logical-session-cursor-invalid");
  const cursor = value as LogicalSearchCursor;
  const { integrityHash, ...body } = cursor;
  if (cursor.v !== 1 || cursor.logicalSessionId !== manifest.logicalSessionId || cursor.manifestRevision !== manifest.revision
    || cursor.manifestHash !== manifest.integrityHash || cursor.branchId !== branchId || !/^[a-f0-9]{64}$/.test(String(integrityHash))
    || cursorHash(body) !== integrityHash || !Number.isSafeInteger(cursor.routeIndex)
    || cursor.routeIndex < 0 || cursor.routeIndex >= resolveLogicalShardRoutes(manifest, branchId).length
    || (cursor.storeCursor !== undefined && (typeof cursor.storeCursor !== "string" || cursor.storeCursor.length > 16_384))) return fail("logical-session-cursor-invalid");
  return cursor;
}

/** Fan out through already-existing per-shard stores. Newest history is searched first. */
export async function searchLogicalAncestors<T>(manifest: LogicalSessionManifest, branchId: string,
  execute: (route: LogicalShardRoute, storeCursor?: string) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
  limit: number, cursor?: LogicalSearchCursor): Promise<{ readonly items: readonly T[]; readonly nextCursor?: LogicalSearchCursor }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) return fail("logical-session-search-limit");
  const routes = resolveLogicalShardRoutes(manifest, branchId).reverse();
  let index = cursor ? validateLogicalSearchCursor(manifest, branchId, cursor).routeIndex : 0;
  let storeCursor = cursor?.storeCursor;
  const items: T[] = [];
  while (index < routes.length && items.length < limit) {
    const page = await execute(routes[index]!, storeCursor);
    if (!Array.isArray(page.items) || page.items.length > limit - items.length || (page.nextCursor !== undefined && page.nextCursor.length > 16_384)) {
      return fail("logical-session-store-response-invalid");
    }
    items.push(...page.items);
    if (page.nextCursor !== undefined) return { items, nextCursor: createLogicalSearchCursor(manifest, branchId, index, page.nextCursor) };
    index += 1; storeCursor = undefined;
  }
  return { items, ...(index < routes.length ? { nextCursor: createLogicalSearchCursor(manifest, branchId, index) } : {}) };
}
