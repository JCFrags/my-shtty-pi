import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
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
  const text = `${"H".repeat(4_500)}${mixed}${"T".repeat(4_500)}`;
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
