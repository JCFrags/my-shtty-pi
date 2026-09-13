import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerContextProvider, requestChannel, responseChannel, jsonBytes,
  type ContextCard, type ContextRequest, type ProviderId, type ProviderPage,
} from "@context-kit/protocol";
import { createRecallTool, type RecallInput, type RecallResult } from "../src/index.ts";

function card(providerId: ProviderId, index = 1, text = "Source-known current fact"): ContextCard {
  const id = `${providerId}-${index}`;
  return {
    id, revision: "1", status: providerId === "todo" ? "pending" : "active",
    category: providerId === "todo" ? "task" : providerId === "notes" ? "note" : "plan",
    title: `Record ${index}`, text, omittedFields: [],
    recovery: providerId === "todo" ? { tool: "todo", args: { action: "list" } }
      : providerId === "notes" ? { tool: "notes", args: { action: "read", id } }
      : { tool: "workplan", args: { action: "recover", planId: id } },
  };
}
function page(cards: ContextCard[]): ProviderPage {
  return { readiness: "ready", coverage: { scanned: cards.length, matched: cards.length, excluded: 0, scanComplete: true }, cards };
}
function harness() {
  const events = createEventBus();
  let active = ["todo", "notes", "workplan"];
  let leafId = "leaf-a";
  const ctx = { sessionManager: { getSessionId: () => "session-a", getLeafId: () => leafId } } as ExtensionContext;
  const tool = createRecallTool({ events, getActiveTools: () => active });
  const run = (input: RecallInput = {}) => tool.execute("test-call", input, undefined, undefined, ctx);
  return { events, run, setActive: (tools: string[]) => { active = tools; }, moveLeaf: () => { leafId = "leaf-b"; } };
}
const decoded = (result: Awaited<ReturnType<ReturnType<typeof harness>["run"]>>): RecallResult => JSON.parse(result.content[0]!.text);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("real Recall factory preserves a healthy peer across malformed, missing, late, and failed replies without enabling tools", async () => {
  const h = harness();
  const stopTodo = registerContextProvider(h.events, "todo", () => page([card("todo")]));
  let getterCalls = 0;
  let notesCalls = 0;
  const stopNotes = h.events.on(requestChannel("notes"), (value) => {
    notesCalls++;
    const request = value as ContextRequest;
    h.events.emit(responseChannel("notes"), {
      version: 1, requestId: request.requestId, providerId: "notes", scope: request.scope,
      readiness: "ready", coverage: { scanned: 1, matched: 1, excluded: 0, scanComplete: true },
      get cards() { getterCalls++; throw new Error("must not invoke provider getters"); },
    });
  });
  const first = decoded(await h.run({ waitMs: 20 }));
  assert.deepEqual(first.providers.map((item) => item.status), ["ok", "malformed", "missing_or_timeout"]);
  assert.equal(first.providers[0]!.page!.cards[0]!.status, "pending");
  assert.equal(first.providers[0]!.page!.cards[0]!.text, "Source-known current fact");
  assert.equal(first.complete, false);
  assert.equal(getterCalls, 0);

  h.setActive(["todo", "workplan"]);
  const inactive = decoded(await h.run({ providers: ["notes"], waitMs: 10 }));
  assert.equal(inactive.providers[0]!.status, "tool_inactive");
  assert.equal(notesCalls, 1, "an inactive native tool must not be queried");
  stopNotes();
  const stopLate = registerContextProvider(h.events, "workplan", async () => { await sleep(50); return page([card("workplan")]); });
  const late = decoded(await h.run({ providers: ["todo", "workplan"], waitMs: 10 }));
  assert.deepEqual(late.providers.map((item) => item.status), ["ok", "missing_or_timeout"]);
  const snapshot = JSON.stringify(late);
  await sleep(60);
  assert.equal(JSON.stringify(late), snapshot);
  stopLate();
  const stopFailure = registerContextProvider(h.events, "workplan", () => { throw new Error("private provider error"); });
  const failed = await h.run({ providers: ["todo", "workplan"] });
  assert.deepEqual(decoded(failed).providers.map((item) => item.status), ["ok", "provider_error"]);
  assert.equal(JSON.stringify(failed).includes("private provider error"), false);
  stopFailure(); stopTodo(); h.events.clear();
});

test("real Recall factory charges complete metadata and escaping, preserves whole recovery cards, and refuses a changed view", async () => {
  const h = harness();
  const body = 'Exact "quoted" evidence\n'.repeat(40);
  const stops = (["todo", "notes", "workplan"] as const).map((providerId) => registerContextProvider(
    h.events, providerId, () => page(Array.from({ length: 16 }, (_, index) => card(providerId, index, body))),
  ));
  const bounded = await h.run({ records: 16, scan: 32, providerBytes: 16384, maxBytes: 4096 });
  assert.ok(jsonBytes(bounded) <= 4096, "budget includes content, escaping, details, and all provider metadata");
  const result = decoded(bounded);
  assert.equal(result.complete, false);
  assert.equal(result.providers.length, 3);
  assert.ok(result.providers.every((provider) => provider.status === "ok" && provider.page!.coverage.excluded > 0));
  assert.ok(result.providers.some((provider) => provider.page!.cards.length > 0));
  for (const provider of result.providers) {
    const p = provider.page!;
    assert.equal(p.coverage.matched, p.cards.length + p.coverage.excluded);
    for (const item of p.cards) {
      assert.equal(item.text, body, "consumer must remove whole cards, not truncate recovery data");
      assert.equal(item.recovery.tool, provider.providerId);
      assert.equal(item.revision, "1");
    }
  }
  await assert.rejects(h.run({ maxBytes: 32769 }), /limit/);
  stops.forEach((stop) => stop());
  const stopChanged = registerContextProvider(h.events, "todo", () => { h.moveLeaf(); return page([card("todo")]); });
  const changed = decoded(await h.run({ providers: ["todo"] }));
  assert.equal(changed.providers[0]!.status, "scope_changed");
  assert.equal(changed.providers[0]!.page, undefined);
  stopChanged(); h.events.clear();
});
