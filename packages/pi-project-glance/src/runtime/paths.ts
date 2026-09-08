import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_SESSION_KEY_BYTES,
  MAX_UNIX_SOCKET_PATH_BYTES,
  PROJECT_GLANCE_RUNTIME_KEY,
} from "../protocol/model.js";
import { ProjectGlanceValidationError, validateSessionKey } from "../protocol/validation.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export { MAX_UNIX_SOCKET_PATH_BYTES };
export const MAX_RUNTIME_PATH_BYTES = 512;
export const MAX_DESCRIPTOR_BYTES = 8 * 1024;

export interface ProjectGlanceRuntimePaths {
  runtimeDirectory: string;
  socketPath: string;
  descriptorPath: string;
  registryPath: string;
  registryLockPath: string;
  source: "xdg" | "tmp";
}

function uid(): number {
  return process.getuid?.() ?? 0;
}

function cleanBase(value: string | undefined): string | undefined {
  if (
    !value ||
    !isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    /\p{Cc}/u.test(value)
  ) return undefined;
  return resolve(value);
}

function candidateFor(
  base: string,
  sessionKey: string,
  source: ProjectGlanceRuntimePaths["source"],
): ProjectGlanceRuntimePaths | undefined {
  const directory = join(base, `${PROJECT_GLANCE_RUNTIME_KEY}-${uid()}`);
  const shortKey = sessionKey.slice(0, 24);
  const socketPath = join(directory, `relay-${shortKey}.sock`);
  const descriptorPath = join(directory, `connection-${shortKey}.json`);
  // Keep each session's pane record and acquisition lock independent.
  const registryPath = join(directory, `pane-${shortKey}.json`);
  const registryLockPath = join(directory, `pane-${shortKey}.lock`);
  if (
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES ||
    Buffer.byteLength(directory, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    Buffer.byteLength(descriptorPath, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    Buffer.byteLength(registryPath, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    Buffer.byteLength(registryLockPath, "utf8") > MAX_RUNTIME_PATH_BYTES
  ) {
    return undefined;
  }
  return {
    runtimeDirectory: directory,
    socketPath,
    descriptorPath,
    registryPath,
    registryLockPath,
    source,
  };
}

export function deriveSessionKey(sessionReference: string): string {
  if (
    typeof sessionReference !== "string" ||
    sessionReference.length === 0 ||
    Buffer.byteLength(sessionReference, "utf8") > 4096
  ) {
    throw new ProjectGlanceValidationError();
  }
  return createHash("sha256")
    .update("pi-project-glance-session\0", "utf8")
    .update(sessionReference, "utf8")
    .digest("hex")
    .slice(0, MAX_SESSION_KEY_BYTES);
}

export function runtimePathsForSession(
  sessionKey: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProjectGlanceRuntimePaths {
  const key = validateSessionKey(sessionKey);
  const xdg = cleanBase(environment.XDG_RUNTIME_DIR);
  const temp = cleanBase(tmpdir()) ?? resolve("/tmp");
  const primary = xdg ? candidateFor(xdg, key, "xdg") : undefined;
  const fallback = candidateFor(temp, key, "tmp");
  if (primary) return primary;
  if (fallback) return fallback;
  throw new Error("Project Glance runtime path is unavailable.");
}

function assertPathSyntax(path: string): string {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    Buffer.byteLength(path, "utf8") > MAX_RUNTIME_PATH_BYTES ||
    /\p{Cc}/u.test(path)
  ) {
    throw new Error("Invalid Project Glance runtime path.");
  }
  return resolve(path);
}

function assertPrivateMode(actual: number, expected: number): void {
  if ((actual & 0o7777) !== expected) throw new Error("Unsafe Project Glance permissions.");
}

function assertOwner(actual: number): void {
  const current = process.getuid?.();
  if (current !== undefined && actual !== current) {
    throw new Error("Unsafe Project Glance ownership.");
  }
}

function assertCanonical(path: string, canonical: string): void {
  if (resolve(path) !== resolve(canonical)) {
    throw new Error("Unsafe Project Glance path.");
  }
}

export function assertPathInRuntimeDirectory(
  runtimeDirectory: string,
  path: string,
): void {
  const root = assertPathSyntax(runtimeDirectory);
  const candidate = assertPathSyntax(path);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error("Project Glance path escapes its runtime directory.");
  }
}

export async function assertPrivateRuntimeDirectory(path: string): Promise<void> {
  const resolved = assertPathSyntax(path);
  let entry;
  try {
    entry = await lstat(resolved);
  } catch {
    throw new Error("Project Glance runtime directory is unavailable.");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Unsafe Project Glance runtime directory.");
  }
  assertOwner(entry.uid);
  assertPrivateMode(entry.mode, PRIVATE_DIRECTORY_MODE);
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch {
    throw new Error("Unsafe Project Glance runtime directory.");
  }
  assertCanonical(resolved, canonical);
}

export function assertPrivateRuntimeDirectorySync(path: string): void {
  const resolved = assertPathSyntax(path);
  let entry;
  try {
    entry = lstatSync(resolved);
  } catch {
    throw new Error("Project Glance runtime directory is unavailable.");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Unsafe Project Glance runtime directory.");
  }
  assertOwner(entry.uid);
  assertPrivateMode(entry.mode, PRIVATE_DIRECTORY_MODE);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    throw new Error("Unsafe Project Glance runtime directory.");
  }
  assertCanonical(resolved, canonical);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const resolved = assertPathSyntax(path);
  await mkdir(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertPrivateRuntimeDirectory(resolved);
}

export function ensurePrivateDirectorySync(path: string): void {
  const resolved = assertPathSyntax(path);
  mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  assertPrivateRuntimeDirectorySync(resolved);
}

export async function assertPrivateRegularFile(path: string, maxBytes: number): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe Project Glance file.");
  assertOwner(entry.uid);
  assertPrivateMode(entry.mode, PRIVATE_FILE_MODE);
  if (entry.size > maxBytes) throw new Error("Project Glance file is too large.");
}

export function assertPrivateRegularFileSync(path: string, maxBytes: number): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe Project Glance file.");
  assertOwner(entry.uid);
  assertPrivateMode(entry.mode, PRIVATE_FILE_MODE);
  if (entry.size > maxBytes) throw new Error("Project Glance file is too large.");
}

