import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseHistoricalBlocks } from "../src/blocks.js";
import { buildCausalMemory } from "../src/causal-memory.js";
import { readSessionJsonl } from "../src/jsonl.js";
import extension from "../src/pi-extension.js";
import { recallHistory, renderRecall } from "../src/recall.js";
import { buildLocalSearchIndex, renderRankedSearch, searchLocalHistory } from "../src/search-index.js";
import type { SessionEntryLike } from "../src/types.js";
import { estimateTokensFromText } from "../src/utils.js";

const longEntryId = `long-${"x".repeat(301)}`;
const retryEntryId = `retry-${"r".repeat(1_601)}`;
const retryInstruction = "Recovery: repeat the same history_search query and filters with tokenBudget=2000 and no cursor.";

function recoveryEntries(): SessionEntryLike[] {
  return [
    {
      type: "message",
      id: "page-first",
      parentId: null,
      timestamp: "2026-08-03T00:00:00.000Z",
      message: { role: "user", content: `paging-needle first match ${"large first body ".repeat(90)}` },
    },
    {
      type: "message",
      id: "page-second",
      parentId: "page-first",
      timestamp: "2026-08-03T00:01:00.000Z",
      message: { role: "user", content: `paging-needle second distinct match ${"large second body ".repeat(90)}` },
    },
    {
      type: "message",
      id: longEntryId,
      parentId: "page-second",
      timestamp: "2026-08-03T00:02:00.000Z",
      message: { role: "user", content: `unicode-long-needle Καλημέρα 世界 ${"oversized unicode body ".repeat(90)}` },
    },
    {
      type: "message",
      id: retryEntryId,
      parentId: longEntryId,
      timestamp: "2026-08-03T00:02:30.000Z",
      message: { role: "user", content: `executable-retry-needle useful larger-budget match ${"retry body ".repeat(90)}` },
    },
    {
      type: "message",
      id: "recovery-user",
      parentId: retryEntryId,
      timestamp: "2026-08-03T00:03:00.000Z",
      message: { role: "user", content: `Inspect the resource and preserve exact recovery. ${"objective detail ".repeat(90)}` },
    },
    {
      type: "message",
      id: "recovery-call",
      parentId: "recovery-user",
      timestamp: "2026-08-03T00:04:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "recovery-read", name: "read", arguments: { path: "/repo/src/über-resource.ts", offset: 1, limit: 400 } }],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "recovery-result",
      parentId: "recovery-call",
      timestamp: "2026-08-03T00:05:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "recovery-read",
        toolName: "read",
        content: [{ type: "text", text: `oversized-recall-needle Ελληνικά 世界 ${"resource expansion payload ".repeat(180)}` }],
        isError: false,
      },
    },
    {
      type: "message",
      id: "recovery-done",
      parentId: "recovery-result",
      timestamp: "2026-08-03T00:06:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: `Completed the resource review successfully. ${"large outcome ".repeat(90)}` }], stopReason: "stop" },
    },
  ];
}

function assertBounded(text: string, budget = 120): void {
  assert.ok(estimateTokensFromText(text) <= budget, `rendered ${estimateTokensFromText(text)} tokens for budget ${budget}`);
  assert.doesNotMatch(text, /budget reached|\[truncated\]/i);
}

function textOf(result: any): string {
  return result.content?.[0]?.text ?? "";
}

