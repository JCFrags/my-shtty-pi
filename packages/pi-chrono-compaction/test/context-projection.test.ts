import assert from "node:assert/strict";
import test from "node:test";
import {
  projectToolResultContext,
  projectionSourcesFromBranch,
  validateProjectedToolPairs,
  type ContextMessageLike,
  type ProjectionSourceBinding,
} from "../src/context-projection.js";
import { stableStringify } from "../src/utils.js";

function longSearch(tag: string): string {
  return Array.from({ length: 180 }, (_, index) => `src/${tag}-${index}.ts:${index + 1}: deterministic match ${tag}`).join("\n");
}

function sequence(outputs: Array<{ text: string; tool?: string; isError?: boolean; details?: unknown }>): {
  messages: ContextMessageLike[];
  entryIds: Map<string, string>;
  callIds: Set<string>;
  sources: ReadonlyMap<string, ProjectionSourceBinding>;
} {
  const messages: ContextMessageLike[] = [{ role: "user", content: [{ type: "text", text: "Inspect deterministic state." }] }];
  const entryIds = new Map<string, string>();
  const callIds = new Set<string>();
  outputs.forEach((output, index) => {
    const id = `call-${index}`;
    const tool = output.tool ?? "grep";
    callIds.add(id);
    entryIds.set(id, `result-entry-${index}`);
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id, name: tool, arguments: { pattern: `state-${index}`, path: "src" } }],
    });
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: tool,
      isError: output.isError ?? false,
      details: output.details ?? { matchCount: 180 },
      content: [{ type: "text", text: output.text }],
    });
  });
  const branchEntries = messages.map((message, index) => ({
    type: "message",
    id: message.toolCallId ? entryIds.get(message.toolCallId) ?? `entry-${index}` : `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    message,
  }));
  return { messages, entryIds, callIds, sources: projectionSourcesFromBranch(branchEntries) };
}

function projectedText(message: ContextMessageLike): string {
  const content = message.content as Array<{ type: string; text?: string }>;
  return content.find((item) => item.type === "text")?.text ?? "";
}

function sourceBindingsForMessages(messages: readonly ContextMessageLike[]): ReadonlyMap<string, ProjectionSourceBinding> {
  return projectionSourcesFromBranch(messages.map((message, index) => ({
    type: "message",
    id: message.toolCallId ? `result-${message.toolCallId}` : `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    message,
  })));
}

async function assertBindingRefusal(
  fixture: ReturnType<typeof sequence>,
  targetCallId: string,
  kind: "missing" | "mismatched",
  label: string,
  seenToolCallIds: ReadonlySet<string> = fixture.callIds,
): Promise<void> {
  const sources = new Map(fixture.sources);
  if (kind === "missing") sources.delete(targetCallId);
  else {
    const source = sources.get(targetCallId);
    assert.ok(source, `${label}: source exists before mismatch`);
    sources.set(targetCallId, { ...source, sourceFingerprint: `${source.sourceFingerprint}-tampered` });
  }
  const result = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds,
    sourceByToolCallId: sources,
  });
  assert.equal(result.messages, fixture.messages, `${label}: original message array reference`);
  assert.equal(result.metrics.projectedToolResults, 0, `${label}: projected results`);
  assert.equal(result.metrics.removedTokens, 0, `${label}: removed tokens`);
  assert.equal(result.metrics.refusedResults, fixture.callIds.size, `${label}: refused results`);
  assert.equal(
    result.metrics.refusalReason,
    kind === "missing"
      ? `missing authoritative source binding for call ID ${targetCallId}`
      : `authoritative source fingerprint mismatch for call ID ${targetCallId}`,
    `${label}: refusal reason`,
  );
}

test("off mode returns the exact input reference without projection", async () => {
  const fixture = sequence([{ text: longSearch("off") }]);
  const result = await projectToolResultContext(fixture.messages, {
    mode: "off",
    seenToolCallIds: fixture.callIds,
    sourceByToolCallId: fixture.sources,
  });
  assert.equal(result.messages, fixture.messages);
  assert.equal(result.metrics.mode, "off");
  assert.equal(result.metrics.projectedToolResults, 0);
});

