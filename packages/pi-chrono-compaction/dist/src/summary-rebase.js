import { buildCausalMemory, renderCurrentStateRegister } from "./causal-memory.js";
import { estimateTokensFromText, truncateToTokens } from "./utils.js";
export const DEFAULT_SUMMARY_REBASE_POLICY = Object.freeze({
    intervalGenerations: 8,
    maximumRecursiveMarkers: 2,
    targetTokens: 2_500,
});
function isCompactionEntry(entry) {
    if (entry.type === "compaction")
        return true;
    if (entry.type === "custom" && /compact|summary/i.test(String(entry.customType ?? "")))
        return true;
    return false;
}
export function decideRegularSummaryRebase(entries, previousSummary, policy = {}) {
    const resolved = { ...DEFAULT_SUMMARY_REBASE_POLICY, ...policy };
    const generations = entries.filter(isCompactionEntry).length;
    const recursiveMarkers = (previousSummary?.match(/(?:previous (?:regular )?summary|summary-of-summary|carried forward)/gi) ?? []).length;
    if (generations > 0 && generations % resolved.intervalGenerations === 0) {
        return { rebase: true, generations, recursiveMarkers, reason: `periodic rebase at generation ${generations}` };
    }
    if (recursiveMarkers >= resolved.maximumRecursiveMarkers) {
        return { rebase: true, generations, recursiveMarkers, reason: `${recursiveMarkers} recursive-summary marker(s) reached the limit` };
    }
    return { rebase: false, generations, recursiveMarkers, reason: "prior regular summary remains within rebase limits" };
}
function recoveryRange(blocks) {
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    if (!first || !last)
        return undefined;
    return `Exact source range: history_range("${first.entryId}", "${last.entryId}")`;
}
export function buildDeterministicSummaryRebase(blocks, model = buildCausalMemory(blocks), targetTokens = DEFAULT_SUMMARY_REBASE_POLICY.targetTokens) {
    const openEpisodes = model.episodes.filter((episode) => episode.open);
    const completed = model.episodes.filter((episode) => !episode.open).slice(-20);
    const decisiveFailures = model.failureFamilies.filter((family) => !family.resolved).slice(-20);
    const corrections = model.edges.filter((edge) => edge.kind === "corrects" || edge.kind === "supersedes").slice(-20);
    const sections = [
        "# REGULAR MEMORY REBASE",
        "Rebuilt from normalized original history. No previous generated summary was used as evidence.",
        renderCurrentStateRegister(model, 70),
        openEpisodes.length ? ["## Open work", ...openEpisodes.map((episode) => `- ${episode.objective} [${episode.sourceRange.start.entryId}–${episode.sourceRange.end.entryId}]`)].join("\n") : "",
        completed.length ? ["## Recent completed episodes", ...completed.map((episode) => `- ${episode.objective} → ${episode.outcome ?? "completed"} [${episode.certificate?.certificateHash ?? episode.episodeId}]`)].join("\n") : "",
        decisiveFailures.length ? ["## Unresolved failure families", ...decisiveFailures.map((family) => `- ${family.representative} [${family.sources[0]?.entryId ?? "unknown"}]`)].join("\n") : "",
        corrections.length ? ["## Latest corrections", ...corrections.map((edge) => `- ${edge.fromBlockId} → ${edge.toBlockId}`)].join("\n") : "",
        recoveryRange(blocks) ?? "",
    ].filter(Boolean).join("\n\n");
    return truncateToTokens(sections, Math.max(512, targetTokens), "\n\n[Rebase bounded; exact history remains available.]\n");
}
export function summaryRebaseTokens(text) {
    return estimateTokensFromText(text);
}
//# sourceMappingURL=summary-rebase.js.map