import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Controller, decodeState } from "../src/controller.mjs";
import { fail } from "../src/protocol.mjs";

const target = Object.freeze({ name: "fixture", destination: "fixture", displayName: "fixture", defaultCwd: "/tmp", authorization: "openssh-and-remote-account" });
const config = { targets: { fixture: target } };
function harness(branch = []) {
  const statuses = [];
  const widgets = [];
  const entries = [];
  const manager = { getBranch: () => branch };
  const ctx = { hasUI: true, cwd: "/tmp", sessionManager: manager, ui: { setStatus: (_key, text) => statuses.push(text), setWidget: (...args) => widgets.push(args) } };
  const pi = {
    active: ["read", "ls", "find", "grep", "write", "edit", "bash"],
    getActiveTools() { return [...this.active]; },
    setActiveTools(value) { this.active = [...value]; },
    appendEntry(type, data) { entries.push({ type, data }); },
  };
  return { controller: new Controller(pi, config), pi, ctx, statuses, widgets, entries };
}

test("restored state is exact, configured, collision-free, and recovery-gated", () => {
  const valid = { version: 2, mode: "remote", target: { name: "fixture", destination: "fixture", displayName: "fixture", cwd: "/tmp", authorization: "openssh-and-remote-account" }, generation: randomUUID(), updatedAt: Date.now() };
  assert.equal(decodeState(valid, config.targets).mode, "remote");
  for (const corrupt of [
    { ...valid, extra: true },
    { ...valid, generation: "aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa" },
    { ...valid, updatedAt: Date.now() + 1_000_000 },
    { ...valid, target: { ...valid.target, cwd: "relative" } },
    { ...valid, target: { ...valid.target, displayName: "spoof" } },
  ]) assert.equal(decodeState(corrupt, config.targets).mode, "local");
  const branch = [{ type: "custom", customType: "pi-native-ssh-state", data: valid }];
  const h = harness(branch);
  h.controller.sessionStart(h.ctx);
  h.controller.restore(h.ctx);
  assert.equal(h.controller.status().health, "error");
  assert.match(h.statuses.at(-1), /RECOVERY_REQUIRED/);
  assert.throws(() => h.controller.begin("read", undefined, h.ctx), error => error.code === "REMOTE_STATE_MISMATCH");
  h.controller.markRecovered(h.ctx);
  assert.equal(h.controller.status().health, "ready");
});

test("parallel operation accounting and persistent route errors are correct", () => {
  const h = harness();
  h.controller.sessionStart(h.ctx);
  h.controller.use("fixture", "/tmp", h.ctx);
  assert.ok(h.pi.active.includes("write") && h.pi.active.includes("edit") && h.pi.active.includes("bash"));
  const widgetText = h.widgets.at(-1)?.[1]?.join("\n") ?? "";
  assert.match(widgetText, /ls and ssh_transfer/);
  assert.match(widgetText, /Grounded local_search/);
  assert.doesNotMatch(widgetText, /read\/write\/edit\/bash\/search tools/);
  const one = h.controller.begin("read", undefined, h.ctx);
  const two = h.controller.begin("grep", undefined, h.ctx);
  assert.equal(h.controller.status().activeOperations, 2);
  assert.match(h.statuses.at(-1), /busy:2/);
  h.controller.end(one);
  assert.equal(h.controller.status().activeOperations, 1);
  assert.match(h.statuses.at(-1), /busy:1/);
  h.controller.end(two, fail("PROTOCOL_ERROR", "bad", { routeAffecting: true }));
  assert.equal(h.controller.status().health, "error");
  assert.match(h.statuses.at(-1), /stale\/error: PROTOCOL_ERROR/);
  assert.throws(() => h.controller.begin("read", undefined, h.ctx), error => error.code === "REMOTE_STATE_MISMATCH");
});

test("route changes abort in-flight work and stale completion cannot update the new route", () => {
  const h = harness();
  h.controller.sessionStart(h.ctx);
  const firstState = h.controller.use("fixture", "/tmp", h.ctx);
  const lease = h.controller.begin("read", undefined, h.ctx);
  assert.equal(lease.controller.signal.aborted, false);
  const secondState = h.controller.use("fixture", "/etc", h.ctx);
  assert.notEqual(firstState.generation, secondState.generation);
  assert.equal(lease.controller.signal.aborted, true);
  assert.throws(() => h.controller.end(lease), error => error.code === "TARGET_STALE");
  assert.equal(h.controller.status().health, "ready");
  assert.match(h.statuses.at(-1), /native SSH/);
});

test("clear leaves native mutation tools available and returns local routing", () => {
  const h = harness();
  h.pi.active = ["read", "ls", "write", "bash"];
  h.controller.sessionStart(h.ctx);
  h.controller.use("fixture", "/tmp", h.ctx);
  assert.deepEqual(h.pi.active, ["read", "ls", "write", "bash"]);
  h.controller.clear(h.ctx);
  assert.ok(h.pi.active.includes("write") && h.pi.active.includes("bash"));
  assert.ok(!h.pi.active.includes("edit"));
  assert.equal(h.controller.status().mode, "local");
  assert.equal(h.statuses.at(-1), "LOCAL");
});
