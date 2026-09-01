import { createHash } from "node:crypto";
export function estimateTokensFromText(text) {
    return Math.max(1, Math.ceil(text.length / 4));
}
export function hashText(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 20);
}
export function stableStringify(value, space = 0) {
    const seen = new WeakSet();
    const normalize = (input) => {
        if (input === null || typeof input !== "object")
            return input;
        if (seen.has(input))
            return "[Circular]";
        seen.add(input);
        if (Array.isArray(input))
            return input.map(normalize);
        const record = input;
        const result = {};
        for (const key of Object.keys(record).sort())
            result[key] = normalize(record[key]);
        return result;
    };
    return JSON.stringify(normalize(value), null, space);
}
export function truncateToTokens(text, maxTokens, marker = "\n…[truncated]…") {
    if (estimateTokensFromText(text) <= maxTokens)
        return text;
    const maxChars = Math.max(0, maxTokens * 4 - marker.length);
    if (maxChars <= 0)
        return marker.trim();
    const headChars = Math.ceil(maxChars * 0.7);
    const tailChars = Math.floor(maxChars * 0.3);
    return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(-tailChars).trimStart()}`;
}
export function unique(items) {
    return [...new Set(items)];
}
export function compactWhitespace(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{4,}/g, "\n\n\n")
        .trim();
}
export function getString(value) {
    return typeof value === "string" ? value : undefined;
}
export function getBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
export function getNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function getRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
export function getArray(value) {
    return Array.isArray(value) ? value : undefined;
}
export function extractIdentifiers(text) {
    const identifiers = [];
    const patterns = [
        /https?:\/\/[^\s)\]}>"']+/g,
        /(?:^|[\s"'`(])((?:\.?\.?\/|~\/|\/)[A-Za-z0-9_.@+\-\/]+(?:\.[A-Za-z0-9_-]+)?)/gm,
        /\b[A-Fa-f0-9]{7,64}\b/g,
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        /\b(?:[A-Z][A-Z0-9_]{2,}|[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*){1,4})\b/g,
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const candidate = (match[1] ?? match[0]).trim();
            if (candidate.length >= 3 && candidate.length <= 240)
                identifiers.push(candidate);
            if (identifiers.length >= 80)
                return unique(identifiers);
        }
    }
    return unique(identifiers);
}
function omitCuedLongQuotes(text, pattern) {
    return text.replace(pattern, (match, _body, offset, source) => {
        const prefix = source.slice(Math.max(0, offset - 180), offset);
        const isReference = /\b(?:chatgpt|generated|output|quote|quoted|reference|report|response|said|transcript|what it said)\b/i.test(prefix);
        return isReference ? " [long quoted reference omitted for policy scan] " : match;
    });
}
export function directInstructionText(text) {
    const explicitlyDelimited = text.replace(/"([\s\S]{400,}?)"\s*\*{3}/g, " [long quoted reference omitted for policy scan] ***");
    return omitCuedLongQuotes(omitCuedLongQuotes(explicitlyDelimited, /"([\s\S]{400,}?)"/g), /“([\s\S]{400,}?)”/g);
}
export function hasRestrictionLanguage(text) {
    return /\b(?:must|must not|never|do not|don't|should not|shouldn't|cannot|can't|without changing|only|no longer|avoid|prohibit|forbid|required|restriction|correction|instead|not that|wrong)\b/i.test(text);
}
export function hasUnresolvedLanguage(text) {
    return /\b(?:unresolved|uncertain|unknown|still failing|still broken|not fixed|not yet|todo|tbd|open question|remaining|needs investigation|follow[- ]?up)\b/i.test(text);
}
export function hasFailureLanguage(text) {
    return /\b(?:error|failed|failure|exception|panic|fatal|timeout|assertion|expected\b.*\breceived|exit code\s*[1-9]|segfault|traceback)\b/i.test(text);
}
export function hasSuccessLanguage(text) {
    return /\b(?:passed|success(?:ful|fully)?|fixed|completed|done|resolved|green|exit code\s*0)\b/i.test(text);
}
export function lineCount(text) {
    if (text.length === 0)
        return 0;
    return text.split("\n").length;
}
export function byteCount(text) {
    return new TextEncoder().encode(text).byteLength;
}
export function orderedIncludes(haystack, needles) {
    let at = 0;
    for (const needle of needles) {
        const found = haystack.indexOf(needle, at);
        if (found < 0)
            return false;
        at = found + 1;
    }
    return true;
}
export function formatSourceRef(entryId, blockIndex) {
    return blockIndex === undefined ? `history_get("${entryId}")` : `history_get("${entryId}", blockIndex=${blockIndex})`;
}
export function safeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=utils.js.map