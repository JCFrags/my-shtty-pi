import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHistoryEditor,
  type HistoryEditor,
  type HistoryEditorRequest,
} from "../src/history-editor.js";
import { renderCompressionPlan } from "../src/render.js";
import type { CompressionPlan, HistoricalBlock, PlannedUnit } from "../src/types.js";

function block(id: string, index: number, kind: HistoricalBlock["kind"], text: string, protectedExact = false): HistoricalBlock {
  return {
    id: `${id}:${kind}:0`,
    entryId: id,
    entryIndex: index,
    kind,
    label: kind.toUpperCase(),
    exactText: text,
    rawTokens: Math.ceil(text.length / 4),
    sourceRefs: [{ entryId: id }],
    protectedExact,
    reproducible: kind === "tool_result",
    unresolved: false,
    exactIdentifiers: [],
    attributes: {},
  };
}

function unit(source: HistoricalBlock, importance: number): PlannedUnit {
  const selected = {
    id: `${source.id}:raw`,
    level: "raw" as const,
    text: source.exactText,
    tokens: source.rawTokens,
    rawTokens: source.rawTokens,
    utility: 1,
    lossy: false,
    omissions: [],
    sourceRefs: source.sourceRefs,
    metadata: {},
  };
  const marker = {
    id: `${source.id}:marker`,
    level: "marker" as const,
    text: "Historical detail remains available through exact recovery.",
    tokens: 14,
    rawTokens: source.rawTokens,
    utility: 0.45,
    lossy: true,
    reducer: "historical-marker",
    omissions: [{ description: "Selected historical detail was replaced by a recovery marker" }],
    sourceRefs: source.sourceRefs,
    metadata: {},
  };
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    startEntryIndex: source.entryIndex,
    endEntryIndex: source.entryIndex,
    sourceRefs: source.sourceRefs,
    rawTokens: source.rawTokens,
    importance,
    importanceReasons: [],
    protectedExact: source.protectedExact,
    candidates: source.protectedExact ? [selected] : [marker, selected],
    toolCallIds: [],
    selected,
  };
}

function fixturePlan(): { blocks: HistoricalBlock[]; plan: CompressionPlan } {
  const blocks = [
    block("constraint", 0, "user", "Keep the public API restriction exactly.", true),
    block("routine", 1, "tool_result", "Routine provider-independent output. ".repeat(400)),
    block("current", 2, "assistant_text", "Current implementation state remains visible."),
  ];
  const units = [unit(blocks[0]!, 300), unit(blocks[1]!, 20), unit(blocks[2]!, 140)];
  return {
    blocks,
    plan: {
      targetTokens: 5_000,
      estimatedTokens: units.reduce((sum, item) => sum + item.selected.tokens, 0),
      rawTokens: units.reduce((sum, item) => sum + item.rawTokens, 0),
      units,
      warnings: [],
    },
  };
}

function decision(item: HistoryEditorRequest["items"][number], action: "keep" | "compress") {
  return {
    unitId: item.unitId,
    importance: item.mustKeepCurrent ? "critical" : item.goalRelevance >= 0.75 ? "high" : "low",
    confidence: 0.9,
    action,
  };
}

function compressEligibleResponse(request: HistoryEditorRequest): string {
  return JSON.stringify({
    version: 2,
    decisions: request.items.map((item) => decision(item, item.compress ? "compress" : "keep")),
  });
}

async function apply(editor: HistoryEditor) {
  const fixture = fixturePlan();
  const result = await applyHistoryEditor(
    fixture.plan,
    fixture.blocks,
    "synthetic-generation",
    true,
    editor,
    {
      maxInputTokens: 20_000,
      maxOutputTokens: 5_000,
      retentionHints: "Preserve the public API restriction.",
    },
  );
  return { blocks: fixture.blocks, baselinePlan: fixture.plan, plan: result.plan, observation: result.observation };
}

test("one V1.1 job returns typed decisions and deterministic code renders local candidates", async () => {
  let calls = 0;
  let requestSeen: HistoryEditorRequest | undefined;
  const result = await apply({
    async edit(request) {
      calls += 1;
      requestSeen = request;
      return { text: compressEligibleResponse(request), model: "synthetic/provider-model" };
    },
  });

  assert.equal(calls, 1);
  assert.ok(requestSeen);
  assert.equal(requestSeen.schemaVersion, 2);
  assert.equal(requestSeen.items[0]!.textWasBounded, false, "protected text is not excerpted");
  assert.equal(requestSeen.items[1]!.textWasBounded, true, "large unprotected text is bounded");
  assert.equal(result.observation.status, "applied", result.observation.reason);
  assert.equal(result.observation.outputDecisions, requestSeen.items.length);
  assert.equal(result.observation.changedItems, 1);
  const baseline = renderCompressionPlan(result.baselinePlan, "synthetic-generation", true);
  const rendered = renderCompressionPlan(result.plan, "synthetic-generation", true);
  assert.ok(rendered.tokens <= baseline.tokens - 100);
  assert.match(rendered.text, /Keep the public API restriction exactly/);
  assert.match(rendered.text, /history_(?:get|range)\(/);
  assert.doesNotMatch(rendered.text, /synthetic\/provider-model/);
});

test("malformed output uses the byte-identical deterministic replay after one call", async () => {
  let calls = 0;
  const result = await apply({
    async edit() {
      calls += 1;
      return { text: "not-json" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.observation.status, "fallback");
  assert.equal(result.plan, result.baselinePlan, "fallback keeps the deterministic plan object");
  assert.equal(
    renderCompressionPlan(result.plan, "synthetic-generation", true).text,
    renderCompressionPlan(result.baselinePlan, "synthetic-generation", true).text,
  );
});

test("omitted, altered, or misclassified protected items cannot change exact final bytes", async () => {
  let requestSeen: HistoryEditorRequest | undefined;
  const result = await apply({
    async edit(request) {
      requestSeen = request;
      const protectedItem = request.items[0]!;
      const routine = request.items[1]!;
      return {
        text: JSON.stringify({
          version: 2,
          decisions: [decision(protectedItem, "compress"), decision(routine, "compress")],
        }),
      };
    },
  });
  assert.ok(requestSeen);
  assert.equal(result.observation.status, "applied", result.observation.reason);
  assert.equal(result.observation.rejectedDecisions, 1);
  assert.ok((result.observation.missingDecisions ?? 0) >= 2);
  const rendered = renderCompressionPlan(result.plan, "synthetic-generation", true).text;
  assert.match(rendered, /Keep the public API restriction exactly/);
  assert.doesNotMatch(rendered, /"action":"compress"/);
});

test("model text fields and unsupported facts cannot enter the deterministic replay", async () => {
  const result = await apply({
    async edit(request) {
      return {
        text: JSON.stringify({
          version: 2,
          decisions: [{ ...decision(request.items[1]!, "compress"), text: "Invented value 999999." }],
        }),
      };
    },
  });
  assert.equal(result.observation.status, "fallback");
  const rendered = renderCompressionPlan(result.plan, "synthetic-generation", true).text;
  assert.equal(result.plan, result.baselinePlan, "unsupported model fields cause complete deterministic fallback");
  assert.equal(rendered, renderCompressionPlan(result.baselinePlan, "synthetic-generation", true).text);
  assert.doesNotMatch(rendered, /999999/);
});
