import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { EditToolInput, WriteToolInput } from "@earendil-works/pi-coding-agent";
import { inspectTargetPath, type PathInspection } from "./path-policy.js";
import { renderControlCharacters } from "./text-safety.js";

export type ReviewToolKind = "edit" | "write";

export interface BuiltinSemantics {
  constructEdit(request: {
    cwd: string;
    input: EditToolInput;
    current: Buffer;
    currentExists: boolean;
    signal?: AbortSignal;
  }): Promise<string>;
  generateUnifiedDiff(path: string, oldContent: string, newContent: string): string;
}

export interface PreviewWarning {
  code: "outside-cwd" | "symlink" | "binary" | "oversized" | "missing-parents";
  message: string;
}

export interface ContentMetadata {
  exists: boolean;
  bytes: number;
  lines: number;
  sha256: string;
  containsNul: boolean;
  binaryLike: boolean;
}

export interface ReviewPreview {
  tool: ReviewToolKind;
  toolCallId: string;
  path: PathInspection;
  current: ContentMetadata;
  proposed: ContentMetadata;
  proposedContent: string;
  previewText: string;
  warnings: PreviewWarning[];
  binary: boolean;
  oversized: boolean;
  changed: boolean;
}

export type ReviewInput =
  | { tool: "edit"; toolCallId: string; input: EditToolInput }
  | { tool: "write"; toolCallId: string; input: WriteToolInput };

export interface BuildPreviewOptions {
  cwd: string;
  maxPreviewBytes: number;
  signal?: AbortSignal;
  semantics: BuiltinSemantics;
}

export async function buildReviewPreview(
  request: ReviewInput,
  options: BuildPreviewOptions,
): Promise<ReviewPreview> {
  throwIfAborted(options.signal);
  const path = await inspectTargetPath(options.cwd, request.input.path);
  throwIfAborted(options.signal);

  if (path.targetKind === "directory") {
    throw new Error(`target is a directory: ${path.lexicalPath}`);
  }
  if (path.targetKind === "other") {
    throw new Error(`target is not a regular file: ${path.lexicalPath}`);
  }

  let currentBuffer: Buffer;
  if (path.targetExists) {
    currentBuffer = await readFile(path.lexicalPath);
  } else {
    currentBuffer = Buffer.alloc(0);
  }
  throwIfAborted(options.signal);

  const currentText = currentBuffer.toString("utf8");
  const proposedContent =
    request.tool === "write"
      ? validateWriteContent(request.input.content)
      : await options.semantics.constructEdit({
          cwd: options.cwd,
          input: request.input,
          current: currentBuffer,
          currentExists: path.targetExists,
          ...(options.signal ? { signal: options.signal } : {}),
        });
  throwIfAborted(options.signal);

  const proposedBuffer = Buffer.from(proposedContent, "utf8");
  const currentMetadata = makeMetadata(currentBuffer, path.targetExists);
  const proposedMetadata = makeMetadata(proposedBuffer, true);
  const binary = currentMetadata.binaryLike || proposedMetadata.binaryLike;
  const oversized =
    currentMetadata.bytes > options.maxPreviewBytes || proposedMetadata.bytes > options.maxPreviewBytes;
  const changed = !currentBuffer.equals(proposedBuffer);

  let previewText: string;
  if (binary) {
    previewText = makeBinarySummary(currentMetadata, proposedMetadata, changed);
  } else if (oversized) {
    previewText = makeOversizedSummary(currentBuffer, proposedBuffer, currentMetadata, proposedMetadata);
  } else {
    previewText = options.semantics.generateUnifiedDiff(
      renderControlCharacters(path.displayPath),
      currentText,
      proposedContent,
    );
    throwIfAborted(options.signal);
    if (previewText.trim().length === 0) {
      previewText = "(No textual changes; the built-in tool would write identical content.)";
    }
  }

  const warnings = buildWarnings(request.tool, path, binary, oversized, options.maxPreviewBytes);

  return {
    tool: request.tool,
    toolCallId: request.toolCallId,
    path,
    current: currentMetadata,
    proposed: proposedMetadata,
    proposedContent,
    previewText,
    warnings,
    binary,
    oversized,
    changed,
  };
}

function validateWriteContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new Error("write content must be a string");
  }
  return content;
}

function makeMetadata(buffer: Buffer, exists: boolean): ContentMetadata {
  const containsNul = buffer.includes(0);
  return {
    exists,
    bytes: buffer.byteLength,
    lines: countLines(buffer),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    containsNul,
    binaryLike: containsNul || hasInvalidUtf8(buffer) || hasBinaryControlDensity(buffer),
  };
}

function hasInvalidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function hasBinaryControlDensity(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) return false;
  let controls = 0;
  for (const byte of buffer) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      controls += 1;
    }
  }
  return controls > 0 && controls / buffer.byteLength >= 0.01;
}

