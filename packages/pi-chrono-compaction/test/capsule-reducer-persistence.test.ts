import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CAPSULE_LIMITS, type SourceBlockReducerBaseInput } from "../src/capsule-contract.js";
import {
  beginCapsuleReduction,
  feedCapsuleReduction,
  finalizeCapsuleReduction,
  type CapsuleReducerStreamState,
} from "../src/capsule-reducer-stream.js";
import type { CapsuleReducerOptions } from "../src/capsule-reducer.js";
import { canonicalJson } from "../src/capsule-segment.js";
import { runCapsuleWorker } from "../src/capsule-worker-client.js";
import { line, setupCapsuleFixture } from "./capsule-storage-fixture.js";

async function deriveToEnd(fixture: ReturnType<typeof setupCapsuleFixture>, view: any): Promise<void> {
  let cursor: any;
  for (let page = 0; page < 200; page += 1) {
    const response = await fixture.request(view, { op: "derivePage", ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) return;
    cursor = (response.result as any).cursor;
    if ((response.result as any).complete) return;
  }
  assert.fail("derive did not complete");
}

type Route = "native" | "contained";

async function deriveAndRetrieve(
  fixture: ReturnType<typeof setupCapsuleFixture>,
  view: any,
  route: Route,
): Promise<any> {
  if (route === "native") {
    await deriveToEnd(fixture, view);
    const page = await fixture.ok(view, { op: "capsulePage", limit: 1 });
    assert.equal(page.capsules.length, 1);
    return page.capsules[0];
  }
  const schedulerDirectory = join(fixture.directory, "route-scheduler");
  mkdirSync(schedulerDirectory, { mode: 0o700 });
  let cursor: any;
  for (let page = 0; page < 200; page += 1) {
    const response = await runCapsuleWorker({ v: 1, derivedDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity: fixture.identity, view, op: "derivePage", ...(cursor === undefined ? {} : { cursor }) }, { schedulerDirectory, slots: 1 });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) assert.fail("contained derive refused");
    cursor = (response.result as any).cursor;
    if ((response.result as any).complete) break;
    if (page === 199) assert.fail("contained derive did not complete");
  }
  const response = await runCapsuleWorker({ v: 1, derivedDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
    identity: fixture.identity, view, op: "capsulePage", limit: 1 }, { schedulerDirectory, slots: 1 });
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) assert.fail("contained retrieval refused");
  const capsules = (response.result as any).capsules;
  assert.equal(capsules.length, 1);
  return capsules[0];
}

function directEnvelope(text: string, persisted: any, view: any, sizes: readonly number[], restartEvery = 0): any {
  const base: SourceBlockReducerBaseInput = {
    v: 1,
    identity: persisted.identity,
    view,
    source: persisted.source,
    kind: "user",
    provenance: persisted.provenance,
    structural: {},
  };
  const options: CapsuleReducerOptions = {
    family: persisted.family,
    familyVersion: persisted.familyVersion,
    reducerSetVersion: persisted.reducerSetVersion,
    configHash: persisted.configHash,
    budget: persisted.budget,
  };
  let state: CapsuleReducerStreamState = beginCapsuleReduction(base, options);
  let offset = 0, part = 0;
  while (offset < text.length) {
    const size = Math.max(1, sizes[part % sizes.length] ?? 1);
    const end = Math.min(text.length, offset + Math.min(size, CAPSULE_LIMITS.decodedChunkUnits));
    state = feedCapsuleReduction(state, { decodedUtf16: { start: offset, end }, text: text.slice(offset, end) });
    offset = end; part += 1;
    if (restartEvery > 0 && part % restartEvery === 0) state = JSON.parse(JSON.stringify(state)) as CapsuleReducerStreamState;
  }
  return finalizeCapsuleReduction(state);
}

