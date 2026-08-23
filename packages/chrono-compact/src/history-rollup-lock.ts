import { randomBytes } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface HistoryRollupLockOwner {
  readonly schemaVersion: 2;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly nonce: string;
  readonly creationTime: string;
}

export interface HistoryRollupLockOptions {
  readonly readProcessStart?: (pid: number) => Promise<string | "missing" | "unverifiable">;
}

async function linuxProcessStart(pid: number): Promise<string | "missing" | "unverifiable"> {
  if (process.platform !== "linux") return "unverifiable";
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19] ?? "unverifiable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverifiable";
  }
}

async function currentOwner(options: HistoryRollupLockOptions): Promise<HistoryRollupLockOwner> {
  const readStart = options.readProcessStart ?? linuxProcessStart;
  const processStartIdentity = await readStart(process.pid);
  if (processStartIdentity === "missing" || processStartIdentity === "unverifiable") {
    throw new Error("history-rollup-owner-unverifiable");
  }
  return {
    schemaVersion: 2,
    pid: process.pid,
    processStartIdentity,
    nonce: randomBytes(16).toString("hex"),
    creationTime: new Date().toISOString(),
  };
}

function validOwner(value: unknown): value is HistoryRollupLockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<HistoryRollupLockOwner>;
  return owner.schemaVersion === 2 &&
    Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 &&
    typeof owner.processStartIdentity === "string" && owner.processStartIdentity.length > 0 &&
    typeof owner.nonce === "string" && /^[a-f0-9]{32}$/.test(owner.nonce) &&
    typeof owner.creationTime === "string";
}

async function ownerIsDead(owner: HistoryRollupLockOwner, options: HistoryRollupLockOptions): Promise<boolean> {
  const readStart = options.readProcessStart ?? linuxProcessStart;
  const current = await readStart(owner.pid);
  if (current === "unverifiable") throw new Error("history-rollup-lock-owner-unverifiable");
  if (current === "missing") return true;
  return current !== owner.processStartIdentity;
}

export async function acquireHistoryRollupLock(
  directory: string,
  options: HistoryRollupLockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = join(directory, "writer.lock");
  const owner = await currentOwner(options);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: HistoryRollupLockOwner;
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
      if (!validOwner(parsed)) throw new Error("invalid-owner");
      existing = parsed;
    } catch {
      throw new Error("history-rollup-lock-owner-unverifiable");
    }
    if (!(await ownerIsDead(existing, options))) throw new Error("history-rollup-store-busy");
    const before = await stat(lockPath);
    const parsedAgain = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    if (!validOwner(parsedAgain)) throw new Error("history-rollup-lock-owner-unverifiable");
    const again = parsedAgain;
    const after = await stat(lockPath);
    if (before.ino !== after.ino || again.nonce !== existing.nonce ||
      again.pid !== existing.pid || again.processStartIdentity !== existing.processStartIdentity) {
      throw new Error("history-rollup-lock-replaced");
    }
    await rm(lockPath);
    handle = await open(lockPath, "wx", 0o600);
  }
  await handle.writeFile(JSON.stringify(owner));
  await handle.sync();
  const inode = (await handle.stat()).ino;
  return async () => {
    await handle.close();
    try {
      const currentStat = await stat(lockPath);
      const current = JSON.parse(await readFile(lockPath, "utf8")) as HistoryRollupLockOwner;
      if (
        currentStat.ino === inode &&
        current.nonce === owner.nonce &&
        current.pid === owner.pid &&
        current.processStartIdentity === owner.processStartIdentity
      ) {
        await rm(lockPath);
      }
    } catch {
      // A missing or replacement lock belongs to no release action here.
    }
  };
}
