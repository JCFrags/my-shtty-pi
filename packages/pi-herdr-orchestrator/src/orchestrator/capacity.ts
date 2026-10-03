import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CapacitySettings = { total: number; perTab: number };
export const DEFAULT_CAPACITY: Readonly<CapacitySettings> = Object.freeze({ total: 8, perTab: 4 });
export const MAX_CAPACITY = 32;
export const CAPACITY_SETTINGS_FILENAME = "pi-herdr-orchestrator.json";
const MAX_SETTINGS_BYTES = 16 * 1024;

export class CapacitySettingsError extends Error {
  constructor(readonly code:
    "CAPACITY_SETTINGS_INVALID" | "CAPACITY_SETTINGS_UNREADABLE" |
    "CAPACITY_SETTINGS_CHANGED" | "CAPACITY_SETTINGS_BUSY" | "CAPACITY_SETTINGS_WRITE_FAILED") {
    super(code);
    this.name = "CapacitySettingsError";
  }
}

export interface CapacitySnapshot {
  readonly path: string;
  readonly revision: string | null;
  readonly settings: Readonly<CapacitySettings>;
}

/** Pi 0.85/0.99 expose the environment/default directory, not an SDK agentDir override. */
export function capacitySettingsPath(): string {
  // SDK hosts must align PI_CODING_AGENT_DIR with agentDir. Do not infer it from a
  // project or session path: either can use storage outside the agent directory.
  return resolve(getAgentDir(), CAPACITY_SETTINGS_FILENAME);
}

function validLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CAPACITY;
}

function validateSettings(settings: CapacitySettings): void {
  if (!validLimit(settings.total) || !validLimit(settings.perTab))
    throw new CapacitySettingsError("CAPACITY_SETTINGS_INVALID");
}

function parseSettings(raw: string): CapacitySettings {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new CapacitySettingsError("CAPACITY_SETTINGS_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CapacitySettingsError("CAPACITY_SETTINGS_INVALID");
  const document = value as Record<string, unknown>;
  if (Object.keys(document).length !== 3 || document.version !== 1 ||
    !validLimit(document.total) || !validLimit(document.perTab))
    throw new CapacitySettingsError("CAPACITY_SETTINGS_INVALID");
  return { total: document.total, perTab: document.perTab };
}

async function readSnapshot(path: string): Promise<CapacitySnapshot> {
  let file;
  try {
    // Refuse symlinks and non-files instead of treating a broken target as absence.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, revision: null, settings: { ...DEFAULT_CAPACITY } };
    throw new CapacitySettingsError("CAPACITY_SETTINGS_UNREADABLE");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new CapacitySettingsError("CAPACITY_SETTINGS_UNREADABLE");
    if (stat.size > MAX_SETTINGS_BYTES) throw new CapacitySettingsError("CAPACITY_SETTINGS_INVALID");
    const bytes = await file.readFile();
    if (bytes.length > MAX_SETTINGS_BYTES) throw new CapacitySettingsError("CAPACITY_SETTINGS_INVALID");
    const settings = parseSettings(bytes.toString("utf8"));
    return { path, revision: createHash("sha256").update(bytes).digest("hex"), settings };
  } catch (error) {
    if (error instanceof CapacitySettingsError) throw error;
    throw new CapacitySettingsError("CAPACITY_SETTINGS_UNREADABLE");
  } finally {
    try { await file.close(); }
    catch { throw new CapacitySettingsError("CAPACITY_SETTINGS_UNREADABLE"); }
  }
}

export async function readCapacitySnapshot(): Promise<CapacitySnapshot> {
  return readSnapshot(capacitySettingsPath());
}

/** Read the current preferences on every admission. Absence does not create a file. */
export async function readCapacitySettings(): Promise<CapacitySettings> {
  return { ...(await readCapacitySnapshot()).settings };
}

/** Save only the draft based on this exact file snapshot and agent directory. */
export async function saveCapacitySettings(settings: CapacitySettings, expected: CapacitySnapshot): Promise<void> {
  validateSettings(settings);
  const path = capacitySettingsPath();
  if (path !== expected.path) throw new CapacitySettingsError("CAPACITY_SETTINGS_CHANGED");
  const directory = dirname(path);
  const lockPath = `${path}.lock`;
  const tempPath = join(directory, `.${CAPACITY_SETTINGS_FILENAME}.${randomUUID()}.tmp`);
  let lock;
  let temporary = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Serialize cooperating parent saves. Never delete or steal another writer's lock.
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new CapacitySettingsError("CAPACITY_SETTINGS_BUSY");
      throw error;
    }
    const current = await readSnapshot(path);
    if (current.revision !== expected.revision)
      throw new CapacitySettingsError("CAPACITY_SETTINGS_CHANGED");
    const file = await open(tempPath, "wx", 0o600);
    temporary = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify({ version: 1, total: settings.total, perTab: settings.perTab }, null, 2)}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
    // Also detect an edit made outside this writer's lock while preparing the file.
    if (capacitySettingsPath() !== path || (await readSnapshot(path)).revision !== expected.revision)
      throw new CapacitySettingsError("CAPACITY_SETTINGS_CHANGED");
    await rename(tempPath, path);
    temporary = false;
  } catch (error) {
    if (error instanceof CapacitySettingsError) throw error;
    throw new CapacitySettingsError("CAPACITY_SETTINGS_WRITE_FAILED");
  } finally {
    if (temporary) await unlink(tempPath).catch(() => undefined);
    if (lock) {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
