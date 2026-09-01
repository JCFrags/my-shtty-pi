import assert from "node:assert/strict";
import test from "node:test";
import {
  projectRecentWork,
  projectRecentWorkWithChrono,
  reduceAssistantText,
  validateRecentWorkSnapshot,
} from "../../src/pi/recent-work.js";
import type { ChronoCompactApi } from "../../src/pi/chrono-compact-bridge.js";

const taskId = "tsk_01M1D000000000000000000010";
const runId = "run_01M1D000000000000000000010";
const assignmentId = "asg_01M1D000000000000000000010";

function entry(
  id: string,
  parentId: string | null,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    parentId,
    timestamp: `2026-08-31T00:00:0${id.slice(-1)}.000Z`,
    ...value,
  };
}

test("recent work is scoped to one assignment and omits reasoning, arguments, and tool output", () => {
  const entries = [
    entry("old", null, {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Prior task private material." }],
      },
    }),
    entry("assignment", "old", {
      type: "custom",
      customType: "pi-herdr-orchestrator-assignment",
      data: { taskId, runId, assignmentId },
    }),
    entry("assistant", "assignment", {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain of thought" },
          {
            type: "text",
            text: "Implemented the parser. Next I will test it.",
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "write",
            arguments: { content: "raw file secret", path: "/private/file" },
          },
        ],
        stopReason: "toolUse",
      },
    }),
    entry("result", "assistant", {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "write",
        content: [{ type: "text", text: "raw tool output secret" }],
        isError: false,
      },
    }),
  ];

  const snapshot = projectRecentWork({ entries, taskId, runId, assignmentId });
  assert.deepEqual(snapshot.items, [
    {
      kind: "assistant",
      timestamp: "2026-08-31T00:00:0t.000Z",
      text: "Implemented the parser. Next I will test it.",
    },
    {
      kind: "tool",
      timestamp: "2026-08-31T00:00:0t.000Z",
      toolName: "write",
      status: "succeeded",
    },
  ]);
  const encoded = JSON.stringify(snapshot);
  for (const forbidden of [
    "Prior task private material",
    "private chain of thought",
    "raw file secret",
    "/private/file",
    "raw tool output secret",
  ])
    assert.equal(encoded.includes(forbidden), false);
  assert.equal(validateRecentWorkSnapshot(snapshot, { taskId, runId }), true);
  assert.equal(
    validateRecentWorkSnapshot(
      { ...snapshot, runId: `${runId}-wrong` },
      {
        taskId,
        runId,
      },
    ),
    false,
  );
  assert.equal(
    validateRecentWorkSnapshot(
      { ...snapshot, unexpected: "raw" },
      {
        taskId,
        runId,
      },
    ),
    false,
  );
});

test("recent work follows only the active parent chain", () => {
  const entries = [
    entry("root", null, {
      type: "custom",
      customType: "pi-herdr-orchestrator-assignment",
      data: { taskId, runId, assignmentId },
    }),
    entry("abandoned", "root", {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Abandoned branch." }],
      },
    }),
    entry("active", "root", {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Active branch verified." }],
      },
    }),
  ];
  const snapshot = projectRecentWork({ entries, taskId, runId, assignmentId });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0]?.kind, "assistant");
  assert.equal(
    snapshot.items[0]?.kind === "assistant" ? snapshot.items[0].text : "",
    "Active branch verified.",
  );
});

