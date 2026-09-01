import type { OmissionNotice } from "../types.js";
import {
  byteCount,
  estimateTokensFromText,
  extractIdentifiers,
  getNumber,
  getRecord,
  getString,
  lineCount,
  truncateToTokens,
  unique,
} from "../utils.js";
import { normalizeTerminalText } from "./normalize.js";
import type { ReducerContext, ReducerResult } from "./types.js";

const SYMBOL = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|struct|trait|impl|fn)\s+([A-Za-z_$][\w$]*)/;
const IMPORT = /^\s*(?:import\b|from\s+\S+\s+import\b|require\s*\(|#include\b|use\s+\S+)/;

function filePath(context: ReducerContext): string | undefined {
  return (
    getString(context.block.toolArguments?.path) ??
    getString(context.block.toolArguments?.file_path) ??
    getString(context.block.toolArguments?.file) ??
    getString(getRecord(context.block.attributes.details)?.path)
  );
}

function requestedRange(context: ReducerContext): string | undefined {
  const offset = getNumber(context.block.toolArguments?.offset) ?? getNumber(context.block.toolArguments?.startLine);
  const limit = getNumber(context.block.toolArguments?.limit);
  const end = getNumber(context.block.toolArguments?.endLine);
  if (offset === undefined && limit === undefined && end === undefined) return undefined;
  if (offset !== undefined && end !== undefined) return `${offset}–${end}`;
  if (offset !== undefined && limit !== undefined) return `${offset}–${offset + Math.max(0, limit - 1)}`;
  return `offset=${offset ?? "?"}, limit=${limit ?? "?"}, end=${end ?? "?"}`;
}

function collectSelectedLines(lines: readonly string[], laterText: string): { selected: string[]; symbols: string[]; imports: string[] } {
  const symbols: string[] = [];
  const imports: string[] = [];
  const selectedIndexes = new Set<number>();
  const downstream = extractIdentifiers(laterText)
    .filter((value) => /^[A-Za-z_$][\w$.]{2,}$/.test(value))
    .slice(0, 50);

  lines.forEach((line, index) => {
    const symbol = line.match(SYMBOL)?.[1];
    if (symbol) {
      symbols.push(symbol);
      selectedIndexes.add(index);
      for (let cursor = index + 1; cursor <= Math.min(lines.length - 1, index + 3); cursor += 1) selectedIndexes.add(cursor);
    }
    if (IMPORT.test(line)) {
      imports.push(line.trim());
      if (imports.length <= 20) selectedIndexes.add(index);
    }
    if (/\b(?:TODO|FIXME|HACK|XXX|throw new|panic!|return Err|console\.error)\b/.test(line)) selectedIndexes.add(index);
    if (downstream.some((identifier) => line.includes(identifier))) {
      for (let cursor = Math.max(0, index - 2); cursor <= Math.min(lines.length - 1, index + 4); cursor += 1) {
        selectedIndexes.add(cursor);
      }
    }
  });

  if (selectedIndexes.size === 0) {
    for (let index = 0; index < Math.min(lines.length, 28); index += 1) selectedIndexes.add(index);
    for (let index = Math.max(28, lines.length - 16); index < lines.length; index += 1) selectedIndexes.add(index);
  }

  const selected: string[] = [];
  let previous = -2;
  for (const index of [...selectedIndexes].sort((a, b) => a - b)) {
    if (index > previous + 1 && selected.length > 0) selected.push("…");
    selected.push(lines[index] ?? "");
    previous = index;
  }
  return { selected, symbols: unique(symbols), imports: unique(imports) };
}

export function reduceFileRead(context: ReducerContext): ReducerResult {
  const normalized = normalizeTerminalText(context.block.exactText);
  const lines = normalized.text.split("\n");
  const selected = collectSelectedLines(lines, context.laterText);
  const path = filePath(context);
  const range = requestedRange(context);
  const details = getRecord(context.block.attributes.details);
  const revision =
    getString(context.block.toolArguments?.revision) ??
    getString(context.block.toolArguments?.ref) ??
    getString(details?.revision) ??
    getString(details?.hash);

  const sections: string[] = [];
  if (path) sections.push(`File: ${path}`);
  if (revision) sections.push(`Historical revision/hash: ${revision}`);
  if (range) sections.push(`Requested line range: ${range}`);
  sections.push(`Historical read length: ${lines.length} line(s)`);
  if (selected.symbols.length > 0) sections.push(`Symbols observed: ${selected.symbols.slice(0, 30).join(", ")}`);
  if (selected.imports.length > 0) sections.push(`Imports observed: ${selected.imports.slice(0, 12).join(" | ")}`);
  sections.push(`\nSelected exact lines:\n${selected.selected.join("\n")}`);
  sections.push("\nNote: this is a historical read; the current repository file may have changed.");

  let text = sections.join("\n");
  text = truncateToTokens(text, context.maxTokens, "\n…[additional historical file lines omitted]…\n");
  const omittedLines = Math.max(0, lines.length - lineCount(text));
  const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
  const omissions: OmissionNotice[] = [...normalized.omissions];
  if (omittedLines > 0 || omittedBytes > 0) {
    omissions.push({
      description: "Unreferenced file lines omitted; declarations, imports, and downstream-referenced neighborhoods retained",
      omittedLines,
      omittedBytes,
    });
  }

  return {
    text,
    reducer: "file-read",
    version: "1.0.0",
    lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
    omissions,
    metadata: { path, range, revision, symbols: selected.symbols, imports: selected.imports, originalLines: lines.length },
  };
}
