import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionJsonl } from "../src/jsonl.js";
// @ts-expect-error Package-local executable support module intentionally has no declaration file.
import * as syntheticModule from "../../scripts/synthetic-session.mjs";

const { SYNTHETIC_PROFILES, appendScenario, createSyntheticSession, mutatePrefixScenario, replaceScenario, resolveSyntheticProfile, serializeSyntheticSession, syntheticEntries, truncateScenario } = syntheticModule as any;

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/synthetic-session.mjs");

test("all named workload profiles are deterministic and bounded", () => {
  assert.deepEqual(Object.keys(SYNTHETIC_PROFILES), ["small", "medium", "large", "adversarial", "multi-agent"]);
  for (const name of Object.keys(SYNTHETIC_PROFILES)) {
    const first = createSyntheticSession(name);
    const second = createSyntheticSession(name);
    assert.equal(serializeSyntheticSession(first), serializeSyntheticSession(second));
    assert.equal(first.entries.length, first.config.eventCount);
    assert.ok(first.shards.shards.length >= 1);
    assert.equal(first.shards.shards.reduce((sum: number, shard: { recordCount: number }) => sum + shard.recordCount, 0), first.entries.length);
  }
});

test("configurable counts, payload sizes, giant records, forks, compactions, agents, and rollover are represented", () => {
  const session = createSyntheticSession({
    profile: "small", eventCount: 20, toolResultBytes: 31, giantRecordBytes: 4097,
    giantRecordIndex: 2, forkEvery: 5, compactionCount: 3, agentCount: 4, shardEntries: 6,
    sessionId: "synthetic-controls",
  });
  assert.equal(session.entries.length, 20);
  assert.equal(session.generations.length, 3);
  assert.equal(session.shards.shards.length, 4);
  const giant = session.entries[2].message.content[0].text as string;
  assert.equal(Buffer.byteLength(giant), 4097);
  const ordinaryResult = session.entries.find((entry: any, index: number) => index !== 2 && entry.message?.role === "toolResult");
  assert.ok(ordinaryResult);
  assert.equal(Buffer.byteLength(ordinaryResult.message.content[0].text), 31);
  assert.ok(session.entries.some((entry: { id: string; parentId: string | null }, index: number) => index > 1 && entry.parentId !== session.entries[index - 1].id));
  assert.match(serializeSyntheticSession(session), /agent-0[1-4]/);
  assert.equal(parseSessionJsonl(serializeSyntheticSession(session)).entries.length, 20);
});

test("malformed and incomplete tails are deterministic while complete output parses", () => {
  const session = createSyntheticSession({ profile: "small", eventCount: 8, compactionCount: 0 });
  assert.equal(parseSessionJsonl(serializeSyntheticSession(session)).entries.length, 8);
  assert.throws(() => parseSessionJsonl(serializeSyntheticSession(session, { malformedTail: "truncated-json" })), /Invalid JSON/);
  assert.throws(() => parseSessionJsonl(serializeSyntheticSession(session, { malformedTail: "invalid-json" })), /Invalid JSON/);
  const missingNewline = serializeSyntheticSession(session, { malformedTail: "missing-newline" });
  assert.equal(missingNewline.endsWith("\n"), false);
  assert.equal(parseSessionJsonl(missingNewline).entries.length, 8);
});

test("append, replacement, truncation, and prefix mutation scenarios expose exact boundaries", () => {
  const session = createSyntheticSession({ profile: "small", eventCount: 8, compactionCount: 0 });
  const append = appendScenario(session, 3);
  assert.equal(Buffer.byteLength(append.initialText), append.checkpointBytes);
  assert.equal(append.finalText, append.initialText + append.appendText);
  assert.equal(parseSessionJsonl(append.finalText).entries.length, 11);

  const replacement = replaceScenario(session);
  assert.notEqual(replacement.originalText, replacement.replacementText);
  assert.equal(Buffer.byteLength(replacement.originalText), Buffer.byteLength(replacement.replacementText));

  const retained = Math.floor(Buffer.byteLength(append.initialText) / 2);
  const truncation = truncateScenario(session, retained);
  assert.equal(Buffer.byteLength(truncation.truncated), retained);
  assert.ok(truncation.originalBytes > truncation.retainedBytes);

  const mutation = mutatePrefixScenario(session, 0);
  assert.equal(Buffer.byteLength(mutation.originalText), Buffer.byteLength(mutation.mutatedText));
  assert.notEqual(mutation.originalText, mutation.mutatedText);
});

test("legacy syntheticEntries stays byte-compatible with benchmark consumers", async () => {
  const entries = syntheticEntries(3);
  assert.equal(entries.length, 11);
  assert.equal(entries[0].id, "syn-root");
  assert.equal(entries.at(-1).id, "syn-f-3");
  assert.throws(() => syntheticEntries(0), /synthetic-task-count/);

  const benchmarkSource = await readFile(resolve(dirname(SCRIPT), "benchmark-v2.mjs"), "utf8");
  assert.match(benchmarkSource, /export \{ syntheticEntries \} from "\.\/synthetic-session\.mjs"/);
});

test("profile validation is strict and generator has no ambient discovery", async () => {
  assert.throws(() => resolveSyntheticProfile("unknown"), /synthetic-profile/);
  assert.throws(() => resolveSyntheticProfile({ profile: "small", eventCount: 0 }), /synthetic-event-count/);
  assert.throws(() => resolveSyntheticProfile({ profile: "small", extra: true }), /synthetic-option/);
  const source = await readFile(SCRIPT, "utf8");
  for (const forbidden of ["process.env", "process.cwd", "homedir", "readdir", "readSessionJsonl", ".pi/agent/sessions"]) assert.equal(source.includes(forbidden), false, forbidden);
});
