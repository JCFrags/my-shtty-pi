import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyHistoryEditor,
  DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS,
  historyEditorPrompt,
  historyEditorStructuralHeadroom,
  selectHistoryEditorBudget,
  type HistoryEditorRequest,
} from "../src/history-editor.js";
import extension, { HARD_COMBINED_CONTEXT_CAP_TOKENS } from "../src/pi-extension.js";
import { renderCompressionPlan } from "../src/render.js";
import { isSafeCompactionCut, selectDynamicRawTail } from "../src/tail-selection.js";
import type { CompressionPlan, HistoricalBlock, PlannedUnit, SessionEntryLike } from "../src/types.js";

function message(id: string, role: string, tokens: number, extra: Record<string, unknown> = {}): SessionEntryLike {
  return {
    type: "message",
    id,
    message: { role, content: "x".repeat(tokens * 4), ...extra },
    testTokens: tokens,
  };
}

function estimate(entries: readonly SessionEntryLike[]): number {
  return entries.reduce((sum, entry) => sum + (typeof entry.testTokens === "number" ? entry.testTokens : 0), 0);
}

test("V1.1 adaptive tail stays small and rejects only a call/result crossing", () => {
  const entries: SessionEntryLike[] = [
    message("old", "user", 1_000),
    message("call", "assistant", 1_000, { content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }] }),
    { type: "custom_message", id: "between", content: "between", testTokens: 1_000 },
    message("result", "toolResult", 1_000, { toolCallId: "paired" }),
    message("checkpoint", "user", 1_000),
    message("missing", "assistant", 1_000, { content: [{ type: "toolCall", id: "permanently-missing", name: "read", arguments: {} }] }),
    { type: "custom_message", id: "after-missing", content: "safe", testTokens: 1_000 },
    message("current", "user", 1_000),
    message("current-work", "assistant", 1_500),
    message("pending", "assistant", 500, { content: [{ type: "toolCall", id: "currently-pending", name: "bash", arguments: {} }] }),
  ];

  assert.equal(isSafeCompactionCut(entries, 2), false, "the paired result remains in the retained suffix");
  assert.equal(isSafeCompactionCut(entries, 6), true, "an old permanently missing result must not poison later cuts");
  const selected = selectDynamicRawTail(entries, 3_000, 6_000, estimate);
  assert.ok(selected);
  assert.ok(selected.actualTokens >= 3_000 && selected.actualTokens <= 6_000);
  assert.ok(selected.cutIndex >= 5, "content formerly left in Pi's large raw tail is Chrono eligible");
  assert.equal(entries.at(-1)?.id, "pending", "the incomplete current tool call stays in the exact suffix");
  assert.match(selected.reason, /1500-token continuity margin.*complete raw-tail tool structure/);
});

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

