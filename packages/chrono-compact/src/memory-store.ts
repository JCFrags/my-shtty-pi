import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hashText, stableStringify, unique } from "./utils.js";

export type MemoryAuthority = "ordinary" | "system" | "user" | "project" | "skill";
export type MemoryAction = "remember" | "update" | "promote" | "touch" | "demote" | "forget";
export type MemoryState = "current" | "superseded" | "demoted";

export interface MemoryEvent {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly memoryId: string;
  readonly action: MemoryAction;
  readonly timestamp: string;
  readonly turn: number;
  readonly previousEventHash: string;
  readonly eventHash: string;
  readonly sourceRef: string;
  readonly scope: string;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly text?: string;
  readonly reason?: string;
  readonly supersedesMemoryId?: string;
  readonly authoritativeSourceHash?: string;
  readonly authoritativeSourceIdentity?: string;
  readonly authoritativeVerifier?: "configured-file-v1";
}

export interface RememberedMemory {
  readonly memoryId: string;
  readonly text: string;
  readonly sourceRef: string;
  readonly scope: string;
  readonly authority: MemoryAuthority;
  readonly protected: boolean;
  readonly confidence: number;
  readonly state: MemoryState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdTurn: number;
  readonly lastUsedTurn: number;
  readonly useCount: number;
  readonly promotedUntilTurn?: number;
  readonly supersedesMemoryId?: string;
  readonly lastEventHash: string;
}

export interface MemoryMaterialization {
  readonly schemaVersion: 2;
  readonly status: "ready" | "corrupt-rebuild-required";
  readonly generationHash: string;
  readonly memories: readonly RememberedMemory[];
  readonly events: readonly MemoryEvent[];
  readonly error?: string;
}

export interface MemoryEventInput {
  readonly action: MemoryAction;
  readonly memoryId?: string;
  readonly timestamp: string;
  readonly turn: number;
  readonly sourceRef: string;
  readonly scope?: string;
  readonly authority?: MemoryAuthority;
  readonly confidence?: number;
  readonly text?: string;
  readonly reason?: string;
  readonly supersedesMemoryId?: string;
}

export type ProtectedMemoryAuthority = Exclude<MemoryAuthority, "ordinary">;

export interface AuthoritativeMemoryRequestInput {
  readonly action: "remember";
  readonly memoryId?: string;
  readonly timestamp: string;
  readonly turn: number;
  readonly sourceRef: string;
  readonly scope?: string;
  readonly confidence?: number;
  readonly reason?: string;
  readonly supersedesMemoryId?: string;
}

interface ConfiguredAuthoritativeFile {
  readonly sourceRef: string;
  readonly authority: "project" | "skill";
  readonly relativePath: string;
  readonly sha256: string;
}

interface ConfiguredAuthoritativeManifest {
  readonly schemaVersion: 1;
  readonly sources: readonly ConfiguredAuthoritativeFile[];
}

const VERIFIED_SOURCE = Symbol("verified-authoritative-memory-source");
interface VerifiedAuthoritativeMemorySource {
  readonly [VERIFIED_SOURCE]: true;
  readonly authority: "project" | "skill";
  readonly sourceRef: string;
  readonly sourceText: string;
  readonly sourceSha256: string;
}

