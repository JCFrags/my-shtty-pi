import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CAPSULE_REDUCER_PIPELINE_VERSION,
  CAPSULE_TEXT_HASH,
  isReducerEnvelope,
  type SourceBlockReducerBaseInput,
} from "../src/capsule-contract.js";
import { CAPSULE_REDUCER_FAMILY_VERSIONS, type CapsuleReducerOptions } from "../src/capsule-reducer.js";
import {
  beginCapsuleReduction,
  feedCapsuleReduction,
  finalizeCapsuleReduction,
  type CapsuleReducerStreamState,
} from "../src/capsule-reducer-stream.js";

const hex = (text: string): string => createHash("sha256").update(text).digest("hex");

function base(text: string): SourceBlockReducerBaseInput {
  return {
    v: 1,
    identity: {
      storeKey: "11111111-1111-4111-8111-111111111111",
      sessionKey: "session-stream",
      catalogStoreKey: "22222222-2222-4222-8222-222222222222",
      catalogGeneration: 5,
      derivedSchemaVersion: 2,
      capsuleSchemaVersion: 1,
      chunkSchemaVersion: 1,
      reducerSetVersion: "capsule-pure-v1",
      configHash: "c".repeat(64),
    },
    view: {
      storeKey: "22222222-2222-4222-8222-222222222222",
      sessionKey: "session-stream",
      generation: 5,
      eventCut: 9,
      branchKey: "branch-stream",
      segments: [{ segment: 1, cut: 9 }],
    },
    source: {
      catalogStoreKey: "22222222-2222-4222-8222-222222222222",
      sessionKey: "session-stream",
      catalogGeneration: 5,
      shardKey: "shard-stream",
      segment: 1,
      eventSeq: 9,
      ordinal: 1,
      descriptor: 3,
      field: "message.content.0.text",
      raw: { start: 20, end: 22 + text.length * 2 },
      coordinateKind: "decoded-body",
      decodedUtf16: { start: 0, end: text.length },
      bodyHashAlgorithm: CAPSULE_TEXT_HASH,
      bodyHash: hex(text),
    },
    kind: "tool-result",
    provenance: "mixed",
    structural: {},
  };
}

const options: CapsuleReducerOptions = {
  family: "generic-text",
  familyVersion: CAPSULE_REDUCER_FAMILY_VERSIONS["generic-text"],
  reducerSetVersion: "capsule-pure-v1",
  configHash: "c".repeat(64),
  budget: { maxTokens: 4096, maxUtf16Units: 24 * 1024, maxAlternatives: 2 },
};

function reducePartitioned(
  text: string,
  sizes: readonly number[],
  restartEvery = 0,
  reducerOptions: CapsuleReducerOptions = options,
): ReturnType<typeof finalizeCapsuleReduction> {
  let state: CapsuleReducerStreamState = beginCapsuleReduction(base(text), reducerOptions);
  let offset = 0;
  let part = 0;
  while (offset < text.length) {
    const size = sizes[part % sizes.length] ?? 1;
    const end = Math.min(text.length, offset + Math.max(1, size));
    state = feedCapsuleReduction(state, { decodedUtf16: { start: offset, end }, text: text.slice(offset, end) });
    offset = end;
    part += 1;
    if (restartEvery > 0 && part % restartEvery === 0) state = JSON.parse(JSON.stringify(state)) as CapsuleReducerStreamState;
  }
  return finalizeCapsuleReduction(state);
}

test("feed partition and serialized restart produce identical envelope bytes", () => {
  const text = `${"routine output\r\n".repeat(2_000)}ONLY IF approved, do not deploy; failure remains unknown and pending approval.${"tail 😀\n".repeat(2_000)}`;
  const one = reducePartitioned(text, [16_384]);
  const uneven = reducePartitioned(text, [1, 7, 31, 257, 4096], 9);
  const windows = reducePartitioned(text, [32_768], 1);
  assert.equal(JSON.stringify(uneven), JSON.stringify(one));
  assert.equal(JSON.stringify(windows), JSON.stringify(one));
  assert.equal(isReducerEnvelope(one), true);
  const cues = one.alternatives[0]!.protectedCues;
  assert.ok(cues.some((cue) => cue.kind === "condition" && cue.exactText === "ONLY IF"));
  assert.ok(cues.some((cue) => cue.kind === "pending-approval"));
  for (const cue of cues) assert.equal(text.slice(cue.decodedUtf16.start, cue.decodedUtf16.end), cue.exactText);
});

