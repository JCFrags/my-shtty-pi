import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { capture } from "./exec.ts";

export interface SearchPage {
  output: string;
  allOutput: string;
  totalLines: number;
  nextCursor?: number;
}

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

export async function exactGrep(options: {
  cwd: string;
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  cursor?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SearchPage> {
  const args = ["--line-number", "--column", "--no-heading", "--color=never", "--with-filename", "--sort", "path", "--hidden"];
  if (options.ignoreCase) args.push("--ignore-case");
  if (options.literal) args.push("--fixed-strings");
  if (options.glob) args.push("--glob", options.glob);
  args.push("--glob", "!**/.git/**");
  if (options.context && options.context > 0) args.push("--context", String(options.context));
  appendIgnoreFiles(args, options.cwd, options.path);
  args.push("--", options.pattern, options.path);

  const result = await capture("rg", args, {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  ensureSuccess("ripgrep", result.code, result.stderr);
  const allOutput = result.stdout.replace(/\n$/, "");
  const lines = allOutput ? allOutput.split("\n") : [];
  const cursor = Math.max(0, options.cursor ?? 0);
  const limit = Math.min(2000, Math.max(1, options.limit ?? 200));
  const page = lines.slice(cursor, cursor + limit);
  const next = cursor + page.length;
  return {
    output: page.join("\n"),
    allOutput,
    totalLines: lines.length,
    ...(next < lines.length ? { nextCursor: next } : {}),
  };
}

export async function exactFind(options: {
  cwd: string;
  pattern: string;
  path: string;
  cursor?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SearchPage> {
  const args = ["--glob", options.pattern, "--color=never", "--type", "f", "--type", "d", "--hidden", "--exclude", ".git"];
  appendIgnoreFiles(args, options.cwd, options.path);
  args.push(options.path);
  const result = await capture("fd", args, {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  ensureSuccess("fd", result.code, result.stderr);
  const lines = result.stdout.replace(/\n$/, "").split("\n").filter(Boolean).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const allOutput = lines.join("\n");
  const cursor = Math.max(0, options.cursor ?? 0);
  const limit = Math.min(2000, Math.max(1, options.limit ?? 200));
  const page = lines.slice(cursor, cursor + limit);
  const next = cursor + page.length;
  return {
    output: page.join("\n"),
    allOutput,
    totalLines: lines.length,
    ...(next < lines.length ? { nextCursor: next } : {}),
  };
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

export async function fuzzyFiles(options: {
  cwd: string;
  query: string;
  path: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<Array<{ path: string; score: number; gitChanged: boolean }>> {
  const fileArgs = ["--type", "f", "--color=never", "--hidden", "--exclude", ".git"];
  appendIgnoreFiles(fileArgs, options.cwd, options.path);
  fileArgs.push(".", options.path);
  const files = await capture("fd", fileArgs, {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  ensureSuccess("fd", files.code, files.stderr);

  const changed = new Set<string>();
  const git = await capture("git", ["status", "--porcelain=v1", "-z"], {
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch(() => undefined);
  if (git?.code === 0) {
    for (const record of git.stdout.split("\0")) {
      if (record.length < 4) continue;
      const path = record.slice(3).replace(/^.* -> /, "");
      changed.add(path);
    }
  }

  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  return files.stdout
    .split("\n")
    .filter(Boolean)
    .map((path) => {
      const relativePath = isAbsolute(path) ? relative(options.cwd, path) : path;
      const normalized = relativePath.replace(/^\.\//, "");
      const base = fuzzyScore(normalized, options.query);
      const gitChanged = changed.has(normalized) || changed.has(path);
      return base === undefined ? undefined : { path: normalized, score: base + (gitChanged ? 25 : 0), gitChanged };
    })
    .filter((entry): entry is { path: string; score: number; gitChanged: boolean } => entry !== undefined)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
}
