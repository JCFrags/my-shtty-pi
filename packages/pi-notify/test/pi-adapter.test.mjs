import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NotifyClient } from "../src/client.ts";
import { startServer } from "../src/server/index.ts";
import piNotify from "../src/pi/extension.ts";
import { DeliveryJournal, EXTERNAL_EVENT } from "../src/pi/delivery.ts";
import { BINDING_ENTRY, IdentityRegistry, newBinding, readChronoIdentity } from "../src/pi/identity.ts";
import { canonical, digest, writePrivate } from "../src/pi/files.ts";
import { subscribeNotifications } from "../src/pi/bus.ts";

const note = { purpose: "Synthetic adapter check", owner: "fixture", references: [], repairContext: "Disposable test state only." };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
const assistant = () => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: [{ type: "text", text: "Synthetic task observed. Completion must be explicit." }], usage, stopReason: "stop", timestamp: Date.now() });
async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25); }
  assert.fail(`Timed out: ${label}`);
}
function task(destinationId, trigger) {
  return { name: "Inspect synthetic issue", purpose: "Exercise exact targeted delivery", targetId: destinationId, trigger,
    onWake: "Inspect this synthetic event only. Do not modify files or call external services. Report an explicit result.",
    context: ["This is disposable test data, not a real issue."], authority: { allowedActions: ["Read this event"], limits: ["No real system changes"] },
    completionCriteria: ["Synthetic issue inspected"], resultDestination: { kind: "delivery-result" },
    validity: { expiresAt: new Date(Date.now() + 60000).toISOString(), stopConditions: ["Stop if cancelled or ownership is lost"] } };
}

