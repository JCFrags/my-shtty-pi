import { estimateTokensFromText, formatSourceRef, getRecord, hashText } from "./utils.js";
const MIN_REPEAT_TOKENS = 128;
const MIN_DELTA_LINES = 8;
const MAX_DELTA_TOKENS = 180;
function sourceBlock(unit, blocks) {
    if (unit.sourceRefs.length !== 1)
        return undefined;
    const ref = unit.sourceRefs[0];
    return blocks.find((block) => block.entryId === ref?.entryId && (ref.blockIndex === undefined || block.blockIndex === ref.blockIndex));
}
function refText(ref) {
    return formatSourceRef(ref.entryId, ref.blockIndex);
}
function numericCode(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
        return Number(value);
    return undefined;
}
function hasStructuredFailure(record) {
    if (!record)
        return false;
    for (const key of ["exitCode", "exit_code", "code"]) {
        const code = numericCode(record[key]);
        if (code !== undefined && code !== 0)
            return true;
    }
    for (const key of ["cancelled", "canceled", "aborted"]) {
        if (record[key] === true)
            return true;
    }
    for (const key of ["status", "state", "reason"]) {
        const value = record[key];
        if (typeof value === "string" && /^(?:abort(?:ed)?|cancel(?:led|ed)?)$/i.test(value.trim()))
            return true;
    }
    return false;
}
function hasStructuredSuccess(record) {
    if (!record)
        return false;
    for (const key of ["exitCode", "exit_code", "code"]) {
        if (numericCode(record[key]) === 0)
            return true;
    }
    return false;
}
function exactExitCodes(text) {
    const pattern = /(?:^|\n)\s*(?:exit(?:ed)?[ _-]*(?:code|status)|exit_code)\s*[:=]\s*(-?\d+)\b/gim;
    return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}
function hasExactNonzeroExitCode(text) {
    return exactExitCodes(text).some((code) => code !== 0);
}
function hasExactZeroExitCode(text) {
    return exactExitCodes(text).some((code) => code === 0);
}
function isTerminalObservation(block) {
    if (block.kind === "bash_execution")
        return true;
    const toolName = block.toolName?.trim() ?? "";
    return /^(?:bash|shell|terminal|exec|execute|command|run)$/i.test(toolName);
}
/**
 * Return true when an observation failed or lacks a positive completion fact.
 * Unknown tool outcomes are conservatively ineligible for repeat reduction.
 */
