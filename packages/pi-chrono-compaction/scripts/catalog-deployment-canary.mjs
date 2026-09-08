#!/usr/bin/env node
// @ts-nocheck
/**
 * Bounded, offline deployment canary. Build the candidate BEFORE running:
 *   npm run build
 *   node scripts/catalog-deployment-canary.mjs --package /explicit/package [--pi-cli /path/dist/cli.js]
 * Optional --production uses ONLY an already initialized, verified default M03
 * namespace. It never installs/repairs gates, inhibitors, or policy. Development
 * always uses one fresh synthetic namespace. No fault injection is performed.
 * All evidence is retained in an owner-only /tmp directory, including failures.
 * No cleanup or secure-erasure claim: ambiguous admissions are never removed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url), MiB = 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failureCode = error => { const first = String(error?.message ?? "unknown-failure").split("\n")[0]; return /^[a-z][a-z0-9:-]{0,160}$/.test(first) ? first : "canary-invariant-or-io-failed"; };
async function deadline(promise, ms) { let timer; try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); } finally { clearTimeout(timer); } }
const hash = value => createHash("sha256").update(value).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const url = path => pathToFileURL(path).href;
const mod = (o, name) => import(url(join(o.pkg, "dist/src", name + ".js")));
const usage = { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const regularText = "## Goal\nOFFLINE_CANARY_REGULAR_SUMMARY: Preserve synthetic acceptance history.\n## Progress\nSynthetic fixture checked.\n## Next Steps\nContinue the bounded canary.";
const toolText = n => Array.from({ length: 180 }, (_, i) => `src/synthetic-${n}-${i}.ts:${i + 1}: deterministic match synthetic-${n}`).join("\n");
// Allowlist, not a secret-name blacklist. Never read ordinary Pi settings/auth.
function environment(home, temp, extra = {}) {
  return { ...Object.fromEntries(["PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), HOME: home, TMPDIR: temp, PI_OFFLINE: "1", ...extra };
}
function privateDirectory(path) {
  const s = lstatSync(path);
  assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, "private-directory-required");
}
function privateFile(path, maxBytes = 4096) {
  const s = lstatSync(path);
  assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size <= maxBytes, "private-file-required");
}
// Enumerate metadata only, never catalog content or parser carry. Races where a
// task-owned temporary file disappears are expected; links are not followed.
function permissions(root) {
  const result = { files: 0, directories: 0, catalog: 0, checkpoint: 0, wal: 0, shm: 0, temporary: 0 };
  function walk(path) {
    let s; try { s = lstatSync(path); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    assert(!s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0, "unsafe-task-artifact");
    if (s.isDirectory()) { result.directories++; for (const name of readdirSync(path)) walk(join(path, name)); }
    else {
      assert(s.isFile() || s.isSocket(), "unexpected-task-artifact-type"); result.files++;
      if (/\.sqlite(?:$|-)/.test(path)) result.catalog++;
      if (/checkpoint/.test(path)) result.checkpoint++;
      if (/-wal$/.test(path)) result.wal++;
      if (/-shm$/.test(path)) result.shm++;
      if (/\.tmp$|\/tmp\//.test(path.slice(root.length))) result.temporary++;
    }
    assert(result.files + result.directories < 10000, "artifact-count-bound");
  }
  walk(root); return result;
}
function snapshot(root) {
  const entries = [];
  if (!existsSync(root)) return entries;
  function walk(path) { for (const name of readdirSync(path).sort()) { const p = join(path, name), s = lstatSync(p); assert(!s.isSymbolicLink()); if (s.isDirectory()) walk(p); else if (s.isFile()) entries.push({ name: p.slice(root.length), bytes: s.size, sha256: hash(readFileSync(p)) }); } }
  walk(root); return entries;
}
function fixture(dir) {
  const file = join(dir, "synthetic.jsonl"), sessionId = randomUUID();
  const entries = [{ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }];
  let parentId = null, n = 0;
  const add = message => { const id = (++n).toString(16).padStart(8, "0"); entries.push({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { ...message, timestamp: 1767225600000 + n } }); parentId = id; };
  for (let i = 0; i < 160; i++) {
    const text = `Synthetic acceptance turn ${i}. ` + "bounded acceptance state ".repeat(100);
    add(i % 2 ? { role: "assistant", content: [{ type: "text", text }], api: "chrono-canary-api", provider: "chrono-canary", model: "synthetic", usage, stopReason: "stop" } : { role: "user", content: text });
  }
  for (let i = 0; i < 6; i++) {
    add({ role: "assistant", content: [{ type: "toolCall", id: `canary-tool-${i}`, name: "grep", arguments: { pattern: "synthetic", path: "src" } }], api: "chrono-canary-api", provider: "chrono-canary", model: "synthetic", usage, stopReason: "toolUse" });
    add({ role: "toolResult", toolCallId: `canary-tool-${i}`, toolName: "grep", content: [{ type: "text", text: toolText(i) }], details: { matchCount: 180 }, isError: false });
  }
  const bytes = Buffer.from(entries.map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, sessionId, prefixBytes: bytes.length, prefixSha256: hash(bytes), dev: lstatSync(file).dev, ino: lstatSync(file).ino };
}

/** Installed runtime is unchanged. This is a documented offline provider seam,
 * not a replacement compaction hook. Pi's regular summarizer builds the request.
 * The provider returns a fixed fixture, so this proves integration, NOT model
 * quality or any external-provider-produced summary. */