const AUTHORITATIVE_MANIFEST_PATH = process.env.PI_CHRONO_AUTHORITATIVE_MEMORY_MANIFEST?.trim();
const PROTECTED = new Set<MemoryAuthority>(["system", "user", "project", "skill"]);

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function readStableRegularFile(path: string, allowedRoot?: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) !== 0) {
      throw new Error(`Authoritative source is not a one-link regular file without group or other write access: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Authoritative source changed while it was read: ${path}`);
    }
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error(`Authoritative source path was replaced while it was read: ${path}`);
    }
    if (allowedRoot) {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => realpath(path));
      if (!isWithinRoot(allowedRoot, openedPath)) throw new Error("Authoritative source escaped its configured root.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseAuthoritativeManifest(value: unknown): ConfiguredAuthoritativeManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Authoritative memory manifest must be an object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.sources)) throw new Error("Unsupported authoritative memory manifest schema.");
  const sources: ConfiguredAuthoritativeFile[] = record.sources.map((item, index): ConfiguredAuthoritativeFile => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid authoritative source at index ${index}.`);
    const source = item as Record<string, unknown>;
    if (source.authority !== "project" && source.authority !== "skill") throw new Error(`Unsupported authoritative source type at index ${index}.`);
    const authority = source.authority;
    if (typeof source.sourceRef !== "string" || !new RegExp(`^${authority}:[A-Za-z0-9._-]{1,120}$`).test(source.sourceRef)) {
      throw new Error(`Authoritative source identity does not match its authority at index ${index}.`);
    }
    if (typeof source.relativePath !== "string" || !source.relativePath || isAbsolute(source.relativePath)) throw new Error(`Invalid authoritative source path at index ${index}.`);
    const normalized = relative(".", source.relativePath);
    if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`Authoritative source path traversal at index ${index}.`);
    if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error(`Invalid authoritative source SHA-256 at index ${index}.`);
    return { sourceRef: source.sourceRef, authority, relativePath: source.relativePath, sha256: source.sha256 };
  });
  if (new Set(sources.map((source) => source.sourceRef)).size !== sources.length) throw new Error("Authoritative source identities must be unique.");
  return { schemaVersion: 1, sources };
}

async function resolveConfiguredAuthoritativeSource(sourceRef: string): Promise<VerifiedAuthoritativeMemorySource> {
  if (!AUTHORITATIVE_MANIFEST_PATH) throw new Error("Authoritative file ingestion is not configured; protected memory fails closed.");
  if (!isAbsolute(AUTHORITATIVE_MANIFEST_PATH)) throw new Error("Authoritative memory manifest path must be absolute.");
  const manifestPath = resolve(AUTHORITATIVE_MANIFEST_PATH);
  const root = await realpath(dirname(manifestPath));
  const manifestBytes = await readStableRegularFile(manifestPath, root);
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
  catch (error) { throw new Error(`Authoritative memory manifest is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const manifest = parseAuthoritativeManifest(manifestValue);
  const configured = manifest.sources.find((source) => source.sourceRef === sourceRef);
  if (!configured) throw new Error(`Authoritative source identity is not configured: ${sourceRef}`);
  const target = resolve(root, configured.relativePath);
  if (!isWithinRoot(root, target)) throw new Error("Authoritative source path traversal was rejected.");
  const bytes = await readStableRegularFile(target, root);
  const sourceSha256 = sha256Hex(bytes);
  if (sourceSha256 !== configured.sha256) throw new Error(`Authoritative source bytes changed for ${sourceRef}.`);
  let sourceText: string;
  try { sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`Authoritative source is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`); }
  if (!sourceText.trim() || sourceText !== sourceText.trim()) throw new Error("Authoritative memory source must be non-empty normalized text.");
  return Object.freeze({
    [VERIFIED_SOURCE]: true as const,
    authority: configured.authority,
    sourceRef: configured.sourceRef,
    sourceText,
    sourceSha256,
  });
}

function eventPayload(event: Omit<MemoryEvent, "eventHash">): string {
  return stableStringify(event);
}

function validateEvent(event: MemoryEvent, previousHash: string): void {
  if (event.schemaVersion !== 2) throw new Error("Unsupported memory event schema.");
  if (event.previousEventHash !== previousHash) throw new Error(`Memory hash chain broke at ${event.eventId}.`);
  const { eventHash: _eventHash, ...payload } = event;
  if (hashText(eventPayload(payload)) !== event.eventHash) throw new Error(`Memory event integrity failed at ${event.eventId}.`);
  if (!Number.isSafeInteger(event.turn) || event.turn < 0) throw new Error(`Memory event ${event.eventId} has an invalid turn.`);
  if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) throw new Error(`Memory event ${event.eventId} has invalid confidence.`);
  if (event.action === "remember" && PROTECTED.has(event.authority)) {
    const sourceHash = event.text === undefined ? "" : sha256Hex(event.text);
    const sourceIdentity = hashText(`${event.authority}\n${event.sourceRef}\n${sourceHash}\nconfigured-file-v1`);
    if (event.authoritativeVerifier !== "configured-file-v1"
      || event.authoritativeSourceHash !== sourceHash
      || event.authoritativeSourceIdentity !== sourceIdentity) {
      throw new Error(`Protected memory ${event.memoryId} lacks independently verified authoritative source bytes and identity.`);
    }
    if ((event.authority !== "project" && event.authority !== "skill") || !event.sourceRef.startsWith(`${event.authority}:`)) {
      throw new Error(`Protected memory ${event.memoryId} has an unsupported or mismatched authoritative source identity.`);
    }
  }
}