test("ordinary and incremental cues share source ordering before capped admission", () => {
  const mixed = `${"must ".repeat(16)}${"exit code 1 ".repeat(16)}.`;
  for (const text of [mixed, `${"long head ".repeat(700)}${mixed}${" long tail".repeat(700)}`]) {
    const complete = reducePartitioned(text, [text.length]);
    const oneUnit = reducePartitioned(text, [1]);
    const uneven = reducePartitioned(text, [7, 1, 97, 3, 509]);
    const restarted = reducePartitioned(text, [1, 31, 257], 2);
    for (const actual of [oneUnit, uneven, restarted]) {
      assert.equal(JSON.stringify(actual), JSON.stringify(complete), "same final envelope bytes for every partition and restart");
    }
    const primary = complete.alternatives[0]!;
    assert.equal(primary.protectedCues.length, 16);
    assert.deepEqual(primary.protectedCues.map(cue => cue.exactText), Array(16).fill("must"));
    assert.ok(primary.text.includes("must"));
    assert.equal(primary.protectedCues.some(cue => cue.kind === "failure"), false);
    assert.ok(primary.omissions.some(item => item.kind === "transformation-loss" && /16 additional protected-cue/.test(item.description)));
    for (const cue of primary.protectedCues) assert.equal(text.slice(cue.decodedUtf16.start, cue.decodedUtf16.end), cue.exactText);
  }
});

test("failure grammar rejects lexical continuations across BMP, astral, split-surrogate, and restart boundaries", () => {
  const astralLetter = "𝒂"; // U+1D482, two UTF-16 code units.
  const loneHigh = String.fromCharCode(0xd835), loneLow = String.fromCharCode(0xdc82);
  const invalid = [
    "eexit code 17", "aexit code 17", `${astralLetter}exit code 17`,
    "exit code 17a", `exit code 17${astralLetter}`,
  ];
  const valid = [
    { source: `exit code${" ".repeat(400)}17.`, cue: `exit code${" ".repeat(400)}17` },
    { source: `exit code 19${loneHigh}.`, cue: "exit code 19" },
    { source: `${loneLow}exit code 23.`, cue: "exit code 23" },
  ];
  const text = `${invalid.join(" | ")} | ${valid.map(value => value.source).join(" | ")}`;
  const complete = reducePartitioned(text, [text.length]);
  for (const actual of [
    reducePartitioned(text, [1]),
    reducePartitioned(text, [text.indexOf(astralLetter) + 1, 1, 3, 17], 1),
    reducePartitioned(text, [2, 31, 257], 2),
  ]) assert.equal(JSON.stringify(actual), JSON.stringify(complete));
  const failures = complete.alternatives[0]!.protectedCues.filter(cue => cue.kind === "failure").map(cue => cue.exactText);
  assert.deepEqual(failures, valid.map(value => value.cue));
});

test("malformed partial literals and repetitions do not hide a later valid long failure clause", () => {
  const malformed = `${"eexit code 17 | exit codex 18 | exit code 19𝒂 | ".repeat(24)}`;
  const valid = `exit code${" ".repeat(400)}29`;
  const text = `${"H".repeat(4_500)}.${malformed}${"M".repeat(900)}.${valid}.${"T".repeat(4_500)}`;
  const complete = reducePartitioned(text, [text.length]);
  for (const actual of [reducePartitioned(text, [1], 1), reducePartitioned(text, [13, 2, 511, 4_097], 3)]) {
    assert.equal(JSON.stringify(actual), JSON.stringify(complete));
  }
  assert.deepEqual(complete.alternatives[0]!.protectedCues.filter(cue => cue.kind === "failure").map(cue => cue.exactText), [valid]);
  assert.ok(complete.alternatives[0]!.text.includes(valid));
});

