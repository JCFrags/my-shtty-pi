import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CommitOptions, ImportReceiptInput, ObjectLocation, ObjectRef, OwnedSnapshot, OwnerResolution,
  OwnerStatus, ResolveOptions, SessionEntryView, StateAnchorHost, StateOwnerOptions, StateScope } from "./types.ts";
import { checkedEntry, currentScope } from "./ancestry.ts";
import { OwnedObjectStore, publishPrivateBytes, readPrivateRecord, writePrivateRecord } from "./objects.ts";
import { acquireSourceLock, anchorDataMatches, captureSource, sameSource, sourceKey, validateSource,
  verifyDiskAnchor, type AnchorProof, type SourceIdentity } from "./source.ts";
import { canonicalJson, checkSignal, detach, exact, fail, freezeJson, hashText, identifier, integer, isHash,
  isStoreId, objectRef, sameScope, scope, STATE_ANCHOR_TYPE, STATE_STORE_LIMITS, StateStoreError } from "./validation.ts";

interface AnchorData { version: 1; providerId: string; storeId: string; commitRef: ObjectRef }
interface CommitRecord {
  version: 1; commitId: string; parentCommitId: string | null; rootRef: ObjectRef;
  origin: StateScope; source: SourceIdentity; importReceipt?: ObjectRef;
}
interface CommittedReceipt {
  version: 1; commitRef: ObjectRef; anchor: SessionEntryView;
  durability: SourceIdentity["durability"]; proof?: Omit<AnchorProof, "entry">;
}
interface ViewKey { version: 1; scope: StateScope; sourceKey: string }
interface Binding extends ViewKey { head: string; anchorId: string; commitRef: ObjectRef }
interface Cursor extends ViewKey { nextEntryId: string | null; scanned: number; legacySeen: boolean }
interface PendingCommit { record: CommitRecord; commitRef: ObjectRef; data: AnchorData; operationId: string }
interface View<Root> { source: SourceIdentity; resolution: OwnerResolution<Root> }
interface CapturedView { epoch: number; scope: StateScope; source: SourceIdentity }

function keyOf(view: ViewKey): string { return hashText(canonicalJson(view, STATE_STORE_LIMITS.recordBytes)); }
function nativeSignature(entry: SessionEntryView): string {
  return hashText(canonicalJson({ id: entry.id, parentId: entry.parentId, type: entry.type,
    customType: entry.customType ?? null }, STATE_STORE_LIMITS.anchorBytes));
}
function resolutionScope<Root>(resolution: OwnerResolution<Root>): StateScope {
  return resolution.status === "ready" ? resolution.snapshot.scope : resolution.scope;
}
function receiptInput(value: ImportReceiptInput, expected: StateScope): void {
  exact(value, ["importer", "source", "coverage"], ["evidence"]);
  identifier(value.importer); scope(value.source);
  if (!sameScope(value.source, expected)) fail("state-store-scope-changed");
  exact(value.coverage, ["scannedEntries", "providerEntries", "complete", "sourceDigest"]);
  integer(value.coverage.scannedEntries, 0, Number.MAX_SAFE_INTEGER);
  integer(value.coverage.providerEntries, 0, value.coverage.scannedEntries);
  if (value.coverage.complete !== true || !isHash(value.coverage.sourceDigest)) fail("state-store-legacy-required");
  if (value.evidence !== undefined) objectRef(value.evidence);
}

/** One provider instance owns its objects, selected root, bounded indexes, and lifecycle. */
export class BranchStateOwner<Root> {
  readonly objects: OwnedObjectStore;
  private readonly options: StateOwnerOptions<Root>;
  private readonly rootMaximum: number;
  private readonly rootObjectMaximum: number;
  private readonly pageEntries: number;
  private readonly cacheMaximum: number;
  private readonly bindings = new Map<string, Binding>();
  private epoch = 0;
  private closed = false;
  private busy = false;
  private selected?: View<Root>;
  private pending?: PendingCommit;

