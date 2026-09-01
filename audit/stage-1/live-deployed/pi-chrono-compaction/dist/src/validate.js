import { directInstructionText, extractIdentifiers, hasFailureLanguage, hasSuccessLanguage, orderedIncludes, estimateTokensFromText, unique, } from "./utils.js";
function refKey(entryId, blockIndex) {
    return `${entryId}:${blockIndex ?? "*"}`;
}
export function buildValidationIndex(blocks) {
    const exactBlockByRef = new Map();
    const mutableBlocksByEntryId = new Map();
    const firstBlockByEntry = new Map();
    const validEntryIds = new Set();
    const validExactSourceRefs = new Set();
    const unresolvedEntryIds = new Set();
    const failedEntryIds = new Set();
    const toolPairs = new Map();
    const entryOrder = [];
    for (const block of blocks) {
        const exactKey = refKey(block.entryId, block.blockIndex);
        if (!exactBlockByRef.has(exactKey))
            exactBlockByRef.set(exactKey, block);
        const entryBlocks = mutableBlocksByEntryId.get(block.entryId);
        if (entryBlocks)
            entryBlocks.push(block);
        else
            mutableBlocksByEntryId.set(block.entryId, [block]);
        if (!firstBlockByEntry.has(block.entryId))
            firstBlockByEntry.set(block.entryId, block);
        validEntryIds.add(block.entryId);
        validExactSourceRefs.add(exactKey);
        entryOrder.push(block.entryId);
        if (block.unresolved)
            unresolvedEntryIds.add(block.entryId);
        if (block.isError || hasFailureLanguage(block.exactText))
            failedEntryIds.add(block.entryId);
        if (block.toolCallId) {
            const previous = toolPairs.get(block.toolCallId) ?? { call: false, result: false, latestEntryIndex: -1 };
            toolPairs.set(block.toolCallId, {
                call: previous.call || block.kind === "tool_call",
                result: previous.result || block.kind === "tool_result",
                latestEntryIndex: Math.max(previous.latestEntryIndex, block.entryIndex),
            });
        }
    }
    const blocksByEntryId = new Map();
    for (const [entryId, entryBlocks] of mutableBlocksByEntryId) {
        blocksByEntryId.set(entryId, Object.freeze(entryBlocks));
    }
    return {
        blocks,
        exactBlockByRef,
        blocksByEntryId,
        firstBlockByEntry,
        validEntryIds,
        validExactSourceRefs,
        unresolvedEntryIds,
        failedEntryIds,
        toolPairs,
        entryOrder,
    };
}
const EMPTY_BLOCKS = Object.freeze([]);
function blocksForSourceRef(index, ref, stats) {
    if (ref.blockIndex === undefined) {
        if (stats)
            stats.entryLookups += 1;
        return index.blocksByEntryId.get(ref.entryId) ?? EMPTY_BLOCKS;
    }
    if (stats)
        stats.exactLookups += 1;
    const block = index.exactBlockByRef.get(refKey(ref.entryId, ref.blockIndex));
    return block ? [block] : EMPTY_BLOCKS;
}
function blockForSourceText(index, ref) {
    return ref.blockIndex === undefined
        ? index.firstBlockByEntry.get(ref.entryId)
        : index.exactBlockByRef.get(refKey(ref.entryId, ref.blockIndex));
}
export function sourceTextForCandidate(candidate, index) {
    const pieces = [];
    for (const ref of candidate.sourceRefs) {
        const block = blockForSourceText(index, ref);
        if (block)
            pieces.push(block.exactText);
    }
    return pieces.join("\n");
}
function quotedSpans(text) {
    const spans = [];
    for (const match of text.matchAll(/`([^`\n]{5,})`|“([^”\n]{5,})”|"([^"\n]{8,})"/g)) {
        const value = match[1] ?? match[2] ?? match[3];
        if (value)
            spans.push(value);
    }
    return unique(spans);
}
function numericFacts(text) {
    const facts = [];
    // Numeric outcomes are particularly easy for a semantic compressor to invent.
    // Normalize common formatting differences while keeping fractions and units distinct.
    for (const match of text.matchAll(/(?<![A-Za-z0-9_])[-+]?\d[\d,_]*(?:\.\d+)?(?:\/\d[\d,_]*(?:\.\d+)?)?(?:\s*(?:ms|s|sec|secs|seconds?|minutes?|hours?|tokens?|tests?|files?|entries|lines?|bytes?|%))?/gi)) {
        const value = match[0]?.toLowerCase().replace(/[,_\s]+/g, "");
        if (value)
            facts.push(value);
    }
    return unique(facts);
}
function candidateIssues(unit, candidate, index) {
    const issues = [];
    const sourceText = sourceTextForCandidate(candidate, index);
    if (unit.protectedExact && candidate.level !== "raw") {
        const directTextIsExact = candidate.metadata.protectedDirectText === true && candidate.text === directInstructionText(sourceText);
        if (!directTextIsExact) {
            issues.push({
                severity: "error",
                code: "protected-exact",
                message: "Direct user restriction/correction text was not retained exactly.",
                unitId: unit.id,
            });
        }
    }
    if (candidate.lossy && candidate.level !== "absent" && candidate.omissions.length === 0) {
        issues.push({
            severity: "error",
            code: "loss-without-notice",
            message: "Lossy representation does not report what was omitted.",
            unitId: unit.id,
        });
    }
    if (candidate.reducer === "llm-semantic" || candidate.reducer === "llm-history-editor-v1") {
        for (const identifier of extractIdentifiers(candidate.text)) {
            if (!sourceText.includes(identifier)) {
                issues.push({
                    severity: "error",
                    code: "unsupported-identifier",
                    message: `Semantic compression introduced identifier ${identifier}.`,
                    unitId: unit.id,
                });
            }
        }
        for (const quote of quotedSpans(candidate.text)) {
            if (!sourceText.includes(quote)) {
                issues.push({
                    severity: "error",
                    code: "unsupported-quote",
                    message: `Semantic compression introduced an exact-looking quotation not found in source: ${quote}`,
                    unitId: unit.id,
                });
            }
        }
        const sourceNumbers = new Set(numericFacts(sourceText));
        for (const fact of numericFacts(candidate.text)) {
            if (!sourceNumbers.has(fact)) {
                issues.push({
                    severity: "error",
                    code: "unsupported-number",
                    message: `Semantic compression introduced numeric fact ${fact} that does not occur in source.`,
                    unitId: unit.id,
                });
            }
        }
    }
    const sourceUnresolved = candidate.sourceRefs.some((ref) => index.unresolvedEntryIds.has(ref.entryId));
    if (sourceUnresolved && hasSuccessLanguage(candidate.text) && !hasSuccessLanguage(sourceText)) {
        issues.push({
            severity: "error",
            code: "unresolved-became-complete",
            message: "Compression describes unresolved work as completed.",
            unitId: unit.id,
        });
    }
    const sourceFailed = candidate.sourceRefs.some((ref) => index.failedEntryIds.has(ref.entryId));
    if (sourceFailed && hasSuccessLanguage(candidate.text) && !hasFailureLanguage(candidate.text) && !hasSuccessLanguage(sourceText)) {
        issues.push({
            severity: "error",
            code: "failure-became-success",
            message: "Compression rewrites a failed or abandoned event as successful.",
            unitId: unit.id,
        });
    }
    return issues;
}
export function pruneUnsafeCandidates(units, blocks, validationIndex = buildValidationIndex(blocks)) {
    const rejectedIssues = [];
    const safeUnits = units.map((unit) => {
        const safe = unit.candidates.filter((candidate) => {
            const issues = candidateIssues(unit, candidate, validationIndex);
            if (issues.length > 0)
                rejectedIssues.push(...issues);
            return issues.length === 0;
        });
        if (safe.length > 0)
            return { ...unit, candidates: safe };
        const raw = unit.candidates.find((candidate) => candidate.level === "raw");
        if (raw)
            return { ...unit, candidates: [raw] };
        if (unit.protectedExact)
            throw new Error(`Validation removed every candidate for protected unit ${unit.id}, and no raw fallback exists.`);
        const text = "Historical unit omitted from active detail. Exact source remains recoverable.";
        const recovery = {
            id: `${unit.id}:validated-recovery`, level: "marker", text, tokens: estimateTokensFromText(text), rawTokens: unit.rawTokens,
            utility: 0.05, lossy: true, reducer: "validated-recovery-marker", reducerVersion: "1.0.0",
            omissions: [{ description: "Unsafe reduced candidates replaced by a source-linked recovery marker" }], sourceRefs: unit.sourceRefs,
            metadata: { validationFallback: true },
        };
        return { ...unit, candidates: [recovery] };
    });
    return { units: safeUnits, rejectedIssues };
}
export function validatePlan(plan, blocks, targetTokens = plan.targetTokens, options = {}) {
    const issues = [];
    const validationIndex = options.validationIndex ?? buildValidationIndex(blocks);
    let previousStart = -1;
    let previousEnd = -1;
    const coveredSourceOrdinals = new Set();
    for (const unit of plan.units) {
        if (unit.startEntryIndex < previousStart || unit.startEntryIndex < previousEnd || unit.endEntryIndex < unit.startEntryIndex) {
            issues.push({
                severity: "error",
                code: "chronology",
                message: `Unit ${unit.id} is out of chronological order or overlaps a previous unit.`,
                unitId: unit.id,
            });
        }
        previousStart = unit.startEntryIndex;
        previousEnd = Math.max(previousEnd, unit.endEntryIndex);
        for (const ref of unit.sourceRefs) {
            const exactKeys = blocksForSourceRef(validationIndex, ref, options.lookupStats)
                .map((block) => refKey(block.entryId, block.blockIndex));
            if (exactKeys.some((key) => coveredSourceOrdinals.has(key))) {
                issues.push({ severity: "error", code: "source-overlap", message: `Unit ${unit.id} repeats source coverage from an earlier unit.`, unitId: unit.id });
            }
            for (const key of exactKeys)
                coveredSourceOrdinals.add(key);
            const valid = validationIndex.validEntryIds.has(ref.entryId)
                && (ref.blockIndex === undefined || validationIndex.validExactSourceRefs.has(refKey(ref.entryId, ref.blockIndex)));
            if (!valid) {
                issues.push({
                    severity: "error",
                    code: "invalid-source-ref",
                    message: `Unit ${unit.id} references missing source ${ref.entryId}:${ref.blockIndex ?? "*"}.`,
                    unitId: unit.id,
                });
            }
        }
        issues.push(...candidateIssues(unit, unit.selected, validationIndex));
    }
    const firstRepresentedEntryIndex = plan.units[0]?.startEntryIndex ?? Number.POSITIVE_INFINITY;
    const representedToolPairs = new Map();
    for (const unit of plan.units) {
        if (unit.selected.level === "absent")
            continue;
        for (const ref of unit.selected.sourceRefs) {
            const referencedBlocks = blocksForSourceRef(validationIndex, ref, options.lookupStats);
            for (const block of referencedBlocks) {
                if (!block.toolCallId)
                    continue;
                const previous = representedToolPairs.get(block.toolCallId) ?? { call: false, result: false };
                representedToolPairs.set(block.toolCallId, {
                    call: previous.call || block.kind === "tool_call",
                    result: previous.result || block.kind === "tool_result",
                });
            }
        }
    }
    for (const [toolCallId, pair] of validationIndex.toolPairs) {
        if (!pair.call || !pair.result)
            continue;
        const represented = representedToolPairs.get(toolCallId) ?? { call: false, result: false };
        if (represented.call !== represented.result) {
            issues.push({
                severity: "error",
                code: "tool-pair-partial",
                message: `Tool interaction ${toolCallId} has only one source side in the compacted replay.`,
            });
            continue;
        }
        if (!represented.call) {
            if (options.allowOmittedPrefix === true && pair.latestEntryIndex < firstRepresentedEntryIndex)
                continue;
            issues.push({
                severity: "error",
                code: "tool-pair-missing",
                message: `Tool interaction ${toolCallId} disappeared from the compacted replay.`,
            });
        }
    }
    const renderedOrder = plan.units.flatMap((unit) => unit.sourceRefs.map((ref) => ref.entryId));
    if (!orderedIncludes(validationIndex.entryOrder, unique(renderedOrder))) {
        issues.push({
            severity: "error",
            code: "source-order",
            message: "Rendered source references are not in original chronological order.",
        });
    }
    if (plan.estimatedTokens > targetTokens) {
        issues.push({
            severity: "warning",
            code: "budget-estimate",
            message: `Estimated rendered context is ${plan.estimatedTokens} tokens, above target ${targetTokens}.`,
        });
    }
    return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}
//# sourceMappingURL=validate.js.map