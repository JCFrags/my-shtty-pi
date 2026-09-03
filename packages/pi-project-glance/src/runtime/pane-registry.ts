import { constants, readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertPathInRuntimeDirectory,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  MAX_RUNTIME_PATH_BYTES,
  PRIVATE_FILE_MODE,
  readPrivateFile,
  type ProjectGlanceRuntimePaths,
} from "./paths.js";
import { PROJECT_GLANCE_PROTOCOL_VERSION } from "../protocol/model.js";
import {
  ProjectGlanceValidationError,
  validateSessionKey,
} from "../protocol/validation.js";

export const MAX_REGISTRY_BYTES = 4 * 1024;
export const MAX_REGISTRY_LOCK_BYTES = 2 * 1024;
export const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
export const REGISTRY_LOCK_RETRY_MS = 10;
const PANE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REGISTRY_BASENAME = /^pane-([a-f0-9]{24})\.json$/u;
const LOCK_BASENAME = /^pane-([a-f0-9]{24})\.lock$/u;
const PROCESS_START_TIME_PATTERN = /^\d{1,32}$/u;
const NONCE_PATTERN = /^[a-f0-9]{32}$/u;

type RegistryRecord = {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  sessionKey: string;
  paneId: string;
  updatedAt: string;
};

type PublicRegistryRecord = {
  paneId: string;
  updatedAt: string;
};

export type ProjectGlanceRegistryLockRecord = {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  sessionKey: string;
  pid: number;
  processStartTime: string;
  nonce: string;
};

export type ProjectGlanceProcessIdentity = {
  pid: number;
  processStartTime: string;
};

export interface ProjectGlancePaneRegistrySession {
  get(sessionKey: string): Promise<{ paneId: string; updatedAt: string } | undefined>;
  set(sessionKey: string, paneId: string): Promise<void>;
  remove(sessionKey: string): Promise<void>;
}

type FileIdentity = {
  dev: number;
  ino: number;
};

type OwnedLock = {
  record: ProjectGlanceRegistryLockRecord;
  identity: FileIdentity;
  handle: Awaited<ReturnType<typeof open>>;
  released: boolean;
};

function assertPaneId(value: unknown): string {
  if (typeof value !== "string" || !PANE_ID_PATTERN.test(value)) {
    throw new ProjectGlanceValidationError();
  }
  return value;
}

function assertTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ProjectGlanceValidationError();
  }
  return value;
}

function assertProcessId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2 ** 31 - 1) {
    throw new ProjectGlanceValidationError();
  }
  return Number(value);
}

function assertProcessStartTime(value: unknown): string {
  if (typeof value !== "string" || !PROCESS_START_TIME_PATTERN.test(value)) {
    throw new ProjectGlanceValidationError();
  }
  return value;
}

function assertNonce(value: unknown): string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
    throw new ProjectGlanceValidationError();
  }
  return value;
}

function registryLocations(
  paths: ProjectGlanceRuntimePaths,
  expectedSessionKey?: string,
): { path: string; lockPath: string; prefix: string } {
  const runtimeDirectory = resolve(paths.runtimeDirectory);
  const path = resolve(paths.registryPath);
  const lockPath = resolve(paths.registryLockPath);
  assertPathInRuntimeDirectory(runtimeDirectory, path);
  assertPathInRuntimeDirectory(runtimeDirectory, lockPath);
  const registryMatch = REGISTRY_BASENAME.exec(basename(path));
  const lockMatch = LOCK_BASENAME.exec(basename(lockPath));
  const prefix = registryMatch?.[1];
  if (
    prefix === undefined ||
    lockMatch === null ||
    prefix !== lockMatch[1] ||
    dirname(path) !== runtimeDirectory ||
    dirname(lockPath) !== runtimeDirectory ||
    Buffer.byteLength(path, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    Buffer.byteLength(lockPath, "utf8") > MAX_RUNTIME_PATH_BYTES
  ) {
    throw new Error("Unexpected Project Glance registry location.");
  }
  if (
    expectedSessionKey !== undefined &&
    validateSessionKey(expectedSessionKey).slice(0, 24) !== prefix
  ) {
    throw new Error("PROJECT_GLANCE_REGISTRY_SESSION_MISMATCH");
  }
  return { path, lockPath, prefix };
}

function pathsForSession(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
): ProjectGlanceRuntimePaths {
  const key = validateSessionKey(sessionKey);
  const runtimeDirectory = resolve(paths.runtimeDirectory);
  const prefix = key.slice(0, 24);
  return {
    ...paths,
    registryPath: join(runtimeDirectory, `pane-${prefix}.json`),
    registryLockPath: join(runtimeDirectory, `pane-${prefix}.lock`),
  };
}

function validateRecord(value: unknown, expectedSessionKey: string): RegistryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectGlanceValidationError();
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !["version", "sessionKey", "paneId", "updatedAt"].includes(key)) ||
    source.version !== PROJECT_GLANCE_PROTOCOL_VERSION ||
    source.sessionKey !== expectedSessionKey ||
    !Object.hasOwn(source, "paneId") ||
    !Object.hasOwn(source, "updatedAt")
  ) {
    throw new ProjectGlanceValidationError();
  }
  return {
    version: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey: validateSessionKey(source.sessionKey),
    paneId: assertPaneId(source.paneId),
    updatedAt: assertTimestamp(source.updatedAt),
  };
}

