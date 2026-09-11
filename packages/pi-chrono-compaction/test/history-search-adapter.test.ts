import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSessionRollout, writeSessionRollout } from "../src/session-rollout.js";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HistorySearchAdapter } from "../src/history-search-adapter.js";
import { CAPSULE_REDUCER_PIPELINE_VERSION, type CapsuleCatalogView, type DerivedStoreIdentity } from "../src/capsule-contract.js";
import { runCatalogWorker } from "../src/catalog-worker-client.js";
import { runCapsuleWorker } from "../src/capsule-worker-client.js";
import { line } from "./capsule-storage-fixture.js";

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const uuid = (s: string): string => { const h = hash(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
async function ready(adapter: HistorySearchAdapter, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = adapter.scheduler.status();
    if (status.state === "ready") return;
    assert.notEqual(status.state, "error", JSON.stringify(status));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`lifecycle did not settle: ${JSON.stringify(adapter.scheduler.status())}`);
}

/** Each cold layer has the existing finite 10-second settlement bound. A
 * completed earlier layer is not charged against a later layer's startup.
 * Never reset on repeated running/lagging ticks. Five stages cap total waiting.
 */
async function readyLayers(adapter: HistorySearchAdapter): Promise<void> {
  const stages = ["catalog", "capsules", "index", "memory", "rollup"] as const;
  const started = Date.now();
  const observed: { stage: string; elapsedMs: number }[] = [];
  for (const stage of stages) {
    const deadline = Date.now() + 10_000;
    const layerState = (): unknown => {
      const value = adapter.status()[stage];
      return typeof value === "object" && value !== null ? (value as { state?: string }).state : value;
    };
    // Prefix restoration may make a layer ready before append catch-up finishes.
    // The final stage must also settle the whole scheduled target, within this
    // same deadline, rather than accepting an intermediate cached publication.
    while (layerState() !== "ready" || stage === "rollup" && adapter.scheduler.status().state !== "ready") {
      const status = adapter.scheduler.status();
      assert.notEqual(status.state, "error", JSON.stringify({ stage, status, observed }));
      assert.notEqual(status[stage], "error", JSON.stringify({ stage, status, observed }));
      assert.ok(Date.now() < deadline, JSON.stringify({ code: "layer-did-not-settle", stage, status, observed }));
      // drain is only one active job, not full readiness. Race it with a short
      // poll so the finite stage deadline still applies to a stuck worker.
      await Promise.race([adapter.scheduler.drain(), new Promise(resolve => setTimeout(resolve, 20))]);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    observed.push({ stage, elapsedMs: Date.now() - started });
  }
  assert.equal(adapter.scheduler.status().state, "ready");
}

test("real lifecycle search, decoded block and exact raw range survive append with branch isolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-adapter-"));
  const sourcePath = join(directory, "source.jsonl");
  const schedulerDirectory = join(directory, "scheduler");
  mkdirSync(schedulerDirectory, { mode: 0o700 });
  const generatedStatus = JSON.stringify({ type: "message", id: "status", parentId: null, message: { role: "toolResult", toolName: "history_status", content: [{ type: "text", text: "generatedstatusneedle" }] } }) + "\n";
  const first = line("a", "status", "amber compass source one. Do not edit /project/amber.ts.");
  const second = line("b", "a", "amber compass source two");
  writeFileSync(sourcePath, generatedStatus + first + second, { mode: 0o600 });
  let adapter = new HistorySearchAdapter({ schedulerDirectory, slots: 1 });
  const target = { sourcePath, schedulerDirectory, catalogDirectory: join(directory, "catalog"), sessionKey: hash("adapter-session"), shardKey: hash("adapter-shard"), leafId: "b" };
  // The public scheduler target deliberately contains no worker configuration.
  const schedule = (leafId: string) => adapter.schedule({ sourcePath: target.sourcePath, catalogDirectory: target.catalogDirectory, sessionKey: target.sessionKey, shardKey: target.shardKey, leafId });
  try {
    schedule("b"); await readyLayers(adapter);
    assert.equal(adapter.status().enabled, true);
    assert.equal(adapter.status().lag, 0);
    assert.equal(adapter.status().requestedCut, adapter.status().indexedCut);
    const memoryStatus = adapter.status().memory as Record<string, unknown>;
    assert.equal(memoryStatus.state, "ready", JSON.stringify(memoryStatus));
    assert.equal(memoryStatus.knownThroughCut, adapter.status().indexedCut);
    const memory = await adapter.recallState("amber", "state");
    assert.equal(memory.details.status, "ok", JSON.stringify(memory.details));
    const stateItems = memory.details.items as { kind: string; evidence: { recovery: string } }[];
    assert.ok(stateItems.some(item => item.kind === "restriction"), JSON.stringify(memory.details));
    const memoryHandle = stateItems[0]!.evidence.recovery;
    assert.ok(memoryHandle);
    assert.match(String((await adapter.recall(memoryHandle)).details.text), /Do not edit \/project\/amber.ts/);
    const episode = await adapter.recallState("amber", "episode");
    assert.equal(episode.details.status, "ok", JSON.stringify(episode.details));
    assert.ok((episode.details.items as unknown[]).length > 0);
    const resource = await adapter.recallState("amber", "resource");
    assert.equal(resource.details.status, "ok", JSON.stringify(resource.details));
    assert.ok((resource.details.items as unknown[]).length > 0);
    const stableStatus = adapter.status();
    assert.deepEqual(adapter.status(), stableStatus); // read-only cached surface
    const excludedStatus = await adapter.search({ query: "generatedstatusneedle" });
    assert.equal(excludedStatus.details.status, "ok");
    for (const hit of excludedStatus.details.hits as { independentEvidence: boolean; provenance: string }[]) {
      assert.equal(hit.independentEvidence, false, "history_status output is not independent source evidence");
      assert.equal(hit.provenance, "generated");
    }
    const budgeted = await adapter.search({ query: "source", limit: 8 });
    assert.equal(budgeted.details.status, "ok");
    assert.equal((budgeted.details.hits as unknown[]).length, 1);
    assert.ok(budgeted.details.nextCursor, "budgeted page must keep continuation");
    const found = await adapter.search({ query: "source two", mode: "exact", limit: 1 });
    assert.equal(found.details.status, "ok", JSON.stringify(found.details));
    const handle = (found.details.hits as { handle: string }[])[0]?.handle;
    assert.ok(handle);
    const recalled = await adapter.recall(handle);
    assert.equal(recalled.details.status, "ok", JSON.stringify(recalled.details));
    assert.match(String(recalled.details.text), /amber compass source two/);
    const block = await adapter.getBlock("b", 0);
    assert.equal(block.details.status, "ok", JSON.stringify(block.details));
    assert.equal(block.details.text, "amber compass source two");
    const raw = await adapter.getRaw("b", {});
    assert.equal(raw.details.status, "ok", JSON.stringify(raw.details));
    assert.equal(raw.details.text, second);
    const range = await adapter.range("a", "b", 1);
    assert.equal(range.details.status, "ok", JSON.stringify(range.details));
    assert.equal(range.details.complete, false);
    const cursor = String(range.details.nextCursor);
    appendFileSync(sourcePath, line("c", "b", "later source"));
    schedule("c");
    const pendingDeadline = Date.now() + 10_000;
    while (adapter.status().catalog !== "ready" && Date.now() < pendingDeadline) await new Promise(r => setTimeout(r, 10));
    const catchingUp = adapter.status();
    assert.equal(catchingUp.servingLastReady, true);
    assert.ok(Number(catchingUp.lag) > 0, JSON.stringify(catchingUp));
    assert.equal((await adapter.recall(handle)).details.status, "ok", "validated old view remains available during append catch-up");
    await readyLayers(adapter);
    assert.equal(adapter.status().lag, 0);
    const continued = await adapter.range("a", "b", 1, cursor);
    assert.equal(continued.details.status, "ok", JSON.stringify(continued.details));
    assert.equal(continued.details.complete, true);
    const entries = continued.details.entries as { data: string }[];
    assert.equal(Buffer.from(entries[0]!.data, "base64").toString("utf8"), second);
    const beforeRestart = (adapter.status().memory as Record<string, unknown>).stateGeneration;
    adapter.dispose(); await adapter.scheduler.drain();
    adapter = new HistorySearchAdapter({ schedulerDirectory, slots: 1 });
    schedule("c"); await readyLayers(adapter);
    assert.equal((adapter.status().memory as Record<string, unknown>).stateGeneration, beforeRestart, "restart must not reprocess completed deltas");
    assert.equal((await adapter.recall(memoryHandle)).details.status, "ok");
    appendFileSync(sourcePath, line("fork", "a", "sibling source"));
    schedule("fork");
    assert.equal(adapter.status().servingLastReady, false, "unvalidated branch cannot expose old view");
    await readyLayers(adapter);
    const refused = await adapter.recall(handle);
    assert.equal(refused.details.status, "unavailable");
    const sibling = await adapter.getRaw("b", {});
    assert.equal(sibling.details.status, "unavailable");
  } finally {
    adapter.dispose(); await adapter.scheduler.drain();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollup lifecycle offers bounded top-down exact recall across append restart and branch isolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-adapter-rollup-")), sourcePath = join(directory, "source.jsonl"), schedulerDirectory = join(directory, "scheduler");
  mkdirSync(schedulerDirectory, { mode: 0o700 });
  const first = "Do not edit /project/amber.ts. Keep the unresolved amber task open.";
  writeFileSync(sourcePath, line("a", null, first) + line("b", "a", "Inspection is reported, not verification.", "assistant")
    + line("c", "b", "Next request; earlier obligation remains."), { mode: 0o600 });
  let adapter = new HistorySearchAdapter({ schedulerDirectory, slots: 1 });
  const schedule = (leafId: string) => adapter.schedule({ sourcePath, catalogDirectory: join(directory, "catalog"), sessionKey: hash("rollup-session"), shardKey: hash("rollup-shard"), leafId });
  try {
    schedule("c"); await readyLayers(adapter);
    assert.equal((adapter.status().rollup as Record<string, unknown>).state, "ready", JSON.stringify(adapter.status()));
    const root = await adapter.recallRollup("");
    assert.equal(root.details.status, "ok", JSON.stringify(root.details));
    assert.equal(root.details.partial, true);
    const expand = (root.details.items as { expand: string }[])[0]!.expand;
    assert.ok(expand);
    let page = await adapter.recallRollup(expand);
    for (let depth = 0; depth < 4 && !(page.details.items as { recovery?: string }[])[0]?.recovery; depth++) {
      assert.equal(page.details.status, "ok", JSON.stringify(page.details));
      page = await adapter.recallRollup((page.details.items as { expand: string }[])[0]!.expand);
    }
    assert.equal(page.details.status, "ok", JSON.stringify(page.details));
    const exact = (page.details.items as { recovery: string }[])[0]!.recovery;
    assert.ok(exact, JSON.stringify(page.details));
    assert.equal((await adapter.recall(exact)).details.text, first);
    const pinned = page.details;
    const before = adapter.status();
    assert.deepEqual(adapter.status(), before, "status is a cached read, not ingestion");
    appendFileSync(sourcePath, line("d", "c", "Later independent request."));
    schedule("d"); await readyLayers(adapter);
    const old = await adapter.recallRollup(expand);
    assert.equal(old.details.knownThroughCut, root.details.knownThroughCut);
    const generation = (adapter.status().rollup as Record<string, unknown>).rollupGeneration;
    adapter.dispose(); await adapter.scheduler.drain();
    adapter = new HistorySearchAdapter({ schedulerDirectory, slots: 1 });
    schedule("d"); await readyLayers(adapter);
    assert.equal((adapter.status().rollup as Record<string, unknown>).rollupGeneration, generation, "resume must reuse its completed rollup publication");
    assert.equal((await adapter.recall(exact)).details.text, first);
    assert.ok(Number(pinned.knownThroughCut) <= Number(adapter.status().indexedCut));
    appendFileSync(sourcePath, line("fork", "a", "Sibling request."));
    schedule("fork"); await readyLayers(adapter);
    assert.equal((await adapter.recallRollup(expand)).details.status, "unavailable");
  } finally { adapter.dispose(); await adapter.scheduler.drain(); rmSync(directory, { recursive: true, force: true }); }
});

