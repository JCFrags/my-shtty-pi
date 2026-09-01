import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export async function persistOutput(prefix: string, output: string | Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const path = join(dir, "full-output.txt");
  await withFileMutationQueue(path, () => typeof output === "string" ? writeFile(path, output, "utf8") : writeFile(path, output));
  return path;
}

export async function boundedOutput(
  output: string,
  options: { direction?: "head" | "tail"; prefix: string; maxBytes?: number; maxLines?: number },
): Promise<{ text: string; fullOutputPath?: string; truncated: boolean }> {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
  };
  const result = options.direction === "tail" ? truncateTail(output, limits) : truncateHead(output, limits);
  if (!result.truncated) return { text: result.content, truncated: false };

  const fullOutputPath = await persistOutput(options.prefix, output);
  const text = `${result.content}\n\n[Output truncated exactly: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). Full output: ${fullOutputPath}]`;
  return { text, fullOutputPath, truncated: true };
}

export function pageLines(
  lines: string[],
  offset: number,
  limit: number,
): { lines: string[]; nextOffset?: number; total: number } {
  const start = Math.max(0, offset);
  const end = Math.min(lines.length, start + Math.max(1, limit));
  return {
    lines: lines.slice(start, end),
    ...(end < lines.length ? { nextOffset: end } : {}),
    total: lines.length,
  };
}
