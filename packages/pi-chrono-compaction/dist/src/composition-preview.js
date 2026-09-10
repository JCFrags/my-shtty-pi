import { composeStoredSelection, persistPrivateCompositionArtifact } from "./context-composer.js";
import { isSafeCompactionCut } from "./tail-selection.js";
import { byteCount, estimateTokensFromText, getRecord, getString, stableStringify } from "./utils.js";
export const COMPOSITION_PREVIEW_LIMITS = { tailEntries: 256, tailBytes: 512 * 1024, comparisonBytes: 512 * 1024 };
/** Authoritative replacement remains impossible to enable through runtime configuration. */
export const M09_AUTHORITATIVE_REPLACEMENT_ENABLED = false;
/** Reuse one recorded compaction's exact Pi summary, original raw-tail cut and
 * baseline representation. A bounded lookup failure refuses, not reconstructs. */
export async function previewStoredCompaction(compaction, reader, artifactDirectory, combinedCeilingTokens, requireCompleteMandatoryCoverage = false, activeContextChanged = false) {
    if (compaction.type !== "compaction")
        throw new Error("preview requires an actual recorded compaction");
    // Match the existing authoritative ceiling; callers may request less, never more.
    if (!Number.isSafeInteger(combinedCeilingTokens) || combinedCeilingTokens > 30_000 || combinedCeilingTokens < 512) {
        throw new Error("preview ceiling must remain within the existing 30000-token limit");
    }
    const record = compaction;
    const details = getRecord(record.details);
    const regularPiSummary = getString(details?.piSummary);
    const baseline = getString(record.summary);
    const firstKeptEntryId = getString(record.firstKeptEntryId);
    const retained = getRecord(details?.retainedTail);
    const recordedTailTokens = retained?.actualTokens;
    if (!regularPiSummary || !baseline || !firstKeptEntryId || retained?.firstKeptEntryId !== firstKeptEntryId
        || !Number.isSafeInteger(recordedTailTokens) || recordedTailTokens < 0) {
        throw new Error("recorded separate Pi summary or retained-tail evidence is unavailable");
    }
    if (byteCount(baseline) > COMPOSITION_PREVIEW_LIMITS.comparisonBytes)
        throw new Error("comparison representation exceeds the preview byte bound");
    const first = reader.getEntry(firstKeptEntryId);
    const prefixId = first && getString(first.parentId);
    if (!prefixId)
        throw new Error("recorded summarized-prefix boundary is unavailable");
    const prefixEntry = reader.getEntry(prefixId);
    if (!prefixEntry)
        throw new Error("recorded summarized-prefix entry is unavailable");
    const reverse = [];
    let id = getString(record.parentId), bytes = byteCount(stableStringify(prefixEntry));
    if (bytes > COMPOSITION_PREVIEW_LIMITS.tailBytes)
        throw new Error("prefix boundary exceeds the preview byte bound");
    const seen = new Set();
    while (id && id !== prefixId) {
        if (reverse.length >= COMPOSITION_PREVIEW_LIMITS.tailEntries || seen.has(id))
            throw new Error("retained-tail lookup exceeded its bound or contains a cycle");
        seen.add(id);
        const entry = reader.getEntry(id);
        if (!entry || entry.id !== id)
            throw new Error("retained-tail entry is missing or mismatched");
        bytes += byteCount(stableStringify(entry));
        if (bytes > COMPOSITION_PREVIEW_LIMITS.tailBytes)
            throw new Error("retained-tail byte bound exceeded");
        reverse.push(entry);
        id = getString(entry.parentId);
    }
    const tail = reverse.reverse();
    if (id !== prefixId || tail[0]?.id !== firstKeptEntryId || !isSafeCompactionCut([prefixEntry, ...tail], 1)) {
        throw new Error("recorded retained tail fails exact boundary or tool-pair validation");
    }
    const selection = await reader.select(prefixId);
    const firstView = await reader.pin(firstKeptEntryId);
    if (firstView.storeKey !== selection.sourceView.storeKey || firstView.generation !== selection.sourceView.generation
        || firstView.branchKey !== selection.branchKey || firstView.sessionKey !== selection.sourceView.sessionKey
        || firstView.eventCut <= selection.requestedCut)
        throw new Error("retained tail and memory views are incompatible");
    const result = composeStoredSelection({ regularPiSummary, combinedCeilingTokens,
        cut: { sourceCutEntryId: prefixId, sourceCutSeq: selection.requestedCut, firstKeptEntryId,
            firstKeptSeq: firstView.eventCut, rawTailTokens: recordedTailTokens, toolPairSafe: true } }, selection, source => reader.recovery(selection.sourceView, source));
    if (requireCompleteMandatoryCoverage && (!result.envelope.validation.protectedCoverageComplete
        || !result.envelope.validation.openWorkCoverageComplete || !result.envelope.validation.safeTail
        || !result.envelope.validation.withinCombinedCeiling || result.status !== "composed")) {
        throw new Error("normal composition requires complete mandatory coverage and a valid bounded result");
    }
    // Comparison and actual selected prose remain private, not appended to Pi.
    const artifact = { ...result.artifact, preview: {
            compactionEntryId: compaction.id, regularPiSummary, baseline, composedSummary: result.text,
            sameCut: true, sameSummaryInput: true, activeContextChanged,
            baselineSummaryTokens: estimateTokensFromText(baseline), baselineCombinedTokens: estimateTokensFromText(baseline) + recordedTailTokens,
            sectionTokens: Object.fromEntries(["protected", "open-work", "older", "recent", "delta"].map(section => [section, result.artifact.selectedRows.filter(row => row.section === section).reduce((sum, row) => sum + row.renderedTokens, 0)])),
            regularPiSummaryTokens: estimateTokensFromText(regularPiSummary), rawTailTokens: recordedTailTokens,
            envelope: result.envelope,
        } };
    const stored = await persistPrivateCompositionArtifact(artifactDirectory, artifact);
    return { summary: result.text, envelope: { ...result.envelope, artifactHash: stored.artifactHash }, artifactRef: stored.artifactRef };
}
/** Future normal-return adapter. The extension must additionally gate every call
 * on M09_AUTHORITATIVE_REPLACEMENT_ENABLED. Only this minimal envelope is fit
 * for Pi compaction details; the detailed comparison remains owner-only. */
export async function composeStoredCompactionForNormalReturn(compaction, reader, artifactDirectory, combinedCeilingTokens) {
    const preview = await previewStoredCompaction(compaction, reader, artifactDirectory, combinedCeilingTokens, true, true);
    return { summary: preview.summary, firstKeptEntryId: preview.envelope.firstKeptEntryId,
        envelope: { ...preview.envelope, artifactRef: preview.artifactRef } };
}
//# sourceMappingURL=composition-preview.js.map