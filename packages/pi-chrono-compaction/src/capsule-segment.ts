import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as F, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  CAPSULE_LIMITS,
  CAPSULE_SCHEMA_VERSION,
  CHUNK_CONTENT_HASH,
  CHUNK_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  SEGMENT_CONTENT_HASH,
  isDecodedChunkDescriptor,
  isDerivedManifest,
  isDerivedPublicationReceipt,
  isReducerEnvelope,
  type CapsuleSegmentDescriptor,
  type ChunkSegmentDescriptor,
  type DecodedChunkDescriptor,
  type DerivedManifest,
  type DerivedPublicationReceipt,
  type DerivedStoreIdentity,
  type ReducerEnvelope,
} from "./capsule-contract.js";

const CAPSULE_MAGIC = "CHRONO-M05-CAPSULE-SEGMENT-V1\n";
const CHUNK_MAGIC = "CHRONO-M05-CHUNK-SEGMENT-V1\n";
const HASH = /^[0-9a-f]{64}$/;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Canonical JSON: recursively sorted object keys, no whitespace, one optional terminal LF. */
export function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || item < 0) fail("capsule-canonical-invalid");
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object" || item instanceof Uint8Array || Buffer.isBuffer(item)) fail("capsule-canonical-invalid");
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(item as Record<string, unknown>).sort()) {
      const child = (item as Record<string, unknown>)[key];
      if (child === undefined) continue;
      output[key] = visit(child);
    }
    return output;
  };
  const encoded = JSON.stringify(visit(value));
  if (encoded === undefined) fail("capsule-canonical-invalid");
  return encoded;
}

function frame(bytes: Buffer): Buffer {
  if (bytes.length > 0xffffffff) fail("capsule-segment-limit");
  return Buffer.concat([Buffer.from(bytes.length.toString(16).padStart(8, "0") + "\n"), bytes, Buffer.from("\n")]);
}

export interface EncodedCapsuleSegment {
  readonly bytes: Buffer;
  readonly descriptor: CapsuleSegmentDescriptor;
}
export function encodeCapsuleSegment(envelope: ReducerEnvelope): EncodedCapsuleSegment {
  if (!isReducerEnvelope(envelope)) fail("capsule-envelope-invalid");
  const record = Buffer.from(canonicalJson(envelope), "utf8");
  const bytes = Buffer.concat([Buffer.from(CAPSULE_MAGIC), frame(record)]);
  if (bytes.length > CAPSULE_LIMITS.segmentBytes) fail("capsule-segment-limit");
  const at = { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor };
  return { bytes, descriptor: { kind: "capsules", schemaVersion: CAPSULE_SCHEMA_VERSION, hashAlgorithm: SEGMENT_CONTENT_HASH,
    hash: sha256(bytes), bytes: bytes.length, records: 1, first: at, last: at } };
}

export interface EncodedChunkSegment {
  readonly bytes: Buffer;
  readonly descriptor: ChunkSegmentDescriptor;
  readonly chunk: DecodedChunkDescriptor;
}
export function encodeChunkSegment(input: Omit<DecodedChunkDescriptor, "segmentHash" | "segmentOffset">, payload: Uint8Array): EncodedChunkSegment {
  const provisional: DecodedChunkDescriptor = { ...input, segmentHash: "0".repeat(64), segmentOffset: 0 };
  if (!isDecodedChunkDescriptor(provisional) || payload.byteLength !== input.utf16leBytes || sha256(payload) !== input.contentHash
    || input.contentHashAlgorithm !== CHUNK_CONTENT_HASH) fail("capsule-chunk-invalid");
  const encodedDescriptor = Buffer.from(canonicalJson(input), "utf8");
  const prefix = Buffer.concat([Buffer.from(CHUNK_MAGIC), frame(encodedDescriptor), Buffer.from(payload.byteLength.toString(16).padStart(8, "0") + "\n")]);
  const bytes = Buffer.concat([prefix, Buffer.from(payload), Buffer.from("\n")]);
  if (bytes.length > CAPSULE_LIMITS.segmentBytes) fail("capsule-segment-limit");
  const hash = sha256(bytes);
  const chunk: DecodedChunkDescriptor = { ...input, segmentHash: hash, segmentOffset: prefix.length };
  const at = { eventSeq: input.source.eventSeq, descriptor: input.source.descriptor, chunkIndex: input.chunkIndex };
  return { bytes, chunk, descriptor: { kind: "chunks", schemaVersion: CHUNK_SCHEMA_VERSION, hashAlgorithm: SEGMENT_CONTENT_HASH,
    hash, bytes: bytes.length, chunks: 1, first: at, last: at } };
}

