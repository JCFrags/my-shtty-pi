import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCandidateUnits, precomputeCandidateRepresentations } from "../src/candidates.js";
import { compactEntries, resolveCompactorConfig } from "../src/compactor.js";
import {
  buildIncrementalCheckpoint,
  incrementalConfigHash,
  incrementalReducerHash,
  persistedIncrementalCheckpoint,
  readIncrementalCheckpoint,
  validateIncrementalCheckpoint,
  writeIncrementalCheckpoint,
  type IncrementalCacheIdentity,
} from "../src/incremental-context.js";
import type { RepresentationCandidate, SessionEntryLike } from "../src/types.js";
import { estimateTokensFromText, hashText, stableStringify } from "../src/utils.js";

function entries(): SessionEntryLike[] {
  const output = Array.from({ length: 220 }, (_, index) => `src/file-${index}.ts:${index + 1}: deterministic match`).join("\n");
  return [
    {
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Do not modify the repository while you inspect it." }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "deterministic", path: "src" } }],
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "grep",
        isError: false,
        details: { exitCode: 0, matchCount: 220 },
        content: [{ type: "text", text: output }],
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "r1",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The repository inspection completed." }] },
    },
  ];
}

const config = resolveCompactorConfig({
  targetTokens: 2_500,
  semanticMaxTokens: 180,
  enableSemanticCompression: false,
});
const identity: IncrementalCacheIdentity = {
  sessionPath: "/private/session.jsonl",
  sessionId: "session-1",
  configHash: incrementalConfigHash(config),
  reducerHash: incrementalReducerHash(),
};

test("new to append to append parses only suffixes, reconciles pairs, and matches cold output", async () => {
  const source = entries();
  const first = await buildIncrementalCheckpoint(source.slice(0, 2), identity, config);
  assert.equal(first.metrics.transition, "new");
  assert.equal(first.metrics.parsedEntries, 2);

  const second = await buildIncrementalCheckpoint(source.slice(0, 3), identity, config, { previous: first });
  assert.equal(second.metrics.transition, "append");
  assert.equal(second.metrics.appendedEntries, 1);
  assert.equal(second.metrics.parsedEntries, 1);
  const appended = await buildIncrementalCheckpoint(source, identity, config, { previous: second });
  assert.equal(appended.metrics.transition, "append");
  assert.equal(appended.metrics.appendedEntries, 1);
  assert.equal(appended.metrics.parsedEntries, 1);
  assert.deepEqual(appended.blocks, parseHistoricalBlocks(source, { includeHistoricalCompactions: false, includeMetadata: false }));
  const call = appended.blocks.find((block) => block.kind === "tool_call");
  const result = appended.blocks.find((block) => block.kind === "tool_result");
  assert.equal(call?.attributes.pairedResultEntryId, "r1");
  assert.equal(result?.attributes.pairedCallEntryId, "a1");

  const warm = await compactEntries(source, {
    config,
    precomputedCandidates: new Map(appended.candidates.map((record) => [record.blockId, record])),
  });
  const cold = await compactEntries(source, { config });
  assert.equal(warm.summary, cold.summary);
  assert.equal(warm.details.generationHash, cold.details.generationHash);
  assert.equal(warm.renderedTokens, cold.renderedTokens);
});

test("validated candidate precompute is byte-equivalent to cold generation", async () => {
  const source = entries();
  const checkpoint = await buildIncrementalCheckpoint(source, identity, config);
  const precomputed = new Map(checkpoint.candidates.map((record) => [record.blockId, record]));
  const cold = await compactEntries(source, { config });
  const warm = await compactEntries(source, { config, precomputedCandidates: precomputed });
  assert.equal(warm.summary, cold.summary);
  assert.equal(warm.details.generationHash, cold.details.generationHash);
  assert.equal(warm.renderedTokens, cold.renderedTokens);

  const exact = await buildIncrementalCheckpoint(source, identity, config, { previous: checkpoint });
  assert.equal(exact.metrics.transition, "exact-hit");
  assert.equal(exact.metrics.parsedEntries, 0);
  assert.equal(exact.metrics.reusedCandidates, checkpoint.candidates.length);
  assert.equal(exact.metrics.recomputedCandidates, 0);
});

