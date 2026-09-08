import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CAPSULE_TEXT_HASH,
  isReducerEnvelope,
  type CatalogProvenance,
  type DerivedStoreIdentity,
  type ScopedRawSourceRef,
  type SourceBlockReducerInput,
  type SourceStructuralFacts,
  type SourceStructuralField,
} from "../src/capsule-contract.js";
import {
  CAPSULE_REDUCER_FAMILY_VERSIONS,
  reduceSourceBlock,
  type CapsuleReducerOptions,
} from "../src/capsule-reducer.js";

const hex = (text: string): string => createHash("sha256").update(text).digest("hex");
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function fixture(
  text: string,
  structural: SourceStructuralFacts = {},
  provenance: CatalogProvenance = "original",
  descriptor = 0,
  entryId: string | undefined = "entry-1",
  addStructuralSources = true,
): SourceBlockReducerInput {
  const identity: DerivedStoreIdentity = {
    storeKey: UUID_A,
    sessionKey: "session-1",
    catalogStoreKey: UUID_B,
    catalogGeneration: 3,
    derivedSchemaVersion: 2,
    capsuleSchemaVersion: 1,
    chunkSchemaVersion: 1,
    reducerSetVersion: "capsule-pure-v1",
    configHash: "c".repeat(64),
  };
  const structuralFields: readonly SourceStructuralField[] = [
    "role", "toolName", "toolCallId", "exitCode", "isError", "cancelled", "originallyTruncated",
  ];
  const sources: Partial<Record<SourceStructuralField, ScopedRawSourceRef>> = { ...structural.sources };
  if (addStructuralSources) {
    for (const field of structuralFields) {
      if (structural[field] === undefined || sources[field] !== undefined) continue;
      sources[field] = {
        catalogStoreKey: UUID_B,
        sessionKey: "session-1",
        catalogGeneration: 3,
        shardKey: "shard-1",
        segment: 1,
        eventSeq: 7,
        ordinal: 1,
        descriptor,
        field: `metadata.${field}`,
        raw: { start: 10, end: 11 },
        ...(entryId === undefined ? {} : { entryId }),
        coordinateKind: "raw-json",
        rawHashAlgorithm: "sha256-bytes-v1",
        rawHash: hex(`metadata.${field}`),
      };
    }
  }
  const verifiedStructural: SourceStructuralFacts = Object.keys(sources).length === 0 ? structural : { ...structural, sources };
  return {
    v: 1,
    identity,
    view: {
      storeKey: UUID_B,
      sessionKey: "session-1",
      generation: 3,
      eventCut: 12,
      branchKey: "branch-1",
      segments: [{ segment: 1, cut: 12 }],
    },
    source: {
      catalogStoreKey: UUID_B,
      sessionKey: "session-1",
      catalogGeneration: 3,
      shardKey: "shard-1",
      segment: 1,
      eventSeq: 7,
      ordinal: 1,
      descriptor,
      field: "message.content.0.text",
      raw: { start: 100, end: 100 + Math.max(2, text.length * 2 + 2) },
      ...(entryId === undefined ? {} : { entryId }),
      coordinateKind: "decoded-body",
      decodedUtf16: { start: 0, end: text.length },
      bodyHashAlgorithm: CAPSULE_TEXT_HASH,
      bodyHash: hex(text),
    },
    kind: "tool-result",
    provenance,
    structural: verifiedStructural,
    window: {
      decodedUtf16: { start: 0, end: text.length },
      text,
      completeBody: true,
      omittedBeforeUnits: 0,
      omittedAfterUnits: 0,
    },
  };
}

function options(family: CapsuleReducerOptions["family"] = "generic-text"): CapsuleReducerOptions {
  return {
    family,
    familyVersion: CAPSULE_REDUCER_FAMILY_VERSIONS[family],
    reducerSetVersion: "capsule-pure-v1",
    configHash: "c".repeat(64),
    budget: { maxTokens: 4096, maxUtf16Units: 16 * 1024, maxAlternatives: 3 },
  };
}

test("protected conditions, exceptions, negation, failures, unknowns, cancellation and pending approval retain exact ranges", () => {
  const text = "Only if ticket ABC is approved, do not deploy. However, failure is unresolved; cancellation is possible and pending approval.";
  const envelope = reduceSourceBlock(fixture(text), options("assistant-extractive"));
  assert.equal(isReducerEnvelope(envelope), true);
  const cues = envelope.alternatives[0]!.protectedCues;
  for (const kind of ["condition", "exception", "negation", "failure", "unknown", "cancelled", "pending-approval", "restriction"] as const) {
    const cue = cues.find((candidate) => candidate.kind === kind);
    assert.ok(cue, `missing ${kind}`);
    assert.equal(text.slice(cue.decodedUtf16.start, cue.decodedUtf16.end), cue.exactText);
  }
  assert.equal(envelope.alternatives[0]!.facts.some((fact) => fact.name === "pendingApproval"), true);
  assert.deepEqual(envelope.alternatives[0]!.outcome, { status: "unknown" });
});