function checkedText(input: MemoryEventInput): string | undefined {
  const text = input.text?.trim();
  if ((input.action === "remember" || input.action === "update") && !text) throw new Error(`${input.action} requires non-empty text.`);
  return text;
}

function currentById(events: readonly MemoryEvent[]): Map<string, RememberedMemory> {
  const memories = new Map<string, RememberedMemory>();
  for (const event of events) {
    const existing = memories.get(event.memoryId);
    if (event.action === "remember") {
      if (existing) throw new Error(`Memory ${event.memoryId} was remembered more than once.`);
      memories.set(event.memoryId, {
        memoryId: event.memoryId,
        text: event.text!,
        sourceRef: event.sourceRef,
        scope: event.scope,
        authority: event.authority,
        protected: PROTECTED.has(event.authority),
        confidence: event.confidence,
        state: "current",
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        createdTurn: event.turn,
        lastUsedTurn: event.turn,
        useCount: 0,
        ...(event.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: event.supersedesMemoryId }),
        lastEventHash: event.eventHash,
      });
      if (event.supersedesMemoryId) {
        const superseded = memories.get(event.supersedesMemoryId);
        if (superseded?.protected && !PROTECTED.has(event.authority)) {
          throw new Error(`Protected ${superseded.authority} memory ${superseded.memoryId} cannot be superseded by ordinary memory.`);
        }
        if (superseded) memories.set(event.supersedesMemoryId, { ...superseded, state: "superseded", updatedAt: event.timestamp });
      }
      continue;
    }
    if (!existing) throw new Error(`Memory event ${event.eventId} refers to unknown memory ${event.memoryId}.`);
    if (existing.protected) {
      throw new Error(`Protected ${existing.authority} memory ${event.memoryId} cannot be changed by an ordinary memory event.`);
    }
    if (event.action === "update") {
      memories.set(event.memoryId, {
        ...existing,
        text: event.text!,
        sourceRef: event.sourceRef,
        scope: event.scope,
        confidence: event.confidence,
        state: "current",
        updatedAt: event.timestamp,
        lastEventHash: event.eventHash,
      });
    } else if (event.action === "touch") {
      memories.set(event.memoryId, {
        ...existing,
        updatedAt: event.timestamp,
        lastUsedTurn: event.turn,
        useCount: existing.useCount + 1,
        lastEventHash: event.eventHash,
      });
    } else if (event.action === "promote") {
      memories.set(event.memoryId, {
        ...existing,
        state: "current",
        updatedAt: event.timestamp,
        lastUsedTurn: event.turn,
        useCount: existing.useCount + 1,
        promotedUntilTurn: event.turn + 8,
        lastEventHash: event.eventHash,
      });
    } else {
      memories.set(event.memoryId, {
        ...existing,
        state: "demoted",
        updatedAt: event.timestamp,
        lastEventHash: event.eventHash,
      });
    }
  }
  return memories;
}

