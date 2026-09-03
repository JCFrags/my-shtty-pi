import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, lstat, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

export const MAX_REGISTRY_BYTES = 16 * 1024;
export const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const PANE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REGISTRY_NAME = "pi-project-glance-panes.json";
const LOCK_NAME = "pi-project-glance-panes.lock";

type RegistryDocument = {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  entries: Record<string, RegistryEntry>;
};

export type RegistryEntry = {
  paneId: string;
  updatedAt: string;
};

export interface ProjectGlancePaneRegistrySession {
  get(sessionKey: string): Promise<RegistryEntry | undefined>;
  set(sessionKey: string, paneId: string): Promise<void>;
  remove(sessionKey: string): Promise<void>;
}

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

function assertRegistryLocation(
  paths: ProjectGlanceRuntimePaths,
): { path: string; lockPath: string } {
  const runtimeDirectory = resolve(paths.runtimeDirectory);
  const path = resolve(paths.registryPath);
  assertPathInRuntimeDirectory(runtimeDirectory, path);
  if (
    dirname(path) !== runtimeDirectory ||
    path !== join(runtimeDirectory, REGISTRY_NAME) ||
    Buffer.byteLength(path, "utf8") > MAX_RUNTIME_PATH_BYTES
  ) {
    throw new Error("Unexpected Project Glance registry location.");
  }
  const lockPath = join(runtimeDirectory, LOCK_NAME);
  if (Buffer.byteLength(lockPath, "utf8") > MAX_RUNTIME_PATH_BYTES) {
    throw new Error("Unexpected Project Glance registry lock location.");
  }
  return { path, lockPath };
}

function validateDocument(value: unknown): RegistryDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectGlanceValidationError();
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !["version", "entries"].includes(key)) ||
    source.version !== PROJECT_GLANCE_PROTOCOL_VERSION ||
    source.entries === null ||
    typeof source.entries !== "object" ||
    Array.isArray(source.entries)
  ) {
    throw new ProjectGlanceValidationError();
  }
  const entries: Record<string, RegistryEntry> = {};
  for (const [sessionKey, valueForKey] of Object.entries(
    source.entries as Record<string, unknown>,
  )) {
    const key = validateSessionKey(sessionKey);
    if (valueForKey === null || typeof valueForKey !== "object" || Array.isArray(valueForKey)) {
      throw new ProjectGlanceValidationError();
    }
    const entry = valueForKey as Record<string, unknown>;
    if (
      Object.keys(entry).some((keyName) => !["paneId", "updatedAt"].includes(keyName)) ||
      !Object.hasOwn(entry, "paneId") ||
      !Object.hasOwn(entry, "updatedAt")
    ) {
      throw new ProjectGlanceValidationError();
    }
    entries[key] = {
      paneId: assertPaneId(entry.paneId),
      updatedAt: assertTimestamp(entry.updatedAt),
    };
  }
  return { version: PROJECT_GLANCE_PROTOCOL_VERSION, entries };
}

async function readDocument(
  paths: ProjectGlanceRuntimePaths,
): Promise<RegistryDocument> {
  const { path } = assertRegistryLocation(paths);
  let body: Buffer;
  try {
    body = await readPrivateFile(path, MAX_REGISTRY_BYTES, paths.runtimeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: PROJECT_GLANCE_PROTOCOL_VERSION, entries: {} };
    }
    throw error;
  }
  try {
    return validateDocument(JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    throw new Error("Invalid Project Glance registry.");
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

async function writeDocument(
  paths: ProjectGlanceRuntimePaths,
  document: RegistryDocument,
): Promise<void> {
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const { path } = assertRegistryLocation(paths);
  await assertWritableTarget(path);
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Project Glance registry is too large.");
  }
  const temporaryPath = join(paths.runtimeDirectory, `.registry-${randomUUID()}.tmp`);
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveResult) => setTimeout(resolveResult, milliseconds));
}

async function acquireLock(
  paths: ProjectGlanceRuntimePaths,
): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const { lockPath } = assertRegistryLocation(paths);
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      try {
        await handle.chmod(PRIVATE_FILE_MODE);
        const entry = await handle.stat();
        if (!entry.isFile() || (entry.mode & 0o7777) !== PRIVATE_FILE_MODE) {
          throw new Error("Unsafe Project Glance registry lock.");
        }
        await handle.sync();
      } catch (error) {
        await handle.close();
        try { await unlink(lockPath); } catch { /* best effort */ }
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        try {
          await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const entry = await lstat(lockPath);
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error("Unsafe Project Glance registry lock.");
        }
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ENOENT") throw probeError;
      }
      if (Date.now() >= deadline) throw new Error("Project Glance registry is busy.");
      await wait(10);
    }
  }
}

export class ProjectGlancePaneRegistry {
  readonly #paths: ProjectGlanceRuntimePaths;

  constructor(paths: ProjectGlanceRuntimePaths) {
    this.#paths = paths;
  }

  async get(sessionKey: string): Promise<RegistryEntry | undefined> {
    const key = validateSessionKey(sessionKey);
    const document = await readDocument(this.#paths);
    return document.entries[key];
  }

  async set(sessionKey: string, paneId: string): Promise<void> {
    const key = validateSessionKey(sessionKey);
    const value = assertPaneId(paneId);
    await this.#withRegistryLock(async () => {
      const document = await readDocument(this.#paths);
      document.entries[key] = {
        paneId: value,
        updatedAt: new Date().toISOString(),
      };
      await writeDocument(this.#paths, document);
    });
  }

  async remove(sessionKey: string): Promise<void> {
    const key = validateSessionKey(sessionKey);
    await this.#withRegistryLock(() => this.#removeUnlocked(key));
  }

  async clear(sessionKey?: string): Promise<void> {
    if (sessionKey !== undefined) {
      await this.remove(sessionKey);
      return;
    }
    await this.#withRegistryLock(async () => {
      const { path } = assertRegistryLocation(this.#paths);
      try {
        await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  async withSessionLock<T>(
    sessionKey: string,
    operation: (session: ProjectGlancePaneRegistrySession) => Promise<T>,
  ): Promise<T> {
    validateSessionKey(sessionKey);
    return this.#withRegistryLock(() => operation({
      get: (key) => this.get(key),
      set: (key, paneId) => this.#setUnlocked(key, paneId),
      remove: (key) => this.#removeUnlocked(validateSessionKey(key)),
    }));
  }

  async #withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireLock(this.#paths);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async #setUnlocked(sessionKey: string, paneId: string): Promise<void> {
    const key = validateSessionKey(sessionKey);
    const value = assertPaneId(paneId);
    const document = await readDocument(this.#paths);
    document.entries[key] = {
      paneId: value,
      updatedAt: new Date().toISOString(),
    };
    await writeDocument(this.#paths, document);
  }

  async #removeUnlocked(sessionKey: string): Promise<void> {
    const document = await readDocument(this.#paths);
    if (!Object.hasOwn(document.entries, sessionKey)) return;
    delete document.entries[sessionKey];
    if (Object.keys(document.entries).length === 0) {
      const { path } = assertRegistryLocation(this.#paths);
      try {
        await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    await writeDocument(this.#paths, document);
  }
}

export function isValidPaneId(value: string): boolean {
  return typeof value === "string" && PANE_ID_PATTERN.test(value);
}
