import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCandidateUnits } from "../src/candidates.js";
import { resolveCompactorConfig } from "../src/compactor.js";
import { getActiveBranch, readSessionJsonl } from "../src/jsonl.js";
import type { SemanticCompressor } from "../src/types.js";
import { pruneUnsafeCandidates } from "../src/validate.js";

const fixture = resolve("test/fixtures/session.jsonl");

test("semantic candidates that invent identifiers or numeric facts are rejected before planning", async () => {
  const semanticCompressor: SemanticCompressor = {
    async compress() {
      return { text: "Considered 999 retry attempts before selecting the focused inspection." };
    },
  };
  const session = await readSessionJsonl(fixture);
  const blocks = parseHistoricalBlocks(getActiveBranch(session));
  const config = resolveCompactorConfig({ targetTokens: 2_500, enableSemanticCompression: true, semanticMaxTokens: 80 });
  const candidates = await buildCandidateUnits(blocks, config, semanticCompressor);
  const before = candidates
    .flatMap((unit) => unit.candidates)
    .filter((candidate) => candidate.reducer === "llm-semantic");
  assert.ok(before.length > 0);

  const pruned = pruneUnsafeCandidates(candidates, blocks);
  const after = pruned.units.flatMap((unit) => unit.candidates).filter((candidate) => candidate.reducer === "llm-semantic");
  assert.equal(after.length, 0);
  assert.ok(pruned.rejectedIssues.some((issue) => issue.code === "unsupported-number"));
});

test("a non-protected unit with only unsafe reduced candidates gets a validated recovery marker", async () => {
  const session = await readSessionJsonl(fixture);
  const blocks = parseHistoricalBlocks(getActiveBranch(session));
  const units = await buildCandidateUnits(blocks, resolveCompactorConfig({ targetTokens: 2_500 }), {
    async compress() { return { text: "Invented result 987654321 tokens completed successfully." }; },
  });
  const source = units.find((unit) => !unit.protectedExact);
  assert.ok(source);
  const unsafe = source.candidates.find((candidate) => candidate.reducer === "llm-semantic") ?? {
    ...source.candidates[0]!, id: "unsafe", level: "semantic" as const, reducer: "llm-semantic", text: "Invented result 987654321 tokens completed successfully.", lossy: true,
  };
  const pruned = pruneUnsafeCandidates([{ ...source, candidates: [unsafe] }], blocks);
  const recovery = pruned.units[0]!.candidates[0]!;
  assert.equal(recovery.reducer, "validated-recovery-marker");
  assert.equal(recovery.level, "marker");
  assert.deepEqual(recovery.sourceRefs, source.sourceRefs);
  assert.match(recovery.text, /Exact source remains recoverable/);
  assert.ok(pruned.rejectedIssues.length > 0);
});
