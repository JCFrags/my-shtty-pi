import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { canonical, digest, fail, listJson, object, privateDirectory, readJson, readPrivate, writePrivate } from "./files.ts";

export const BINDING_ENTRY = "pi-notify-binding-v1";
export interface SessionView {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly leafId: string | null;
  readonly entries: readonly Record<string, unknown>[];
}
export interface ChronoIdentity {
  readonly logicalSessionId: string;
  readonly branchId: string;
  readonly shardId: string;
  readonly ordinal: number;
  readonly predecessorShardIds: readonly string[];
}
export interface SavedBinding {
  readonly schemaVersion: 1;
  readonly destinationId: string;
  readonly bindingId: string;
  readonly boundAt: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly anchorId: string;
  readonly resumeAnchorId: string;
  readonly chrono?: ChronoIdentity;
  readonly suspended: boolean;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Read-only compatibility with Chrono's logical-session v1 contract. No module
 * is imported from an installation path, and no Chrono state is created. A
 * copied continuation cannot activate a fork with a different physical ID. */
export function readChronoIdentity(view: SessionView, root: string): ChronoIdentity | undefined {
  const markers = view.entries.filter(entry => (entry.type === "custom" && entry.customType === "chrono-logical-adoption")
    || (entry.type === "custom_message" && entry.customType === "chrono-logical-continuation"));
  if (markers.length === 0) return undefined;
  if (markers.length !== 1) fail("notify_chrono_binding_ambiguous");
  const marker = markers[0]!;
  const data = marker.type === "custom" ? marker.data : marker.details;
  if (!object(data) || data.schemaVersion !== 1 || !uuid(data.logicalSessionId) || !key(data.branchId)) fail("notify_chrono_binding_invalid");
  const logicalId = data.logicalSessionId as string;
  privateDirectory(root);
  privateDirectory(join(root, logicalId));
  const manifest: unknown = JSON.parse(readPrivate(join(root, logicalId, "manifest.json")));
  if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.logicalSessionId !== logicalId
    || !Number.isSafeInteger(manifest.revision) || Number(manifest.revision) < 1 || !sha(manifest.integrityHash)
    || manifest.pendingRollover !== undefined || !Array.isArray(manifest.branches) || !Array.isArray(manifest.shards)
    || manifest.branches.length > 256 || manifest.shards.length > 1024) fail("notify_chrono_manifest_invalid");
  const { integrityHash, ...body } = manifest;
  if (digest("chrono-logical-session-manifest-v1\0" + canonical(body)) !== integrityHash) fail("notify_chrono_manifest_integrity");
  const branches = manifest.branches.filter((branch: unknown) => object(branch) && branch.branchId === data.branchId);
  if (branches.length !== 1) fail("notify_chrono_branch_invalid");
  const branch = branches[0] as Record<string, unknown>;
  if (!uuid(branch.activeShardId) || !Array.isArray(branch.shardIds) || branch.shardIds.length < 1
    || !branch.shardIds.every(uuid) || new Set(branch.shardIds).size !== branch.shardIds.length) fail("notify_chrono_branch_invalid");
  const shards = branch.shardIds.map(id => {
    const matches = (manifest.shards as unknown[]).filter(shard => object(shard) && shard.shardId === id);
    if (matches.length !== 1) fail("notify_chrono_shard_invalid");
    return matches[0] as Record<string, unknown>;
  });
  for (const [ordinal, shard] of shards.entries()) {
    if (shard.branchId !== branch.branchId || shard.ordinal !== ordinal || !key(shard.piSessionId)
      || typeof shard.sourcePath !== "string" || !isAbsolute(shard.sourcePath)
      || shard.state !== (ordinal === shards.length - 1 ? "active" : "closed")) fail("notify_chrono_shard_invalid");
  }
  const active = shards.at(-1)!;
  if (active.shardId !== branch.activeShardId || active.piSessionId !== view.sessionId || active.sourcePath !== view.sessionFile) fail("notify_chrono_physical_mismatch");
  if (marker.type === "custom") {
    if (data.shardId !== active.shardId || shards.length !== 1 || branch.parent !== undefined || active.continuationHash !== undefined) fail("notify_chrono_adoption_invalid");
  } else {
    if (data.toShardId !== active.shardId || !uuid(data.fromShardId) || !uuid(data.operationId)
      || !sha(data.continuationHash) || data.continuationHash !== active.continuationHash || !sha(data.summaryHash)
      || typeof marker.content !== "string" || digest(marker.content) !== data.summaryHash) fail("notify_chrono_continuation_invalid");
    if (shards.length > 1 && data.fromShardId !== shards.at(-2)!.shardId) fail("notify_chrono_predecessor_invalid");
  }
  return { logicalSessionId: logicalId, branchId: branch.branchId as string, shardId: active.shardId as string,
    ordinal: active.ordinal as number, predecessorShardIds: shards.slice(0, -1).map(shard => shard.shardId as string) };
}

