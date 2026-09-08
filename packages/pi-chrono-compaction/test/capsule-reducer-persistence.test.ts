import assert from "node:assert/strict";
import test from "node:test";
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
