import { homedir } from "node:os";
import path from "node:path";

import { SUMMARY_MAX_CHARS, TOKEN_VALUE_MAX_CHARS } from "./constants.ts";

const CSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const OSC_ESCAPE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/gu;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const SECRET_ENV_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/giu;
const SECRET_OPTION_EQUALS = /(\B--?[A-Za-z0-9_-]*(?:api[-_]?key|token|password|passwd|secret|authorization|auth|credential)[A-Za-z0-9_-]*=)(?:"[^"]*"|'[^']*'|[^\s]+)/giu;
const SECRET_OPTION_VALUE = /(\B--?[A-Za-z0-9_-]*(?:api[-_]?key|token|password|passwd|secret|authorization|auth|credential)[A-Za-z0-9_-]*\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu;
const USER_OPTION = /(\B(?:-u|--user)(?:=|\s+))(?:(?:"[^"]*"|'[^']*'|[^\s]+))/giu;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[^\s]+/giu;
const NAMED_SECRET_HEADER = /\b((?:Authorization|X-Api-Key|Api-Key|X-Auth-Token)\s*:\s*)[^\s'"]+/giu;
const URL_USERINFO = /:\/\/[^\s/@]+@/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Replace an absolute home-directory prefix without interpreting the value as a path. */
export function redactHomePathPrefixes(value: string, homeDirectory = homedir()): string {
  const home = String(homeDirectory ?? "").trim().replace(/[\\/]+$/u, "");
  if (!home) return value;

  const variants = new Set([home, home.replace(/\\/gu, "/"), home.replace(/\//gu, "\\")]);
  let redacted = value;
  for (const variant of variants) {
    if (!variant) continue;
    const flags = WINDOWS_ABSOLUTE.test(variant) ? "giu" : "gu";
    const pattern = new RegExp(
      `${escapeRegExp(variant)}(?=$|[\\\\/\\s'\"])`,
      flags,
    );
    redacted = redacted.replace(pattern, "~");
  }
  return redacted;
}

export function stripTerminalControls(value: string): string {
  return value.replace(OSC_ESCAPE, " ").replace(CSI_ESCAPE, " ").replace(CONTROL_CHARS, " ");
}

export function truncateVisible(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function sanitizeVisible(value: unknown, maxChars = TOKEN_VALUE_MAX_CHARS): string {
  const normalized = stripTerminalControls(String(value ?? ""))
    .replace(/\s+/gu, " ")
    .trim();
  return truncateVisible(normalized, maxChars);
}

export function sanitizeSummary(value: unknown): string {
  return sanitizeVisible(
    redactHomePathPrefixes(redactCredentials(String(value ?? ""))),
    SUMMARY_MAX_CHARS,
  );
}

export function redactCredentials(value: string): string {
  return value
    .replace(SECRET_ENV_ASSIGNMENT, "$1=<redacted>")
    .replace(SECRET_OPTION_EQUALS, "$1<redacted>")
    .replace(SECRET_OPTION_VALUE, "$1<redacted>")
    .replace(USER_OPTION, "$1<redacted>")
    .replace(AUTH_HEADER, "$1 <redacted>")
    .replace(NAMED_SECRET_HEADER, "$1<redacted>")
    .replace(URL_USERINFO, "://<redacted>@");
}

export function sanitizeFirstCommandLine(command: unknown, homeDirectory = homedir()): string {
  const firstLine = String(command ?? "").split(/\r\n|\n|\r/u, 1)[0] ?? "";
  return sanitizeVisible(
    redactHomePathPrefixes(redactCredentials(firstLine), homeDirectory),
    SUMMARY_MAX_CHARS - "running ".length,
  );
}

export interface NormalizedObservedPath {
  key: string;
  display: string;
}

function isWithin(relativePath: string, pathImpl: typeof path.posix | typeof path.win32): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathImpl.sep}`) &&
      !pathImpl.isAbsolute(relativePath))
  );
}

function cleanPathInput(rawPath: unknown): string {
  return stripTerminalControls(String(rawPath ?? ""))
    .replace(/\s*\n\s*/gu, " ")
    .trim()
    .slice(0, 4_096);
}

function portableDisplay(value: string): string {
  return value.replace(/\\/gu, "/");
}

export function normalizeObservedPath(
  rawPath: unknown,
  cwd: string,
  homeDirectory = homedir(),
): NormalizedObservedPath | undefined {
  const cleaned = cleanPathInput(rawPath);
  if (!cleaned) return undefined;

  const useWindows = WINDOWS_ABSOLUTE.test(cleaned) || WINDOWS_ABSOLUTE.test(cwd);
  const pathImpl = useWindows ? path.win32 : path.posix;
  const normalizedCwd = pathImpl.resolve(cwd || ".");
  const absolute = pathImpl.isAbsolute(cleaned)
    ? pathImpl.normalize(cleaned)
    : pathImpl.resolve(normalizedCwd, cleaned);
  const relativeToCwd = pathImpl.relative(normalizedCwd, absolute);

  let display: string;
  if (isWithin(relativeToCwd, pathImpl)) {
    display = relativeToCwd || ".";
  } else {
    const normalizedHome = homeDirectory ? pathImpl.resolve(homeDirectory) : "";
    const relativeToHome = normalizedHome ? pathImpl.relative(normalizedHome, absolute) : "";
    if (normalizedHome && isWithin(relativeToHome, pathImpl)) {
      display = relativeToHome ? `~/${portableDisplay(relativeToHome)}` : "~";
    } else {
      display = pathImpl.basename(absolute) || ".";
    }
  }

  let key = portableDisplay(pathImpl.normalize(absolute));
  if (useWindows && /^[A-Z]:/u.test(key)) {
    key = `${key[0]?.toLowerCase()}${key.slice(1)}`;
  }

  return {
    key,
    display: sanitizeVisible(portableDisplay(display), SUMMARY_MAX_CHARS - "editing ".length),
  };
}

export function sanitizeToolName(toolName: unknown): string {
  return sanitizeVisible(toolName, 48);
}
