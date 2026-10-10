import type { OmissionNotice } from "../types.js";
import {
  byteCount,
  estimateTokensFromText,
  extractIdentifiers,
  getBoolean,
  getNumber,
  getRecord,
  getString,
  lineCount,
  truncateToTokens,
  unique,
} from "../utils.js";
import { normalizeTerminalText } from "./normalize.js";
import type { ReducerContext, ReducerResult } from "./types.js";

interface SearchRecord {
  file: string;
  raw: string;
}

interface GroundedPage {
  strategy: "text" | "files" | "fuzzy";
  header: string;
  records: SearchRecord[];
  trailing: string;
}

function parseGroundedPage(text: string): GroundedPage | undefined {
  const lines = text.split("\n");
  const strategy = lines[0]?.match(/^Strategy: (text|files|fuzzy)$/)?.[1];
  if (!strategy || !/^Coverage: /m.test(text) || !/^Returned: \d+/m.test(text)) return undefined;
  const records: SearchRecord[] = [];
  const header: string[] = [];
  const trailing: string[] = [];
  let current: SearchRecord | undefined;
  let ended = false;
  for (const line of lines.slice(1)) {
    const record = strategy === "text"
      ? line.match(/^\d+\. (.+):(\d+):(\d+)$/)
      : line.match(/^\d+\. (.+)$/);
    if (record?.[1] && !ended) {
      const file = strategy === "fuzzy"
        ? record[1].replace(/^\* /, "").replace(/ \(score [\d.-]+\)$/, "")
        : record[1];
      current = { file, raw: line };
      records.push(current);
    } else if (current && !ended && (line === "" || line.startsWith("   "))) {
      // Numbered source lines and submatch labels belong to this record, not to new files.
      current.raw += `\n${line}`;
    } else if (records.length === 0) {
      header.push(line);
    } else {
      ended = true;
      trailing.push(line);
    }
  }
  return {
    strategy: strategy as GroundedPage["strategy"],
    header: [`Strategy: ${strategy}`, ...header].join("\n").trimEnd(),
    records,
    trailing: trailing.join("\n").trim(),
  };
}

export function looksLikeSearchOutput(context: ReducerContext): boolean {
  const name = context.block.toolName ?? "";
  return /^(?:local_search|grep|rg|search|find)$/i.test(name)
    || /^Strategy: (?:text|files|fuzzy)\n/m.test(context.block.exactText)
    || /^(?:[^:\n]+):\d+:/m.test(context.block.exactText);
}

function rawFileName(file: string, allowBareName: boolean): boolean {
  return !/^\s|^\d+$/.test(file)
    && !/^(?:Strategy|Coverage|Returned|Scope|Request|Next cursor|Qualifications?|Display|Continuation|Absence evidence)$/i.test(file)
    && (/(?:[/\\]|\.[\w-]+$)/.test(file) || (allowBareName && /^[\w-]+$/.test(file)));
}

function parseRawMatch(raw: string, allowBareName: boolean): SearchRecord | undefined {
  const sourceContext = raw.match(/^(.+?)-[1-9]\d*-/);
  if (sourceContext?.[1] && rawFileName(sourceContext[1], allowBareName)) return undefined;
  const withLine = raw.match(/^((?:[A-Za-z]:[/\\])?[^:\n]+):([1-9]\d*):(.*)$/);
  if (withLine?.[1] && rawFileName(withLine[1], allowBareName)) return { file: withLine[1], raw };
  const withoutLine = allowBareName ? raw.match(/^((?:[A-Za-z]:[/\\])?[^:\n]+):(.*)$/) : undefined;
  if (withoutLine?.[1] && rawFileName(withoutLine[1], false) && !/^\s*\d+\s*$/.test(withoutLine[2] ?? "")) {
    return { file: withoutLine[1], raw };
  }
  // Unqualified colon-separated prose and numeric count-only output remain ambiguous.
  return undefined;
}

function searchMetadata(context: ReducerContext): Record<string, unknown> {
  const args = context.block.toolArguments ?? {};
  const details = getRecord(context.block.attributes.details);
  const query =
    getString(args.pattern) ?? getString(args.query) ?? getString(args.regex) ?? getString(args.name) ?? getString(args.glob);
  const scope =
    getString(args.path) ?? getString(args.cwd) ?? getString(args.directory) ?? getString(args.root) ?? getString(details?.path);
  const truncated = getBoolean(details?.truncated) ?? getBoolean(details?.wasTruncated);
  const totalMatches = getNumber(details?.totalMatches);
  return { query, scope, truncated, totalMatches };
}

