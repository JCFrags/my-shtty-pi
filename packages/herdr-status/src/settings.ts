import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { applySidebarLayout, type AppliedSidebarLayout, type HerdrLayoutOptions } from "./sidebar-config.ts";
import { DEFAULT_SETTINGS, type ProfileId, type SidebarSettings } from "./settings-types.ts";

const SETTINGS_FILE = "herdr-sidebar-settings.json";
const LEGACY_FILE = "title-animation.json";
const PROFILES = new Set<ProfileId>([
  "smart", "minimal", "arcade", "cosmic", "playful", "terminal", "context", "surprise", "still",
]);

interface SettingsDocument {
  settings: SidebarSettings;
  previous?: SidebarSettings;
}

export interface SettingsReadResult {
  settings: SidebarSettings;
  revision: string;
  warning?: string;
}

export interface SettingsSaveOptions {
  herdr?: HerdrLayoutOptions;
}

export interface SettingsSaveResult {
  revision: string;
  warning?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the complete versioned shape. Missing and unknown fields are errors. */
export function validateSettings(value: unknown): SidebarSettings {
  if (!record(value) || Object.keys(value).length !== Object.keys(DEFAULT_SETTINGS).length) {
    throw new Error("Sidebar settings must contain exactly the version 1 fields.");
  }
  for (const [key, expected] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== typeof expected) {
      throw new Error(`Invalid sidebar setting: ${key}.`);
    }
  }
  if (value.version !== 1 ||
      (value.modelName !== "short" && value.modelName !== "full") ||
      (value.idle !== "ready" && value.idle !== "hidden") ||
      !PROFILES.has(value.animation as ProfileId)) {
    throw new Error("Sidebar settings contain an unsupported version or option.");
  }
  return { ...value } as unknown as SidebarSettings;
}

function parseDocument(bytes: Buffer): SettingsDocument {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!record(value) || !Object.hasOwn(value, "settings") ||
      Object.keys(value).some((key) => key !== "settings" && key !== "previous")) {
    throw new Error("Invalid sidebar settings document.");
  }
  return {
    settings: validateSettings(value.settings),
    ...(Object.hasOwn(value, "previous") ? { previous: validateSettings(value.previous) } : {}),
  };
}

function readOptional(path: string): Buffer | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Settings must be a regular file, not a symbolic link.");
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function digest(bytes: Buffer | undefined): string {
  return bytes === undefined ? "missing" : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function importLegacy(bytes: Buffer | undefined): { settings: SidebarSettings; warning?: string } {
  const settings = { ...DEFAULT_SETTINGS };
  if (bytes === undefined) return { settings };
  try {
    const legacy: unknown = JSON.parse(bytes.toString("utf8"));
    if (!record(legacy) || typeof legacy.profile !== "string" || !PROFILES.has(legacy.profile as ProfileId)) {
      throw new Error("Invalid legacy profile.");
    }
    settings.animation = legacy.profile as ProfileId;
    return { settings };
  } catch {
    return {
      settings,
      warning: "title-animation.json has an invalid profile. Defaults are shown. The legacy file has not been changed.",
    };
  }
}

function currentRevision(agentDir: string, bytes: Buffer | undefined): string {
  // Include legacy bytes while they are the source, so an old profile menu cannot be lost silently.
  return bytes === undefined
    ? `missing:${digest(readOptional(join(agentDir, LEGACY_FILE)))}`
    : digest(bytes);
}

export function readSettings(agentDir: string): SettingsReadResult {
  let bytes: Buffer | undefined;
  try {
    bytes = readOptional(join(agentDir, SETTINGS_FILE));
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      revision: "unreadable",
      warning: "herdr-sidebar-settings.json cannot be read. Defaults are shown. Saving is disabled until the file is repaired.",
    };
  }
  if (bytes === undefined) {
    try {
      const legacy = readOptional(join(agentDir, LEGACY_FILE));
      return { ...importLegacy(legacy), revision: `missing:${digest(legacy)}` };
    } catch {
      return {
        settings: { ...DEFAULT_SETTINGS },
        revision: "legacy-unreadable",
        warning: "title-animation.json cannot be read. Saving is disabled until the legacy preference can be read.",
      };
    }
  }
  try {
    return { settings: parseDocument(bytes).settings, revision: digest(bytes) };
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      revision: digest(bytes),
      warning: "herdr-sidebar-settings.json is invalid. Defaults are shown. Saving is disabled until the file is repaired. No preferences were overwritten.",
    };
  }
}

export function readPreviousSettings(agentDir: string): SidebarSettings | undefined {
  try {
    const bytes = readOptional(join(agentDir, SETTINGS_FILE));
    return bytes === undefined ? undefined : parseDocument(bytes).previous;
  } catch {
    return undefined;
  }
}

function writePrivate(path: string, bytes: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeTemporary(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertRevision(agentDir: string, expectedRevision: string): void {
  const bytes = readOptional(join(agentDir, SETTINGS_FILE));
  if (currentRevision(agentDir, bytes) !== expectedRevision) {
    throw new Error("Sidebar settings changed in another pane or editor. Reopen the menu and retry. No newer settings were overwritten.");
  }
}

/** Save explicitly. Reading settings never creates files or changes Herdr. */
export async function saveSettings(
  agentDir: string,
  settings: SidebarSettings,
  expectedRevision: string,
  options: SettingsSaveOptions = {},
): Promise<SettingsSaveResult> {
  const validated = validateSettings(settings);
  const path = join(agentDir, SETTINGS_FILE);
  const lock = `${path}.lock`;
  const staged = join(agentDir, `.herdr-sidebar-settings-${randomUUID()}.json`);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  try {
    writePrivate(lock, `${process.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another sidebar settings save is in progress. If that process stopped, inspect the stale lock at ${lock}.`);
    }
    throw error;
  }
  let applied: AppliedSidebarLayout | undefined;
  try {
    const original = readOptional(path);
    if (currentRevision(agentDir, original) !== expectedRevision) {
      throw new Error("Sidebar settings changed in another pane or editor. Reopen the menu and retry.");
    }
    let previous: SidebarSettings;
    let warning: string | undefined;
    if (original === undefined) {
      const legacy = importLegacy(readOptional(join(agentDir, LEGACY_FILE)));
      previous = legacy.settings;
      warning = legacy.warning;
    } else {
      try {
        previous = parseDocument(original).settings;
      } catch {
        throw new Error("herdr-sidebar-settings.json is invalid. Repair it before saving. The file was not overwritten.");
      }
    }
    const content = `${JSON.stringify({ settings: validated, previous } satisfies SettingsDocument, null, 2)}\n`;
    writePrivate(staged, content);
    assertRevision(agentDir, expectedRevision);
    if (options.herdr) applied = await applySidebarLayout(validated, options.herdr);
    // Keep the comparison and rename synchronous. Cooperative writers also hold this lock.
    assertRevision(agentDir, expectedRevision);
    renameSync(staged, path);
    return { revision: digest(Buffer.from(content)), ...(warning ? { warning } : {}) };
  } catch (error) {
    if (applied) {
      try {
        await applied.rollback();
      } catch (rollbackError) {
        const reason = rollbackError instanceof Error ? rollbackError.message : "Config rollback failed.";
        throw new Error(`Sidebar settings were not saved. ${reason}${applied.backupPath ? ` Backup: ${applied.backupPath}.` : ""}`, { cause: error });
      }
    }
    const reason = error instanceof Error ? error.message : "The save failed.";
    throw new Error(`Sidebar settings were not saved. ${reason}`, { cause: error });
  } finally {
    removeTemporary(staged);
    removeTemporary(lock);
  }
}