test("pipeline and serialized checkpoint expose the new settled-frontier semantics", () => {
  const state = feedCapsuleReduction(beginCapsuleReduction(base("exit"), options), { decodedUtf16: { start: 0, end: 4 }, text: "exit" });
  assert.equal(CAPSULE_REDUCER_PIPELINE_VERSION, "capsule-pure-v4");
  assert.equal(Number(state.v), 4);
  assert.equal(Number((JSON.parse(JSON.stringify(state)) as { v: number }).v), 4);
});

test("identifier prefixes at a feed boundary are deferred until the match is settled", () => {
  const text = "head https://example.com/alpha/beta tail";
  const one = reducePartitioned(text, [text.length]);
  const split = reducePartitioned(text, [20, text.length - 20]);
  const restarted = reducePartitioned(text, [20, text.length - 20], 1);
  assert.equal(JSON.stringify(split), JSON.stringify(one));
  assert.equal(JSON.stringify(restarted), JSON.stringify(one));
  const identifiers = one.alternatives[0]!.protectedCues.filter((cue) => cue.kind === "identifier");
  assert.deepEqual(identifiers.map((cue) => cue.exactText), ["https://example.com/alpha/beta"]);
});

test("ordinary identifiers crossing the settled frontier retain exact coordinates and neighborhoods", () => {
  const identifiers = ["./" + "x".repeat(198), "https://example.com/" + "x".repeat(220)];
  for (const identifier of identifiers) {
    const text = `${"H".repeat(4_999)}\n${identifier}\n${"T".repeat(4_999)}`;
    const complete = reducePartitioned(text, [text.length]);
    for (const split of [5_567, 5_568, 5_569]) {
      for (const restartEvery of [0, 1]) {
        const actual = reducePartitioned(text, [split, text.length - split], restartEvery);
        assert.equal(JSON.stringify(actual), JSON.stringify(complete), `${identifier.slice(0, 12)} split ${split} restart ${restartEvery}`);
      }
    }
    let state = beginCapsuleReduction(base(text), options);
    let sawPostScanCarry = false;
    for (let offset = 0; offset < text.length; offset += 257) {
      const end = Math.min(text.length, offset + 257);
      const priorSettled = state.scanSettledOffset;
      state = feedCapsuleReduction(state, { decodedUtf16: { start: offset, end }, text: text.slice(offset, end) });
      assert.ok(state.scanCarry.length < 768, `bounded between-scan carry at ${end}`);
      if (state.scanSettledOffset > priorSettled) {
        assert.equal(state.scanCarry.length, 512, `fixed post-scan carry at ${end}`);
        sawPostScanCarry = true;
      }
      const serialized = JSON.stringify(state);
      assert.ok(Buffer.byteLength(serialized) < 128 * 1024, `bounded serialized state at ${end}`);
      state = JSON.parse(serialized) as CapsuleReducerStreamState;
    }
    assert.equal(sawPostScanCarry, true);
    assert.equal(JSON.stringify(finalizeCapsuleReduction(state)), JSON.stringify(complete), "small multi-chunk restart envelope");
    const primary = complete.alternatives[0]!;
    const cue = primary.protectedCues.find((candidate) => candidate.kind === "identifier");
    assert.deepEqual(cue?.decodedUtf16, { start: 5_000, end: 5_000 + identifier.length });
    assert.equal(cue?.exactText, identifier);
    assert.ok(primary.text.includes(`\n${identifier}\n`));
  }
});

test("exact cue-end feed boundary is reconsidered when the following delimiter settles it", () => {
  const text = "pending approval tail";
  const whole = reducePartitioned(text, [text.length]);
  const split = reducePartitioned(text, [16, text.length - 16]);
  const restarted = reducePartitioned(text, [16, text.length - 16], 1);
  assert.equal(JSON.stringify(split), JSON.stringify(whole));
  assert.equal(JSON.stringify(restarted), JSON.stringify(whole));
  assert.deepEqual(whole.alternatives[0]!.protectedCues.map((cue) => cue.exactText), ["pending approval"]);
});

