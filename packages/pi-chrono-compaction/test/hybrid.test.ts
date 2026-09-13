import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareAdaptiveChronoTail,
  previousRegularPiSummary,
  rawSourceMessages,
  regularSummaryMessagesForCut,
  renderHybridCompaction,
} from "../src/pi-hybrid.js";

import { resolveContextCeiling } from "../src/context-budget.js";
import { resolveExtensionSettings } from "../src/pi-extension.js";
import { applyConfigCommand } from "../src/user-config.js";
import type { compact } from "@earendil-works/pi-coding-agent";
import type { SessionEntryLike } from "../src/types.js";

test("adaptive prepared tail shares an exact Pi cut and adjustable model-validated budgets", () => {
  const settings = resolveExtensionSettings(applyConfigCommand({}, "target-context 60000").config);
  assert.equal(settings.targetContextTokens, 60_000);
  assert.equal(resolveContextCeiling(settings.targetContextTokens, 128_000, 1500), 60_000);
  assert.equal(resolveContextCeiling(settings.targetContextTokens, 48_000, 1500), 30_116);
  assert.throws(() => resolveContextCeiling(60_000, 0), /capacity/);
  const entries: SessionEntryLike[] = [
    { type: "message", id: "prefix", message: { role: "user", content: "Earlier prefix" } },
    { type: "message", id: "pi-cut", message: { role: "user", content: "Earlier retained work. ".repeat(2800) } },
    { type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] } },
    { type: "message", id: "result", message: { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "Exact read result. ".repeat(700) }] } },
    { type: "message", id: "current", message: { role: "user", content: "Continue the unresolved task." } },
  ];
  const original = JSON.stringify(entries);
  const preparation = { firstKeptEntryId: "pi-cut", messagesToSummarize: rawSourceMessages(entries.slice(0, 1)),
    turnPrefixMessages: [], previousSummary: "Old independent summary", isSplitTurn: false, tokensBefore: 40_000,
    settings: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() } } as Parameters<typeof compact>[0];
  const result = prepareAdaptiveChronoTail(entries, preparation, 3000, 6000);
  assert.equal(result.tail.firstKeptEntryId, "call");
  assert.ok(result.tail.actualTokens >= 3000 && result.tail.actualTokens <= 6000);
  assert.equal(result.preparation.firstKeptEntryId, result.tail.firstKeptEntryId);
  assert.match(JSON.stringify(result.preparation.messagesToSummarize), /Earlier retained work/);
  assert.doesNotMatch(JSON.stringify(result.preparation.messagesToSummarize), /Exact read result|unresolved task/);
  assert.equal(JSON.stringify(entries), original, "full tool results must remain unchanged");
  assert.equal(preparation.firstKeptEntryId, "pi-cut", "Pi's input preparation is not mutated");
  assert.throws(() => prepareAdaptiveChronoTail(entries.slice(0, 4), preparation, 1000, 2000), /No complete tool-safe/);
  const prior = renderHybridCompaction("Independent prior Pi summary", "CHRONO HISTORY MUST NOT BE SUMMARY INPUT");
  assert.equal(previousRegularPiSummary([{ type: "compaction", summary: prior }], prior), "Independent prior Pi summary");
});

test("ChronoCompact raw replay input excludes prior generated compaction summaries", () => {
  const messages = rawSourceMessages([
    {
      type: "message",
      id: "raw-user",
      parentId: null,
      message: { role: "user", content: "Original raw instruction." },
    },
    {
      type: "compaction",
      id: "old-compaction",
      parentId: "raw-user",
      summary: "PREVIOUS_GENERATED_SUMMARY",
      firstKeptEntryId: "raw-user",
    },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.doesNotMatch(JSON.stringify(messages), /PREVIOUS_GENERATED_SUMMARY/);
});

test("regular Pi summary messages follow the final raw-tail boundary", () => {
  const messages = regularSummaryMessagesForCut(
    [
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "old raw" } },
      { type: "compaction", id: "prior", parentId: "old", summary: "OLD_COMBINED", firstKeptEntryId: "old" },
      { type: "message", id: "middle", parentId: "prior", message: { role: "assistant", content: [{ type: "text", text: "middle raw" }] } },
      { type: "message", id: "final-cut", parentId: "middle", message: { role: "user", content: "retained raw" } },
    ],
    "final-cut",
  );
  const encoded = JSON.stringify(messages);
  assert.match(encoded, /old raw/);
  assert.match(encoded, /middle raw/);
  assert.doesNotMatch(encoded, /OLD_COMBINED/);
  assert.doesNotMatch(encoded, /retained raw/);
});

test("regular Pi summary rebase uses original raw messages and no generated compaction text", () => {
  const messages = regularSummaryMessagesForCut([
    { type: "message", id: "original", parentId: null, message: { role: "user", content: "original raw source" } },
    { type: "compaction", id: "prior", parentId: "original", summary: "PRIOR_COMBINED_OUTPUT", firstKeptEntryId: "original" },
    { type: "message", id: "new", parentId: "prior", message: { role: "assistant", content: [{ type: "text", text: "new raw source" }] } },
    { type: "message", id: "cut", parentId: "new", message: { role: "user", content: "retained" } },
  ], "cut", true);
  const encoded = JSON.stringify(messages);
  assert.match(encoded, /original raw source/);
  assert.match(encoded, /new raw source/);
  assert.doesNotMatch(encoded, /PRIOR_COMBINED_OUTPUT|retained/);
});

test("regular Pi summary stream never receives the prior ChronoCompact replay", () => {
  const selected = previousRegularPiSummary(
    [
      {
        type: "compaction",
        id: "chrono-generation",
        parentId: null,
        summary: "COMBINED_PI_SUMMARY_AND_CHRONOCOMPACT_REPLAY",
        firstKeptEntryId: "kept",
        details: { kind: "chrono-compact-event-stream-context-compaction", piSummary: "REGULAR_PI_ONLY" },
      },
    ],
    "PREPARATION_CONTAINING_COMBINED_CONTEXT",
  );
  assert.equal(selected, "REGULAR_PI_ONLY");
});

test("a pre-ChronoCompact regular Pi compaction remains valid previous summary input", () => {
  const selected = previousRegularPiSummary(
    [
      {
        type: "compaction",
        id: "pi-generation",
        parentId: null,
        summary: "REGULAR_PI_SUMMARY",
        firstKeptEntryId: "kept",
      },
    ],
    "REGULAR_PI_SUMMARY",
  );
  assert.equal(selected, "REGULAR_PI_SUMMARY");
});

test("combined context places the regular Pi compaction summary before the event replay", () => {
  const rendered = renderHybridCompaction(
    "## Goal\nPreserve chronological context.",
    "# CHRONOCOMPACT CHRONOLOGICAL REPLAY\n[e1 USER — exact]\nContinue.",
  );
  const regularAt = rendered.indexOf("## REGULAR PI COMPACTION SUMMARY");
  const replayAt = rendered.indexOf("## CHRONOCOMPACT EVENT REPLAY");
  assert.ok(regularAt >= 0 && replayAt > regularAt);
  assert.match(rendered, /Pi generated this regular compaction summary independently/);
  assert.match(rendered, /replay below was not used as summary input/);
  assert.match(rendered, /Preserve chronological context/);
  assert.match(rendered, /\[e1 USER — exact\]/);
});
