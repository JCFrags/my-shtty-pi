import { existsSync } from "node:fs";
import { basename, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { capture } from "./exec.ts";

function ensureSuccess(tool: string, code: number | null, stderr: string): void {
  if (code === 0 || code === 1) return;
  throw new Error(`${tool} failed${code === null ? "" : ` with exit ${code}`}: ${stderr.trim()}`);
}

function appendIgnoreFiles(args: string[], cwd: string, path: string): void {
  const candidates = new Set([join(resolve(cwd), ".gitignore"), join(resolve(cwd, path), ".gitignore")]);
  for (const candidate of candidates) {
    if (existsSync(candidate)) args.push("--ignore-file", candidate);
  }
}

function fuzzyScore(candidate: string, query: string): number | undefined {
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return undefined;
    score += found === previous + 1 ? 8 : 2;
    if (found === 0 || "/_- .".includes(haystack[found - 1] ?? "")) score += 5;
    score -= Math.min(5, found - cursor);
    previous = found;
    cursor = found + 1;
  }
  score += Math.max(0, 20 - candidate.length / 5);
  return score;
}

export interface StructuredTextHit {
  path: string;
  line: number;
  byteColumn: number;
  text: string;
  snippet: string;
  snippetStartLine: number;
  snippetEndLine: number;
  submatchCount: number;
}

export interface StructuredPathHit {
  path: string;
  kind: "file" | "directory";
}

interface RgData {
  text?: string;
  bytes?: string;
}

interface RgEvent {
  type: string;
  data?: {
    path?: RgData;
    lines?: RgData;
    line_number?: number;
    submatches?: Array<{ start: number; end: number }>;
  };
}