test("every split position and one-unit feeds preserve phrase, URL, negation and condition matches", () => {
  const text = "if pending approval, do not continue unless cleared; inspect https://example.com/alpha/beta tail";
  const whole = reducePartitioned(text, [text.length]);
  for (let split = 1; split < text.length; split += 1) {
    const partitioned = reducePartitioned(text, [split, text.length - split]);
    const restarted = reducePartitioned(text, [split, text.length - split], 1);
    assert.equal(JSON.stringify(partitioned), JSON.stringify(whole), `split ${split}`);
    assert.equal(JSON.stringify(restarted), JSON.stringify(whole), `restart split ${split}`);
  }
  assert.equal(JSON.stringify(reducePartitioned(text, [1], 1)), JSON.stringify(whole));
  const kinds = new Set(whole.alternatives[0]!.protectedCues.map((cue) => cue.kind));
  for (const kind of ["condition", "pending-approval", "negation", "restriction", "identifier"] as const) assert.ok(kinds.has(kind));
});

test("settled scan cursor keeps overflow count and selected-cue priority partition-stable", () => {
  const text = `${"must not continue; ".repeat(40)}https://example.com/final`;
  const whole = reducePartitioned(text, [32_768]);
  for (const sizes of [[1], [17], [31, 7, 2], [256]] as const) {
    assert.equal(JSON.stringify(reducePartitioned(text, sizes, 1)), JSON.stringify(whole));
  }
  assert.ok(whole.alternatives[0]!.omissions.some((item) => /additional protected-cue match/.test(item.description)));
});

test("giant streamed input retains bounded serializable state and output", () => {
  const unit = "0123456789 routine line without cues\n";
  const text = unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length)).slice(0, 3 * 1024 * 1024);
  let state = beginCapsuleReduction(base(text), options);
  let maximumStateBytes = 0;
  for (let offset = 0; offset < text.length; offset += 32_768) {
    const end = Math.min(text.length, offset + 32_768);
    state = feedCapsuleReduction(state, { decodedUtf16: { start: offset, end }, text: text.slice(offset, end) });
    maximumStateBytes = Math.max(maximumStateBytes, Buffer.byteLength(JSON.stringify(state)));
  }
  assert.ok(maximumStateBytes < 128 * 1024, `serialized state ${maximumStateBytes} bytes`);
  const envelope = finalizeCapsuleReduction(state);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 256 * 1024);
  assert.ok(envelope.alternatives[0]!.text.length <= options.budget.maxUtf16Units);
  assert.ok(envelope.alternatives[0]!.omissions.some((item) => item.kind === "exact-range" && item.reason === "middle"));
  // This is a bounded-state assertion, not an operating-system or native-allocation memory claim.
});

test("cue matching spans feed boundaries and preserves CRLF, escapes, Unicode and lone surrogate coordinates", () => {
  const lone = String.fromCharCode(0xd800);
  const text = `head\r\nrequires approval then must not continue \\u263a 😀 ${lone} tail`;
  const envelope = reducePartitioned(text, [2, 3, 5], 2);
  assert.equal(isReducerEnvelope(envelope), true);
  for (const cue of envelope.alternatives[0]!.protectedCues) {
    assert.equal(text.slice(cue.decodedUtf16.start, cue.decodedUtf16.end), cue.exactText);
  }
  assert.ok(envelope.alternatives[0]!.protectedCues.some((cue) => cue.exactText === "requires approval"));
});

test("streamed head/tail coverage is exact at every 4 KiB boundary", () => {
  for (const length of [4_095, 4_096, 4_097, 8_191, 8_192, 8_193]) {
    const text = Array.from({ length }, (_, index) => String.fromCharCode(0x21 + index % 90)).join("");
    const envelope = reducePartitioned(text, [1, 17, 509, 4_096], 3);
    const primary = envelope.alternatives[0]!;
    const exact = primary.omissions.filter((item) => item.kind === "exact-range");
    if (length <= 8_192) {
      assert.equal(primary.text, text, `length ${length} must retain every selected unit without a synthetic marker`);
      assert.deepEqual(exact, [], `length ${length} must not claim an omission`);
    } else {
      assert.ok(primary.text.startsWith(text.slice(0, 4_096)));
      assert.ok(primary.text.endsWith(text.slice(-4_096)));
      assert.deepEqual(exact.map((item) => item.decodedUtf16), [{ start: 4_096, end: 4_097 }]);
      assert.equal(exact[0]!.omittedUnits, 1);
    }
  }
});

