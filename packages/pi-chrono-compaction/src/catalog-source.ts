import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { captureCatalogFileIdentity, isCatalogFileIdentity, sameCatalogFileIdentity, type CatalogFileIdentity } from "./catalog-file-identity.js";

/** Worker-only source access. This counter does NOT include native SQLite I/O. */
export const CATALOG_SOURCE_CHUNK_BYTES = 64 * 1024;
export const CATALOG_SOURCE_ANCHOR_BYTES = 16 * 1024;
export const CATALOG_SOURCE_JOB_BYTES = 8 * 1024 * 1024;
export interface CatalogSourceIdentity { readonly device: string; readonly inode: string }
export interface CatalogSourceAnchor { readonly offset: number; readonly length: number; readonly sha256: string }
export interface CatalogSourceObservation extends CatalogSourceIdentity {
  readonly size: number; readonly mtimeNs: string; readonly ctimeNs: string;
}
export interface CatalogSourceIdentityReceipt {
  readonly version: 1;
  readonly recoveryKey: string;
  readonly storeKey: string;
  readonly sessionKey: string;
  readonly generation: number;
  readonly shardKey: string;
  readonly previousSnapshot: string;
  readonly previousSnapshotHash: string;
  readonly checkpointHash: string;
  readonly bindingHash: string;
  readonly fileIdentity: CatalogFileIdentity;
  readonly observation: CatalogSourceObservation;
  readonly prefixBytes: number;
  readonly spans: number;
  readonly spanChainHash: string;
}
interface SnapshotBase {
  readonly identity: CatalogSourceIdentity;
  readonly size: number;
  readonly anchors: readonly CatalogSourceAnchor[];
}
export type CatalogSourceSnapshot = SnapshotBase & (
  | { readonly schemaVersion: 1 }
  | { readonly schemaVersion: 2; readonly fileIdentity: CatalogFileIdentity; readonly identityReceipt?: CatalogSourceIdentityReceipt }
);
export class CatalogSourceError extends Error {
  constructor(readonly code: "catalog-source-unsafe" | "catalog-source-changed" | "catalog-source-budget" | "catalog-source-range" | "catalog-source-io" | "catalog-source-identity-unavailable") {
    super(code); this.name = "CatalogSourceError";
  }
}
const validInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function safeError(error: unknown): never {
  if (error instanceof CatalogSourceError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "catalog-source-identity-unavailable") throw new CatalogSourceError(code);
  throw new CatalogSourceError(code === "ELOOP" ? "catalog-source-unsafe" : code === "ENOENT" ? "catalog-source-changed" : "catalog-source-io");
}

/** Open once, read bounded ranges, close within one contained job. No source writes.
 * No-follow checks are not a security boundary against a malicious same-UID
 * ancestor rename. The final component is opened with O_NOFOLLOW and pinned by fd.
 */
