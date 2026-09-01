import { analyzeBlockHistory } from "./history-analysis.js";
import { normalizeBlock, reduceBlock, reducePersistentBlock, REDUCER_VERSIONS } from "./reducers/index.js";
import { compactWhitespace, directInstructionText, estimateTokensFromText, getNumber, getRecord, getString, hasFailureLanguage, hashText, stableStringify, truncateToTokens, unique, } from "./utils.js";
const MAX_PRECOMPUTED_CANDIDATES_PER_BLOCK = 8;
const MAX_PRECOMPUTED_CANDIDATE_TEXT_CHARS = 64 * 1024;
const PRECOMPUTED_REDUCER_VERSIONS = Object.freeze({
    terminal: REDUCER_VERSIONS.terminal,
    "test-output": REDUCER_VERSIONS["test-output"],
    "file-read": REDUCER_VERSIONS["file-read"],
    "git-diff": REDUCER_VERSIONS["git-diff"],
    "search-results": REDUCER_VERSIONS["search-results"],
    "structured-json": REDUCER_VERSIONS["structured-json"],
    "assistant-extractive": REDUCER_VERSIONS["assistant-extractive"],
    "assistant-cleanup": REDUCER_VERSIONS["assistant-cleanup"],
    "generic-text": REDUCER_VERSIONS["generic-text"],
    "tool-arguments": "1.0.0",
    "tool-call-marker": "1.0.0",
    "historical-marker": "1.0.0",
    absent: "1.0.0",
});
const GENERIC_RETENTION_TERMS = new Set([
    "abandoned",
    "advisory",
    "completed",
    "compaction",
    "compress",
    "current",
    "evidence",
    "exact",
    "failures",
    "historical",
    "instructions",
    "manual",
    "needed",
    "older",
    "preserve",
    "ranges",
    "restrictions",
    "retention",
    "unresolved",
    "work",
]);
function candidateRecordIntegrityHash(blockId, key, candidates, metadata) {
    return hashText(stableStringify({ schema: 3, blockId, key, candidates, metadata }));
}
const BASE_IMPORTANCE = {
    user: 125,
    assistant_reasoning: 72,
    assistant_text: 68,
    tool_call: 82,
    tool_result: 64,
    bash_execution: 68,
    branch_summary: 80,
    custom_message: 95,
    model_change: 16,
    thinking_level_change: 12,
    historical_compaction: 8,
    metadata: 6,
};
function recordedExitCode(block) {
    const details = getRecord(block.attributes.details);
    const structured = getNumber(block.attributes.exitCode) ?? getNumber(details?.exitCode) ?? getNumber(details?.code);
    if (structured !== undefined)
        return structured;
    const exact = block.exactText.match(/\bexit code:\s*(-?\d+)/i)?.[1];
    return exact === undefined ? undefined : Number(exact);
}
function hasDecisiveFailureEvidence(block) {
    if (block.isError === true)
        return true;
    if (block.kind === "bash_execution" || (block.kind === "tool_result" && /^(?:bash|shell|terminal|exec)$/i.test(block.toolName ?? ""))) {
        const exitCode = recordedExitCode(block);
        if (exitCode !== undefined)
            return exitCode !== 0;
        if (block.isError === false)
            return false;
        return hasFailureLanguage(block.exactText);
    }
    return (block.kind === "user" ||
        block.kind === "custom_message" ||
        block.kind === "assistant_reasoning" ||
        block.kind === "assistant_text" ||
        block.kind === "branch_summary") && hasFailureLanguage(block.exactText);
}
function hasUnresolvedTaskEvidence(block) {
    return (block.unresolved &&
        (block.kind === "user" ||
            block.kind === "custom_message" ||
            block.kind === "assistant_reasoning" ||
            block.kind === "assistant_text" ||
            block.kind === "branch_summary"));
}
function scoreImportance(block, index, total, retentionHints = "", historyAnalysis) {
    let score = BASE_IMPORTANCE[block.kind] + (historyAnalysis?.importanceAdjustment ?? 0);
    const recency = total <= 1 ? 1 : index / (total - 1);
    score *= 0.72 + recency * 0.28;
    if (block.protectedExact)
        score += 220;
    if (hasUnresolvedTaskEvidence(block))
        score += 90;
    if (hasDecisiveFailureEvidence(block))
        score += 85;
    if (block.reproducible && !block.isError)
        score -= 16;
    if (block.kind === "assistant_text") {
        const phase = getString(block.attributes.phase);
        if (phase === "preamble")
            score -= 28;
        if (phase === "final")
            score += 20;
    }
    if (block.kind === "tool_result" && block.rawTokens > 2_000 && !block.isError)
        score -= 10;
    if (block.exactIdentifiers.length > 0)
        score += Math.min(20, block.exactIdentifiers.length * 2);
    if (retentionHints.trim()) {
        const hintTerms = unique([
            ...block.exactIdentifiers.filter((identifier) => retentionHints.includes(identifier)),
            ...retentionHints
                .toLowerCase()
                .split(/[^a-z0-9_./-]+/)
                .map((term) => term.replace(/^[./-]+|[.,;:/-]+$/g, ""))
                .filter((term) => term.length >= 5 &&
                !GENERIC_RETENTION_TERMS.has(term) &&
                block.exactText.toLowerCase().includes(term))
                .slice(0, 20),
        ]);
        if (hintTerms.length > 0)
            score += Math.min(180, 55 + hintTerms.length * 15);
    }
    return Math.max(1, score);
}
function candidate(block, level, text, utility, options = {}) {
    const base = {
        id: `${block.id}:${level}:${options.reducer ?? "native"}`,
        level,
        text,
        tokens: estimateTokensFromText(text),
        rawTokens: block.rawTokens,
        utility,
        lossy: options.lossy ?? (level !== "raw" && level !== "normalized"),
        omissions: options.omissions ?? [],
        sourceRefs: block.sourceRefs,
        metadata: options.metadata ?? {},
    };
    return {
        ...base,
        ...(options.reducer === undefined ? {} : { reducer: options.reducer }),
        ...(options.reducerVersion === undefined ? {} : { reducerVersion: options.reducerVersion }),
    };
}
function reducedBudget(block, config) {
    switch (block.kind) {
        case "assistant_reasoning":
            return Math.min(config.semanticMaxTokens, Math.max(70, Math.ceil(block.rawTokens * 0.24)));
        case "assistant_text":
            return Math.min(320, Math.max(60, Math.ceil(block.rawTokens * 0.32)));
        case "tool_result":
        case "bash_execution":
            return Math.min(620, Math.max(120, Math.ceil(block.rawTokens * 0.14)));
        case "user":
        case "custom_message":
            return Math.min(800, Math.max(180, Math.ceil(block.rawTokens * 0.55)));
        case "branch_summary":
            return Math.min(320, Math.max(100, Math.ceil(block.rawTokens * 0.5)));
        default:
            return Math.min(240, Math.max(60, Math.ceil(block.rawTokens * 0.35)));
    }
}
function looksLikeGeneratedOutput(block) {
    const command = getString(block.toolArguments?.command) ?? getString(block.attributes.command) ?? "";
    if (/(?:\bsource[-_.]?map\b|\.map\b|\.min\.(?:js|css)\b)/i.test(command))
        return true;
    const lines = block.exactText.split("\n");
    const longest = lines.reduce((maximum, line) => Math.max(maximum, line.length), 0);
    return block.exactText.length > 8_000 && (lines.length <= 4 || longest > 4_000);
}
function markerText(block) {
    const firstUseful = compactWhitespace(block.exactText)
        .split(/\n|(?<=[.!?])\s+/)
        .find((line) => line.trim().length > 0);
    const excerpt = firstUseful ? truncateToTokens(firstUseful, 36, "…") : "No textual excerpt available.";
    if (block.kind === "tool_call") {
        const importantArgumentNames = ["command", "path", "file_path", "file", "query", "pattern", "cwd", "url"];
        const importantArguments = Object.fromEntries(importantArgumentNames.flatMap((name) => {
            const value = block.toolArguments?.[name];
            if (typeof value !== "string" || value.length === 0)
                return [];
            return [[name, truncateToTokens(value, 28, "…")]];
        }));
        const argumentText = Object.keys(importantArguments).length > 0
            ? stableStringify(importantArguments)
            : `Representative exact excerpt: ${excerpt}`;
        return [
            `Historical ${block.toolName ?? "tool"} call.`,
            argumentText,
            "Detailed arguments omitted from active context; exact source remains recoverable.",
        ].join("\n");
    }
    if (block.kind === "tool_result" || block.kind === "bash_execution") {
        const command = getString(block.toolArguments?.command) ?? getString(block.attributes.command);
        const path = getString(block.toolArguments?.path) ?? getString(block.toolArguments?.file_path);
        const generated = looksLikeGeneratedOutput(block);
        return [
            `Historical ${block.toolName ?? "tool"} result (${block.isError ? "error/failure" : "non-error"}).`,
            command ? `Command: ${command}` : "",
            path ? `Path: ${path}` : "",
            generated
                ? "Representative excerpt omitted because the output appears machine-generated, minified, or source-map encoded."
                : `Representative exact excerpt: ${excerpt}`,
            "Detailed output omitted from active context; exact source remains recoverable.",
        ]
            .filter(Boolean)
            .join("\n");
    }
    if (block.kind === "assistant_reasoning") {
        return `Historical assistant reasoning marker. Representative exact excerpt: ${excerpt}\nDetailed reasoning omitted; exact source remains recoverable.`;
    }
    if (block.kind === "assistant_text") {
        return `Historical assistant text marker. Representative exact excerpt: ${excerpt}\nRemaining prose omitted; exact source remains recoverable.`;
    }
    return `Historical ${block.label.toLowerCase()} marker. Representative exact excerpt: ${excerpt}\nExact source remains recoverable.`;
}
function compactUnknown(value, depth, omissions) {
    if (depth > 5) {
        omissions.count += 1;
        return "[nested value omitted]";
    }
    if (typeof value === "string") {
        if (value.length <= 800)
            return value;
        omissions.count += 1;
        return `${value.slice(0, 520)}…[${value.length - 520} chars omitted]`;
    }
    if (Array.isArray(value)) {
        if (value.length <= 8)
            return value.map((item) => compactUnknown(item, depth + 1, omissions));
        omissions.count += value.length - 4;
        return [
            ...value.slice(0, 3).map((item) => compactUnknown(item, depth + 1, omissions)),
            `[${value.length - 4} array item(s) omitted]`,
            compactUnknown(value[value.length - 1], depth + 1, omissions),
        ];
    }
    if (value !== null && typeof value === "object") {
        const record = value;
        const result = {};
        for (const key of Object.keys(record).sort()) {
            const critical = /^(?:command|path|file|file_path|query|pattern|id|url|method|cwd|offset|limit|line|start|end|revision|ref)$/i.test(key);
            const child = record[key];
            if (critical || Object.keys(record).length <= 12)
                result[key] = compactUnknown(child, depth + 1, omissions);
            else if (typeof child === "string" && child.length <= 240)
                result[key] = child;
            else
                omissions.count += 1;
        }
        return result;
    }
    return value;
}
function reduceToolCall(block) {
    if (!block.toolArguments || block.rawTokens < 280)
        return undefined;
    const omissions = { count: 0 };
    const compacted = compactUnknown(block.toolArguments, 0, omissions);
    const text = `${block.toolName ?? "tool"}(${stableStringify(compacted)})`;
    if (estimateTokensFromText(text) >= block.rawTokens * 0.9)
        return undefined;
    return candidate(block, "reduced", text, 0.9, {
        reducer: "tool-arguments",
        reducerVersion: "1.0.0",
        lossy: true,
        omissions: [{ description: `${omissions.count} oversized or low-priority tool-argument value(s) omitted` }],
        metadata: { omittedValues: omissions.count },
    });
}
function dedupeCandidates(candidates) {
    const sorted = [...candidates].sort((a, b) => a.tokens - b.tokens || a.utility - b.utility);
    const output = [];
    for (const item of sorted) {
        const duplicate = output.some((existing) => existing.text === item.text && existing.level === item.level);
        if (!duplicate)
            output.push(item);
    }
    return output;
}
export function candidatePrecomputeKey(block, laterText, config) {
    return hashText(stableStringify({ schema: 1, block, laterText, config: {
            semanticMaxTokens: config.semanticMaxTokens, enableSemanticCompression: config.enableSemanticCompression,
            emergencyAllowAbsent: config.emergencyAllowAbsent
        }, reducerVersions: REDUCER_VERSIONS }));
}
export function persistentCandidateKey(block, config) {
    return hashText(stableStringify({ schema: 1, dependency: candidateDependency(block), block, config: {
            semanticMaxTokens: config.semanticMaxTokens, emergencyAllowAbsent: config.emergencyAllowAbsent
        }, reducerVersions: REDUCER_VERSIONS }));
}
export function candidateDependency(block) {
    return block.kind === "tool_result" && typeof block.attributes.pairedCallEntryId === "string" ? "pairing-dependent" : "source-local";
}
export function isFutureSensitiveReducer(reducer) {
    return reducer === "file-read" || reducer === "search-results" || reducer === "llm-semantic";
}
function sourceRefsMatchBlock(candidate, block) {
    if (!Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length !== block.sourceRefs.length)
        return false;
    return candidate.sourceRefs.every((ref, index) => {
        const expected = block.sourceRefs[index];
        return ref !== null
            && typeof ref === "object"
            && typeof ref.entryId === "string"
            && ref.entryId === expected?.entryId
            && ref.blockIndex === expected?.blockIndex;
    });
}
function expectedCachedCandidateShape(block, config, reducer) {
    if (reducer === "tool-arguments" && block.kind === "tool_call")
        return { level: "reduced", utility: 0.9 };
    if (reducer === "tool-call-marker" && block.kind === "tool_call")
        return { level: "marker", utility: 0.34 };
    if (reducer === "historical-marker" && !["user", "custom_message", "tool_call"].includes(block.kind)) {
        return { level: "marker", utility: block.kind === "tool_result" && block.isError ? 0.5 : 0.28 };
    }
    if (reducer === "absent" && config.emergencyAllowAbsent) {
        const phase = getString(block.attributes.phase);
        if (block.kind === "metadata" || block.kind === "historical_compaction" || (block.kind === "assistant_text" && phase === "preamble")) {
            return { level: "absent", utility: 0 };
        }
    }
    if (["assistant-extractive", "assistant-cleanup"].includes(reducer)) {
        if (!["assistant_reasoning", "assistant_text", "branch_summary", "custom_message", "user"].includes(block.kind))
            return undefined;
        const level = block.kind === "assistant_reasoning" || block.kind === "assistant_text" ? "semantic" : "reduced";
        return { level, utility: level === "semantic" ? 0.76 : 0.82 };
    }
    if (["terminal", "test-output", "file-read", "git-diff", "search-results", "structured-json"].includes(reducer)) {
        if (block.kind !== "tool_result" && block.kind !== "bash_execution")
            return undefined;
        return { level: "reduced", utility: 0.82 };
    }
    if (reducer === "generic-text" && !["tool_call", "assistant_reasoning", "assistant_text", "branch_summary", "custom_message", "user"].includes(block.kind)) {
        return { level: "reduced", utility: 0.82 };
    }
    return undefined;
}
/**
 * Validate persisted background candidates against the current authoritative
 * block immediately before official compaction can use them.
 */
