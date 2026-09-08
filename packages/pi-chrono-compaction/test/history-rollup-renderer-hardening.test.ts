import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderHistoryLossyCue, renderHistoryRollupPrototype } from "../src/history-rollup-renderer.js";
import { createHistoryRollupRuntime, updateHistoryRollupStore } from "../src/history-rollup-store.js";
import { validateHistoryRollupPlan, type HistoryRenderPlanLine } from "../src/history-rollup-validation.js";
import { createHistoryValueRecord } from "../src/history-value.js";
import type { HistoricalBlock, SessionEntryLike } from "../src/types.js";

function entry(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    message: { role, content: role === "assistant" ? [{ type: "text", text }] : text, stopReason: "stop" },
  };
}

async function fixture(t: test.TestContext, texts: { id: string; role: "user" | "assistant"; text: string }[], config = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chrono-render-hardening-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, "session.jsonl");
  let parent: string | null = null;
  const entries = texts.map(item => {
    const value = entry(item.id, parent, item.role, item.text);
    parent = item.id;
    return value;
  });
  await writeFile(sessionPath, [{ type: "session", version: 3, id: "renderer-hardening" }, ...entries]
    .map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const runtime = createHistoryRollupRuntime(sessionPath, { targetLeafEntries: 2, fanout: 4, ...config });
  await updateHistoryRollupStore(runtime, parent!);
  runtime.cache.clear();
  runtime.cacheBytes = 0;
  runtime.nodesLoaded = 0;
  runtime.nodeBytesRead = 0;
  return { runtime, ledger: runtime.ledger! };
}

test("recentSourceTokens controls leaf selection and numeric source order", async t => {
  const texts = Array.from({ length: 40 }, (_, index) => ({
    id: index === 0 ? "z-random" : index === 1 ? "a-random" : `id-${index}`,
    role: "assistant" as const,
    text: `routine recent event ${index} ${"token ".repeat(10)}`,
  }));
  const low = await fixture(t, texts);
  const lowResult = await renderHistoryRollupPrototype(low.runtime, low.ledger, { recentSourceTokens: 20, recentTokens: 5000 });
  const highResult = await renderHistoryRollupPrototype(low.runtime, low.ledger, { recentSourceTokens: 1000, recentTokens: 5000 });
  const lowRecent = lowResult.plan.filter(line => line.included && line.section === "recent").length;
  const highRecent = highResult.plan.filter(line => line.included && line.section === "recent").length;
  assert.ok(highRecent > lowRecent, JSON.stringify({ lowSections: lowResult.plan.filter(line => line.included).map(line => `${line.section}:${line.record?.category}:${line.record?.lifecycle}`), highSections: highResult.plan.filter(line => line.included).map(line => line.section), lowRecent, highRecent, lowCoverage: lowResult.quality.recentSourceTokenCoverage, highCoverage: highResult.quality.recentSourceTokenCoverage }));
  const highOrder = highResult.plan.filter(line => line.included && line.section === "recent").map(line => line.sourceOrder.start);
  assert.deepEqual(highOrder, [...highOrder].sort((a, b) => a - b));
});

test("dynamic traversal renders old evidence omitted from the root without loading every leaf", async t => {
  const texts = Array.from({ length: 200 }, (_, index) => ({
    id: `dynamic-${index}`,
    role: "assistant" as const,
    text: index === 0
      ? "old-critical-evidence tungsten marker"
      : `failure pressure-${index} failed and remains unresolved`,
  }));
  const f = await fixture(t, texts, { maximumStructuredRecords: 8 });
  const result = await renderHistoryRollupPrototype(f.runtime, f.ledger, {
    dynamicContext: { retentionHints: "old-critical-evidence tungsten" },
    recentSourceTokens: 20,
  });
  assert.match(result.text, /old-critical-evidence tungsten marker/);
  assert.ok(result.quality.queryNodesVisited <= f.runtime.config.maximumQueryNodes);
  assert.ok(result.quality.nodesReadDuringRender < f.runtime.branchManifest!.reachableNodeCount);
  assert.equal(result.quality.sourceOrderErrors, 0);
});

