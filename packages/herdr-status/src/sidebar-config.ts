import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runBoundedProcess } from "./herdr-client.ts";
import type { SidebarSettings } from "./settings-types.ts";

export interface HerdrLayoutOptions {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
}

export interface AppliedSidebarLayout {
  configPath: string;
  backupPath?: string;
  /** Restore only this operation's Pi entry, provided that entry is unchanged. */
  rollback(): Promise<void>;
}

const TABLE = ["ui", "sidebar", "agents", "rows_by_agent"];
const PROCESS_OPTIONS = { timeoutMs: 1_500, outputLimitBytes: 4_096 };

export function buildSidebarRows(settings: SidebarSettings): string[][] {
  const rows: string[][] = [["state_icon", "agent", "state_text"]];
  if (settings.model || settings.context) rows.push(["$model_context"]);
  const details: string[] = [];
  if (settings.changedFiles) details.push("$changed_files");
  if (settings.turns) details.push("$turn");
  if (details.length) rows.push(details);
  if (settings.activity) rows.push(["terminal_title"]);
  const location = (["machine", "workspace", "tab", "pane"] as const)
    .filter((token) => settings[token]);
  if (location.length) rows.push(location);
  return rows;
}

function formatRows(settings: SidebarSettings, newline: string): string {
  const rows = buildSidebarRows(settings).map((row) => `  [${row.map((token) => JSON.stringify(token)).join(", ")}]`);
  return `[${newline}${rows.join(`,${newline}`)}${newline}]`;
}

interface Entry {
  start: number;
  valueStart: number;
  valueEnd: number;
  end: number;
}

interface PiLocation {
  table?: { end: number };
  entry?: Entry;
}

function unsupported(): never {
  throw new Error("Unsupported or ambiguous Herdr TOML. Use one explicit [ui.sidebar.agents.rows_by_agent] table and a plain or quoted pi key.");
}

function horizontal(text: string, offset: number): number {
  while (text[offset] === " " || text[offset] === "\t" || text[offset] === "\r") offset++;
  return offset;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end + 1;
}

/** Skip TOML strings, including multiline strings and escaped delimiters. */
function stringEnd(text: string, start: number, multiline = true): number {
  const quote = text[start]!;
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  if (triple && !multiline) unsupported();
  let offset = start + (triple ? 3 : 1);
  while (offset < text.length) {
    if (quote === '"' && text[offset] === "\\") {
      offset += 2;
      continue;
    }
    if (text[offset] === quote) {
      if (!triple) return offset + 1;
      if (text.slice(offset, offset + 3) === quote.repeat(3)) {
        offset += 3;
        // TOML permits one or two quote characters before the closing delimiter.
        for (let extra = 0; extra < 2 && text[offset] === quote; extra++) offset++;
        return offset;
      }
    }
    if (!triple && text[offset] === "\n") unsupported();
    offset++;
  }
  return unsupported();
}

function decodeKey(raw: string): string {
  if (raw[0] === "'") return raw.slice(1, -1);
  if (raw[0] !== '"') return raw;
  const body = raw.slice(1, -1);
  let decoded = "";
  for (let offset = 0; offset < body.length; offset++) {
    const char = body[offset]!;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const escape = body[++offset];
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (escape && Object.hasOwn(simple, escape)) {
      decoded += simple[escape];
    } else if (escape === "u" || escape === "U") {
      const count = escape === "u" ? 4 : 8;
      const digits = body.slice(offset + 1, offset + 1 + count);
      if (digits.length !== count || !/^[a-fA-F0-9]+$/.test(digits)) unsupported();
      const code = Number.parseInt(digits, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) unsupported();
      decoded += String.fromCodePoint(code);
      offset += count;
    } else {
      unsupported();
    }
  }
  return decoded;
}

function keyPath(text: string): string[] {
  const keys: string[] = [];
  let offset = horizontal(text, 0);
  while (offset < text.length) {
    const start = offset;
    if (text[offset] === '"' || text[offset] === "'") {
      offset = stringEnd(text, offset, false);
    } else {
      while (offset < text.length && /[A-Za-z0-9_-]/.test(text[offset]!)) offset++;
      if (offset === start) unsupported();
    }
    keys.push(decodeKey(text.slice(start, offset)));
    offset = horizontal(text, offset);
    if (offset === text.length) return keys;
    if (text[offset] !== ".") unsupported();
    offset = horizontal(text, offset + 1);
    if (offset === text.length) unsupported();
  }
  return unsupported();
}

function prefix(first: readonly string[], second: readonly string[]): boolean {
  return first.length <= second.length && first.every((key, index) => key === second[index]);
}

function samePath(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && prefix(first, second);
}

