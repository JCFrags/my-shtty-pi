import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  compactEntries,
  CompactionValidationError,
  HARD_REPLAY_CAP_TOKENS,
  computeGenerationHash,
  computeSummaryBudget,
  resolveCompactorConfig,
  selectReplayTarget,
} from "../src/compactor.js";
import { getActiveBranch, readSessionJsonl } from "../src/jsonl.js";
import type { SessionEntryLike } from "../src/types.js";

const fixture = resolve("test/fixtures/session.jsonl");

test("builds a deterministic, chronological, explicitly lossy replay from raw history", async () => {
  const beforeBytes = await readFile(fixture, "utf8");
  const session = await readSessionJsonl(fixture);
  const branch = getActiveBranch(session);
  const options = {
    config: { targetTokens: 2_500, mergeEpisodes: true },
    retentionHints: "Preserve the timeout.test.ts assertion and public API restriction.",
  } as const;
  const first = await compactEntries(branch, options);
  const second = await compactEntries(branch, options);

  assert.equal(first.validation.ok, true);
  assert.equal(first.summary, second.summary);
  assert.equal(first.details.generationHash, second.details.generationHash);
  assert.ok(first.rawTokens > first.renderedTokens * 5);
  assert.ok(first.renderedTokens <= 2_500);
  assert.equal(await readFile(fixture, "utf8"), beforeBytes, "compaction must not rewrite the JSONL");

  assert.match(first.summary, /USER \[e120\] — exact\nFix the timeout problem without changing the public API\./);
  assert.match(first.summary, /USER \[e133\] — exact\nNext, document the retry behavior\. Do not change src\/server\/request-handler\.ts again\./);
  assert.match(first.summary, /TOOL RESULT — test-output/);
  assert.match(first.summary, /expected activeRequests=1/);
  assert.match(first.summary, /received activeRequests=3/);
  assert.match(first.summary, /Omitted:/);
  assert.match(first.summary, /Exact source: history_get\("e124"\)/);
  assert.doesNotMatch(first.summary, /FABRICATED_SUMMARY_SHOULD_NEVER_BE_RECOMPACTED/);

  const planEntryIds = first.plan.units.flatMap((unit) => unit.sourceRefs.map((source) => source.entryId));
  const orderedIds = ["e120", "e121", "e122", "e123", "e124", "e125", "e126", "e127", "e128", "e129", "e130", "e131", "e133", "e134"];
  let at = -1;
  for (const id of orderedIds) {
    const next = planEntryIds.indexOf(id, at + 1);
    assert.ok(next > at, `expected ${id} after previous chronological event`);
    at = next;
  }

  for (const unit of first.plan.units) {
    if (!unit.selected.lossy || unit.selected.level === "absent") continue;
    assert.ok(unit.selected.omissions.length > 0, `${unit.id} must declare loss`);
  }
});

test("bounds structural overhead for a very long unfinished autonomous turn", async () => {
  const entries: SessionEntryLike[] = [
    { type: "message", id: "long-user", parentId: null, message: { role: "user", content: "Inspect all components. Do not change the public API." } },
  ];
  let parentId = "long-user";
  for (let index = 0; index < 400; index += 1) {
    const id = `long-step-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: `Plan and inspect routine component ${index} before continuing.` }],
        stopReason: "toolUse",
      },
    });
    parentId = id;
  }
  const result = await compactEntries(entries, {
    config: { targetTokens: 2_000, maxIndividualUnits: 60, maxEpisodeTokens: 140 },
  });
  assert.ok(result.renderedTokens <= 2_000);
  assert.ok(result.plan.units.length < 70);
  assert.match(result.summary, /ACTIVITY SEGMENT/);
  assert.match(result.summary, /Exact range: history_range\("long-step-0", "long-step-25"\)/);
  assert.match(result.summary, /Do not change the public API/);
});

test("hard replay cap retains only the newest chronological suffix when minimum-safe output is too large", async () => {
  const entries: SessionEntryLike[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < 180; index += 1) {
    const id = `cap-user-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      message: {
        role: "user",
        content: `Requirement ${index}: Do not remove this direct restriction. ${"Preserve exact behavior. ".repeat(45)}`,
      },
    });
    parentId = id;
  }
  const result = await compactEntries(entries, { config: { targetTokens: 2_000, maxIndividualUnits: 40 } });
  assert.ok(result.renderedTokens <= HARD_REPLAY_CAP_TOKENS);
  assert.match(result.summary, /Hard replay cap applied/);
  assert.match(result.summary, /history_range\("cap-user-0", "cap-user-/);
  assert.doesNotMatch(result.summary, /USER \[cap-user-0\]/);
  assert.match(result.summary, /USER \[cap-user-179\]/);
  assert.ok(result.validation.issues.some((issue) => issue.code === "hard-replay-cap"));
});

