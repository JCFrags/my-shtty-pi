import assert from "node:assert/strict";
import test from "node:test";
import {
  previousRegularPiSummary,
  rawSourceMessages,
  regularSummaryMessagesForCut,
  renderHybridCompaction,
} from "../src/pi-hybrid.js";

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
