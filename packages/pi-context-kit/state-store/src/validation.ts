import { createHash } from "node:crypto";
import type { ObjectRef, StateDurability, StateProviderId, StateScope } from "./types.ts";

export const STATE_ANCHOR_TYPE = "context-kit:state-anchor:v1" as const;
export const STATE_STORE_LIMITS = Object.freeze({
  objectBytes: 128 * 1024 * 1024,
  rootBytes: 8 * 1024 * 1024,
  recordBytes: 64 * 1024,
  anchorBytes: 16 * 1024,
  headerBytes: 16 * 1024,
  ancestryEntries: 128,
  maxAncestryEntries: 512,
  ancestryBytes: 8 * 1024 * 1024,
  bindingCacheEntries: 128,
  maxBindingCacheEntries: 512,
  jsonNodes: 1_000_000,
  jsonDepth: 64,
  transferProviderBytes: 8 * 1024 * 1024,
  transferAggregateBytes: 16 * 1024 * 1024,
});
export type StateStoreErrorCode =
  | "state-store-invalid" | "state-store-budget" | "state-store-unsafe-path"
  | "state-store-corrupt" | "state-store-missing" | "state-store-scope-changed"
  | "state-store-conflict" | "state-store-busy" | "state-store-cancelled"
  | "state-store-unresolved" | "state-store-legacy-required" | "state-store-unpersisted"
  | "state-store-uncertain" | "state-store-closed";
export class StateStoreError extends Error {
  readonly code: StateStoreErrorCode;
  readonly durability?: StateDurability;
  constructor(code: StateStoreErrorCode, durability?: StateDurability) {
    super(code);
    this.name = "StateStoreError";
    this.code = code;
    this.durability = durability;
  }
}
export function fail(code: StateStoreErrorCode, durability?: StateDurability): never {
  throw new StateStoreError(code, durability);
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) fail("state-store-cancelled");
}
export function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === code;
}
export const hashText = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isStoreId = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function providerId(value: unknown): asserts value is StateProviderId {
  if (value !== "todo" && value !== "notes" && value !== "workplan") fail("state-store-invalid");
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 128 || Buffer.byteLength(value) > 128
    || /\p{Cc}/u.test(value)) fail("state-store-invalid");
}
export function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail("state-store-invalid");
}
export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("state-store-corrupt");
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.has(key))
    || required.some(key => !Object.hasOwn(value, key))) fail("state-store-corrupt");
}
export function scope(value: unknown): asserts value is StateScope {
  exact(value, ["sessionId", "leafId"]);
  identifier(value.sessionId);
  if (value.leafId !== null) identifier(value.leafId);
}
export const sameScope = (left: StateScope, right: StateScope): boolean => left.sessionId === right.sessionId && left.leafId === right.leafId;
export function objectRef(value: unknown): asserts value is ObjectRef {
  exact(value, ["version", "providerId", "storeId", "hash", "bytes"]);
  if (value.version !== 1 || !isHash(value.hash) || !isStoreId(value.storeId)) fail("state-store-corrupt");
  providerId(value.providerId);
  integer(value.bytes, 1, STATE_STORE_LIMITS.objectBytes);
}

/** Canonical, bounded plain JSON. Charge before copying large strings or traversing children. */
export function canonicalJson(value: unknown, maximumBytes: number, omitUndefinedProperties = false): string {
  integer(maximumBytes, 1, STATE_STORE_LIMITS.objectBytes);
  // A JSON node needs at least two bytes on average (one scalar plus its separator).
  // Scale only large admitted objects. Small roots and progress keep the original cap.
  const nodeBudget = Math.max(STATE_STORE_LIMITS.jsonNodes, Math.ceil(maximumBytes / 2));
  let bytes = 0, nodes = 0;
  const pieces: string[] = [];
  const ancestors = new Set<object>();
  const add = (text: string): void => {
    bytes += Buffer.byteLength(text);
    if (bytes > maximumBytes) fail("state-store-budget");
    pieces.push(text);
  };
  const text = (value: string): void => {
    if (value.length > maximumBytes - bytes) fail("state-store-budget");
    add(JSON.stringify(value));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > nodeBudget || depth > STATE_STORE_LIMITS.jsonDepth) fail("state-store-budget");
    if (item === null) { add("null"); return; }
    if (typeof item === "string") { text(item); return; }
    if (typeof item === "boolean") { add(String(item)); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) fail("state-store-invalid");
      add(JSON.stringify(item)); return;
    }
    if (!item || typeof item !== "object" || ancestors.has(item)) fail("state-store-invalid");
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) fail("state-store-invalid");
    ancestors.add(item);
    if (array) {
      if (item.length > nodeBudget - nodes || Reflect.ownKeys(item).length !== item.length + 1) fail("state-store-budget");
      add("[");
      for (let index = 0; index < item.length; index++) {
        if (index) add(",");
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor)) fail("state-store-invalid");
        visit(descriptor.value, depth + 1);
      }
      add("]");
    } else {
      let keys = Reflect.ownKeys(item);
      if (keys.length > nodeBudget - nodes || keys.some(key => typeof key !== "string")) fail("state-store-budget");
      if (omitUndefinedProperties) keys = keys.filter(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) fail("state-store-invalid");
        return descriptor.value !== undefined;
      });
      (keys as string[]).sort((left, right) => left.localeCompare(right));
      add("{");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index] as string;
        if (index) add(",");
        text(key); add(":");
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) fail("state-store-invalid");
        visit(descriptor.value, depth + 1);
      }
      add("}");
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return pieces.join("");
}
export function detach<T>(value: T, maximumBytes = STATE_STORE_LIMITS.recordBytes): T {
  return JSON.parse(canonicalJson(value, maximumBytes)) as T;
}
export function freezeJson<T>(value: T): Readonly<T> {
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    for (const child of Object.values(item)) visit(child);
    Object.freeze(item);
  };
  visit(value);
  return value;
}