function assertFullPersistedOracle(text: string, persisted: any, view: any): void {
  assert.equal(persisted.source.catalogStoreKey, persisted.identity.catalogStoreKey);
  assert.equal(persisted.source.sessionKey, persisted.identity.sessionKey);
  assert.ok(persisted.source.eventSeq > 0);
  assert.ok(persisted.source.descriptor >= 0);
  for (const alternative of persisted.alternatives) {
    for (const cue of alternative.protectedCues) assert.deepEqual(cue.source, persisted.source);
  }
  const partitions: readonly [string, readonly number[], number][] = [
    ["complete", [text.length], 0],
    ["one-unit", [1], 0],
    ["uneven", [7, 31, 2, 509, 4_097], 0],
    ["serialized-restarts", [1, 17, 257, 4_096], 3],
  ];
  const persistedEnvelopeBytes = JSON.stringify(persisted);
  const persistedAlternativeBytes = JSON.stringify(persisted.alternatives);
  for (const [name, sizes, restartEvery] of partitions) {
    const direct = directEnvelope(text, persisted, view, sizes, restartEvery);
    assert.equal(canonicalJson(direct), persistedEnvelopeBytes, `${name}: complete persisted envelope bytes`);
    assert.equal(canonicalJson(direct.alternatives), persistedAlternativeBytes, `${name}: complete alternatives bytes`);
  }
}

const routeFixtures = {
  mixed: (() => {
    const mixed = `${"must ".repeat(16)}${"exit code 1 ".repeat(16)}.`;
    return `${"H".repeat(32_760)}. ${mixed}${" tail".repeat(1_200)}`;
  })(),
  lexical: (() => {
    const astral = "𝒂";
    const loneHigh = String.fromCharCode(0xd835), loneLow = String.fromCharCode(0xdc82);
    const malformed = `${"eexit code 17 | exit codex 18 | exit code 19𝒂 | ".repeat(24)}`;
    const long = `exit code${" ".repeat(400)}29`;
    // The astral character starts at UTF-16 unit 32,767, so the production
    // 32,768-unit reducer feed splits its surrogate pair.
    return `${"P".repeat(32_767)}${astral}exit code 17 | Aexit code 17 | exit code 17A | exit code 17${astral} | ${malformed}`
      + `exit code 21${loneHigh}. ${loneLow}exit code 22. ${long}.${"T".repeat(5_000)}`;
  })(),
} as const;

for (const route of ["native", "contained"] as const) {
  test(`${route} persisted route matches complete direct envelopes for mixed capped cues`, async () => {
    const text = routeFixtures.mixed;
    assert.equal(text.indexOf("must"), 32_762);
    assert.equal(text.indexOf("must", 32_763), 32_767, "production feed boundary splits the second cue literal");
    const fixture = setupCapsuleFixture(line("a", null, text));
    try {
      const view = await fixture.initialize();
      const persisted = await deriveAndRetrieve(fixture, view, route);
      assertFullPersistedOracle(text, persisted, view);
      assert.deepEqual(persisted.alternatives[0].protectedCues.map((cue: any) => cue.exactText), Array(16).fill("must"));
      assert.ok(persisted.alternatives[0].omissions.some((item: any) => item.kind === "transformation-loss" && /16 additional protected-cue/.test(item.description)));
    } finally { fixture.cleanup(); }
  });

  test(`${route} persisted route matches complete direct envelopes for Unicode lexical failures`, async () => {
    const text = routeFixtures.lexical;
    assert.equal(text.indexOf("𝒂"), 32_767);
    assert.equal(text.charCodeAt(32_767), 0xd835);
    assert.equal(text.charCodeAt(32_768), 0xdc82, "production feed boundary splits the astral lexical character");
    const fixture = setupCapsuleFixture(line("a", null, text));
    try {
      const view = await fixture.initialize();
      const persisted = await deriveAndRetrieve(fixture, view, route);
      assertFullPersistedOracle(text, persisted, view);
      const failures = persisted.alternatives[0].protectedCues.filter((cue: any) => cue.kind === "failure").map((cue: any) => cue.exactText);
      assert.deepEqual(failures, ["exit code 21", "exit code 22", `exit code${" ".repeat(400)}29`]);
      for (const cue of persisted.alternatives[0].protectedCues) {
        assert.equal(text.slice(cue.decodedUtf16.start, cue.decodedUtf16.end), cue.exactText);
      }
    } finally { fixture.cleanup(); }
  });
}

test("persisted capsule retrieval rejects malformed exit-code words before a valid failure", async () => {
  const malformed = Array.from({ length: 16 }, (_, index) => `exit code${index + 1}abc`).join("|");
  const valid = `exit code${" ".repeat(400)}17`;
  const text = `${"H".repeat(4_500)}\n${malformed}\n${"M".repeat(1_200)}\n${valid}\n${"T".repeat(4_500)}`;
  const fixture = setupCapsuleFixture(line("a", null, text));
  try {
    const view = await fixture.initialize();
    await deriveToEnd(fixture, view);
    const page = await fixture.ok(view, { op: "capsulePage", limit: 1 });
    const primary = page.capsules[0].alternatives[0];
    assert.deepEqual(primary.protectedCues.filter((cue: any) => cue.kind === "failure").map((cue: any) => cue.exactText), [valid]);
    assert.ok(primary.text.includes(valid));
  } finally {
    fixture.cleanup();
  }
});

