import { createHash } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function defaultRuntimeDirectory(): string { return `/run/user/${process.getuid?.()}/chrono-runtime`; }
export function legacySchedulerDirectory(): string {
  const uid = String(process.getuid?.() ?? "unknown");
  return join(tmpdir(), `chrono-compact-worker-v1-${createHash("sha256").update(uid).digest("hex").slice(0, 16)}`);
}
export async function prepareRuntimeNamespace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe-scheduler-directory");
  return realpath(path);
}
