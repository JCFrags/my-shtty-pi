import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { BrowserOwner } from "pixel-store";

export const TAB_RECOVERY_LIMITS = Object.freeze({
  tabs: 32,
  urlChars: 2048,
  fileBytes: 98304,
  lifetimeMs: 2592000000,
} as const);

export type TabRecoveryExclusion =
  | "non-web" | "invalid-url" | "control-character" | "malformed-encoding"
  | "userinfo" | "sensitive-route" | "auth-marker" | "token-path" | "url-too-long";
export type TabRecoveryEntry =
  | { kind: "url"; url: string }
  | { kind: "excluded"; url: "about:blank"; reason: TabRecoveryExclusion };
export interface TabRecoveryTabs {
  entries: TabRecoveryEntry[];
  activeIndex: number | null;
}
export interface TabRecoverySnapshot extends TabRecoveryTabs {
  schemaVersion: 1;
  key: string;
  savedAt: number;
}
export interface TabRecoveryIdentity {
  owner: BrowserOwner | null;
  projectRoot: string | null;
  profileDir: string;
  partition: string | null;
}
export type TabRecoveryFailure =
  | "unowned" | "invalid-identity" | "missing" | "unsafe" | "too-large"
  | "invalid" | "expired" | "wrong-key" | "unknown-version" | "io-error";
export type TabRecoveryLoadResult =
  | { status: "ready"; snapshot: TabRecoverySnapshot }
  | { status: TabRecoveryFailure; snapshot: null };
export type TabRecoveryWriteStatus =
  | "saved" | "unowned" | "invalid-identity" | "unsafe" | "too-large" | "invalid" | "io-error";
export type TabRecoveryClearStatus =
  | "cleared" | "missing" | "unowned" | "invalid-identity" | "unsafe" | "io-error";

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const OWNER_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const EXCLUSIONS = new Set<TabRecoveryExclusion>([
  "non-web", "invalid-url", "control-character", "malformed-encoding", "userinfo",
  "sensitive-route", "auth-marker", "token-path", "url-too-long",
]);
const AUTH_KEYS = new Set([
  "code", "state", "idtoken", "accesstoken", "refreshtoken", "token", "sessionstate",
  "samlresponse", "samlrequest", "relaystate", "clientid", "redirecturi", "responsetype",
  "codechallenge", "codechallengemethod", "codeverifier", "nonce", "scope",
]);
const SENSITIVE_SEGMENTS = new Set([
  "auth", "authenticate", "authentication", "authorize", "authorization", "login", "logon",
  "signin", "signon", "signout", "logout", "oauth", "oauth2", "oidc", "saml", "sso",
  "callback", "callbacks", "signinoidc", "password", "passwordreset",
  "resetpassword", "forgotpassword", "reset", "recover", "recovery", "verify", "verification",
  "activate", "activation", "invite", "invites", "invitation", "invitations", "magiclink",
  "logincomplete", "logincompletion",
]);

function excluded(reason: TabRecoveryExclusion): TabRecoveryEntry {
  return { kind: "excluded", url: "about:blank", reason };
}

function marker(value: string): string {
  return value.toLowerCase().replace(/[-_.]/g, "");
}

function hasAuthMarker(value: string): boolean {
  return [value, decodeURIComponent(value)].some(candidate => candidate.split(/[?&;]/).some(part => {
    const key = decodeURIComponent(part.split("=", 1)[0].replace(/\+/g, " "));
    return AUTH_KEYS.has(marker(key));
  }));
}

function tokenSegment(segment: string): boolean {
  if (/^[a-f0-9]{32,}$/i.test(segment)) return true;
  if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(segment)) return true;
  if (/^[A-Za-z0-9]{32,}$/.test(segment)) return true;
  if (/^[A-Za-z0-9_+=-]{32,}$/.test(segment) && /[A-Z0-9_+=]/.test(segment)) return true;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segment) && segment.length >= 32;
}