test("safe projection is request-local, deterministic, pair-safe, and exactly recoverable", async () => {
  const fixture = sequence([
    { text: longSearch("alpha") },
    { text: longSearch("beta") },
    { text: longSearch("gamma") },
    { text: longSearch("newest") },
  ]);
  const before = stableStringify(fixture.messages);
  const runs = await Promise.all(Array.from({ length: 5 }, () => projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: fixture.callIds,
    sourceByToolCallId: fixture.sources,
  })));
  assert.equal(stableStringify(fixture.messages), before);
  assert.ok(runs[0]);
  for (const run of runs.slice(1)) assert.deepEqual(run, runs[0]);
  const result = runs[0];
  assert.equal(result.metrics.projectedToolResults, 3);
  assert.ok(result.metrics.removedTokens > 1_000);
  assert.equal(result.metrics.exactRecoveryCovered, result.metrics.projectedToolResults);
  assert.equal(validateProjectedToolPairs(result.messages).ok, true);
  result.messages.forEach((message) => {
    if (message.role !== "toolResult" || !projectedText(message).startsWith("[ChronoCompact")) return;
    const entryId = fixture.entryIds.get(message.toolCallId ?? "");
    assert.ok(entryId);
    assert.match(projectedText(message), new RegExp(`history_get\\(\\{\\"entryId\\":\\"${entryId}\\"\\}\\)`));
    assert.equal(stableStringify(message.details).includes(longSearch("alpha")), false);
  });
  assert.equal(projectedText(result.messages.at(-1)!), longSearch("newest"));
});

test("first model consumption remains full and becomes eligible only on a later request", async () => {
  const fixture = sequence([
    { text: longSearch("first") },
    { text: longSearch("second") },
    { text: longSearch("third") },
  ]);
  const first = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: new Set(),
    sourceByToolCallId: fixture.sources,
  });
  assert.equal(first.metrics.projectedToolResults, 0);
  assert.equal(first.metrics.keptFirstConsumption, 2);
  assert.deepEqual(first.newlySeenToolCallIds, fixture.callIds);

  const later = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: first.newlySeenToolCallIds,
    sourceByToolCallId: fixture.sources,
  });
  assert.equal(later.metrics.projectedToolResults, 2);
});

test("errors, warnings, cancellation, unknown terminal outcomes, citations, pins, and images remain full", async () => {
  const citedLine = "src/cited.ts:44: exact user-cited numeric value 9173";
  const fixture = sequence([
    { text: `Error: permission denied\n${longSearch("error")}`, isError: true },
    { text: `Warning: stale result\n${longSearch("warning")}` },
    { text: longSearch("cancelled"), tool: "bash", details: { cancelled: true, exitCode: 0 } },
    { text: longSearch("unknown-terminal"), tool: "bash", details: {} },
    { text: `${citedLine}\n${longSearch("cited")}` },
    { text: longSearch("pinned") },
    { text: longSearch("success"), tool: "bash", details: { exitCode: 0, cwd: "/workspace" } },
    { text: longSearch("newest") },
  ]);
  fixture.messages.push({ role: "user", content: [{ type: "text", text: `Keep this exact line: ${citedLine}` }] });
  const imageIndex = fixture.messages.findIndex((message) => message.toolCallId === "call-5");
  assert.notEqual(imageIndex, -1);
  fixture.messages[imageIndex] = {
    ...fixture.messages[imageIndex]!,
    content: [{ type: "text", text: longSearch("pinned") }, { type: "image", data: "AA==", mimeType: "image/png" }],
  };

  const result = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: fixture.callIds,
    pinnedToolCallIds: new Set(["call-5"]),
    sourceByToolCallId: sourceBindingsForMessages(fixture.messages),
  });
  assert.equal(result.metrics.projectedToolResults, 1);
  assert.equal(result.metrics.protectedResults, 6);
  for (let index = 0; index <= 5; index += 1) {
    const message = result.messages.find((item) => item.toolCallId === `call-${index}`);
    assert.ok(message);
    assert.equal(projectedText(message).startsWith("[ChronoCompact"), false);
  }
  const successful = result.messages.find((message) => message.toolCallId === "call-6");
  assert.ok(successful);
  assert.match(projectedText(successful), /Outcome: successful/);
  assert.match(projectedText(successful), /history_get/);
});

