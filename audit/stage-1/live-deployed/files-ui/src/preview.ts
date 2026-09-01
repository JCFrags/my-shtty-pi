import { PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES, TAB_WIDTH } from "./constants.ts";
import { detectBinary } from "./binary.ts";
import { decodeUtf8, readFilePrefix } from "./file-read.ts";
import type { RepositoryTree } from "./filesystem.ts";
import type { PreviewMetadata, PreviewResult } from "./types.ts";

export interface PreviewServiceOptions {
  maxBytes?: number;
  maxLines?: number;
}

interface CachedPreview {
  size: number;
  mtimeMs: number;
  result: PreviewResult;
}

function emptyMetadata(relativePath: string): PreviewMetadata {
  return {
    relativePath,
    absolutePath: "",
    size: 0,
    mtimeMs: 0,
    mode: 0,
    encoding: "utf-8",
    invalidUtf8: false,
    changed: false,
    binary: false,
    truncated: false,
    bytesRead: 0,
    displayedLines: 0,
  };
}

function splitPreviewLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function expandTabs(value: string, tabWidth = TAB_WIDTH): string {
  let column = 0;
  let output = "";
  for (const character of value) {
    if (character === "\t") {
      const spaces = tabWidth - (column % tabWidth);
      output += " ".repeat(spaces);
      column += spaces;
    } else {
      output += character;
      column += 1;
    }
  }
  return output;
}

export class PreviewService {
  private readonly cache = new Map<string, CachedPreview>();
  private readonly tree: RepositoryTree;
  readonly maxBytes: number;
  readonly maxLines: number;

  constructor(tree: RepositoryTree, options: PreviewServiceOptions = {}) {
    this.tree = tree;
    this.maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES;
    this.maxLines = options.maxLines ?? PREVIEW_MAX_LINES;
  }

  async load(relativePath: string, force = false): Promise<PreviewResult> {
    try {
      const safeFile = await this.tree.resolveSafeReadableFile(relativePath);
      const cached = this.cache.get(safeFile.relativePath);
      const changed = cached !== undefined && (cached.size !== safeFile.stats.size || cached.mtimeMs !== safeFile.stats.mtimeMs);
      if (!force && cached && !changed) {
        return {
          ...cached.result,
          metadata: { ...cached.result.metadata, changed: false },
        };
      }

      const prefix = await readFilePrefix(safeFile.absolutePath, this.maxBytes);
      const binary = detectBinary(prefix.bytes);
      const metadataBase: PreviewMetadata = {
        relativePath: safeFile.relativePath,
        absolutePath: safeFile.absolutePath,
        size: safeFile.stats.size,
        mtimeMs: safeFile.stats.mtimeMs,
        mode: safeFile.stats.mode,
        encoding: "utf-8",
        invalidUtf8: false,
        changed,
        binary: binary.binary,
        truncated: prefix.truncated,
        bytesRead: prefix.bytesRead,
        displayedLines: 0,
      };
      if (binary.binary) {
        const result: PreviewResult = {
          metadata: {
            ...metadataBase,
            binaryKind: binary.kind,
            displayedLines: 0,
          },
          lines: [],
        };
        this.cache.set(safeFile.relativePath, { size: safeFile.stats.size, mtimeMs: safeFile.stats.mtimeMs, result });
        return result;
      }

      const decoded = decodeUtf8(prefix.bytes, { allowTrimmedTail: prefix.truncated });
      const allLines = splitPreviewLines(decoded.text);
      const lineTruncated = allLines.length > this.maxLines;
      const visibleLines = lineTruncated ? allLines.slice(0, this.maxLines) : allLines;
      const truncatedBy =
        prefix.truncated && lineTruncated ? "bytes-and-lines" : prefix.truncated ? "bytes" : lineTruncated ? "lines" : undefined;
      const metadata: PreviewMetadata = {
        ...metadataBase,
        invalidUtf8: decoded.invalid,
        truncated: prefix.truncated || lineTruncated,
        displayedLines: visibleLines.length,
      };
      if (truncatedBy) metadata.truncatedBy = truncatedBy;
      if (!prefix.truncated) metadata.totalLines = allLines.length;
      const result: PreviewResult = {
        metadata,
        lines: visibleLines,
        rawText: decoded.text,
      };
      this.cache.set(safeFile.relativePath, { size: safeFile.stats.size, mtimeMs: safeFile.stats.mtimeMs, result });
      return result;
    } catch (error) {
      return {
        metadata: emptyMetadata(relativePath),
        lines: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  invalidate(relativePath?: string): void {
    if (relativePath === undefined) this.cache.clear();
    else this.cache.delete(relativePath);
  }
}