export async function installCanaryExtension(pi, o) {
  globalThis.fetch = () => { throw new Error("canary-network-forbidden"); };
  const compatModules = await Promise.all(o.compats.map(path => import(path)));
  const { createAssistantMessageEventStream } = compatModules[0];
  let summaries = 0, ordinary = 0, firstFull = false, authPresent = false;
  pi.on("session_before_compact", async (_event, ctx) => { const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model); authPresent = !!(auth.ok && auth.apiKey); });
  function stream(model, context) {
    const s = createAssistantMessageEventStream();
    let message;
    try {
      // Pi summary requests serialize messages; normal requests retain roles.
      const summarizing = (context.systemPrompt ?? "").startsWith("You are a context summarization assistant.");
      if (summarizing) {
        assert(!JSON.stringify(context).includes("CHRONOCOMPACT EVENT REPLAY"), "summary-must-not-consume-replay");
        summaries++;
      } else {
        if (ordinary++ === 0 && o.checkFirst) {
          for (let i = 0; i < 6; i++) {
            const m = context.messages.find(m => m.role === "toolResult" && m.toolCallId === `canary-tool-${i}`);
            assert(m && m.content.find(x => x.type === "text")?.text === toolText(i), "first-tool-result-delivery-must-be-full");
          }
          firstFull = true;
        }
      }
      message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now(), content: [{ type: "text", text: summarizing ? regularText : "OFFLINE_CANARY_TURN_OK" }] };
      s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "stop", message });
    } catch { message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, stopReason: "error", errorMessage: "canary-offline-invariant-failed", timestamp: Date.now(), content: [] }; s.push({ type: "error", reason: "error", error: message }); }
    s.end(); return s;
  }
  // CLI and package can resolve distinct pi-ai versions. Register the SAME
  // offline test API in both; never override a built-in provider or runtime file.
  for (const { registerApiProvider } of compatModules) registerApiProvider({ api: "chrono-canary-api", stream, streamSimple: stream }, "chrono-deployment-canary");
  pi.registerProvider("chrono-canary", { baseUrl: "http://127.0.0.1:1", apiKey: "synthetic", api: "chrono-canary-api", models: [{ id: "synthetic", name: "Offline synthetic canary", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }], streamSimple: stream });
  const tools = new Map();
  const proxy = new Proxy(pi, { get(target, key) { if (key === "registerTool") return tool => { tools.set(tool.name, tool); return target.registerTool(tool); }; return Reflect.get(target, key); } });
  const { default: chrono } = await import(url(o.entry));
  chrono(proxy, o.production ? {} : { schedulerDirectory: o.scheduler });
  pi.registerCommand("canary-history", { description: "Check synthetic history without logging content", handler: async (_args, ctx) => {
    const r = await tools.get("history_search").execute("synthetic-history-call", { query: "Synthetic", limit: 2 }, undefined, undefined, ctx);
    assert(!r.isError && JSON.stringify(r).includes("Synthetic"), "history-result-required"); ctx.ui.notify("CANARY_HISTORY_OK", "info");
  } });
  pi.registerCommand("canary-metrics", { description: "Read offline counters", handler: async (_args, ctx) => ctx.ui.notify("CANARY_METRICS:" + JSON.stringify({ summaries, ordinary, firstFull, authPresent, externalProviderCalls: 0 }), "info") });
  pi.registerCommand("canary-quit", { description: "Graceful task-owned shutdown", handler: async (_args, ctx) => ctx.shutdown() });
}