function publicRecord(record: RegistryRecord | undefined): PublicRegistryRecord | undefined {
  if (!record) return undefined;
  return { paneId: record.paneId, updatedAt: record.updatedAt };
}

function validateLockRecord(
  value: unknown,
  expectedSessionKey: string,
): ProjectGlanceRegistryLockRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectGlanceValidationError();
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !["version", "sessionKey", "pid", "processStartTime", "nonce"].includes(key)) ||
    source.version !== PROJECT_GLANCE_PROTOCOL_VERSION ||
    source.sessionKey !== expectedSessionKey ||
    !Object.hasOwn(source, "pid") ||
    !Object.hasOwn(source, "processStartTime") ||
    !Object.hasOwn(source, "nonce")
  ) {
    throw new ProjectGlanceValidationError();
  }
  return {
    version: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey: validateSessionKey(source.sessionKey),
    pid: assertProcessId(source.pid),
    processStartTime: assertProcessStartTime(source.processStartTime),
    nonce: assertNonce(source.nonce),
  };
}

type ProcessIdentityProbe =
  | { state: "live"; processStartTime: string }
  | { state: "dead" | "unknown" };

function inspectProcessStartTime(pid: number): ProcessIdentityProbe {
  let body: string;
  try {
    body = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "dead" }
      : { state: "unknown" };
  }
  const closeParen = body.lastIndexOf(")");
  if (closeParen < 0) return { state: "unknown" };
  const fields = body.slice(closeParen + 1).trim().split(/\s+/u);
  const processStartTime = fields[19];
  if (typeof processStartTime !== "string" || !PROCESS_START_TIME_PATTERN.test(processStartTime)) {
    return { state: "unknown" };
  }
  return { state: "live", processStartTime };
}

export function currentProjectGlanceProcessIdentity(): ProjectGlanceProcessIdentity {
  const result = inspectProcessStartTime(process.pid);
  if (result.state !== "live") {
    throw new Error("PROJECT_GLANCE_LOCK_IDENTITY_UNAVAILABLE");
  }
  return { pid: process.pid, processStartTime: result.processStartTime };
}

export function createProjectGlanceRegistryLockRecord(
  sessionKey: string,
  identity: ProjectGlanceProcessIdentity = currentProjectGlanceProcessIdentity(),
  nonce = randomBytes(16).toString("hex"),
): ProjectGlanceRegistryLockRecord {
  const key = validateSessionKey(sessionKey);
  return {
    version: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey: key,
    pid: assertProcessId(identity.pid),
    processStartTime: assertProcessStartTime(identity.processStartTime),
    nonce: assertNonce(nonce),
  };
}

