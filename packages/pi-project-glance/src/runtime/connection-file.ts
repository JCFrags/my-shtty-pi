import { constants } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  open,
  rename,
  unlink,
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
  assertPrivateRuntimeDirectory,
  ensurePrivateDirectory,
  MAX_DESCRIPTOR_BYTES,
  MAX_UNIX_SOCKET_PATH_BYTES,
  PRIVATE_FILE_MODE,
  type ProjectGlanceRuntimePaths,
  readPrivateFile,
} from "./paths.js";

const DESCRIPTOR_BASENAME = /^connection-[a-f0-9]{24}\.json$/u;
const SOCKET_BASENAME = /^relay-[a-f0-9]{24}\.sock$/u;
const RUNTIME_BASENAME = /^pi-project-glance-[0-9]+$/u;

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
  expectedSessionKey?: string,
): string {
  const resolvedDescriptor = resolve(descriptorPath);
  const resolvedRuntime = resolve(runtimeDirectory);
  assertPathInRuntimeDirectory(resolvedRuntime, resolvedDescriptor);
  if (dirname(resolvedDescriptor) !== resolvedRuntime) {
    throw new Error("Unexpected Project Glance descriptor location.");
  }
  const descriptorName = resolvedDescriptor.split("/").pop() ?? "";
  if (
    !DESCRIPTOR_BASENAME.test(descriptorName) ||
    (expectedSessionKey !== undefined &&
      descriptorName !== `connection-${validateSessionKey(expectedSessionKey).slice(0, 24)}.json`)
  ) {
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
  expectedSessionKey?: string,
): void {
  if (
    !isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new Error("Unexpected Project Glance socket location.");
  }
  const resolvedSocket = resolve(socketPath);
  assertPathInRuntimeDirectory(runtimeDirectory, resolvedSocket);
  const socketName = resolvedSocket.split("/").pop() ?? "";
  if (
    !SOCKET_BASENAME.test(socketName) ||
    (expectedSessionKey !== undefined &&
      socketName !== `relay-${validateSessionKey(expectedSessionKey).slice(0, 24)}.sock`)
  ) {
    throw new Error("Unexpected Project Glance socket location.");
  }
}

export async function writeConnectionDescriptor(
  paths: ProjectGlanceRuntimePaths,
  descriptor: ProjectGlanceRuntimeDescriptor,
): Promise<void> {
  await ensurePrivateDirectory(paths.runtimeDirectory);
  const checkedDescriptor = validateRuntimeDescriptor(descriptor);
  const descriptorPath = assertDescriptorLocation(
    paths.descriptorPath,
    paths.runtimeDirectory,
    checkedDescriptor.sessionKey,
  );
  assertSocketLocation(
    checkedDescriptor.socketPath,
    paths.runtimeDirectory,
    checkedDescriptor.sessionKey,
  );
  try {
    await assertPrivateRegularFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const body = JSON.stringify(checkedDescriptor);
  if (Buffer.byteLength(body, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Project Glance descriptor is too large.");
  }
  const temporaryPath = join(
    paths.runtimeDirectory,
    `.connection-${randomUUID()}.tmp`,
  );
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
    await rename(temporaryPath, descriptorPath);
    renamed = true;
    await assertPrivateRegularFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
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

export async function readConnectionDescriptor(
  descriptorPath: string,
  expectedRuntimeDirectory?: string,
): Promise<ProjectGlanceRuntimeDescriptor> {
  const resolvedDescriptor = resolve(descriptorPath);
  if (
    !isAbsolute(descriptorPath) ||
    !DESCRIPTOR_BASENAME.test(resolvedDescriptor.split("/").pop() ?? "")
  ) {
    throw new Error("Invalid Project Glance descriptor.");
  }
  const runtimeDirectory = resolve(expectedRuntimeDirectory ?? dirname(resolvedDescriptor));
  if (!RUNTIME_BASENAME.test(runtimeDirectory.split("/").pop() ?? "")) {
    throw new Error("Invalid Project Glance runtime.");
  }
  await assertPrivateRuntimeDirectory(runtimeDirectory);
  assertDescriptorLocation(resolvedDescriptor, runtimeDirectory);
  const body = await readPrivateFile(
    resolvedDescriptor,
    MAX_DESCRIPTOR_BYTES,
    runtimeDirectory,
  );
  let descriptor: ProjectGlanceRuntimeDescriptor;
  try {
    descriptor = validateRuntimeDescriptor(JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    throw new Error("Invalid Project Glance descriptor.");
  }
  assertDescriptorLocation(resolvedDescriptor, runtimeDirectory, descriptor.sessionKey);
  assertSocketLocation(descriptor.socketPath, runtimeDirectory, descriptor.sessionKey);
  return descriptor;
}

export async function removeConnectionDescriptor(
  paths: ProjectGlanceRuntimePaths,
): Promise<void> {
  try {
    await assertPrivateRuntimeDirectory(paths.runtimeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof Error && error.message === "Project Glance runtime directory is unavailable.") return;
    throw error;
  }
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