/** Read a private regular file through an O_NOFOLLOW handle after parent validation. */
export async function readPrivateFile(
  path: string,
  maxBytes: number,
  runtimeDirectory = dirname(path),
): Promise<Buffer> {
  const resolvedRuntime = assertPathSyntax(runtimeDirectory);
  const resolvedPath = assertPathSyntax(path);
  await assertPrivateRuntimeDirectory(resolvedRuntime);
  assertPathInRuntimeDirectory(resolvedRuntime, resolvedPath);
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe Project Glance file.");
    assertOwner(entry.uid);
    assertPrivateMode(entry.mode, PRIVATE_FILE_MODE);
    if (entry.size > maxBytes) throw new Error("Project Glance file is too large.");
    const body = await handle.readFile();
    if (body.byteLength > maxBytes) throw new Error("Project Glance file is too large.");
    return body;
  } finally {
    await handle.close();
  }
}

export async function assertPrivateSocket(path: string, runtimeDirectory?: string): Promise<void> {
  const resolvedPath = assertPathSyntax(path);
  if (runtimeDirectory !== undefined) {
    const resolvedRuntime = assertPathSyntax(runtimeDirectory);
    await assertPrivateRuntimeDirectory(resolvedRuntime);
    assertPathInRuntimeDirectory(resolvedRuntime, resolvedPath);
  }
  const entry = await lstat(resolvedPath);
  if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error("Unsafe Project Glance socket.");
  assertOwner(entry.uid);
  assertPrivateMode(entry.mode, PRIVATE_FILE_MODE);
}