test("bounded initial catch-up serves a searchable committed prefix before the full requested view", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-adapter-prefix-"));
  const sourcePath = join(directory, "source.jsonl");
  const schedulerDirectory = join(directory, "scheduler");
  mkdirSync(schedulerDirectory, { mode: 0o700 });
  let content = "", parent: string | null = null;
  for (let index = 1; index <= 40; index += 1) {
    const id = `event-${index}`;
    content += line(id, parent, index === 1 ? "early searchable prefix needle" : index === 40 ? "eventual tail needle" : `ordinary history ${index}`);
    parent = id;
  }
  writeFileSync(sourcePath, content, { mode: 0o600 });
  const catalogDirectory = join(directory, "catalog"), sessionKey = hash("prefix-session"), shardKey = hash("prefix-shard");
  const workerOptions = { schedulerDirectory, slots: 1 };
  // Model an installed 2.0.8 head under the old configuration identity. The
  // new prefix configuration must preserve it and use a separate route.
  const ingested = await runCatalogWorker({ v: 1, op: "ingestStep", sourcePath, catalogDirectory, sessionKey, shardKey, branchKey: "pi-session", shardOrdinal: 0 }, workerOptions);
  if (!ingested.ok) assert.fail(JSON.stringify(ingested));
  assert.equal(ingested.result.caughtUp, true);
  const oldPin = await runCatalogWorker({ v: 1, op: "pin", catalogDirectory, sessionKey, branchKey: "pi-session", leaf: { shardKey, eventId: "event-40" } }, workerOptions);
  if (!oldPin.ok) assert.fail(JSON.stringify(oldPin));
  const oldView = oldPin.result.view as CapsuleCatalogView;
  const oldConfig = hash("chrono-m06-capsule-default-v1");
  const oldIdentity: DerivedStoreIdentity = { storeKey: uuid(`${oldView.storeKey}:${oldView.generation}:${CAPSULE_REDUCER_PIPELINE_VERSION}:${oldConfig}`), sessionKey,
    catalogStoreKey: oldView.storeKey, catalogGeneration: oldView.generation, derivedSchemaVersion: 2, capsuleSchemaVersion: 1, chunkSchemaVersion: 1,
    reducerSetVersion: CAPSULE_REDUCER_PIPELINE_VERSION, configHash: oldConfig };
  const oldDirectory = join(catalogDirectory, `capsules-${oldIdentity.storeKey}`);
  const oldHead = await runCapsuleWorker({ v: 1, op: "derivePage", derivedDirectory: oldDirectory, catalogDirectory, identity: oldIdentity, view: oldView }, workerOptions);
  if (!oldHead.ok) assert.fail(JSON.stringify(oldHead));
  assert.equal(oldHead.result.complete, false, "fixture must leave the old whole-view head in progress");

  let adapter = new HistorySearchAdapter(workerOptions);
  try {
    adapter.schedule({ sourcePath, catalogDirectory, sessionKey, shardKey, leafId: "event-40" });
    const deadline = Date.now() + 60_000;
    let prefixStatus: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const status = adapter.status();
      if (status.servingLastReady === true && Number(status.indexedCut) < Number(status.requestedCut)) { prefixStatus = status; break; }
      assert.notEqual(adapter.scheduler.status().state, "error", JSON.stringify(status));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(prefixStatus, `no committed prefix became available: ${JSON.stringify(adapter.status())}`);
    assert.equal(prefixStatus.requestedCut, 40);
    assert.equal(prefixStatus.indexedCut, 16);
    assert.equal(prefixStatus.lag, 24);
    assert.equal(prefixStatus.index, "pending", "the whole requested view is not falsely complete");
    assert.equal(oldIdentity.configHash, hash("chrono-m06-capsule-default-v1"));
    const early = await adapter.search({ query: "early searchable prefix needle", mode: "exact", limit: 1 });
    assert.equal(early.details.status, "ok", JSON.stringify(early.details));
    const earlyHandle = (early.details.hits as { handle: string }[])[0]?.handle;
    assert.ok(earlyHandle);
    assert.match(String((await adapter.recall(earlyHandle)).details.text), /early searchable prefix needle/);
    assert.equal((await adapter.getBlock("event-1", 0)).details.text, "early searchable prefix needle");
    const incompleteDeadline = Date.now() + 60_000;
    while (!(adapter.status().index === "lagging" && adapter.status().indexedCut === 16) && Date.now() < incompleteDeadline) {
      assert.notEqual(adapter.scheduler.status().state, "error", JSON.stringify(adapter.status()));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(adapter.status().index, "lagging", `no incomplete cut-40 index head: ${JSON.stringify(adapter.status())}`);
    adapter.dispose(); await adapter.scheduler.drain();
    adapter = new HistorySearchAdapter(workerOptions);
    adapter.schedule({ sourcePath, catalogDirectory, sessionKey, shardKey, leafId: "event-40" });
    const secondDeadline = Date.now() + 60_000;
    while (Number(adapter.status().indexedCut) < 40 && Date.now() < secondDeadline) {
      assert.notEqual(adapter.scheduler.status().state, "error", JSON.stringify(adapter.status()));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(adapter.status().indexedCut, 40, `reload did not resume the incomplete prefix: ${JSON.stringify(adapter.status())}`);
    adapter.dispose(); await adapter.scheduler.drain();
    adapter = new HistorySearchAdapter(workerOptions);
    adapter.schedule({ sourcePath, catalogDirectory, sessionKey, shardKey, leafId: "event-40" });
    const reloadDeadline = Date.now() + 60_000;
    while (adapter.status().servingLastReady !== true && Date.now() < reloadDeadline) {
      assert.notEqual(adapter.scheduler.status().state, "error", JSON.stringify(adapter.status()));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(adapter.status().indexedCut, 40, `reload did not restore the complete prefix: ${JSON.stringify(adapter.status())}`);
    assert.equal(adapter.status().requestedCut, 40);
    await ready(adapter, 60_000);
    assert.equal(adapter.status().requestedCut, 40);
    assert.equal(adapter.status().indexedCut, 40);
    assert.equal(adapter.status().lag, 0);
    const tail = await adapter.search({ query: "eventual tail needle", mode: "exact", limit: 1 });
    assert.equal((tail.details.hits as unknown[]).length, 1, JSON.stringify(tail.details));
  } finally {
    adapter.dispose(); await adapter.scheduler.drain();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal fresh Pi loading resumes persisted rollout without activation commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrono-auto-resume-"));
  const agent = join(root, "agent"), sessions = join(root, "sessions"), scheduler = join(root, "scheduler");
  for (const directory of [agent, sessions, scheduler]) mkdirSync(directory, { mode: 0o700 });
  const sessionId = randomUUID(), sourcePath = join(sessions, "resume.jsonl"), phrase = "amber automatic resume evidence";
  writeFileSync(sourcePath, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }) + "\n" + line("a", null, phrase), { mode: 0o600 });
  const rolloutDirectory = join(agent, "chrono-session-rollouts");
  await writeSessionRollout(rolloutDirectory, { sessionId, sourcePath }, true);
  assert.equal(await readSessionRollout(rolloutDirectory, { sessionId: randomUUID(), sourcePath }), undefined);
  writeFileSync(join(agent, "chrono.json"), "{}\n", { mode: 0o600 });
  const bridge = join(root, "bridge.mjs");
  writeFileSync(bridge, `import chrono from ${JSON.stringify(new URL("../../dist/src/pi-extension.js", import.meta.url).href)};
export default function(pi) {
 const tools=new Map();
 chrono(new Proxy(pi,{get(o,k){if(k==='registerTool')return t=>{tools.set(t.name,t);return o.registerTool(t)};return Reflect.get(o,k)}}),{schedulerDirectory:${JSON.stringify(scheduler)}});
 pi.registerCommand('resume-probe',{handler:async(_args,ctx)=>{
  const call=(name,params={})=>tools.get(name).execute('resume-probe',params,undefined,undefined,ctx);
  const deadline=Date.now()+20000;let status;
  do {status=(await call('history_status')).details;if(status.index==='ready')break;if(Date.now()>=deadline)throw Error('resume-not-ready:'+JSON.stringify(status));await new Promise(r=>setTimeout(r,30));}while(true);
  const found=(await call('history_search',{query:${JSON.stringify(phrase)},mode:'exact',limit:1,tokenBudget:2000})).details;
  if(found.status!=='ok'||!found.hits?.[0])throw Error('resume-search-failed');
  const recall=(await call('history_recall',{query:found.hits[0].handle,tokenBudget:2000})).details;
  const exact=(await call('history_get',{entryId:'a',blockIndex:0})).details;
  ctx.ui.notify('RESUME_RESULT:'+JSON.stringify({enabled:status.enabled,persisted:status.rollout.persisted,search:true,recall:recall.text===${JSON.stringify(phrase)},exact:exact.text===${JSON.stringify(phrase)}}),'info');
 }});
 pi.registerCommand('resume-quit',{handler:async(_args,ctx)=>ctx.shutdown()});
}
`, { mode: 0o600 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [bridge] }), { mode: 0o600 });
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  async function fresh(): Promise<void> {
    const base = Object.fromEntries(["PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", "--session", sourcePath, "--session-dir", sessions,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], { cwd: root, env: { ...base, HOME: agent, PI_CODING_AGENT_DIR: agent,
        PI_CHRONO_CONFIG_PATH: join(agent, "chrono.json"), PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false", PI_CHRONO_CATALOG_SHADOW: "false", PI_CHRONO_ROLLUP_SHADOW: "false", PI_CHRONO_VALUE_WORKER_MODE: "off" }, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", sequence = 0, receipt: unknown, diagnostics = "";
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    child.stderr.on("data", bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-4096); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      buffer += text;
      if (buffer.length > 1024 * 1024) { child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event: any; try { event = JSON.parse(raw); } catch { continue; }
        if (event.type === "extension_ui_request" && event.method === "notify" && event.message.startsWith("RESUME_RESULT:")) receipt = JSON.parse(event.message.slice(14));
        if (event.type === "response" && pending.has(event.id)) {
          const p = pending.get(event.id)!; pending.delete(event.id); clearTimeout(p.timer);
          if (event.success) p.resolve(event.data); else p.reject(new Error(String(event.error)));
        }
      }
    });
    const send = (type: string, extra = {}) => new Promise<unknown>((resolve, reject) => {
      const id = String(++sequence), timer = setTimeout(() => { pending.delete(id); reject(new Error(`resume-rpc-timeout:${diagnostics}`)); }, 25_000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
    try {
      await send("get_commands");
      await send("prompt", { message: "/resume-probe" });
      assert.deepEqual(receipt, { enabled: true, persisted: true, search: true, recall: true, exact: true });
      await send("prompt", { message: "/resume-quit" });
      assert.equal(await closed, 0);
    } finally {
      for (const p of pending.values()) clearTimeout(p.timer);
      if (child.exitCode === null) { child.kill("SIGTERM"); await closed; }
    }
  }
  try {
    await fresh();
    await fresh();
    await writeSessionRollout(rolloutDirectory, { sessionId, sourcePath }, false);
    assert.equal(await readSessionRollout(rolloutDirectory, { sessionId, sourcePath }), false, "explicit disable persists");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
