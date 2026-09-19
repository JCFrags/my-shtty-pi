import { randomUUID } from "node:crypto";
import { PROVIDER_IDS, V1_PROVIDER_IDS, sameScope, validateScope, type ContextEventBus, type ContextScope, type ProviderId } from "./index.js";

export const STATE_TRANSFER_REQUEST = "context-kit:state-transfer-request:v2";
export const STATE_TRANSFER_RESPONSE = "context-kit:state-transfer-response:v2";
export const NATIVE_CHECKPOINT_ENTRY = "grounded-state-checkpoint-v1";
export const OWNER_BINDING_ENTRY = "context-kit:owner-binding:v1";
export const STATE_TRANSFER_LIMITS = Object.freeze({ providerBytes: 8 * 1024 * 1024, aggregateBytes: 16 * 1024 * 1024, waitMs: 5000, maxWaitMs: 30000 });
export type StateTransferCode = "state-checkpoint-corrupt" | "state-checkpoint-pending" | "state-checkpoint-scope" | "state-checkpoint-budget";
export class StateTransferError extends Error {
  constructor(readonly code: StateTransferCode) { super(code); }
}
function refuse(code: StateTransferCode): never { throw new StateTransferError(code); }
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 128 && Buffer.byteLength(value, "utf8") <= 128 && !/\p{Cc}/u.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Bound traversal before cloning or native validation. Complete state only. */
export function boundedTransferJson(value: unknown, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STATE_TRANSFER_LIMITS.aggregateBytes) refuse("state-checkpoint-budget");
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const count = (amount: number) => { bytes += amount; if (bytes > maxBytes) refuse("state-checkpoint-budget"); };
  const text = (value: string) => {
    if (value.length > maxBytes - bytes) refuse("state-checkpoint-budget");
    count(Buffer.byteLength(JSON.stringify(value), "utf8"));
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 200_000 || depth > 32) refuse("state-checkpoint-budget");
    if (item === null) { count(4); return; }
    if (typeof item === "string") { text(item); return; }
    if (typeof item === "boolean") { count(item ? 4 : 5); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) refuse("state-checkpoint-corrupt");
      count(JSON.stringify(item).length); return;
    }
    if (typeof item !== "object" || ancestors.has(item)) refuse("state-checkpoint-corrupt");
    if (Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype)) refuse("state-checkpoint-corrupt");
    ancestors.add(item); count(2);
    if (Array.isArray(item)) {
      if (item.length > 200_000 - nodes) refuse("state-checkpoint-budget");
      if (Reflect.ownKeys(item).length !== item.length + 1) refuse("state-checkpoint-corrupt");
      for (let index = 0; index < item.length; index++) {
        if (index) count(1);
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property || !("value" in property)) refuse("state-checkpoint-corrupt");
        visit(property.value, depth + 1);
      }
    } else {
      const keys = Object.keys(item);
      if (keys.length > 200_000 - nodes) refuse("state-checkpoint-budget");
      if (Reflect.ownKeys(item).length !== keys.length) refuse("state-checkpoint-corrupt");
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
export interface StateTransferRequest {
  version: 2; requestId: string; scope: ContextScope; providers: ProviderId[]; maxBytes: number; deadlineMs: number;
}
export type StateTransferEntry =
  | { customType: typeof NATIVE_CHECKPOINT_ENTRY; data: { version: 1; provider: typeof V1_PROVIDER_IDS[number]; sourceSessionId: string; sourceLeafId: string | null; state: unknown } }
  | { customType: typeof OWNER_BINDING_ENTRY; data: { version: 1; provider: ProviderId; sourceSessionId: string; sourceLeafId: string | null; binding: unknown } };
export type StateTransferResponse = { version: 2; requestId: string; provider: ProviderId; scope: ContextScope }
  & ({ ok: true; entries: StateTransferEntry[] } | { ok: false; code: StateTransferCode });
function requestData(value: unknown): StateTransferRequest {
  const data: unknown = JSON.parse(boundedTransferJson(value, 4096));
  if (!exact(data, ["version", "requestId", "scope", "providers", "maxBytes", "deadlineMs"]) || data.version !== 2 || !identifier(data.requestId)) refuse("state-checkpoint-corrupt");
  const scope = validateScope(data.scope);
  if (!Array.isArray(data.providers) || data.providers.length < 1 || data.providers.length > PROVIDER_IDS.length
    || new Set(data.providers).size !== data.providers.length || data.providers.some((id: unknown) => !(PROVIDER_IDS as readonly unknown[]).includes(id))) refuse("state-checkpoint-corrupt");
  if (!Number.isSafeInteger(data.maxBytes) || data.maxBytes < 1 || data.maxBytes > STATE_TRANSFER_LIMITS.providerBytes
    || !Number.isSafeInteger(data.deadlineMs)) refuse("state-checkpoint-budget");
  return { ...data, scope } as StateTransferRequest;
}
/** Validate only transport, provider completeness, and source scope. Providers
 * validate native contents and binding integrity before export and restoration. */
export function validateTransferEntries(values: unknown, scope?: ContextScope, provider?: ProviderId, maxBytes: number = STATE_TRANSFER_LIMITS.aggregateBytes): StateTransferEntry[] {
  const data: unknown = JSON.parse(boundedTransferJson(values, maxBytes));
  if (!Array.isArray(data) || data.length > 7) refuse("state-checkpoint-corrupt");
  const seen = new Set<string>();
  const sizes = new Map<string, number>();
  for (const entry of data) {
    if (!exact(entry, ["customType", "data"])) refuse("state-checkpoint-corrupt");
    const body = entry.data;
    const native = entry.customType === NATIVE_CHECKPOINT_ENTRY;
    if (!native && entry.customType !== OWNER_BINDING_ENTRY) refuse("state-checkpoint-corrupt");
    if (!exact(body, ["version", "provider", "sourceSessionId", "sourceLeafId", native ? "state" : "binding"])
      || body.version !== 1 || !(PROVIDER_IDS as readonly unknown[]).includes(body.provider)
      || (provider !== undefined && body.provider !== provider) || (native && body.provider === "memory")
      || !identifier(body.sourceSessionId) || !(body.sourceLeafId === null || identifier(body.sourceLeafId))) refuse("state-checkpoint-corrupt");
    if (scope && !sameScope(scope, { sessionId: body.sourceSessionId, leafId: body.sourceLeafId })) refuse("state-checkpoint-scope");
    const key = `${body.provider}:${entry.customType}`;
    if (seen.has(key)) refuse("state-checkpoint-corrupt");
    seen.add(key);
    const bytes = (sizes.get(body.provider) ?? 0) + Buffer.byteLength(JSON.stringify(entry));
    if (bytes > STATE_TRANSFER_LIMITS.providerBytes) refuse("state-checkpoint-budget");
    sizes.set(body.provider, bytes);
  }
  for (const id of provider ? [provider] : sizes.keys()) {
    if (!seen.has(`${id}:${id === "memory" ? OWNER_BINDING_ENTRY : NATIVE_CHECKPOINT_ENTRY}`)) refuse("state-checkpoint-corrupt");
  }
  return data as StateTransferEntry[];
}
export function registerStateTransferProvider(
  events: ContextEventBus, provider: ProviderId,
  capture: (request: StateTransferRequest, signal: AbortSignal) => StateTransferEntry[] | Promise<StateTransferEntry[]>,
  getScope: () => ContextScope | undefined,
): () => void {
  if (!(PROVIDER_IDS as readonly unknown[]).includes(provider)) refuse("state-checkpoint-corrupt");
  let active = true;
  const jobs = new Set<AbortController>();
  const remove = events.on(STATE_TRANSFER_REQUEST, (raw) => {
    let request: StateTransferRequest;
    try { request = requestData(raw); } catch { return; }
    const remaining = request.deadlineMs - Date.now();
    if (!active || !request.providers.includes(provider) || remaining < 0 || remaining > STATE_TRANSFER_LIMITS.maxWaitMs) return;
    Object.freeze(request.scope); Object.freeze(request.providers); Object.freeze(request);
    const envelope = { version: 2 as const, requestId: request.requestId, provider, scope: request.scope };
    const emit = (reply: StateTransferResponse) => {
      if (active && Date.now() <= request.deadlineMs) {
        try { events.emit(STATE_TRANSFER_RESPONSE, reply); } catch { /* Optional peer transport cannot fail native use. */ }
      }
    };
    if (jobs.size >= 1) { emit({ ...envelope, ok: false, code: "state-checkpoint-pending" }); return; }
    const controller = new AbortController(); jobs.add(controller);
    const timer = setTimeout(() => controller.abort(), remaining);
    const verify = () => {
      const current = getScope();
      if (!active || controller.signal.aborted) refuse("state-checkpoint-pending");
      if (!current || !sameScope(validateScope(current), request.scope)) refuse("state-checkpoint-scope");
    };
    void Promise.resolve().then(async () => {
      verify();
      const entries = validateTransferEntries(await capture(request, controller.signal), request.scope, provider, request.maxBytes);
      verify();
      const reply: StateTransferResponse = { ...envelope, ok: true, entries };
      boundedTransferJson(reply, request.maxBytes);
      emit(reply);
    }).catch((error) => emit({ ...envelope, ok: false, code: error instanceof StateTransferError ? error.code : "state-checkpoint-corrupt" }))
      .finally(() => { clearTimeout(timer); jobs.delete(controller); });
  });
  return () => { active = false; for (const job of jobs) job.abort(); remove(); };
}

/** Collect every requested owner before replacement. Timeout/cancellation never
 * authorizes partial state. A deadline stops waiting, not an uncooperative peer. */
export async function captureStateTransfer(
  events: ContextEventBus, getScope: () => ContextScope,
  options: { providers: ProviderId[]; waitMs?: number; signal?: AbortSignal },
): Promise<StateTransferEntry[]> {
  const providers = [...options.providers];
  if (providers.length > PROVIDER_IDS.length || new Set(providers).size !== providers.length
    || providers.some((id) => !(PROVIDER_IDS as readonly string[]).includes(id))) refuse("state-checkpoint-corrupt");
  if (!providers.length) return [];
  const scope = validateScope(getScope()), requestId = randomUUID();
  const waitMs = options.waitMs ?? STATE_TRANSFER_LIMITS.waitMs;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > STATE_TRANSFER_LIMITS.maxWaitMs) refuse("state-checkpoint-budget");
  const request: StateTransferRequest = { version: 2, requestId, scope, providers, maxBytes: STATE_TRANSFER_LIMITS.providerBytes, deadlineMs: Date.now() + waitMs };
  const replies = new Map<ProviderId, StateTransferEntry[]>();
  await new Promise<void>((resolve, reject) => {
    let settled = false, remove = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: StateTransferError) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer);
      try { remove(); } catch { /* Settlement still completes. */ }
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new StateTransferError("state-checkpoint-pending"));
    try {
      remove = events.on(STATE_TRANSFER_RESPONSE, (raw) => {
        if (settled || !raw || typeof raw !== "object") return;
        const correlation = Object.getOwnPropertyDescriptor(raw, "requestId");
        if (!correlation || !("value" in correlation) || correlation.value !== requestId) return;
        try {
          if (Date.now() > request.deadlineMs) refuse("state-checkpoint-pending");
          const reply = JSON.parse(boundedTransferJson(raw, request.maxBytes));
          if (!exact(reply, ["version", "requestId", "provider", "scope", "ok", reply.ok ? "entries" : "code"])
            || reply.version !== 2 || !sameScope(validateScope(reply.scope), scope)) refuse("state-checkpoint-corrupt");
          // Other installed owners can answer the same transport. Do not import them.
          if (!providers.includes(reply.provider)) return;
          if (replies.has(reply.provider)) refuse("state-checkpoint-corrupt");
          if (reply.ok !== true) {
            const codes: StateTransferCode[] = ["state-checkpoint-corrupt", "state-checkpoint-pending", "state-checkpoint-scope", "state-checkpoint-budget"];
            refuse(codes.includes(reply.code) ? reply.code : "state-checkpoint-corrupt");
          }
          replies.set(reply.provider, validateTransferEntries(reply.entries, scope, reply.provider, request.maxBytes));
          if (replies.size === providers.length) finish();
        } catch (error) { finish(error instanceof StateTransferError ? error : new StateTransferError("state-checkpoint-corrupt")); }
      });
      timer = setTimeout(abort, waitMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      events.emit(STATE_TRANSFER_REQUEST, request);
    } catch { finish(new StateTransferError("state-checkpoint-corrupt")); }
  });
  if (options.signal?.aborted || !sameScope(validateScope(getScope()), scope)) refuse("state-checkpoint-scope");
  return validateTransferEntries(providers.flatMap((provider) => replies.get(provider)!), scope);
}
