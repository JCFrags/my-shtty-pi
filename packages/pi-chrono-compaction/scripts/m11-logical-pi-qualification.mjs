#!/usr/bin/env node
// @ts-nocheck
// One owner-only, synthetic, no-model qualification of logical rollover through
// the installed Pi RPC runtime. The harness retains every physical source shard.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_PI_VERSION = "0.85.1";
const EXPECTED_PACKAGE_VERSION = "2.0.28";
const MAIN_ROLLOVERS = 10;
const HELP = `Usage:
  node scripts/m11-logical-pi-qualification.mjs plan --runtime-sha <40-hex>
  node scripts/m11-logical-pi-qualification.mjs run --runtime-sha <40-hex> --root <absolute-new-directory> --output <absolute-json>

The run uses the installed pi executable in offline RPC mode. It creates only
owner-controlled synthetic sessions and retains all source shards under --root.`;

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function parseArgs(argv) {
  if (["help", "--help", "-h"].includes(argv[0])) return { mode: "help" };
  const mode = argv[0];
  if (!["plan", "run"].includes(mode)) throw new Error("qualification-mode");
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key.slice(2))) throw new Error("qualification-option");
    values[key.slice(2)] = value;
  }
  if (Object.keys(values).some(key => !["runtime-sha", "root", "output"].includes(key))) throw new Error("qualification-option");
  if (!/^[a-f0-9]{40}$/.test(values["runtime-sha"] ?? "")) throw new Error("qualification-runtime-sha");
  if (mode === "run") {
    for (const key of ["root", "output"]) if (!isAbsolute(values[key] ?? "")) throw new Error(`qualification-${key}`);
    if (resolve(values.output).startsWith(`${resolve(values.root)}/`)) throw new Error("qualification-output-inside-root");
  }
  return { mode, runtimeSha: values["runtime-sha"], root: values.root, output: values.output };
}
function gitHead() { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
function assertRuntimeIdentity(runtimeSha) {
  execFileSync("git", ["merge-base", "--is-ancestor", runtimeSha, "HEAD"]);
  execFileSync("git", ["diff", "--quiet", runtimeSha, "HEAD", "--", "packages/pi-chrono-compaction/package.json",
    "packages/pi-chrono-compaction/package-lock.json", "packages/pi-chrono-compaction/src", "packages/pi-chrono-compaction/dist"]);
}
function installedPiVersion() { return execFileSync("pi", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } }).trim(); }
function line(id, parentId, text) {
  return JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: text, timestamp: Date.now() } }) + "\n";
}
function assistantLine(id, parentId, text) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "assistant",
    content: [{ type: "text", text }], api: "qualification-no-provider", provider: "qualification", model: "synthetic",
    usage, stopReason: "stop", timestamp: Date.now() } }) + "\n";
}
async function fileHash(path) { return sha(await readFile(path)); }
async function safeWrite(path, content) { await writeFile(path, content, { mode: 0o600, flag: "wx" }); await chmod(path, 0o600); }

class RpcClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.sequence = 0;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.stderr = "";
    this.closed = new Promise(resolve => child.once("close", resolve));
    child.stderr.on("data", bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-8192); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", text => this.consume(text));
  }
  consume(text) {
    this.buffer += text;
    if (this.buffer.length > 2 * 1024 * 1024) this.child.kill("SIGKILL");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      let event;
      try { event = JSON.parse(raw); } catch { continue; }
      if (event.type === "extension_ui_request" && event.method === "notify") {
        const message = String(event.message);
        const waiter = this.waiters.find(candidate => candidate.predicate(message));
        if (waiter) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message);
        } else this.notifications.push(message);
      }
      if (event.type === "response" && this.pending.has(event.id)) {
        const pending = this.pending.get(event.id); this.pending.delete(event.id); clearTimeout(pending.timer);
        event.success ? pending.resolve(event.data) : pending.reject(new Error(String(event.error)));
      }
    }
  }
  send(type, extra = {}, timeoutMs = 120_000) {
    return new Promise((resolvePromise, reject) => {
      const id = `q-${++this.sequence}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc-timeout:${type}:${this.stderr}`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
  }
  notify(predicate, timeoutMs = 120_000) {
    const existing = this.notifications.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(this.notifications.splice(existing, 1)[0]);
    return new Promise((resolvePromise, reject) => {
      const waiter = { predicate, resolve: resolvePromise, timer: undefined };
      waiter.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error(`notify-timeout:${this.stderr}`)); }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async stop() {
    try { await this.send("prompt", { message: "/qualification-quit" }, 10_000); } catch {}
    const code = await Promise.race([this.closed, new Promise(resolvePromise => setTimeout(() => resolvePromise("timeout"), 10_000))]);
    if (code === "timeout") { this.child.kill("SIGTERM"); await this.closed; }
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
  }
}

function spawnPi({ root, agent, sessions, sourcePath }) {
  const keep = ["PATH", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  const base = Object.fromEntries(keep.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = spawn("pi", ["--mode", "rpc", "--offline", "--no-builtin-tools", "--session", sourcePath, "--session-dir", sessions,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], {
    cwd: root,
    env: { ...base, HOME: agent, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      PI_CHRONO_CONFIG_PATH: join(agent, "chrono.json"), PI_CHRONO_INCREMENTAL_PRECOMPUTE: "false", PI_CHRONO_CATALOG_SHADOW: "false",
      PI_CHRONO_ROLLUP_SHADOW: "false", PI_CHRONO_VALUE_WORKER_MODE: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new RpcClient(child);
}

async function readManifest(agent, logicalSessionId) {
  return JSON.parse(await readFile(join(agent, "chrono-logical-sessions", logicalSessionId, "manifest.json"), "utf8"));
}
async function sourceSnapshot(manifest) {
  return new Map(await Promise.all(manifest.shards.map(async shard => [shard.shardId, { hash: await fileHash(shard.sourcePath), size: (await stat(shard.sourcePath)).size }])));
}
async function promptCommand(client, message, timeoutMs = 120_000) {
  const before = client.notifications.length;
  await client.send("prompt", { message }, timeoutMs);
  const refused = client.notifications.slice(before).find(value => value.startsWith("Logical session command refused:"));
  assert.equal(refused, undefined, `${message}: ${refused}`);
}
async function seed(client, ordinal, marker) {
  const prefix = `QUALIFICATION_SEED:${ordinal}:`;
  const notice = client.notify(value => value.startsWith(prefix));
  await promptCommand(client, `/qualification-seed ${ordinal} ${marker}`);
  const result = JSON.parse((await notice).slice(prefix.length));
  assert.ok(result.entries <= 6, JSON.stringify(result));
  return result;
}
async function probe(client, marker, expectedRoutes, entryId) {
  const prefix = `QUALIFICATION_PROBE:${marker}:`;
  const notice = client.notify(value => value.startsWith(prefix), 180_000);
  await promptCommand(client, `/qualification-probe ${marker} ${expectedRoutes} ${entryId}`, 180_000);
  const result = JSON.parse((await notice).slice(prefix.length));
  assert.deepEqual({ routes: result.routes, search: result.search, recall: result.recall, exact: result.exact },
    { routes: expectedRoutes, search: true, recall: true, exact: true }, JSON.stringify(result));
  return result;
}

async function run(input) {
  const harnessSha = gitHead();
  assertRuntimeIdentity(input.runtimeSha);
  assert.equal(installedPiVersion(), EXPECTED_PI_VERSION, "installed Pi version mismatch");
  const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.version, EXPECTED_PACKAGE_VERSION, "candidate package version mismatch");
  await stat(join(packageRoot, "dist", "src", "pi-extension.js"));
  await stat(join(packageRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"));

  await mkdir(input.root, { mode: 0o700 }); await chmod(input.root, 0o700);
  const agent = join(input.root, "agent"), sessions = join(input.root, "sessions"), scheduler = join(input.root, "scheduler");
  for (const directory of [agent, sessions, scheduler]) { await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); }
  const initialSessionId = randomUUID(), initialPath = join(sessions, "initial.jsonl");
  const initialMarker = `qualification-shard-0-${sha(input.runtimeSha).slice(0, 12)}`;
  const firstId = "qual-root";
  const header = JSON.stringify({ type: "session", version: 3, id: initialSessionId, timestamp: new Date().toISOString(), cwd: input.root }) + "\n";
  const user = line(firstId, null, `Exact marker ${initialMarker}. Do not delete protected qualification artifact zero. Keep qualification task zero open until exact recovery.`);
  const answer = assistantLine("qual-answer", firstId, "Recorded synthetic qualification state without a provider call.");
  const compaction = JSON.stringify({ type: "compaction", id: "qual-summary", parentId: "qual-answer", timestamp: new Date().toISOString(),
    summary: "Qualification regular summary zero.", firstKeptEntryId: firstId, tokensBefore: 64, details: { piSummary: "Qualification regular summary zero." } }) + "\n";
  const tail = line("qual-tail", "qual-summary", "Continue the bounded qualification scenario.")
    + assistantLine("qual-tail-answer", "qual-tail", "Ready for the next bounded qualification operation.");
  await safeWrite(initialPath, header + user + answer + compaction + tail);

  const bridgePath = join(agent, "qualification-bridge.mjs");
  const chronoUrl = pathToFileURL(join(packageRoot, "dist", "src", "pi-extension.js")).href;
  await safeWrite(bridgePath, `import chrono from ${JSON.stringify(chronoUrl)};
export default function qualificationBridge(pi) {
  const tools = new Map();
  chrono(new Proxy(pi, { get(target, key) { if (key === "registerTool") return tool => { tools.set(tool.name, tool); return target.registerTool(tool); }; return Reflect.get(target, key); } }), { schedulerDirectory: ${JSON.stringify(scheduler)} });
  const call = (name, params, ctx) => tools.get(name).execute("qualification", params, undefined, undefined, ctx);
  const waitReady = async (ctx, expectedRoutes) => {
    const deadline = Date.now() + 150000; let status;
    do { status = (await call("history_status", {}, ctx)).details;
      if (status.catalog === "ready" && status.capsules === "ready" && status.index === "ready" && status.memory?.state === "ready"
        && status.rollup?.state === "ready" && status.logical?.routes === expectedRoutes) return status;
      if (Date.now() >= deadline) throw Error("qualification-index-timeout:" + JSON.stringify(status)); await new Promise(resolve => setTimeout(resolve, 30)); } while (true);
  };
  pi.registerCommand("qualification-seed", { handler: async (args, ctx) => {
    const [ordinalText, marker] = args.trim().split(/\\s+/); const ordinal = Number(ordinalText);
    if (!Number.isSafeInteger(ordinal) || !marker) throw Error("qualification-seed-input");
    const parent = ctx.sessionManager.getLeafId();
    const userId = ctx.sessionManager.appendMessage({ role: "user", content: "Exact marker " + marker + ". Do not delete protected qualification artifact " + ordinal + ". Keep qualification task " + ordinal + " open until exact recovery.", timestamp: Date.now() });
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const answerId = ctx.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recorded synthetic qualification state without a provider call." }],
      api: "qualification-no-provider", provider: "qualification", model: "synthetic", usage, stopReason: "stop", timestamp: Date.now() });
    const summaryId = ctx.sessionManager.appendCompaction("Qualification regular summary " + ordinal + ".", userId, 64, { piSummary: "Qualification regular summary " + ordinal + ".", qualificationParent: parent, answerId });
    ctx.sessionManager.appendMessage({ role: "user", content: "Continue the bounded qualification scenario.", timestamp: Date.now() });
    ctx.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready for the next bounded qualification operation." }],
      api: "qualification-no-provider", provider: "qualification", model: "synthetic", usage, stopReason: "stop", timestamp: Date.now() });
    ctx.ui.notify("QUALIFICATION_SEED:" + ordinal + ":" + JSON.stringify({ entries: ctx.sessionManager.getEntries().length, entryId: userId, summaryId }), "info");
  }});
  pi.registerCommand("qualification-probe", { handler: async (args, ctx) => {
    const [marker, routesText, entryId] = args.trim().split(/\\s+/); const routes = Number(routesText); let status;
    try { status = await waitReady(ctx, routes); }
    catch (error) { ctx.ui.notify("QUALIFICATION_PROBE:" + marker + ":" + JSON.stringify({ error: String(error?.message ?? error) }), "warning"); return; }
    let cursor, found, shardId;
    for (let page = 0; page < 4 && !found; page++) {
      const search = (await call("history_search", { query: marker, mode: "exact", limit: 1, tokenBudget: 2000, ...(cursor ? { cursor } : {}) }, ctx)).details;
      if (search.status !== "ok") throw Error("qualification-search:" + JSON.stringify(search));
      found = search.hits?.[0]; shardId = search.shardId; cursor = search.nextCursor;
      if (!found && !cursor) break;
    }
    if (!found || !shardId) throw Error("qualification-search-miss:" + marker);
    const recalled = (await call("history_recall", { query: found.handle, tokenBudget: 2000 }, ctx)).details;
    const exact = (await call("history_get", { entryId: found.handle }, ctx)).details;
    ctx.ui.notify("QUALIFICATION_PROBE:" + marker + ":" + JSON.stringify({ routes: status.logical.routes, search: true,
      recall: recalled.status === "ok" && String(recalled.text).includes(marker), exact: exact.status === "ok" && String(exact.text).includes(marker),
      exactStatus: exact.status, exactCode: exact.code, exactTextType: typeof exact.text, shardId, entryId }), "info");
  }});
  pi.registerCommand("qualification-refuse", { handler: async (args, ctx) => {
    const [shardId, entryId] = args.trim().split(/\\s+/); const result = (await call("history_get", { entryId, shardId, blockIndex: 0 }, ctx)).details;
    ctx.ui.notify("QUALIFICATION_REFUSE:" + JSON.stringify({ refused: result.status === "unavailable" }), "info");
  }});
  pi.registerCommand("qualification-quit", { handler: async (_args, ctx) => ctx.shutdown() });
}
`);
  await safeWrite(join(agent, "settings.json"), JSON.stringify({ extensions: [bridgePath] }) + "\n");
  await safeWrite(join(agent, "chrono.json"), JSON.stringify({ memoryEngineEnabled: true }) + "\n");

  const markers = [initialMarker];
  let client = spawnPi({ root: input.root, agent, sessions, sourcePath: initialPath });
  let restartVerified = false;
  try {
    await client.send("get_commands");
    const adoptNotice = client.notify(value => value.startsWith("Logical session adopted:"));
    await promptCommand(client, "/chrono-logical-session adopt main");
    const logicalSessionId = (await adoptNotice).match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
    assert.ok(logicalSessionId);
    await probe(client, initialMarker, 1, firstId);

    const beforeFirst = (await client.send("get_state")).sessionFile;
    await promptCommand(client, `/chrono-logical-session rollover ${logicalSessionId} main`, 180_000);
    const replacement = (await client.send("get_state")).sessionFile;
    assert.notEqual(replacement, beforeFirst);
    await promptCommand(client, `/chrono-logical-session rollback ${logicalSessionId}`, 120_000);
    assert.equal((await client.send("get_state")).sessionFile, beforeFirst, "rollback must reopen the exact old source");
    let manifest = await readManifest(agent, logicalSessionId);
    const rollbackBranch = manifest.branches.find(branch => branch.branchId.startsWith("rollback."));
    assert.ok(rollbackBranch, "rollback must preserve an isolated abandoned branch");
    const abandonedShardId = rollbackBranch.activeShardId;
    const abandonedPath = manifest.shards.find(shard => shard.shardId === abandonedShardId)?.sourcePath;
    assert.ok(abandonedPath);
    const abandonedEntry = (await readFile(abandonedPath, "utf8")).trim().split("\n").map(value => JSON.parse(value))
      .find(value => value.type === "custom_message" && value.customType === "chrono-logical-continuation");
    assert.ok(abandonedEntry?.id, "abandoned replacement must retain its continuation entry");
    const abandonedEntryId = abandonedEntry.id;
    await probe(client, initialMarker, 1, firstId);

    for (let operation = 1; operation <= MAIN_ROLLOVERS; operation++) {
      await promptCommand(client, `/chrono-logical-session rollover ${logicalSessionId} main`, 180_000);
      const marker = `qualification-shard-${operation}-${sha(`${input.runtimeSha}:${operation}`).slice(0, 12)}`;
      markers.push(marker);
      const seeded = await seed(client, operation, marker);
      await probe(client, marker, operation + 1, seeded.entryId);
    }
    manifest = await readManifest(agent, logicalSessionId);
    assert.equal(manifest.branches.find(branch => branch.branchId === "main").shardIds.length, MAIN_ROLLOVERS + 1);
    const mainActivePath = manifest.shards.find(shard => shard.shardId === manifest.branches.find(branch => branch.branchId === "main").activeShardId).sourcePath;

    await promptCommand(client, `/chrono-logical-session fork ${logicalSessionId} main experiment`, 180_000);
    const childMarker = `qualification-child-${sha(input.runtimeSha).slice(0, 12)}`;
    const childSeed = await seed(client, MAIN_ROLLOVERS + 1, childMarker);
    await probe(client, initialMarker, MAIN_ROLLOVERS + 2, firstId);
    await probe(client, childMarker, MAIN_ROLLOVERS + 2, childSeed.entryId);
    manifest = await readManifest(agent, logicalSessionId);
    assert.equal(manifest.branches.find(branch => branch.branchId === "experiment").parent.branchId, "main");
    assert.equal(manifest.branches.find(branch => branch.branchId === "experiment").shardIds.includes(abandonedShardId), false);
    const sourcesBeforeRestart = await sourceSnapshot(manifest);
    const refuseNotice = client.notify(value => value.startsWith("QUALIFICATION_REFUSE:"));
    await promptCommand(client, `/qualification-refuse ${abandonedShardId} ${abandonedEntryId}`);
    assert.equal(JSON.parse((await refuseNotice).slice("QUALIFICATION_REFUSE:".length)).refused, true);

    const childPath = (await client.send("get_state")).sessionFile;
    await client.stop();
    client = spawnPi({ root: input.root, agent, sessions, sourcePath: childPath });
    await client.send("get_commands");
    const shardOne = manifest.shards.find(shard => shard.branchId === "main" && shard.ordinal === 1);
    assert.ok(shardOne);
    const shardOneEntry = (await readFile(shardOne.sourcePath, "utf8")).trim().split("\n").map(value => JSON.parse(value))
      .find(value => value.type === "message" && value.message?.role === "user")?.id;
    assert.ok(shardOneEntry);
    await probe(client, markers[1], MAIN_ROLLOVERS + 2, shardOneEntry);
    restartVerified = true;
    await client.send("switch_session", { sessionPath: mainActivePath }, 120_000);
    await probe(client, initialMarker, MAIN_ROLLOVERS + 1, firstId);

    manifest = await readManifest(agent, logicalSessionId);
    const finalSources = await sourceSnapshot(manifest);
    assert.equal(finalSources.size, manifest.shards.length);
    for (const [shardId, before] of sourcesBeforeRestart) {
      const after = finalSources.get(shardId); assert.ok(after); assert.deepEqual(after, before, `source shard changed: ${shardId}`);
    }
    const maximumActiveEntries = Math.max(...await Promise.all(manifest.shards.map(async shard => {
      const records = (await readFile(shard.sourcePath, "utf8")).trim().split("\n"); return Math.max(0, records.length - 1);
    })));
    assert.ok(maximumActiveEntries <= 6, `active physical branch exceeded bound: ${maximumActiveEntries}`);
    const result = { schemaVersion: 1, status: "passed", runtimeSha: input.runtimeSha, harnessSha, packageVersion: metadata.version,
      piVersion: EXPECTED_PI_VERSION, mainRolloverOperations: MAIN_ROLLOVERS, mainPhysicalShards: MAIN_ROLLOVERS + 1,
      totalPhysicalShards: manifest.shards.length, ancestorSearchRoutes: MAIN_ROLLOVERS + 2,
      searchRecallExactAcrossAncestors: true, forkIsolation: true, abandonedRollbackBranchPreserved: true,
      rollbackReopenedExactSource: true, processReopenVerified: restartVerified, maximumEntriesPerPhysicalShard: maximumActiveEntries,
      sourceShardsPresent: finalSources.size, preForkSourceHashesPreserved: true, providerCalls: 0,
      producerCoverage: "actual-indexed-selection-gates", sharedSettingsChanged: false, sourcesDeleted: 0 };
    await writeFile(input.output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return result;
  } finally { await client.stop(); }
}

const input = parseArgs(process.argv.slice(2));
if (input.mode === "help") console.log(HELP);
else if (input.mode === "plan") {
  assertRuntimeIdentity(input.runtimeSha);
  console.log(JSON.stringify({ runtimeSha: input.runtimeSha, harnessSha: gitHead(), requiredPackageVersion: EXPECTED_PACKAGE_VERSION, requiredInstalledPiVersion: EXPECTED_PI_VERSION,
    mainRolloverOperations: MAIN_ROLLOVERS, mainPhysicalShards: MAIN_ROLLOVERS + 1, forkChildShards: 1, providerCalls: 0,
    prerequisites: ["candidate dependencies installed", "candidate dist built", "better-sqlite3 native probe passed", "new owner-only root", "new output path"] }, null, 2));
} else console.log(JSON.stringify(await run(input), null, 2));