test("V1.1 classifier gets bounded gradient metadata while deterministic text stays authoritative", async () => {
  const blocks = [
    block("old-noise", 0, "tool_result", "Routine old output. ".repeat(300)),
    block("old-critical", 1, "user", "Do not change the public API. ".repeat(10), true),
    block("middle", 2, "assistant_text", "Middle implementation detail. ".repeat(200)),
    block("recent-useful", 3, "assistant_text", "Current goal remains active. ".repeat(80)),
    block("recent-noise", 4, "tool_result", "Routine recent output. ".repeat(300)),
  ];
  const plan: CompressionPlan = {
    targetTokens: 6_000,
    estimatedTokens: blocks.reduce((sum, item) => sum + item.rawTokens, 0),
    rawTokens: blocks.reduce((sum, item) => sum + item.rawTokens, 0),
    units: [unit(blocks[0]!, 20), unit(blocks[1]!, 300), unit(blocks[2]!, 60), unit(blocks[3]!, 140), unit(blocks[4]!, 20)],
    warnings: [],
  };
  let requestSeen: HistoryEditorRequest | undefined;
  let calls = 0;
  const edited = await applyHistoryEditor(plan, blocks, "synthetic-gradient", false, {
    async edit(request) {
      calls += 1;
      requestSeen = request;
      return {
        model: "synthetic/provider",
        text: JSON.stringify({
          version: 2,
          decisions: request.items.map((item) => ({
            unitId: item.unitId,
            importance: item.importance >= 0.8 ? "critical" : item.importance >= 0.5 ? "high" : "low",
            confidence: 0.9,
            action: item.unitId === "old-critical:user:0" || item.unitId === "recent-useful:assistant_text:0"
              ? "keep"
              : item.compress ? "compress" : "keep",
          })),
        }),
      };
    },
  }, { maxInputTokens: 20_000, maxOutputTokens: 6_000, retentionHints: "Keep the public API constraint." });

  assert.equal(calls, 1);
  assert.equal(edited.observation.status, "applied", edited.observation.reason);
  assert.ok(requestSeen);
  assert.ok(requestSeen.items.every((item) => [item.age, item.goalRelevance, item.importance].every((value) => value >= 0 && value <= 1)));
  assert.deepEqual(requestSeen.items.map((item) => item.retentionTreatment), ["aggressive", "light", "moderate", "light", "moderate"]);
  assert.equal(requestSeen.items[0]!.textWasBounded, true);
  assert.equal(requestSeen.items[1]!.textWasBounded, false, "protected text is visible in full");
  assert.equal(requestSeen.items[1]!.mustKeepCurrent, true);
  assert.ok(requestSeen.items[1]!.age > requestSeen.items[4]!.age);
  assert.ok(requestSeen.items[1]!.importance > requestSeen.items[4]!.importance, "old critical value outranks recent noise");
  assert.match(edited.plan.units[1]!.selected.text, /Do not change the public API/);
  assert.match(renderCompressionPlan(edited.plan, "synthetic-gradient", false).text, /history_get\("recent-noise"\)/);
  assert.equal(requestSeen.preferredOutputTokens <= requestSeen.maxOutputTokens, true);

  const prompt = historyEditorPrompt(requestSeen);
  assert.match(prompt, /do not write, summarize, or copy the final replay/i);
  assert.match(prompt, /Omitted items deterministically keep their current treatment/);
  assert.match(prompt, /Goal relevance and importance outrank age/);
  assert.match(prompt, /output text is never rendered/);
});

test("V1.1 adaptive editor budget expands only for high-value ultra-long history", () => {
  const source = block("ultra-critical", 0, "user", "Critical constraint. ".repeat(1_200), true);
  const critical = unit(source, 300);
  const longPlan: CompressionPlan = {
    targetTokens: 20_000,
    estimatedTokens: 12_000,
    rawTokens: 12_000,
    units: [{ ...critical, selected: { ...critical.selected, tokens: 5_000, rawTokens: 5_000 }, rawTokens: 5_000 }],
    warnings: [],
  };
  const expanded = selectHistoryEditorBudget(longPlan, 14_000, 16_000, 20_000);
  assert.equal(expanded.expandedForHighValueHistory, true);
  assert.ok(expanded.maxOutputTokens > 8_000);
  assert.ok(expanded.preferredOutputTokens < expanded.maxOutputTokens);

  const routine = { ...longPlan, units: [{ ...longPlan.units[0]!, protectedExact: false, importance: 20 }] };
  const bounded = selectHistoryEditorBudget(routine, 14_000, 16_000, 20_000);
  assert.equal(bounded.expandedForHighValueHistory, false);
  assert.equal(bounded.maxOutputTokens, 8_000);

  const manyItemHeadroom = historyEditorStructuralHeadroom(16_000, 600);
  assert.equal(manyItemHeadroom, 6_400);
  assert.ok(16_000 - manyItemHeadroom >= 9_600, "hundreds of metadata items keep at least 60% for model text");
  assert.equal(DEFAULT_HISTORY_EDITOR_MAX_INPUT_TOKENS, 50_000);
});