test("final restriction metrics and routes use final included lines under pressure", async t => {
  const texts: { id: string; role: "user" | "assistant"; text: string }[] = Array.from({ length: 100 }, (_, index) => ({
    id: `restriction-${index}`,
    role: "user" as const,
    text: `Never publish subject-${index} without explicit approval.`,
  }));
  texts.push({ id: "blocker", role: "assistant", text: "Blocked waiting for validation." });
  texts.push({ id: "failure", role: "assistant", text: "build Z99 failed and remains unresolved" });
  texts.push({ id: "resource", role: "assistant", text: "next action: preserve current resource state" });
  const f = await fixture(t, texts, { targetLeafEntries: 8 });
  const result = await renderHistoryRollupPrototype(f.runtime, f.ledger, {
    targetTokens: 5000,
    hardTokens: 5000,
    currentTokens: 2500,
  });
  const includedRestrictions = result.plan.filter(line => line.included && line.record?.category === "restriction");
  assert.equal(result.quality.currentRestrictionCount, 100);
  assert.equal(result.quality.exactCurrentRestrictions + result.quality.recoveryOnlyRestrictions, includedRestrictions.length);
  assert.equal(result.quality.omittedRestrictionsWithoutRoute, 0);
  assert.equal(result.quality.restrictionCueCoverage, 1);
  assert.equal(result.quality.blockerCoverage, 1);
  assert.equal(result.quality.unresolvedFailureCoverage, 1);
  assert.ok(includedRestrictions.every(line => line.recoveryRoute));
  assert.ok(result.text.split("\n").every(line => !line.endsWith("…")));
  assert.ok(result.quality.outputTokens <= 5000);
  assert.equal(result.validation.ok, true, result.validation.issues.join(","));
});

test("duplicate source claims render once", async t => {
  const f = await fixture(t, Array.from({ length: 12 }, (_, index) => ({
    id: `duplicate-${index}`,
    role: "assistant" as const,
    text: "identical routine observation",
  })));
  const result = await renderHistoryRollupPrototype(f.runtime, f.ledger, { recentSourceTokens: 1000 });
  const matching = result.plan.filter(line => line.included && line.record?.cue === "identical routine observation");
  assert.ok(matching.length <= 1, JSON.stringify(matching.map(line => ({ section: line.section, id: line.record?.id, group: line.record?.duplicateGroupIdentity }))));
  assert.equal(result.quality.duplicateRenderedRecords, 0);
});

test("failure cues cannot turn source success wording into a false completion", () => {
  const failure = createHistoryValueRecord({
    id: "failure-cue",
    entryId: "failure-entry",
    entryIndex: 1,
    kind: "tool_result",
    label: "tool",
    exactText: "Expected success, but validation failed.",
    rawTokens: 8,
    sourceRefs: [{ entryId: "failure-entry" }],
    protectedExact: false,
    reproducible: false,
    unresolved: true,
    exactIdentifiers: [],
    attributes: { isError: true },
  });
  const text = renderHistoryLossyCue(failure);
  assert.equal(/\b(passed|success)\b/i.test(text), false);
  assert.match(text, /failure/i);
});

test("typed validator rejects unsupported facts and final-plan defects", async t => {
  const f = await fixture(t, [{ id: "source", role: "assistant", text: "routine source statement" }]);
  const base: HistoricalBlock = {
    id: "source:assistant_text:0",
    entryId: "source",
    entryIndex: 0,
    blockIndex: 0,
    kind: "assistant_text",
    label: "assistant",
    exactText: "routine source statement",
    rawTokens: 4,
    sourceRefs: [{ entryId: "source", blockIndex: 0 }],
    protectedExact: false,
    reproducible: false,
    unresolved: false,
    exactIdentifiers: [],
    attributes: {},
  };
  const record = createHistoryValueRecord(base);
  const line = (id: string, text: string, patch: Partial<HistoryRenderPlanLine> = {}): HistoryRenderPlanLine => ({
    id,
    section: "older",
    record,
    sourceRange: record.sourceRange,
    sourceOrder: record.sourceOrder,
    lineType: "derived",
    lossy: true,
    recoveryRoute: `history_get("source")`,
    text,
    tokenEstimate: 10,
    priority: "C",
    included: true,
    ...patch,
  });
  const result = await validateHistoryRollupPlan(f.runtime, f.ledger, [
    line("identifier", "[derived omission] NEW_IDENTIFIER omitted detail — Exact recovery: history_get(\"source\")"),
    line("quotation", "[derived omission] 'invented quotation' omitted detail — Exact recovery: history_get(\"source\")"),
    line("number", "[derived omission] 987654 omitted detail — Exact recovery: history_get(\"source\")"),
    line("missing", "[derived omission] routine source statement", { recoveryRoute: undefined }),
    line("duplicate", "[derived omission] routine source statement — Exact recovery: history_get(\"source\")"),
    line("duplicate", "[derived omission] routine source statement — Exact recovery: history_get(\"source\")"),
    line("order", "[derived omission] routine source statement — Exact recovery: history_get(\"source\")", { sourceOrder: { start: 2, end: 1 } }),
  ], 30);
  for (const issue of [
    "unsupported-identifier",
    "unsupported-quotation",
    "unsupported-number",
    "loss-without-recovery",
    "duplicate-rendered-record",
    "source-order",
    "hard-token-limit",
  ]) assert.ok(result.issues.includes(issue as never), issue);
});