test("serious negative language remains full even when structured status says success", async () => {
  const terms = ["fatal", "panic", "traceback", "segfault", "segmentation fault", "unhealthy", "refused", "corrupt", "mismatch"];
  const fixture = sequence([
    ...terms.map((term) => ({ text: `${term}: decisive negative evidence\n${longSearch(term.replaceAll(" ", "-"))}` })),
    { text: longSearch("ordinary-success") },
    { text: longSearch("newest") },
  ]);
  const result = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: fixture.callIds,
    sourceByToolCallId: fixture.sources,
  });
  assert.equal(result.metrics.protectedResults, terms.length);
  assert.equal(result.metrics.projectedToolResults, 1);
  for (let index = 0; index < terms.length; index += 1) {
    const message = result.messages.find((item) => item.toolCallId === `call-${index}`);
    assert.ok(message);
    assert.equal(projectedText(message).startsWith("[ChronoCompact"), false);
  }
});

test("restriction and unresolved language in old successful results remains full", async () => {
  const fixture = sequence([
    { text: `Do not remove this exact operational restriction.\n${longSearch("restriction")}` },
    { text: `Remaining work needs investigation before completion.\n${longSearch("unresolved")}` },
    { text: longSearch("ordinary-success") },
    { text: longSearch("newest") },
  ]);
  const result = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: fixture.callIds,
    sourceByToolCallId: fixture.sources,
  });
  assert.equal(result.metrics.protectedResults, 2);
  assert.equal(result.metrics.projectedToolResults, 1);
  for (const id of ["call-0", "call-1"]) {
    const message = result.messages.find((item) => item.toolCallId === id);
    assert.ok(message);
    assert.equal(projectedText(message).startsWith("[ChronoCompact"), false);
  }
});

test("authoritative source binding refuses transformed content and key fields", async () => {
  const mutations: Array<(message: ContextMessageLike) => ContextMessageLike> = [
    (message) => ({ ...message, content: [{ type: "text", text: longSearch("transformed-request") }] }),
    (message) => ({ ...message, details: { matchCount: 0 } }),
    (message) => ({ ...message, toolName: "find" }),
  ];
  for (const mutate of mutations) {
    const fixture = sequence([
      { text: longSearch("authoritative-source") },
      { text: longSearch("second") },
      { text: longSearch("newest") },
    ]);
    const sourceIndex = fixture.messages.findIndex((message) => message.toolCallId === "call-0");
    assert.notEqual(sourceIndex, -1);
    fixture.messages[sourceIndex] = mutate(fixture.messages[sourceIndex]!);
    const result = await projectToolResultContext(fixture.messages, {
      mode: "safe",
      keepRecentResults: 1,
      seenToolCallIds: fixture.callIds,
      sourceByToolCallId: fixture.sources,
    });
    assert.equal(result.messages, fixture.messages);
    assert.equal(result.metrics.projectedToolResults, 0);
    assert.equal(result.metrics.removedTokens, 0);
    assert.equal(result.metrics.refusalReason, "authoritative source fingerprint mismatch for call ID call-0");
  }
});

test("one missing authoritative binding fails closed for the complete request", async () => {
  const fixture = sequence([
    { text: longSearch("missing-binding") },
    { text: longSearch("bound-one") },
    { text: longSearch("bound-two") },
    { text: longSearch("bound-three") },
    { text: longSearch("newest") },
  ]);
  const incompleteSources = new Map(fixture.sources);
  incompleteSources.delete("call-0");
  const result = await projectToolResultContext(fixture.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: fixture.callIds,
    sourceByToolCallId: incompleteSources,
  });
  assert.equal(result.messages, fixture.messages);
  assert.equal(result.metrics.projectedToolResults, 0);
  assert.equal(result.metrics.removedTokens, 0);
  assert.match(result.metrics.refusalReason ?? "", /missing authoritative source binding for call ID call-0/);
});