test("tampered candidate records pass source binding but are rejected at final use", async (testContext) => {
  const source = entries();
  const checkpoint = await buildIncrementalCheckpoint(source, identity, config);
  const target = checkpoint.candidates.find((record) => record.blockId.startsWith("r1:tool_result") && record.candidates.length > 0);
  assert.ok(target);
  const cold = await compactEntries(source, { config });

  const cases: Array<{
    name: string;
    mutate: (candidate: RepresentationCandidate) => RepresentationCandidate;
  }> = [
    {
      name: "sourceRefs",
      mutate: (candidate) => ({ ...candidate, sourceRefs: [{ entryId: "wrong-entry", blockIndex: 0 }] }),
    },
    {
      name: "rawTokens",
      mutate: (candidate) => ({ ...candidate, rawTokens: candidate.rawTokens + 1 }),
    },
    {
      name: "tokens/text consistency",
      mutate: (candidate) => ({ ...candidate, tokens: candidate.tokens + 1 }),
    },
    {
      name: "candidate ID",
      mutate: (candidate) => ({ ...candidate, id: `${candidate.id}:wrong` }),
    },
    {
      name: "allowed level",
      mutate: (candidate) => ({
        ...candidate,
        id: `${target.blockId}:merged:${candidate.reducer}`,
        level: "merged",
      }),
    },
    {
      name: "reducer identity",
      mutate: (candidate) => ({
        ...candidate,
        id: `${target.blockId}:${candidate.level}:history-editor-v1`,
        reducer: "history-editor-v1",
        reducerVersion: "1.1.0",
      }),
    },
    {
      name: "reducer version",
      mutate: (candidate) => ({ ...candidate, reducerVersion: "0.0.0-tampered" }),
    },
  ];

  for (const tamperCase of cases) {
    await testContext.test(tamperCase.name, async () => {
      const tamperedCandidates = checkpoint.candidates.map((record) => {
        if (record.blockId !== target.blockId) return record;
        const candidates = record.candidates.map((candidate, index) => {
          const text = `TAMPERED CANDIDATE ${tamperCase.name} ${index}`;
          return tamperCase.mutate({ ...candidate, text, tokens: estimateTokensFromText(text) });
        });
        return {
          ...record,
          integrityHash: hashText(stableStringify({
            schema: 1,
            blockId: record.blockId,
            key: record.key,
            candidates,
          })),
          candidates,
        };
      });
      const tampered = { ...checkpoint, candidates: tamperedCandidates };
      const sourceValidated = validateIncrementalCheckpoint(tampered, source, identity);
      assert.equal(sourceValidated.ok, true, "the test must reach the final-use candidate validator");
      const result = await compactEntries(source, { config, precomputedCandidates: sourceValidated.candidates });
      assert.equal(result.summary, cold.summary);
      assert.equal(result.details.generationHash, cold.details.generationHash);
      assert.equal(result.renderedTokens, cold.renderedTokens);
      assert.doesNotMatch(result.summary, /TAMPERED CANDIDATE/);
    });
  }
});

test("candidate integrity rejects independent text, omission, and metadata changes", async (testContext) => {
  const source = entries();
  const checkpoint = await buildIncrementalCheckpoint(source, identity, config);
  const target = checkpoint.candidates.find((record) => record.blockId.startsWith("r1:tool_result") && record.candidates.length > 0);
  assert.ok(target);
  const coldUnits = await buildCandidateUnits(checkpoint.blocks, config);
  const cases: Array<{
    name: string;
    mutate: (candidate: RepresentationCandidate) => RepresentationCandidate;
  }> = [
    {
      name: "text only with a consistent token count",
      mutate: (candidate) => {
        const text = "INDEPENDENT TAMPERED CANDIDATE TEXT";
        return { ...candidate, text, tokens: estimateTokensFromText(text) };
      },
    },
    {
      name: "omission only",
      mutate: (candidate) => ({
        ...candidate,
        omissions: [...candidate.omissions, { description: "INDEPENDENT TAMPERED OMISSION" }],
      }),
    },
    {
      name: "metadata only",
      mutate: (candidate) => ({
        ...candidate,
        metadata: { ...candidate.metadata, tampered: "INDEPENDENT TAMPERED METADATA" },
      }),
    },
  ];

  for (const tamperCase of cases) {
    await testContext.test(tamperCase.name, async () => {
      const tamperedCandidates = target.candidates.map((candidate, index) => index === 0 ? tamperCase.mutate(candidate) : candidate);
      const tamperedRecord = { ...target, candidates: tamperedCandidates };
      const tamperedMap = new Map(checkpoint.candidates.map((record) => [
        record.blockId,
        record.blockId === target.blockId ? tamperedRecord : record,
      ]));

      const warmUnits = await buildCandidateUnits(
        checkpoint.blocks,
        config,
        undefined,
        undefined,
        "",
        checkpoint.blocks,
        tamperedMap,
      );
      assert.equal(JSON.stringify(warmUnits), JSON.stringify(coldUnits));
      assert.doesNotMatch(JSON.stringify(warmUnits), /INDEPENDENT TAMPERED/);

      const refreshed = await precomputeCandidateRepresentations(checkpoint.blocks, config, tamperedMap);
      assert.equal(refreshed.recomputed, 1);
      assert.equal(refreshed.reused, checkpoint.candidates.length - 1);
      assert.equal(refreshed.records.get(target.blockId)?.integrityHash, target.integrityHash);
    });
  }
});