export class CatalogSource {
  readonly identity: CatalogSourceIdentity;
  readonly fileIdentity: CatalogFileIdentity;
  readonly observation: CatalogSourceObservation;
  readonly size: number;
  private fd: number;
  private used = 0;
  // At most two 16 KiB windows, never a lifetime read log. Only accept() advances
  // these windows: a read can contain a suffix the parser did not consume.
  private evidence?: { size: number; first: Buffer; tail: Buffer; prior: CatalogSourceSnapshot };
  private readonly filename: string;
  constructor(filename: string, readonly budget = CATALOG_SOURCE_JOB_BYTES) {
    if (!isAbsolute(filename) || filename.includes("\0") || !validInteger(budget) || budget < 1 || budget > CATALOG_SOURCE_JOB_BYTES) throw new CatalogSourceError("catalog-source-range");
    this.filename = resolve(filename);
    let fd: number | undefined;
    try {
      const parts = this.filename.split(sep).filter(Boolean);
      let path = "";
      for (const part of parts) {
        path += sep + part;
        if (lstatSync(path).isSymbolicLink()) throw new CatalogSourceError("catalog-source-unsafe");
      }
      fd = openSync(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n) throw new CatalogSourceError("catalog-source-unsafe");
      const size = Number(stat.size);
      if (!validInteger(size)) throw new CatalogSourceError("catalog-source-range");
      this.fd = fd;
      this.size = size;
      this.identity = { device: String(stat.dev), inode: String(stat.ino) };
      this.observation = { ...this.identity, size, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
      this.assertUnchanged(this.observation);
      this.fileIdentity = captureCatalogFileIdentity(fd, stat);
      this.assertUnchanged(this.observation);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve safe original error */ } }
      safeError(error);
    }
  }
  get bytesRead(): number { return this.used; }
  get remainingBytes(): number { return this.budget - this.used; }
  close(): void { if (this.fd >= 0) { const fd = this.fd; this.fd = -1; try { closeSync(fd); } catch (error) { safeError(error); } } }
  assertCurrent(minimumSize = this.size): void {
    if (!validInteger(minimumSize) || minimumSize > this.size) throw new CatalogSourceError("catalog-source-range");
    try {
      const current = lstatSync(this.filename, { bigint: true });
      const pinned = fstatSync(this.fd, { bigint: true });
      for (const stat of [current, pinned]) {
        if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== this.identity.device || String(stat.ino) !== this.identity.inode || stat.size < BigInt(minimumSize)) throw new CatalogSourceError("catalog-source-changed");
      }
    } catch (error) { safeError(error); }
  }
  /** Explicit recovery requires a write-free source window across all pages. */
  assertUnchanged(expected: CatalogSourceObservation): void {
    this.assertCurrent();
    try {
      for (const stat of [lstatSync(this.filename, { bigint: true }), fstatSync(this.fd, { bigint: true })]) {
        if (String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode || Number(stat.size) !== expected.size
          || String(stat.mtimeNs) !== expected.mtimeNs || String(stat.ctimeNs) !== expected.ctimeNs) throw new CatalogSourceError("catalog-source-changed");
      }
    } catch (error) { safeError(error); }
  }
  read(offset: number, length: number): Buffer {
    if (!validInteger(offset) || !validInteger(length) || length > CATALOG_SOURCE_CHUNK_BYTES || offset > this.size || length > this.size - offset) throw new CatalogSourceError("catalog-source-range");
    if (length > this.remainingBytes) throw new CatalogSourceError("catalog-source-budget");
    const bytes = Buffer.allocUnsafe(length);
    try {
      let done = 0;
      while (done < length) {
        const count = readSync(this.fd, bytes, done, length - done, offset + done);
        if (count === 0) throw new CatalogSourceError("catalog-source-changed");
        done += count; this.used += count;
      }
      return bytes;
    } catch (error) { safeError(error); }
  }
  /** Bounded anchors detect sampled changes, NOT every historical prefix rewrite. */
  snapshot(size = this.size): CatalogSourceSnapshot {
    if (!validInteger(size) || size > this.size) throw new CatalogSourceError("catalog-source-range");
    const first = Math.min(size, CATALOG_SOURCE_ANCHOR_BYTES);
    const spans = [{ offset: 0, length: first }];
    if (size > first) spans.push({ offset: Math.max(first, size - CATALOG_SOURCE_ANCHOR_BYTES), length: Math.min(size - first, CATALOG_SOURCE_ANCHOR_BYTES) });
    const evidence = this.evidence;
    if (evidence && size !== evidence.size) throw new CatalogSourceError("catalog-source-range");
    const buffers = spans.map((span, index) => evidence
      ? (index === 0 ? evidence.first : evidence.tail.subarray(evidence.tail.length - span.length))
      : this.read(span.offset, span.length));
    const anchors = spans.map((span, index) => ({ ...span, sha256: digest(buffers[index]!) }));
    const receipt = evidence?.prior.schemaVersion === 2 ? evidence.prior.identityReceipt : undefined;
    // A healthy legacy source can keep appending under its original guard.
    // Only explicit full-span recovery promotes an existing v1 binding.
    const snapshot: CatalogSourceSnapshot = evidence?.prior.schemaVersion === 1
      ? { schemaVersion: 1, identity: { ...this.identity }, size, anchors }
      : { schemaVersion: 2, identity: { ...this.identity }, fileIdentity: { ...this.fileIdentity }, size, anchors,
        ...(receipt ? { identityReceipt: structuredClone(receipt) } : {}) };
    if (evidence) {
      // New anchors must match bytes accepted by the parser, not freshly adopted
      // filesystem bytes. Recheck old evidence AFTER candidate capture as well:
      // overlapping windows must not erase a mutation in the retiring old tail.
      for (const anchor of anchors) this.verifyRange(anchor);
      for (const anchor of evidence.prior.anchors) this.verifyRange(anchor);
    }
    this.assertCurrent();
    this.seedEvidence(snapshot, buffers);
    return snapshot;
  }
  verify(snapshot: CatalogSourceSnapshot): void {
    if (!snapshot || !validInteger(snapshot.size) || snapshot.size > this.size || snapshot.identity?.inode !== this.identity.inode
      || (snapshot.schemaVersion === 1 ? snapshot.identity.device !== this.identity.device
        : snapshot.schemaVersion !== 2 || !isCatalogFileIdentity(snapshot.fileIdentity)
          || !sameCatalogFileIdentity(snapshot.fileIdentity, this.fileIdentity))) throw new CatalogSourceError("catalog-source-changed");
    this.verifyAnchors(snapshot);
  }
  /** Only the explicit full-span recovery operation uses this legacy check.
   * It does not authorize normal ingestion or reads and does not publish state.
   */
  verifyLegacyForRecovery(snapshot: CatalogSourceSnapshot): void {
    if (snapshot?.schemaVersion !== 1 || !validInteger(snapshot.size) || snapshot.size > this.size
      || snapshot.identity?.inode !== this.identity.inode || this.fileIdentity.kind !== "linux-btrfs-statfs") throw new CatalogSourceError("catalog-source-changed");
    this.verifyAnchors(snapshot);
  }
  private verifyAnchors(snapshot: CatalogSourceSnapshot): void {
    const first = Math.min(snapshot.size, CATALOG_SOURCE_ANCHOR_BYTES);
    const expected = [{ offset: 0, length: first }];
    if (snapshot.size > first) expected.push({ offset: Math.max(first, snapshot.size - CATALOG_SOURCE_ANCHOR_BYTES), length: Math.min(snapshot.size - first, CATALOG_SOURCE_ANCHOR_BYTES) });
    if (!Array.isArray(snapshot.anchors) || snapshot.anchors.length !== expected.length) throw new CatalogSourceError("catalog-source-range");
    const buffers = snapshot.anchors.map((anchor, index) => {
      const span = expected[index]!;
      if (anchor.offset !== span.offset || anchor.length !== span.length || !/^[a-f0-9]{64}$/.test(anchor.sha256)) throw new CatalogSourceError("catalog-source-range");
      return this.verifyRange(anchor);
    });
    this.assertCurrent(snapshot.size);
    this.seedEvidence(snapshot, buffers);
  }
  private seedEvidence(snapshot: CatalogSourceSnapshot, buffers: readonly Buffer[]): void {
    this.evidence = {
      size: snapshot.size,
      first: Buffer.from(buffers[0]!),
      tail: Buffer.from(Buffer.concat(buffers).subarray(-CATALOG_SOURCE_ANCHOR_BYTES)),
      prior: structuredClone(snapshot),
    };
  }
  /** Hand off exactly the contiguous bytes consumed and hashed by ingestion.
   * Memory and final verification are bounded independently of prefix length.
   * As with every sampled check, writes after the final read cannot be excluded.
   */
  accept(offset: number, bytes: Uint8Array): void {
    const evidence = this.evidence;
    if (!evidence || offset !== evidence.size || bytes.length > CATALOG_SOURCE_CHUNK_BYTES || bytes.length > this.size - offset) throw new CatalogSourceError("catalog-source-range");
    const remaining = CATALOG_SOURCE_ANCHOR_BYTES - evidence.first.length;
    if (remaining > 0) evidence.first = Buffer.concat([evidence.first, bytes.subarray(0, remaining)]);
    evidence.tail = Buffer.from(Buffer.concat([evidence.tail, bytes]).subarray(-CATALOG_SOURCE_ANCHOR_BYTES));
    evidence.size += bytes.length;
  }
  /** Selected-byte recovery verifies the complete bounded hashed span, not just
   * its returned subrange. Callers store these hashes atomically with offsets. */
  verifyRange(anchor: CatalogSourceAnchor): Buffer {
    if (!/^[a-f0-9]{64}$/.test(anchor.sha256)) throw new CatalogSourceError("catalog-source-range");
    const bytes = this.read(anchor.offset, anchor.length);
    if (digest(bytes) !== anchor.sha256) throw new CatalogSourceError("catalog-source-changed");
    return bytes;
  }
}