test("persisted retrieval uses source-ordered capped cue admission", async () => {
  const mixed = `${"must ".repeat(16)}${"exit code 1 ".repeat(16)}.`;
  const text = `${"H".repeat(4_500)}.${mixed}${"T".repeat(4_500)}`;
  const fixture = setupCapsuleFixture(line("a", null, text));
  try {
    const view = await fixture.initialize();
    await deriveToEnd(fixture, view);
    const page = await fixture.ok(view, { op: "capsulePage", limit: 1 });
    const primary = page.capsules[0].alternatives[0];
    assert.deepEqual(primary.protectedCues.map((cue: any) => cue.exactText), Array(16).fill("must"));
    assert.ok(primary.omissions.some((item: any) => item.kind === "transformation-loss" && /16 additional protected-cue/.test(item.description)));
    assert.ok(primary.text.includes("must"));
    assert.equal(primary.protectedCues.some((cue: any) => cue.kind === "failure"), false);
  } finally {
    fixture.cleanup();
  }
});

test("contained worker derives and retrieves the same source-ordered cue selection", async () => {
  const mixed = `${"must ".repeat(16)}${"exit code 1 ".repeat(16)}.`;
  const text = `${"head ".repeat(900)}${mixed}${" tail".repeat(900)}`;
  const fixture = setupCapsuleFixture(line("a", null, text));
  try {
    const view = await fixture.initialize();
    const schedulerDirectory = join(fixture.directory, "scheduler");
    mkdirSync(schedulerDirectory, { mode: 0o700 });
    let cursor: any;
    for (let page = 0; page < 200; page += 1) {
      const response = await runCapsuleWorker({ v: 1, derivedDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
        identity: fixture.identity, view, op: "derivePage", ...(cursor === undefined ? {} : { cursor }) }, { schedulerDirectory, slots: 1 });
      assert.equal(response.ok, true, JSON.stringify(response));
      if (!response.ok) return;
      cursor = (response.result as any).cursor;
      if ((response.result as any).complete) break;
      if (page === 199) assert.fail("contained derive did not complete");
    }
    const response = await runCapsuleWorker({ v: 1, derivedDirectory: fixture.derivedDirectory, catalogDirectory: fixture.catalogDirectory,
      identity: fixture.identity, view, op: "capsulePage", limit: 1 }, { schedulerDirectory, slots: 1 });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) return;
    const primary = (response.result as any).capsules[0].alternatives[0];
    assert.deepEqual(primary.protectedCues.map((cue: any) => cue.exactText), Array(16).fill("must"));
    assert.equal(primary.protectedCues.some((cue: any) => cue.kind === "failure"), false);
  } finally {
    fixture.cleanup();
  }
});

test("persisted capsule retrieval retains exact streamed edges and protected middle clause", async () => {
  const clause = "Do not deploy to production unless Morgan approves; staging is permitted.";
  const text = `${Array.from({ length: 5_000 }, (_, index) => String.fromCharCode(0x400 + index % 700)).join("")}\n${"routine ".repeat(700)}${clause}${" tail".repeat(700)}`;
  const fixture = setupCapsuleFixture(line("a", null, text));
  try {
    const view = await fixture.initialize();
    await deriveToEnd(fixture, view);
    const page = await fixture.ok(view, { op: "capsulePage", limit: 1 });
    assert.equal(page.capsules.length, 1);
    const primary = page.capsules[0].alternatives[0];
    assert.ok(primary.text.includes(clause));
    assert.ok(primary.text.endsWith(text.slice(-4_096)));
    const exact = primary.omissions.filter((item: any) => item.kind === "exact-range");
    assert.ok(exact.every((item: any) => item.omittedUnits === item.decodedUtf16.end - item.decodedUtf16.start));
    assert.ok(exact.every((item: any) => !primary.text.includes(text.slice(item.decodedUtf16.start, item.decodedUtf16.end))));
  } finally {
    fixture.cleanup();
  }
});
