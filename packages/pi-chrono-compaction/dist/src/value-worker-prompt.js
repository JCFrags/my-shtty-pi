import { createHash } from "node:crypto";
import { estimateTokensFromText, stableStringify } from "./utils.js";
export const VALUE_WORKER_EXCERPT_CHARACTERS = 600;
export const VALUE_WORKER_PROMPT_SCHEMA_HASH = createHash("sha256").update("chrono-value-worker-prompt-v4").digest("hex");
function sanitizeExcerpt(text, record) { let value = text; for (const candidate of record.candidates) {
    for (const ref of candidate.sourceRefs)
        value = value.split(ref.entryId).join("[source-id]");
    for (const [key, metadata] of Object.entries(candidate.metadata))
        if (/path|source|revision|reference/i.test(key) && typeof metadata === "string" && metadata.length > 0)
            value = value.split(metadata).join("[metadata]");
} return value.replace(/\b[0-9a-f]{8}(?:[0-9a-f-]{0,55}[0-9a-f])?\b/gi, "[identifier]").replace(/(?:\.{0,2}\/)?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+/g, "[path]").replace(/[A-Z]:\\[^\s"'`]+/gi, "[path]").replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[credential]").replace(/\b(api[_-]?key|token|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[credential]"); }
function role(kind) { return kind === "user" ? "user" : kind === "custom_message" ? "custom" : kind.startsWith("assistant") ? "assistant" : kind.includes("tool") || kind === "bash_execution" ? "tool" : "other"; }
export function buildValueWorkerItems(records, maximumItems) {
    const items = [];
    const privateIds = new Map();
    for (const [index, record] of records.entries()) {
        if (items.length >= maximumItems)
            break;
        const c = record.candidates.filter(x => x.level !== "absent").sort((a, b) => a.tokens - b.tokens)[0];
        if (!c)
            continue;
        const kind = String(record.blockKind ?? "other");
        const sourceRole = role(kind);
        const safetyFloor = sourceRole === "user" || sourceRole === "custom" || Boolean(c.metadata.protectedExact) || Boolean(c.metadata.unresolved) || Boolean(record.unresolved);
        const opaque = `i${index.toString(36).padStart(4, "0")}`;
        privateIds.set(opaque, record.blockId);
        const eligible = (sourceRole === "assistant" || kind === "tool_result") && !safetyFloor && c.lossy && c.tokens < c.rawTokens;
        const raw = eligible ? sanitizeExcerpt(c.text, record) : "";
        const excerpt = raw.slice(0, VALUE_WORKER_EXCERPT_CHARACTERS);
        items.push({ itemId: opaque, sourceRole, blockKind: kind, candidateKind: c.reducer ?? c.level, error: Boolean(record.isError), unresolved: Boolean(record.unresolved), reproducible: Boolean(record.reproducible), candidateLevels: record.candidates.map(x => x.level), candidateTokenSizes: record.candidates.map(x => x.tokens), staticImportance: safetyFloor ? "critical" : "normal", compressionRisk: safetyFloor ? "high" : "medium", ...(excerpt ? { excerpt } : {}), textBounded: raw.length > excerpt.length, identifierCount: record.identifierCount ?? 0, duplicate: false, ageBand: index < records.length / 3 ? "old" : index < records.length * 2 / 3 ? "middle" : "recent", safetyFloor });
    }
    return { items, privateIds };
}
export function valueWorkerPrompt(items, maxOutputTokens) { return ["You give non-authoritative value advice only.", "Deterministic code owns final text, chronology, source links, lifecycle state, token limits, and validation.", "Do not write a replay. Do not summarize the session. Do not copy excerpts.", "Return JSON only. Omitted items keep deterministic behavior. Protected and authority items cannot be downgraded.", "Age does not override current importance. Treat failures, blockers, corrections, and unresolved work carefully. Routine reproducible output can have lower value. Exact recovery remains available.", '{"version":1,"items":[{"itemId":"...","semanticClass":"instruction|goal|decision|plan|blocker|failure|result|evidence|resource|status|routine|duplicate|unknown","importance":"critical|high|normal|low","compressionRisk":"high|medium|low","reuseLikelihood":"high|medium|low","uniqueness":"high|medium|low","action":"keep|compress|neutral","confidence":0.0}]}', `Output limit: ${maxOutputTokens} estimated tokens.`, "<bounded-items>", stableStringify(items), "</bounded-items>"].join("\n"); }
export function boundedValueWorkerBatch(records, maxItems, maxInputTokens, maxOutputTokens) { let count = Math.min(maxItems, records.length); while (count > 0) {
    const built = buildValueWorkerItems(records.slice(0, count), count);
    const prompt = valueWorkerPrompt(built.items, maxOutputTokens);
    if (estimateTokensFromText(prompt) <= maxInputTokens)
        return { ...built, prompt, inputTokens: estimateTokensFromText(prompt), consumed: count };
    count--;
} return { items: [], privateIds: new Map(), prompt: "", inputTokens: 0, consumed: 0 }; }
//# sourceMappingURL=value-worker-prompt.js.map