import { byteCount, estimateTokensFromText, stableStringify, truncateToTokens } from "../utils.js";
const IMPORTANT_KEY = /^(?:status|state|error|errors|message|code|id|ids|cursor|nextCursor|previousCursor|timestamp|createdAt|updatedAt|count|total|totalCount|hasMore|ok|success|failed|failure|warning|warnings|result|results)$/i;
const IDENTIFIER_KEY = /(?:^|_)(?:id|uuid|hash|sha|url|uri|path|name|key|token)$/i;
export function parseStructuredJson(text) {
    const trimmed = text.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("[")))
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
function isJsonRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function recordIsImportant(record) {
    return Object.entries(record).some(([key, value]) => {
        if (/error|fail|warn|outlier|invalid/i.test(key))
            return true;
        if (typeof value === "string" && /error|fail|warn|timeout|invalid|denied/i.test(value))
            return true;
        return false;
    });
}
function compactJson(value, depth, stats) {
    if (depth > 6)
        return "[nested value omitted]";
    if (Array.isArray(value)) {
        if (value.length <= 8)
            return value.map((item) => compactJson(item, depth + 1, stats));
        const important = value.filter((item) => isJsonRecord(item) && recordIsImportant(item)).slice(0, 4);
        const samples = [value[0], value[1], value[value.length - 2], value[value.length - 1]].filter((item) => item !== undefined);
        const selected = [];
        for (const item of [...important, ...samples]) {
            if (!selected.some((existing) => stableStringify(existing) === stableStringify(item)))
                selected.push(item);
        }
        stats.arraysReduced += 1;
        stats.recordsOmitted += Math.max(0, value.length - selected.length);
        return [
            ...selected.map((item) => compactJson(item, depth + 1, stats)),
            { __compacted__: true, originalCount: value.length, omittedCount: Math.max(0, value.length - selected.length) },
        ];
    }
    if (isJsonRecord(value)) {
        const result = {};
        const entries = Object.entries(value);
        for (const [key, child] of entries) {
            const smallPrimitive = child === null || ["string", "number", "boolean"].includes(typeof child);
            if (IMPORTANT_KEY.test(key) || IDENTIFIER_KEY.test(key) || entries.length <= 12 || (smallPrimitive && depth <= 1)) {
                result[key] = compactJson(child, depth + 1, stats);
            }
            else if (Array.isArray(child)) {
                result[key] = compactJson(child, depth + 1, stats);
            }
            else if (isJsonRecord(child) && recordIsImportant(child)) {
                result[key] = compactJson(child, depth + 1, stats);
            }
            else {
                stats.fieldsOmitted += 1;
            }
        }
        if (Object.keys(result).length === 0 && entries.length > 0) {
            const [key, child] = entries[0];
            result[key] = compactJson(child, depth + 1, stats);
        }
        if (stats.fieldsOmitted > 0 && depth === 0)
            result.__omittedFields__ = stats.fieldsOmitted;
        return result;
    }
    if (typeof value === "string" && value.length > 2_000)
        return `${value.slice(0, 1_500)}…[string truncated]`;
    return value;
}
function renderPlainJson(value, path = "root") {
    if (Array.isArray(value)) {
        return value.flatMap((item, index) => renderPlainJson(item, `${path}[${index}]`));
    }
    if (isJsonRecord(value)) {
        return Object.entries(value).flatMap(([key, child]) => renderPlainJson(child, path === "root" ? key : `${path}.${key}`));
    }
    const rendered = typeof value === "string" ? value.replace(/\r?\n/g, " ↩ ") : String(value);
    return [`${path}: ${rendered}`];
}
export function reduceStructuredJson(context, parsed = parseStructuredJson(context.block.exactText)) {
    if (parsed === undefined)
        return undefined;
    const stats = { arraysReduced: 0, recordsOmitted: 0, fieldsOmitted: 0 };
    const compacted = compactJson(parsed, 0, stats);
    let text = renderPlainJson(compacted).join("\n");
    text = truncateToTokens(text, context.maxTokens, "\n…[additional structured records omitted]…\n");
    const omissions = [];
    if (stats.recordsOmitted > 0) {
        omissions.push({
            description: `${stats.recordsOmitted} structured array record(s) omitted; errors, identifiers, boundary samples, and counts retained`,
            omittedBytes: Math.max(0, byteCount(context.block.exactText) - byteCount(text)),
        });
    }
    if (stats.fieldsOmitted > 0)
        omissions.push({ description: `${stats.fieldsOmitted} low-priority structured field(s) omitted` });
    return {
        text,
        reducer: "structured-json",
        version: "2.0.0",
        lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
        omissions,
        metadata: { ...stats },
    };
}
//# sourceMappingURL=json.js.map