test("recent work applies deterministic item and byte bounds with explicit omissions", () => {
  const entries: Record<string, unknown>[] = [
    entry("marker", null, {
      type: "custom",
      customType: "pi-herdr-orchestrator-assignment",
      data: { taskId, runId, assignmentId },
    }),
  ];
  let parent = "marker";
  for (let index = 0; index < 300; index++) {
    const id = `message-${index}`;
    entries.push(
      entry(id, parent, {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Verified bounded step ${index}. ${"detail ".repeat(100)}`,
            },
          ],
        },
      }),
    );
    parent = id;
  }
  const snapshot = projectRecentWork({
    entries,
    taskId,
    runId,
    assignmentId,
    maxItems: 4,
    maxBytes: 2_048,
  });
  assert.ok(snapshot.items.length > 0 && snapshot.items.length <= 4);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.sourceEntryCount, 300);
  assert.ok(snapshot.omittedEntryCount >= 296);
  assert.ok(snapshot.omittedItemCount > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 2_048);
});

test("optional ChronoCompact calls receive only safe sections and honor a larger bound", async () => {
  const entries: Record<string, unknown>[] = [
    entry("chrono-marker", null, {
      type: "custom",
      customType: "pi-herdr-orchestrator-assignment",
      data: { taskId, runId, assignmentId },
    }),
  ];
  let parent = "chrono-marker";
  for (let index = 0; index < 6; index++) {
    const assistantId = `chrono-assistant-${index}`;
    const callId = `chrono-call-${index}`;
    entries.push(
      entry(assistantId, parent, {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: `private reasoning ${index}` },
            { type: "text", text: `Verified public step ${index}.` },
            {
              type: "toolCall",
              id: callId,
              name: "bash",
              arguments: { command: `secret command ${index}` },
            },
          ],
        },
      }),
    );
    const resultId = `chrono-result-${index}`;
    entries.push(
      entry(resultId, assistantId, {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "bash",
          content: [{ type: "text", text: `raw secret result ${index}` }],
          isError: false,
        },
      }),
    );
    parent = resultId;
  }
  let reducerCalls = 0;
  let plannerCalls = 0;
  const chrono: ChronoCompactApi = {
    reduceBlock: ({ block }) => {
      reducerCalls++;
      const text = String(block.exactText);
      assert.equal(text.includes("private reasoning"), false);
      assert.equal(text.includes("secret command"), false);
      assert.equal(text.includes("raw secret result"), false);
      return {
        text,
        reducer: "assistant-extractive",
        lossy: false,
        omissions: [],
      };
    },
    compactEntries: async (safeEntries, options) => {
      plannerCalls++;
      const encoded = JSON.stringify(safeEntries);
      for (const forbidden of [
        "private reasoning",
        "secret command",
        "raw secret result",
      ])
        assert.equal(encoded.includes(forbidden), false);
      assert.equal(options.config.enableSemanticCompression, false);
      return {
        summary:
          'Chronological safe replay. token=hidden-value. Full source: history_get("recent-work-1").',
        rawTokens: 900,
        renderedTokens: 120,
        targetTokens: options.config.targetTokens,
        validation: { ok: true },
      };
    },
  };
  const snapshot = await projectRecentWorkWithChrono({
    entries,
    taskId,
    runId,
    assignmentId,
    maxItems: 64,
    maxBytes: 32_768,
    chrono,
  });
  assert.equal(snapshot.reducer, "chrono-compact");
  assert.ok(reducerCalls > 0);
  assert.equal(plannerCalls, 1);
  assert.ok(snapshot.replay);
  assert.equal(snapshot.replay?.text.includes("hidden-value"), false);
  assert.equal(snapshot.replay?.text.includes("history_get"), false);
  assert.match(snapshot.replay?.text ?? "", /larger maxBytes/u);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 32_768);
  assert.equal(validateRecentWorkSnapshot(snapshot, { taskId, runId }), true);
});

test("assistant reduction retains conclusions rather than a raw long body", () => {
  const reduced = reduceAssistantText(
    `I am looking now. ${"routine detail ".repeat(100)}. Tests failed because the parser rejected the marker. Fixed the parser and verified the focused tests.`,
    180,
  );
  assert.ok(Buffer.byteLength(reduced, "utf8") <= 180);
  assert.match(reduced, /Tests failed|Fixed the parser/u);
  assert.equal(reduced.includes("routine detail ".repeat(20)), false);

  const redacted = reduceAssistantText(
    "Verified request with token=super-sensitive-value, Bearer bearer-sensitive-value, and sk-1234567890abcdef.",
  );
  assert.equal(redacted.includes("super-sensitive-value"), false);
  assert.equal(redacted.includes("bearer-sensitive-value"), false);
  assert.equal(redacted.includes("sk-1234567890abcdef"), false);
  assert.match(redacted, /\[redacted\]/u);
});
