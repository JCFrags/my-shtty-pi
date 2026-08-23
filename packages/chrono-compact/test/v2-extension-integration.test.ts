import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/pi-extension.js";
import { appendMemoryEvent, memorySidecarPath, readMemoryEvents } from "../src/memory-store.js";
import type { SessionEntryLike } from "../src/types.js";
import { estimateTokensFromText } from "../src/utils.js";

type Hook = (event: any, context: any) => Promise<any> | any;

test("extension search feedback, recall promotion, and replay-only summary fallback are product-connected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-extension-connected-"));
  const sessionPath = join(directory, "session.jsonl");
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    PI_CHRONO_CONFIG_PATH: join(directory, "config.json"),
    PI_CHRONO_CACHE: "false",
    PI_CHRONO_PI_SUMMARY: "true",
    PI_CHRONO_RAW_TAIL: "pi",
    PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false",
    PI_CHRONO_TOOL_RESULT_PROJECTION: "off",
  })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    const entries: SessionEntryLike[] = [{
      type: "message",
      id: "connected-user",
      parentId: null,
      timestamp: "2026-08-02T00:00:00.000Z",
      message: { role: "user", content: "Keep exact recovery and continue the parser task." },
    }];
    let parent = "connected-user";
    for (let index = 0; index < 30; index += 1) {
      const id = `connected-assistant-${index}`;
      entries.push({
        type: "message",
        id,
        parentId: parent,
        timestamp: `2026-08-02T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
        message: {
          role: "assistant",
          content: [{
            type: "thinking",
            thinking: `${index === 0 ? "rare-connected-feedback parser memory " : ""}${`Routine parser analysis ${index} with immutable recovery. `.repeat(90)}`,
          }],
          stopReason: "stop",
        },
      });
      parent = id;
    }
    for (let index = 1; index <= 8; index += 1) {
      const id = `connected-compaction-${index}`;
      entries.push({
        type: "compaction",
        id,
        parentId: parent,
        summary: "previous regular summary carried forward",
        firstKeptEntryId: parent,
      });
      parent = id;
    }
    const tailId = "connected-tail";
    entries.push({
      type: "message",
      id: tailId,
      parentId: parent,
      timestamp: "2026-08-02T02:00:00.000Z",
      message: { role: "user", content: "Continue after compaction." },
    });

    const records = [
      JSON.stringify({ type: "session", version: 3, id: "connected-session", timestamp: "2026-08-02T00:00:00.000Z", cwd: directory }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ];
    await writeFile(sessionPath, `${records.join("\n")}\n`, { mode: 0o600 });

    const hooks = new Map<string, Hook>();
    const tools = new Map<string, (...args: any[]) => Promise<any>>();
    const appended: unknown[] = [];
    const pi = {
      registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool.execute); },
      registerCommand() {},
      on(name: string, handler: Hook) { hooks.set(name, handler); },
      appendEntry(_type: string, data: unknown) { appended.push(data); },
      sendMessage() {},
    };
    extension(pi as unknown as ExtensionAPI);

    const context = {
      hasUI: true,
      model: undefined,
      thinkingLevel: "medium",
      sessionManager: {
        getSessionFile: () => sessionPath,
        getEntries: () => entries,
        getBranch: () => entries,
      },
      getContextUsage: () => ({ tokens: 20_000, contextWindow: 272_000, percent: 7.4 }),
      isIdle: () => true,
      abort() {},
      compact() {},
      ui: { notify() {} },
      modelRegistry: {
        getApiKeyAndHeaders() { throw new Error("deterministic rebase must not call a provider"); },
      },
    };

    const remembered = await appendMemoryEvent(memorySidecarPath(sessionPath), {
      action: "remember",
      timestamp: "2026-08-02T03:00:00.000Z",
      turn: 1,
      sourceRef: "memory-tool:connected",
      text: "Parser memory should stay active when recalled.",
    });
    await appendMemoryEvent(memorySidecarPath(sessionPath), {
      action: "forget",
      memoryId: remembered.memories[0]!.memoryId,
      timestamp: "2026-08-02T03:01:00.000Z",
      turn: 2,
      sourceRef: "memory-tool:connected-forget",
    });

    const recall = tools.get("history_recall");
    const search = tools.get("history_search");
    assert.ok(recall && search);
    const recallResult = await recall("recall-tool-1", { query: "parser memory", level: "cue", tokenBudget: 500 }, undefined, undefined, context);
    assert.equal(recallResult.details.promotedMemories, 1);
    const promoted = await readMemoryEvents(memorySidecarPath(sessionPath));
    assert.equal(promoted.status, "ready");
    assert.equal(promoted.memories[0]?.state, "current");
    assert.equal(promoted.events.at(-1)?.action, "promote");
    assert.ok(appended.length > 0);

    await search("search-tool-1", { query: "rare-connected-feedback", mode: "ranked", tokenBudget: 300 }, undefined, undefined, context);
    await search("search-tool-2", { query: "rare-connected-feedback", mode: "ranked", tokenBudget: 300 }, undefined, undefined, context);
    const boundedSearch = await search("search-tool-budget", { query: "rare-connected-feedback", mode: "ranked", tokenBudget: 120, includeNeighbors: true }, undefined, undefined, context);
    const boundedSearchText = boundedSearch.content[0]?.text ?? "";
    assert.ok(estimateTokensFromText(boundedSearchText) <= 120);
    assert.equal(boundedSearch.details.tokenBudget, 120);
    assert.equal(boundedSearch.details.returnedTokens, estimateTokensFromText(boundedSearchText));
    for (const level of ["cue", "episode", "resource", "block"] as const) {
      const boundedRecall = await recall(`recall-tool-budget-${level}`, { query: "rare-connected-feedback", level, tokenBudget: 120 }, undefined, undefined, context);
      const boundedRecallText = boundedRecall.content[0]?.text ?? "";
      assert.ok(estimateTokensFromText(boundedRecallText) <= 120, `${level} tool response exceeded its requested budget`);
      assert.equal(boundedRecall.details.tokenBudget, 120);
      assert.equal(boundedRecall.details.renderedTokens, estimateTokensFromText(boundedRecallText));
    }

    const compact = hooks.get("session_before_compact");
    assert.ok(compact);
    const result = await compact({
      branchEntries: entries,
      preparation: {
        firstKeptEntryId: tailId,
        tokensBefore: 40_000,
        previousSummary: "previous regular summary carried forward",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "Preserve exact recovery.",
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    }, context);
    assert.ok(result?.compaction);
    assert.doesNotMatch(result.compaction.summary, /# REGULAR MEMORY REBASE/);
    assert.match(result.compaction.summary, /# CHRONOCOMPACT MEMORY REPLAY/);
    assert.equal(result.compaction.details.hybrid.enabled, false);
    assert.ok(result.compaction.details.compaction.plan.some((item: { importanceReasons: string[] }) =>
      item.importanceReasons.some((reason) => /reused [2-9]\d* time/.test(reason))));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