export function materializeMemoryEvents(events: readonly MemoryEvent[]): MemoryMaterialization {
  try {
    let previousHash = "0".repeat(64);
    for (const event of events) {
      validateEvent(event, previousHash);
      previousHash = event.eventHash;
    }
    const memories = [...currentById(events).values()].sort((a, b) => a.createdTurn - b.createdTurn || a.memoryId.localeCompare(b.memoryId));
    return {
      schemaVersion: 2,
      status: "ready",
      generationHash: hashText(stableStringify(events.map((event) => event.eventHash))),
      memories,
      events: [...events],
    };
  } catch (error) {
    return {
      schemaVersion: 2,
      status: "corrupt-rebuild-required",
      generationHash: hashText("corrupt-memory-store"),
      memories: [],
      events: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createMemoryEventInternal(
  events: readonly MemoryEvent[],
  input: MemoryEventInput,
  authoritativeSource?: VerifiedAuthoritativeMemorySource,
): MemoryEvent {
  const current = materializeMemoryEvents(events);
  if (current.status !== "ready") throw new Error(`Memory store is corrupt: ${current.error ?? "unknown error"}`);
  const text = checkedText(input);
  const prior = current.memories.find((memory) => memory.memoryId === input.memoryId);
  const authority = authoritativeSource?.authority ?? input.authority ?? prior?.authority ?? "ordinary";
  const scope = input.scope?.trim() || prior?.scope || "session";
  const confidence = input.confidence ?? prior?.confidence ?? 1;
  const memoryId = input.memoryId ?? hashText(`${input.sourceRef}\n${input.timestamp}\n${text ?? ""}`).slice(0, 20);
  const existing = current.memories.find((memory) => memory.memoryId === memoryId);
  if (input.action !== "remember" && !existing) throw new Error(`Unknown memory: ${memoryId}`);
  if (existing?.protected) {
    throw new Error(`Protected ${existing.authority} memory ${memoryId} cannot be updated, touched, promoted, demoted, or forgotten by ordinary memory operations.`);
  }
  const superseded = input.supersedesMemoryId
    ? current.memories.find((memory) => memory.memoryId === input.supersedesMemoryId)
    : undefined;
  if (superseded?.protected && !authoritativeSource) {
    throw new Error(`Protected ${superseded.authority} memory ${superseded.memoryId} cannot be superseded by ordinary memory operations.`);
  }

  let authoritativeSourceHash: string | undefined;
  let authoritativeSourceIdentity: string | undefined;
  let authoritativeVerifier: "configured-file-v1" | undefined;
  if (authoritativeSource) {
    if (authoritativeSource[VERIFIED_SOURCE] !== true) throw new Error("Authoritative memory verifier result is invalid.");
    if (input.action !== "remember") throw new Error("Authoritative ingestion creates a new protected memory event; it does not mutate an existing protected event.");
    if (input.authority !== undefined && input.authority !== authoritativeSource.authority) throw new Error("Authoritative memory authority does not match the independently loaded source.");
    if (input.sourceRef !== authoritativeSource.sourceRef || !input.sourceRef.startsWith(`${authoritativeSource.authority}:`)) {
      throw new Error("Authoritative memory source identity does not match the independently loaded source.");
    }
    if (text !== authoritativeSource.sourceText) throw new Error("Protected memory text must exactly match independently loaded authoritative bytes.");
    authoritativeSourceHash = authoritativeSource.sourceSha256;
    authoritativeVerifier = "configured-file-v1";
    authoritativeSourceIdentity = hashText(`${authoritativeSource.authority}\n${authoritativeSource.sourceRef}\n${authoritativeSourceHash}\n${authoritativeVerifier}`);
  } else if (PROTECTED.has(authority)) {
    throw new Error("Protected memory requires independently configured authoritative loading; caller claims are not proof.");
  }

  const previousEventHash = events[events.length - 1]?.eventHash ?? "0".repeat(64);
  const eventId = hashText(`${previousEventHash}\n${memoryId}\n${input.action}\n${input.timestamp}\n${input.turn}`).slice(0, 24);
  const withoutHash: Omit<MemoryEvent, "eventHash"> = {
    schemaVersion: 2,
    eventId,
    memoryId,
    action: input.action,
    timestamp: input.timestamp,
    turn: input.turn,
    previousEventHash,
    sourceRef: input.sourceRef,
    scope,
    authority,
    confidence,
    ...(text === undefined ? {} : { text }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: input.supersedesMemoryId }),
    ...(authoritativeSourceHash === undefined ? {} : { authoritativeSourceHash }),
    ...(authoritativeSourceIdentity === undefined ? {} : { authoritativeSourceIdentity }),
    ...(authoritativeVerifier === undefined ? {} : { authoritativeVerifier }),
  };
  return Object.freeze({ ...withoutHash, eventHash: hashText(eventPayload(withoutHash)) });
}

/** Create one untrusted ordinary memory event. Source labels never grant authority. */
export function createMemoryEvent(events: readonly MemoryEvent[], input: MemoryEventInput): MemoryEvent {
  return createMemoryEventInternal(events, input);
}

function authoritativeMemoryInput(
  input: AuthoritativeMemoryRequestInput,
  source: VerifiedAuthoritativeMemorySource,
): MemoryEventInput {
  return {
    action: "remember",
    ...(input.memoryId === undefined ? {} : { memoryId: input.memoryId }),
    timestamp: input.timestamp,
    turn: input.turn,
    sourceRef: source.sourceRef,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    authority: source.authority,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    text: source.sourceText,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: input.supersedesMemoryId }),
  };
}