/** Find statement boundaries without interpreting or rewriting unrelated values. */
function locatePi(text: string): PiLocation {
  const location: PiLocation = {};
  let table: string[] = [];
  let offset = text[0] === "\uFEFF" ? 1 : 0;
  while (offset < text.length) {
    const statementStart = offset;
    offset = horizontal(text, offset);
    if (text[offset] === "\n" || text[offset] === "#") {
      offset = lineEnd(text, offset);
      continue;
    }
    if (offset === text.length) break;
    if (text[offset] === "[") {
      const array = text[offset + 1] === "[";
      const keyStart = offset + (array ? 2 : 1);
      offset = keyStart;
      while (offset < text.length && text[offset] !== "]") {
        if (text[offset] === '"' || text[offset] === "'") offset = stringEnd(text, offset, false);
        else if (text[offset] === "\n" || text[offset] === "#") unsupported();
        else offset++;
      }
      if (offset === text.length || (array && text[offset + 1] !== "]")) unsupported();
      table = keyPath(text.slice(keyStart, offset));
      offset = horizontal(text, offset + (array ? 2 : 1));
      if (offset < text.length && text[offset] !== "\n" && text[offset] !== "#") unsupported();
      offset = lineEnd(text, offset);
      if ((array && prefix(table, TABLE)) || (prefix(TABLE, table) && !samePath(TABLE, table))) unsupported();
      if (samePath(table, TABLE)) {
        if (array || location.table) unsupported();
        location.table = { end: offset };
      }
      continue;
    }

    const keyStart = offset;
    while (offset < text.length && text[offset] !== "=") {
      if (text[offset] === '"' || text[offset] === "'") offset = stringEnd(text, offset, false);
      else if (text[offset] === "\n" || text[offset] === "#") unsupported();
      else offset++;
    }
    if (offset === text.length) unsupported();
    const key = keyPath(text.slice(keyStart, offset));
    const absoluteKey = [...table, ...key];
    const ownedKey = [...TABLE, "pi"];
    if (prefix(absoluteKey, TABLE)) unsupported(); // An ancestor is an inline table or scalar.
    const isPi = samePath(absoluteKey, ownedKey);
    if (prefix(ownedKey, absoluteKey) && (!isPi || !samePath(table, TABLE) || key.length !== 1)) unsupported();
    offset = horizontal(text, offset + 1);
    const valueStart = offset;
    const stack: string[] = [];
    let valueEnd = offset;
    while (offset < text.length) {
      const char = text[offset];
      if (char === '"' || char === "'") {
        offset = stringEnd(text, offset);
        valueEnd = offset;
        continue;
      }
      if (char === "#") {
        if (!stack.length) break;
        offset = lineEnd(text, offset);
        continue;
      }
      if (char === "\n" && !stack.length) break;
      if (char === "[" || char === "{") stack.push(char === "[" ? "]" : "}");
      else if (char === "]" || char === "}") {
        if (stack.pop() !== char) unsupported();
      }
      if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") valueEnd = offset + 1;
      offset++;
    }
    if (stack.length || valueEnd === valueStart) unsupported();
    offset = lineEnd(text, offset);
    if (isPi) {
      if (location.entry || text[valueStart] !== "[" || text[valueEnd - 1] !== "]") unsupported();
      location.entry = { start: statementStart, valueStart, valueEnd, end: offset };
    }
  }
  return location;
}

export function patchPiRows(toml: string, settings: SidebarSettings): string {
  const location = locatePi(toml);
  const newline = toml.includes("\r\n") ? "\r\n" : "\n";
  const value = formatRows(settings, newline);
  if (location.entry) {
    return toml.slice(0, location.entry.valueStart) + value + toml.slice(location.entry.valueEnd);
  }
  if (location.table) {
    const index = location.table.end;
    const separator = index && toml[index - 1] !== "\n" ? newline : "";
    return toml.slice(0, index) + `${separator}pi = ${value}${newline}` + toml.slice(index);
  }
  const separator = !toml.length ? "" : toml.endsWith("\n") ? newline : newline + newline;
  return `${toml}${separator}[${TABLE.join(".")}]${newline}pi = ${value}${newline}`;
}

function undoPiRows(current: string, original: string, applied: string): string {
  if (current === applied) return original;
  const now = locatePi(current);
  const before = locatePi(original);
  const after = locatePi(applied);
  if (!now.entry || !after.entry ||
      current.slice(now.entry.valueStart, now.entry.valueEnd) !== applied.slice(after.entry.valueStart, after.entry.valueEnd)) {
    throw new Error("The Pi sidebar entry changed after this save. It was not overwritten. Restore that entry from the backup, then run herdr server reload-config.");
  }
  if (before.entry) {
    return current.slice(0, now.entry.valueStart) + original.slice(before.entry.valueStart, before.entry.valueEnd) + current.slice(now.entry.valueEnd);
  }
  // Keep newer comments. An empty table is harmless and may have new neighboring entries.
  const suffix = current.slice(now.entry.valueEnd, now.entry.end);
  const addedComment = suffix === applied.slice(after.entry.valueEnd, after.entry.end) ? "" : suffix;
  return current.slice(0, now.entry.start) + addedComment + current.slice(now.entry.end);
}