function decodeRgData(data: RgData | undefined): string {
  if (!data) return "";
  if (typeof data.text === "string") return data.text;
  if (typeof data.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf8");
  return "";
}

function normalizeReportedPath(cwd: string, path: string): string {
  const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
  return relativePath.replace(/^\.\//, "");
}

function matchesSearchGlob(value: string, pattern: string): boolean {
  const markSegments = (input: string, keepGlobstar: boolean) => input
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => keepGlobstar && segment === "**" ? segment : `x${segment}`)
    .join("/");
  return matchesGlob(markSegments(value, false), markSegments(pattern, true));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Operation aborted");
}

export async function structuredTextSearch(options: {
  cwd: string;
  query: string;
  path: string;
  fileGlob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  contextLines?: number;
  signal?: AbortSignal;
}): Promise<StructuredTextHit[]> {
  const contextLines = Math.min(20, Math.max(0, options.contextLines ?? 2));
  const args = [
    "--json", "--no-config", "--line-number", "--column", "--sort", "path",
    "--hidden", "--no-require-git", "--glob", "!**/.git/**",
  ];
  if (options.ignoreCase) args.push("--ignore-case");
  if (options.literal !== false) args.push("--fixed-strings");
  if (options.fileGlob) args.push("--glob", options.fileGlob);
  if (contextLines > 0) args.push("--context", String(contextLines));
  appendIgnoreFiles(args, options.cwd, options.path);
  args.push("--", options.query, options.path);

  const result = await capture("rg", args, {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  ensureSuccess("ripgrep", result.code, result.stderr);

  const recordsByPath = new Map<string, Map<number, string>>();
  const matches: Array<{ path: string; line: number; byteColumn: number; text: string; submatchCount: number }> = [];
  for (const rawLine of result.stdout.split("\n")) {
    if (!rawLine) continue;
    let event: RgEvent;
    try {
      event = JSON.parse(rawLine) as RgEvent;
    } catch {
      throw new Error("ripgrep returned invalid JSON output");
    }
    if (event.type !== "match" && event.type !== "context") continue;
    const path = normalizeReportedPath(options.cwd, decodeRgData(event.data?.path));
    const line = event.data?.line_number;
    if (!path || typeof line !== "number") continue;
    const text = decodeRgData(event.data?.lines).replace(/\r?\n$/, "");
    let records = recordsByPath.get(path);
    if (!records) {
      records = new Map<number, string>();
      recordsByPath.set(path, records);
    }
    records.set(line, text);
    if (event.type === "match") {
      const submatches = event.data?.submatches ?? [];
      matches.push({
        path,
        line,
        byteColumn: (submatches[0]?.start ?? 0) + 1,
        text,
        submatchCount: submatches.length,
      });
    }
  }

  return matches.map((match) => {
    const records = recordsByPath.get(match.path)!;
    const available = [...records.keys()]
      .filter((line) => Math.abs(line - match.line) <= contextLines)
      .sort((a, b) => a - b);
    const snippetStartLine = available[0] ?? match.line;
    const snippetEndLine = available.at(-1) ?? match.line;
    const snippet = available.map((line) => `${line}: ${records.get(line) ?? ""}`).join("\n");
    return { ...match, snippet, snippetStartLine, snippetEndLine };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.byteColumn - b.byteColumn);
}

async function structuredPathInventory(options: {
  cwd: string;
  path: string;
  signal?: AbortSignal;
}): Promise<StructuredPathHit[]> {
  const args = [
    "--print0", "--color=never", "--type", "f", "--type", "d", "--hidden",
    "--no-require-git", "--exclude", ".git",
  ];
  appendIgnoreFiles(args, options.cwd, options.path);
  args.push(".", options.path);
  const result = await capture("fd", args, {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  ensureSuccess("fd", result.code, result.stderr);
  return result.stdout.split("\0").filter(Boolean).map((reported) => {
    const path = normalizeReportedPath(options.cwd, reported);
    return { path, kind: reported.endsWith("/") ? "directory" as const : "file" as const };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export function filterStructuredFileInventory(options: {
  cwd: string;
  pathGlob: string;
  path: string;
  inventory: StructuredPathHit[];
  signal?: AbortSignal;
}): StructuredPathHit[] {
  const hasSeparator = options.pathGlob.includes("/");
  const scopeRoot = resolve(options.cwd, options.path);
  return options.inventory.filter((hit) => {
    throwIfAborted(options.signal);
    if (!hasSeparator) return matchesSearchGlob(basename(hit.path), options.pathGlob);
    const scopeRelativePath = relative(scopeRoot, resolve(options.cwd, hit.path)).replaceAll("\\", "/");
    return matchesSearchGlob(scopeRelativePath, options.pathGlob);
  });
}

export async function structuredFileSearch(options: {
  cwd: string;
  pathGlob: string;
  path: string;
  signal?: AbortSignal;
}): Promise<StructuredPathHit[]> {
  const inventory = await structuredPathInventory(options);
  return filterStructuredFileInventory({ ...options, inventory });
}

export interface StructuredFuzzyResult {
  hits: Array<{ path: string; score: number; gitChanged: boolean }>;
  gitMetadataAvailable: boolean;
}

export async function structuredFuzzySearch(options: {
  cwd: string;
  query: string;
  path: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<StructuredFuzzyResult> {
  throwIfAborted(options.signal);
  const inventory = (await structuredPathInventory(options)).filter((hit) => hit.kind === "file");
  throwIfAborted(options.signal);
  const changed = new Set<string>();
  let gitMetadataAvailable = false;
  try {
    const git = await capture("git", ["status", "--porcelain=v1", "-z"], {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfAborted(options.signal);
    if (git.code === 0) {
      gitMetadataAvailable = true;
      for (const record of git.stdout.split("\0")) {
        throwIfAborted(options.signal);
        if (record.length < 4) continue;
        changed.add(record.slice(3).replace(/^.* -> /, ""));
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
  }

  const scored: Array<{ path: string; score: number; gitChanged: boolean }> = [];
  for (const { path } of inventory) {
    throwIfAborted(options.signal);
    const score = fuzzyScore(path, options.query);
    if (score === undefined) continue;
    const gitChanged = gitMetadataAvailable && changed.has(path);
    scored.push({ path, score: score + (gitChanged ? 25 : 0), gitChanged });
  }
  throwIfAborted(options.signal);
  scored.sort((a, b) => {
    throwIfAborted(options.signal);
    return b.score - a.score || a.path.localeCompare(b.path);
  });
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  return { hits: scored.slice(0, limit), gitMetadataAvailable };
}