function validatedPrecomputedRecord(precomputed, block, expectedKey, config) {
    if (!precomputed || block.protectedExact)
        return undefined;
    if (precomputed.blockId !== block.id || precomputed.key !== expectedKey || precomputed.dependency !== candidateDependency(block))
        return undefined;
    if (!Array.isArray(precomputed.candidates) || precomputed.candidates.length > MAX_PRECOMPUTED_CANDIDATES_PER_BLOCK) {
        return undefined;
    }
    const safeMetadata = { blockKind: precomputed.blockKind, isError: precomputed.isError, unresolved: precomputed.unresolved, reproducible: precomputed.reproducible, identifierCount: precomputed.identifierCount };
    if (precomputed.blockKind !== block.kind || precomputed.isError !== Boolean(block.isError) || precomputed.unresolved !== block.unresolved || precomputed.reproducible !== block.reproducible || precomputed.identifierCount !== block.exactIdentifiers.length
        || typeof precomputed.integrityHash !== "string"
        || precomputed.integrityHash !== candidateRecordIntegrityHash(precomputed.blockId, precomputed.key, precomputed.candidates, safeMetadata)) {
        return undefined;
    }
    const candidateIds = new Set();
    for (const item of precomputed.candidates) {
        if (!item || typeof item !== "object")
            return undefined;
        if (typeof item.text !== "string" || item.text.length > MAX_PRECOMPUTED_CANDIDATE_TEXT_CHARS)
            return undefined;
        if (!Number.isSafeInteger(item.tokens) || item.tokens < 0 || item.tokens !== estimateTokensFromText(item.text))
            return undefined;
        if (!Number.isSafeInteger(item.rawTokens) || item.rawTokens !== block.rawTokens)
            return undefined;
        if (!Number.isFinite(item.utility) || item.lossy !== true)
            return undefined;
        if (typeof item.reducer !== "string" || typeof item.reducerVersion !== "string")
            return undefined;
        const shape = expectedCachedCandidateShape(block, config, item.reducer);
        const expectedVersion = PRECOMPUTED_REDUCER_VERSIONS[item.reducer];
        if (!shape || item.level !== shape.level || item.utility !== shape.utility || item.reducerVersion !== expectedVersion)
            return undefined;
        const expectedId = `${block.id}:${item.level}:${item.reducer}`;
        if (item.id !== expectedId || candidateIds.has(item.id))
            return undefined;
        candidateIds.add(item.id);
        if (!sourceRefsMatchBlock(item, block))
            return undefined;
    }
    return precomputed;
}
async function candidatesForBlock(block, laterText, config, semanticCompressor, signal, precomputed, persistentOnly = false) {
    const containsOpaqueImage = block.attributes.containsImage === true || block.attributes.image === true;
    const candidates = [
        candidate(block, "raw", block.exactText, 1, containsOpaqueImage
            ? {
                lossy: true,
                reducer: "opaque-image-reference",
                reducerVersion: "1.0.0",
                omissions: [
                    {
                        description: "Original image bytes are not embedded in the text-only replay; an explicit image marker is retained and exact JSONL remains recoverable",
                    },
                ],
                metadata: { containsOpaqueImage: true },
            }
            : { lossy: false }),
    ];
    const precomputeKey = persistentCandidateKey(block, config);
    const usablePrecomputed = validatedPrecomputedRecord(precomputed, block, precomputeKey, config);
    if (block.protectedExact) {
        const directText = directInstructionText(block.exactText);
        if (directText !== block.exactText && estimateTokensFromText(directText) < block.rawTokens * 0.9) {
            candidates.push(candidate(block, "reduced", directText, 0.97, {
                reducer: "user-reference-segmentation",
                reducerVersion: "1.0.0",
                lossy: true,
                omissions: [
                    {
                        description: "Long quoted reference material omitted; surrounding direct user text retained exactly",
                    },
                ],
                metadata: { protectedDirectText: true },
            }));
        }
        return dedupeCandidates(candidates);
    }
    const normalized = normalizeBlock(block);
    if (normalized && estimateTokensFromText(normalized.text) <= block.rawTokens) {
        candidates.push(candidate(block, "normalized", normalized.text, 0.995, {
            reducer: normalized.reducer,
            reducerVersion: normalized.version,
            lossy: false,
            omissions: normalized.omissions,
            metadata: normalized.metadata,
        }));
    }
    if (usablePrecomputed)
        candidates.push(...usablePrecomputed.candidates);
    if (block.kind === "tool_call") {
        const reducedCall = reduceToolCall(block);
        if (reducedCall)
            candidates.push(reducedCall);
        candidates.push(candidate(block, "marker", markerText(block), 0.34, {
            reducer: "tool-call-marker",
            reducerVersion: "1.0.0",
            lossy: true,
            omissions: [{ description: "Low-priority tool arguments omitted; tool identity, critical arguments, and recovery pointer retained" }],
        }));
        return dedupeCandidates(candidates);
    }
    const maxTokens = reducedBudget(block, config);
    if (block.rawTokens > Math.max(80, maxTokens * 1.15)) {
        const reduced = persistentOnly ? reducePersistentBlock({ block, maxTokens, laterText }) : reduceBlock({ block, maxTokens, laterText });
        if (reduced && estimateTokensFromText(reduced.text) < block.rawTokens * 0.95) {
            const semanticLevel = block.kind === "assistant_reasoning" || block.kind === "assistant_text" ? "semantic" : "reduced";
            candidates.push(candidate(block, semanticLevel, reduced.text, semanticLevel === "semantic" ? 0.76 : 0.82, {
                reducer: reduced.reducer,
                reducerVersion: reduced.version,
                lossy: reduced.lossy,
                omissions: reduced.omissions,
                metadata: reduced.metadata,
            }));
        }
    }
    if (semanticCompressor &&
        config.enableSemanticCompression &&
        (block.kind === "assistant_reasoning" || block.kind === "assistant_text") &&
        block.rawTokens > config.semanticMaxTokens * 1.6) {
        const response = await semanticCompressor.compress({
            block,
            maxTokens: config.semanticMaxTokens,
            sourceText: block.exactText,
            requiredIdentifiers: block.exactIdentifiers,
        }, signal);
        if (response?.text) {
            const semanticText = truncateToTokens(response.text.trim(), config.semanticMaxTokens, " …[semantic output truncated]… ");
            if (estimateTokensFromText(semanticText) < block.rawTokens * 0.95) {
                candidates.push(candidate(block, "semantic", semanticText, 0.8, {
                    reducer: "llm-semantic",
                    reducerVersion: "1.0.0",
                    lossy: true,
                    omissions: [{ description: "Assistant prose semantically compressed from the original block" }],
                    metadata: { model: response.model, usage: response.usage },
                }));
            }
        }
    }
    if (block.kind !== "user" && block.kind !== "custom_message") {
        candidates.push(candidate(block, "marker", markerText(block), block.kind === "tool_result" && block.isError ? 0.5 : 0.28, {
            reducer: "historical-marker",
            reducerVersion: "1.0.0",
            lossy: true,
            omissions: [{ description: "Most block content omitted; representative excerpt and recovery pointer retained" }],
        }));
    }
    const phase = getString(block.attributes.phase);
    if (config.emergencyAllowAbsent &&
        (block.kind === "metadata" || block.kind === "historical_compaction" || (block.kind === "assistant_text" && phase === "preamble"))) {
        candidates.push(candidate(block, "absent", "", 0, {
            reducer: "absent",
            reducerVersion: "1.0.0",
            lossy: true,
            omissions: [{ description: "Block omitted from active context; exact source remains in JSONL/search" }],
        }));
    }
    return dedupeCandidates(candidates);
}
function laterTextForBlock(block, fallbackIndex, analysisBlocks, analysisIndexById) {
    const analysisIndex = analysisIndexById.get(block.id);
    const laterStart = analysisIndex === undefined ? fallbackIndex + 1 : analysisIndex + 1;
    return analysisBlocks
        .slice(laterStart, Math.min(analysisBlocks.length, laterStart + 40))
        .map((candidateBlock) => candidateBlock.exactText)
        .join("\n")
        .slice(0, 24_000);
}
function cacheSafeCandidate(candidate) {
    const metadata = {};
    for (const [key, value] of Object.entries(candidate.metadata)) {
        if (value === null || typeof value === "boolean" || typeof value === "number")
            metadata[key] = value;
        else if (typeof value === "string" && value.length <= 512)
            metadata[key] = value;
    }
    return Object.freeze({
        ...candidate,
        omissions: Object.freeze(candidate.omissions.map((notice) => Object.freeze({ ...notice }))),
        sourceRefs: Object.freeze(candidate.sourceRefs.map((ref) => Object.freeze({ ...ref }))),
        metadata: Object.freeze(metadata),
    });
}
/**
 * Precompute deterministic lossy candidates without storing raw or normalized
 * source representations. Protected blocks are not persisted in this cache.
 */
