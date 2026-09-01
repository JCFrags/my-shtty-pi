import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashText, stableStringify } from "./utils.js";
export const CACHE_SCHEMA_VERSION = 4;
export function cachePathForSession(sessionPath) {
    return `${sessionPath}.chrono-compact.json`;
}
export function hashCompactionConfig(value) {
    return hashText(stableStringify(value));
}
export async function readCompactionCache(cachePath) {
    try {
        const parsed = JSON.parse(await readFile(cachePath, "utf8"));
        if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
            typeof parsed.generation !== "number" ||
            typeof parsed.sourceHash !== "string" ||
            typeof parsed.configHash !== "string" ||
            typeof parsed.summary !== "string" ||
            (parsed.piSummary !== undefined && typeof parsed.piSummary !== "string") ||
            typeof parsed.rawTokens !== "number" ||
            typeof parsed.renderedTokens !== "number" ||
            typeof parsed.targetTokens !== "number" ||
            parsed.details === undefined ||
            typeof parsed.createdAt !== "string") {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
export async function writeCompactionCache(cachePath, record) {
    await mkdir(dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${stableStringify(record, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, cachePath);
}
export async function nextCacheGeneration(cachePath) {
    const existing = await readCompactionCache(cachePath);
    return (existing?.generation ?? 0) + 1;
}
//# sourceMappingURL=cache.js.map