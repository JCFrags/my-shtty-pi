import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export function normalizeToolPath(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}

export function resolveToolPath(cwd: string, input: string): string {
  const normalized = normalizeToolPath(input);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

export async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const link = await readlink(absolute);
      return canonicalTarget(resolve(dirname(absolute), link));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}