function parseLength(bytes: Buffer, offset: number): { length: number; next: number } {
  const text = bytes.subarray(offset, offset + 9).toString("ascii");
  if (!/^[0-9a-f]{8}\n$/.test(text)) fail("capsule-segment-invalid");
  return { length: Number.parseInt(text.slice(0, 8), 16), next: offset + 9 };
}

export function decodeCapsuleSegment(bytes: Buffer): ReducerEnvelope {
  const magic = Buffer.from(CAPSULE_MAGIC);
  if (!bytes.subarray(0, magic.length).equals(magic)) fail("capsule-segment-invalid");
  const frame = parseLength(bytes, magic.length);
  if (frame.next + frame.length + 1 !== bytes.length || bytes.at(-1) !== 10) fail("capsule-segment-invalid");
  let value: unknown;
  try { value = JSON.parse(bytes.subarray(frame.next, frame.next + frame.length).toString("utf8")); } catch { fail("capsule-segment-invalid"); }
  if (!isReducerEnvelope(value) || canonicalJson(value) !== bytes.subarray(frame.next, frame.next + frame.length).toString("utf8")) fail("capsule-segment-invalid");
  return value as ReducerEnvelope;
}

export function decodeChunkPayload(bytes: Buffer, descriptor: DecodedChunkDescriptor): Buffer {
  const magic = Buffer.from(CHUNK_MAGIC);
  if (!bytes.subarray(0, magic.length).equals(magic)) fail("capsule-segment-invalid");
  const header = parseLength(bytes, magic.length);
  const payloadLength = parseLength(bytes, header.next + header.length + 1);
  if (bytes[header.next + header.length] !== 10 || payloadLength.next !== descriptor.segmentOffset
    || payloadLength.length !== descriptor.utf16leBytes || payloadLength.next + payloadLength.length + 1 !== bytes.length || bytes.at(-1) !== 10) fail("capsule-segment-invalid");
  const payload = bytes.subarray(payloadLength.next, payloadLength.next + payloadLength.length);
  if (sha256(payload) !== descriptor.contentHash) fail("capsule-content-corrupt");
  return payload;
}

export function encodeManifest(identity: DerivedStoreIdentity, layer: "capsules" | "chunks", segment: CapsuleSegmentDescriptor | ChunkSegmentDescriptor): { bytes: Buffer; manifest: DerivedManifest } {
  const base = { v: 1 as const, schemaVersion: MANIFEST_SCHEMA_VERSION, identity, layer, segment, hashAlgorithm: SEGMENT_CONTENT_HASH };
  const hash = sha256(Buffer.from(canonicalJson(base), "utf8"));
  const manifest: DerivedManifest = { ...base, hash };
  if (!isDerivedManifest(manifest)) fail("capsule-manifest-invalid");
  return { bytes: Buffer.from(canonicalJson(manifest) + "\n", "utf8"), manifest };
}

export function encodeReceipt(receipt: Omit<DerivedPublicationReceipt, "receiptHash">): { bytes: Buffer; receipt: DerivedPublicationReceipt } {
  const hash = sha256(Buffer.from(canonicalJson(receipt), "utf8"));
  const complete: DerivedPublicationReceipt = { ...receipt, receiptHash: hash };
  if (!isDerivedPublicationReceipt(complete)) fail("capsule-receipt-invalid");
  return { bytes: Buffer.from(canonicalJson(complete) + "\n", "utf8"), receipt: complete };
}

