import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { at, canonical, fail, integer, object, plain, sha, text } from "./contracts.ts";
import { atomicJson, privateDirectory, readPrivateJson, sourceTicket } from "./files.ts";
import { MemoryStore } from "./store.ts";

export interface SessionTarget { sessionId: string; sourcePath: string }
export interface MemoryBinding {
  version: 1; provider: "memory"; namespaceId: string; storeId: string; storeRevision: number;
  sourceSessionId: string; sourceLeafId: string | null; hash: string;
}
interface SessionBinding { version: 1; sessionId: string; namespaceId: string; storeId: string; createdAt: string; hash: string }
export function defaultMemoryRoot(): string {
  return resolve(process.env.PI_CONTEXT_MEMORY_ROOT ?? join(homedir(), ".local", "state", "pi", "context-memory-v1"));
}
function pathFor(root: string, sessionId: string): string {
  text(sessionId); return join(root, "bindings", `${sha(sessionId)}.json`);
}
function parseSessionBinding(raw: unknown, sessionId: string): SessionBinding {
  const value = object(plain(raw, 8192), ["version", "sessionId", "namespaceId", "storeId", "createdAt", "hash"]);
  const { hash, ...body } = value;
  if (value.version !== 1 || value.sessionId !== sessionId || hash !== sha(canonical(body)) || !/^[a-f0-9]{32}$/.test(value.namespaceId)) fail("binding-invalid");
  text(value.storeId); at(value.createdAt);
  return value as SessionBinding;
}
export function lookupMemoryBinding(root: string, sessionId: string): SessionBinding | undefined {
  const raw = readPrivateJson(pathFor(root, sessionId));
  if (raw === undefined) return undefined;
  privateDirectory(root); privateDirectory(join(root, "bindings"));
  return parseSessionBinding(raw, sessionId);
}
/** Verify the actual file header, not a provisional session_start context. */
export function verifySessionTarget(target: SessionTarget): void {
  text(target.sessionId); sourceTicket(target.sourcePath);
  const fd = openSync(target.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd), bytes = Buffer.alloc(Math.min(8192, st.size));
    const size = readSync(fd, bytes, 0, bytes.length, 0), newline = bytes.subarray(0, size).indexOf(10);
    if (newline < 0) fail("session-header-limit");
    let header: any;
    try { header = JSON.parse(bytes.subarray(0, newline).toString("utf8")); } catch { fail("session-header-invalid"); }
    if (header.type !== "session" || header.id !== target.sessionId) fail("session-header-mismatch");
  } finally { closeSync(fd); }
}
function publish(root: string, target: SessionTarget, namespaceId: string, storeId: string): void {
  privateDirectory(root); privateDirectory(join(root, "bindings"), true);
  const prior = lookupMemoryBinding(root, target.sessionId);
  if (prior) {
    if (prior.namespaceId !== namespaceId || prior.storeId !== storeId) fail("binding-conflict");
    return;
  }
  const body = { version: 1 as const, sessionId: target.sessionId, namespaceId, storeId, createdAt: new Date().toISOString() };
  atomicJson(pathFor(root, target.sessionId), { ...body, hash: sha(canonical(body)) });
}
/** Only an explicit first use initializes an unrelated, persisted physical session. */
export function initializeMemoryBinding(root: string, target: SessionTarget): MemoryStore {
  verifySessionTarget(target);
  const existing = lookupMemoryBinding(root, target.sessionId);
  if (existing) return openBoundMemory(root, target.sessionId);
  // A lost binding cannot silently replace its deterministic pre-existing store.
  const namespaceId = sha(`context-memory-v1\n${target.sessionId}`).slice(0, 32);
  const store = new MemoryStore(root, namespaceId, true);
  try { publish(root, target, namespaceId, store.meta().storeId); return store; }
  catch (error) { store.close(); throw error; }
}
export function openBoundMemory(root: string, sessionId: string): MemoryStore {
  const binding = lookupMemoryBinding(root, sessionId);
  if (!binding) return fail("binding-missing");
  const store = new MemoryStore(root, binding.namespaceId);
  if (store.meta().storeId !== binding.storeId) { store.close(); fail("binding-store-mismatch"); }
  return store;
}
export function validateMemoryBinding(raw: unknown): MemoryBinding {
  const value = object(plain(raw, 8192), ["version", "provider", "namespaceId", "storeId", "storeRevision", "sourceSessionId", "sourceLeafId", "hash"]);
  const { hash, ...body } = value;
  if (value.version !== 1 || value.provider !== "memory" || !/^[a-f0-9]{32}$/.test(value.namespaceId) || hash !== sha(canonical(body))) fail("binding-invalid");
  text(value.storeId); integer(value.storeRevision, 0); text(value.sourceSessionId);
  if (value.sourceLeafId !== null) text(value.sourceLeafId);
  return value as MemoryBinding;
}
export function captureMemoryBinding(root: string, source: { sessionId: string; leafId: string | null }): MemoryBinding {
  const store = openBoundMemory(root, source.sessionId);
  try {
    const meta = store.meta();
    if (meta.pending) fail("pending");
    const body = { version: 1 as const, provider: "memory" as const, namespaceId: meta.namespaceId, storeId: meta.storeId,
      storeRevision: meta.revision, sourceSessionId: source.sessionId, sourceLeafId: source.leafId };
    return validateMemoryBinding({ ...body, hash: sha(canonical(body)) });
  } finally { store.close(); }
}
/** This is a same-store binding, not a snapshot or a rollback. Refuse a missing or advanced store. */
export function restoreMemoryBinding(root: string, raw: MemoryBinding, target: SessionTarget): MemoryBinding {
  const binding = validateMemoryBinding(raw); verifySessionTarget(target);
  const source = lookupMemoryBinding(root, binding.sourceSessionId);
  if (!source || source.namespaceId !== binding.namespaceId || source.storeId !== binding.storeId) fail("binding-source-mismatch");
  const store = new MemoryStore(root, binding.namespaceId);
  try {
    const meta = store.meta();
    if (meta.pending) fail("pending");
    if (meta.storeId !== binding.storeId || meta.revision !== binding.storeRevision) fail("binding-revision-mismatch");
    publish(root, target, binding.namespaceId, binding.storeId);
    return binding;
  } finally { store.close(); }
}
