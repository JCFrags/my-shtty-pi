import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceRuntimeDescriptor,
} from "../protocol/model.js";
import { ProjectGlanceValidationError } from "../protocol/validation.js";
import {
  assertPathInRuntimeDirectory,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  PRIVATE_DIRECTORY_MODE,
  type ProjectGlanceRuntimePaths,
} from "./paths.js";

const MAX_REGISTRY_BYTES = 16 * 1024;
const PANE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

type RegistryEntry = {
  paneId: string;
  updatedAt: string;
};

type RegistryDocument = {
  version: typeof PROJECT_GLANCE_PROTOCOL_VERSION;
  entries: Record<string, RegistryEntry>;
};

function privateUmask<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  return operation().finally(() => process.umask(previous));
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
    if (!/^[a-f0-9]{16,64}$/u.test(sessionKey)) {
      throw new ProjectGlanceValidationError();
    }
    if (
      valueForKey === null ||
      typeof valueForKey !== "object" ||
      Array.isArray(valueForKey)
    ) {
      throw new ProjectGlanceValidationError();
    }
    const entry = valueForKey as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !["paneId", "updatedAt"].includes(key)) ||
      !Object.hasOwn(entry, "paneId") ||
      !Object.hasOwn(entry, "updatedAt")
    ) {
      throw new ProjectGlanceValidationError();
    }
    entries[sessionKey] = {
      paneId: assertPaneId(entry.paneId),
      updatedAt: assertTimestamp(entry.updatedAt),
    };
  }
  return { version: PROJECT_GLANCE_PROTOCOL_VERSION, entries };
}

async function readDocument(path: string): Promise<RegistryDocument> {
  try {
    await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: PROJECT_GLANCE_PROTOCOL_VERSION, entries: {} };
    }
    throw error;
  }
  const body = await readFile(path, "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Project Glance registry is too large.");
  }
  return validateDocument(JSON.parse(body) as unknown);
}

async function writeDocument(
  paths: ProjectGlanceRuntimePaths,
  document: RegistryDocument,
): Promise<void> {
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const path = paths.registryPath;
  assertPathInRuntimeDirectory(paths.runtimeDirectory, path);
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Project Glance registry is too large.");
  }
  const temporaryPath = join(
    paths.runtimeDirectory,
    `.registry-${randomUUID()}.tmp`,
  );
  await privateUmask(async () => {
    await writeFile(temporaryPath, body, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
      flag: "wx",
    });
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  }).catch(async (error: unknown) => {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error;
  });
  await assertPrivateRegularFile(path, MAX_REGISTRY_BYTES);
}

export class ProjectGlancePaneRegistry {
  readonly #paths: ProjectGlanceRuntimePaths;

  constructor(paths: ProjectGlanceRuntimePaths) {
    this.#paths = paths;
  }

  async get(sessionKey: string): Promise<RegistryEntry | undefined> {
    const document = await readDocument(this.#paths.registryPath);
    return document.entries[sessionKey];
  }

  async set(sessionKey: string, paneId: string): Promise<void> {
    const document = await readDocument(this.#paths.registryPath);
    document.entries[sessionKey] = {
      paneId: assertPaneId(paneId),
      updatedAt: new Date().toISOString(),
    };
    await writeDocument(this.#paths, document);
  }

  async remove(sessionKey: string): Promise<void> {
    const document = await readDocument(this.#paths.registryPath);
    if (!Object.hasOwn(document.entries, sessionKey)) return;
    delete document.entries[sessionKey];
    if (Object.keys(document.entries).length === 0) {
      try {
        await assertPrivateRegularFile(this.#paths.registryPath, MAX_REGISTRY_BYTES);
        await unlink(this.#paths.registryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    await writeDocument(this.#paths, document);
  }

  async clear(): Promise<void> {
    try {
      await assertPrivateRegularFile(this.#paths.registryPath, MAX_REGISTRY_BYTES);
      await unlink(this.#paths.registryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function isValidPaneId(value: string): boolean {
  return PANE_ID_PATTERN.test(value);
}
