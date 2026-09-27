import { createHash } from "node:crypto";
import { BranchStateOwner, StateStoreError, type ObjectRef, type OwnedSnapshot, type StateAnchorHost, type StateScope } from "@context-kit/state-store";
import { cloneNotesState, emptyNotesState, performNotesAction, validateNotesState, type NotesInput, type NotesOperation, type NotesState } from "@grounded/pi-core/notes";
import { cancelled, requireExactObject, requireSafeInteger, stableJson, StateToolError } from "@grounded/pi-core/state";
import { findNotesBootstrap, notesBootstrapReceipt } from "./bootstrap.ts";
import { advanceNotesImport, isLegacyNotesEntry, notesImportReceipt, type NotesImportCursor } from "./legacy.ts";

export interface NotesOwnerMetadata {
  version: 1; provider: "notes"; commitId: string | null; parentCommitId: string | null; rootRef: ObjectRef | null;
  origin: StateScope | null; importReceipt: ObjectRef | null; nativeDigest: string; recordRevision: number;
}
export interface NotesRoot {
  version: 1; native: NotesState;
  inherited?: Pick<NotesOwnerMetadata, "commitId" | "rootRef" | "origin" | "importReceipt">;
}
// JSON escaping and bounded note metadata can exceed the 1 MiB body budget.
const ROOT_BYTES = 8 * 1024 * 1024;
export function validateNotesRoot(root: NotesRoot): void {
  requireExactObject(root, ["version", "native"], ["inherited"], "Notes root", "STATE_CORRUPT");
  if (root.version !== 1) throw new StateToolError("STATE_CORRUPT", "Unsupported Notes root version");
  validateNotesState(root.native);
  if (root.inherited !== undefined) validateLineage(root.inherited);
}
function nativeDigest(state: NotesState): string { return createHash("sha256").update(stableJson(state)).digest("hex"); }
function validateReference(value: ObjectRef | null): void {
  if (value === null) return;
  requireExactObject(value, ["version", "providerId", "storeId", "hash", "bytes"], [], "owner reference", "STATE_CORRUPT");
  if (value.version !== 1 || value.providerId !== "notes" || typeof value.storeId !== "string" || !/^[a-f0-9-]{36}$/.test(value.storeId)
    || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash)) throw new StateToolError("STATE_CORRUPT", "Invalid owner reference");
  requireSafeInteger(value.bytes, "object bytes", 1, "STATE_CORRUPT");
}
function validateLineage(value: NonNullable<NotesRoot["inherited"]>): void {
  requireExactObject(value, ["commitId", "rootRef", "origin", "importReceipt"], [], "owner lineage", "STATE_CORRUPT");
  if (value.commitId !== null && (typeof value.commitId !== "string" || !value.commitId || Buffer.byteLength(value.commitId) > 128)) throw new StateToolError("STATE_CORRUPT", "Invalid owner commit identity");
  validateReference(value.rootRef); validateReference(value.importReceipt);
  if (value.origin !== null) {
    requireExactObject(value.origin, ["sessionId", "leafId"], [], "owner origin", "STATE_CORRUPT");
    if (typeof value.origin.sessionId !== "string" || !value.origin.sessionId || Buffer.byteLength(value.origin.sessionId) > 128
      || (value.origin.leafId !== null && (typeof value.origin.leafId !== "string" || !value.origin.leafId || Buffer.byteLength(value.origin.leafId) > 128))) throw new StateToolError("STATE_CORRUPT", "Invalid owner origin");
  }
}
function restoredRoot(state: NotesState, metadata?: NotesOwnerMetadata): NotesRoot {
  validateNotesState(state);
  if (metadata === undefined) return { version: 1, native: cloneNotesState(state) };
  requireExactObject(metadata, ["version", "provider", "commitId", "parentCommitId", "rootRef", "origin", "importReceipt", "nativeDigest", "recordRevision"], [], "owner metadata", "STATE_CORRUPT");
  if (metadata.version !== 1 || metadata.provider !== "notes" || metadata.nativeDigest !== nativeDigest(state)) throw new StateToolError("STATE_CORRUPT", "Owner metadata does not match the native checkpoint");
  requireSafeInteger(metadata.recordRevision, "owner revision", 0, "STATE_CORRUPT");
  if (metadata.parentCommitId !== null && (typeof metadata.parentCommitId !== "string" || !metadata.parentCommitId || Buffer.byteLength(metadata.parentCommitId) > 128)) throw new StateToolError("STATE_CORRUPT", "Invalid parent commit identity");
  const inherited = { commitId: metadata.commitId, rootRef: metadata.rootRef, origin: metadata.origin, importReceipt: metadata.importReceipt };
  validateLineage(inherited);
  if (metadata.recordRevision !== state.stateRevision) throw new StateToolError("STATE_CORRUPT", "Notes revision does not match its checkpoint");
  const root: NotesRoot = { version: 1, native: cloneNotesState(state),  inherited };
  validateNotesRoot(root);
  return root;
}