/**
 * Load one explicitly configured project or skill file by stable identity.
 * The caller supplies only the identity. Source bytes, authority, and SHA-256
 * come from the owner-configured manifest and stable file descriptor.
 */
export async function createConfiguredAuthoritativeMemoryEvent(
  events: readonly MemoryEvent[],
  input: AuthoritativeMemoryRequestInput,
): Promise<MemoryEvent> {
  const source = await resolveConfiguredAuthoritativeSource(input.sourceRef);
  return createMemoryEventInternal(events, authoritativeMemoryInput(input, source), source);
}

export function decayMemories(materialization: MemoryMaterialization, currentTurn: number, ordinaryDecayTurns = 48): readonly RememberedMemory[] {
  if (materialization.status !== "ready") return [];
  return materialization.memories.map((memory) => {
    if (memory.protected || memory.state !== "current") return memory;
    if ((memory.promotedUntilTurn ?? -1) >= currentTurn) return memory;
    const refresh = Math.min(ordinaryDecayTurns * 4, memory.useCount * 8);
    return currentTurn - memory.lastUsedTurn > ordinaryDecayTurns + refresh ? { ...memory, state: "demoted" as const } : memory;
  });
}

function memoryTerms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? []));
}

export function searchMemories(
  materialization: MemoryMaterialization,
  query: string,
  options: { readonly scope?: string; readonly includeDemoted?: boolean; readonly limit?: number } = {},
): readonly RememberedMemory[] {
  if (materialization.status !== "ready") return [];
  const wanted = memoryTerms(query);
  return materialization.memories
    .filter((memory) => options.includeDemoted || memory.state === "current")
    .filter((memory) => !options.scope || memory.scope === options.scope)
    .map((memory) => {
      const present = memoryTerms(`${memory.text} ${memory.scope} ${memory.sourceRef}`);
      const intersection = [...wanted].filter((term) => present.has(term)).length;
      const phrase = memory.text.toLowerCase().includes(query.toLowerCase()) ? 10 : 0;
      const score = phrase + intersection * 2 + memory.useCount * 0.2 + (memory.protected ? 1 : 0);
      return { memory, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.lastUsedTurn - a.memory.lastUsedTurn || a.memory.memoryId.localeCompare(b.memory.memoryId))
    .slice(0, Math.min(100, Math.max(1, options.limit ?? 20)))
    .map((item) => item.memory);
}

export function listMemories(
  materialization: MemoryMaterialization,
  options: { readonly scope?: string; readonly state?: MemoryState; readonly authorities?: readonly MemoryAuthority[] } = {},
): readonly RememberedMemory[] {
  if (materialization.status !== "ready") return [];
  return materialization.memories.filter((memory) =>
    (!options.scope || memory.scope === options.scope)
    && (!options.state || memory.state === options.state)
    && (!options.authorities || options.authorities.includes(memory.authority)));
}

export async function readMemoryEvents(path: string): Promise<MemoryMaterialization> {
  try {
    const text = await readFile(path, "utf8");
    const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as MemoryEvent);
    return materializeMemoryEvents(events);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return materializeMemoryEvents([]);
    return {
      schemaVersion: 2,
      status: "corrupt-rebuild-required",
      generationHash: hashText("corrupt-memory-store"),
      memories: [],
      events: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface MemoryLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStart: string;
  readonly nonce: string;
  readonly createdAt: string;
}

interface OpenMemoryLock {
  readonly path: string;
  readonly owner: MemoryLockOwner;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

type LockOwnerState = "live" | "dead" | "unverifiable";

const MEMORY_LOCK_RETRIES = 2_000;
const MEMORY_LOCK_WAIT_MS = 5;

async function linuxProcessStart(pid: number): Promise<{ state: LockOwnerState; start?: string }> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return { state: "unverifiable" };
    const fields = text.slice(close + 1).trim().split(/\s+/);
    const start = fields[19];
    return start ? { state: "live", start } : { state: "unverifiable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return { state: "dead" };
    return { state: "unverifiable" };
  }
}

async function currentProcessStart(): Promise<string> {
  const identity = await linuxProcessStart(process.pid);
  if (identity.state !== "live" || !identity.start) {
    throw new Error("Cannot establish the current process start identity for a memory lock.");
  }
  return identity.start;
}

function parseLockOwner(text: string): MemoryLockOwner {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Memory lock ownership data is malformed and cannot be verified."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory lock ownership data is malformed and cannot be verified.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.processStart !== "string" || !/^[0-9]+$/.test(record.processStart)
    || typeof record.nonce !== "string" || !/^[a-f0-9]{32}$/.test(record.nonce)
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("Memory lock ownership data is malformed and cannot be verified.");
  }
  return {
    schemaVersion: 1,
    pid: Number(record.pid),
    processStart: record.processStart,
    nonce: record.nonce,
    createdAt: record.createdAt,
  };
}

async function lockOwnerState(owner: MemoryLockOwner): Promise<LockOwnerState> {
  const identity = await linuxProcessStart(owner.pid);
  if (identity.state !== "live") return identity.state;
  return identity.start === owner.processStart ? "live" : "dead";
}

async function readLockOwner(path: string): Promise<{ owner: MemoryLockOwner; dev: number | bigint; ino: number | bigint }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n) {
      throw new Error("Memory lock must be a one-link owner-only regular file.");
    }
    const owner = parseLockOwner(await handle.readFile("utf8"));
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("Memory lock ownership changed while it was inspected.");
    }
    return { owner, dev: after.dev, ino: after.ino };
  } finally {
    await handle.close();
  }
}