test("overlapping tail remains retained and omission coverage follows final bytes", () => {
  const text = Array.from({ length: 5_000 }, (_, index) => String.fromCharCode(0x400 + index % 700)).join("");
  const primary = reducePartitioned(text, [37, 1_003, 2], 2).alternatives[0]!;
  assert.equal(primary.text, text);
  assert.equal(primary.text.endsWith(text.slice(-904)), true);
  assert.equal(primary.omissions.some((item) => item.kind === "exact-range"), false);
});

test("protected middle text retains one exact bounded clause neighborhood", () => {
  const clause = "Do not deploy to production unless Morgan approves; staging is permitted.";
  const text = `${"ordinary head ".repeat(400)}${clause}${" ordinary tail".repeat(400)}`;
  const whole = reducePartitioned(text, [32_768]);
  const uneven = reducePartitioned(text, [1, 13, 257, 4_097], 4);
  assert.equal(JSON.stringify(uneven), JSON.stringify(whole));
  assert.ok(whole.alternatives[0]!.text.includes(clause));
  assert.equal((whole.alternatives[0]!.text.match(/Do not deploy/g) ?? []).length, 1);
  for (const cue of whole.alternatives[0]!.protectedCues) {
    assert.equal(text.slice(cue.decodedUtf16.start, cue.decodedUtf16.end), cue.exactText);
  }
});

test("protected middle lines retain restrictions, exceptions, failure detail, cancellation and pending approval without outcome inference", () => {
  const lines = [
    "Do not deploy unless Morgan approves; staging is permitted.",
    "Failure detail: the command failed after exit code 9.",
    "Cancellation was requested; the work remains unresolved.",
    "The quoted phrase ‘pending approval’ does not grant approval.",
  ];
  const text = `${"head ".repeat(900)}\n${lines.join("\n")}\n${"tail ".repeat(900)}`;
  const envelope = reducePartitioned(text, [1, 29, 513, 4_097], 5);
  const primary = envelope.alternatives[0]!;
  for (const line of lines) assert.ok(primary.text.includes(line), line);
  assert.deepEqual(primary.outcome, { status: "unknown" });
  const kinds = new Set(primary.protectedCues.map((cue) => cue.kind));
  for (const kind of ["restriction", "condition", "failure", "cancelled", "unknown", "pending-approval", "negation"] as const) assert.ok(kinds.has(kind), kind);
});

test("bounded failure grammar crosses more than the old overlap and remains partition stable", () => {
  const failure = `exit code${" ".repeat(400)}17`;
  const text = `${"head ".repeat(900)}${failure}${" tail".repeat(900)}`;
  const whole = reducePartitioned(text, [32_768]);
  for (const sizes of [[1], [17, 65, 4_097], [257, 3, 8_191]] as const) {
    assert.equal(JSON.stringify(reducePartitioned(text, sizes, 5)), JSON.stringify(whole));
  }
  assert.ok(whole.alternatives[0]!.protectedCues.some((cue) => cue.kind === "failure" && cue.exactText === failure));
  assert.ok(whole.alternatives[0]!.text.includes(failure));
});

test("malformed exit-code words cannot exhaust cues before a valid long-whitespace failure", () => {
  const malformed = Array.from({ length: 16 }, (_, index) => `exit code${index + 1}abc`).join("|");
  const valid = `exit code${" ".repeat(400)}17`;
  const text = `${"H".repeat(4_500)}\n${malformed}\n${"M".repeat(1_200)}\n${valid}\n${"T".repeat(4_500)}`;
  const whole = reducePartitioned(text, [32_768]);
  const oneUnit = reducePartitioned(text, [1], 1);
  const uneven = reducePartitioned(text, [17, 513, 4_097], 2);
  assert.equal(JSON.stringify(oneUnit), JSON.stringify(whole));
  assert.equal(JSON.stringify(uneven), JSON.stringify(whole));
  const failureCues = whole.alternatives[0]!.protectedCues.filter((cue) => cue.kind === "failure");
  assert.deepEqual(failureCues.map((cue) => cue.exactText), [valid]);
  assert.ok(whole.alternatives[0]!.text.includes(valid));
  assert.equal(failureCues.some((cue) => /(?:abc|_)$/u.test(cue.exactText)), false);
});