function countLines(buffer: Buffer): number {
  if (buffer.byteLength === 0) return 0;
  let newlineCount = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) newlineCount += 1;
  }
  return newlineCount + (buffer[buffer.byteLength - 1] === 0x0a ? 0 : 1);
}

function buildWarnings(
  tool: ReviewToolKind,
  path: PathInspection,
  binary: boolean,
  oversized: boolean,
  maxPreviewBytes: number,
): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];
  if (path.outsideCwd) {
    warnings.push({
      code: "outside-cwd",
      message:
        `Target is outside ctx.cwd. Requested: ${path.lexicalPath}. ` +
        `Effective target: ${path.effectivePath}.`,
    });
  }
  if (path.usedSymlink) {
    warnings.push({
      code: "symlink",
      message:
        `Symbolic link encountered (${path.symlinkPaths.join(", ")}). ` +
        `Effective target: ${path.effectivePath}.`,
    });
  }
  if (binary) {
    warnings.push({
      code: "binary",
      message: "Current or proposed content is binary-like or contains NUL bytes; text diff rendering is suppressed.",
    });
  }
  if (oversized) {
    warnings.push({
      code: "oversized",
      message: `At least one preview side exceeds ${formatBytes(maxPreviewBytes)}; only a bounded summary is shown.`,
    });
  }
  if (tool === "write" && path.missingParentDirectories.length > 0) {
    warnings.push({
      code: "missing-parents",
      message: `Missing parent director${path.missingParentDirectories.length === 1 ? "y" : "ies"}: ${path.missingParentDirectories.join(", ")}.`,
    });
  }
  return warnings;
}

function makeBinarySummary(current: ContentMetadata, proposed: ContentMetadata, changed: boolean): string {
  return [
    "Binary/NUL content metadata (text diff omitted)",
    "",
    `Current:  ${current.exists ? "existing" : "missing"}, ${formatBytes(current.bytes)}, ${current.lines} lines, sha256 ${current.sha256}`,
    `Proposed: ${formatBytes(proposed.bytes)}, ${proposed.lines} lines, sha256 ${proposed.sha256}`,
    `Changed:  ${changed ? "yes" : "no"}`,
  ].join("\n");
}

function makeOversizedSummary(
  current: Buffer,
  proposed: Buffer,
  currentMetadata: ContentMetadata,
  proposedMetadata: ContentMetadata,
): string {
  const commonPrefix = countCommonPrefix(current, proposed);
  const commonSuffix = countCommonSuffix(current, proposed, commonPrefix);
  const firstChangedLine = 1 + countByte(current.subarray(0, commonPrefix), 0x0a);
  const excerptRadius = 256;
  const currentExcerpt = sanitizedExcerpt(current, commonPrefix, excerptRadius);
  const proposedExcerpt = sanitizedExcerpt(proposed, commonPrefix, excerptRadius);

  return [
    "Oversized diff summary (full unified diff omitted)",
    "",
    `Current:  ${currentMetadata.exists ? "existing" : "missing"}, ${formatBytes(currentMetadata.bytes)}, ${currentMetadata.lines} lines, sha256 ${currentMetadata.sha256}`,
    `Proposed: ${formatBytes(proposedMetadata.bytes)}, ${proposedMetadata.lines} lines, sha256 ${proposedMetadata.sha256}`,
    `Common prefix: ${formatBytes(commonPrefix)}`,
    `Common suffix: ${formatBytes(commonSuffix)}`,
    `First differing line (approximate): ${firstChangedLine}`,
    "",
    "--- bounded current excerpt",
    currentExcerpt,
    "+++ bounded proposed excerpt",
    proposedExcerpt,
  ].join("\n");
}

function countCommonPrefix(left: Buffer, right: Buffer): number {
  const limit = Math.min(left.byteLength, right.byteLength);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function countCommonSuffix(left: Buffer, right: Buffer, prefixLength: number): number {
  const limit = Math.min(left.byteLength, right.byteLength) - prefixLength;
  let count = 0;
  while (
    count < limit &&
    left[left.byteLength - 1 - count] === right[right.byteLength - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function countByte(buffer: Buffer, byte: number): number {
  let count = 0;
  for (const candidate of buffer) {
    if (candidate === byte) count += 1;
  }
  return count;
}

function sanitizedExcerpt(buffer: Buffer, center: number, radius: number): string {
  if (buffer.byteLength === 0) return "(empty)";
  const start = Math.max(0, center - radius);
  const end = Math.min(buffer.byteLength, center + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < buffer.byteLength ? "…" : "";
  const text = buffer
    .subarray(start, end)
    .toString("utf8")
    .replace(/\r/g, "\\r")
    .replace(/[^\t\n\x20-\x7E\u00A0-\uFFFF]/g, "�");
  return `${prefix}${text}${suffix}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KiB";
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("review aborted");
  }
}