  constructor(options: StateOwnerOptions<Root>) {
    this.objects = new OwnedObjectStore(options);
    if (typeof options.validateRoot !== "function" || typeof options.isLegacyEntry !== "function") fail("state-store-invalid");
    this.options = { ...options };
    this.rootMaximum = options.rootMaxBytes ?? STATE_STORE_LIMITS.rootBytes;
    this.rootObjectMaximum = Math.min(this.rootMaximum + 512, STATE_STORE_LIMITS.objectBytes);
    this.pageEntries = options.ancestryPageEntries ?? STATE_STORE_LIMITS.ancestryEntries;
    this.cacheMaximum = options.bindingCacheEntries ?? STATE_STORE_LIMITS.bindingCacheEntries;
    integer(this.rootMaximum, 1, STATE_STORE_LIMITS.objectBytes);
    integer(this.pageEntries, 1, STATE_STORE_LIMITS.maxAncestryEntries);
    integer(this.cacheMaximum, 1, STATE_STORE_LIMITS.maxBindingCacheEntries);
  }
  invalidate(): void { this.epoch++; this.selected = undefined; this.bindings.clear(); }
  close(): void { this.invalidate(); this.closed = true; }
  status(): OwnerStatus {
    const resolution = this.selected?.resolution;
    return { providerId: this.options.providerId, epoch: this.epoch,
      state: this.closed ? "closed" : this.pending ? "uncertain" : resolution?.status ?? "unresolved",
      ...(this.pending ? { operationId: this.pending.operationId } : {}),
      ...(resolution?.status === "ready" ? { commitId: resolution.snapshot.commitId, durability: resolution.snapshot.durability } : {}) };
  }
  private active(signal?: AbortSignal): void { if (this.closed) fail("state-store-closed"); checkSignal(signal); }
  private async capture(host: StateAnchorHost, signal?: AbortSignal): Promise<CapturedView> {
    this.active(signal);
    const epoch = this.epoch, view = currentScope(host.sessionManager);
    const source = await captureSource(host.sessionManager);
    if (epoch !== this.epoch || !sameScope(view, currentScope(host.sessionManager))) fail("state-store-scope-changed");
    this.active(signal);
    return { epoch, scope: view, source };
  }
  private async unchanged(host: StateAnchorHost, view: CapturedView, signal?: AbortSignal, exactSize = true): Promise<void> {
    this.active(signal);
    if (this.epoch !== view.epoch || !sameScope(view.scope, currentScope(host.sessionManager))) fail("state-store-scope-changed");
    const source = await captureSource(host.sessionManager);
    if (this.epoch !== view.epoch || !sameScope(view.scope, currentScope(host.sessionManager))
      || !sameSource(view.source, source, exactSize)) fail("state-store-scope-changed");
    this.active(signal);
  }
  private viewKey(view: CapturedView): ViewKey { return { version: 1, scope: view.scope, sourceKey: sourceKey(view.source) }; }
  private belongs(ref: ObjectRef, location: ObjectLocation): void {
    objectRef(ref);
    if (ref.providerId !== location.providerId || ref.storeId !== location.storeId) fail("state-store-corrupt");
  }
  private anchorData(ref: ObjectRef, location: ObjectLocation): AnchorData {
    return { version: 1, providerId: location.providerId, storeId: location.storeId, commitRef: ref };
  }
  private anchorRef(entry: SessionEntryView, location: ObjectLocation): ObjectRef | undefined {
    if (entry.type !== "custom" || !entry.customType?.startsWith("context-kit:state-anchor:")) return undefined;
    // Other providers share the native custom type, but never their objects or indexes.
    const provider = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>).providerId : undefined;
    if ((provider === "todo" || provider === "notes" || provider === "workplan") && provider !== location.providerId) return undefined;
    if (entry.customType !== STATE_ANCHOR_TYPE) fail("state-store-corrupt");
    const value = detach(entry.data, STATE_STORE_LIMITS.anchorBytes);
    exact(value, ["version", "providerId", "storeId", "commitRef"]);
    if (value.version !== 1 || value.providerId !== location.providerId || value.storeId !== location.storeId) fail("state-store-corrupt");
    this.belongs(value.commitRef as ObjectRef, location);
    return value.commitRef as ObjectRef;
  }
  private async commitRecord(ref: ObjectRef, location: ObjectLocation): Promise<CommitRecord> {
    this.belongs(ref, location);
    const record = await this.objects.read<CommitRecord>(ref, { maxBytes: STATE_STORE_LIMITS.recordBytes });
    exact(record, ["version", "commitId", "parentCommitId", "rootRef", "origin", "source"], ["importReceipt"]);
    if (record.version !== 1 || !isStoreId(record.commitId) || record.parentCommitId !== null && !isStoreId(record.parentCommitId)) fail("state-store-corrupt");
    scope(record.origin); validateSource(record.source);
    if (record.source.sessionId !== record.origin.sessionId) fail("state-store-corrupt");
    this.belongs(record.rootRef, location);
    if (record.importReceipt !== undefined) this.belongs(record.importReceipt, location);
    return record;
  }
  private async committed(record: CommitRecord, ref: ObjectRef, location: ObjectLocation,
    live?: SessionEntryView): Promise<CommittedReceipt> {
    const path = join(location.root, "commits", `${record.commitId}.json`);
    let receipt = await readPrivateRecord<CommittedReceipt>(path);
    const data = this.anchorData(ref, location);
    if (receipt === undefined) {
      // Object publication without this bounded native append is never a commit.
      const proof = await verifyDiskAnchor(record.source, record.origin, data, live);
      receipt = { version: 1, commitRef: ref, anchor: proof.entry, durability: "disk",
        proof: { offset: proof.offset, bytes: proof.bytes, lineHash: proof.lineHash } };
      await publishPrivateBytes(path, Buffer.from(canonicalJson(receipt, STATE_STORE_LIMITS.recordBytes)));
    }
    exact(receipt, ["version", "commitRef", "anchor", "durability"], ["proof"]);
    this.belongs(receipt.commitRef, location);
    if (receipt.version !== 1 || receipt.commitRef.hash !== ref.hash || receipt.commitRef.bytes !== ref.bytes
      || receipt.durability !== record.source.durability) fail("state-store-corrupt");
    identifier(receipt.anchor.id);
    if (receipt.anchor.parentId !== record.origin.leafId || !anchorDataMatches(receipt.anchor, data)) fail("state-store-corrupt");
    if (receipt.durability === "disk") {
      exact(receipt.proof, ["offset", "bytes", "lineHash"]);
      if (record.source.durability !== "disk" || receipt.proof.offset !== record.source.size || !isHash(receipt.proof.lineHash)) fail("state-store-corrupt");
      integer(receipt.proof.bytes, 1, STATE_STORE_LIMITS.anchorBytes);
    } else if (receipt.proof !== undefined) fail("state-store-corrupt");
    return receipt;
  }
  private async snapshot(host: StateAnchorHost, view: CapturedView, anchor: SessionEntryView, ref: ObjectRef,
    location: ObjectLocation): Promise<OwnedSnapshot<Root>> {
    const record = await this.commitRecord(ref, location);
    const receipt = await this.committed(record, ref, location);
    if (anchor.id !== receipt.anchor.id || !anchorDataMatches(anchor, this.anchorData(ref, location))) fail("state-store-corrupt");
    if (record.origin.sessionId === view.scope.sessionId) {
      const materialized = record.source.durability === "ephemeral" || record.source.durability === "deferred"
        && view.source.durability !== "ephemeral" && record.source.file === view.source.file;
      if (anchor.parentId !== record.origin.leafId || !sameSource(record.source, view.source) && !materialized) fail("state-store-corrupt");
    } else {
      const parent = host.sessionManager.getHeader()?.parentSession;
      if (typeof parent !== "string" || !parent || parent.length > 4096) fail("state-store-corrupt");
    }
    const root = await this.objects.read<Root>(record.rootRef, { maxBytes: this.rootObjectMaximum });
    canonicalJson(root, this.rootMaximum); this.options.validateRoot(root);
    return freezeJson({ commitId: record.commitId, parentCommitId: record.parentCommitId,
      rootRef: record.rootRef, root, anchorId: anchor.id, scope: view.scope, origin: record.origin,
      durability: view.source.durability === "disk" ? receipt.durability : view.source.durability,
      ...(record.importReceipt ? { importReceipt: record.importReceipt } : {}) });
  }
  private cacheBinding(key: string, binding: Binding): void {
    this.bindings.delete(key); this.bindings.set(key, binding);
    while (this.bindings.size > this.cacheMaximum) this.bindings.delete(this.bindings.keys().next().value!);
  }
  private async loadBinding(location: ObjectLocation, key: ViewKey): Promise<Binding | undefined> {
    const hash = keyOf(key);
    const binding = this.bindings.get(hash) ?? await readPrivateRecord<Binding>(join(location.root, "bindings", `${hash}.json`));
    if (!binding) return undefined;
    exact(binding, ["version", "scope", "sourceKey", "head", "anchorId", "commitRef"]);
    scope(binding.scope); identifier(binding.anchorId);
    if (binding.version !== 1 || !sameScope(binding.scope, key.scope) || binding.sourceKey !== key.sourceKey || !isHash(binding.head)) fail("state-store-corrupt");
    this.belongs(binding.commitRef, location);
    this.cacheBinding(hash, binding);
    return binding;
  }
  private async saveBinding(location: ObjectLocation, key: ViewKey, head: SessionEntryView,
    anchor: SessionEntryView, ref: ObjectRef): Promise<void> {
    const binding: Binding = { ...key, head: nativeSignature(head), anchorId: anchor.id, commitRef: ref };
    const hash = keyOf(key);
    await writePrivateRecord(join(location.root, "bindings", `${hash}.json`), binding);
    this.cacheBinding(hash, binding);
  }
  private async reconcilePending(host: StateAnchorHost, location: ObjectLocation): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    try {
      await this.committed(pending.record, pending.commitRef, location);
      this.pending = undefined;
    } catch (error) {
      // A thrown append that left both the source cut and live leaf unchanged is an orphan.
      const source = await captureSource(host.sessionManager);
      if (sameScope(pending.record.origin, currentScope(host.sessionManager)) && sameSource(pending.record.source, source, true)) {
        this.pending = undefined;
        return;
      }
      if (error instanceof StateStoreError && error.code === "state-store-unpersisted") fail("state-store-uncertain", source.durability);
      throw error;
    }
  }
  async resolve(host: StateAnchorHost, options: ResolveOptions = {}): Promise<OwnerResolution<Root>> {
    this.active(options.signal);
    if (this.busy) fail("state-store-busy");
    this.busy = true;
    try {
      const location = await this.objects.location();
      await this.reconcilePending(host, location);
      const view = await this.capture(host, options.signal), key = this.viewKey(view);
      const hash = keyOf(key), path = join(location.root, "resolutions", `${hash}.json`);
      let cursor = await readPrivateRecord<Cursor>(path);
      if (cursor) {
        exact(cursor, ["version", "scope", "sourceKey", "nextEntryId", "scanned", "legacySeen"]);
        scope(cursor.scope); integer(cursor.scanned, 0, Number.MAX_SAFE_INTEGER);
        if (cursor.version !== 1 || !sameScope(cursor.scope, view.scope) || cursor.sourceKey !== key.sourceKey
          || typeof cursor.legacySeen !== "boolean") fail("state-store-corrupt");
        if (cursor.nextEntryId !== null) identifier(cursor.nextEntryId);
      } else cursor = { ...key, nextEntryId: view.scope.leafId, scanned: 0, legacySeen: false };
      let result: OwnerResolution<Root> | undefined;
      let head: SessionEntryView | undefined;
      const seen = new Set<string>();
      let reads = 0;
      const getEntry = (id: string): SessionEntryView => { reads++; return checkedEntry(host.sessionManager, id); };
      while (cursor.nextEntryId !== null && reads < this.pageEntries) {
        checkSignal(options.signal);
        const id = cursor.nextEntryId;
        if (seen.has(id)) fail("state-store-corrupt");
        seen.add(id);
        const entry = getEntry(id);
        if (id === view.scope.leafId) head = entry;
        const ref = this.anchorRef(entry, location);
        if (ref && !cursor.legacySeen) {
          const snapshot = await this.snapshot(host, view, entry, ref, location);
          result = { status: "ready", snapshot, coverage: { scanned: cursor.scanned + reads, complete: true, legacySeen: false } };
          await this.unchanged(host, view, options.signal);
          if (head) await this.saveBinding(location, key, head, entry, ref);
          break;
        }
        if (this.options.isLegacyEntry(entry)) cursor.legacySeen = true;
        // A previous complete binding avoids replay through a long stable ancestor chain.
        if (!cursor.legacySeen && reads < this.pageEntries) {
          const binding = await this.loadBinding(location, { ...key, scope: { sessionId: view.scope.sessionId, leafId: id } });
          if (binding) {
            if (binding.head !== nativeSignature(entry)) fail("state-store-corrupt");
            const anchor = getEntry(binding.anchorId);
            if (this.anchorRef(anchor, location)?.hash !== binding.commitRef.hash) fail("state-store-corrupt");
            const snapshot = await this.snapshot(host, view, anchor, binding.commitRef, location);
            result = { status: "ready", snapshot, coverage: { scanned: cursor.scanned + reads, complete: true, legacySeen: false } };
            await this.unchanged(host, view, options.signal);
            if (head) await this.saveBinding(location, key, head, anchor, binding.commitRef);
            break;
          }
        }
        cursor.nextEntryId = entry.parentId;
      }
      if (!result) {
        cursor.scanned += reads;
        await this.unchanged(host, view, options.signal);
        await writePrivateRecord(path, cursor);
        const coverage = { scanned: cursor.scanned, complete: cursor.nextEntryId === null, legacySeen: cursor.legacySeen };
        result = cursor.nextEntryId === null
          ? { status: cursor.legacySeen ? "legacy" : "empty", scope: view.scope, coverage }
          : { status: "pending", scope: view.scope, continuation: hashText(canonicalJson(cursor, STATE_STORE_LIMITS.recordBytes)), coverage };
      }
      await this.unchanged(host, view, options.signal);
      this.selected = { source: view.source, resolution: result };
      return result;
    } finally { this.busy = false; }
  }
  async readProgress<T>(host: StateAnchorHost, key: string): Promise<T | undefined> {
    identifier(key);
    const view = await this.capture(host), location = await this.objects.location();
    const binding = this.viewKey(view);
    const hash = hashText(canonicalJson({ ...binding, key }, STATE_STORE_LIMITS.recordBytes));
    const value = await readPrivateRecord<Record<string, unknown>>(join(location.root, "imports", `${hash}.json`));
    if (value !== undefined) {
      exact(value, ["version", "scope", "sourceKey", "key", "value"]);
      scope(value.scope);
      if (value.version !== 1 || value.sourceKey !== binding.sourceKey || !sameScope(value.scope, view.scope) || value.key !== key) fail("state-store-corrupt");
      canonicalJson(value, STATE_STORE_LIMITS.recordBytes);
    }
    await this.unchanged(host, view);
    return value?.value as T | undefined;
  }
  async writeProgress<T>(host: StateAnchorHost, key: string, value: T): Promise<void> {
    identifier(key);
    const view = await this.capture(host), location = await this.objects.location();
    const binding = this.viewKey(view);
    const hash = hashText(canonicalJson({ ...binding, key }, STATE_STORE_LIMITS.recordBytes));
    const record = detach({ ...binding, key, value }, STATE_STORE_LIMITS.recordBytes);
    await this.unchanged(host, view);
    await writePrivateRecord(join(location.root, "imports", `${hash}.json`), record);
    await this.unchanged(host, view);
  }
  async commit(host: StateAnchorHost, nextRoot: Root, options: CommitOptions): Promise<OwnedSnapshot<Root>> {
    this.active(options?.signal);
    if (this.busy) fail("state-store-busy");
    if (this.pending) fail("state-store-uncertain");
    if (!options || options.expectedCommitId !== null && !isStoreId(options.expectedCommitId)
      || options.durability !== undefined && options.durability !== "require-disk" && options.durability !== "allow-volatile") fail("state-store-invalid");
    const selected = this.selected;
    if (!selected || selected.resolution.status === "pending") fail("state-store-unresolved");
    const previous = selected.resolution.status === "ready" ? selected.resolution.snapshot.commitId : null;
    if (previous !== options.expectedCommitId) fail("state-store-conflict");
    if (selected.resolution.status === "legacy" && !options.importReceipt) fail("state-store-legacy-required");
    this.busy = true;
    let release: (() => Promise<void>) | undefined;
    try {
      const view = await this.capture(host, options.signal), location = await this.objects.location();
      if (!sameScope(resolutionScope(selected.resolution), view.scope) || !sameSource(selected.source, view.source)) fail("state-store-scope-changed");
      if (view.source.durability !== "disk" && options.durability !== "allow-volatile") fail("state-store-unpersisted", view.source.durability);
      if (options.importReceipt) {
        receiptInput(options.importReceipt, view.scope);
        if (options.importReceipt.evidence) this.belongs(options.importReceipt.evidence, location);
      }
      const root = detach(nextRoot, this.rootMaximum);
      this.options.validateRoot(root);
      const operationId = randomUUID();
      release = await acquireSourceLock(location, view.source, operationId);
      const rootRef = await this.objects.publish(root, { maxBytes: this.rootObjectMaximum, signal: options.signal });
      const importReceipt = options.importReceipt ? await this.objects.publish({ version: 1, providerId: location.providerId,
        ...detach(options.importReceipt, STATE_STORE_LIMITS.recordBytes), rootRef }, { maxBytes: STATE_STORE_LIMITS.recordBytes, signal: options.signal }) : undefined;
      const record: CommitRecord = { version: 1, commitId: operationId, parentCommitId: previous,
        rootRef, origin: view.scope, source: view.source, ...(importReceipt ? { importReceipt } : {}) };
      const commitRef = await this.objects.publish(record, { maxBytes: STATE_STORE_LIMITS.recordBytes, signal: options.signal });
      const data = this.anchorData(commitRef, location);
      await this.unchanged(host, view, options.signal);
      this.pending = { record, commitRef, data, operationId };
      host.appendEntry(STATE_ANCHOR_TYPE, data);
      const anchoredScope = currentScope(host.sessionManager);
      if (view.epoch !== this.epoch || anchoredScope.sessionId !== view.scope.sessionId || anchoredScope.leafId === null) fail("state-store-uncertain");
      const anchor = checkedEntry(host.sessionManager, anchoredScope.leafId);
      if (anchor.parentId !== view.scope.leafId || !anchorDataMatches(anchor, data)) fail("state-store-uncertain");
      let receipt: CommittedReceipt;
      if (view.source.durability === "disk") {
        const proof = await verifyDiskAnchor(view.source, view.scope, data, anchor);
        receipt = { version: 1, commitRef, anchor: proof.entry, durability: "disk",
          proof: { offset: proof.offset, bytes: proof.bytes, lineHash: proof.lineHash } };
      } else receipt = { version: 1, commitRef, anchor: detach(anchor, STATE_STORE_LIMITS.anchorBytes), durability: view.source.durability };
      await publishPrivateBytes(join(location.root, "commits", `${operationId}.json`), Buffer.from(canonicalJson(receipt, STATE_STORE_LIMITS.recordBytes)));
      const after = await this.capture(host, options.signal);
      if (view.epoch !== after.epoch || !sameScope(after.scope, anchoredScope) || !sameSource(after.source, view.source)) fail("state-store-uncertain");
      const snapshot: OwnedSnapshot<Root> = freezeJson({ commitId: operationId, parentCommitId: previous, rootRef,
        root, anchorId: anchor.id, scope: anchoredScope, origin: view.scope, durability: view.source.durability,
        ...(importReceipt ? { importReceipt } : {}) });
      await this.saveBinding(location, this.viewKey(after), anchor, anchor, commitRef);
      await this.unchanged(host, after, options.signal);
      this.pending = undefined;
      this.selected = { source: after.source, resolution: { status: "ready", snapshot,
        coverage: { scanned: 0, complete: true, legacySeen: false } } };
      return snapshot;
    } catch (error) {
      if (this.pending) fail("state-store-uncertain", this.pending.record.source.durability);
      throw error;
    } finally {
      try { await release?.(); } finally { this.busy = false; }
    }
  }
}