test("binding validation runs before every projection-policy skip", async (t) => {
  const protectedFailure = sequence([
    { text: `Error: permission denied\n${longSearch("protected-binding")}`, isError: true },
    { text: longSearch("protected-eligible-one") },
    { text: longSearch("protected-eligible-two") },
    { text: longSearch("protected-eligible-three") },
    { text: longSearch("protected-newest") },
  ]);
  const recent = sequence([
    { text: longSearch("recent-eligible-one") },
    { text: longSearch("recent-eligible-two") },
    { text: longSearch("recent-eligible-three") },
    { text: longSearch("recent-eligible-four") },
    { text: longSearch("recent-target") },
  ]);
  const firstConsumption = sequence([
    { text: longSearch("first-consumption-target") },
    { text: longSearch("first-consumption-eligible-one") },
    { text: longSearch("first-consumption-eligible-two") },
    { text: longSearch("first-consumption-eligible-three") },
    { text: longSearch("first-consumption-newest") },
  ]);
  const firstConsumptionSeen = new Set(firstConsumption.callIds);
  firstConsumptionSeen.delete("call-0");
  const repeated = longSearch("canonical-binding-target");
  const canonical = sequence([
    { text: repeated },
    { text: repeated },
    { text: longSearch("canonical-eligible-one") },
    { text: longSearch("canonical-eligible-two") },
    { text: longSearch("canonical-newest") },
  ]);
  const small = sequence([
    { text: "small successful result" },
    { text: longSearch("small-eligible-one") },
    { text: longSearch("small-eligible-two") },
    { text: longSearch("small-eligible-three") },
    { text: longSearch("small-newest") },
  ]);
  const cases = [
    { label: "protected failure", fixture: protectedFailure, target: "call-0", seen: protectedFailure.callIds },
    { label: "recent result", fixture: recent, target: "call-4", seen: recent.callIds },
    { label: "first-consumption result", fixture: firstConsumption, target: "call-0", seen: firstConsumptionSeen },
    { label: "canonical repeated result", fixture: canonical, target: "call-0", seen: canonical.callIds },
    { label: "below-threshold result", fixture: small, target: "call-0", seen: small.callIds },
  ];
  for (const item of cases) {
    await t.test(`${item.label}: missing binding`, async () => {
      await assertBindingRefusal(item.fixture, item.target, "missing", `${item.label} missing`, item.seen);
    });
    await t.test(`${item.label}: mismatched binding`, async () => {
      await assertBindingRefusal(item.fixture, item.target, "mismatched", `${item.label} mismatched`, item.seen);
    });
  }
});

test("authoritative source binding validates entry and call identities", async () => {
  for (const invalid of [
    {
      update: (source: ProjectionSourceBinding): ProjectionSourceBinding => ({ ...source, entryId: "" }),
      reason: "invalid authoritative source entry identity for call ID call-0",
    },
    {
      update: (source: ProjectionSourceBinding): ProjectionSourceBinding => ({ ...source, toolCallId: "different-call" }),
      reason: "authoritative source call ID mismatch for call ID call-0",
    },
  ]) {
    const fixture = sequence([
      { text: longSearch("identity-target") },
      { text: longSearch("identity-eligible") },
      { text: longSearch("identity-newest") },
    ]);
    const sources = new Map(fixture.sources);
    const source = sources.get("call-0");
    assert.ok(source);
    sources.set("call-0", invalid.update(source));
    const result = await projectToolResultContext(fixture.messages, {
      mode: "safe",
      keepRecentResults: 1,
      seenToolCallIds: fixture.callIds,
      sourceByToolCallId: sources,
    });
    assert.equal(result.messages, fixture.messages);
    assert.equal(result.metrics.projectedToolResults, 0);
    assert.equal(result.metrics.removedTokens, 0);
    assert.equal(result.metrics.refusalReason, invalid.reason);
  }

  const duplicateEntry = sequence([
    { text: longSearch("entry-owner-one") },
    { text: longSearch("entry-owner-two") },
    { text: longSearch("entry-owner-newest") },
  ]);
  const sources = new Map(duplicateEntry.sources);
  const first = sources.get("call-0");
  const second = sources.get("call-1");
  assert.ok(first);
  assert.ok(second);
  sources.set("call-1", { ...second, entryId: first.entryId });
  const result = await projectToolResultContext(duplicateEntry.messages, {
    mode: "safe",
    keepRecentResults: 1,
    seenToolCallIds: duplicateEntry.callIds,
    sourceByToolCallId: sources,
  });
  assert.equal(result.messages, duplicateEntry.messages);
  assert.equal(result.metrics.projectedToolResults, 0);
  assert.equal(result.metrics.removedTokens, 0);
  assert.equal(
    result.metrics.refusalReason,
    `authoritative source entry identity ${first.entryId} is shared by call IDs call-0 and call-1`,
  );
});