function fileIdentity(entry: { dev: number; ino: number }): FileIdentity {
  return { dev: entry.dev, ino: entry.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readRecord(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
): Promise<RegistryRecord | undefined> {
  const key = validateSessionKey(sessionKey);
  const { path } = registryLocations(paths, key);
  let body: Buffer;
  try {
    body = await readPrivateFile(path, MAX_REGISTRY_BYTES, paths.runtimeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return validateRecord(JSON.parse(body.toString("utf8")) as unknown, key);
  } catch {
    throw new Error("Invalid Project Glance registry record.");
  }
}

async function assertWritableTarget(path: string): Promise<void> {
  try {
    await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeRecord(
  paths: ProjectGlanceRuntimePaths,
  record: RegistryRecord,
): Promise<void> {
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const { path } = registryLocations(paths, record.sessionKey);
  await assertWritableTarget(path);
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Project Glance registry record is too large.");
  }
  const temporaryPath = join(paths.runtimeDirectory, `.pane-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    renamed = true;
    await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
  } finally {
    if (!renamed) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
    }
  }
}

async function removeRecord(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
): Promise<void> {
  const { path } = registryLocations(paths, sessionKey);
  try {
    await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readLockCandidate(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
): Promise<{ record: ProjectGlanceRegistryLockRecord; identity: FileIdentity } | undefined> {
  const { lockPath } = registryLocations(paths, sessionKey);
  let entry;
  try {
    entry = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("Unsafe Project Glance registry lock.");
  }
  let body: Buffer;
  try {
    body = await readPrivateFile(lockPath, MAX_REGISTRY_LOCK_BYTES, paths.runtimeDirectory);
  } catch {
    throw new Error("Project Glance registry is busy.");
  }
  try {
    return {
      record: validateLockRecord(JSON.parse(body.toString("utf8")) as unknown, validateSessionKey(sessionKey)),
      identity: fileIdentity(entry),
    };
  } catch {
    throw new Error("Project Glance registry is busy.");
  }
}

function processOwnerState(record: ProjectGlanceRegistryLockRecord): "live" | "stale" | "unknown" {
  const result = inspectProcessStartTime(record.pid);
  if (result.state !== "live") return result.state === "dead" ? "stale" : "unknown";
  return result.processStartTime === record.processStartTime ? "live" : "stale";
}

async function unlinkLockIfIdentity(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
  expectedIdentity: FileIdentity,
): Promise<boolean> {
  const { lockPath } = registryLocations(paths, sessionKey);
  let entry;
  try {
    entry = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || !sameFile(expectedIdentity, fileIdentity(entry))) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function removeLockIfMatches(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
  record: ProjectGlanceRegistryLockRecord,
  expectedIdentity: FileIdentity,
): Promise<boolean> {
  const { lockPath } = registryLocations(paths, sessionKey);
  let entry;
  try {
    entry = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || !sameFile(expectedIdentity, fileIdentity(entry))) {
    return false;
  }
  let body: Buffer;
  try {
    body = await readPrivateFile(lockPath, MAX_REGISTRY_LOCK_BYTES, paths.runtimeDirectory);
  } catch {
    return false;
  }
  let current: ProjectGlanceRegistryLockRecord;
  try {
    current = validateLockRecord(JSON.parse(body.toString("utf8")) as unknown, sessionKey);
  } catch {
    return false;
  }
  if (current.nonce !== record.nonce || current.pid !== record.pid || current.processStartTime !== record.processStartTime) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

async function releaseLock(paths: ProjectGlanceRuntimePaths, lock: OwnedLock): Promise<void> {
  if (lock.released) return;
  lock.released = true;
  try {
    await removeLockIfMatches(paths, lock.record.sessionKey, lock.record, lock.identity);
  } finally {
    await lock.handle.close();
  }
}

async function acquireLock(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
): Promise<() => Promise<void>> {
  const key = validateSessionKey(sessionKey);
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const { lockPath } = registryLocations(paths, key);
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
  const identity = currentProjectGlanceProcessIdentity();
  while (true) {
    const record = createProjectGlanceRegistryLockRecord(key, identity);
    try {
      const temporaryPath = join(paths.runtimeDirectory, `.pane-lock-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let createdIdentity: FileIdentity | undefined;
    let linked = false;
    let keepOpen = false;
    let temporaryRemoved = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      createdIdentity = fileIdentity(await handle.stat());
      const body = JSON.stringify(record);
      if (Buffer.byteLength(body, "utf8") > MAX_REGISTRY_LOCK_BYTES) {
        throw new Error("Project Glance registry lock is too large.");
      }
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      // Publish only after the complete private record is durable. A direct
      // O_EXCL create exposes an empty/partial lock to a competing opener.
      await link(temporaryPath, lockPath);
      linked = true;
      await unlink(temporaryPath);
      temporaryRemoved = true;
      const owned: OwnedLock = {
        record,
        identity: createdIdentity,
        handle,
        released: false,
      };
      keepOpen = true;
      return async () => releaseLock(paths, owned);
    } catch (error) {
      if (linked && createdIdentity !== undefined) {
        await unlinkLockIfIdentity(paths, key, createdIdentity);
      }
      throw error;
    } finally {
      if (!keepOpen) {
        await handle?.close();
        if (!temporaryRemoved) await unlink(temporaryPath).catch(() => undefined);
      }
    }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const candidate = await readLockCandidate(paths, key);
      if (candidate === undefined) {
        if (Date.now() >= deadline) throw new Error("Project Glance registry is busy.");
        await new Promise((resolveResult) => setTimeout(resolveResult, REGISTRY_LOCK_RETRY_MS));
        continue;
      }
      const state = processOwnerState(candidate.record);
      if (state === "stale") {
        const removed = await removeLockIfMatches(paths, key, candidate.record, candidate.identity);
        if (removed) continue;
        if (Date.now() >= deadline) throw new Error("Project Glance registry is busy.");
        await new Promise((resolveResult) => setTimeout(resolveResult, REGISTRY_LOCK_RETRY_MS));
        continue;
      }
      if (state === "unknown") throw new Error("Project Glance registry is busy.");
      if (Date.now() >= deadline) throw new Error("Project Glance registry is busy.");
      await new Promise((resolveResult) => setTimeout(resolveResult, REGISTRY_LOCK_RETRY_MS));
    }
  }
}

export class ProjectGlancePaneRegistry {
  readonly #paths: ProjectGlanceRuntimePaths;

  constructor(paths: ProjectGlanceRuntimePaths) {
    this.#paths = paths;
  }

  async get(sessionKey: string): Promise<PublicRegistryRecord | undefined> {
    return publicRecord(await readRecord(this.#paths, sessionKey));
  }

  async set(sessionKey: string, paneId: string): Promise<void> {
    const key = validateSessionKey(sessionKey);
    const value = assertPaneId(paneId);
    await this.#withRegistryLock(this.#paths, key, async () => {
      await this.#setUnlocked(key, value);
    });
  }

  async remove(sessionKey: string): Promise<void> {
    const key = validateSessionKey(sessionKey);
    await this.#withRegistryLock(this.#paths, key, () => removeRecord(this.#paths, key));
  }

  async clear(sessionKey?: string): Promise<void> {
    if (sessionKey !== undefined) {
      await this.remove(sessionKey);
      return;
    }
    await ensurePrivateDirectory(this.#paths.runtimeDirectory);
    const entries = await readdir(this.#paths.runtimeDirectory, { withFileTypes: true });
    const sessionKeys = new Set<string>();
    for (const entry of entries) {
      const match = REGISTRY_BASENAME.exec(entry.name);
      if (!match) continue;
      const path = join(this.#paths.runtimeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unsafe Project Glance registry record.");
      await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
      let value: unknown;
      try {
        value = JSON.parse((await readPrivateFile(path, MAX_REGISTRY_BYTES, this.#paths.runtimeDirectory)).toString("utf8")) as unknown;
      } catch {
        throw new Error("Invalid Project Glance registry record.");
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid Project Glance registry record.");
      }
      const candidateKey = (value as Record<string, unknown>).sessionKey;
      let key: string;
      try {
        key = validateSessionKey(candidateKey);
        if (key.slice(0, 24) !== match[1]) throw new Error("registry prefix mismatch");
        validateRecord(value, key);
      } catch {
        throw new Error("Invalid Project Glance registry record.");
      }
      sessionKeys.add(key);
    }
    for (const key of sessionKeys) {
      const sessionPaths = pathsForSession(this.#paths, key);
      await this.#withRegistryLock(sessionPaths, key, () => removeRecord(sessionPaths, key));
    }
  }

  async withSessionLock<T>(
    sessionKey: string,
    operation: (session: ProjectGlancePaneRegistrySession) => Promise<T>,
  ): Promise<T> {
    const key = validateSessionKey(sessionKey);
    return this.#withRegistryLock(this.#paths, key, () => operation({
      get: async (requestedKey) => publicRecord(await readRecord(this.#paths, requestedKey)),
      set: (requestedKey, paneId) => this.#setUnlocked(requestedKey, paneId),
      remove: (requestedKey) => removeRecord(this.#paths, requestedKey),
    }));
  }

  async #withRegistryLock<T>(
    paths: ProjectGlanceRuntimePaths,
    sessionKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await acquireLock(paths, sessionKey);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async #setUnlocked(sessionKey: string, paneId: string): Promise<void> {
    const key = validateSessionKey(sessionKey);
    const value = assertPaneId(paneId);
    await writeRecord(this.#paths, {
      version: PROJECT_GLANCE_PROTOCOL_VERSION,
      sessionKey: key,
      paneId: value,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function isValidPaneId(value: string): boolean {
  return typeof value === "string" && PANE_ID_PATTERN.test(value);
}
