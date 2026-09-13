import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isExactObject } from "./state.ts";

export const STATE_CHECKPOINT_REQUEST_EVENT = "grounded-state:checkpoint-request-v1" as const;
export const STATE_CHECKPOINT_RESPONSE_EVENT = "grounded-state:checkpoint-response-v1" as const;
export const STATE_CHECKPOINT_ENTRY = "grounded-state-checkpoint-v1" as const;
export const STATE_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const MAX_DEPTH = 32;

export type StateCheckpointProvider = "notes" | "todo" | "workplan";
export type StateCheckpointCode = "state-checkpoint-corrupt" | "state-checkpoint-pending"
  | "state-checkpoint-scope" | "state-checkpoint-budget";
export interface StateCheckpointRequest {
  version: 1;
  requestId: string;
  sourceSessionId: string;
  sourceLeafId: string | null;
  maxBytes: number;
}
export interface StateCheckpoint<S = unknown> {
  version: 1;
  provider: StateCheckpointProvider;
  sourceSessionId: string;
  sourceLeafId: string | null;
  state: S;
}
export interface StateCheckpointEntry<S = unknown> {
  customType: typeof STATE_CHECKPOINT_ENTRY;
  data: StateCheckpoint<S>;
}
export type StateCheckpointResponse = {
  version: 1; requestId: string; provider: StateCheckpointProvider;
} & ({ ok: true; entry: StateCheckpointEntry } | { ok: false; code: StateCheckpointCode });

class CheckpointError extends Error {
  constructor(readonly code: StateCheckpointCode) { super(code); }
}
function refuse(code: StateCheckpointCode): never { throw new CheckpointError(code); }
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 128 && Buffer.byteLength(value, "utf8") <= 128 && !/\p{Cc}/u.test(value);
const providerName = (value: unknown): value is StateCheckpointProvider => value === "notes" || value === "todo" || value === "workplan";

/** Bound traversal before validation, serialization, or cloning. Never shorten state to fit. */
function boundedJson(value: unknown, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STATE_CHECKPOINT_MAX_BYTES) refuse("state-checkpoint-budget");
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const count = (amount: number) => { bytes += amount; if (bytes > maxBytes) refuse("state-checkpoint-budget"); };
  const text = (value: string) => {
    if (value.length > maxBytes - bytes) refuse("state-checkpoint-budget");
    count(Buffer.byteLength(JSON.stringify(value), "utf8"));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) refuse("state-checkpoint-budget");
    if (item === null) { count(4); return; }
    if (typeof item === "string") { text(item); return; }
    if (typeof item === "boolean") { count(item ? 4 : 5); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) refuse("state-checkpoint-corrupt");
      count(JSON.stringify(item).length); return;
    }
    if (typeof item !== "object" || ancestors.has(item)) refuse("state-checkpoint-corrupt");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) refuse("state-checkpoint-corrupt");
    ancestors.add(item);
    count(2);
    if (Array.isArray(item)) {
      if (item.length > MAX_NODES - nodes) refuse("state-checkpoint-budget");
      for (let index = 0; index < item.length; index++) {
        if (index) count(1);
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property || !("value" in property)) refuse("state-checkpoint-corrupt");
        visit(property.value, depth + 1);
      }
    } else {
      const keys = Object.keys(item);
      if (keys.length > MAX_NODES - nodes) refuse("state-checkpoint-budget");
      for (let index = 0; index < keys.length; index++) {
        if (index) count(1);
        const key = keys[index]!;
        text(key); count(1);
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in property)) refuse("state-checkpoint-corrupt");
        visit(property.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return JSON.stringify(value);
}

/** Native custom entries only. The caller rejects a second checkpoint or one after provider events. */
export function restoreStateCheckpoint<S>(
  entry: { type?: string; customType?: string; data?: unknown },
  provider: StateCheckpointProvider,
  validate: (state: S) => void,
): S | undefined {
  if (entry.type !== "custom" || entry.customType !== STATE_CHECKPOINT_ENTRY) return undefined;
  const value = entry.data;
  if (!isExactObject(value, ["version", "provider", "sourceSessionId", "sourceLeafId", "state"])
    || value.version !== 1 || !providerName(value.provider)
    || !identifier(value.sourceSessionId) || !(value.sourceLeafId === null || identifier(value.sourceLeafId))) refuse("state-checkpoint-corrupt");
  if (value.provider !== provider) return undefined;
  const detached = JSON.parse(boundedJson({ customType: STATE_CHECKPOINT_ENTRY, data: value }, STATE_CHECKPOINT_MAX_BYTES)) as StateCheckpointEntry<S>;
  validate(detached.data.state);
  return detached.data.state;
}

/** A synchronous, in-memory export. Callers must collect every provider before replacing the session. */
export function registerStateCheckpointProvider<S>(
  events: Pick<ExtensionAPI["events"], "on" | "emit">,
  provider: StateCheckpointProvider,
  capture: () => { state: S; sessionId?: string; leafId?: string | null; pending: boolean; corrupt: boolean },
  validate: (state: S) => void,
): () => void {
  return events.on(STATE_CHECKPOINT_REQUEST_EVENT, (value: unknown) => {
    if (!isExactObject(value, ["version", "requestId", "sourceSessionId", "sourceLeafId", "maxBytes"])
      || value.version !== 1 || !identifier(value.requestId)) return;
    let response: StateCheckpointResponse;
    try {
      if (!identifier(value.sourceSessionId) || !(value.sourceLeafId === null || identifier(value.sourceLeafId))) refuse("state-checkpoint-scope");
      const current = capture();
      if (current.sessionId !== value.sourceSessionId || current.leafId !== value.sourceLeafId) refuse("state-checkpoint-scope");
      if (current.corrupt) refuse("state-checkpoint-corrupt");
      if (current.pending) refuse("state-checkpoint-pending");
      const entry = JSON.parse(boundedJson({ customType: STATE_CHECKPOINT_ENTRY, data: {
        version: 1, provider, sourceSessionId: value.sourceSessionId, sourceLeafId: value.sourceLeafId, state: current.state,
      } }, value.maxBytes as number)) as StateCheckpointEntry<S>;
      validate(entry.data.state);
      response = { version: 1, requestId: value.requestId, provider, ok: true, entry };
    } catch (error) {
      response = { version: 1, requestId: value.requestId, provider, ok: false,
        code: error instanceof CheckpointError ? error.code : "state-checkpoint-corrupt" };
    }
    events.emit(STATE_CHECKPOINT_RESPONSE_EVENT, response);
  });
}