export async function precomputeCandidateRepresentations(blocks, config, previous = new Map(), signal) {
    if (config.enableSemanticCompression) {
        throw new Error("Incremental candidate precompute requires deterministic semantic compression to be disabled.");
    }
    const analysisIndexById = new Map(blocks.map((block, index) => [block.id, index]));
    const records = new Map();
    let reused = 0;
    let recomputed = 0;
    let skippedProtected = 0;
    for (let index = 0; index < blocks.length; index += 1) {
        if (signal?.aborted)
            throw signal.reason instanceof Error ? signal.reason : new Error("Incremental precompute aborted");
        const block = blocks[index];
        if (!block)
            continue;
        if (block.protectedExact) {
            skippedProtected += 1;
            continue;
        }
        const laterText = laterTextForBlock(block, index, blocks, analysisIndexById);
        const key = persistentCandidateKey(block, config);
        const cached = validatedPrecomputedRecord(previous.get(block.id), block, key, config);
        if (cached) {
            records.set(block.id, cached);
            reused += 1;
            continue;
        }
        const all = await candidatesForBlock(block, "", config, undefined, signal, undefined, true);
        const candidates = all
            .filter((item) => item.level !== "raw" && item.level !== "normalized" && item.level !== "semantic" && typeof item.reducer === "string" && !isFutureSensitiveReducer(item.reducer))
            .map(cacheSafeCandidate);
        records.set(block.id, {
            blockId: block.id, key, dependency: candidateDependency(block),
            blockKind: block.kind, isError: Boolean(block.isError), unresolved: block.unresolved,
            reproducible: block.reproducible, identifierCount: block.exactIdentifiers.length,
            integrityHash: candidateRecordIntegrityHash(block.id, key, candidates, { blockKind: block.kind, isError: Boolean(block.isError), unresolved: block.unresolved, reproducible: block.reproducible, identifierCount: block.exactIdentifiers.length }), candidates,
        });
        recomputed += 1;
    }
    return { records, reused, recomputed, skippedProtected };
}
export async function buildCandidateUnits(blocks, config, semanticCompressor, signal, retentionHints = "", analysisBlocks = blocks, precomputedCandidates = new Map()) {
    const units = [];
    const historyAnalysis = analyzeBlockHistory(analysisBlocks);
    const analysisIndexById = new Map(analysisBlocks.map((block, index) => [block.id, index]));
    for (let index = 0; index < blocks.length; index += 1) {
        if (signal?.aborted)
            throw signal.reason instanceof Error ? signal.reason : new Error("Compaction aborted");
        const block = blocks[index];
        if (!block)
            continue;
        const laterText = laterTextForBlock(block, index, analysisBlocks, analysisIndexById);
        const representations = await candidatesForBlock(block, laterText, config, semanticCompressor, signal, precomputedCandidates.get(block.id));
        const analysis = historyAnalysis.get(block.id);
        const resource = analysis?.resourceKind &&
            analysis.resourceKey &&
            analysis.occurrence !== undefined &&
            analysis.occurrenceCount !== undefined
            ? {
                kind: analysis.resourceKind,
                key: analysis.resourceKey,
                occurrence: analysis.occurrence,
                occurrenceCount: analysis.occurrenceCount,
            }
            : undefined;
        units.push({
            id: block.id,
            kind: block.kind,
            label: block.label,
            startEntryIndex: block.entryIndex,
            endEntryIndex: block.entryIndex,
            sourceRefs: block.sourceRefs,
            rawTokens: block.rawTokens,
            importance: scoreImportance(block, index, blocks.length, retentionHints, analysis),
            importanceReasons: analysis?.reasons ?? [],
            ...(resource === undefined ? {} : { resource }),
            protectedExact: block.protectedExact,
            candidates: representations,
            toolCallIds: block.toolCallId ? [block.toolCallId] : [],
        });
    }
    return units;
}
export function sourceIdentifiersForUnit(unit, blocksById) {
    return unique(unit.sourceRefs.flatMap((ref) => {
        const block = [...blocksById.values()].find((candidateBlock) => candidateBlock.entryId === ref.entryId && candidateBlock.blockIndex === ref.blockIndex);
        return block?.exactIdentifiers ?? [];
    }));
}
//# sourceMappingURL=candidates.js.map