test("orphan and duplicate tool structures refuse the entire projection", async () => {
  const orphan: ContextMessageLike[] = [{
    role: "toolResult",
    toolCallId: "missing",
    toolName: "grep",
    isError: false,
    content: [{ type: "text", text: longSearch("orphan") }],
  }];
  const orphanResult = await projectToolResultContext(orphan, { mode: "safe", seenToolCallIds: new Set(["missing"]) });
  assert.equal(orphanResult.messages, orphan);
  assert.match(orphanResult.metrics.refusalReason ?? "", /orphan/);
  assert.equal(validateProjectedToolPairs(orphan).ok, false);

  const duplicate = sequence([{ text: longSearch("one") }]);
  duplicate.messages.push(duplicate.messages[2]!);
  const duplicateResult = await projectToolResultContext(duplicate.messages, {
    mode: "safe",
    seenToolCallIds: duplicate.callIds,
    sourceByToolCallId: duplicate.sources,
  });
  assert.equal(duplicateResult.messages, duplicate.messages);
  assert.match(duplicateResult.metrics.refusalReason ?? "", /duplicate tool result/);

  const duplicateCall = sequence([{ text: longSearch("duplicate-call") }]);
  duplicateCall.messages.splice(1, 0, duplicateCall.messages[1]!);
  const duplicateCallResult = await projectToolResultContext(duplicateCall.messages, {
    mode: "safe",
    seenToolCallIds: duplicateCall.callIds,
    sourceByToolCallId: duplicateCall.sources,
  });
  assert.equal(duplicateCallResult.messages, duplicateCall.messages);
  assert.match(duplicateCallResult.metrics.refusalReason ?? "", /duplicate tool call/);
});

test("unsupported tool-result content fails the complete request closed", async (t) => {
  const fixture = sequence([
    { text: longSearch("opaque") },
    { text: longSearch("opaque-eligible-one") },
    { text: longSearch("opaque-eligible-two") },
    { text: longSearch("opaque-eligible-three") },
    { text: longSearch("opaque-newest") },
  ]);
  const index = fixture.messages.findIndex((message) => message.toolCallId === "call-0");
  assert.notEqual(index, -1);
  fixture.messages[index] = {
    ...fixture.messages[index]!,
    content: [
      { type: "text", text: longSearch("opaque") },
      { type: "document", data: "opaque-provider-content" },
    ],
  };
  const boundFixture = { ...fixture, sources: sourceBindingsForMessages(fixture.messages) };

  await t.test("missing binding takes request-wide precedence", async () => {
    await assertBindingRefusal(boundFixture, "call-0", "missing", "unsupported missing binding");
  });
  await t.test("mismatched binding takes request-wide precedence", async () => {
    await assertBindingRefusal(boundFixture, "call-0", "mismatched", "unsupported mismatched binding");
  });
  await t.test("valid binding still refuses unsupported request content", async () => {
    const result = await projectToolResultContext(fixture.messages, {
      mode: "safe",
      keepRecentResults: 1,
      seenToolCallIds: fixture.callIds,
      sourceByToolCallId: boundFixture.sources,
    });
    assert.equal(result.messages, fixture.messages);
    assert.equal(result.metrics.projectedToolResults, 0);
    assert.equal(result.metrics.removedTokens, 0);
    assert.equal(result.metrics.refusedResults, fixture.callIds.size);
    assert.equal(result.metrics.refusalReason, "unsupported tool result content for call ID call-0");
  });
});

test("aggressive mode masks later exact duplicates but keeps one canonical copy", async () => {
  const repeated = longSearch("repeat");
  const fixture = sequence([
    { text: repeated },
    { text: repeated },
    { text: repeated },
    { text: longSearch("newest") },
  ]);
  const options = {
    mode: "aggressive" as const,
    keepRecentResults: 1,
    seenToolCallIds: fixture.callIds,
    sourceByToolCallId: fixture.sources,
  };
  const result = await projectToolResultContext(fixture.messages, options);
  const repeatedRun = await projectToolResultContext(fixture.messages, options);
  assert.deepEqual(repeatedRun, result);
  assert.equal(projectedText(result.messages[2]!), repeated);
  assert.equal(result.metrics.reducerFamilies["exact-repeat"]?.results, 2);
  assert.equal(result.metrics.projectedToolResults, 2);
});
