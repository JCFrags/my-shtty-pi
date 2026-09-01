import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalTarget } from "./paths.ts";

export interface AtomicWriteResult {
  target: string;
  atomic: boolean;
  preservedHardLinks: boolean;
}

export async function atomicWriteText(inputPath: string, content: string): Promise<AtomicWriteResult> {
  const target = await canonicalTarget(inputPath);
  await mkdir(dirname(target), { recursive: true });

  let existing: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    existing = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = undefined;
  }

  if (existing && existing.nlink > 1) {
    await writeFile(target, content, { encoding: "utf8", flush: true });
    return { target, atomic: false, preservedHardLinks: true };
  }

  const temp = join(dirname(target), `.${randomBytes(8).toString("hex")}.grounded-tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", existing?.mode ?? 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (existing) {
      await chown(temp, existing.uid, existing.gid).catch(() => undefined);
      await chmod(temp, existing.mode);
    }
    await rename(temp, target);
    return { target, atomic: true, preservedHardLinks: false };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