function rpc(o, dir, f, enabled, checkFirst) {
  const agent = join(dir, "agent"), temp = join(dir, "tmp");
  for (const p of [agent, temp]) if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
  const wrapper = join(dir, `extension-${enabled}.mjs`);
  writeFileSync(wrapper, `import {installCanaryExtension} from ${JSON.stringify(url(SELF))};\nexport default pi => installCanaryExtension(pi, ${JSON.stringify({ ...o, checkFirst })});\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [o.cli, "--mode", "rpc", "--offline", "--session", f.file, "--session-dir", join(dir, "sessions"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", wrapper, "--provider", "chrono-canary", "--model", "synthetic"], { cwd: dir, env: environment(agent, o.production ? o.legacyTempRoot : temp, { PI_CODING_AGENT_DIR: agent, PI_CHRONO_CONFIG_PATH: join(dir, "absent-chrono.json"), PI_CHRONO_CATALOG_SHADOW: String(enabled), PI_CHRONO_ISOLATED_WORKER: "true", PI_CHRONO_HOST_WORKER_SLOTS: String(o.slots) }), stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", serial = 0, stderrBytes = 0, extensionErrors = 0, exited = false, malformed = false;
  const notifications = [], pending = new Map();
  const closed = new Promise(resolve => child.once("close", (code, signal) => { exited = true; for (const p of pending.values()) p.reject(new Error("rpc-process-exited")); pending.clear(); resolve({ code, signal }); }));
  child.on("error", () => { malformed = true; });
  child.stdin.on("error", () => { malformed = true; for (const p of pending.values()) p.reject(new Error("rpc-input-failed")); pending.clear(); });
  child.stderr.on("data", b => { stderrBytes += b.length; }); // discard contents
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", text => {
    buffer += text;
    if (buffer.length > 2 * MiB) { malformed = true; buffer = ""; return; }
    let n; while ((n = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, n).replace(/\r$/, ""); buffer = buffer.slice(n + 1);
      let e; try { e = JSON.parse(line); } catch { malformed = true; continue; }
      if (e.type === "extension_error") extensionErrors++;
      if (e.type === "extension_ui_request" && e.method === "notify") { notifications.push(e.message); if (notifications.length > 512) notifications.shift(); }
      if (e.type === "response" && pending.has(e.id)) { const p = pending.get(e.id); pending.delete(e.id); e.success ? p.resolve(e.data) : p.reject(new Error("rpc-command-failed:" + p.type)); }
    }
  });
  function send(type, extra = {}) {
    return new Promise((resolve, reject) => {
      assert(!exited, "rpc-already-exited"); const id = String(++serial);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc-deadline:" + type)); }, 60000);
      pending.set(id, { type, resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
  }
  return { pid: child.pid, send, notifications,
    healthy() { assert(!malformed && extensionErrors === 0, "rpc-loader-or-event-error"); },
    async close() {
      if (!exited) {
        try { await send("prompt", { message: "/canary-quit" }); }
        catch { child.unref(); for (const s of child.stdio) s?.unref?.(); throw new Error("rpc-unsettled-preserved"); }
      }
      const result = await deadline(closed, 15000);
      if (!result) { child.unref(); for (const s of child.stdio) s?.unref?.(); throw new Error("rpc-unsettled-preserved"); }
      assert(result.code === 0 && !result.signal, "rpc-shutdown-failed");
      return { ...result, stderrBytes, extensionErrors };
    }
  };
}
async function piCase(o, ordinal, enabled) {
  const dir = join(o.root, `pi-${ordinal}`); mkdirSync(dir, { mode: 0o700 });
  const f = fixture(dir), r = rpc(o, dir, f, enabled, true);
  const result = { pid: r.pid, enabled, source: f, checks: [] };
  save(join(dir, "pi-result.json"), result);
  try {
    const commands = await r.send("get_commands");
    for (const name of ["chrono-doctor", "chrono-worker-status", "chrono-catalog-status"]) assert(commands.commands.some(c => c.name === name), "missing-command");
    result.checks.push("actual-manifest-loader");
    for (const name of ["chrono-doctor", "chrono-worker-status", "chrono-catalog-status"]) await r.send("prompt", { message: "/" + name });
    assert(r.notifications.some(n => n.includes("Isolated replay worker: enabled")), "isolated-worker-disabled");
    assert(r.notifications.some(n => n.includes("Kernel containment: available")), "kernel-containment-required");
    result.checks.push("doctor", "worker-status", "catalog-status");
    if (enabled) {
      let ready = false;
      for (let i = 0; i < 150; i++) { await r.send("prompt", { message: "/chrono-catalog-status" }); if (/\bready\b/.test(r.notifications.at(-1))) { ready = true; break; } await sleep(100); }
      assert(ready, "shadow-readiness-deadline");
    } else { assert(r.notifications.some(n => n.includes("disabled"))); assert(!existsSync(join(dir, ".chrono-catalog")), "off-created-catalog"); }
    await r.send("prompt", { message: "CANARY_FIRST_DELIVERY" });
    // get_state may precede the settled event; poll counters only through slash
    // commands and state. Never infer prompt response means model completion.
    for (let i = 0; i < 100; i++) { const state = await r.send("get_state"); if (!state.isStreaming) break; await sleep(50); }
    await r.send("prompt", { message: "/canary-metrics" });
    const first = JSON.parse(r.notifications.findLast(n => n.startsWith("CANARY_METRICS:")).slice(15));
    assert(first.firstFull && first.ordinary === 1, "first-full-tool-result-delivery-not-proven");
    result.checks.push("first-full-tool-result-delivery-at-offline-provider-boundary");
    await r.send("prompt", { message: "/canary-history" }); assert(r.notifications.includes("CANARY_HISTORY_OK"));
    const compact = await r.send("compact", { customInstructions: "Preserve synthetic acceptance and chronological order." });
    await r.send("prompt", { message: "/canary-metrics" });
    result.offline = JSON.parse(r.notifications.findLast(n => n.startsWith("CANARY_METRICS:")).slice(15));
    result.summaryDiagnostic = { unavailable: r.notifications.some(n => n.includes("summary was unavailable")), missingApi: r.notifications.some(n => n.includes("No API provider")), offlineInvariantFailed: r.notifications.some(n => n.includes("canary-offline-invariant-failed")) };
    assert(compact.summary.includes(regularText), "regular-pi-summary-required");
    assert(compact.details?.layers?.regularPiSummaryTokens > 0 && compact.details?.layers?.chronoHistoryTokens > 0, "both-summary-layers-required");
    assert.equal(compact.details?.isolatedWorker?.used, true, "contained-compaction-required");
    await r.send("prompt", { message: "/canary-metrics" });
    result.offline = JSON.parse(r.notifications.findLast(n => n.startsWith("CANARY_METRICS:")).slice(15));
    assert(result.offline.summaries > 0, "regular-summarizer-not-called");
    result.checks.push("history", "contained-compaction", "required-regular-pi-summary-offline-fixture");
    result.summaryBytes = Buffer.byteLength(compact.summary);
    const b = readFileSync(f.file); assert.equal(hash(b.subarray(0, f.prefixBytes)), f.prefixSha256, "pi-source-prefix-changed");
    result.source.finalSha256 = hash(b); result.source.finalBytes = b.length;
    assert.equal(lstatSync(f.file).dev, f.dev); assert.equal(lstatSync(f.file).ino, f.ino);
    assert(!r.notifications.some(n => n.includes(dir) || n.includes(o.pkg) || n.includes(".jsonl")), "diagnostic-path-leak"); r.healthy();
  } finally { try { result.shutdown = await r.close(); } finally { save(join(dir, "pi-result.json"), result); } }
  if (enabled) {
    // Fresh process off on the SAME persisted session. No config write. Appends
    // through Pi must not schedule shadow work or modify its old catalog.
    const before = snapshot(join(dir, ".chrono-catalog")); assert(before.length > 0, "enabled-catalog-missing");
    const off = rpc(o, dir, f, false, false);
    try {
      await off.send("get_commands");
      await off.send("prompt", { message: "/chrono-catalog-status" }); assert(off.notifications.at(-1).includes("disabled"));
      await off.send("set_session_name", { name: "Synthetic off restart" });
      await off.send("prompt", { message: "CANARY_OFF_RESTART" });
      let idle = false;
      for (let i = 0; i < 100; i++) { const state = await off.send("get_state"); if (!state.isStreaming) { idle = true; break; } await sleep(50); }
      assert(idle, "off-restart-turn-deadline");
      await off.send("prompt", { message: "/chrono-catalog-status" }); assert(off.notifications.at(-1).includes("disabled"));
      await off.send("prompt", { message: "/canary-history" }); assert(off.notifications.includes("CANARY_HISTORY_OK"));
      await sleep(300); off.healthy();
    } finally { result.offRestart = { pid: off.pid, shutdown: await off.close() }; }
    assert.deepEqual(snapshot(join(dir, ".chrono-catalog")), before, "disabled-shadow-mutated-catalog");
    result.checks.push("fresh-process-off-restart-history", "disabled-shadow-no-catalog-writes");
  }
  assert(!existsSync(join(dir, "absent-chrono.json")), "canary-must-not-write-config");
  const final = readFileSync(f.file); assert.equal(hash(final.subarray(0, f.prefixBytes)), f.prefixSha256, "pi-final-prefix-changed");
  result.source.finalSha256 = hash(final); result.source.finalBytes = final.length;
  result.permissions = permissions(dir); save(join(dir, "pi-result.json"), result); return result;
}

const eventId = n => `catalog-${String(n).padStart(6, "0")}`;
const recordLine = n => JSON.stringify({ type: "message", id: eventId(n), parentId: n === 1 ? null : eventId(n - 1), timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `Unique synthetic catalog record ${n}: λ\\n ${hash(String(n))}` } }) + "\n";
async function catalogCase(o, resume) {
  const { runCatalogWorker, CATALOG_WORKER_CAPS } = await mod(o, "catalog-worker-client");
  assert.equal(CATALOG_WORKER_CAPS.memoryBytes, 256 * MiB); assert.equal(CATALOG_WORKER_CAPS.heapMiB, 128);
  const base = { v: 1, catalogDirectory: join(o.dir, "catalog"), sessionKey: `synthetic-${o.ordinal}` };
  const sourcePath = join(o.dir, "catalog-source.jsonl");
  const metrics = { jobs: 0, maxSourceBytes: 0, maxResponseBytes: 0, maxRssBytes: 0, maxCgroupBytes: 0 };
  async function call(request) {
    const response = await runCatalogWorker({ ...base, ...request }, { slots: o.slots, ...(o.production ? {} : { schedulerDirectory: o.scheduler }) });
    assert(response.ok, "catalog-job-failed:" + (response.code ?? "unknown")); assert.equal(response.result.error, undefined, "catalog-store-error");
    const w = response.result.workerObservation; assert(w && w.processIo && w.cgroupMemoryLimitBytes === 256 * MiB, "worker-observation-required");
    assert(w.processPeakRssBytes <= 256 * MiB && w.cgroupMemoryPeakBytes <= 256 * MiB, "worker-memory-cap");
    const bytes = Buffer.byteLength(JSON.stringify(response)); assert(bytes <= 256 * 1024 && response.sourceBytes <= 8 * MiB, "catalog-response-or-source-cap");
    metrics.jobs++; metrics.maxSourceBytes = Math.max(metrics.maxSourceBytes, response.sourceBytes); metrics.maxResponseBytes = Math.max(metrics.maxResponseBytes, bytes); metrics.maxRssBytes = Math.max(metrics.maxRssBytes, w.processPeakRssBytes); metrics.maxCgroupBytes = Math.max(metrics.maxCgroupBytes, w.cgroupMemoryPeakBytes);
    return response;
  }
  const ingest = { op: "ingestStep", sourcePath, shardKey: "one", branchKey: "main", shardOrdinal: 0 };
  const count = 128;
  let view, prefixSha256;
  if (!resume) {
    const original = Array.from({ length: count }, (_, i) => recordLine(i + 1)).join(""); writeFileSync(sourcePath, original, { mode: 0o600 }); prefixSha256 = hash(original);
    let caught = false;
    for (let i = 0; i < 16; i++) { if ((await call(ingest)).result.caughtUp) { caught = true; break; } }
    assert(caught, "bounded-ingest-deadline");
    const status = await call({ op: "status", shardKey: "one" }); assert.equal(status.result.records, count); assert.equal(status.result.committed, Buffer.byteLength(original));
    view = (await call({ op: "pin", branchKey: "main", leaf: { shardKey: "one", eventId: eventId(count) } })).result.view;
    appendFileSync(sourcePath, recordLine(count + 1));
    assert((await call(ingest)).result.caughtUp, "append-catchup-required");
    assert.equal((await call({ op: "status", shardKey: "one" })).result.records, count + 1);
    save(join(o.dir, "restart.json"), { view, prefixSha256 });
  } else ({ view, prefixSha256 } = json(join(o.dir, "restart.json")));
  for (const after of [0, 60, 120]) {
    const page = await call({ op: "page", view, after, limit: 16 }); assert.equal(page.sourceBytes, 0, "metadata-query-read-source");
    const expected = Array.from({ length: Math.min(16, count - after) }, (_, i) => eventId(after + i + 1));
    assert.deepEqual(page.result.events.map(e => e.metadata.id), expected, "pinned-chronology-or-append-cut");
    const e = page.result.events[0];
    const raw = await call({ op: "raw", view, eventSeq: e.seq, offset: e.rawStart, length: e.endByte - e.rawStart });
    assert.equal(Buffer.from(raw.result.data, "base64").toString(), recordLine(after + 1), "exact-raw-recovery");
  }
  const expected = Array.from({ length: count + 1 }, (_, i) => recordLine(i + 1)).join("");
  assert.equal(hash(readFileSync(sourcePath)), hash(expected), "catalog-source-hash");
  assert.equal(hash(Buffer.from(expected).subarray(0, Buffer.byteLength(expected) - Buffer.byteLength(recordLine(count + 1)))), prefixSha256);
  return { pid: process.pid, resume, metrics, count, sourceSha256: hash(expected), prefixSha256, checks: [resume ? "fresh-client-restart" : "bounded-ingest-and-append-catchup", "pinned-chronology", "pinned-cut-excludes-append", "exact-raw", "full-source-hash"], permissions: permissions(o.dir) };
}
function startCatalog(o, resume) {
  const input = join(o.dir, resume ? "resume-input.json" : "input.json"), output = join(o.dir, resume ? "resume-result.json" : "result.json"); save(input, o);
  const child = spawn(process.execPath, ["--max-old-space-size=128", SELF, "--catalog-child", input, output, String(resume)], { cwd: o.dir, env: environment(o.root, o.production ? o.legacyTempRoot : join(o.root, "tmp")), stdio: ["ignore", "ignore", "ignore"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.unref(); reject(new Error("catalog-caller-unsettled-preserved")); }, 240000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("catalog-caller-start-failed")); });
    child.once("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error("catalog-caller-failed:" + output)); else resolve(json(output)); });
  });
}
async function preflight(pkg, cli, production) {
  pkg = realpathSync(pkg); cli = realpathSync(cli);
  const manifestPath = join(pkg, "package.json"), manifest = json(manifestPath);
  assert.equal(manifest.pi?.extensions?.length, 1, "one-explicit-manifest-entry-required");
  const entry = realpathSync(resolve(pkg, manifest.pi.extensions[0])); assert(entry.startsWith(pkg + "/"), "entry-outside-package");
  assert(entry.includes("/dist/"), "build-package-before-dist-canary");
  const req = createRequire(manifestPath);
  // pi-ai exposes import-only conditions; require.resolve('/compat') refuses
  // them. Locate the nearest installed dependency without loading native code.
  function dependency(base, name, file) {
    const root = createRequire(join(base, "package.json")).resolve.paths(name).map(p => join(p, name)).find(p => existsSync(join(p, file)));
    assert(root, "installed-dependency-required"); return realpathSync(join(root, file));
  }
  const sdkRoot = dirname(dirname(dependency(pkg, "@earendil-works/pi-coding-agent", "dist/index.js")));
  const compats = [...new Set([pkg, sdkRoot, resolve(cli, "../..")].map(base => url(dependency(base, "@earendil-works/pi-ai", "dist/compat.js"))))];
  const nativeRoot = dirname(req.resolve("better-sqlite3/package.json"));
  const nativePath = join(nativeRoot, "build/Release/better_sqlite3.node");
  const runtime = { harnessSha256: hash(readFileSync(SELF)), packageVersion: manifest.version, sdkVersion: json(join(sdkRoot, "package.json")).version, manifestSha256: hash(readFileSync(manifestPath)), entry, entrySha256: hash(readFileSync(entry)), piVersion: json(resolve(cli, "../../package.json")).version, piCli: cli, piCliSha256: hash(readFileSync(cli)), node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch, nativeVersion: json(join(nativeRoot, "package.json")).version, nativeSha256: hash(readFileSync(nativePath)) };
  const provenancePath = join(nativeRoot, "build/chrono-native-provenance.json");
  if (existsSync(provenancePath)) { const p = json(provenancePath); runtime.nativeBuild = { target: p.target, buildNode: p.buildNode, sourceSha256: p.sourceSha256, nativeSha256: p.nativeSha256 }; assert.equal(p.nativeSha256, runtime.nativeSha256, "native-provenance-hash-mismatch"); }
  const o = { pkg, cli, entry, compats, production, slots: 1, legacyTempRoot: tmpdir() };
  if (production) {
    const { defaultRuntimeDirectory, legacySchedulerDirectory } = await mod(o, "worker-runtime-namespace"); o.scheduler = defaultRuntimeDirectory();
    // No mkdir, no normal job, no activation helper before these read-only checks.
    privateDirectory(o.scheduler); privateFile(join(o.scheduler, "policy.json"), 1024);
    const policy = readFileSync(join(o.scheduler, "policy.json")), p = JSON.parse(policy);
    const { WORKER_LIMITS } = await mod(o, "worker-runtime-limits");
    assert(p.schemaVersion === 2 && Number.isInteger(p.slots) && p.slots >= 1 && p.slots <= 4 && p.memoryBytes === WORKER_LIMITS.hostMemoryBytes, "existing-policy-required");
    assert.equal(policy.toString(), JSON.stringify({ schemaVersion: 2, slots: p.slots, memoryBytes: WORKER_LIMITS.hostMemoryBytes }), "canonical-existing-policy-required");
    const { verifyLegacyAdmissionGate } = await mod(o, "worker-runtime-legacy-gate"); assert(await verifyLegacyAdmissionGate(), "verified-existing-legacy-gate-required");
    o.slots = p.slots; o.policySha256 = hash(policy);
    o.guardFiles = [join(o.scheduler, "legacy-gate.json"), ...Array.from({ length: 4 }, (_, i) => join(legacySchedulerDirectory(), `slot-${i}.json`))].map(path => { privateFile(path); return { path, sha256: hash(readFileSync(path)) }; });
  }
  return { o, runtime };
}
async function main() {
  const args = process.argv.slice(2); let pkg, cli, production = false;
  while (args.length) { const a = args.shift(); if (a === "--package") pkg = args.shift(); else if (a === "--pi-cli") cli = args.shift(); else if (a === "--production") production = true; else throw new Error("usage: --package PATH [--pi-cli PATH] [--production]"); }
  assert(pkg, "explicit-package-path-required");
  cli ??= join(pkg, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const { o, runtime } = await preflight(resolve(pkg), resolve(cli), production);
  process.umask(0o077);
  o.root = mkdtempSync("/tmp/chrono-deployment-canary-"); privateDirectory(o.root); mkdirSync(join(o.root, "tmp"), { mode: 0o700 });
  if (!production) o.scheduler = join(o.root, "scheduler");
  const reportPath = join(o.root, "report.json");
  const report = { passed: false, root: o.root, runtime, namespace: production ? "existing-production-normal-jobs-only" : "fresh-synthetic", scheduler: o.scheduler, phase: "starting", limits: ["Small synthetic fixture, not a repeat of the retained 50k-record/276MiB campaign.", "Regular Pi summarizer uses a fixed offline stream fixture; no external-provider summary or model-quality claim.", "First full tool-result delivery is checked at the offline provider boundary on a persisted synthetic fixture, not live external tool execution.", "Permission samples cannot prove every transient WAL/SHM/temp lifetime; absent files are reported, not claimed observed.", "No corruption, mutation, process-kill, or full fault campaign. Existing disposable tests own those checks.", "Native ABI compatibility is demonstrated by successful contained SQLite jobs; native allocation is not measured separately.", "All private evidence and scheduler artifacts are retained; no deletion and no secure-erasure claim."] };
  save(reportPath, report); console.log(JSON.stringify({ artifact: reportPath, phase: "starting" }));
  // Attributable owner metadata only. No request content or parser checkpoints.
  const owners = new Map(), samples = { maximumSlots: 0, maximumTickets: 0, permissionSamples: 0, wal: 0, shm: 0, temporary: 0 }; let sampleFailure, initialPolicySha256 = o.policySha256;
  function sample() {
    try {
      if (existsSync(o.scheduler)) {
        const names = readdirSync(o.scheduler); let slots = 0, tickets = 0;
        if (names.includes("policy.json")) { const current = hash(readFileSync(join(o.scheduler, "policy.json"))); initialPolicySha256 ??= current; assert.equal(current, initialPolicySha256, "admission-policy-changed"); }
        for (const name of names.filter(n => /^(slot-\d|ticket-[a-f0-9]+)\.json$/.test(n))) {
          try { const path = join(o.scheduler, name); privateFile(path); const p = json(path); if (name.startsWith("slot")) slots++; else tickets++; if (Number.isInteger(p.pid) && typeof p.processStartIdentity === "string" && typeof p.nonce === "string") owners.set(p.nonce, { pid: p.pid, start: p.processStartIdentity, nonce: p.nonce, jobType: p.jobType }); } catch (e) { if (e.code !== "ENOENT") throw e; }
        }
        samples.maximumSlots = Math.max(samples.maximumSlots, slots); samples.maximumTickets = Math.max(samples.maximumTickets, tickets);
      }
      const p = permissions(o.root); samples.permissionSamples++; for (const k of ["wal", "shm", "temporary"]) samples[k] = Math.max(samples[k], p[k]);
    } catch { sampleFailure = "permission-or-admission-sample-failed"; }
  }
  const timer = setInterval(sample, 40);
  try {
    report.phase = "two-fresh-pi-processes"; save(reportPath, report);
    const pi = await Promise.allSettled([piCase(o, 0, false), piCase(o, 1, true)]);
    report.pi = pi.map(x => x.status === "fulfilled" ? x.value : { failed: true, reason: failureCode(x.reason) });
    assert(pi.every(x => x.status === "fulfilled"), "pi-case-failed");
    assert.equal(new Set(report.pi.map(x => x.pid)).size, 2);
    report.phase = "two-independent-catalog-clients"; save(reportPath, report);
    const inputs = [0, 1].map(ordinal => { const dir = join(o.root, `catalog-${ordinal}`); mkdirSync(dir, { mode: 0o700 }); return { ...o, ordinal, dir }; });
    report.catalog = [];
    for (const resume of [false, true]) {
      const results = await Promise.allSettled(inputs.map(input => startCatalog(input, resume)));
      report.catalog.push({ resume, results: results.map(x => x.status === "fulfilled" ? x.value : { failed: true, reason: failureCode(x.reason) }) });
      assert(results.every(x => x.status === "fulfilled"), "independent-catalog-case-failed");
    }
    report.phase = "settlement"; save(reportPath, report);
    await sleep(500); sample(); assert(!sampleFailure, sampleFailure); assert(samples.maximumSlots <= o.slots, "sampled-policy-cap-exceeded");
    const { schedulerArtifactCounts } = await mod(o, "host-worker-scheduler");
    const { runtimeUnitName, runtimeUnitState } = await mod(o, "worker-runtime-systemd");
    const counts = await schedulerArtifactCounts(o.scheduler);
    const states = await Promise.all(Array.from({ length: o.slots }, (_, i) => runtimeUnitState(runtimeUnitName(o.scheduler, i))));
    if (!production) { assert.deepEqual(counts, { slots: 0, tickets: 0 }); assert(states.every(s => s === "inactive" || s === "failed"), "synthetic-unsettled-unit"); }
    // On production, do not demand unrelated jobs stop. Prove only sampled
    // canary ownership disappears; never delete another client's admission.
    const pids = new Set([...report.pi.flatMap(x => [x.pid, x.offRestart?.pid]), ...report.catalog.flatMap(x => x.results.map(r => r.pid))].filter(Boolean));
    const owned = [...owners.values()].filter(x => pids.has(x.pid));
    const requiredPids = [...report.pi.map(x => x.pid), ...report.catalog.flatMap(x => x.results.map(r => r.pid))];
    assert(requiredPids.every(pid => owned.some(x => x.pid === pid)), "each-independent-caller-needs-attributable-ownership");
    const remaining = readdirSync(o.scheduler).filter(n => /^(slot-|ticket-)/.test(n)).map(n => { try { return json(join(o.scheduler, n)); } catch { return { ambiguous: true }; } });
    assert(!remaining.some(x => pids.has(x.pid) || owned.some(y => y.nonce === x.nonce)), "task-admission-unsettled");
    assert(!remaining.some(x => x.ambiguous), "ambiguous-admission-preserved");
    const policySha256 = hash(readFileSync(join(o.scheduler, "policy.json")));
    assert.equal(policySha256, initialPolicySha256, "admission-policy-changed");
    if (production) for (const guard of o.guardFiles) { privateFile(guard.path); assert.equal(hash(readFileSync(guard.path)), guard.sha256, "production-gate-or-inhibitor-changed"); }
    report.settlement = { counts, unitStates: states, sampledTaskOwners: owned, taskAdmissionsRemaining: 0, policySha256 };
    report.permissions = { ...permissions(o.root), checkpointStorage: "SQLite catalog transaction; no separate parser-carry or checkpoint log", productionTempRootPreservedForLegacyGate: production }; report.passed = true; report.phase = "complete";
  } catch (error) { report.failure = { phase: report.phase, code: failureCode(error) }; }
  finally { clearInterval(timer); report.samples = samples; report.sampleFailure = sampleFailure; save(reportPath, report); }
  console.log(JSON.stringify({ passed: report.passed, artifact: reportPath, phase: report.phase })); if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) {
  if (process.argv[2] === "--catalog-child") {
    process.umask(0o077);
    const [, , , input, output, resume] = process.argv;
    try { save(output, await catalogCase(json(input), resume === "true")); }
    catch (error) { save(output, { passed: false, code: failureCode(error) }); process.exitCode = 1; }
  } else {
    try { await main(); } catch (error) { console.error(JSON.stringify({ error: "canary-preflight-refused", type: error.name, code: error.code ?? "preflight-invariant", reason: error instanceof assert.AssertionError ? error.message.split("\n")[0] : undefined })); process.exitCode = 1; }
  }
}