test("failure extraction requires a trailing word boundary after an exit code", () => {
  const text = "exit code17a exit code17_ exit code17-";
  const cues = reduceSourceBlock(fixture(text), options("generic-text")).alternatives[0]!.protectedCues
    .filter((cue) => cue.kind === "failure");
  assert.deepEqual(cues.map((cue) => cue.exactText), ["exit code17"]);
  assert.equal(cues[0]!.decodedUtf16.start, text.lastIndexOf("exit code17"));
});

test("negated, quoted, and later-granted approval text never becomes a supported pending outcome", () => {
  for (const text of [
    "This is not pending approval.",
    "Historical quote: ‘pending approval’.",
    "It was pending approval, but approval was later granted.",
  ]) {
    const alternative = reduceSourceBlock(fixture(text), options("assistant-extractive")).alternatives[0]!;
    assert.ok(alternative.protectedCues.some((cue) => cue.kind === "pending-approval"));
    assert.ok(alternative.facts.some((fact) => fact.name === "pendingApproval"));
    assert.deepEqual(alternative.outcome, { status: "unknown" });
  }
});

test("outcomes require actual raw-referenced structural evidence and never infer success from quiet text or isError false", () => {
  assert.deepEqual(reduceSourceBlock(fixture("Work proposed; no error was printed.", { isError: false }), options()).alternatives[0]!.outcome, { status: "unknown" });
  const success = reduceSourceBlock(fixture("ordinary", { exitCode: 0 }), options()).alternatives[0]!;
  assert.equal(success.outcome.status, "supported");
  assert.equal(success.facts[0]!.source.coordinateKind, "raw-json");
  assert.match(success.facts[0]!.source.field, /metadata\.exitCode/);
  assert.deepEqual(reduceSourceBlock(fixture("ordinary", { exitCode: 2 }), options()).alternatives[0]!.outcome, { status: "supported", value: "failure", facts: [0] });
  assert.deepEqual(reduceSourceBlock(fixture("ordinary", { cancelled: true }), options()).alternatives[0]!.outcome, { status: "supported", value: "cancelled", facts: [0] });
});

test("missing or body-backed structural metadata references are refused rather than fabricated", () => {
  const missing = fixture("ordinary", { exitCode: 0 }, "original", 0, "entry-1", false);
  assert.throws(() => reduceSourceBlock(missing, options()), /complete-input-required/);
  const valid = fixture("ordinary", { exitCode: 0 });
  const bodyBacked = {
    ...valid,
    structural: { ...valid.structural, sources: { exitCode: valid.source } },
  } as unknown as SourceBlockReducerInput;
  assert.throws(() => reduceSourceBlock(bodyBacked, options()), /complete-input-required/);
});

test("source-local identity ignores later cut growth but distinguishes idless duplicate descriptors and bodies", () => {
  const first = fixture("same text", {}, "original", 1, undefined);
  const firstEnvelope = reduceSourceBlock(first, options());
  const later = { ...first, view: { ...first.view, eventCut: 99, segments: [{ segment: 1, cut: 99 }] } };
  assert.equal(reduceSourceBlock(later, options()).inputHash, firstEnvelope.inputHash);

  const duplicateDescriptor = fixture("same text", {}, "original", 2, undefined);
  const duplicateBody = fixture("different text", {}, "original", 1, undefined);
  assert.notEqual(reduceSourceBlock(duplicateDescriptor, options()).inputHash, firstEnvelope.inputHash);
  assert.notEqual(reduceSourceBlock(duplicateBody, options()).inputHash, firstEnvelope.inputHash);
});

test("generated and mixed provenance remain explicit in persisted envelopes", () => {
  for (const provenance of ["generated", "mixed"] as const) {
    const envelope = reduceSourceBlock(fixture("chronological generated action", {}, provenance), options());
    assert.equal(envelope.provenance, provenance);
    assert.equal(isReducerEnvelope(envelope), true);
  }
});