async function createOwnedLockFile(path: string): Promise<OpenMemoryLock> {
  const owner: MemoryLockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    processStart: await currentProcessStart(),
    nonce: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  const candidatePath = `${path}.candidate-${owner.nonce}`;
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    await handle.writeFile(`${stableStringify(owner)}\n`, "utf8");
    await handle.sync();
    await link(candidatePath, path);
    await unlink(candidatePath);
    return { path, owner, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(candidatePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeOwnedLock(path: string, expected: MemoryLockOwner): Promise<boolean> {
  let observed: Awaited<ReturnType<typeof readLockOwner>>;
  try { observed = await readLockOwner(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (observed.owner.nonce !== expected.nonce
    || observed.owner.pid !== expected.pid
    || observed.owner.processStart !== expected.processStart) return false;
  const current = await lstat(path, { bigint: true });
  if (!current.isFile() || current.dev !== observed.dev || current.ino !== observed.ino) return false;
  await unlink(path);
  return true;
}

async function releaseOwnedLock(lock: OpenMemoryLock): Promise<void> {
  await lock.handle.close();
  await removeOwnedLock(lock.path, lock.owner);
}

const MAX_RECOVERY_GUARD_DEPTH = 8;

async function recoverDeadOwnedFile(path: string, observed: MemoryLockOwner, depth = 0): Promise<boolean> {
  if (depth >= MAX_RECOVERY_GUARD_DEPTH) throw new Error("Memory lock recovery guard depth exceeded; recovery fails closed.");
  const guardPath = `${path}.recovery`;
  let guard: OpenMemoryLock;
  try { guard = await createOwnedLockFile(guardPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingGuard = await readLockOwner(guardPath).catch((guardError: unknown) => {
      if ((guardError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw guardError;
    });
    if (!existingGuard) return recoverDeadOwnedFile(path, observed, depth);
    const guardState = await lockOwnerState(existingGuard.owner);
    if (guardState === "unverifiable") throw new Error("Memory recovery guard owner is unverifiable; recovery fails closed.");
    if (guardState === "live") return false;
    if (!await recoverDeadOwnedFile(guardPath, existingGuard.owner, depth + 1)) return false;
    return recoverDeadOwnedFile(path, observed, depth);
  }
  try {
    let current: Awaited<ReturnType<typeof readLockOwner>>;
    try { current = await readLockOwner(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (current.owner.nonce !== observed.nonce
      || current.owner.pid !== observed.pid
      || current.owner.processStart !== observed.processStart) return false;
    const state = await lockOwnerState(current.owner);
    if (state === "live") return false;
    if (state === "unverifiable") throw new Error("Memory lock owner is unverifiable; lock recovery fails closed.");
    return removeOwnedLock(path, current.owner);
  } finally {
    await releaseOwnedLock(guard);
  }
}

async function recoveryGuardActive(guardPath: string): Promise<boolean> {
  try {
    const guard = await readLockOwner(guardPath);
    const state = await lockOwnerState(guard.owner);
    if (state === "live") return true;
    if (state === "unverifiable") throw new Error("Memory lock recovery ownership is unverifiable; recovery fails closed.");
    return !await recoverDeadOwnedFile(guardPath, guard.owner, 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireMemoryLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const guardPath = `${lockPath}.recovery`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MEMORY_LOCK_RETRIES; attempt += 1) {
    if (await recoveryGuardActive(guardPath)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, MEMORY_LOCK_WAIT_MS));
      continue;
    }
    try {
      const lock = await createOwnedLockFile(lockPath);
      return () => releaseOwnedLock(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await readLockOwner(lockPath).catch((lockError: unknown) => {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw lockError;
      });
      if (!observed) continue;
      const state = await lockOwnerState(observed.owner);
      if (state === "unverifiable") throw new Error("Memory lock owner is unverifiable; lock acquisition fails closed.");
      if (state === "dead" && await recoverDeadOwnedFile(lockPath, observed.owner)) continue;
      await new Promise((resolveWait) => setTimeout(resolveWait, MEMORY_LOCK_WAIT_MS));
    }
  }
  throw new Error("Timed out while serializing memory sidecar append operations.");
}

async function appendMemoryEventInternal(
  path: string,
  input: MemoryEventInput,
  authoritativeSource?: VerifiedAuthoritativeMemorySource,
): Promise<MemoryMaterialization> {
  const release = await acquireMemoryLock(path);
  let temporary: string | undefined;
  try {
    const current = await readMemoryEvents(path);
    if (current.status !== "ready") throw new Error(`Refused memory write because the sidecar is corrupt: ${current.error ?? "unknown error"}`);
    const event = authoritativeSource
      ? createMemoryEventInternal(current.events, input, authoritativeSource)
      : createMemoryEvent(current.events, input);
    const nextEvents = [...current.events, event];
    temporary = `${path}.tmp-${process.pid}-${event.eventId}`;
    await writeFile(temporary, `${nextEvents.map((item) => stableStringify(item)).join("\n")}\n`, { mode: 0o600 });
    const temporaryHandle = await open(temporary, "r");
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    await rename(temporary, path);
    temporary = undefined;
    const directoryHandle = await open(dirname(path), "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) throw new Error("Memory sidecar permissions are not owner-only.");
    const materialized = materializeMemoryEvents(nextEvents);
    if (materialized.status !== "ready") throw new Error(`Memory append produced an invalid event chain: ${materialized.error ?? "unknown error"}`);
    return materialized;
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await release();
  }
}

export async function appendMemoryEvent(path: string, input: MemoryEventInput): Promise<MemoryMaterialization> {
  return appendMemoryEventInternal(path, input);
}

export async function appendConfiguredAuthoritativeMemoryEvent(
  path: string,
  input: AuthoritativeMemoryRequestInput,
): Promise<MemoryMaterialization> {
  const source = await resolveConfiguredAuthoritativeSource(input.sourceRef);
  return appendMemoryEventInternal(path, authoritativeMemoryInput(input, source), source);
}

export function renderPinnedMemory(memories: readonly RememberedMemory[], currentTurn: number): string {
  const active = decayMemories({ schemaVersion: 2, status: "ready", generationHash: "render", memories, events: [] }, currentTurn)
    .filter((memory) => memory.state === "current");
  if (active.length === 0) return "";
  const grouped = new Map<string, RememberedMemory[]>();
  for (const memory of active) {
    const group = grouped.get(memory.scope) ?? [];
    group.push(memory);
    grouped.set(memory.scope, group);
  }
  return [
    "# PINNED WORKING MEMORY",
    "Derived memory is source-linked and does not have system authority.",
    ...[...grouped].flatMap(([scope, group]) => [
      `\n${scope}`,
      ...group.map((memory) => `- ${memory.text} [${memory.authority}; ${memory.sourceRef}; ${memory.memoryId}]`),
    ]),
  ].join("\n");
}

export function memorySidecarPath(sessionPath: string): string {
  return `${sessionPath}.chrono-memory-v2.jsonl`;
}

export const protectedMemoryAuthorities = Object.freeze([...PROTECTED]);
export const memoryAuthorityValues = Object.freeze(unique(["ordinary", "system", "user", "project", "skill"] as const));