function pathExclusion(route: string): TabRecoveryExclusion | null {
  // Inspect decoded segments before URL normalization can remove dot segments.
  for (const segment of decodeURIComponent(route).split(/[\/\\;]/)) {
    if (SENSITIVE_SEGMENTS.has(marker(segment)) || segment.split(/[-_.]/).some(part => SENSITIVE_SEGMENTS.has(marker(part)))) return "sensitive-route";
    if (segment.split(/[=:]/).some(tokenSegment)) return "token-path";
  }
  return null;
}

/** Conservative URL heuristics, not a complete secret scanner or read-only navigation guarantee. */
export function sanitizeTabRecoveryUrl(value: unknown): TabRecoveryEntry {
  if (typeof value !== "string" || !value) return excluded("invalid-url");
  if (CONTROLS.test(value)) return excluded("control-character");
  if (value.length > TAB_RECOVERY_LIMITS.urlChars) return excluded("url-too-long");
  let decoded: string;
  try {
    encodeURI(value); // Refuse lone surrogates rather than normalize them silently.
    decoded = decodeURIComponent(value);
  } catch { return excluded("malformed-encoding"); }
  if (CONTROLS.test(decoded)) return excluded("control-character");
  if (!/^https?:/i.test(value)) return excluded("non-web");
  if (!/^https?:\/\//i.test(value) || /\s|\\/.test(value)) return excluded("invalid-url");
  const authority = value.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
  if (!authority) return excluded("invalid-url");
  if (authority.includes("@")) return excluded("userinfo");
  let parsed: URL;
  try { parsed = new URL(value); } catch { return excluded("invalid-url"); }
  if (parsed.username || parsed.password) return excluded("userinfo");
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) return excluded("invalid-url");
  try {
    const fragment = parsed.hash.slice(1);
    if (hasAuthMarker(parsed.search.slice(1)) || hasAuthMarker(fragment)) return excluded("auth-marker");
    const rawRoute = value.replace(/^https?:\/\/[^/?#]*/i, "").split(/[?#]/, 1)[0];
    const reason = pathExclusion(rawRoute) ?? pathExclusion(parsed.pathname) ?? pathExclusion(fragment.split("?", 1)[0]);
    if (reason) return excluded(reason);
    let hash = "";
    if (fragment.startsWith("/")) {
      const route = fragment.split("?", 1)[0];
      const hashReason = pathExclusion(route);
      if (hashReason) return excluded(hashReason);
      // Do not allow another fragment or encoded separators to change the retained route.
      if (/[?#\\]/.test(decodeURIComponent(route))) return excluded("invalid-url");
      hash = `#${route}`;
    }
    const url = `${parsed.origin}${parsed.pathname}${hash}`;
    if (url.length > TAB_RECOVERY_LIMITS.urlChars) return excluded("url-too-long");
    return { kind: "url", url };
  } catch { return excluded("malformed-encoding"); }
}

function canonicalDirectory(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || CONTROLS.test(value)) throw new Error("invalid recovery identity");
  const directory = fs.realpathSync(value);
  if (!fs.statSync(directory).isDirectory()) throw new Error("invalid recovery identity");
  return directory;
}

/** The digest includes physical profile identity, never a release path or runtime instance ID. */
export function tabRecoveryKey(identity: TabRecoveryIdentity): string | null {
  try {
    const owner = identity.owner;
    if (!owner || ![owner.workspaceId, owner.tabId, owner.paneId].every(id => typeof id === "string" && OWNER_ID.test(id))) return null;
    if (owner.sessionId !== null && (typeof owner.sessionId !== "string" || !owner.sessionId || owner.sessionId.length > 512 || CONTROLS.test(owner.sessionId))) return null;
    const project = canonicalDirectory(identity.projectRoot);
    if (canonicalDirectory(owner.projectDir) !== project) return null;
    const profile = canonicalDirectory(identity.profileDir);
    const partition = identity.partition;
    if (partition !== null && (typeof partition !== "string" || partition.length > 512 || CONTROLS.test(partition))) return null;
    const effectivePartition = partition ? ["persistent", partition.startsWith("persist:") ? partition : `persist:${partition}`] : ["default"];
    const tuple = [1, [owner.workspaceId, owner.tabId, owner.paneId, owner.sessionId], project, profile, effectivePartition];
    return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
  } catch { return null; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(",") === expected.sort().join(",");
}

function validEntry(value: unknown): value is TabRecoveryEntry {
  if (!object(value)) return false;
  if (value.kind === "excluded") return keys(value, ["kind", "url", "reason"]) && value.url === "about:blank" && EXCLUSIONS.has(value.reason as TabRecoveryExclusion);
  if (value.kind !== "url" || !keys(value, ["kind", "url"]) || typeof value.url !== "string") return false;
  const sanitized = sanitizeTabRecoveryUrl(value.url);
  return sanitized.kind === "url" && sanitized.url === value.url;
}

function validTabs(value: unknown): value is TabRecoveryTabs {
  if (!object(value) || !keys(value, ["entries", "activeIndex"]) || !Array.isArray(value.entries) || value.entries.length > TAB_RECOVERY_LIMITS.tabs || !value.entries.every(validEntry)) return false;
  return value.entries.length === 0 ? value.activeIndex === null : Number.isSafeInteger(value.activeIndex) && (value.activeIndex as number) >= 0 && (value.activeIndex as number) < value.entries.length;
}

class StorageError extends Error {
  constructor(readonly status: "unsafe" | "too-large" | "invalid") { super("tab recovery storage refused"); }
}

function failure(error: unknown): "unsafe" | "too-large" | "invalid" | "missing" | "io-error" {
  if (error instanceof StorageError) return error.status;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "missing";
  if (code === "ELOOP" || code === "ENOTDIR") return "unsafe";
  return "io-error";
}

function close(descriptor: number | undefined): void {
  if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
}

function sync(descriptor: number): void {
  try { fs.fsyncSync(descriptor); }
  catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function privateFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) throw new StorageError("unsafe");
}

/** Synchronous I/O serializes writes in the daemon thread. Construction/load never save. */
export class TabRecoveryStore {
  readonly key: string | null;
  private readonly directory: string;
  private readonly disabled: "unowned" | "invalid-identity" | null;

  constructor(options: TabRecoveryIdentity & { directory: string }) {
    this.key = tabRecoveryKey(options);
    this.directory = options.directory;
    this.disabled = !options.owner ? "unowned" : this.key === null ? "invalid-identity" : null;
  }

  private filename(): string { return path.join(this.directory, `${this.key}.json`); }

  private checkDirectory(create: boolean): void {
    if (typeof process.getuid?.() !== "number" || !path.isAbsolute(this.directory) || path.resolve(this.directory) !== this.directory || CONTROLS.test(this.directory)) throw new StorageError("unsafe");
    let current = path.parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(current, { mode: 0o700 });
        stat = fs.lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw new StorageError("unsafe");
      if (current === this.directory && (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700)) throw new StorageError("unsafe");
    }
  }

  private openDirectory(create: boolean): number {
    this.checkDirectory(create);
    const descriptor = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { this.checkCurrentDirectory(descriptor); return descriptor; }
    catch (error) { close(descriptor); throw error; }
  }

  private checkCurrentDirectory(descriptor: number): void {
    this.checkDirectory(false);
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(this.directory);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new StorageError("unsafe");
  }

  private checkTarget(): void {
    try { privateFile(fs.lstatSync(this.filename())); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  load(): TabRecoveryLoadResult {
    if (this.disabled) return { status: this.disabled, snapshot: null };
    let directory: number | undefined;
    let descriptor: number | undefined;
    try {
      directory = this.openDirectory(false);
      descriptor = fs.openSync(this.filename(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      privateFile(stat);
      if (stat.size > TAB_RECOVERY_LIMITS.fileBytes) throw new StorageError("too-large");
      const bytes = Buffer.alloc(TAB_RECOVERY_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = fs.readSync(descriptor, bytes, length, bytes.length - length, length);
        if (!read) break;
        length += read;
      }
      if (length > TAB_RECOVERY_LIMITS.fileBytes) throw new StorageError("too-large");
      const after = fs.fstatSync(descriptor);
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new StorageError("invalid");
      this.checkCurrentDirectory(directory);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { return { status: "invalid", snapshot: null }; }
      if (!object(value) || !keys(value, ["schemaVersion", "key", "savedAt", "entries", "activeIndex"])) return { status: "invalid", snapshot: null };
      if (value.schemaVersion !== 1) return { status: "unknown-version", snapshot: null };
      if (typeof value.key !== "string" || !/^[a-f0-9]{64}$/.test(value.key)) return { status: "invalid", snapshot: null };
      if (value.key !== this.key) return { status: "wrong-key", snapshot: null };
      if (!Number.isSafeInteger(value.savedAt) || (value.savedAt as number) < 0 || (value.savedAt as number) > Date.now()) return { status: "invalid", snapshot: null };
      if (Date.now() - (value.savedAt as number) > TAB_RECOVERY_LIMITS.lifetimeMs) return { status: "expired", snapshot: null };
      if (Array.isArray(value.entries) && value.entries.length > TAB_RECOVERY_LIMITS.tabs) return { status: "too-large", snapshot: null };
      const tabs = { entries: value.entries, activeIndex: value.activeIndex };
      if (!validTabs(tabs)) return { status: "invalid", snapshot: null };
      return { status: "ready", snapshot: { schemaVersion: 1, key: this.key!, savedAt: value.savedAt as number, ...tabs } };
    } catch (error) { return { status: failure(error), snapshot: null }; }
    finally { close(descriptor); close(directory); }
  }

  save(tabs: TabRecoveryTabs): TabRecoveryWriteStatus {
    if (this.disabled) return this.disabled;
    let directory: number | undefined;
    let descriptor: number | undefined;
    let temporary: string | undefined;
    let temporaryIdentity: fs.Stats | undefined;
    try {
      if (Array.isArray(tabs?.entries) && tabs.entries.length > TAB_RECOVERY_LIMITS.tabs) return "too-large";
      if (!validTabs(tabs)) return "invalid";
      const entries: TabRecoveryEntry[] = tabs.entries.map(entry => entry.kind === "url"
        ? { kind: "url", url: entry.url }
        : { kind: "excluded", url: "about:blank", reason: entry.reason });
      const snapshot: TabRecoverySnapshot = { schemaVersion: 1, key: this.key!, savedAt: Date.now(), entries, activeIndex: tabs.activeIndex };
      const bytes = Buffer.from(JSON.stringify(snapshot));
      if (bytes.length > TAB_RECOVERY_LIMITS.fileBytes) return "too-large";
      directory = this.openDirectory(true);
      this.checkTarget();
      temporary = path.join(this.directory, `.snapshot-${randomUUID()}.tmp`);
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryIdentity = fs.fstatSync(descriptor);
      privateFile(temporaryIdentity);
      fs.writeFileSync(descriptor, bytes);
      sync(descriptor);
      close(descriptor);
      descriptor = undefined;
      this.checkCurrentDirectory(directory);
      this.checkTarget();
      fs.renameSync(temporary, this.filename());
      temporary = undefined;
      sync(directory);
      return "saved";
    } catch (error) {
      const status = failure(error);
      return status === "missing" ? "io-error" : status;
    } finally {
      close(descriptor);
      if (temporary && temporaryIdentity && directory !== undefined) {
        try {
          this.checkCurrentDirectory(directory);
          const current = fs.lstatSync(temporary);
          if (current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) fs.unlinkSync(temporary);
        } catch {}
      }
      close(directory);
    }
  }

  clear(): TabRecoveryClearStatus {
    if (this.disabled) return this.disabled;
    let directory: number | undefined;
    try {
      directory = this.openDirectory(false);
      privateFile(fs.lstatSync(this.filename()));
      this.checkCurrentDirectory(directory);
      fs.unlinkSync(this.filename());
      sync(directory);
      return "cleared";
    } catch (error) {
      const status = failure(error);
      return status === "too-large" || status === "invalid" ? "io-error" : status;
    } finally { close(directory); }
  }
}