export function reduceSearchOutput(context: ReducerContext): ReducerResult {
  const normalized = normalizeTerminalText(context.block.exactText);
  const lines = normalized.text.split("\n").filter((line) => line.trim().length > 0);
  const page = parseGroundedPage(normalized.text);
  const details = getRecord(context.block.attributes.details);
  const metadata = searchMetadata(context);
  const downstreamTerms = extractIdentifiers(context.laterText).slice(0, 40);
  const rawTool = /^(?:rg|grep)$/i.test(context.block.toolName ?? "");
  const rawMatches = page ? [] : lines.map((line) => parseRawMatch(line, rawTool)).filter((match): match is SearchRecord => match !== undefined);
  const rawFiles = unique(rawMatches.map((match) => match.file));
  const rawEstablished = !/^local_search$/i.test(context.block.toolName ?? "") && rawMatches.length > 0 && lines.every((line) => {
    if (parseRawMatch(line, rawTool) || line === "--") return true;
    const sourceContext = line.match(/^(.+?)-[1-9]\d*-.*$/);
    return sourceContext?.[1] !== undefined && rawFiles.includes(sourceContext[1]);
  });
  const records = page?.records ?? (rawEstablished ? rawMatches : []);
  const files = unique(records.map((record) => record.file));
  const sorted = [...records].sort((a, b) => {
    const aRelevant = downstreamTerms.some((term) => a.raw.includes(term)) ? 1 : 0;
    const bRelevant = downstreamTerms.some((term) => b.raw.includes(term)) ? 1 : 0;
    return bRelevant - aRelevant;
  });
  const sections: string[] = [];
  if (page) {
    // Keep scan coverage, page counts, cursors, and qualifications in their original wording.
    sections.push(page.header);
    if (!/^Next cursor:/m.test(page.header) && getString(details?.nextCursor)) {
      sections.push(`Source next cursor: ${getString(details?.nextCursor)}`);
    }
    if (getRecord(details?.page) && !/offset=/.test(page.header)) {
      sections.push(`Source page: ${JSON.stringify(details?.page)}`);
    }
    if (getBoolean(details?.complete) !== undefined) {
      sections.push(`Source scan complete: ${String(details?.complete)} (not page or excerpt completeness)`);
    }
    if (getBoolean(details?.displayTruncated) !== undefined) {
      sections.push(`Source display truncated: ${String(details?.displayTruncated)}`);
    }
    sections.push(`Recognized displayed records: ${records.length} (not a count of exact submatches)`);
    if (files.length > 0) {
      sections.push(`${page.strategy === "text" ? "Files" : "Paths"} in displayed records (${files.length}):\n${files.slice(0, 80).map((file) => `- ${file}`).join("\n")}`);
    }
  } else if (rawEstablished) {
    const query = getString(metadata.query);
    const scope = getString(metadata.scope);
    if (query) sections.push(`Query: ${query}`);
    if (scope) sections.push(`Scope: ${scope}`);
    sections.push(`Match lines observed: ${records.length} (not a count of occurrences)`);
    if (getNumber(metadata.totalMatches) !== undefined) sections.push(`Source-reported total matches: ${metadata.totalMatches}`);
    sections.push(`Files in observed match lines (${files.length}):\n${files.slice(0, 80).map((file) => `- ${file}`).join("\n")}`);
    if (getBoolean(metadata.truncated) !== undefined) sections.push(`Source output truncated: ${metadata.truncated}`);
  }

  if (files.length > 80) sections.push("[Additional file paths omitted from the list.]");
  let text: string;
  if (!page && !rawEstablished) {
    // Ambiguous prose is evidence, not a source for derived match or file counts.
    text = truncateToTokens(normalized.text, context.maxTokens, "\n…[original search evidence omitted]…\n");
  } else {
    const prefix = sections.join("\n");
    const suffix = (page?.trailing ? `\n\n${page.trailing}` : "")
      + (sorted.length > 40 ? "\n[Additional search records omitted.]" : "");
    const label = `\n\nRepresentative exact ${page ? "records and source context" : "match lines"}${downstreamTerms.length > 0 ? " (downstream references prioritized)" : ""}:\n`;
    const remainingTokens = context.maxTokens - estimateTokensFromText(prefix + label + suffix);
    if (remainingTokens <= estimateTokensFromText("\n…[search record excerpts omitted]…\n")) {
      // When the envelope alone exceeds the budget, do not replace it with invented statistics.
      text = truncateToTokens(normalized.text, context.maxTokens, "\n…[original search evidence omitted]…\n");
    } else {
      const excerpt = truncateToTokens(sorted.slice(0, 40).map((record) => record.raw.trimEnd()).join("\n\n"), remainingTokens,
        "\n…[search record excerpts omitted]…\n");
      text = prefix + (records.length > 0 ? label + excerpt : "") + suffix;
    }
  }
  const omittedLines = Math.max(0, lineCount(normalized.text) - lineCount(text));
  const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
  const omissions: OmissionNotice[] = [...normalized.omissions];
  if (omittedLines > 0 || omittedBytes > 0) {
    omissions.push({
      description: "Search evidence reduced within the excerpt budget; retained counts keep their source meaning",
      omittedLines,
      omittedBytes,
    });
  }
  return {
    text,
    reducer: "search-results",
    version: "1.1.0",
    lossy: text !== normalized.text || omissions.length > 0,
    omissions,
    metadata: {
      ...metadata,
      format: page ? `grounded-${page.strategy}` : rawEstablished ? "raw-match-lines" : "ambiguous",
      ...(page ? { parsedRecords: records.length } : rawEstablished ? { parsedMatches: records.length } : {}),
      files,
    },
  };
}