function validBinding(value: unknown): value is SavedBinding {
  return object(value) && value.schemaVersion === 1 && key(value.destinationId) && uuid(value.bindingId)
    && typeof value.boundAt === "string" && typeof value.sessionId === "string" && typeof value.sessionFile === "string"
    && isAbsolute(value.sessionFile) && typeof value.anchorId === "string" && typeof value.resumeAnchorId === "string"
    && typeof value.suspended === "boolean" && (value.chrono === undefined || (object(value.chrono) && uuid(value.chrono.logicalSessionId)
      && key(value.chrono.branchId) && uuid(value.chrono.shardId) && Number.isSafeInteger(value.chrono.ordinal)
      && Array.isArray(value.chrono.predecessorShardIds) && value.chrono.predecessorShardIds.every(uuid)));
}

export class IdentityRegistry {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  private path(destinationId: string): string {
    if (!key(destinationId)) fail("notify_destination_id_invalid");
    return join(this.directory, `${digest(destinationId)}.json`);
  }
  get(destinationId: string): SavedBinding | undefined {
    const value = readJson<unknown>(this.path(destinationId));
    if (value === undefined) return undefined;
    if (!validBinding(value) || value.destinationId !== destinationId) fail("notify_binding_invalid");
    return value;
  }
  save(binding: SavedBinding): void {
    if (!validBinding(binding)) fail("notify_binding_invalid");
    writePrivate(this.path(binding.destinationId), binding);
  }
  all(): SavedBinding[] {
    return listJson(this.directory).map(path => {
      const value = readJson<unknown>(path);
      if (!validBinding(value) || path !== this.path(value.destinationId)) fail("notify_binding_invalid");
      return value;
    });
  }
  find(view: SessionView, chrono: ChronoIdentity | undefined): SavedBinding | undefined {
    const candidates = this.all().filter(binding => this.matches(binding, view, chrono));
    if (candidates.length > 1) fail("notify_multiple_targets_for_context");
    return candidates[0];
  }
  matches(binding: SavedBinding, view: SessionView, chrono: ChronoIdentity | undefined): boolean {
    if (binding.suspended) return false;
    if (binding.sessionId === view.sessionId && binding.sessionFile === view.sessionFile) {
      const marker = view.entries.find(entry => entry.id === binding.anchorId && entry.type === "custom" && entry.customType === BINDING_ENTRY);
      return object(marker?.data) && marker.data.bindingId === binding.bindingId && marker.data.destinationId === binding.destinationId
        && view.entries.some(entry => entry.id === binding.resumeAnchorId);
    }
    // Only forward movement on the same registered logical branch is automatic.
    // Native forks and Chrono's explicit branch forks cannot inherit this target.
    return !!binding.chrono && !!chrono && binding.chrono.logicalSessionId === chrono.logicalSessionId
      && binding.chrono.branchId === chrono.branchId && chrono.ordinal > binding.chrono.ordinal
      && chrono.predecessorShardIds.includes(binding.chrono.shardId);
  }
}

export function newBinding(destinationId: string, view: SessionView, anchorId: string, bindingId = randomUUID(), chrono?: ChronoIdentity): SavedBinding {
  return { schemaVersion: 1, destinationId, bindingId, boundAt: new Date().toISOString(), sessionId: view.sessionId,
    sessionFile: view.sessionFile, anchorId, resumeAnchorId: anchorId, ...(chrono ? { chrono } : {}), suspended: false };
}
