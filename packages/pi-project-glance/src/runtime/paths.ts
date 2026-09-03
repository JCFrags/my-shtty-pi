import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  MAX_SESSION_KEY_BYTES,
  PROJECT_GLANCE_RUNTIME_KEY,
} from "../protocol/model.js";
import { ProjectGlanceValidationError, validateSessionKey } from "../protocol/validation.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;
export const MAX_DESCRIPTOR_BYTES = 8 * 1024;

export interface ProjectGlanceRuntimePaths {
  runtimeDirectory: string;
  socketPath: string;
  descriptorPath: string;
  registryPath: string;
  source: "xdg" | "tmp";
}

function uid(): number {
  return process.getuid?.() ?? 0;
}

function cleanBase(value: string | undefined): string | undefined {
  if (!value || !isAbsolute(value) || /\p{Cc}/u.test(value)) return undefined;
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
  const registryPath = join(directory, "pi-project-glance-panes.json");
  if (
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES ||
    Buffer.byteLength(directory, "utf8") > 512 ||
    Buffer.byteLength(descriptorPath, "utf8") > 512
  ) {
    return undefined;
  }
  return {
    runtimeDirectory: directory,
    socketPath,
    descriptorPath,
    registryPath,
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

function assertPrivateMode(actual: number, expected: number): void {
  if ((actual & 0o777) !== expected) throw new Error("Unsafe Project Glance permissions.");
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

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Unsafe Project Glance runtime directory.");
  }
  assertOwner(entry.uid);
  await chmod(path, PRIVATE_DIRECTORY_MODE);
  const canonical = await realpath(path);
  assertCanonical(path, canonical);
  const checked = await stat(path);
  assertPrivateMode(checked.mode, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Unsafe Project Glance runtime directory.");
  }
  assertOwner(entry.uid);
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  const canonical = realpathSync(path);
  assertCanonical(path, canonical);
  assertPrivateMode(statSync(path).mode, PRIVATE_DIRECTORY_MODE);
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

export async function assertPrivateSocket(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error("Unsafe Project Glance socket.");
  assertOwner(entry.uid);
  if ((entry.mode & 0o077) !== 0) throw new Error("Unsafe Project Glance socket permissions.");
}

export function assertPathInRuntimeDirectory(
  runtimeDirectory: string,
  path: string,
): void {
  const root = resolve(runtimeDirectory);
  const candidate = resolve(path);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error("Project Glance path escapes its runtime directory.");
  }
}
