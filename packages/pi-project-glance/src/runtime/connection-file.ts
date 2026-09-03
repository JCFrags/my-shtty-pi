import { randomBytes, randomUUID } from "node:crypto";
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceRuntimeDescriptor,
} from "../protocol/model.js";
import {
  validateRuntimeDescriptor,
  validateSessionKey,
} from "../protocol/validation.js";
import {
  assertPathInRuntimeDirectory,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  MAX_DESCRIPTOR_BYTES,
  PRIVATE_FILE_MODE,
  type ProjectGlanceRuntimePaths,
} from "./paths.js";

const DESCRIPTOR_BASENAME = /^connection-[a-f0-9]{24}\.json$/u;
const SOCKET_BASENAME = /^relay-[a-f0-9]{24}\.sock$/u;
const RUNTIME_BASENAME = /^pi-project-glance-[0-9]+$/u;

function privateUmask<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  return operation().finally(() => process.umask(previous));
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function createRuntimeDescriptor(
  paths: ProjectGlanceRuntimePaths,
  sessionKey: string,
  now = new Date().toISOString(),
): ProjectGlanceRuntimeDescriptor {
  return {
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey: validateSessionKey(sessionKey),
    socketPath: paths.socketPath,
    token: randomHex(32),
    generation: randomHex(16),
    createdAt: now,
  };
}

function assertDescriptorLocation(
  descriptorPath: string,
  runtimeDirectory: string,
): string {
  const resolvedDescriptor = resolve(descriptorPath);
  const resolvedRuntime = resolve(runtimeDirectory);
  assertPathInRuntimeDirectory(resolvedRuntime, resolvedDescriptor);
  if (!DESCRIPTOR_BASENAME.test(resolvedDescriptor.split("/").pop() ?? "")) {
    throw new Error("Unexpected Project Glance descriptor location.");
  }
  if (!RUNTIME_BASENAME.test(resolvedRuntime.split("/").pop() ?? "")) {
    throw new Error("Unexpected Project Glance runtime location.");
  }
  return resolvedDescriptor;
}

function assertSocketLocation(
  socketPath: string,
  runtimeDirectory: string,
): void {
  const resolvedSocket = resolve(socketPath);
  assertPathInRuntimeDirectory(runtimeDirectory, resolvedSocket);
  if (!SOCKET_BASENAME.test(resolvedSocket.split("/").pop() ?? "")) {
    throw new Error("Unexpected Project Glance socket location.");
  }
}

export async function writeConnectionDescriptor(
  paths: ProjectGlanceRuntimePaths,
  descriptor: ProjectGlanceRuntimeDescriptor,
): Promise<void> {
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const descriptorPath = assertDescriptorLocation(
    paths.descriptorPath,
    paths.runtimeDirectory,
  );
  assertSocketLocation(descriptor.socketPath, paths.runtimeDirectory);
  const body = JSON.stringify(descriptor);
  if (Buffer.byteLength(body, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Project Glance descriptor is too large.");
  }
  const temporaryPath = join(
    paths.runtimeDirectory,
    `.connection-${randomUUID()}.tmp`,
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
    await rename(temporaryPath, descriptorPath);
  }).catch(async (error: unknown) => {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error;
  });
  await assertPrivateRegularFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
}

export async function readConnectionDescriptor(
  descriptorPath: string,
  expectedRuntimeDirectory?: string,
): Promise<ProjectGlanceRuntimeDescriptor> {
  const resolvedDescriptor = resolve(descriptorPath);
  if (!isAbsolute(descriptorPath) || !DESCRIPTOR_BASENAME.test(resolvedDescriptor.split("/").pop() ?? "")) {
    throw new Error("Invalid Project Glance descriptor.");
  }
  const runtimeDirectory = expectedRuntimeDirectory ?? dirname(resolvedDescriptor);
  if (!RUNTIME_BASENAME.test(runtimeDirectory.split("/").pop() ?? "")) {
    throw new Error("Invalid Project Glance runtime.");
  }
  assertDescriptorLocation(resolvedDescriptor, runtimeDirectory);
  await assertPrivateRegularFile(resolvedDescriptor, MAX_DESCRIPTOR_BYTES);
  const body = await readFile(resolvedDescriptor, "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Project Glance descriptor is too large.");
  }
  const descriptor = validateRuntimeDescriptor(JSON.parse(body) as unknown);
  assertSocketLocation(descriptor.socketPath, runtimeDirectory);
  return descriptor;
}

export async function removeConnectionDescriptor(
  paths: ProjectGlanceRuntimePaths,
): Promise<void> {
  const descriptorPath = assertDescriptorLocation(
    paths.descriptorPath,
    paths.runtimeDirectory,
  );
  try {
    await assertPrivateRegularFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
    await unlink(descriptorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
