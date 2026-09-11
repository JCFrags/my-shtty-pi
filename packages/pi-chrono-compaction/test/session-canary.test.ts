import assert from "node:assert/strict";
import test from "node:test";
import { SessionCanary } from "../src/session-canary.js";

test("session canary binds one fresh source and cannot adopt or inherit history", () => {
  const off = new SessionCanary(undefined);
  off.start("fresh", "/fixture/fresh.jsonl", []);
  assert.equal(off.active("fresh", "/fixture/fresh.jsonl"), false);
  const fresh = new SessionCanary("fresh");
  fresh.start("fresh", "/fixture/fresh.jsonl", []);
  assert.equal(fresh.active("fresh", "/fixture/fresh.jsonl"), true);
  assert.equal(fresh.active("sibling", "/fixture/fresh.jsonl"), false);
  assert.equal(fresh.active("fresh", "/fixture/replaced.jsonl"), false);
  fresh.stop();
  fresh.start("fresh", "/fixture/fresh.jsonl", []);
  assert.equal(fresh.active("fresh", "/fixture/fresh.jsonl"), false);
  const resumed = new SessionCanary("fresh");
  resumed.start("fresh", "/fixture/fresh.jsonl", [{ id: "prior", type: "message", message: { role: "user", content: "Keep pending work." } }]);
  assert.equal(resumed.active("fresh", "/fixture/fresh.jsonl"), false);
  const inherited = new SessionCanary("fresh");
  inherited.start("fresh", "/fixture/fresh.jsonl", [{ id: "prior", type: "custom_message" }]);
  assert.equal(inherited.active("fresh", "/fixture/fresh.jsonl"), false);
});