test("checkpoint validation rejects branch, rewrite, config, reducer, and session changes", async () => {
  const source = entries();
  const checkpoint = await buildIncrementalCheckpoint(source, identity, config);
  assert.equal(validateIncrementalCheckpoint(checkpoint, source, identity).ok, true);

  const rewritten = structuredClone(source);
  const result = rewritten[2] as SessionEntryLike & { message: { content: Array<{ type: string; text: string }> } };
  result.message.content[0]!.text += "\nchanged";
  assert.equal(validateIncrementalCheckpoint(checkpoint, rewritten, identity).ok, false);
  assert.equal((await buildIncrementalCheckpoint(rewritten, identity, config, { previous: checkpoint })).metrics.transition, "rewrite-or-branch-switch");
  assert.equal((await buildIncrementalCheckpoint(source.slice(0, 3), identity, config, { previous: checkpoint })).metrics.transition, "truncation");
  assert.equal((await buildIncrementalCheckpoint(source, { ...identity, configHash: "changed" }, config, { previous: checkpoint })).metrics.transition, "config-change");
  assert.equal((await buildIncrementalCheckpoint(source, { ...identity, reducerHash: "changed" }, config, { previous: checkpoint })).metrics.transition, "reducer-change");
  assert.equal((await buildIncrementalCheckpoint(source, { ...identity, sessionPath: "/other.jsonl" }, config, { previous: checkpoint })).metrics.transition, "session-replacement");
  assert.equal((await buildIncrementalCheckpoint(source, { ...identity, sessionId: "session-2" }, config, { previous: checkpoint })).metrics.transition, "session-replacement");
});

test("persistent checkpoints are atomic, owner-only, bounded, and omit raw blocks", async () => {
  const source = entries();
  const checkpoint = await buildIncrementalCheckpoint(source, identity, config);
  const directory = await mkdtemp(join(tmpdir(), "chrono-incremental-"));
  const path = join(directory, "checkpoint.json");
  await writeIncrementalCheckpoint(path, checkpoint);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /"blocks"/);
  assert.doesNotMatch(text, /"level":"raw"|"level": "raw"/);
  assert.doesNotMatch(text, /"level":"normalized"|"level": "normalized"/);
  assert.equal(text.includes(stableStringify(source[2])), false);
  assert.equal(text.includes("Do not modify the repository while you inspect it."), false, "protected exact user text must not enter persisted candidates");
  const loaded = await readIncrementalCheckpoint(path);
  assert.ok(loaded);
  assert.equal(loaded.orderedSourceHash, persistedIncrementalCheckpoint(checkpoint).orderedSourceHash);
  assert.equal(loaded.candidates.length, checkpoint.candidates.length);
  assert.equal(validateIncrementalCheckpoint(loaded, source, identity).ok, true);
  await assert.rejects(() => writeIncrementalCheckpoint(join(directory, "too-large.json"), checkpoint, 10), /storage bound/);

  const malformedPath = join(directory, "malformed.json");
  await writeFile(malformedPath, "{not valid JSON\n", { mode: 0o600 });
  assert.equal(await readIncrementalCheckpoint(malformedPath), undefined);
  await writeFile(malformedPath, `${stableStringify({ ...persistedIncrementalCheckpoint(checkpoint), orderedSourceHash: "tampered" })}\n`, { mode: 0o600 });
  assert.equal(await readIncrementalCheckpoint(malformedPath), undefined);
});

test("incremental preprocessing honors cancellation and entry bounds", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled for replacement"));
  await assert.rejects(() => buildIncrementalCheckpoint(entries(), identity, config, { signal: controller.signal }), /cancelled for replacement/);
  await assert.rejects(() => buildIncrementalCheckpoint(entries(), identity, config, { maxEntries: 2 }), /entry bound/);
});