test("rejects a replay that would expand a small historical prefix", async () => {
  await assert.rejects(
    () =>
      compactEntries(
        [
          { type: "message", id: "small-user", parentId: null, message: { role: "user", content: "Hi" } },
          {
            type: "message",
            id: "small-assistant",
            parentId: "small-user",
            message: { role: "assistant", content: [{ type: "text", text: "Hello." }] },
          },
        ],
        { config: { targetTokens: 8_000 } },
      ),
    (error: unknown) =>
      error instanceof CompactionValidationError && error.report.issues.some((issue) => issue.code === "no-net-savings"),
  );
});

test("generation hash includes retained future context used for retrospective analysis", () => {
  const source = [{ type: "message", id: "source", parentId: null, message: { role: "user", content: "Analyze the code." } }] as const;
  const config = resolveCompactorConfig({ targetTokens: 1_000 });
  const implementationTail = [
    { type: "message", id: "future", parentId: "source", message: { role: "user", content: "Implement the fix." } },
  ] as const;
  const researchTail = [
    { type: "message", id: "future", parentId: "source", message: { role: "user", content: "Continue the analysis." } },
  ] as const;
  assert.notEqual(
    computeGenerationHash(source, config, "", implementationTail),
    computeGenerationHash(source, config, "", researchTail),
  );
});

test("generation hash ignores unrelated runtime metadata entries", () => {
  const source = [{ type: "message", id: "source", parentId: null, message: { role: "user", content: "Analyze the code." } }] as const;
  const config = resolveCompactorConfig({ targetTokens: 1_000 });
  const first = [{ type: "custom", customType: "pi-web-state", id: "random-a", data: { runtime: true } }] as const;
  const second = [{ type: "custom", customType: "pi-web-state", id: "random-b", data: { runtime: true } }] as const;
  assert.equal(computeGenerationHash(source, config, "", first), computeGenerationHash(source, config, "", second));
});

test("fixed replay target remains separate from the derived active-context budget", () => {
  assert.equal(selectReplayTarget({ derivedTargetTokens: 2_000, fixedTargetTokens: 6_000, maximumTokens: 8_000 }), 6_000);
  assert.equal(selectReplayTarget({ derivedTargetTokens: 2_000, fixedTargetTokens: 9_000, maximumTokens: 8_000 }), 8_000);
  assert.equal(selectReplayTarget({ derivedTargetTokens: 2_000, maximumTokens: 8_000 }), 2_000);
});

test("summary budget accounts for retained raw tail and reserve", () => {
  assert.equal(
    computeSummaryBudget({ targetActiveContextTokens: 32_000, retainedTailTokens: 9_000, contextReserveTokens: 1_500 }),
    20_000,
  );
  assert.equal(
    computeSummaryBudget({
      targetActiveContextTokens: 12_000,
      retainedTailTokens: 8_500,
      contextReserveTokens: 1_500,
      minSummaryTokens: 1_000,
      maxSummaryTokens: 5_000,
    }),
    2_000,
  );
});
