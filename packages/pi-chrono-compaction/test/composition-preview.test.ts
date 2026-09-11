import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { M09_AUTHORITATIVE_REPLACEMENT_ENABLED, composeStoredCompactionForNormalReturn, previewStoredCompaction, type CompositionPreviewReader } from "../src/composition-preview.js";
import type { EpisodeStateSelection, EpisodeStateSelectionItem } from "../src/episode-state-contract.js";
import type { CapsuleCatalogView } from "../src/capsule-contract.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/pi-extension.js";
import type { SessionEntryLike } from "../src/types.js";

test("recorded same-cut preview persists privately and refuses an unsafe tool-pair tail before selection", async () => {
  assert.equal(M09_AUTHORITATIVE_REPLACEMENT_ENABLED, false);
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
    const serialized = await readFile(path, "utf8");
    assert.doesNotMatch(serialized, /\[Circular\]/, "shared validation and envelope references are values, not cycles");
    const artifact = JSON.parse(serialized);
    assert.equal(artifact.preview.sameCut, true);
    assert.equal(artifact.preview.sameSummaryInput, true);
    assert.equal(artifact.preview.activeContextChanged, false);
    assert.equal(artifact.preview.baseline, compaction.summary);
    assert.equal(artifact.preview.composedSummary, preview.summary);
    assert.equal(artifact.preview.envelope.payloadHash, preview.envelope.payloadHash);
    assert.equal(artifact.preview.envelope.artifactHash, preview.envelope.payloadHash,
      "the embedded composition envelope identifies the pre-comparison payload");
    assert.notEqual(preview.envelope.artifactHash, preview.envelope.payloadHash,
      "the returned envelope identifies the final persisted comparison artifact separately");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    entries.push({ id: "orphan", parentId: "tail", type: "message", message: { role: "toolResult", toolCallId: "missing", content: [] } });
    await assert.rejects(previewStoredCompaction({ ...compaction, parentId: "orphan" }, reader, join(root, "artifacts"), 3000), /tool-pair/);
    assert.equal(reads, 1, "unsafe tail must refuse before contained selection");

    const previousConfigPath = process.env.PI_CHRONO_CONFIG_PATH;
    process.env.PI_CHRONO_CONFIG_PATH = join(root, "config.json");
    try {
      type Hook = (event: any, context: any) => Promise<any> | any;
      const hooks = new Map<string, Hook>();
      let summaryCalls = 0, composeCalls = 0;
      let refuseComposition = false;
      const pi = { registerTool() {}, registerCommand() {}, appendEntry() {}, sendMessage() {},
        on(name: string, handler: Hook) { hooks.set(name, handler); } };
      extension(pi as unknown as ExtensionAPI, { schedulerDirectory: join(root, "runtime"),
        normalCompositionFixture: {
          createPiSummary: async (_ctx, preparation) => {
            summaryCalls++;
            assert.equal(preparation.firstKeptEntryId, "tail");
            return { text: "Independent Pi summary.", tokens: 6, model: "fixture/model" };
          },
          compose: async input => {
            composeCalls++;
            if (refuseComposition) throw new Error("mandatory coverage incomplete");
            assert.equal(input.sourceCutEntryId, "prefix");
            assert.equal(input.firstKeptEntryId, "tail");
            assert.equal(input.toolPairSafe, true);
            const storeKey = "22222222-2222-4222-8222-222222222222";
            const healthyView = { ...view, storeKey, segments: [{ segment: 1, cut: 1 }] };
            const item = (kind: "restriction" | "openwork", text: string): EpisodeStateSelectionItem => ({
              stableKey: kind, propositionKey: kind, spanKey: kind, subject: "topic:fixture", revision: "unspecified",
              kind, authority: "user", confidence: "qualified", status: "current", effectiveAtCut: 1,
              evidence: { source: { catalogStoreKey: storeKey, sessionKey: "session", catalogGeneration: 1,
                shardKey: "shard", segment: 1, eventSeq: 1, ordinal: 1, descriptor: 1,
                field: "message.content.0.text", raw: { start: 0, end: 200 }, coordinateKind: "decoded-body",
                decodedUtf16: { start: 0, end: text.length }, bodyHashAlgorithm: "chrono-utf16le-chain-sha256-v1",
                bodyHash: "a".repeat(64) }, decodedUtf16: { start: 0, end: text.length }, exactText: text, omissions: [] },
            });
            return composeStoredCompactionForNormalReturn(input, { ...reader,
              select: async () => ({ ...selection, sourceView: healthyView, complete: true, partial: false,
                coverage: { ...selection.coverage, qualifiedReducers: false },
                protected: [item("restriction", "Protected obligation remains exact.")],
                current: [item("openwork", "Open work remains unresolved.")] }),
              pin: async () => ({ ...healthyView, eventCut: 2 }), recovery: () => "opaque:fixture",
            }, join(root, "normal-artifacts"), 30000);
          },
        } });
      const hook = hooks.get("session_before_compact");
      assert.ok(hook);
      const compactEvent = { branchEntries: entries.slice(0, 2), preparation: {
        firstKeptEntryId: "tail", tokensBefore: 1000, previousSummary: "Prior Pi summary.",
        messagesToSummarize: [], turnPrefixMessages: [], settings: { reserveTokens: 512 },
      }, reason: "manual", willRetry: false, signal: new AbortController().signal };
      const compactContext = {
        hasUI: true, ui: { notify() {} },
        sessionManager: { getSessionId: () => "fixture-session", getLeafId: () => "tail", getEntry: (id: string) => entries.find(entry => entry.id === id),
          getSessionFile: () => { throw new Error("legacy reconstruction must not run"); } },
      };
      const result = await hook(compactEvent, compactContext);
      assert.equal(summaryCalls, 1);
      assert.equal(composeCalls, 1);
      assert.equal(result.compaction.firstKeptEntryId, "tail");
      assert.match(result.compaction.summary, /Independent Pi summary[\s\S]*Protected obligation[\s\S]*Open work/);
      assert.deepEqual(Object.keys(result.compaction.details).sort(), ["composition", "kind"]);
      assert.equal(result.compaction.details.piSummary, undefined);
      assert.deepEqual(result.compaction.details.composition.validation, { safeTail: true, withinCombinedCeiling: true,
        protectedCoverageComplete: true, openWorkCoverageComplete: true });
      refuseComposition = true;
      assert.deepEqual(await hook(compactEvent, compactContext), { cancel: true },
        "coverage refusal must preserve context, not publish a summary-only success");
    } finally {
      if (previousConfigPath === undefined) delete process.env.PI_CHRONO_CONFIG_PATH;
      else process.env.PI_CHRONO_CONFIG_PATH = previousConfigPath;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
