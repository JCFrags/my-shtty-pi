import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewStoredCompaction, type CompositionPreviewReader } from "../src/composition-preview.js";
import type { EpisodeStateSelection } from "../src/episode-state-contract.js";
import type { CapsuleCatalogView } from "../src/capsule-contract.js";
import type { SessionEntryLike } from "../src/types.js";

test("recorded same-cut preview persists privately and refuses an unsafe tool-pair tail before selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chrono-preview-"));
  await chmod(root, 0o700);
  try {
    const entries: SessionEntryLike[] = [
      { id: "prefix", parentId: null, type: "message", message: { role: "user", content: "Earlier request." } },
      { id: "tail", parentId: "prefix", type: "message", message: { role: "user", content: "Retained request." } },
    ];
    const compaction: SessionEntryLike = { id: "compaction", parentId: "tail", type: "compaction", firstKeptEntryId: "tail",
      summary: "Original combined representation", details: { piSummary: " Separate Pi summary. \n",
        retainedTail: { firstKeptEntryId: "tail", actualTokens: 30 } } };
    // Empty selected rows isolate cut/tail/persistence behavior. No source ref is fabricated.
    const view = { storeKey: "store", generation: 1, branchKey: "branch", sessionKey: "session", eventCut: 1 } as CapsuleCatalogView;
    const selection: EpisodeStateSelection = { sourceView: view, stateGeneration: 1, branchKey: "branch", requestedCut: 1,
      processedCut: 1, processedMemoryCut: 1, complete: false, partial: true,
      coverage: { bodyComplete: true, metadataComplete: true, partialMemory: false, qualifiedReducers: true },
      protected: [], current: [], recent: [], omissions: { protectedAtLeastOne: false, currentAtLeastOne: false,
        recentAtLeastOne: false, responseBudgetAtLeastOne: false }, metrics: { sqliteStatements: 1 } };
    let reads = 0;
    const reader: CompositionPreviewReader = { getEntry: id => entries.find(entry => entry.id === id),
      select: async id => { assert.equal(id, "prefix"); reads++; return selection; },
      pin: async id => { assert.equal(id, "tail"); return { ...view, eventCut: 2 }; },
      recovery: () => { throw new Error("empty selection must not request recovery"); } };
    const preview = await previewStoredCompaction(compaction, reader, join(root, "artifacts"), 3000);
    assert.equal(reads, 1);
    assert.ok(preview.summary.includes(" Separate Pi summary. \n"));
    assert.equal(preview.envelope.validation.protectedCoverageComplete, false);
    assert.equal(preview.envelope.firstKeptEntryId, "tail");
    const path = join(root, "artifacts", preview.artifactRef);
    const artifact = JSON.parse(await readFile(path, "utf8"));
    assert.equal(artifact.preview.sameCut, true);
    assert.equal(artifact.preview.sameSummaryInput, true);
    assert.equal(artifact.preview.activeContextChanged, false);
    assert.equal(artifact.preview.baseline, compaction.summary);
    assert.equal(artifact.preview.composedSummary, preview.summary);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    entries.push({ id: "orphan", parentId: "tail", type: "message", message: { role: "toolResult", toolCallId: "missing", content: [] } });
    await assert.rejects(previewStoredCompaction({ ...compaction, parentId: "orphan" }, reader, join(root, "artifacts"), 3000), /tool-pair/);
    assert.equal(reads, 1, "unsafe tail must refuse before contained selection");
  } finally { await rm(root, { recursive: true, force: true }); }
});