test("caller-supplied earlier pair is copied without looking up or inventing tool arguments", () => {
  const input = fixture("tool result", { toolCallId: "call-7", toolName: "bash" }, "generated", 2);
  const pair = {
    kind: "paired-call" as const,
    verifiedBy: "catalog-view-ancestry-v1" as const,
    call: {
      ...input.source,
      descriptor: 1,
      field: "message.content.0.arguments",
      coordinateKind: "raw-json" as const,
      rawHashAlgorithm: "sha256-bytes-v1" as const,
      rawHash: "d".repeat(64),
    },
    result: input.source,
  };
  const envelope = reduceSourceBlock(input, { ...options("terminal"), pair });
  assert.deepEqual(envelope.pair, pair);
  assert.equal(envelope.provenance, "generated");
  assert.deepEqual(envelope.alternatives[0]!.sourceRefs.slice(0, 2), [pair.call, input.source]);
  assert.ok(envelope.alternatives[0]!.sourceRefs.slice(2).every((source) => source.coordinateKind === "raw-json"));
  assert.equal(envelope.alternatives[0]!.facts.some((fact) => fact.name === "command"), false);
});

test("fixed pure families reuse their pinned versions and retain representation alternatives", () => {
  const samples: Array<[CapsuleReducerOptions["family"], string]> = [
    ["terminal", "start\nwarning: careful\nend"],
    ["test-output", "Vitest\nTests: 2 passed, 0 failed\nPASS alpha"],
    ["git-diff", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new"],
    ["generic-text", "head\nbody\ntail"],
    ["assistant-extractive", "Because this matters, verify it. Next test the result."],
    ["assistant-cleanup", "line  \n\n\n\nnext"],
    ["lossless-normalizer", "\u001b[31mred\u001b[0m"],
    ["small-json", JSON.stringify({ status: "unknown", id: "abc", values: [1, 2, 3] })],
  ];
  for (const [family, text] of samples) {
    const envelope = reduceSourceBlock(fixture(text), options(family));
    assert.equal(envelope.familyVersion, CAPSULE_REDUCER_FAMILY_VERSIONS[family]);
    assert.ok(envelope.alternatives.length >= 1 && envelope.alternatives.length <= 3);
    assert.ok(envelope.alternatives.every((alternative) => alternative.lossy && alternative.family === family));
    assert.equal(isReducerEnvelope(envelope), true);
  }
});

test("reduced, normalized and marker representation choices remain distinct", () => {
  const text = `\u001b[31mwarning: must inspect\u001b[0m  \n${"routine middle\n".repeat(300)}tail`;
  const envelope = reduceSourceBlock(fixture(text), options("terminal"));
  assert.equal(envelope.alternatives.length, 3);
  assert.equal(new Set(envelope.alternatives.map((alternative) => alternative.text)).size, 3);
  assert.ok(envelope.alternatives[2]!.omissions.some((item) => item.kind === "exact-range" && item.reason === "middle"));
});

test("every post-reducer text cap records honest unknown transformation loss", () => {
  const input = fixture("x".repeat(9_000));
  const capped = reduceSourceBlock(input, {
    ...options("lossless-normalizer"),
    budget: { maxTokens: 4_096, maxUtf16Units: 16_384, maxAlternatives: 1 },
  });
  assert.equal(capped.alternatives[0]!.text.length, 8 * 1024);
  assert.ok(capped.alternatives[0]!.omissions.some((item) => item.kind === "transformation-loss"
    && item.reason === "budget" && item.omittedUnits === "unknown" && /Post-reducer/.test(item.description)));
});

test("cue and escaped-text budgets keep the wire bounded with explicit overflow", () => {
  const text = `${"must not \\u0001 continue; ".repeat(1_500)}`.slice(0, 32_000);
  const envelope = reduceSourceBlock(fixture(text), options("generic-text"));
  assert.equal(isReducerEnvelope(envelope), true);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 256 * 1024);
  assert.ok(envelope.alternatives[0]!.protectedCues.length <= 16);
  assert.ok(envelope.alternatives[0]!.omissions.some((item) => /additional protected-cue match/.test(item.description)));
});

test("empty, CRLF, JSON escapes, Unicode and lone surrogates remain deterministic code-unit inputs", () => {
  for (const text of ["", "a\r\nb\r\n", "{\"value\":\"\\u263a\"}", "A😀B", `left${String.fromCharCode(0xd800)}right`]) {
    const a = reduceSourceBlock(fixture(text), options(text.startsWith("{") ? "small-json" : "generic-text"));
    const b = reduceSourceBlock(fixture(text), options(text.startsWith("{") ? "small-json" : "generic-text"));
    assert.deepEqual(a, b);
    assert.equal(isReducerEnvelope(a), true);
  }
});