test("core rendering preserves complete paging and recovery fields at the minimum budget", () => {
  const entries = recoveryEntries();
  const index = buildLocalSearchIndex(parseHistoricalBlocks(entries));
  const first = searchLocalHistory(index, "paging-needle", { limit: 1, tokenBudget: 120 });
  const firstText = renderRankedSearch(first);
  assertBounded(firstText);
  assert.ok(first.nextCursor);
  assert.ok(firstText.includes(`More: use cursor ${first.nextCursor}`));
  assert.ok(firstText.includes(first.hits[0]!.sourceRef.entryId));
  assert.equal(first.returnedTokens, estimateTokensFromText(firstText));

  const second = searchLocalHistory(index, "paging-needle", { limit: 1, tokenBudget: 120, cursor: first.nextCursor });
  const secondText = renderRankedSearch(second);
  assertBounded(secondText);
  assert.notEqual(second.hits[0]!.sourceRef.entryId, first.hits[0]!.sourceRef.entryId);
  assert.ok(secondText.includes(second.hits[0]!.sourceRef.entryId));
  assert.equal(second.returnedTokens, estimateTokensFromText(secondText));

  const repeated = searchLocalHistory(index, "paging-needle", { limit: 1, tokenBudget: 120 });
  assert.equal(repeated.cacheHit, true);
  assert.equal(renderRankedSearch(repeated), firstText);

  const long = searchLocalHistory(index, "unicode-long-needle", { limit: 1, tokenBudget: 120 });
  const longText = renderRankedSearch(long);
  assertBounded(longText);
  assert.ok(longText.includes(longEntryId));
  assert.match(longText, /Καλημέρα|Exact recovery/);
  assert.equal(long.returnedTokens, estimateTokensFromText(longText));
  const unicode = searchLocalHistory(index, "Καλημέρα", { limit: 1, tokenBudget: 120 });
  assertBounded(renderRankedSearch(unicode));
  assert.ok(renderRankedSearch(unicode).includes(longEntryId));

  const tiny = searchLocalHistory(index, "no-such-history-match", { mode: "exact", tokenBudget: 1 });
  const tinyText = renderRankedSearch(tiny);
  assert.equal(tiny.tokenBudget, 120);
  assertBounded(tinyText);
  assert.match(tinyText, /no matches/i);

  const model = buildCausalMemory(index.documents.map((document) => document.block), index.resourceLineage);
  const longRecovery = recallHistory(index, model, "unicode-long-needle", { level: "episode", limit: 1, tokenBudget: 120 });
  const longRecoveryText = renderRecall(longRecovery);
  assertBounded(longRecoveryText);
  assert.ok(longRecoveryText.includes("Recovery: repeat the same history_recall query with level=episode and tokenBudget=2000."));
  assert.ok(!longRecoveryText.includes(longEntryId.slice(0, 40)));

  for (const level of ["cue", "episode", "resource", "block"] as const) {
    const recalled = recallHistory(index, model, "oversized-recall-needle", { level, limit: 1, tokenBudget: 1 });
    const rendered = renderRecall(recalled);
    assert.equal(recalled.tokenBudget, 120);
    assert.ok(recalled.items.length >= 1, `${level} omitted every matching item`);
    assertBounded(rendered);
    assert.match(rendered, /Exact recovery: history_(?:get|range)\(|Recovery: repeat the same history_recall/);
    assert.equal(recalled.renderedTokens, estimateTokensFromText(rendered));
    const repeatedRecall = recallHistory(index, model, "oversized-recall-needle", { level, limit: 1, tokenBudget: 1 });
    assert.equal(renderRecall(repeatedRecall), rendered);
  }
});

test("core long-identity search retry restarts without a cursor and exposes exact recovery", () => {
  const index = buildLocalSearchIndex(parseHistoricalBlocks(recoveryEntries()));
  const options = { mode: "ranked" as const, limit: 1, tokenBudget: 120, filters: { kinds: ["user" as const] } };
  const fallback = searchLocalHistory(index, "executable-retry-needle", options);
  const fallbackText = renderRankedSearch(fallback);
  assertBounded(fallbackText);
  assert.ok(fallbackText.includes(retryInstruction));
  assert.doesNotMatch(fallbackText, /More: use cursor|cursor [A-Za-z0-9_-]{20,}/);
  assert.ok(!fallbackText.includes(retryEntryId.slice(0, 40)));
  assert.equal(fallback.returnedTokens, estimateTokensFromText(fallbackText));

  const fallbackRepeat = searchLocalHistory(index, "executable-retry-needle", options);
  assert.equal(fallbackRepeat.cacheHit, true);
  assert.equal(renderRankedSearch(fallbackRepeat), fallbackText);

  const retryOptions = { ...options, tokenBudget: 2_000 };
  const retry = searchLocalHistory(index, "executable-retry-needle", retryOptions);
  const retryText = renderRankedSearch(retry);
  assertBounded(retryText, 2_000);
  assert.ok(retryText.includes(`history_get(${JSON.stringify(retryEntryId)})`));
  assert.ok(retryText.includes(retryEntryId));
  assert.doesNotMatch(retryText, /stale or invalid cursor|Recovery: repeat the same history_search/);
  assert.equal(retry.returnedTokens, estimateTokensFromText(retryText));
  const retryRepeat = searchLocalHistory(index, "executable-retry-needle", retryOptions);
  assert.equal(retryRepeat.cacheHit, true);
  assert.equal(renderRankedSearch(retryRepeat), retryText);
});

test("extension responses page, repeat deterministically, and recover exact oversized matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-render-recovery-"));
  const sessionPath = join(directory, "session.jsonl");
  const configPath = join(directory, "config.json");
  const entries = recoveryEntries();
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    PI_CHRONO_CONFIG_PATH: configPath,
    PI_CHRONO_CACHE: "false",
    PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false",
    PI_CHRONO_TOOL_RESULT_PROJECTION: "off",
  })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "render-recovery-session", timestamp: "2026-08-03T00:00:00.000Z", cwd: directory }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ];
    await writeFile(sessionPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    const tools = new Map<string, (...args: any[]) => Promise<any>>();
    const pi = {
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool.execute); },
      registerCommand() {},
      on() {},
      appendEntry() {},
      sendMessage() {},
    };
    extension(pi as unknown as ExtensionAPI);
    const context = {
      hasUI: false,
      model: undefined,
      thinkingLevel: "medium",
      sessionManager: {
        getSessionFile: () => sessionPath,
        getEntries: () => entries,
        getBranch: () => entries,
      },
      getContextUsage: () => undefined,
      isIdle: () => true,
      abort() {},
      compact() {},
      ui: { notify() {} },
      modelRegistry: { getApiKeyAndHeaders() { throw new Error("provider access is prohibited"); } },
    };

    const search = tools.get("history_search");
    const recall = tools.get("history_recall");
    const get = tools.get("history_get");
    assert.ok(search && recall && get);

    const first = await search("page-1", { query: "paging-needle", mode: "ranked", limit: 1, tokenBudget: 120 }, undefined, undefined, context);
    const firstText = textOf(first);
    assertBounded(firstText);
    const cursor = firstText.match(/More: use cursor ([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(cursor);
    assert.ok(firstText.includes(`More: use cursor ${cursor}`));

    const repeated = await search("page-repeat", { query: "paging-needle", mode: "ranked", limit: 1, tokenBudget: 120 }, undefined, undefined, context);
    assert.equal(textOf(repeated), firstText);
    const second = await search("page-2", { query: "paging-needle", mode: "ranked", limit: 1, tokenBudget: 120, cursor }, undefined, undefined, context);
    const secondText = textOf(second);
    assertBounded(secondText);
    assert.notEqual(secondText, firstText);

    const long = await search("long", { query: "unicode-long-needle", mode: "ranked", limit: 1, tokenBudget: 120 }, undefined, undefined, context);
    const longText = textOf(long);
    assertBounded(longText);
    assert.ok(longText.includes(longEntryId));

    const retryFallback = await search("retry-small", { query: "executable-retry-needle", mode: "ranked", kind: "user", limit: 1, tokenBudget: 120 }, undefined, undefined, context);
    const retryFallbackText = textOf(retryFallback);
    assertBounded(retryFallbackText);
    assert.ok(retryFallbackText.includes(retryInstruction));
    assert.equal(retryFallback.details.returnedTokens, estimateTokensFromText(retryFallbackText));
    assert.doesNotMatch(retryFallbackText, /More: use cursor|cursor [A-Za-z0-9_-]{20,}/);
    const retryFallbackRepeat = await search("retry-small-repeat", { query: "executable-retry-needle", mode: "ranked", kind: "user", limit: 1, tokenBudget: 120 }, undefined, undefined, context);
    assert.equal(textOf(retryFallbackRepeat), retryFallbackText);

    const retryLarge = await search("retry-large", { query: "executable-retry-needle", mode: "ranked", kind: "user", limit: 1, tokenBudget: 2_000 }, undefined, undefined, context);
    const retryLargeText = textOf(retryLarge);
    assertBounded(retryLargeText, 2_000);
    assert.ok(retryLargeText.includes(`history_get(${JSON.stringify(retryEntryId)})`));
    assert.ok(retryLargeText.includes(retryEntryId));
    assert.doesNotMatch(retryLargeText, /stale or invalid cursor|Recovery: repeat the same history_search/);
    assert.equal(retryLarge.details.returnedTokens, estimateTokensFromText(retryLargeText));
    const retryLargeRepeat = await search("retry-large-repeat", { query: "executable-retry-needle", mode: "ranked", kind: "user", limit: 1, tokenBudget: 2_000 }, undefined, undefined, context);
    assert.equal(textOf(retryLargeRepeat), retryLargeText);
    const retryExact = await get("retry-get", { entryId: retryEntryId }, undefined, undefined, context);
    assert.match(textOf(retryExact), /executable-retry-needle useful larger-budget match/);

    const noHit = await search("none", { query: "not-present-anywhere", mode: "exact", tokenBudget: 1 }, undefined, undefined, context);
    assert.equal(noHit.details.tokenBudget, 120);
    assertBounded(textOf(noHit));
    assert.match(textOf(noHit), /no matches/i);

    let exactGetChecked = false;
    for (const level of ["cue", "episode", "resource", "block"] as const) {
      const result: any = await recall(`recall-${level}`, { query: "oversized-recall-needle", level, limit: 1, tokenBudget: 120 }, undefined, undefined, context);
      const rendered = textOf(result);
      assertBounded(rendered);
      assert.ok(result.details.items >= 1, `${level} extension response omitted every matching item`);
      assert.equal(result.details.renderedTokens, estimateTokensFromText(rendered));
      assert.match(rendered, /Exact recovery: history_(?:get|range)\(|Recovery: repeat the same history_recall/);
      const blockIndex = rendered.match(/history_get\("recovery-result"(?:, blockIndex=(\d+))?\)/)?.[1];
      if (!exactGetChecked && rendered.includes('history_get("recovery-result"')) {
        const exact = await get("get-recovery", { entryId: "recovery-result", ...(blockIndex === undefined ? {} : { blockIndex: Number(blockIndex) }) }, undefined, undefined, context);
        assert.match(textOf(exact), /oversized-recall-needle/);
        exactGetChecked = true;
      }
    }
    assert.equal(exactGetChecked, true);

    const parsed = await readSessionJsonl(sessionPath);
    assert.equal(parsed.entryById.has(longEntryId), true);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
