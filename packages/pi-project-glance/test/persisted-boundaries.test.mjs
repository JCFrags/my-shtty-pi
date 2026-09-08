import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import extension from "../dist/pi/extension.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("registered persisted boundaries recover updates delayed by another message_end handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glance-persisted-boundary-"));
  const oldRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const branch = [];
  const handlers = new Map();
  const statuses = [];
  let context = {
    sessionManager: { getSessionId: () => "synthetic-boundary", getLeafId: () => "synthetic-root", getBranch: () => branch },
    ui: { setStatus: (_key, value) => statuses.push(value), notify: () => {} },
  };
  let slot;
  try {
    await extension({
      registerCommand() {},
      appendEntry() { assert.fail("Passive boundary must not persist UI state"); },
      on(name, handler) { handlers.set(name, [handler]); },
    });
    slot = globalThis[Symbol.for("pi-project-glance.extension-runtime")];
    const runner = {
      createContext: () => context,
      extensions: [
        { path: "synthetic-glance", handlers },
        { path: "synthetic-later-hook", handlers: new Map([["message_end", [async () => { await pause(30); }]]]) },
      ],
      isSessionBeforeEvent: () => false,
      emitError() { assert.fail("Extension runner reported an error"); },
    };
    const emit = (event) => ExtensionRunner.prototype.emit.call(runner, event);
    await emit({ type: "session_start" });
    const commentary = (text) => ({ role: "assistant", stopReason: "stop", timestamp: Date.now(), content: [
      { type: "text", text, textSignature: JSON.stringify({ v: 1, id: "synthetic-signature", phase: "commentary" }) },
    ] });
    async function persistAfterHandlers(id, message) {
      // AgentSession also persists only after this awaited runner method.
      await ExtensionRunner.prototype.emitMessageEnd.call(runner, { type: "message_end", message });
      branch.push({ type: "message", id, parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message });
      await pause(40);
    }
    await persistAfterHandlers("preamble", { ...commentary("Synthetic preamble"), stopReason: "toolUse" });
    assert.equal(slot.runtime.feed.length, 0, "The early timer ran before persistence");
    await emit({ type: "tool_execution_start", toolCallId: "synthetic-call", toolName: "read", args: {} });
    assert.equal(slot.runtime.feed.length, 1);
    assert.equal(statuses.at(-1), "● Glance 1", "Passive publication leaves the update unread");

    await persistAfterHandlers("checkpoint-entry", { role: "toolResult", toolName: "workplan", content: [], details: { activity: {
      version: 1, id: "checkpoint", type: "checkpoint_recorded", planId: "WP1", summary: "Synthetic checkpoint", at: new Date().toISOString(),
    } } });
    await emit({ type: "turn_end", turnIndex: 0, message: commentary("Synthetic turn"), toolResults: [] });
    assert.deepEqual(slot.runtime.feed.map((item) => item.id), ["preamble", "checkpoint"]);
    await persistAfterHandlers("final-commentary", commentary("Synthetic final commentary"));
    await emit({ type: "agent_end", messages: [] });
    assert.equal(slot.runtime.feed.length, 3);
    assert.equal(statuses.at(-1), "● Glance 3");

    context = { ...context, sessionManager: { ...context.sessionManager, getLeafId: () => "destination", getBranch: () => [] } };
    await emit({ type: "session_tree" });
    await emit({ type: "turn_end", turnIndex: 1, message: commentary("Synthetic destination"), toolResults: [] });
    assert.equal(slot.runtime.feed.length, 0);
    await emit({ type: "session_shutdown" });
    await emit({ type: "agent_end", messages: [] });
    assert.equal(slot.runtime.started, false);
    assert.equal(statuses.at(-1), undefined);
  } finally {
    await slot?.dispose();
    if (oldRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldRuntimeDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
