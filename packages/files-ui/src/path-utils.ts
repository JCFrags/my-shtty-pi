import path from "node:path";

export function toPosixPath(value: string): string {
  return path.sep === "\\" ? value.replaceAll("\\", "/") : value;
}

export function normalizeRelativePath(value: string): string {
  if (value.includes("\0")) throw new Error("Path contains a NUL byte");
  const posix = toPosixPath(value);
  if (path.posix.isAbsolute(posix) || (path.sep === "\\" && path.win32.isAbsolute(value))) {
    throw new Error(`Expected a relative path: ${value}`);
  }
  const normalized = path.posix.normalize(posix).replace(/^\.\//, "");
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path escapes the repository root: ${value}`);
  }
  return normalized;
}

export function relativePathFromRoot(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside repository root: ${absolutePath}`);
  }
  return normalizeRelativePath(relative);
}

export function absolutePathFromRoot(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(root, ...normalized.split("/").filter(Boolean));
  if (!isPathInside(root, absolute)) throw new Error(`Path is outside repository root: ${relativePath}`);
  return absolute;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isHiddenPath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath)
    .split("/")
    .some((segment) => segment.length > 1 && segment.startsWith("."));
}

export function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function deterministicNameCompare(a: string, b: string): number {
  const folded = lexicalCompare(a.toLowerCase(), b.toLowerCase());
  return folded !== 0 ? folded : lexicalCompare(a, b);
}


/** Keep the paths block one-line-per-file while leaving ordinary paths unchanged. */
export function escapePlainPath(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\\") output += "\\\\";
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      output += `\\u{${codePoint.toString(16).toUpperCase()}}`;
    } else output += character;
  }
  return output;
}

export function escapeXmlAttribute(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "&") output += "&amp;";
    else if (character === '"') output += "&quot;";
    else if (character === "<") output += "&lt;";
    else if (character === ">") output += "&gt;";
    else if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      output += `&#x${codePoint.toString(16).toUpperCase()};`;
    } else output += character;
  }
  return output;
}

export function codePointLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatApproximateTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens}`;
  if (tokens < 10_000) return `~${(tokens / 1000).toFixed(1)}K`;
  if (tokens < 1_000_000) return `~${Math.round(tokens / 1000)}K`;
  return `~${(tokens / 1_000_000).toFixed(1)}M`;
}
