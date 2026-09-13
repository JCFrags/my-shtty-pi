import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import telemetry, { QUALITY_EVENT } from "../index.ts";
import { MAX_CORRELATIONS, Meter, parseQuality } from "../model.ts";
import { LocalWriter, STORAGE_LIMITS } from "../storage.ts";

// These checks keep small temporary artifacts for inspection. They never use the live telemetry directory.
function host() {
  const handlers = new Map<string, (event: any, context?: any) => unknown>();
  const listeners = new Map<string, (value: unknown) => void>();
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  const api = {
    on(name: string, handler: (event: any) => unknown) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    events: {
      on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => { listeners.delete(name); }; },
      emit(name: string, value: unknown) { listeners.get(name)?.(value); },
    },
  };
  return { api: api as unknown as ExtensionAPI, handlers, tools, commands, listeners,
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event) };
}
const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 };

test("standalone tool, lifecycle pairing, quality separation and content-free records", async () => {
  const home = await mkdtemp(join(tmpdir(), "context-telemetry-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const pi = host();
  try {
    telemetry(pi.api);
    assert.deepEqual([...pi.tools.keys()], ["telemetry_status"]);
    assert.deepEqual([...pi.commands.keys()], ["context-telemetry"]);
    assert.equal(pi.listeners.size, 0, "factory does not start bus resources");
    assert.equal((await pi.tools.get("telemetry_status").execute()).details.storage.state, "idle");
    await assert.rejects(stat(join(home, ".local")), { code: "ENOENT" });
    assert.equal(pi.emit("session_start"), undefined, "startup does not await filesystem work");
    assert.equal(pi.listeners.size, 1);
    const secret = "SYNTHETIC_SECRET_MUST_NOT_APPEAR";
    const forbidden = { get args() { throw new Error(secret); }, get result() { throw new Error(secret); },
      get content() { throw new Error(secret); }, get toolName() { throw new Error(secret); },
      get errorMessage() { throw new Error(secret); } };
    pi.emit("agent_start");
    pi.emit("turn_start", { turnIndex: 0 });
    pi.emit("tool_execution_start", Object.assign(Object.create(forbidden), { toolCallId: secret }));
    pi.emit("tool_execution_end", Object.assign(Object.create(forbidden), { toolCallId: secret, isError: false }));
    pi.emit("message_end", { message: Object.assign(Object.create(forbidden), { role: "assistant", usage: { ...usage, credential: secret } }) });
    pi.emit("message_end", { message: { role: "toolResult", usage } });
    pi.emit("turn_end", { turnIndex: 0 });
    pi.emit("agent_end", forbidden);
    pi.emit("agent_settled");
    const begin = { reason: "manual", willRetry: false };
    const success = { ...begin, compactionEntry: { usage, summary: secret } };
    pi.emit("session_compact", success); // Orphan success is not a completed compaction.
    pi.emit("session_before_compact", begin);
    pi.emit("session_compact", success);
    pi.emit("session_compact", success); // Duplicate terminal event.
    pi.emit("session_before_compact", begin);
    pi.emit("session_compact_failed", Object.assign(Object.create(forbidden), { ...begin, aborted: true }));
    pi.emit("session_before_compact", begin);
    pi.emit("session_compact_failed", Object.assign(Object.create(forbidden), { ...begin, aborted: false }));
    pi.emit("session_before_compact", begin);
    pi.emit("session_tree", { summaryEntry: { usage, summary: secret } });
    pi.emit("session_compact", success); // Prior branch is abandoned.
    pi.emit("session_before_compact", begin);
    pi.emit("session_before_compact", begin); // No operation ID exists to disambiguate overlap.
    pi.emit("session_compact", success);
    pi.emit("session_before_compact", begin);
    pi.emit("session_compact", { ...success, reason: "overflow", willRetry: true });
    pi.emit("session_before_compact", { reason: secret, willRetry: false });
    let result = (await pi.tools.get("telemetry_status").execute()).details;
    assert.equal(result.quality.state, "unknown");
    assert.equal(result.runtime.compaction.succeeded, 1);
    assert.equal(result.runtime.compaction.aborted, 1);
    assert.equal(result.runtime.compaction.failed, 1);
    assert.equal(result.runtime.compaction.unpaired, 5);
    assert.equal(result.runtime.compaction.abandoned, 4);
    assert.equal(result.runtime.tool.succeeded, 1);
    assert.equal(result.runtime.agent.ended, 1, "agent_end does not claim task success");
    assert.equal(result.runtime.usage.assistant.input, 10);
    assert.equal(result.runtime.usage.tool.input, 10);
    assert.equal(result.runtime.usage.compaction.input, 10);
    assert.equal(result.runtime.usage.branch_summary.input, 10);
    pi.api.events.emit(QUALITY_EVENT, { version: 1, kind: "retrieval", outcome: "fail", basis: "source_known_case",
      issue: "missing_evidence", expectedEvidence: 2, observedEvidence: 1 });
    pi.api.events.emit(QUALITY_EVENT, { version: 1, kind: "agent_outcome", outcome: "pass" });
    pi.api.events.emit(QUALITY_EVENT, { version: 1, kind: "agent_outcome", outcome: "pass", secret });
    pi.api.events.emit(QUALITY_EVENT, { get version() { throw new Error(secret); } });
    result = (await pi.tools.get("telemetry_status").execute()).details;
    assert.equal(result.quality.state, "observed_not_verified");
    assert.equal(result.quality.source_known_case.retrieval.missing_evidence, 1);
    assert.equal(result.quality.self_report.agent_outcome.pass, 1);
    assert.equal(result.quality.rejected, 2);
    let commandText = "";
    await pi.commands.get("context-telemetry").handler("", { ui: { notify(text: string) { commandText = text; } } });
    assert.equal(JSON.parse(commandText).runtime.tool.succeeded, 1);
    await pi.emit("session_shutdown");
    assert.equal(pi.listeners.size, 0);
    result = (await pi.tools.get("telemetry_status").execute()).details;
    assert.equal(result.active, false);
    assert.equal(result.storage.state, "closed");
    const directory = join(home, ".local", "state", "pi-context-kit", "telemetry", "v1");
    const names = await readdir(directory);
    assert.ok(names.length > 0);
    const lines = (await Promise.all(names.map(name => readFile(join(directory, name), "utf8")))).join("");
    assert.ok(!lines.includes(secret));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!lines.includes(home));
    assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);
    for (const line of lines.trim().split("\n")) {
      const record = JSON.parse(line);
      assert.match(record.run, /^[0-9a-f-]{36}$/);
      assert.ok(["runtime", "quality"].includes(record.channel));
      assert.ok(Buffer.byteLength(line) < STORAGE_LIMITS.recordBytes);
    }
  } finally {
    await pi.emit("session_shutdown");
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("bounded correlations, strict quality, concurrent global cap, queue pressure and storage failure", async () => {
  let now = 0;
  const records: unknown[] = [];
  const meter = new Meter(record => records.push(record), () => now);
  for (let index = 0; index < MAX_CORRELATIONS + 5; index++) meter.begin("tool", String(index));
  assert.equal(meter.runtime.correlationDrops, 5);
  now = 25;
  meter.finish("tool", "0", "succeeded");
  assert.equal(meter.runtime.tool.totalMs, 25);
  meter.boundary();
  assert.equal(meter.runtime.tool.abandoned, MAX_CORRELATIONS - 1);
  meter.usage("assistant", { ...usage, input: Infinity });
  assert.equal(meter.runtime.usage.assistant.samples, 0);
  assert.equal(meter.runtime.usage.assistant.missingOrInvalid, 1);
  assert.equal(parseQuality({ version: 1, kind: "retrieval", outcome: "pass", basis: null }), undefined);
  assert.equal(parseQuality({ version: 1, kind: "retrieval", outcome: "pass", expectedEvidence: -1 }), undefined);
  assert.equal(parseQuality({ version: 1, kind: "retrieval", outcome: "pass", [Symbol("extra")]: 1 }), undefined);
  assert.equal(parseQuality(Object.assign(Object.create({}), { version: 1, kind: "retrieval", outcome: "pass" })), undefined);

  const root = await mkdtemp(join(tmpdir(), "context-telemetry-storage-"));
  const directory = join(root, "telemetry", "v1");
  const left = new LocalWriter({ directory, slots: 2, slotBytes: 2048 });
  const right = new LocalWriter({ directory, slots: 2, slotBytes: 2048 });
  left.enqueue({ version: 1, channel: "runtime", test: "left" });
  right.enqueue({ version: 1, channel: "runtime", test: "right" });
  await Promise.all([left.stop(), right.stop()]);
  assert.equal(left.snapshot().written, 1);
  assert.equal(right.snapshot().written, 1);
  assert.equal((await readdir(directory)).length, 2);
  const capped = new LocalWriter({ directory, slots: 2, slotBytes: 2048 });
  for (let index = 0; index < STORAGE_LIMITS.queueRecords + 5; index++) capped.enqueue({ version: 1, count: index });
  assert.equal(capped.snapshot().queued, STORAGE_LIMITS.queueRecords);
  assert.equal(capped.snapshot().dropped, 5);
  await capped.stop();
  assert.equal(capped.snapshot().state, "full");
  assert.equal(capped.snapshot().error, "global_cap");
  assert.equal(capped.snapshot().dropped, STORAGE_LIMITS.queueRecords + 5);
  for (const name of await readdir(directory)) assert.ok((await stat(join(directory, name))).size <= 2048);
  const blocker = join(root, "blocked");
  await writeFile(blocker, "not a directory", { mode: 0o600 });
  const failed = new LocalWriter({ directory: join(blocker, "telemetry", "v1") });
  assert.doesNotThrow(() => failed.enqueue({ version: 1, count: 1 }));
  await failed.stop();
  assert.equal(failed.snapshot().state, "failed");
  assert.equal(failed.snapshot().error, "storage_unavailable");
  assert.ok(!JSON.stringify(failed.snapshot()).includes(root));
  await mkdir(join(root, "unsafe"), { mode: 0o755 });
  const unsafe = new LocalWriter({ directory: join(root, "unsafe", "telemetry", "v1") });
  unsafe.enqueue({ version: 1 });
  await unsafe.stop();
  assert.equal(unsafe.snapshot().error, "unsafe_directory");
});
