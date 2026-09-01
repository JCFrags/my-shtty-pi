import { lstat, readlink, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export interface PathInspection {
  inputPath: string;
  cwdPath: string;
  cwdRealPath: string;
  lexicalPath: string;
  effectivePath: string;
  displayPath: string;
  lexicalOutsideCwd: boolean;
  effectiveOutsideCwd: boolean;
  outsideCwd: boolean;
  usedSymlink: boolean;
  symlinkPaths: string[];
  targetExists: boolean;
  targetKind: "file" | "directory" | "other" | "missing";
  missingParentDirectories: string[];
}

export interface PathOperations {
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
}

const DEFAULT_PATH_OPERATIONS: PathOperations = {
  lstat,
  stat,
  realpath: (path) => realpath(path),
  readlink: (path) => readlink(path),
};
const MAX_SYMLINK_EXPANSIONS = 40;

export function isPathWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function makeDisplayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  if (rel === "") return ".";
  // Prefer a cwd-relative title/diff label even for ../ paths. On Windows,
  // relative() returns an absolute path when the target is on another drive.
  return isAbsolute(rel) ? target : rel;
}

interface EffectiveResolution {
  path: string;
  symlinkPaths: string[];
}

async function resolveEffectivePath(absolutePath: string, ops: PathOperations): Promise<EffectiveResolution> {
  let pathToResolve = normalize(absolutePath);
  const symlinkPaths: string[] = [];
  const seenLinks = new Set<string>();

  for (let expansion = 0; expansion <= MAX_SYMLINK_EXPANSIONS; expansion += 1) {
    const parsed = parse(pathToResolve);
    const rest = pathToResolve.slice(parsed.root.length);
    const parts = rest.split(sep).filter((part) => part.length > 0);
    let resolvedPath = parsed.root;
    let restarted = false;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) continue;
      const candidate = join(resolvedPath, part);
      let entry: Stats;
      try {
        entry = await ops.lstat(candidate);
      } catch (error: unknown) {
        if (isMissingPathError(error)) {
          return {
            path: normalize(join(resolvedPath, ...parts.slice(index))),
            symlinkPaths,
          };
        }
        throw error;
      }

      if (!entry.isSymbolicLink()) {
        resolvedPath = candidate;
        continue;
      }

      const normalizedCandidate = normalize(candidate);
      if (seenLinks.has(normalizedCandidate)) {
        throw Object.assign(new Error(`symbolic-link loop at ${candidate}`), { code: "ELOOP" });
      }
      seenLinks.add(normalizedCandidate);
      symlinkPaths.push(normalizedCandidate);

      const linkTarget = await ops.readlink(candidate);
      const absoluteLinkTarget = isAbsolute(linkTarget)
        ? normalize(linkTarget)
        : normalize(resolve(dirname(candidate), linkTarget));
      pathToResolve = normalize(resolve(absoluteLinkTarget, ...parts.slice(index + 1)));
      restarted = true;
      break;
    }

    if (!restarted) {
      return { path: normalize(resolvedPath), symlinkPaths };
    }
  }

  throw Object.assign(new Error(`too many symbolic-link expansions for ${absolutePath}`), { code: "ELOOP" });
}

async function classifyTarget(path: string, ops: PathOperations): Promise<{
  exists: boolean;
  kind: PathInspection["targetKind"];
}> {
  try {
    const entry = await ops.stat(path);
    if (entry.isFile()) return { exists: true, kind: "file" };
    if (entry.isDirectory()) return { exists: true, kind: "directory" };
    return { exists: true, kind: "other" };
  } catch (error: unknown) {
    if (isMissingPathError(error)) return { exists: false, kind: "missing" };
    throw error;
  }
}

async function collectMissingParents(targetPath: string, ops: PathOperations): Promise<string[]> {
  const missing: string[] = [];
  let current = dirname(targetPath);
  const root = parse(current).root;

  while (current !== root) {
    try {
      const entry = await ops.stat(current);
      if (!entry.isDirectory()) {
        // A non-directory parent will make the original write fail. It is not
        // "missing", so leave the failure to the built-in tool after review.
      }
      break;
    } catch (error: unknown) {
      if (!isMissingPathError(error)) throw error;
      missing.push(normalize(current));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return missing.reverse();
}

export async function inspectTargetPath(
  cwd: string,
  inputPath: string,
  ops: PathOperations = DEFAULT_PATH_OPERATIONS,
): Promise<PathInspection> {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("tool path must be a non-empty string");
  }
  if (inputPath.includes("\0")) {
    throw new Error("tool path contains a NUL character");
  }

  const cwdPath = normalize(resolve(cwd));
  const cwdRealPath = normalize(await ops.realpath(cwdPath));
  const lexicalPath = normalize(isAbsolute(inputPath) ? inputPath : resolve(cwdPath, inputPath));
  const effective = await resolveEffectivePath(lexicalPath, ops);
  const effectivePath = normalize(effective.path);
  const classification = await classifyTarget(lexicalPath, ops);

  const lexicalOutsideCwd = !isPathWithin(cwdPath, lexicalPath);
  const effectiveOutsideCwd = !isPathWithin(cwdRealPath, effectivePath);
  const lexicalMissingParents = await collectMissingParents(lexicalPath, ops);
  const effectiveMissingParents =
    effectivePath === lexicalPath ? [] : await collectMissingParents(effectivePath, ops);
  const missingParentDirectories = [...new Set([...lexicalMissingParents, ...effectiveMissingParents])];

  return {
    inputPath,
    cwdPath,
    cwdRealPath,
    lexicalPath,
    effectivePath,
    displayPath: makeDisplayPath(cwdPath, lexicalPath),
    lexicalOutsideCwd,
    effectiveOutsideCwd,
    outsideCwd: lexicalOutsideCwd || effectiveOutsideCwd,
    usedSymlink: effective.symlinkPaths.length > 0,
    symlinkPaths: effective.symlinkPaths,
    targetExists: classification.exists,
    targetKind: classification.kind,
    missingParentDirectories,
  };
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
