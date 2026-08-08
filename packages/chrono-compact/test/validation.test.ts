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