function configPath(environment: NodeJS.ProcessEnv): string {
  if (environment.HERDR_CONFIG_PATH !== undefined) {
    if (!environment.HERDR_CONFIG_PATH.trim()) throw new Error("HERDR_CONFIG_PATH is empty.");
    return resolve(environment.HERDR_CONFIG_PATH);
  }
  return resolve(environment.XDG_CONFIG_HOME !== undefined
    ? join(environment.XDG_CONFIG_HOME, "herdr", "config.toml")
    : join(environment.HOME || homedir(), ".config", "herdr", "config.toml"));
}

function snapshot(path: string): { bytes: Buffer; mode: number } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Herdr config must be an existing regular file, not a symbolic link.");
  return { bytes: readFileSync(path), mode: stat.mode & 0o777 };
}

function writePrivate(path: string, bytes: Buffer | string): void {
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

function acquireLock(path: string): () => void {
  try { writePrivate(path, `${process.pid}\n`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another sidebar config save is in progress. If that process stopped, inspect the stale lock at ${path}.`);
    }
    throw error;
  }
  return () => removeTemporary(path);
}

async function validate(path: string, options: HerdrLayoutOptions): Promise<void> {
  await runBoundedProcess(options.binaryPath, ["config", "check"], {
    ...PROCESS_OPTIONS,
    environment: { ...options.environment, HERDR_CONFIG_PATH: path },
  });
}

async function reload(options: HerdrLayoutOptions): Promise<void> {
  await runBoundedProcess(options.binaryPath, ["server", "reload-config"], {
    ...PROCESS_OPTIONS,
    environment: options.environment,
  });
}

function replaceUnchanged(path: string, staged: string, expected: Buffer, mode: number): void {
  chmodSync(staged, mode);
  if (!snapshot(path).bytes.equals(expected)) throw new Error("Herdr config changed during this save. Nothing was overwritten. Reopen sidebar settings and retry.");
  renameSync(staged, path);
}

async function restore(
  path: string,
  original: string,
  applied: string,
  options: HerdrLayoutOptions,
): Promise<void> {
  const current = snapshot(path);
  const candidate = undoPiRows(current.bytes.toString("utf8"), original, applied);
  const staged = join(dirname(path), `.pi-sidebar-restore-${randomUUID()}.toml`);
  try {
    writePrivate(staged, candidate);
    await validate(staged, options);
    replaceUnchanged(path, staged, current.bytes, current.mode);
    try {
      await reload(options);
    } catch {
      throw new Error("The saved Pi config entry was restored, but the rollback reload failed. Run herdr server reload-config when the server is available.");
    }
  } finally {
    removeTemporary(staged);
  }
}

/** Apply only the global Pi row override. This never starts or restarts Herdr. */
export async function applySidebarLayout(
  settings: SidebarSettings,
  herdrOptions: HerdrLayoutOptions,
): Promise<AppliedSidebarLayout> {
  const options = { ...herdrOptions, environment: { ...herdrOptions.environment } };
  if (options.environment.HERDR_ENV !== "1") throw new Error("Applying a Herdr layout requires HERDR_ENV=1.");
  const path = configPath(options.environment);
  const unlock = acquireLock(`${path}.pi-sidebar.lock`);
  const staged = join(dirname(path), `.pi-sidebar-candidate-${randomUUID()}.toml`);
  let backupPath: string | undefined;
  try {
    const original = snapshot(path);
    const text = original.bytes.toString("utf8");
    if (!Buffer.from(text).equals(original.bytes)) throw new Error("Herdr config is not valid UTF-8.");
    const candidate = patchPiRows(text, settings);
    writePrivate(staged, candidate);
    await validate(staged, options);
    const changed = candidate !== text;
    if (changed) {
      backupPath = `${path}.pi-sidebar-backup-${randomUUID()}`;
      writePrivate(backupPath, original.bytes);
      replaceUnchanged(path, staged, original.bytes, original.mode);
    } else if (!snapshot(path).bytes.equals(original.bytes)) {
      throw new Error("Herdr config changed during validation. Reopen sidebar settings and retry.");
    }
    try {
      await reload(options);
    } catch (error) {
      let repair = "No config bytes changed.";
      if (changed) {
        try {
          await restore(path, text, candidate, options);
          repair = "The previous Pi config entry was restored and reloaded.";
        } catch (rollbackError) {
          repair = rollbackError instanceof Error ? rollbackError.message : "Config rollback failed.";
        }
      }
      throw new Error(`Herdr layout reload failed. ${repair}${backupPath ? ` Backup: ${backupPath}.` : ""}`, { cause: error });
    }
    let rolledBack = false;
    return {
      configPath: path,
      ...(backupPath ? { backupPath } : {}),
      rollback: async () => {
        if (rolledBack || !changed) return;
        const release = acquireLock(`${path}.pi-sidebar.lock`);
        try {
          await restore(path, text, candidate, options);
          rolledBack = true;
        } finally {
          release();
        }
      },
    };
  } finally {
    removeTemporary(staged);
    unlock();
  }
}
