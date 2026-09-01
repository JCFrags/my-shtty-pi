import { parseHistoricalBlocks } from "./blocks.js";
import { buildCandidateUnits } from "./candidates.js";
import { resolveCompactorConfig } from "./compactor.js";
import { addRepeatedObservationCandidates } from "./repeated-observations.js";
import { estimateTokensFromText, getArray, getBoolean, getRecord, getString, hashText, hasRestrictionLanguage, hasUnresolvedLanguage, stableStringify, } from "./utils.js";
const FAILURE_EVIDENCE = /(?:^|\n).*\b(?:error|warning|failed|failure|fatal|panic|traceback|segfault|segmentation fault|unhealthy|refused|corrupt(?:ed|ion)?|mismatch|denied|cancelled|canceled|aborted|exception|timed out|timeout|permission)\b/im;
const TERMINAL_TOOL = /^(?:bash|shell|terminal|exec|execute|command|run)$/i;
const IMPORTANT_DETAIL_KEY = /(?:^|_)(?:exit|code|status|count|total|passed|failed|warning|error|cancel|abort|cwd|path|file|command|query|pattern|truncat)/i;
function sourceFingerprint(message) {
    return hashText(stableStringify({
        role: message.role,
        toolCallId: getString(message.toolCallId),
        toolName: getString(message.toolName),
        isError: getBoolean(message.isError),
        content: message.content,
        details: message.details,
    }));
}
function contentText(content) {
    if (typeof content === "string")
        return { text: content, hasImage: false, hasUnsupportedContent: false };
    const blocks = getArray(content);
    if (!blocks)
        return { text: "", hasImage: false, hasUnsupportedContent: content !== undefined };
    const text = [];
    let hasImage = false;
    let hasUnsupportedContent = false;
    for (const item of blocks) {
        const block = getRecord(item);
        if (block?.type === "text" && typeof block.text === "string")
            text.push(block.text);
        else if (block?.type === "image")
            hasImage = true;
        else
            hasUnsupportedContent = true;
    }
    return { text: text.join("\n"), hasImage, hasUnsupportedContent };
}
function toolCalls(message) {
    if (message.role !== "assistant")
        return [];
    return (getArray(message.content) ?? []).flatMap((item) => {
        const block = getRecord(item);
        return block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string"
            ? [{ id: block.id, name: block.name }]
            : [];
    });
}
function numericCode(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
        return Number(value);
    return undefined;
}
function detailRecords(value, depth = 0) {
    if (depth > 3)
        return [];
    const record = getRecord(value);
    if (!record)
        return [];
    return [record, ...Object.values(record).flatMap((item) => detailRecords(item, depth + 1))];
}
function terminalOutcomeKnownSuccessful(info) {
    if (!TERMINAL_TOOL.test(info.toolName))
        return true;
    const records = detailRecords(info.message.details);
    for (const record of records) {
        for (const key of ["exitCode", "exit_code", "code"]) {
            const code = numericCode(record[key]);
            if (code !== undefined)
                return code === 0;
        }
    }
    return /(?:^|\n)\s*(?:exit(?:ed)?[ _-]*(?:code|status)|exit_code)\s*[:=]\s*0\b/im.test(info.text);
}
function hasStructuredFailure(message) {
    if (message.isError !== false)
        return true;
    for (const record of detailRecords(message.details)) {
        for (const key of ["exitCode", "exit_code", "code"]) {
            const code = numericCode(record[key]);
            if (code !== undefined && code !== 0)
                return true;
        }
        for (const key of ["cancelled", "canceled", "aborted"])
            if (record[key] === true)
                return true;
        const status = getString(record.status) ?? getString(record.state);
        if (status && /^(?:error|fail(?:ed|ure)?|abort(?:ed)?|cancel(?:led|ed)?)$/i.test(status.trim()))
            return true;
    }
    return false;
}
function laterUserCites(messages, info) {
    const laterUserText = messages
        .slice(info.index + 1)
        .filter((message) => message.role === "user")
        .map((message) => contentText(message.content).text)
        .join("\n");
    if (!laterUserText)
        return false;
    return info.text.split("\n").some((line) => {
        const exact = line.trim();
        return exact.length >= 16 && exact.length <= 500 && laterUserText.includes(exact);
    });
}
function isProtectedProjectionResult(messages, info, options) {
    return options.pinnedToolCallIds?.has(info.toolCallId) === true
        || info.hasImage
        || info.hasUnsupportedContent
        || hasStructuredFailure(info.message)
        || !terminalOutcomeKnownSuccessful(info)
        || FAILURE_EVIDENCE.test(info.text)
        || hasRestrictionLanguage(info.text)
        || hasUnresolvedLanguage(info.text)
        || laterUserCites(messages, info);
}
function safeDetails(value) {
    const result = {};
    const record = getRecord(value);
    if (!record)
        return result;
    for (const [key, item] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
        if (!IMPORTANT_DETAIL_KEY.test(key) || Object.keys(result).length >= 32)
            continue;
        if (item === null || typeof item === "boolean" || typeof item === "number")
            result[key] = item;
        else if (typeof item === "string" && item.length <= 512)
            result[key] = item;
    }
    return result;
}
function syntheticEntries(messages, resultEntryIds) {
    const entries = [];
    let parentId = null;
    messages.forEach((message, index) => {
        if (!["user", "assistant", "toolResult"].includes(message.role))
            return;
        const id = resultEntryIds.get(index) ?? `context-${index}`;
        entries.push({ type: "message", id, parentId, message });
        parentId = id;
    });
    return entries;
}
function candidateForProjection(unit, mode, minimumSavedTokens) {
    if (!unit)
        return undefined;
    const eligible = unit.candidates.filter((candidate) => {
        if (!candidate.lossy || candidate.tokens + minimumSavedTokens > unit.rawTokens)
            return false;
        if (candidate.level === "raw" || candidate.level === "normalized" || candidate.level === "absent")
            return false;
        if (mode === "safe" && (candidate.level === "marker" || candidate.reducer === "historical-marker"))
            return false;
        return true;
    });
    if (mode === "aggressive") {
        const repeat = eligible.find((candidate) => candidate.reducer === "exact-repeat");
        if (repeat)
            return repeat;
    }
    return eligible.sort((left, right) => right.utility - left.utility || left.tokens - right.tokens || left.id.localeCompare(right.id))[0];
}
function placeholder(info, candidate) {
    const recovery = `history_get(${stableStringify({ entryId: info.entryId })})`;
    return [
        "[ChronoCompact request-local tool-result projection]",
        `Tool: ${info.toolName}. Call ID: ${info.toolCallId}. Outcome: successful.`,
        candidate.text,
        `Original estimated tokens: ${info.sourceTokens}. Projected reducer: ${candidate.reducer ?? candidate.level}.`,
        `Original content SHA-256 prefix: ${hashText(info.text)}.`,
        `Exact recovery: ${recovery}. The immutable session JSONL remains authoritative.`,
    ].join("\n");
}
function emptyMetrics(mode, sourceTokens, refusalReason) {
    return {
        mode,
        sourceTokens,
        projectedTokens: sourceTokens,
        removedTokens: 0,
        totalToolResults: 0,
        projectedToolResults: 0,
        exactRecoveryCovered: 0,
        keptRecent: 0,
        keptFirstConsumption: 0,
        protectedResults: 0,
        tooSmallResults: 0,
        refusedResults: 0,
        reducerFamilies: {},
        ...(refusalReason === undefined ? {} : { refusalReason }),
    };
}
function requestRefusal(messages, mode, sourceTokens, resultCount, newlySeenToolCallIds, refusalReason) {
    return {
        messages,
        metrics: {
            ...emptyMetrics(mode, sourceTokens, refusalReason),
            totalToolResults: resultCount,
            refusedResults: resultCount,
        },
        newlySeenToolCallIds,
    };
}
export async function projectToolResultContext(messages, options = {}) {
    const mode = options.mode ?? "off";
    const sourceTokens = messages.reduce((sum, message) => sum + estimateTokensFromText(contentText(message.content).text), 0);
    const newlySeen = new Set();
    if (mode === "off")
        return { messages, metrics: emptyMetrics(mode, sourceTokens), newlySeenToolCallIds: newlySeen };
    const calls = new Map();
    let pairRefusal;
    messages.forEach((message, index) => {
        for (const call of toolCalls(message)) {
            if (calls.has(call.id))
                pairRefusal = `duplicate tool call ID ${call.id}`;
            else
                calls.set(call.id, { index, name: call.name });
        }
    });
    const results = [];
    const seenResults = new Set();
    messages.forEach((message, index) => {
        if (message.role !== "toolResult")
            return;
        const toolCallId = getString(message.toolCallId);
        if (!toolCallId || !calls.has(toolCallId) || (calls.get(toolCallId)?.index ?? index) >= index) {
            pairRefusal = `orphan or malformed tool result at message ${index}`;
            return;
        }
        if (seenResults.has(toolCallId)) {
            pairRefusal = `duplicate tool result for call ID ${toolCallId}`;
            return;
        }
        seenResults.add(toolCallId);
        const rendered = contentText(message.content);
        const info = {
            message,
            index,
            toolCallId,
            toolName: getString(message.toolName) ?? calls.get(toolCallId)?.name ?? "unknown",
            text: rendered.text,
            sourceTokens: estimateTokensFromText(rendered.text),
            entryId: options.sourceByToolCallId?.get(toolCallId)?.entryId,
            hasImage: rendered.hasImage,
            hasUnsupportedContent: rendered.hasUnsupportedContent,
        };
        results.push(info);
        if (!options.seenToolCallIds?.has(toolCallId))
            newlySeen.add(toolCallId);
    });
    if (pairRefusal) {
        return {
            messages,
            metrics: { ...emptyMetrics(mode, sourceTokens, pairRefusal), totalToolResults: results.length, refusedResults: results.length },
            newlySeenToolCallIds: newlySeen,
        };
    }
    const validatedSources = new Map();
    const entryOwners = new Map();
    for (const info of results) {
        const source = options.sourceByToolCallId?.get(info.toolCallId);
        if (!source) {
            return requestRefusal(messages, mode, sourceTokens, results.length, newlySeen, `missing authoritative source binding for call ID ${info.toolCallId}`);
        }
        if (typeof source.entryId !== "string" || source.entryId.length === 0) {
            return requestRefusal(messages, mode, sourceTokens, results.length, newlySeen, `invalid authoritative source entry identity for call ID ${info.toolCallId}`);
        }
        if (source.toolCallId !== info.toolCallId) {
            return requestRefusal(messages, mode, sourceTokens, results.length, newlySeen, `authoritative source call ID mismatch for call ID ${info.toolCallId}`);
        }
        if (source.sourceFingerprint !== sourceFingerprint(info.message)) {
            return requestRefusal(messages, mode, sourceTokens, results.length, newlySeen, `authoritative source fingerprint mismatch for call ID ${info.toolCallId}`);
        }
        const entryOwner = entryOwners.get(source.entryId);
        if (entryOwner !== undefined && entryOwner !== info.toolCallId) {
            return requestRefusal(messages, mode, sourceTokens, results.length, newlySeen, `authoritative source entry identity ${source.entryId} is shared by call IDs ${entryOwner} and ${info.toolCallId}`);
        }
        entryOwners.set(source.entryId, info.toolCallId);
        validatedSources.set(info.toolCallId, source);
    }
    const unsupported = results.find((info) => info.hasUnsupportedContent);
    if (unsupported) {
        return requestRefusal(messages, mode, sourceTokens, results.length, newlySeen, `unsupported tool result content for call ID ${unsupported.toolCallId}`);
    }
    const resultEntryIds = new Map(results.map((info) => [info.index, validatedSources.get(info.toolCallId).entryId]));
    const blocks = parseHistoricalBlocks(syntheticEntries(messages, resultEntryIds), {
        includeHistoricalCompactions: false,
        includeMetadata: false,
    });
    const config = resolveCompactorConfig({
        targetTokens: 4_000,
        enableSemanticCompression: false,
        emergencyAllowAbsent: false,
        mergeEpisodes: false,
    });
    const units = addRepeatedObservationCandidates(await buildCandidateUnits(blocks, config), blocks);
    const unitByEntry = new Map(units.filter((unit) => unit.kind === "tool_result").map((unit) => [unit.sourceRefs[0]?.entryId, unit]));
    const keepRecent = Math.max(1, Math.floor(options.keepRecentResults ?? 3));
    const minimumSourceTokens = Math.max(64, Math.floor(options.minimumSourceTokens ?? 256));
    const minimumSavedTokens = Math.max(32, Math.floor(options.minimumSavedTokens ?? 100));
    const recentIndexes = new Set(results.slice(-keepRecent).map((info) => info.index));
    const canonicalIndexes = new Set();
    const indexesByContent = new Map();
    for (const info of results) {
        const key = `${info.toolName}\0${info.text}`;
        const indexes = indexesByContent.get(key) ?? [];
        indexes.push(info.index);
        indexesByContent.set(key, indexes);
    }
    for (const indexes of indexesByContent.values()) {
        if (indexes.length > 1 && indexes[0] !== undefined)
            canonicalIndexes.add(indexes[0]);
    }
    let keptRecent = 0;
    let keptFirstConsumption = 0;
    let protectedResults = 0;
    let tooSmallResults = 0;
    let refusedResults = 0;
    let exactRecoveryCovered = 0;
    const families = {};
    const projected = [...messages];
    for (const info of results) {
        if (recentIndexes.has(info.index) || canonicalIndexes.has(info.index)) {
            keptRecent += recentIndexes.has(info.index) ? 1 : 0;
            continue;
        }
        if (newlySeen.has(info.toolCallId)) {
            keptFirstConsumption += 1;
            continue;
        }
        if (isProtectedProjectionResult(messages, info, options)) {
            protectedResults += 1;
            continue;
        }
        if (info.sourceTokens < minimumSourceTokens) {
            tooSmallResults += 1;
            continue;
        }
        const source = validatedSources.get(info.toolCallId);
        const entryKey = source.entryId;
        const candidate = candidateForProjection(unitByEntry.get(entryKey), mode, minimumSavedTokens);
        if (!candidate) {
            refusedResults += 1;
            continue;
        }
        const replacement = placeholder(info, candidate);
        const replacementTokens = estimateTokensFromText(replacement);
        if (replacementTokens + minimumSavedTokens > info.sourceTokens) {
            tooSmallResults += 1;
            continue;
        }
        const removedTokens = info.sourceTokens - replacementTokens;
        const family = candidate.reducer ?? candidate.level;
        const prior = families[family] ?? { results: 0, removedTokens: 0 };
        families[family] = { results: prior.results + 1, removedTokens: prior.removedTokens + removedTokens };
        projected[info.index] = {
            ...info.message,
            content: [{ type: "text", text: replacement }],
            details: {
                ...safeDetails(info.message.details),
                chronoProjection: {
                    schemaVersion: 1,
                    requestLocal: true,
                    reducer: family,
                    originalTokens: info.sourceTokens,
                    projectedTokens: replacementTokens,
                    entryId: info.entryId,
                    contentHash: hashText(info.text),
                },
            },
        };
        exactRecoveryCovered += 1;
    }
    const projectedTokens = projected.reduce((sum, message) => sum + estimateTokensFromText(contentText(message.content).text), 0);
    return {
        messages: projected,
        metrics: {
            mode,
            sourceTokens,
            projectedTokens,
            removedTokens: sourceTokens - projectedTokens,
            totalToolResults: results.length,
            projectedToolResults: exactRecoveryCovered,
            exactRecoveryCovered,
            keptRecent,
            keptFirstConsumption,
            protectedResults,
            tooSmallResults,
            refusedResults,
            reducerFamilies: families,
        },
        newlySeenToolCallIds: newlySeen,
    };
}
export function projectionSourcesFromBranch(entries) {
    const result = new Map();
    const ambiguous = new Set();
    for (const entry of entries) {
        if (entry.type !== "message" || typeof entry.id !== "string")
            continue;
        const message = getRecord(entry.message);
        if (message?.role !== "toolResult")
            continue;
        const toolCallId = getString(message.toolCallId);
        if (!toolCallId)
            continue;
        if (result.has(toolCallId)) {
            result.delete(toolCallId);
            ambiguous.add(toolCallId);
            continue;
        }
        if (ambiguous.has(toolCallId))
            continue;
        result.set(toolCallId, {
            entryId: entry.id,
            toolCallId,
            sourceFingerprint: sourceFingerprint(message),
        });
    }
    return result;
}
export function validateProjectedToolPairs(messages) {
    const calls = new Map();
    const results = new Set();
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        for (const call of toolCalls(message)) {
            if (calls.has(call.id))
                return { ok: false, reason: `duplicate call ${call.id}` };
            calls.set(call.id, index);
        }
        if (message.role !== "toolResult")
            continue;
        const id = getString(message.toolCallId);
        if (!id || !calls.has(id) || (calls.get(id) ?? index) >= index)
            return { ok: false, reason: `orphan result at ${index}` };
        if (results.has(id))
            return { ok: false, reason: `duplicate result ${id}` };
        results.add(id);
    }
    return { ok: true, reason: "all tool results have one preceding call" };
}
//# sourceMappingURL=context-projection.js.map