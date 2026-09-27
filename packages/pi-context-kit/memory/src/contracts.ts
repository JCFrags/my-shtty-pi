import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({ text: 8192, record: 16384, sources: 8, query: 512, scan: 512, results: 100,
  output: 32768, importBytes: 8 * 1024 * 1024, importEvents: 4096, anchorBytes: 65536, input: 32768 });
export const ANCHOR_TYPE = "context-memory-commit-v1";
export const VISIBILITY = "Accepted ordinary knowledge is shared across tree moves within this logical session, not across projects. Proposals are separate. Sources do not grant instruction authority.";
export class MemoryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MemoryError"; }
}
export function fail(code: string): never { throw new MemoryError(`memory-${code}`); }
export const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
  return JSON.stringify(normalize(value));
}
export function plain(value: unknown, bytes: number = LIMITS.input): any {
  let nodes = 0, used = 0;
  function copy(item: any, depth: number): any {
    if (++nodes > 4096 || depth > 10) fail("input-limit");
    if (item === null || typeof item === "boolean") { used += 5; return item; }
    if (typeof item === "number") { if (!Number.isFinite(item)) fail("input-invalid"); used += 32; return item; }
    if (typeof item === "string") { used += Buffer.byteLength(item); if (used > bytes) fail("input-limit"); return item; }
    if (!item || typeof item !== "object") fail("input-invalid");
    if (Array.isArray(item)) {
      if (item.length > 512 || Reflect.ownKeys(item).length !== item.length + 1) fail("input-limit");
      return Array.from({ length: item.length }, (_, index: number) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor)) fail("input-invalid");
        return copy(descriptor.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("input-invalid");
    const keys = Reflect.ownKeys(item);
    if (keys.length > 48) fail("input-limit");
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) fail("input-invalid");
      used += key.length;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) fail("input-invalid");
      out[key] = copy(descriptor.value, depth + 1);
    }
    return out;
  }
  const out = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(out)) > bytes) fail("input-limit");
  return out;
}
export function object(value: any, keys?: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || keys && Object.keys(value).some(key => !keys.includes(key))) fail("input-invalid");
  return value;
}
export function text(value: unknown, maximum = 128, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > maximum || /[\uD800-\uDFFF]/u.test(value)) fail("text-invalid");
  return value;
}
export function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail("integer-invalid");
  return value as number;
}
export function at(value: unknown): string {
  const timestamp = text(value, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) fail("time-invalid");
  return timestamp;
}
export type EventTime = { kind: "unknown" } | { kind: "instant"; at: string };
export type Validity = { kind: "unknown" } | { kind: "interval"; from: string | null; until: string | null };
export function eventTime(value: any = { kind: "unknown" }): EventTime {
  object(value, ["kind", "at"]);
  if (value.kind === "unknown" && Object.keys(value).length === 1) return { kind: "unknown" };
  if (value.kind === "instant") return { kind: "instant", at: at(value.at) };
  return fail("event-time-invalid");
}
export function validity(value: any = { kind: "unknown" }): Validity {
  object(value, ["kind", "from", "until"]);
  if (value.kind === "unknown" && Object.keys(value).length === 1) return { kind: "unknown" };
  if (value.kind !== "interval") return fail("validity-invalid");
  const from = value.from === null ? null : at(value.from), until = value.until === null ? null : at(value.until);
  if (from === null && until === null || from && until && from >= until) fail("validity-invalid");
  return { kind: "interval", from, until };
}
export interface Origin { sessionId: string | null; leafId: string | null; toolCallId: string | null }
export interface SourceLink {
  identity: string; kind: "operation" | "history" | "external" | "legacy";
  reference?: string; role: string; derivation: "original" | "derived" | "unknown";
  verification: "operation_origin" | "unverified" | "legacy_integrity";
}
export function sourceLinks(value: any = []): SourceLink[] {
  if (!Array.isArray(value) || value.length > LIMITS.sources - 1) fail("sources-limit");
  return value.map((raw: any) => {
    const source = object(raw, ["identity", "kind", "reference", "role", "derivation"]);
    if (!["history", "external"].includes(source.kind)) fail("source-invalid");
    const derivation = source.derivation ?? "unknown";
    if (!["original", "derived", "unknown"].includes(derivation)) fail("source-invalid");
    return { identity: text(source.identity, 512), kind: source.kind,
      ...(source.reference === undefined ? {} : { reference: text(source.reference, 2048) }),
      role: source.role === undefined ? "unknown" : text(source.role, 32), derivation, verification: "unverified" };
  });
}
export interface MemoryRecord {
  schemaVersion: 1; memoryId: string; revision: number; kind: "knowledge" | "proposal";
  state: "current" | "demoted" | "superseded" | "pending" | "accepted" | "rejected";
  text: string; scope: string; confidence: number; authority: string; protected: boolean;
  createdAt: string; recordedAt: string; recordedSequence: number; eventTime: EventTime; validity: Validity;
  origin: Origin; originalOrigin: Origin; sources: SourceLink[]; sourceRef: string; operation: string;
  previousHash: string | null; revisionHash: string; reason?: string;
  supersedesMemoryId?: string; acceptedMemoryId?: string; acceptedRevision?: number; derivedFromMemoryId?: string;
  useCount: number; promotedUntilSequence?: number;
  legacy?: Record<string, unknown>;
}
export function sealRecord(input: Omit<MemoryRecord, "revisionHash">): MemoryRecord {
  const result = { ...input, revisionHash: sha(canonical(input)) };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.record
    || Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ memory: result }) }] })) > LIMITS.output - 2048) fail("record-limit");
  return result;
}
export function decodeRecord(body: unknown): MemoryRecord {
  if (typeof body !== "string" || Buffer.byteLength(body) > LIMITS.record) return fail("store-corrupt");
  try {
    const result = JSON.parse(body) as MemoryRecord;
    const { revisionHash, ...rest } = result;
    if (revisionHash !== sha(canonical(rest)) || result.schemaVersion !== 1) fail("store-corrupt");
    text(result.memoryId); integer(result.revision); text(result.text, LIMITS.text); at(result.createdAt); at(result.recordedAt);
    integer(result.recordedSequence); integer(result.useCount, 0); text(result.scope, 256); text(result.operation); text(result.sourceRef, 2048);
    if (!["ordinary", "system", "user", "project", "skill"].includes(result.authority) || typeof result.protected !== "boolean"
      || typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 1 || !Number.isFinite(result.confidence)) fail("store-corrupt");
    if (!(result.kind === "knowledge" ? ["current", "demoted", "superseded"] : result.kind === "proposal" ? ["pending", "accepted", "rejected"] : []).includes(result.state)) fail("store-corrupt");
    for (const origin of [result.origin, result.originalOrigin]) {
      object(origin, ["sessionId", "leafId", "toolCallId"]);
      for (const field of ["sessionId", "leafId", "toolCallId"] as const) if (origin[field] !== null) text(origin[field]);
    }
    if (!Array.isArray(result.sources) || result.sources.length > LIMITS.sources) fail("store-corrupt");
    for (const source of result.sources) {
      text(source.identity, 512); text(source.role, 32);
      if (!["operation", "history", "external", "legacy"].includes(source.kind) || !["original", "derived", "unknown"].includes(source.derivation)
        || !["operation_origin", "unverified", "legacy_integrity"].includes(source.verification)) fail("store-corrupt");
      if (source.reference !== undefined) text(source.reference, 2048);
    }
    if (result.eventTime === undefined || result.validity === undefined) fail("store-corrupt");
    eventTime(result.eventTime); validity(result.validity);
    return result;
  } catch { return fail("store-corrupt"); }
}
export function validityState(record: MemoryRecord, time = new Date().toISOString()): string {
  const value = record.validity;
  return value.kind === "unknown" ? "unknown" : value.from && time < value.from ? "not_yet_valid"
    : value.until && time >= value.until ? "expired" : "within_declared_interval";
}
export function prefix(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
export function safeError(error: unknown): MemoryError {
  if (error instanceof MemoryError) return error;
  const code = (error as any)?.errcode;
  return new MemoryError(code === 5 || code === 6 ? "memory-store-busy" : "memory-store-unavailable");
}