export function isFailedObservation(block) {
    if (block.kind !== "tool_result" && block.kind !== "bash_execution")
        return false;
    const attributes = block.attributes;
    const details = getRecord(attributes.details);
    if (block.isError === true
        || hasStructuredFailure(attributes)
        || hasStructuredFailure(details)
        || hasExactNonzeroExitCode(block.exactText)) {
        return true;
    }
    const hasPositiveExit = hasStructuredSuccess(attributes)
        || hasStructuredSuccess(details)
        || hasExactZeroExitCode(block.exactText);
    if (isTerminalObservation(block))
        return !hasPositiveExit;
    if (block.isError === false || hasPositiveExit)
        return false;
    return true;
}
function repeatCandidate(unit, canonical, block) {
    if (isFailedObservation(block))
        return undefined;
    const canonicalRef = canonical.sourceRefs[0];
    const text = [
        `Exact repeated observation. Canonical selected copy: ${refText(canonicalRef)}.`,
        `Content SHA-256 prefix: ${hashText(block.exactText)}.`,
        "This occurrence remains exactly recoverable from its own source reference.",
    ].join("\n");
    return {
        id: `${unit.id}:marker:exact-repeat`,
        level: "marker",
        text,
        tokens: estimateTokensFromText(text),
        rawTokens: unit.rawTokens,
        utility: 0.72,
        lossy: true,
        reducer: "exact-repeat",
        reducerVersion: "1.0.0",
        omissions: [{ description: "Repeated observation body omitted; the first canonical copy and both exact source references remain" }],
        sourceRefs: unit.sourceRefs,
        metadata: {
            canonicalEntryId: canonicalRef.entryId,
            canonicalBlockIndex: canonicalRef.blockIndex,
            contentHash: hashText(block.exactText),
        },
    };
}
function commonEdges(previous, current) {
    const maximum = Math.min(previous.length, current.length);
    let prefix = 0;
    while (prefix < maximum && previous[prefix] === current[prefix])
        prefix += 1;
    let suffix = 0;
    while (suffix < maximum - prefix
        && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]) {
        suffix += 1;
    }
    return { prefix, suffix };
}
function deltaCandidate(unit, previousUnit, previousBlock, block) {
    if (block.kind !== "tool_result" && block.kind !== "bash_execution")
        return undefined;
    if (previousBlock.kind !== block.kind || isFailedObservation(block) || isFailedObservation(previousBlock))
        return undefined;
    if (block.unresolved || previousBlock.unresolved || !unit.resource || unit.resource.key !== previousUnit.resource?.key)
        return undefined;
    const previousLines = previousBlock.exactText.split("\n");
    const currentLines = block.exactText.split("\n");
    if (previousLines.length < MIN_DELTA_LINES || currentLines.length < MIN_DELTA_LINES)
        return undefined;
    const { prefix, suffix } = commonEdges(previousLines, currentLines);
    const stableLines = prefix + suffix;
    if (stableLines < MIN_DELTA_LINES || stableLines / Math.max(previousLines.length, currentLines.length) < 0.72)
        return undefined;
    const currentChanged = currentLines.slice(prefix, currentLines.length - suffix);
    if (currentChanged.length === 0)
        return undefined;
    const changedText = currentChanged.join("\n");
    const changedTokens = estimateTokensFromText(changedText);
    if (changedTokens > MAX_DELTA_TOKENS || changedTokens >= block.rawTokens * 0.28)
        return undefined;
    const previousChangedLines = Math.max(0, previousLines.length - prefix - suffix);
    const previousRef = previousUnit.sourceRefs[0];
    const text = [
        `Repeated ${unit.resource.kind} observation delta from ${refText(previousRef)}.`,
        `Stable prefix: ${prefix} line(s). Stable suffix: ${suffix} line(s).`,
        `Previous changed region: ${previousChangedLines} line(s). Current changed region: ${currentChanged.length} line(s).`,
        "Current changed region (exact):",
        changedText,
    ].join("\n");
    const tokens = estimateTokensFromText(text);
    if (tokens >= block.rawTokens * 0.8)
        return undefined;
    return {
        id: `${unit.id}:reduced:observation-delta`,
        level: "reduced",
        text,
        tokens,
        rawTokens: unit.rawTokens,
        utility: 0.9,
        lossy: true,
        reducer: "observation-delta",
        reducerVersion: "1.0.0",
        omissions: [{ description: "Unchanged repeated-observation prefix and suffix omitted; the exact current changed region and both source references remain" }],
        sourceRefs: unit.sourceRefs,
        metadata: {
            priorEntryId: previousRef.entryId,
            priorBlockIndex: previousRef.blockIndex,
            stablePrefixLines: prefix,
            stableSuffixLines: suffix,
            previousChangedLines,
            currentChangedLines: currentChanged.length,
        },
    };
}
/**
 * Add local repeat and delta candidates without changing source order.
 * The first exact copy stays canonical. Later candidates always retain their
 * own source reference, so exact recovery does not depend on mutable state.
 */
export function addRepeatedObservationCandidates(units, blocks) {
    const exactCounts = new Map();
    for (const unit of units) {
        const block = sourceBlock(unit, blocks);
        if (!block
            || unit.protectedExact
            || block.protectedExact
            || block.unresolved
            || isFailedObservation(block)
            || block.rawTokens < MIN_REPEAT_TOKENS
            || !unit.candidates.some((candidate) => candidate.level !== "marker" && candidate.level !== "absent"))
            continue;
        const key = `${block.kind}\u0000${block.exactText}`;
        exactCounts.set(key, (exactCounts.get(key) ?? 0) + 1);
    }
    const firstExact = new Map();
    const latestResource = new Map();
    return units.map((unit) => {
        const block = sourceBlock(unit, blocks);
        if (!block
            || unit.protectedExact
            || block.protectedExact
            || block.unresolved
            || isFailedObservation(block)
            || block.rawTokens < MIN_REPEAT_TOKENS
            || !unit.candidates.some((candidate) => candidate.level !== "marker" && candidate.level !== "absent")) {
            return unit;
        }
        const additions = [];
        const exactKey = `${block.kind}\u0000${block.exactText}`;
        const canonical = firstExact.get(exactKey);
        if (canonical) {
            const repeated = repeatCandidate(unit, canonical, block);
            if (repeated)
                additions.push(repeated);
        }
        else
            firstExact.set(exactKey, unit);
        const canonicalUnit = !canonical && (exactCounts.get(exactKey) ?? 0) > 1
            ? {
                ...unit,
                candidates: unit.candidates.filter((candidate) => candidate.level !== "marker" && candidate.level !== "absent"),
            }
            : unit;
        if (!canonical && unit.resource) {
            const previous = latestResource.get(unit.resource.key);
            if (previous) {
                const delta = deltaCandidate(unit, previous.unit, previous.block, block);
                if (delta)
                    additions.push(delta);
            }
        }
        if (unit.resource)
            latestResource.set(unit.resource.key, { unit: canonicalUnit, block });
        if (additions.length === 0)
            return canonicalUnit;
        return { ...canonicalUnit, candidates: [...canonicalUnit.candidates, ...additions] };
    });
}
//# sourceMappingURL=repeated-observations.js.map