test("V1.1 omission and misclassification cannot remove protected or first-run failure text", async () => {
  const firstRunText = "The failed attempt did reach Linux. I found a boot with two NVIDIA GPUs and a large error record.";
  const blocks = [
    block("constraint", 0, "user", "Keep this exact restriction.", true),
    block("first-run", 1, "assistant_text", firstRunText),
    block("noise", 2, "tool_result", "Routine provider-independent output. ".repeat(300)),
  ];
  const units = [unit(blocks[0]!, 300), unit(blocks[1]!, 180), unit(blocks[2]!, 20)];
  const plan: CompressionPlan = {
    targetTokens: 3_000,
    estimatedTokens: units.reduce((sum, item) => sum + item.selected.tokens, 0),
    rawTokens: units.reduce((sum, item) => sum + item.rawTokens, 0),
    units,
    warnings: [],
  };
  let calls = 0;
  let requestSeen: HistoryEditorRequest | undefined;
  const regressionResponse = await readFile(resolve("test/fixtures/history-editor-first-rejection-omission.json"), "utf8");
  const result = await applyHistoryEditor(plan, blocks, "synthetic-protection", false, {
    async edit(request) {
      calls += 1;
      requestSeen = request;
      return { text: regressionResponse };
    },
  }, { maxInputTokens: 10_000, maxOutputTokens: 3_000 });
  assert.equal(calls, 1);
  assert.ok(requestSeen);
  assert.equal(requestSeen.items[0]!.mustKeepCurrent, true);
  assert.equal(requestSeen.items[1]!.requiredExactEvidence, true);
  assert.equal(requestSeen.items[1]!.mustKeepCurrent, true);
  assert.equal(requestSeen.items[1]!.compress, null);
  assert.equal(result.observation.status, "applied", result.observation.reason);
  assert.equal(result.observation.rejectedDecisions, 1);
  assert.ok((result.observation.missingDecisions ?? 0) >= 1);
  const rendered = renderCompressionPlan(result.plan, "synthetic-protection", false).text;
  assert.match(rendered, /Keep this exact restriction/);
  assert.match(rendered, /The failed attempt did reach Linux/);
  assert.doesNotMatch(rendered, /999999/);
});

test("V1.1 extension default tail and all three context layers stay under the hard cap", async () => {
  const hooks = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>>();
  const names = ["PI_CHRONO_CONFIG_PATH", "PI_CHRONO_RAW_TAIL", "PI_CHRONO_PI_SUMMARY", "PI_CHRONO_HISTORY_EDITOR", "PI_CHRONO_CACHE"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.PI_CHRONO_CONFIG_PATH = join(tmpdir(), `chrono-v11-focused-${process.pid}.json`);
  delete process.env.PI_CHRONO_RAW_TAIL;
  process.env.PI_CHRONO_PI_SUMMARY = "false";
  process.env.PI_CHRONO_HISTORY_EDITOR = "false";
  process.env.PI_CHRONO_CACHE = "false";
  try {
    extension({
      registerTool() {},
      registerCommand() {},
      on(name: string, handler: (event: Record<string, unknown>, context: Record<string, unknown>) => unknown) {
        if (hooks.has(name)) throw new Error(`Test hook mock refused duplicate handler for ${name}.`);
        hooks.set(name, handler);
      },
      appendEntry() {},
      sendMessage() {},
    } as unknown as ExtensionAPI);
    const branch = Array.from({ length: 50 }, (_, index) => ({
      type: "message",
      id: `cap-${index}`,
      parentId: index === 0 ? null : `cap-${index - 1}`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Synthetic ${index} routine output. ${"noise line. ".repeat(300)}`,
        ...(index % 2 === 0 ? {} : { stopReason: "stop" }),
      },
    }));
    const hook = hooks.get("session_before_compact");
    assert.ok(hook);
    const result = await hook({
      branchEntries: branch,
      preparation: { firstKeptEntryId: "cap-25", tokensBefore: 50_000 },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    }, {
      hasUI: true,
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify() {} },
      modelRegistry: {},
    }) as { compaction?: { details?: { retainedTail?: { mode?: string; actualTokens?: number }; layers?: { combinedContextTokens?: number; hardCeilingTokens?: number } } } };
    assert.ok(result.compaction);
    assert.equal(result.compaction.details?.retainedTail?.mode, "dynamic");
    assert.ok((result.compaction.details?.retainedTail?.actualTokens ?? 0) >= 3_000);
    assert.ok((result.compaction.details?.retainedTail?.actualTokens ?? Infinity) <= 6_000);
    assert.equal(result.compaction.details?.layers?.hardCeilingTokens, HARD_COMBINED_CONTEXT_CAP_TOKENS);
    assert.ok((result.compaction.details?.layers?.combinedContextTokens ?? Infinity) <= HARD_COMBINED_CONTEXT_CAP_TOKENS);
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