test("over-limit grammar and identifiers degrade explicitly with partition-stable final envelopes", () => {
  const overlongFailure = `exit code${" ".repeat(513)}17`;
  const overlongUrl = `https://example.com/${"a".repeat(241)}`;
  const text = `${"head ".repeat(900)}${overlongFailure} and ${overlongUrl}${" tail".repeat(900)}`;
  const whole = reducePartitioned(text, [32_768]);
  for (const sizes of [[1], [19, 257, 4_097]] as const) {
    assert.equal(JSON.stringify(reducePartitioned(text, sizes, 7)), JSON.stringify(whole));
  }
  assert.equal(whole.alternatives[0]!.protectedCues.some((cue) => cue.exactText === overlongFailure || cue.exactText === overlongUrl), false);
  assert.ok(whole.alternatives[0]!.omissions.some((item) => item.kind === "transformation-loss" && /bounded-grammar/.test(item.description)));
});

test("post-render cap clips exact source coverage instead of retaining pre-cap ranges", () => {
  const clause = "Unless approved, do not deploy to production; staging is permitted.";
  const text = `${"H".repeat(4_500)}${clause}${"T".repeat(4_500)}`;
  const cappedOptions: CapsuleReducerOptions = { ...options, budget: { ...options.budget, maxUtf16Units: 6_000 } };
  const whole = reducePartitioned(text, [32_768], 0, cappedOptions);
  const restarted = reducePartitioned(text, [1, 31, 257, 4_097], 3, cappedOptions);
  assert.equal(JSON.stringify(restarted), JSON.stringify(whole));
  const primary = whole.alternatives[0]!;
  assert.equal(primary.text.length, 6_000);
  assert.ok(primary.omissions.some((item) => item.kind === "transformation-loss" && /Post-reducer/.test(item.description)));
  const exact = primary.omissions.filter((item) => item.kind === "exact-range");
  assert.ok(exact.length >= 1);
  for (const item of exact) {
    assert.equal(item.omittedUnits, item.decodedUtf16.end - item.decodedUtf16.start);
  }
});

test("empty body finalizes without a feed and invalid feed order is refused", () => {
  const empty = beginCapsuleReduction(base(""), options);
  assert.equal(isReducerEnvelope(finalizeCapsuleReduction(empty)), true);
  const state = beginCapsuleReduction(base("abc"), options);
  assert.throws(() => feedCapsuleReduction(state, { decodedUtf16: { start: 1, end: 2 }, text: "b" }), /noncontiguous/);
  const oversizedText = "x".repeat(32_769);
  const oversized = beginCapsuleReduction(base(oversizedText), options);
  assert.throws(() => feedCapsuleReduction(oversized, { decodedUtf16: { start: 0, end: oversizedText.length }, text: oversizedText }), /noncontiguous/);
  assert.throws(() => finalizeCapsuleReduction(state), /incomplete/);
});

test("overflowed cue selection remains bounded and discloses the count", () => {
  const text = `${"must not continue; ".repeat(400)}${"routine\n".repeat(3_000)}`;
  let state = beginCapsuleReduction(base(text), options);
  for (let offset = 0; offset < text.length; offset += 113) {
    const end = Math.min(text.length, offset + 113);
    state = feedCapsuleReduction(state, { decodedUtf16: { start: offset, end }, text: text.slice(offset, end) });
  }
  assert.ok(state.protectedCueOverflow > 0);
  assert.ok(state.protectedCues.length <= 16);
  const envelope = finalizeCapsuleReduction(state);
  assert.ok(envelope.alternatives[0]!.omissions.some((item) => /additional protected-cue match/.test(item.description)));
});
