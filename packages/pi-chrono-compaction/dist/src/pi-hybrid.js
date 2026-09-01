import { compact as compactWithPi, generateSummaryWithUsage, sessionEntryToContextMessages, } from "@earendil-works/pi-coding-agent";
import { estimateTokensFromText } from "./utils.js";
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
    const previousCompaction = [...branchEntries].reverse().find((entry) => entry.type === "compaction");
    if (!previousCompaction)
        return preparedPreviousSummary;
    const details = previousCompaction.details;
    if (details && typeof details === "object") {
        const piSummary = details.piSummary;
        if (typeof piSummary === "string" && piSummary.trim())
            return piSummary.trim();
    }
    const summary = typeof previousCompaction.summary === "string" ? previousCompaction.summary : "";
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