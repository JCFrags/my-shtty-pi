import { compact as compactWithPi, generateSummaryWithUsage, estimateTokens, sessionEntryToContextMessages, } from "@earendil-works/pi-coding-agent";
import { estimateTokensFromText } from "./utils.js";
import { selectDynamicRawTail } from "./tail-selection.js";
export const ADAPTIVE_PREPARATION_LIMITS = { tailEntries: 256, tailTokens: 128_000 };
/** Extend Pi's already-prepared prefix to the exact small Chrono cut. Never read
 * lifetime history or copy the prior composed replay into the independent summary. */
export function prepareAdaptiveChronoTail(branchEntries, preparation, minimumTokens, maximumTokens, includeSummary = true) {
    const windowStart = Math.max(0, branchEntries.length - ADAPTIVE_PREPARATION_LIMITS.tailEntries);
    const bounded = branchEntries.slice(windowStart);
    const preparedOffset = bounded.findIndex(entry => entry.id === preparation.firstKeptEntryId);
    if (windowStart === 0 && preparedOffset < 1)
        throw new Error("Pi prepared boundary is unavailable.");
    // A Pi-prepared boundary outside the bounded suffix precedes the selected cut.
    // Do not traverse the lifetime prefix merely to recover its array offset.
    const start = windowStart + Math.max(0, preparedOffset - 1);
    const preparedIndex = preparedOffset >= 0 ? windowStart + preparedOffset : undefined;
    const window = branchEntries.slice(start);
    // Estimate each visible message once. Pi's estimator includes image costs and
    // full tool results. No result text is shortened or replaced in the raw tail.
    const suffix = new Array(window.length + 1).fill(0);
    for (let index = window.length - 1; index >= 0; index--) {
        const entry = window[index];
        const tokens = index === 0 || entry.type === "compaction" || suffix[index + 1] > ADAPTIVE_PREPARATION_LIMITS.tailTokens ? 0
            : sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
        suffix[index] = Math.min(ADAPTIVE_PREPARATION_LIMITS.tailTokens + 1, suffix[index + 1] + tokens);
    }
    const tail = selectDynamicRawTail(window, minimumTokens, maximumTokens, entries => suffix[window.length - entries.length]);
    if (!tail || tail.actualTokens > maximumTokens)
        throw new Error("No complete tool-safe raw tail fits the dynamic maximum.");
    const cutIndex = start + tail.cutIndex;
    const summaryInputComplete = includeSummary && preparedIndex !== undefined
        && cutIndex - preparedIndex <= ADAPTIVE_PREPARATION_LIMITS.tailEntries;
    // An unusually long Pi tail must not force a foreground lifetime traversal.
    // Optional summary generation is skipped if its extra input exceeds this bound.
    const messages = summaryInputComplete ? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages,
        ...rawSourceMessages(branchEntries.slice(preparedIndex, cutIndex))] : [];
    return { tail: { ...tail, cutIndex }, summaryInputComplete, preparation: { ...preparation,
            firstKeptEntryId: tail.firstKeptEntryId, messagesToSummarize: messages,
            turnPrefixMessages: [], isSplitTurn: false } };
}
export function rawSourceMessages(sourceEntries) {
    return sourceEntries
        .filter((entry) => entry.type !== "compaction")
        .flatMap((entry) => sessionEntryToContextMessages(entry));
}
export function regularSummaryMessagesForCut(branchEntries, firstKeptEntryId, rebaseFromOriginal = false) {
    const cutIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (cutIndex < 0)
        return [];
    let boundaryStart = 0;
    for (let index = rebaseFromOriginal ? -1 : cutIndex - 1; index >= 0; index -= 1) {
        const entry = branchEntries[index];
        if (entry?.type !== "compaction")
            continue;
        const priorFirstKept = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
        const priorBoundary = priorFirstKept
            ? branchEntries.findIndex((candidate) => candidate.id === priorFirstKept)
            : -1;
        boundaryStart = priorBoundary >= 0 ? priorBoundary : index + 1;
        break;
    }
    return rawSourceMessages(branchEntries.slice(boundaryStart, cutIndex));
}
export async function createPiRegularSummary(ctx, preparation, options) {
    const model = ctx.model;
    if (!model)
        return undefined;
    if (options.messages) {
        if (options.messages.length === 0)
            return undefined;
    }
    else if (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0)
        return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey)
        return undefined;
    const headers = auth.headers
        ? Object.fromEntries(Object.entries(auth.headers).filter((entry) => entry[1] !== null))
        : undefined;
    const targetTokens = Math.max(256, Math.floor(options.targetTokens));
    const reserveTokens = Math.max(512, Math.ceil(targetTokens / 0.8));
    if (options.messages) {
        const generated = await generateSummaryWithUsage(options.messages, model, reserveTokens, auth.apiKey, headers, options.signal, options.customInstructions, options.previousSummary, ctx.thinkingLevel, undefined, auth.env);
        const text = generated.text.trim();
        if (!text)
            return undefined;
        return {
            text,
            tokens: estimateTokensFromText(text),
            model: `${model.provider}/${model.id}`,
            usage: generated.usage,
        };
    }
    const generated = await compactWithPi({
        ...preparation,
        previousSummary: options.previousSummary,
        settings: { ...preparation.settings, reserveTokens },
    }, model, auth.apiKey, headers, options.customInstructions, options.signal, ctx.thinkingLevel, undefined, auth.env);
    const text = generated.summary.trim();
    if (!text || !generated.usage)
        return undefined;
    return {
        text,
        tokens: estimateTokensFromText(text),
        model: `${model.provider}/${model.id}`,
        usage: generated.usage,
    };
}
export function previousRegularPiSummary(branchEntries, preparedPreviousSummary) {
    const previousCompaction = branchEntries.slice(-256).reverse().find((entry) => entry.type === "compaction");
    if (!previousCompaction)
        return preparedPreviousSummary;
    const details = previousCompaction.details;
    if (details && typeof details === "object") {
        const piSummary = details.piSummary;
        if (typeof piSummary === "string" && piSummary.trim())
            return piSummary.trim();
    }
    const summary = typeof previousCompaction.summary === "string" ? previousCompaction.summary : "";
    if (summary.startsWith("# CHRONOCOMPACT CONTEXT")) {
        // Read older composed records that predate the separate piSummary receipt.
        const description = summary.indexOf("Pi generated this regular compaction summary independently.");
        if (description < 0)
            return undefined;
        const start = summary.indexOf("\n\n", description);
        const end = summary.lastIndexOf("\n\n---\n\n## CHRONOCOMPACT EVENT REPLAY\n\n");
        return start >= 0 && end > start ? summary.slice(start + 2, end).trim() : undefined;
    }
    if (summary.startsWith("# HYBRID RETROSPECTIVE CONTEXT")) {
        const goalAt = summary.indexOf("\n\n## Goal");
        const replayAt = summary.indexOf("\n\n---\n\n## DETERMINISTIC CHRONOLOGICAL REPLAY");
        if (goalAt >= 0 && replayAt > goalAt)
            return summary.slice(goalAt + 2, replayAt).trim();
        return undefined;
    }
    return preparedPreviousSummary;
}
export function renderHybridCompaction(regularSummary, chronologicalReplay) {
    return [
        "# CHRONOCOMPACT CONTEXT",
        "",
        "## REGULAR PI COMPACTION SUMMARY",
        "",
        "Pi generated this regular compaction summary independently. The ChronoCompact replay below was not used as summary input. Later replay events or the retained raw tail can supersede states described here.",
        "",
        regularSummary.trim(),
        "",
        "---",
        "",
        "## CHRONOCOMPACT EVENT REPLAY",
        "",
        chronologicalReplay.trim(),
    ].join("\n");
}
//# sourceMappingURL=pi-hybrid.js.map