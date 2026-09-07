import { homedir } from "node:os";

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceHomeOccurrences(value: string): string {
  const home = homedir().replace(/\/+$/u, "");
  if (!home || home === "/") return value;
  const pattern = new RegExp(`${escapeRegExp(home)}(?=$|/)`, "gu");
  return value.replace(pattern, "$HOME");
}

function containsUnsafeAbsoluteLocalPath(value: string): boolean {
  const posixPath = /(?:^|[^A-Za-z0-9/])\/(?!\/)[^\s"'`<>()[\]{};,:!?]*/u;
  const posixDoubleSlashPath = /(?:^|[^A-Za-z0-9:])\/{2,}[^\s"'`<>()[\]{};,:!?]*/u;
  const windowsDrivePath = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\\/][^\s"'`<>()[\]{};,:!?]*/u;
  const windowsUncPath = /\\\\[^\s"'`<>()[\]{};,:!?]*/u;
  const fileUri = /file:\/\/[^\s"'`<>()[\]{};,:!?]*/iu;
  const homeShortcut = /~(?:[A-Za-z0-9._-]+)?\/[^\s"'`<>()[\]{};,:!?]*/u;
  return posixPath.test(value)
    || posixDoubleSlashPath.test(value)
    || windowsDrivePath.test(value)
    || windowsUncPath.test(value)
    || fileUri.test(value)
    || homeShortcut.test(value);
}

function clipUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}…`, "utf8") > maximumBytes) break;
    output += character;
  }
  return `${output}…`;
}

function normalizedProjectionText(value: string): string | undefined {
  if (hasUnpairedSurrogate(value)) return undefined;
  const normalized = value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  const projected = replaceHomeOccurrences(normalized);
  return containsUnsafeAbsoluteLocalPath(projected) ? undefined : projected;
}

/**
 * Normalize and privacy-check prose before it is composed into a projection.
 * The returned value is clipped without splitting a Unicode code point.
 */
export function projectDisplayText(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizedProjectionText(value);
  if (!normalized) return undefined;
  return clipUtf8(normalized, maximumBytes);
}

/**
 * Validate an already composed wire value without changing meaningful layout,
 * including the two-space current-state ID separator.
 */
export function projectFeedText(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) return undefined;
  const withoutAnsi = value.replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, "");
  const normalized = withoutAnsi
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!normalized || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(normalized)) return undefined;
  const projected = replaceHomeOccurrences(normalized);
  if (containsUnsafeAbsoluteLocalPath(projected)) return undefined;
  const credential = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*[^\s]{8,}|\b(?:sk|gh[opusa]|xox[baprs])-[-A-Za-z0-9_]{12,})/iu;
  if (credential.test(projected)) return undefined;
  return clipUtf8(projected, maximumBytes);
}

export function validateProjectionText(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string" || !value || hasUnpairedSurrogate(value)) return undefined;
  if (Buffer.byteLength(value, "utf8") > maximumBytes || /\p{Cc}/u.test(value)) return undefined;
  return containsUnsafeAbsoluteLocalPath(value) ? undefined : value;
}
