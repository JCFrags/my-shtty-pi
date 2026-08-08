import {
  INSERT_PER_FILE_MAX_BYTES,
  INSERT_TOTAL_MAX_BYTES,
} from "./constants.ts";
import { detectBinary } from "./binary.ts";
import { decodeUtf8, readFilePrefix } from "./file-read.ts";
import type { RepositoryTree } from "./filesystem.ts";
import {
  codePointLength,
  deterministicNameCompare,
  escapePlainPath,
  escapeXmlAttribute,
  normalizeRelativePath,
} from "./path-utils.ts";
import type { InsertBudget, InsertCandidate } from "./types.ts";

export interface InsertBudgetOptions {
  perFileMaxBytes?: number;
  totalMaxBytes?: number;
}

export function approximateTokensFromCharacters(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

export function formatSelectedPaths(paths: Iterable<string>): string {
  const normalized = [...new Set([...paths].map(normalizeRelativePath))].sort(deterministicNameCompare);
  return ["Files to inspect:", ...normalized.map((filePath) => `- ${escapePlainPath(filePath)}`)].join("\n");
}

function candidateBase(pathValue: string): InsertCandidate {
  return {
    path: normalizeRelativePath(pathValue),
    absolutePath: "",
    bytes: 0,
    characters: 0,
    approximateTokens: 0,
    binary: false,
    invalidUtf8: false,
    eligible: false,
    included: false,
  };
}

export async function prepareInsertBudget(
  tree: RepositoryTree,
  selectedPaths: Iterable<string>,
  options: InsertBudgetOptions = {},
): Promise<InsertBudget> {
  const perFileMaxBytes = options.perFileMaxBytes ?? INSERT_PER_FILE_MAX_BYTES;
  const totalMaxBytes = options.totalMaxBytes ?? INSERT_TOTAL_MAX_BYTES;
  const paths = [...new Set([...selectedPaths].map(normalizeRelativePath))].sort(deterministicNameCompare);
  const candidates: InsertCandidate[] = [];
  let includedBytes = 0;
  let includedCharacters = 0;

  for (const selectedPath of paths) {
    const candidate = candidateBase(selectedPath);
    try {
      const safe = await tree.resolveSafeReadableFile(selectedPath);
      candidate.absolutePath = safe.absolutePath;
      candidate.bytes = safe.stats.size;
      if (safe.stats.size > perFileMaxBytes) {
        candidate.reason = "per-file-limit";
        candidates.push(candidate);
        continue;
      }
      const read = await readFilePrefix(safe.absolutePath, perFileMaxBytes);
      candidate.bytes = read.bytes.length;
      if (read.truncated) {
        candidate.reason = "per-file-limit";
        candidates.push(candidate);
        continue;
      }
      const binary = detectBinary(read.bytes);
      candidate.binary = binary.binary;
      if (binary.kind) candidate.binaryKind = binary.kind;
      if (binary.binary) {
        candidate.reason = "binary";
        candidates.push(candidate);
        continue;
      }
      const decoded = decodeUtf8(read.bytes);
      candidate.invalidUtf8 = decoded.invalid;
      if (decoded.invalid) {
        candidate.reason = "invalid-utf8";
        candidates.push(candidate);
        continue;
      }
      candidate.content = decoded.text;
      candidate.characters = codePointLength(decoded.text);
      candidate.approximateTokens = approximateTokensFromCharacters(candidate.characters);
      candidate.eligible = true;
      if (includedBytes + candidate.bytes <= totalMaxBytes) {
        candidate.included = true;
        includedBytes += candidate.bytes;
        includedCharacters += candidate.characters;
      } else {
        candidate.reason = "total-limit";
      }
    } catch (error) {
      candidate.reason = "read-error";
      candidate.error = error instanceof Error ? error.message : String(error);
    }
    candidates.push(candidate);
  }

  return {
    candidates,
    includedBytes,
    includedCharacters,
    approximateTokens: approximateTokensFromCharacters(includedCharacters),
    perFileMaxBytes,
    totalMaxBytes,
    overBudget: includedBytes > totalMaxBytes,
  };
}

export class InsertBudgetModel {
  readonly budget: InsertBudget;

  constructor(budget: InsertBudget) {
    this.budget = budget;
    this.recalculate();
  }

  toggle(pathValue: string): boolean {
    const normalized = normalizeRelativePath(pathValue);
    const candidate = this.budget.candidates.find((entry) => entry.path === normalized);
    if (!candidate?.eligible) return false;
    if (candidate.included) {
      candidate.included = false;
      if (candidate.reason === undefined) candidate.reason = "total-limit";
      this.recalculate();
      return true;
    }
    const projected = this.budget.includedBytes + candidate.bytes;
    if (projected > this.budget.totalMaxBytes) {
      candidate.reason = "total-limit";
      return false;
    }
    candidate.included = true;
    if (candidate.reason === "total-limit") candidate.reason = undefined;
    this.recalculate();
    return true;
  }

  setIncluded(pathValue: string, included: boolean): boolean {
    const candidate = this.budget.candidates.find((entry) => entry.path === normalizeRelativePath(pathValue));
    if (!candidate || candidate.included === included) return candidate !== undefined;
    return this.toggle(pathValue);
  }

  recalculate(): void {
    let bytes = 0;
    let characters = 0;
    for (const candidate of this.budget.candidates) {
      if (!candidate.included) continue;
      bytes += candidate.bytes;
      characters += candidate.characters;
    }
    this.budget.includedBytes = bytes;
    this.budget.includedCharacters = characters;
    this.budget.approximateTokens = approximateTokensFromCharacters(characters);
    this.budget.overBudget = bytes > this.budget.totalMaxBytes;
  }

  includedCandidates(): InsertCandidate[] {
    return this.budget.candidates.filter((candidate) => candidate.included && candidate.content !== undefined);
  }
}

export const INSERTION_FORMAT = "pi-files-ui:length-delimited-v1";

/**
 * Payload bytes begin immediately after each `<file ...>\n` header. The `bytes`
 * attribute is the UTF-8 byte length of the exact payload. A parser reads that
 * many bytes before interpreting the following `\n</file>` delimiter, so literal
 * `</file>` sequences inside file content are unambiguous and unchanged.
 */
export function formatLengthDelimitedFiles(candidates: Iterable<InsertCandidate>): string {
  const included = [...candidates]
    .filter((candidate) => candidate.included && candidate.content !== undefined)
    .sort((left, right) => deterministicNameCompare(left.path, right.path));
  const parts = [`<selected_files format="${INSERTION_FORMAT}">`];
  for (const candidate of included) {
    const content = candidate.content ?? "";
    const bytes = Buffer.byteLength(content, "utf8");
    const characters = codePointLength(content);
    parts.push(
      `<file path="${escapeXmlAttribute(candidate.path)}" encoding="utf-8" bytes="${bytes}" characters="${characters}">`,
    );
    parts.push(content);
    parts.push("</file>");
  }
  parts.push("</selected_files>");
  return parts.join("\n");
}

function unescapeXmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parseLengthDelimitedFiles(value: string): Array<{ path: string; content: string; bytes: number }> {
  const buffer = Buffer.from(value, "utf8");
  const rootHeader = `<selected_files format="${INSERTION_FORMAT}">\n`;
  if (!value.startsWith(rootHeader)) throw new Error("Unsupported selected_files format");
  let offset = Buffer.byteLength(rootHeader, "utf8");
  const closeRoot = Buffer.from("</selected_files>", "utf8");
  const results: Array<{ path: string; content: string; bytes: number }> = [];

  while (offset < buffer.length) {
    if (buffer.subarray(offset, offset + closeRoot.length).equals(closeRoot)) return results;
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) throw new Error("Missing file header newline");
    const header = buffer.subarray(offset, newline).toString("utf8");
    const match = header.match(/^<file path="([^"]*)" encoding="utf-8" bytes="(\d+)" characters="\d+">$/);
    if (!match) throw new Error(`Invalid file header: ${header}`);
    const byteLength = Number.parseInt(match[2] ?? "", 10);
    const payloadStart = newline + 1;
    const payloadEnd = payloadStart + byteLength;
    if (payloadEnd > buffer.length) throw new Error("File payload exceeds insertion length");
    const payload = buffer.subarray(payloadStart, payloadEnd);
    const delimiter = Buffer.from("\n</file>\n", "utf8");
    if (!buffer.subarray(payloadEnd, payloadEnd + delimiter.length).equals(delimiter)) {
      throw new Error("Invalid file payload delimiter");
    }
    const decoded = decodeUtf8(payload);
    if (decoded.invalid) throw new Error("File payload is not valid UTF-8");
    results.push({ path: unescapeXmlAttribute(match[1] ?? ""), content: decoded.text, bytes: byteLength });
    offset = payloadEnd + delimiter.length;
  }
  throw new Error("Missing selected_files closing tag");
}