function privateRegular(path: string, expectedBytes?: number): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("capsule-content-missing"); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
    || (expectedBytes !== undefined && stat.size !== expectedBytes)) fail("capsule-storage-unsafe");
}
export function syncCapsuleDirectory(path: string): void {
  const fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readExactNamed(directory: string, name: string, expectedBytes: number): Buffer {
  if (!HASH.test(name) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1) fail("capsule-storage-range");
  return readExactSafe(join(directory, name), expectedBytes);
}

function readExactSafe(path: string, expectedBytes: number): Buffer {
  privateRegular(path, expectedBytes);
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const output = Buffer.alloc(expectedBytes); let done = 0;
    while (done < output.length) { const count = readSync(fd, output, done, output.length - done, done); if (!count) fail("capsule-content-corrupt"); done += count; }
    privateRegular(path, expectedBytes); return output;
  } finally { closeSync(fd); }
}

export type CapsuleSegmentFaultPoint = "before-file-write" | "before-file-fsync" | "before-file-rename" | "after-file-rename" | "before-directory-fsync" | "after-directory-fsync";
export interface CapsuleSegmentHooks { readonly fault?: (point: CapsuleSegmentFaultPoint, kind: string) => void }

/** Caller holds the store mutex. Existing immutable bytes are reused only after complete verification. */
export function publishImmutable(directory: string, expectedHash: string, bytes: Uint8Array, kind: string, hooks: CapsuleSegmentHooks = {}, completeBytesHash = true): string {
  if (!HASH.test(expectedHash) || (completeBytesHash && sha256(bytes) !== expectedHash)) fail("capsule-content-hash");
  const finalPath = join(directory, expectedHash);
  try {
    privateRegular(finalPath, bytes.byteLength);
    const existing = completeBytesHash ? readVerifiedImmutable(finalPath, expectedHash, bytes.byteLength) : readExactSafe(finalPath, bytes.byteLength);
    if (!existing.equals(Buffer.from(bytes))) fail("capsule-content-corrupt");
    hooks.fault?.("before-directory-fsync", kind); syncCapsuleDirectory(directory); hooks.fault?.("after-directory-fsync", kind);
    return finalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "capsule-content-missing") throw error;
  }
  const temporary = join(directory, `.pending-${randomUUID()}`);
  let fd: number | undefined;
  try {
    hooks.fault?.("before-file-write", kind);
    fd = openSync(temporary, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (!written) fail("capsule-storage-io");
      offset += written;
    }
    hooks.fault?.("before-file-fsync", kind); fsyncSync(fd);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600 || opened.size !== bytes.byteLength) fail("capsule-storage-unsafe");
    try { lstatSync(finalPath); fail("capsule-publication-conflict"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    hooks.fault?.("before-file-rename", kind); renameSync(temporary, finalPath); hooks.fault?.("after-file-rename", kind);
    privateRegular(finalPath, bytes.byteLength);
    hooks.fault?.("before-directory-fsync", kind); syncCapsuleDirectory(directory); hooks.fault?.("after-directory-fsync", kind);
    return finalPath;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function readVerifiedImmutable(path: string, expectedHash: string, expectedBytes: number, offset = 0, length = expectedBytes): Buffer {
  if (!HASH.test(expectedHash) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 0 || offset > expectedBytes || length > expectedBytes - offset) fail("capsule-storage-range");
  privateRegular(path, expectedBytes);
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600 || opened.size !== expectedBytes) fail("capsule-storage-unsafe");
    // Integrity is over the complete immutable segment; selected output remains bounded.
    const complete = Buffer.alloc(expectedBytes);
    let done = 0;
    while (done < complete.length) {
      const count = readSync(fd, complete, done, complete.length - done, done);
      if (!count) fail("capsule-content-corrupt");
      done += count;
    }
    if (sha256(complete) !== expectedHash) fail("capsule-content-corrupt");
    return complete.subarray(offset, offset + length);
  } finally { closeSync(fd); }
}
