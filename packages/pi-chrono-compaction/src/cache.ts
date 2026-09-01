import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompressionDetails } from "./types.js";
import { hashText, stableStringify } from "./utils.js";

export const CACHE_SCHEMA_VERSION = 4;

export interface CompactionCacheRecord {
  readonly schemaVersion: 4;
  readonly generation: number;
  readonly sourceHash: string;
  readonly configHash: string;
  readonly summary: string;
  readonly piSummary?: string;
  readonly rawTokens: number;
  readonly renderedTokens: number;
  readonly targetTokens: number;
  readonly details: CompressionDetails;
  readonly createdAt: string;
}

export function cachePathForSession(sessionPath: string): string {
  return `${sessionPath}.chrono-compact.json`;
}

export function hashCompactionConfig(value: unknown): string {
  return hashText(stableStringify(value));
}

export async function readCompactionCache(cachePath: string): Promise<CompactionCacheRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<CompactionCacheRecord>;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      typeof parsed.generation !== "number" ||
      typeof parsed.sourceHash !== "string" ||
      typeof parsed.configHash !== "string" ||
      typeof parsed.summary !== "string" ||
      (parsed.piSummary !== undefined && typeof parsed.piSummary !== "string") ||
      typeof parsed.rawTokens !== "number" ||
      typeof parsed.renderedTokens !== "number" ||
      typeof parsed.targetTokens !== "number" ||
      parsed.details === undefined ||
      typeof parsed.createdAt !== "string"
    ) {
      return undefined;
    }
    return parsed as CompactionCacheRecord;
  } catch {
    return undefined;
  }
}

export async function writeCompactionCache(cachePath: string, record: CompactionCacheRecord): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${stableStringify(record, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, cachePath);
}

export async function nextCacheGeneration(cachePath: string): Promise<number> {
  const existing = await readCompactionCache(cachePath);
  return (existing?.generation ?? 0) + 1;
}