test("real Pi SDK: exact binding, crash between receipt and wake, outcome, and model-free consumer", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-notify-sdk-"));
  const oldConfig = process.env.PI_NOTIFY_PI_CONFIG;
  const oldWake = DeliveryJournal.prototype.wake;
  let service, first, second, forked, busSubscription;
  try {
    const token = randomBytes(32).toString("base64url"), tokenFile = join(root, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    service = await startServer({ schemaVersion: 1, serviceId: "fixture", database: join(root, "service.sqlite"), port: 0,
      principals: [{ id: "fixture", tokenFile, roles: ["admin"] }], note });
    const api = new NotifyClient({ baseUrl: service.baseUrl, token });
    const stateDirectory = join(root, "adapter");
    process.env.PI_NOTIFY_PI_CONFIG = join(root, "pi-notify.json");
    writeFileSync(process.env.PI_NOTIFY_PI_CONFIG, JSON.stringify({ schemaVersion: 1, baseUrl: service.baseUrl, tokenFile, stateDirectory, chronoRoot: join(root, "chrono") }), { mode: 0o600 });
    const agentDir = join(root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
    let modelCalls = 0;
    async function open(sm, reason = "startup") {
      const eventBus = createEventBus();
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "never" });
      const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, eventBus,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [piNotify] });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await createAgentSession({ cwd: root, agentDir, sessionManager: sm, resourceLoader: loader, settingsManager: settings,
        modelRuntime: runtime, model, noTools: "builtin", sessionStartEvent: { type: "session_start", reason } });
      session.agent.getApiKey = () => undefined;
      session.agent.streamFunction = () => {
        modelCalls++;
        const message = assistant();
        return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
      };
      const errors = [];
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
      const call = async (name, args) => {
        const tool = session.agent.state.tools.find(item => item.name === name);
        assert.ok(tool, name);
        return (await tool.execute(randomUUID(), args, new AbortController().signal)).details;
      };
      return { session, sm, eventBus, errors, call, close: async () => {
        await session.waitForIdle();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      } };
    }
    await assert.rejects(subscribeNotifications(createEventBus(), { consumerId: "absent", destinationId: "absent", handle() {} }), /notify_adapter_unavailable/);
    // Exercise the real on-disk extension entrypoint with factory-only loading.
    const probe = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/pi-notify.ts", import.meta.url))] });
    await probe.reload();
    assert.deepEqual(probe.getExtensions().errors, []);
    assert.equal(existsSync(stateDirectory), false, "factory must not create state or open a receiver");
    assert.equal((await api.listDestinations()).items.length, 0);

    const sm = SessionManager.create(root, join(root, "sessions")); sm.appendMessage(assistant());
    first = await open(sm);
    assert.equal((await first.call("notify", { action: "status" })).state, "unregistered");
    await first.session.prompt("/notify bind fixture-agent");
    assert.deepEqual(first.errors, []);
    assert.equal((await first.call("notify", { action: "status" })).state, "live");
    await assert.rejects(api.bind("fixture-agent", { schemaVersion: 1, ownerId: "competing-owner" }), error => error.code === "destination_busy");
    const trigger = { kind: "event", source: "fixture", types: ["issue"] };
    await assert.rejects(first.call("notify", { action: "create", job: { schemaVersion: 1, id: "incomplete", destinationId: "fixture-agent", trigger, note } }), /notify_full_task_definition_required/);
    const accepted = await first.call("notify", { action: "create", job: { schemaVersion: 1, id: "fixture-job", destinationId: "fixture-agent", trigger, note,
      piTask: task("fixture-agent", trigger), retry: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 100 } } });
    assert.equal(accepted.accepted, true); assert.match(accepted.guidance, /Do not poll, sleep, or wait/);
    // Fault injection stops only the wake step. Source insertion and service ack
    // run through the real SDK and HTTP service before the synthetic restart.
    DeliveryJournal.prototype.wake = function () {};
    const event = await api.publishEvent({ schemaVersion: 1, id: "fixture-event", source: "fixture", type: "issue", occurredAt: new Date().toISOString(), data: { issue: "Synthetic issue" } });
    const deliveryId = event.deliveryIds[0]; assert.ok(deliveryId);
    await until(async () => (await api.getDelivery(deliveryId)).state === "delivered", "durable receipt");
    assert.equal(modelCalls, 0);
    assert.equal(sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === EXTERNAL_EVENT).length, 1);
    assert.match(readFileSync(sm.getSessionFile(), "utf8"), /pi-notify-external-event-v1/);
    await first.close(); first = undefined;
    DeliveryJournal.prototype.wake = oldWake;
    second = await open(SessionManager.open(sm.getSessionFile()), "resume");
    await until(() => modelCalls === 1, "replayed wake after durable receipt");
    await second.session.waitForIdle();
    await delay(100);
    assert.equal(modelCalls, 1, "agent_settled must not repeat wake indefinitely");
    assert.equal((await api.getDelivery(deliveryId)).state, "delivered", "agent_end is not completion");
    assert.equal(second.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === EXTERNAL_EVENT).length, 1, "reuse the exact durable insertion");
    const completed = await second.call("notify_complete", { deliveryId, status: "completed", result: { summary: "Synthetic issue inspected", evidence: ["SDK received the task"], remaining: [] } });
    assert.equal(completed.completionReported, true);
    assert.equal((await api.getDelivery(deliveryId)).state, "completed");

    // A generic extension gets a pull delivery with no Pi task and no inference.
    await api.createDestination({ schemaVersion: 1, id: "fixture-consumer", kind: "pull", note });
    let consumed = false;
    busSubscription = await subscribeNotifications(second.eventBus, { consumerId: "fixture-extension", destinationId: "fixture-consumer", handle: async delivery => {
      assert.equal(delivery.delivery.piTask, undefined);
      assert.equal("leaseToken" in delivery.delivery, false);
      writePrivate(join(root, "consumer-receipt.json"), delivery.delivery);
      await delivery.acknowledge(); await delivery.complete({ ok: true }); consumed = true;
    } });
    await api.createJob({ schemaVersion: 1, id: "consumer-job", destinationId: "fixture-consumer", trigger: { ...trigger, types: ["widget"] }, note });
    await api.publishEvent({ schemaVersion: 1, id: "consumer-event", source: "fixture", type: "widget", occurredAt: new Date().toISOString(), data: { generic: true } });
    await until(() => consumed, "model-free extension delivery");
    assert.equal(modelCalls, 1);
    await busSubscription.close(); busSubscription = undefined;
    await second.close(); second = undefined;
    // forkFrom preserves source entries. Physical identity still blocks inheritance.
    const fork = SessionManager.forkFrom(sm.getSessionFile(), root, join(root, "forks"));
    forked = await open(fork, "fork");
    assert.equal((await forked.call("notify", { action: "status" })).state, "unregistered");
    assert.deepEqual(forked.errors, []);
  } finally {
    DeliveryJournal.prototype.wake = oldWake;
    await busSubscription?.close(); await first?.close(); await second?.close(); await forked?.close(); await service?.close();
    if (oldConfig === undefined) delete process.env.PI_NOTIFY_PI_CONFIG; else process.env.PI_NOTIFY_PI_CONFIG = oldConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chrono v1 identity accepts forward rollover but refuses copied or forked targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-notify-lineage-"));
  try {
    const logicalSessionId = randomUUID(), shardId = randomUUID(), nextShardId = randomUUID();
    const directory = join(root, logicalSessionId); mkdirSync(directory, { mode: 0o700 });
    const source = { sessionId: randomUUID(), sessionFile: join(root, "source.jsonl"), leafId: "binding", entries: [] };
    const adoption = { type: "custom", id: "adoption", customType: "chrono-logical-adoption", data: { schemaVersion: 1, logicalSessionId, branchId: "main", shardId } };
    source.entries = [adoption];
    const now = new Date().toISOString();
    let manifest = { schemaVersion: 1, revision: 1, logicalSessionId, ownerKey: "a".repeat(64), createdAt: now,
      branches: [{ branchId: "main", shardIds: [shardId], activeShardId: shardId, createdAt: now }],
      shards: [{ shardId, branchId: "main", ordinal: 0, piSessionId: source.sessionId, sourcePath: source.sessionFile, state: "active", openedAt: now }] };
    const save = () => writePrivate(join(directory, "manifest.json"), { ...manifest, integrityHash: digest("chrono-logical-session-manifest-v1\0" + canonical(manifest)) });
    save();
    const chrono = readChronoIdentity(source, root); assert.equal(chrono.shardId, shardId);
    const registry = new IdentityRegistry(join(root, "bindings"));
    const bindingId = randomUUID();
    source.entries.push({ type: "custom", id: "binding", customType: BINDING_ENTRY, data: { bindingId, destinationId: "fixture-agent" } });
    const binding = newBinding("fixture-agent", source, "binding", bindingId, chrono); registry.save(binding);
    assert.equal(registry.find(source, chrono).destinationId, "fixture-agent");
    assert.throws(() => readChronoIdentity({ ...source, sessionId: randomUUID(), sessionFile: join(root, "copy.jsonl") }, root), /physical_mismatch/);
    const next = { sessionId: randomUUID(), sessionFile: join(root, "next.jsonl"), leafId: "continuation", entries: [
      { type: "custom_message", id: "continuation", customType: "chrono-logical-continuation", content: "Self-contained continuation",
        details: { schemaVersion: 1, operationId: randomUUID(), logicalSessionId, branchId: "main", fromShardId: shardId,
          toShardId: nextShardId, continuationHash: "b".repeat(64), summaryHash: digest("Self-contained continuation") } },
    ] };
    manifest = { ...manifest, revision: 2, branches: [{ ...manifest.branches[0], shardIds: [shardId, nextShardId], activeShardId: nextShardId }],
      shards: [{ ...manifest.shards[0], state: "closed" }, { shardId: nextShardId, branchId: "main", ordinal: 1,
        piSessionId: next.sessionId, sourcePath: next.sessionFile, state: "active", openedAt: now, continuationHash: "b".repeat(64) }] };
    save();
    const nextIdentity = readChronoIdentity(next, root);
    assert.equal(registry.find(next, nextIdentity).destinationId, "fixture-agent");
    assert.equal(registry.find(next, { ...nextIdentity, branchId: "fork" }), undefined);
    writePrivate(join(directory, "manifest.json"), { ...manifest, integrityHash: "0".repeat(64) });
    assert.throws(() => readChronoIdentity(next, root), /manifest_integrity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