export type NotesReadiness = "ready" | "pending" | "corrupt" | "unavailable";
/** Complete native snapshots and their old revisions remain immutable owned objects. */
export class NotesStore {
  readonly owner: BranchStateOwner<NotesRoot>;
  private host?: StateAnchorHost;
  private selected?: OwnedSnapshot<NotesRoot>;
  private root?: NotesRoot;
  private phase: NotesReadiness = "unavailable";
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private busy = 0;
  private legacy = false;
  private importCursor?: NotesImportCursor;
  constructor(options: { storeRoot?: string } = {}) {
    this.owner = new BranchStateOwner<NotesRoot>({ providerId: "notes", ...options, rootMaxBytes: ROOT_BYTES,
      validateRoot: validateNotesRoot, isLegacyEntry: isLegacyNotesEntry });
  }
  readiness(): NotesReadiness { return this.busy ? "pending" : this.phase; }
  stateView(): NotesState | undefined { return this.readiness() === "ready" ? this.root?.native : undefined; }
  isLegacy(): boolean { return this.legacy; }
  private serial<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const epoch = this.epoch;
    this.busy++;
    const result = this.queue.then(async () => {
      cancelled(signal);
      if (epoch !== this.epoch) throw new StateToolError("STATE_CONFLICT", "Notes branch changed during the operation");
      try { return await operation(); }
      catch (error) {
        if (this.owner.status().state === "uncertain" || (error instanceof StateStoreError && error.code === "state-store-scope-changed")) {
          this.phase = "pending"; this.root = undefined;
        } else if (error instanceof StateToolError && error.code === "STATE_CORRUPT") {
          this.phase = "corrupt"; this.root = undefined;
        }
        throw error;
      }
    });
    this.queue = result.catch(() => undefined);
    return result.finally(() => { this.busy--; });
  }
  private currentHost(): StateAnchorHost {
    if (!this.host) throw new StateToolError("STATE_CONFLICT", "Notes has no active session");
    return this.host;
  }
  private async resolveNow(signal?: AbortSignal): Promise<void> {
    try {
      const resolution = await this.owner.resolve(this.currentHost(), { signal });
      this.legacy = resolution.status === "legacy";
      this.selected = resolution.status === "ready" ? resolution.snapshot : undefined;
      if (resolution.status === "ready") { this.root = resolution.snapshot.root as NotesRoot; this.phase = "ready"; }
      else if (resolution.status === "empty") { this.root = { version: 1, native: emptyNotesState() }; this.phase = "ready"; }
      else { this.root = undefined; this.phase = "pending"; }
      if (resolution.status === "legacy") {
        const bootstrap = findNotesBootstrap(this.currentHost());
        if (bootstrap) {
          const root = restoredRoot(bootstrap.state, bootstrap.owner);
          const importReceipt = await notesBootstrapReceipt(this.currentHost(), bootstrap, this.owner.objects, signal);
          const committed = await this.owner.commit(this.currentHost(), root, { expectedCommitId: null, importReceipt, signal });
          this.selected = committed; this.root = committed.root as NotesRoot; this.phase = "ready"; this.legacy = false;
        }
      }
    } catch (error) {
      this.root = undefined;
      this.phase = (error instanceof StateStoreError && ["state-store-corrupt", "state-store-missing", "state-store-unsafe-path"].includes(error.code))
        || (error instanceof StateToolError && error.code === "STATE_CORRUPT") ? "corrupt" : "pending";
      throw error;
    }
  }
  private requireRoot(): NotesRoot {
    if (!this.root || this.phase !== "ready") throw new StateToolError(this.phase === "corrupt" ? "STATE_CORRUPT" : "STATE_CONFLICT",
      this.legacy ? "Notes legacy state requires /notes-import. Each invocation advances one bounded step" : "Notes state is pending or unavailable. Retry the native operation to resolve another bounded page");
    return this.root;
  }
  async open(host: StateAnchorHost): Promise<void> {
    this.epoch++; this.owner.invalidate(); this.host = host; this.root = undefined; this.selected = undefined; this.importCursor = undefined; this.phase = "pending";
    return this.serial(() => this.resolveNow());
  }
  refresh(signal?: AbortSignal): Promise<void> { return this.serial(() => this.resolveNow(signal), signal); }
  execute(input: NotesInput, signal?: AbortSignal): Promise<NotesOperation & { owner: NotesOwnerMetadata }> {
    return this.serial(async () => {
      await this.resolveNow(signal);
      const current = this.requireRoot();
      const operation = performNotesAction(current.native, input);
      cancelled(signal);
      if (operation.event) {
        const committed = await this.owner.commit(this.currentHost(), { ...current, native: operation.state }, { expectedCommitId: this.selected?.commitId ?? null, signal });
        this.selected = committed; this.root = committed.root as NotesRoot; this.phase = "ready";
      }
      return { ...operation, owner: this.metadata() };
    }, signal);
  }
  captureNative(): NotesState {
    if (this.busy) throw new StateToolError("STATE_CONFLICT", "Notes has an operation in progress");
    return cloneNotesState(this.requireRoot().native);
  }
  private metadata(): NotesOwnerMetadata {
    const root = this.requireRoot();
    return { version: 1, provider: "notes", commitId: this.selected?.commitId ?? null, parentCommitId: this.selected?.parentCommitId ?? null,
      rootRef: this.selected?.rootRef ?? null, origin: this.selected?.origin ?? null, importReceipt: this.selected?.importReceipt ?? root.inherited?.importReceipt ?? null,
      nativeDigest: nativeDigest(root.native), recordRevision: root.native.stateRevision };
  }
  ownerMetadata(): NotesOwnerMetadata {
    if (this.busy) throw new StateToolError("STATE_CONFLICT", "Notes has an operation in progress");
    return this.metadata();
  }
  checkpoint(signal?: AbortSignal): Promise<{ state: NotesState; owner: NotesOwnerMetadata }> {
    return this.serial(async () => { await this.resolveNow(signal); return { state: cloneNotesState(this.requireRoot().native), owner: this.metadata() }; }, signal);
  }
  restoreNative(state: NotesState, metadata?: NotesOwnerMetadata, signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      await this.resolveNow(signal);
      if (this.phase !== "ready" && !this.legacy) throw new StateToolError("STATE_CONFLICT", "The replacement ancestry is not resolved");
      if (this.selected) throw new StateToolError("STATE_CONFLICT", "Notes already has an owned root");
      if (this.legacy) {
        const bootstrap = findNotesBootstrap(this.currentHost());
        if (!bootstrap || stableJson(bootstrap.state) !== stableJson(state)) throw new StateToolError("STATE_CONFLICT", "Cannot replace unimported legacy state with a checkpoint");
      }
      const root = restoredRoot(state, metadata);
      const committed = await this.owner.commit(this.currentHost(), root, { expectedCommitId: null, signal });
      this.selected = committed; this.root = committed.root as NotesRoot; this.phase = "ready"; this.legacy = false;
    }, signal);
  }
  importStep(signal?: AbortSignal): Promise<{ complete: boolean; phase: string; scannedEntries?: number }> {
    return this.serial(async () => {
      await this.resolveNow(signal);
      if (this.selected) return { complete: true, phase: "owned" };
      if (!this.legacy) return { complete: this.phase === "ready", phase: this.phase === "ready" ? "empty" : "resolve" };
      const saved = await this.owner.readProgress<{ version: 1; cursor: ObjectRef }>(this.currentHost(), "legacy-import-v1");
      if (saved) {
        if (saved.version !== 1) throw new StateToolError("STATE_CORRUPT", "Invalid import progress");
        this.importCursor = await this.owner.objects.read<NotesImportCursor>(saved.cursor, { maxBytes: 9 * 1024 * 1024, signal });
      } else this.importCursor = undefined;
      const next = await advanceNotesImport(this.currentHost(), this.owner.objects, this.importCursor, signal);
      const cursor = await this.owner.objects.publish(next, { maxBytes: 9 * 1024 * 1024, signal });
      await this.owner.writeProgress(this.currentHost(), "legacy-import-v1", { version: 1, cursor });
      this.importCursor = next;
      if (this.importCursor.phase !== "commit") { this.phase = "pending"; this.root = undefined; return { complete: false, phase: this.importCursor.phase, scannedEntries: this.importCursor.scannedEntries }; }
      const root: NotesRoot = { version: 1, native: this.importCursor.native.state };
      const importReceipt = await notesImportReceipt(this.importCursor, this.owner.objects, signal);
      const committed = await this.owner.commit(this.currentHost(), root, { expectedCommitId: null, importReceipt, signal });
      this.selected = committed; this.root = committed.root as NotesRoot; this.phase = "ready"; this.legacy = false;
      return { complete: true, phase: "owned", scannedEntries: this.importCursor.scannedEntries };
    }, signal);
  }
  close(): void { this.epoch++; this.owner.close(); this.host = undefined; this.root = undefined; this.selected = undefined; this.phase = "unavailable"; }
}
