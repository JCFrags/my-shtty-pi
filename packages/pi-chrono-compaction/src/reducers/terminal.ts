import type { OmissionNotice } from "../types.js";
import {
  byteCount,
  estimateTokensFromText,
  getBoolean,
  getNumber,
  getRecord,
  getString,
  lineCount,
  truncateToTokens,
  unique,
} from "../utils.js";
import { collapseAdjacentRepeatedLines, normalizeTerminalText } from "./normalize.js";
import { looksLikeTestOutput, reduceTestOutput } from "./test-output.js";
import type { ReducerContext, ReducerResult } from "./types.js";

const IMPORTANT = /(?:^|\b)(?:error|failed|failure|fatal|exception|panic|traceback|warning|warn|timeout|timed out|denied|not found|cannot|assert|expected|received|conflict|abort|segfault|killed|oom|out of memory)\b/i;

function terminalMetadata(context: ReducerContext): Record<string, unknown> {
  const details = getRecord(context.block.attributes.details);
  const command = getString(context.block.toolArguments?.command) ?? getString(context.block.attributes.command);
  const cwd = getString(context.block.toolArguments?.cwd) ?? getString(details?.cwd);
  const exitCode =
    getNumber(context.block.attributes.exitCode) ??
    getNumber(details?.exitCode) ??
    getNumber(details?.code) ??
    (context.block.isError === true ? 1 : context.block.isError === false ? 0 : undefined);
  const durationMs = getNumber(details?.durationMs) ?? getNumber(details?.duration);
  const originallyTruncated =
    getBoolean(context.block.attributes.truncated) ?? getBoolean(details?.truncated) ?? getBoolean(details?.wasTruncated);
  const fullOutputPath = getString(context.block.attributes.fullOutputPath) ?? getString(details?.fullOutputPath);
  return { command, cwd, exitCode, durationMs, originallyTruncated, fullOutputPath };
}

export function reduceTerminalOutput(context: ReducerContext): ReducerResult {
  if (looksLikeTestOutput(context.block.exactText)) return reduceTestOutput(context);

  const normalized = normalizeTerminalText(context.block.exactText);
  const originalLines = normalized.text.split("\n");
  const collapsed = collapseAdjacentRepeatedLines(originalLines);
  const lines = collapsed.lines;
  const metadata = terminalMetadata(context);

  const importantIndexes = new Set<number>();
  lines.forEach((line, index) => {
    if (!IMPORTANT.test(line)) return;
    for (let cursor = Math.max(0, index - 1); cursor <= Math.min(lines.length - 1, index + 5); cursor += 1) {
      importantIndexes.add(cursor);
    }
  });

  const relevant = [...importantIndexes]
    .sort((a, b) => a - b)
    .map((index) => lines[index] ?? "")
    .filter((line, index, all) => !(line.trim() === "" && all[index - 1]?.trim() === ""));

  // The warm fallback is deliberately small. Important lines and their
  // neighborhoods override it. Cold history receives a one-to-two-line cue
  // from the retention gradient.
  const head = lines.slice(0, Math.min(5, lines.length));
  const tail = lines.slice(Math.max(head.length, lines.length - 5));
  const body = relevant.length > 0 ? relevant : [...head, ...(tail.length > 0 ? ["…", ...tail] : [])];
  const command = getString(metadata.command);
  const cwd = getString(metadata.cwd);
  const exitCode = getNumber(metadata.exitCode);
  const durationMs = getNumber(metadata.durationMs);
  const originallyTruncated = getBoolean(metadata.originallyTruncated);
  const fullOutputPath = getString(metadata.fullOutputPath);

  const sections: string[] = [];
  if (command) sections.push(`Command: ${command}`);
  if (cwd) sections.push(`Working directory: ${cwd}`);
  if (exitCode !== undefined) sections.push(`Exit code: ${exitCode}`);
  if (durationMs !== undefined) sections.push(`Duration: ${durationMs} ms`);
  if (originallyTruncated !== undefined) sections.push(`Originally truncated by command/tool: ${String(originallyTruncated)}`);
  if (fullOutputPath) sections.push(`Original tool spill file: ${fullOutputPath}`);
  sections.push(`\n${relevant.length > 0 ? "Warnings/errors and surrounding evidence" : "Beginning and end"} (exact excerpts):\n${body.join("\n")}`);

  let text = sections.join("\n").trim();
  text = truncateToTokens(text, context.maxTokens, "\n…[additional terminal output omitted]…\n");
  const omittedLines = Math.max(0, originalLines.length - lineCount(text));
  const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
  const omissions: OmissionNotice[] = [...normalized.omissions];
  if (collapsed.repeatedLines > 0) {
    omissions.push({
      description: `${collapsed.repeatedLines} adjacent repeated terminal line(s) collapsed`,
      repeatedLines: collapsed.repeatedLines,
    });
  }
  if (omittedLines > 0 || omittedBytes > 0) {
    omissions.push({
      description:
        relevant.length > 0
          ? "Routine output outside warning/error neighborhoods omitted"
          : "Middle terminal output omitted; beginning and end retained",
      omittedLines,
      omittedBytes,
    });
  }

  return {
    text,
    reducer: "terminal",
    version: "2.0.0",
    lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
    omissions,
    metadata: {
      ...metadata,
      originalLines: originalLines.length,
      importantLines: unique(relevant).length,
    },
  };
}
