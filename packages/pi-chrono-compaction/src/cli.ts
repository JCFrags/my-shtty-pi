#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import process, { argv, stderr, stdout } from "node:process";
import { compactEntries } from "./compactor.js";
import { getActiveBranch, getSourceEntriesBefore, readSessionJsonl } from "./jsonl.js";
import { historyGet, historyRange, historySearch } from "./retrieval.js";
import { safeErrorMessage, stableStringify } from "./utils.js";

interface ParsedArguments {
  readonly command?: string;
  readonly positionals: string[];
  readonly flags: Map<string, string | boolean>;
}

function parseArguments(values: readonly string[]): ParsedArguments {
  const [command, ...rest] = values;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { ...(command === undefined ? {} : { command }), positionals, flags };
}

function flagString(args: ParsedArguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: ParsedArguments, name: string, fallback?: number): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a finite number`);
  return value;
}

function flagBoolean(args: ParsedArguments, name: string, fallback = false): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`--${name} must be true or false`);
}

function usage(): string {
  return `pi-chrono-compact — progressive chronological Pi JSONL context compaction

Usage:
  pi-chrono-compact compact <session.jsonl> [--leaf ID] [--before ID] [--target TOKENS] [--out FILE] [--details FILE]
  pi-chrono-compact get <session.jsonl> <entryId> [--block INDEX] [--before-context N] [--after-context N] [--start-char N] [--max-chars N]
  pi-chrono-compact search <session.jsonl> <query> [--regex] [--case-sensitive] [--limit N] [--start-match N] [--context-chars N]
  pi-chrono-compact range <session.jsonl> <startEntryId> <endEntryId> [--max-entries N]

Compact options:
  --target TOKENS       Final replay target (default: 12000)
  --leaf ID             Active branch leaf (default: last JSONL entry)
  --before ID           Compact only entries before this active-branch entry
  --hint TEXT            Advisory retention hint used for budget allocation
  --no-episodes         Disable old completed-task episode merging
  --out FILE            Write rendered replay to a file instead of stdout
  --details FILE        Write machine-readable plan/validation metadata
`;
}

async function runCompact(args: ParsedArguments): Promise<void> {
  const path = args.positionals[0];
  if (!path) throw new Error("compact requires <session.jsonl>");
  const session = await readSessionJsonl(path);
  const branch = getActiveBranch(session, flagString(args, "leaf") ?? session.inferredLeafId);
  const before = flagString(args, "before");
  const source = before ? getSourceEntriesBefore(branch, before) : branch;
  const targetTokens = Math.max(256, Math.floor(flagNumber(args, "target", 12_000)!));
  const result = await compactEntries(source, {
    config: {
      targetTokens,
      mergeEpisodes: !flagBoolean(args, "no-episodes"),
    },
    retentionHints: flagString(args, "hint"),
  });
  const outputPath = flagString(args, "out");
  if (outputPath) await writeFile(outputPath, `${result.summary}\n`, "utf8");
  else stdout.write(`${result.summary}\n`);

  const detailsPath = flagString(args, "details");
  if (detailsPath) await writeFile(detailsPath, `${stableStringify(result.details, 2)}\n`, "utf8");
  stderr.write(
    `Compacted ${result.rawTokens.toLocaleString()}→${result.renderedTokens.toLocaleString()} estimated tokens; target ${result.targetTokens.toLocaleString()}; ${result.plan.units.length} chronological unit(s); validation ${result.validation.ok ? "passed" : "failed"}.\n`,
  );
}

async function runGet(args: ParsedArguments): Promise<void> {
  const [path, entryId] = args.positionals;
  if (!path || !entryId) throw new Error("get requires <session.jsonl> <entryId>");
  const session = await readSessionJsonl(path);
  stdout.write(
    `${historyGet(session, entryId, {
      blockIndex: flagNumber(args, "block"),
      contextBefore: flagNumber(args, "before-context"),
      contextAfter: flagNumber(args, "after-context"),
      startChar: flagNumber(args, "start-char"),
      maxChars: flagNumber(args, "max-chars"),
    })}\n`,
  );
}

async function runSearch(args: ParsedArguments): Promise<void> {
  const [path, query] = args.positionals;
  if (!path || query === undefined) throw new Error("search requires <session.jsonl> <query>");
  const session = await readSessionJsonl(path);
  stdout.write(
    `${historySearch(session, query, {
      regex: flagBoolean(args, "regex"),
      caseSensitive: flagBoolean(args, "case-sensitive"),
      limit: flagNumber(args, "limit"),
      startMatch: flagNumber(args, "start-match"),
      contextChars: flagNumber(args, "context-chars"),
    })}\n`,
  );
}

async function runRange(args: ParsedArguments): Promise<void> {
  const [path, startEntryId, endEntryId] = args.positionals;
  if (!path || !startEntryId || !endEntryId) throw new Error("range requires <session.jsonl> <startEntryId> <endEntryId>");
  const session = await readSessionJsonl(path);
  stdout.write(`${historyRange(session, startEntryId, endEntryId, { maxEntries: flagNumber(args, "max-entries") })}\n`);
}

async function main(): Promise<void> {
  const args = parseArguments(argv.slice(2));
  switch (args.command) {
    case "compact":
      await runCompact(args);
      break;
    case "get":
      await runGet(args);
      break;
    case "search":
      await runSearch(args);
      break;
    case "range":
      await runRange(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      stdout.write(usage());
      break;
    default:
      throw new Error(`Unknown command: ${args.command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  stderr.write(`pi-chrono-compact: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
