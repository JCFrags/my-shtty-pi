import { composeStoredSelection, persistPrivateCompositionArtifact, type ShadowCompositionEnvelope } from "./context-composer.js";
import type { CapsuleCatalogView, ScopedBodySourceRef, ScopedRawSourceRef } from "./capsule-contract.js";
import type { EpisodeStateSelection } from "./episode-state-contract.js";
import { isSafeCompactionCut } from "./tail-selection.js";
import type { SessionEntryLike } from "./types.js";
import { byteCount, estimateTokensFromText, getRecord, getString, stableStringify } from "./utils.js";

/** Explicit preview only. These callbacks must use the already-loaded session
 * and the read-only contained adapter. This module never loads session files,
 * calls a provider, or registers an authoritative compaction hook. */
export interface CompositionPreviewReader {
  readonly getEntry: (id: string) => SessionEntryLike | undefined;
  readonly select: (prefixEntryId: string) => Promise<EpisodeStateSelection>;
  readonly pin: (entryId: string) => Promise<CapsuleCatalogView>;
  readonly recovery: (view: CapsuleCatalogView, source: ScopedBodySourceRef | ScopedRawSourceRef) => string;
}

export const COMPOSITION_PREVIEW_LIMITS = { tailEntries: 256, tailBytes: 512 * 1024, comparisonBytes: 512 * 1024 } as const;

/** Reuse one recorded compaction's exact Pi summary, original raw-tail cut and
 * baseline representation. A bounded lookup failure refuses, not reconstructs. */
export async function previewStoredCompaction(
  compaction: SessionEntryLike,
  reader: CompositionPreviewReader,
  artifactDirectory: string,
  combinedCeilingTokens: number,
): Promise<{ summary: string; envelope: ShadowCompositionEnvelope; artifactRef: string }> {
  if (compaction.type !== "compaction") throw new Error("preview requires an actual recorded compaction");
  // Match the existing authoritative ceiling; callers may request less, never more.
  if (!Number.isSafeInteger(combinedCeilingTokens) || combinedCeilingTokens > 30_000 || combinedCeilingTokens < 512) {
    throw new Error("preview ceiling must remain within the existing 30000-token limit");
  }
  const record = compaction as unknown as Record<string, unknown>;
  const details = getRecord(record.details);
  const regularPiSummary = getString(details?.piSummary);
  const baseline = getString(record.summary);
  const firstKeptEntryId = getString(record.firstKeptEntryId);
  const retained = getRecord(details?.retainedTail);
  const recordedTailTokens = retained?.actualTokens;
  if (!regularPiSummary || !baseline || !firstKeptEntryId || retained?.firstKeptEntryId !== firstKeptEntryId
    || !Number.isSafeInteger(recordedTailTokens) || (recordedTailTokens as number) < 0) {
    throw new Error("recorded separate Pi summary or retained-tail evidence is unavailable");
  }
  if (byteCount(baseline) > COMPOSITION_PREVIEW_LIMITS.comparisonBytes) throw new Error("comparison representation exceeds the preview byte bound");
  const first = reader.getEntry(firstKeptEntryId);
  const prefixId = first && getString((first as unknown as Record<string, unknown>).parentId);
  if (!prefixId) throw new Error("recorded summarized-prefix boundary is unavailable");
  const prefixEntry = reader.getEntry(prefixId);
  if (!prefixEntry) throw new Error("recorded summarized-prefix entry is unavailable");
  const reverse: SessionEntryLike[] = [];
  let id = getString(record.parentId), bytes = byteCount(stableStringify(prefixEntry));
  if (bytes > COMPOSITION_PREVIEW_LIMITS.tailBytes) throw new Error("prefix boundary exceeds the preview byte bound");
  const seen = new Set<string>();
  while (id && id !== prefixId) {
    if (reverse.length >= COMPOSITION_PREVIEW_LIMITS.tailEntries || seen.has(id)) throw new Error("retained-tail lookup exceeded its bound or contains a cycle");
    seen.add(id);
    const entry = reader.getEntry(id);
    if (!entry || entry.id !== id) throw new Error("retained-tail entry is missing or mismatched");
    bytes += byteCount(stableStringify(entry));
    if (bytes > COMPOSITION_PREVIEW_LIMITS.tailBytes) throw new Error("retained-tail byte bound exceeded");
    reverse.push(entry);
    id = getString((entry as unknown as Record<string, unknown>).parentId);
  }
  const tail = reverse.reverse();
  if (id !== prefixId || tail[0]?.id !== firstKeptEntryId || !isSafeCompactionCut([prefixEntry, ...tail], 1)) {
    throw new Error("recorded retained tail fails exact boundary or tool-pair validation");
  }
  const selection = await reader.select(prefixId);
  const firstView = await reader.pin(firstKeptEntryId);
  if (firstView.storeKey !== selection.sourceView.storeKey || firstView.generation !== selection.sourceView.generation
    || firstView.branchKey !== selection.branchKey || firstView.sessionKey !== selection.sourceView.sessionKey
    || firstView.eventCut <= selection.requestedCut) throw new Error("retained tail and memory views are incompatible");
  const result = composeStoredSelection({ regularPiSummary, combinedCeilingTokens,
    cut: { sourceCutEntryId: prefixId, sourceCutSeq: selection.requestedCut, firstKeptEntryId,
      firstKeptSeq: firstView.eventCut, rawTailTokens: recordedTailTokens as number, toolPairSafe: true } },
    selection, source => reader.recovery(selection.sourceView, source));
  // Comparison and actual selected prose remain private, not appended to Pi.
  const artifact = { ...result.artifact, preview: {
    compactionEntryId: compaction.id, regularPiSummary, baseline, composedSummary: result.text,
    sameCut: true, sameSummaryInput: true, activeContextChanged: false,
    baselineSummaryTokens: estimateTokensFromText(baseline), baselineCombinedTokens: estimateTokensFromText(baseline) + (recordedTailTokens as number),
    sectionTokens: Object.fromEntries(["protected", "open-work", "older", "recent", "delta"].map(section =>
      [section, result.artifact.selectedRows.filter(row => row.section === section).reduce((sum, row) => sum + row.renderedTokens, 0)])),
    regularPiSummaryTokens: estimateTokensFromText(regularPiSummary), rawTailTokens: recordedTailTokens,
    envelope: result.envelope,
  } };
  const stored = await persistPrivateCompositionArtifact(artifactDirectory, artifact);
  return { summary: result.text, envelope: { ...result.envelope, artifactHash: stored.artifactHash }, artifactRef: stored.artifactRef };
}
