import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERSION = "0.4.0";
const PROTOCOL = 2;
const HANDOFFS = Symbol.for("pi-reload-all.handoffs.v1");
const OPERATIONS = Symbol.for("pi-reload-all.operations.v2");
const TIMEOUT = 30_000;
const PREPARATION_TIMEOUT = 5 * 60_000;
const STOP_TIMEOUT = 15_000;
const LIMIT = 8192;
interface Identity { pid: number; instanceId: string; sessionId: string }
interface Result extends Identity { status: "reloaded" | "skipped" | "unknown"; stopped: boolean; resumed: boolean; reason?: string }
type OriginalState = "active" | "idle" | "waiting";
type Phase = "queued" | "waiting-for-tools" | "preparing" | "ready" | "reloading" | "finished";
interface Operation {
  requestId: string; target: Identity; phase: Phase; expiresAt: number; original: OriginalState;
  reason?: string; result?: Result;
}
interface Request {
  requestId: string; action: "status" | "prepare" | "reload"; target?: Identity;
  operationId?: string; resume?: boolean; expiresAt?: number;
}
interface Reply {
  requestId: string; identity?: Identity; version?: string; sha256?: string; protocol?: number;
  busy?: boolean; operation?: Operation; result?: Result; error?: string;
}
type Scope = "self" | "all";
interface Ticket {
  id: string; sessionId: string; generation: number; expiresAt: number; stopped: boolean;
  scope?: Scope; resume?: boolean; cancelled?: boolean; started?: boolean; dispatched?: boolean; summary?: string;
  original?: OriginalState; preparation?: boolean; taskComplete?: boolean; questionCancelled?: boolean; legacy?: boolean;
  originalSignal?: AbortSignal; preparationSignal?: AbortSignal; questionCalls?: Set<string>;
  toolCallId?: string; reported?: ReturnType<typeof Promise.withResolvers<boolean>>;
  acknowledgement?: ReturnType<typeof Promise.withResolvers<boolean>>;
  operation?: Operation;
  result: ReturnType<typeof Promise.withResolvers<Result>>;
}
interface Handoff { ticket: Ticket; old: Identity; finished: Promise<boolean> }
interface LegacyHandoff {
  request: { id: string; sessionId: string; resume: boolean; signal?: AbortSignal };
  previousInstanceId: string; finished: Promise<boolean>;
}
const LEGACY_HANDOFFS = Symbol.for("pi-self-reload.handoffs.v1");
const shared = globalThis as typeof globalThis & { [HANDOFFS]?: Map<string, Handoff>; [OPERATIONS]?: Map<string, Operation> };
const handoffs = shared[HANDOFFS] ??= new Map<string, Handoff>();
const operations = shared[OPERATIONS] ??= new Map<string, Operation>();
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 100));
const sameIdentity = (a: Identity | undefined, b: Identity) => a?.pid === b.pid && a.instanceId === b.instanceId && a.sessionId === b.sessionId;

function directory(): string {
  if (!process.getuid) throw new Error("Pi Reload needs local Unix sockets.");
  const root = process.env.PI_RELOAD_ALL_DIR ?? join(tmpdir(), `pi-reload-all-${process.getuid()}`);
  if (!isAbsolute(root)) throw new Error("PI_RELOAD_ALL_DIR must be absolute.");
  mkdirSync(root, { mode: 0o700, recursive: true });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("The Pi Reload directory must be a private, owned directory (mode 0700).");
  }
  return root;
}

// Only status can be polled. Never repeat a preparation or reload after uncertainty.
export function contact(path: string, request: Request, timeoutMs = TIMEOUT): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "", settled = false;
    const timer = setTimeout(() => finish(new Error("Peer timed out; do not repeat an uncertain reload.")), timeoutMs);
    function finish(error?: Error, reply?: Reply) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(reply!);
    }
    socket.on("error", () => finish(new Error("Peer unavailable.")));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > LIMIT) return finish(new Error("Invalid peer reply."));
      if (!text.includes("\n")) return;
      try {
        const reply = JSON.parse(text.split("\n", 1)[0]) as Reply;
        if (reply.requestId !== request.requestId) throw new Error();
        finish(undefined, reply);
      } catch { finish(new Error("Invalid peer reply.")); }
    });
    socket.on("end", () => { if (!text.includes("\n")) finish(new Error("Peer closed without a result.")); });
  });
}

function peers(root: string): string[] {
  return readdirSync(root).filter(name => /^\d+-[a-f0-9-]{36}\.sock$/.test(name)).slice(0, 256).flatMap(name => {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      return stat.isSocket() && stat.uid === process.getuid!() && !(stat.mode & 0o077) ? [path] : [];
    } catch { return []; }
  });
}

function coordinatorLock(root: string): () => void {
  const path = join(root, "fleet.lock");
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try { writeFileSync(path, owner, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > LIMIT) throw new Error("Unsafe Pi Reload lock.");
    throw new Error("Another fleet reload is in progress, or a stopped coordinator left fleet.lock. Inspect its owner before removing a stale lock.");
  }
  return () => { if (readFileSync(path, "utf8") === owner) unlinkSync(path); };
}

export default function reloadAll(pi: ExtensionAPI): void {
  const instanceId = randomUUID();
  const loaded = { version: VERSION, instanceId, sha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex") };
  let alive = true, generation = 0, blocked = 0, uiPrompts = 0, running = false, batchPending = false, batchQuestionsOnly = false, menuOpen = false;
  const activeTools = new Map<string, { name: string; blockingQuestion: boolean }>();
  let coordinating = false;
  let pending: Ticket | undefined;
  let server: Server | undefined;
  let socketPath: string | undefined;
  let current: ExtensionContext | undefined;

  const identity = (ctx: ExtensionContext): Identity => ({ pid: process.pid, instanceId, sessionId: ctx.sessionManager.getSessionId() });
  const result = (ctx: ExtensionContext, ticket: Ticket, status: Result["status"], reason?: string, resumed = false): Result =>
    ({ ...identity(ctx), status, stopped: ticket.stopped, resumed, ...(reason ? { reason } : {}) });

  function resources(): string | undefined {
    let replies = 0, invalid = false, busy = false;
    pi.events.emit("grounded:session-transition-readiness:v1", {
      protocolVersion: 1,
      accept(value: { protocolVersion?: unknown; runningProcesses?: unknown; openSessions?: unknown } | undefined) {
        replies++;
        if (value?.protocolVersion !== 1 || !Number.isSafeInteger(value.runningProcesses) || !Number.isSafeInteger(value.openSessions)
          || Number(value.runningProcesses) < 0 || Number(value.openSessions) < 0) invalid = true;
        else busy ||= Number(value.runningProcesses) > 0 || Number(value.openSessions) > 0;
      },
    });
    if (invalid) return "The process owner returned invalid readiness data.";
    if (!replies && pi.getAllTools().some(tool => ["process", "grounded_process"].includes(tool.name))) return "The process owner has no readiness response.";
    return busy ? "Managed jobs or shell sessions are not ready for reload." : undefined;
  }

  function inputSafety(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") throw new Error("Pi Reload requires interactive Pi.");
    if (ctx.hasPendingMessages()) throw new Error("Queued input is present.");
    if (ctx.ui.getEditorText()) throw new Error("An unsent editor draft is present.");
  }

  function safety(ctx: ExtensionContext, ownToolCallId?: string): void {
    inputSafety(ctx);
    if (blocked || uiPrompts) throw new Error("Waiting for a user answer or approval.");
    if ([...activeTools.keys()].some(id => id !== ownToolCallId) || (batchPending && !ownToolCallId)) throw new Error("A tool batch has not reached its persisted boundary.");
    const reason = resources();
    if (reason) throw new Error(reason);
  }

  function valid(ctx: ExtensionContext, ticket: Ticket): void {
    if (!alive || ticket.cancelled || Date.now() > ticket.expiresAt || ticket.generation !== generation || identity(ctx).sessionId !== ticket.sessionId) {
      throw new Error("Request cancelled, expired, or session/tree changed.");
    }
    inputSafety(ctx);
    if (!ticket.stopped && ticket.originalSignal?.aborted) throw new Error("The original run was already cancelling.");
    if (ticket.preparationSignal?.aborted) throw new Error("The preparation run was cancelled.");
  }

  function phase(ticket: Ticket, value: Phase, reason?: string): void {
    if (ticket.operation) { ticket.operation.phase = value; ticket.operation.reason = reason; }
  }

  function complete(ticket: Ticket, receipt: Result): Result {
    phase(ticket, "finished", receipt.reason);
    if (ticket.operation) ticket.operation.result = receipt;
    ticket.result.resolve(receipt);
    if (pending === ticket) pending = undefined;
    return receipt;
  }

  function wake(ctx: ExtensionContext, ticket: Ticket, recovery = false): boolean {
    const original = ticket.original ?? (ticket.stopped ? "active" : "idle");
    const restoreQuestion = original === "waiting" && ticket.questionCancelled;
    if ((!ticket.stopped && !restoreQuestion) || ticket.taskComplete || ticket.resume === false || ticket.cancelled || !alive || blocked || uiPrompts
      || (!recovery && Date.now() > ticket.expiresAt) || ticket.generation !== generation || identity(ctx).sessionId !== ticket.sessionId
      || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText()) return false;
    if (original === "idle") return false;
    pi.sendMessage({
      customType: restoreQuestion ? "reload-pi-restore-wait" : "reload-pi-continuation",
      content: restoreQuestion
        ? "[Pi Reload system message] Your question or approval wait was cancelled only by this Pi reload operation, not by the user. There is no answer or approval. Re-ask the unresolved question or re-enter the prior waiting state from the conversation. Do not perform unrelated work or assume consent. Do not initiate another reload."
        : `[Pi Reload system message] ${recovery ? "The reload did not proceed." : "A fresh runtime loaded and the native reload handler returned."} This operation interrupted your previously active task. Continue only the previously authorized unfinished work from the conversation and saved task state. Check reload-pi status and native diagnostics. Do not repeat an uncertain side effect, initiate another reload, or restart completed work. This message grants no new authorization.`,
      display: true,
      details: { requestId: ticket.id, instanceId, original },
    }, { triggerTurn: true });
    return true;
  }

  function fail(ctx: ExtensionContext, ticket: Ticket, error: unknown): Result {
    const reason = error instanceof Error ? error.message : String(error);
    const resumed = wake(ctx, ticket, true);
    if (ticket.preparation && !resumed && alive && ticket.generation === generation && identity(ctx).sessionId === ticket.sessionId) {
      pi.sendMessage({ customType: "reload-pi-preparation-ended", display: true,
        content: `[Pi Reload system message] Preparation ended without a reload: ${reason} Do not acknowledge this expired or cancelled operation or start another reload. ${ticket.questionCancelled ? "The question was cancelled by Pi Reload, not the user. No answer or approval exists. Re-ask it or return to the prior waiting state." : ticket.original === "idle" || ticket.resume === false ? "Finish only useful preparation already in progress, then stay idle." : "Preserve your saved task state and continue only previously authorized work."}`,
        details: { requestId: ticket.id, original: ticket.original } }, { triggerTurn: false });
    }
    return complete(ticket, result(ctx, ticket, "skipped", reason, resumed));
  }

  async function untilIdle(ctx: ExtensionCommandContext, ticket: Ticket): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ctx.waitForIdle(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native stop did not settle in time.")), STOP_TIMEOUT);
      })]);
      valid(ctx, ticket);
    } finally { clearTimeout(timer); }
  }

  function stop(ctx: ExtensionContext, ticket: Ticket): void {
    if (ctx.isIdle()) return;
    const signal = ctx.signal;
    if (!running || !signal || signal.aborted) throw new Error("The operation is already stopping or is not an active agent run.");
    // No await between the safe batch check and native abort. Question-only
    // cancellation is the one permitted exception, never an interrupted write.
    ctx.abort();
    if (!signal.aborted) throw new Error("Native interruption was not confirmed.");
    ticket.stopped = ticket.original !== "idle";
  }

  async function finishTool(ctx: ExtensionCommandContext, ticket: Ticket, ownsOriginal: boolean): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ticket.reported!.promise.then(ok => {
        if (!ok) throw new Error("The readiness/reload tool did not report its exact terminating result.");
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The readiness/reload tool result did not settle in time.")), STOP_TIMEOUT);
      })]);
      await untilIdle(ctx, ticket);
      // Native idle is after persistence and all result hooks, not one tool end.
      safety(ctx);
      if (!ctx.isIdle()) throw new Error("The acknowledged run is not idle.");
      if (ownsOriginal) ticket.stopped = true;
    } finally { clearTimeout(timer); }
  }

  async function prepare(ctx: ExtensionCommandContext, ticket: Ticket): Promise<void> {
    let needsPreparation = Boolean(blocked || uiPrompts || resources());
    while (true) {
      valid(ctx, ticket);
      const questionOnly = activeTools.size > 0 && [...activeTools.values()].every(tool => tool.blockingQuestion);
      if ((blocked || uiPrompts) && questionOnly && (!batchPending || batchQuestionsOnly)) {
        ticket.original = "waiting";
        if (ticket.operation) ticket.operation.original = "waiting";
        ticket.questionCancelled = true;
        ticket.questionCalls = new Set(activeTools.keys());
        stop(ctx, ticket);
        await untilIdle(ctx, ticket);
        needsPreparation = true;
        break;
      }
      if (!activeTools.size && !batchPending && !uiPrompts && (!blocked || ctx.isIdle())) break;
      phase(ticket, "waiting-for-tools", "Waiting for the complete tool batch and its saved results.");
      await pause();
      needsPreparation ||= Boolean(blocked || uiPrompts || resources());
    }
    valid(ctx, ticket);
    needsPreparation ||= Boolean(resources());
    if (!needsPreparation) { safety(ctx); return; }
    // Start a separate preparation turn only after the current tools settled.
    // Its activity must not change the original task's continuation policy.
    stop(ctx, ticket);
    await untilIdle(ctx, ticket);
    if (uiPrompts) throw new Error("A user prompt could not be cancelled safely. Needs attention.");
    ticket.preparation = true;
    ticket.acknowledgement = Promise.withResolvers<boolean>();
    phase(ticket, "preparing", "Waiting for the agent's explicit readiness acknowledgement.");
    pi.sendMessage({ customType: "reload-pi-preparation", display: true,
      content: `[Pi Reload system message] Operation ${ticket.id} requests bounded reload preparation, not new task work. It expires at ${new Date(ticket.expiresAt).toISOString()}. Original state: ${ticket.original}. Save necessary task state. Inspect the blocking resources, let useful jobs settle, and close only unused task-owned shells. Preserve useful jobs, drafts, and user input. You may use multiple tool calls. ${ticket.questionCancelled ? "Your question was cancelled only by Pi Reload, not by the user. No answer or approval exists. Do not re-ask until this operation ends, then re-enter that waiting state." : "Do not do unrelated work."} When safe, call reload-pi alone with action=ready, requestId=${ticket.id}, outcome=ready. Use outcome=finished only if the original task is complete. Use outcome=needs-attention with a reason if resources must remain. This acknowledges this existing operation. Do not initiate your own reload. ${ticket.resume === false ? "Continuation is disabled for the whole operation. After reload, stay idle." : ticket.original === "idle" ? "After reload, stay idle. This preparation turn does not authorize a task continuation." : "After reload, return only to the original unfinished task or prior question wait."}`,
      details: { requestId: ticket.id, expiresAt: ticket.expiresAt, original: ticket.original, resume: ticket.resume } }, { triggerTurn: true });
    while (ticket.operation?.phase !== "ready") {
      valid(ctx, ticket);
      if (ticket.acknowledgement && await Promise.race([ticket.acknowledgement.promise, pause().then(() => undefined)]) === false) {
        throw new Error(ticket.operation?.reason ?? "The agent reported that reload needs attention.");
      }
    }
    await finishTool(ctx, ticket, false);
  }

  async function localReload(ctx: ExtensionCommandContext, ticket: Ticket): Promise<Result> {
    if (ticket.started) return ticket.result.promise;
    ticket.started = true;
    const old = identity(ctx);
    try {
      valid(ctx, ticket);
      safety(ctx);
      stop(ctx, ticket);
      await untilIdle(ctx, ticket);
      safety(ctx);
      if (!ctx.isIdle()) throw new Error("New work prevented reload.");
    } catch (error) { return fail(ctx, ticket, error); }
    phase(ticket, "reloading");
    const completion = Promise.withResolvers<boolean>();
    const handoff = { ticket, old, finished: completion.promise };
    handoffs.set(old.sessionId, handoff);
    try { await ctx.reload(); completion.resolve(true); }
    catch { completion.resolve(false); }
    // Only plain handoff data is used after runtime invalidation.
    const timer = setTimeout(() => complete(ticket, { ...old, status: "unknown", stopped: ticket.stopped, resumed: false,
      reason: "No fresh-runtime acknowledgement. Check this agent's native reload diagnostics." }), 2000);
    const receipt = await ticket.result.promise;
    clearTimeout(timer);
    if (handoffs.get(old.sessionId) === handoff) handoffs.delete(old.sessionId);
    return receipt;
  }

  function reserve(ctx: ExtensionContext, scope: Scope, resume = true, ownToolCallId?: string, id = randomUUID(), expiresAt = Date.now() + PREPARATION_TIMEOUT): Ticket {
    if (!alive) throw new Error("Runtime is shutting down.");
    if (coordinating || pending) throw new Error("Another reload is already pending.");
    if (ownToolCallId) safety(ctx, ownToolCallId); else inputSafety(ctx);
    const original: OriginalState = blocked || uiPrompts ? "waiting" : ctx.isIdle() ? "idle" : "active";
    const old = identity(ctx);
    const operation: Operation = { requestId: id, target: old, phase: "queued", expiresAt, original };
    for (const [key, value] of operations) if (Date.now() > value.expiresAt + PREPARATION_TIMEOUT) operations.delete(key);
    if (operations.size >= 64) throw new Error("Too many retained reload operations. Try after their bounded receipt expiry.");
    operations.set(id, operation);
    const ticket: Ticket = { id, sessionId: old.sessionId, generation, scope, resume, original, operation,
      originalSignal: ctx.signal, expiresAt, stopped: false, result: Promise.withResolvers<Result>() };
    pending = ticket;
    return ticket;
  }

  async function fleetStatus(): Promise<Reply[]> {
    return Promise.all(peers(directory()).map(path => contact(path, { requestId: randomUUID(), action: "status" }, 2000)
      .catch(error => ({ requestId: "", error: (error as Error).message }))));
  }

  async function peerRequest(root: string, path: string, caller: Ticket, ctx: ExtensionContext): Promise<Reply> {
    const id = randomUUID();
    let status: Reply;
    try { status = await contact(path, { requestId: randomUUID(), action: "status" }, 2000); }
    catch (error) { return { requestId: id, error: (error as Error).message }; }
    if (!status.identity || status.protocol !== PROTOCOL) return { ...status, error: "This peer has no cooperative reload handler. A safe initial native reload is required." };
    const target = status.identity;
    const deadline = Date.now() + PREPARATION_TIMEOUT;
    try {
      valid(ctx, caller);
      const accepted = await contact(path, { requestId: id, action: "prepare", target, resume: caller.resume, expiresAt: deadline }, 2000);
      if (accepted.error) return accepted;
      if (!sameIdentity(accepted.operation?.target, target) || accepted.operation?.requestId !== id) return { ...accepted, error: "Invalid preparation acknowledgement. Do not retry." };
    } catch { /* Reconcile only status after an uncertain dispatch. Never resend. */ }
    while (Date.now() <= deadline + STOP_TIMEOUT + 2000) {
      if (!alive || caller.cancelled || caller.generation !== generation) return { requestId: id, identity: target,
        error: "The coordinator ended or changed. The accepted peer has an independent bounded outcome. Reconcile status, do not resend." };
      const candidates = [...new Set([path, ...peers(root).filter(candidate => candidate.split("/").at(-1)?.startsWith(`${target.pid}-`))])];
      for (const candidate of candidates) {
        const remaining = deadline + STOP_TIMEOUT + 2000 - Date.now();
        if (remaining <= 0) break;
        const reply = await contact(candidate, { requestId: randomUUID(), action: "status", operationId: id }, Math.min(2000, remaining)).catch(() => undefined);
        if (!reply || reply.identity?.sessionId !== target.sessionId || !sameIdentity(reply.operation?.target, target) || reply.operation?.requestId !== id) continue;
        if (reply.operation.result) return { ...reply, result: reply.operation.result };
      }
      // Cancelled caller input never authorizes another dispatch. Accepted peers
      // still finish their independently bounded operation and report its result.
      await new Promise<void>(resolve => setTimeout(resolve, 500));
    }
    return { requestId: id, identity: target, error: "No confirmed peer outcome before expiry. Do not repeat the request." };
  }

  async function runRequest(ctx: ExtensionCommandContext, ticket: Ticket, peer = false): Promise<void> {
    if (ticket.dispatched) throw new Error("This reload request is already running.");
    ticket.dispatched = true;
    let root: string | undefined, unlock: (() => void) | undefined;
    const receipts: Reply[] = [];
    try {
      if (ticket.toolCallId) await finishTool(ctx, ticket, true);
      else if (ticket.legacy) safety(ctx);
      else await prepare(ctx, ticket);
      if (ticket.scope === "all" && !peer) {
        valid(ctx, ticket);
        safety(ctx);
        root = directory();
        unlock = coordinatorLock(root);
        coordinating = true;
        // Peers prepare and reload independently. One busy peer does not hold
        // every safe peer behind its model/tool turn.
        receipts.push(...await Promise.all(peers(root).filter(path => path !== socketPath).map(path => peerRequest(root!, path, ticket, ctx))));
        const reloaded = receipts.filter(reply => reply.result?.status === "reloaded").length;
        const resumed = receipts.filter(reply => reply.result?.resumed).length;
        ticket.summary = `Pi Reload peers: ${reloaded} reloaded, ${resumed} resumed, ${receipts.length - reloaded} need attention or are unconfirmed`;
        ctx.ui.notify([ticket.summary, ...receipts.flatMap(reply => {
          const reason = reply.error ?? reply.result?.reason;
          return reason ? [`${reply.identity ? `PID ${reply.identity.pid}` : "Unavailable peer"}: ${reason}`] : [];
        })].join("\n"), reloaded === receipts.length ? "info" : "warning");
      }
      valid(ctx, ticket);
    } catch (error) {
      const own = alive ? fail(ctx, ticket, error) : ticket.operation?.result ?? complete(ticket, { ...(ticket.operation?.target ?? { pid: process.pid, instanceId, sessionId: ticket.sessionId }), status: "unknown", stopped: ticket.stopped, resumed: false, reason: "The runtime ended before a correlated reload completed." });
      unlock?.(); coordinating = false;
      if (root) writeFileSync(join(root, "last-result.json"), JSON.stringify({ at: new Date().toISOString(), requestId: ticket.id, resume: ticket.resume, peers: receipts, caller: own }, null, 2), { mode: 0o600 });
      if (alive) ctx.ui.notify(`Pi Reload skipped: ${(error as Error).message}`, "warning");
      return;
    }
    const own = await localReload(ctx, ticket);
    // No old ctx/pi calls after reload. Keep the lock until the caller settles.
    unlock?.();
    if (root) writeFileSync(join(root, "last-result.json"), JSON.stringify({ at: new Date().toISOString(), requestId: ticket.id, resume: ticket.resume, peers: receipts, caller: own }, null, 2), { mode: 0o600 });
  }

  pi.events.on("herdr:blocked", (event: { active?: boolean }) => { blocked = Math.max(0, blocked + (event.active ? 1 : -1)); });
  pi.on("agent_start", (_event, ctx) => {
    running = true;
    if (pending?.preparation) pending.preparationSignal = ctx.signal;
  });
  pi.on("agent_settled", () => { running = false; });
  pi.on("ui_prompt_start", () => { if (!menuOpen) uiPrompts++; });
  pi.on("ui_prompt_end", () => { if (!menuOpen) uiPrompts = Math.max(0, uiPrompts - 1); });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const calls = event.message.content.filter(block => block.type === "toolCall");
    if (calls.length) {
      batchPending = true;
      batchQuestionsOnly = calls.every(call => call.name === "ask_user_question" || (call.name === "ask_user" && call.arguments.mode === "blocking"));
    }
  });
  pi.on("turn_end", () => { batchPending = false; batchQuestionsOnly = false; });
  pi.on("tool_result", event => {
    const ticket = pending;
    if (!ticket?.questionCalls?.has(event.toolCallId)) return;
    ticket.questionCalls.delete(event.toolCallId);
    const details = event.details as { status?: string; reason?: string } | undefined;
    if (details?.status === "answered" || details?.reason === "user") {
      ticket.questionCancelled = false;
      ticket.original = "active";
      if (ticket.operation) ticket.operation.original = "active";
      return;
    }
    // Native cancellation can allow an ordinary follow-up before idle. Put the
    // reload-specific explanation in that exact result, before any such request.
    return { content: [...event.content, { type: "text" as const,
      text: "[Pi Reload system message] This question wait was interrupted only by Pi Reload, not by the user. No answer or approval is implied. Preserve the unresolved question in the conversation. Do not assume consent, do unrelated work, or re-ask before the existing reload preparation ends. A preparation message will provide this operation's readiness instructions." }] };
  });
  pi.on("tool_execution_start", event => {
    activeTools.set(event.toolCallId, { name: event.toolName,
      blockingQuestion: event.toolName === "ask_user_question" || (event.toolName === "ask_user" && event.args?.mode === "blocking") });
  });
  pi.on("tool_execution_end", event => {
    activeTools.delete(event.toolCallId);
    if (pending?.toolCallId === event.toolCallId) {
      pending.reported!.resolve(event.toolName === "reload-pi" && !event.isError && event.result?.terminate === true
        && event.result?.details?.requestId === pending.id);
    }
  });
  pi.on("session_tree", () => { generation++; });
  pi.on("input", event => { if (event.source !== "extension") generation++; });
  pi.on("session_shutdown", event => {
    alive = false;
    if (pending && (event.reason !== "reload" || !handoffs.has(pending.sessionId))) complete(pending, {
      ...(pending.operation?.target ?? { pid: process.pid, instanceId, sessionId: pending.sessionId }),
      status: event.reason === "reload" ? "unknown" : "skipped", stopped: pending.stopped, resumed: false,
      reason: event.reason === "reload" ? "An unrelated reload ended this operation. No correlated completion exists." : "Session shut down." });
    server?.close();
    if (socketPath) { try { unlinkSync(socketPath); } catch { /* Already closed. */ } }
  });
  pi.on("session_start", async (event, ctx) => {
    if (current && current.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) generation++;
    current = ctx;
    if (ctx.mode !== "tui") return;
    const root = directory();
    if (!server) {
      socketPath = join(root, `${process.pid}-${instanceId}.sock`);
      if (Buffer.byteLength(socketPath) > 100) throw new Error("Pi Reload socket path is too long.");
      server = createServer(socket => {
        let text = "", handled = false;
        socket.setTimeout(TIMEOUT, () => socket.destroy());
        socket.on("error", () => {});
        socket.on("data", chunk => {
          if (handled) return;
          text += chunk.toString("utf8");
          if (Buffer.byteLength(text) > LIMIT) return socket.destroy();
          if (!text.includes("\n")) return;
          handled = true;
          let request: Request;
          try { request = JSON.parse(text.split("\n", 1)[0]); } catch { socket.destroy(); return; }
          if (!/^[a-f0-9-]{36}$/.test(request.requestId)) { socket.destroy(); return; }
          const reply: Reply = { requestId: request.requestId };
          try {
            if (!alive || !current) throw new Error("Runtime is shutting down.");
            reply.identity = identity(current);
            Object.assign(reply, loaded, { protocol: PROTOCOL });
            if (request.action === "status") {
              reply.busy = !current.isIdle();
              reply.operation = request.operationId ? operations.get(request.operationId) : pending?.operation;
            } else if (request.action === "prepare" || request.action === "reload") {
              if (!sameIdentity(request.target, reply.identity)) throw new Error("Target identity changed.");
              if (operations.has(request.requestId)) throw new Error("This operation already exists. Reconcile status, do not resend.");
              // A pre-0.4 coordinator may bootstrap a safe peer. It cannot force
              // cooperative preparation or bypass the older safety contract.
              if (request.action === "reload") safety(current);
              const expiresAt = request.expiresAt ?? Date.now() + (request.action === "reload" ? 25_000 : PREPARATION_TIMEOUT);
              if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + PREPARATION_TIMEOUT) throw new Error("Invalid preparation deadline.");
              const ticket = reserve(current, "self", request.resume !== false, undefined, request.requestId, expiresAt);
              ticket.legacy = request.action === "reload";
              reply.operation = ticket.operation;
              pi.sendUserMessage(`/reload+ @${ticket.id}`, { expandPromptTemplates: true });
              if (request.action === "reload") {
                // Only the private legacy bootstrap keeps its short result reply.
                void ticket.result.promise.then(receipt => socket.end(`${JSON.stringify({ ...reply, result: receipt })}\n`));
                return;
              }
            } else throw new Error("Invalid operation.");
          } catch (error) { reply.error = (error as Error).message; }
          socket.end(`${JSON.stringify(reply)}\n`);
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(socketPath, () => { chmodSync(socketPath!, 0o600); resolve(); });
      });
      server.unref();
    }
    if (event.reason !== "reload") return;
    const id = identity(ctx);
    let handoff = handoffs.get(id.sessionId);
    if (!handoff) {
      const legacy = (globalThis as typeof globalThis & { [LEGACY_HANDOFFS]?: Map<string, LegacyHandoff> })[LEGACY_HANDOFFS];
      const previous = legacy?.get(id.sessionId);
      if (previous?.request.sessionId === id.sessionId && previous.previousInstanceId !== instanceId) {
        legacy!.delete(id.sessionId);
        const bootstrap = ctx.sessionManager.getBranch().some(entry => {
          if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "self_reload" || entry.message.isError) return false;
          const details = entry.message.details as { status?: string; requestId?: string } | undefined;
          return details?.status === "queued" && details.requestId === previous.request.id;
        });
        const ticket: Ticket = { id: previous.request.id, sessionId: id.sessionId, generation: 0, expiresAt: Date.now() + 25_000,
          stopped: Boolean(bootstrap && previous.request.signal && !previous.request.signal.aborted), resume: previous.request.resume, result: Promise.withResolvers<Result>() };
        previous.request.signal?.addEventListener("abort", () => { ticket.cancelled = true; }, { once: true });
        handoff = { ticket, old: { ...id, instanceId: previous.previousInstanceId }, finished: previous.finished };
      }
    }
    if (!handoff || handoff.old.instanceId === instanceId) return;
    handoffs.delete(id.sessionId);
    const claimed = handoff;
    pending = claimed.ticket;
    void claimed.finished.then(finished => {
      pending = undefined;
      if (!finished || !alive) {
        complete(claimed.ticket, { ...id, status: "unknown", stopped: claimed.ticket.stopped, resumed: false, reason: "Native reload did not complete." });
        return;
      }
      const ticket = { ...claimed.ticket, generation: 0 };
      const resumed = wake(ctx, ticket);
      const receipt = result(ctx, ticket, "reloaded", ticket.resume === false ? "Continuation disabled for this operation."
        : ticket.stopped && !resumed && !ticket.taskComplete ? "Continuation skipped because new input, cancellation, or work is present." : undefined, resumed);
      ctx.ui.notify(`${ticket.summary ?? "Pi Reload"}: this agent reloaded${resumed ? " and returned to its prior task state" : "; no task continuation started"}. Check native reload diagnostics.`, "info");
      complete(claimed.ticket, receipt);
    }).catch(() => complete(claimed.ticket, { ...id, status: "unknown", stopped: claimed.ticket.stopped, resumed: false, reason: "Fresh-runtime acknowledgement failed." }));
  });

  pi.registerCommand("reload+", {
    description: "Open Pi Reload: this session, local fleet, continuation policy, and status",
    async handler(args, ctx) {
      const ticket = pending;
      if (ticket && args === `@${ticket.id}`) { await runRequest(ctx, ticket, ticket.scope === "self"); return; }
      if (args.trim()) throw new Error("Use /reload+ without arguments, then select an option.");
      if (ctx.mode !== "tui") throw new Error("Pi Reload requires interactive Pi.");
      if (blocked || uiPrompts) throw new Error("Resolve this session's open prompt before opening the reload menu.");
      const choices = ["Reload this session", "Reload this session, do not resume", "Reload all local sessions", "Reload all local sessions, do not resume", "Status and pending operations"];
      menuOpen = true;
      let selected: string | undefined;
      try { selected = await ctx.ui.select("Pi Reload", choices); } finally { menuOpen = false; }
      if (!selected) return;
      if (selected === choices[4]) {
        const live = await fleetStatus();
        ctx.ui.notify(`Pi Reload ${loaded.version}, instance ${instanceId}, SHA-256 ${loaded.sha256}\n${live.map(reply => reply.identity
          ? `PID ${reply.identity.pid}: ${reply.version}, ${reply.busy ? "working" : "idle"}${reply.operation ? `, ${reply.operation.phase}` : ""}${reply.error ? `, ${reply.error}` : ""}`
          : `Unavailable peer: ${reply.error}`).join("\n")}\nUnloaded and noninteractive sessions are not participants.`, "info");
        return;
      }
      const index = choices.indexOf(selected);
      if (index < 0) throw new Error("Unknown reload menu option.");
      await runRequest(ctx, reserve(ctx, index >= 2 ? "all" : "self", index % 2 === 0));
    },
  });

  pi.registerTool({
    name: "reload-pi",
    label: "Pi Reload",
    description: "Reload interactive Pi through its native handler. Default scope=self refreshes this session. Use scope=all only for an approved local rollout after installing the update. Reload does not install, build, or repair unrelated failures. action=status inspects loaded identities and pending preparation. Save task state and finish useful jobs. Call reload alone as the final action. Its terminating result is saved before reload. Fleet peers prepare independently, preserving tools and useful resources. A blocked peer can receive a bounded preparation turn. Only those preparation agents use action=ready with the exact requestId, alone, after as many preparation calls as needed. ready acknowledges the existing operation, never starts another reload. Report outcome=needs-attention when a useful resource must remain, or finished when the original task is complete. Only original unfinished tasks interrupted by this operation resume once. Idle preparation does not authorize continuation. Reload-cancelled questions receive only instructions to re-ask, never an answer or approval. resume=false disables continuation for the whole operation, including peers. Drafts, queued input, unsafe resources, new input, tree/session changes, and expiry prevent reload. A queued result is not completion. Check fresh loaded status and native diagnostics. Never retry an uncertain reload.",
    promptSnippet: "Reload this Pi session or an approved local fleet; acknowledge assigned preparation without starting another reload",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("reload"), Type.Literal("status"), Type.Literal("ready")], { default: "reload" })),
      scope: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("all")], { default: "self" })),
      resume: Type.Optional(Type.Boolean({ default: true, description: "Resume original unfinished work once. False keeps every participant idle. Ignored for status/ready." })),
      requestId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$", description: "Exact operation ID from a Pi Reload preparation message. Required for ready." })),
      outcome: Type.Optional(Type.Union([Type.Literal("ready"), Type.Literal("finished"), Type.Literal("needs-attention")], { default: "ready", description: "Preparation outcome. finished also declares the original task complete." })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Explain why preparation needs attention." })),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const scope = params.scope ?? "self";
      if (params.action === "status") {
        const details = { ...loaded, pending: pending?.operation ?? null, mode: ctx.mode, scope,
          ...(scope === "all" ? { participants: await fleetStatus() } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
      const assistant = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
      if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Reload/readiness requires a direct assistant tool call.");
      const calls = assistant.message.content.filter(block => block.type === "toolCall");
      if (calls.length !== 1 || calls[0].id !== toolCallId || calls[0].name !== "reload-pi") throw new Error("Call reload-pi alone, not in a mixed or nested tool batch.");
      if (!running || ctx.isIdle() || !ctx.signal || ctx.signal.aborted || signal?.aborted) throw new Error("The requesting run is absent or already stopping.");
      if (params.action === "ready") {
        const ticket = pending;
        if (!ticket?.preparation || ticket.operation?.phase !== "preparing" || params.requestId !== ticket.id) throw new Error("No matching preparation operation. Do not initiate a replacement reload.");
        valid(ctx, ticket);
        if (params.outcome === "needs-attention") {
          if (!params.reason) throw new Error("Give a reason when preparation needs attention.");
          ticket.operation.reason = params.reason;
          ticket.acknowledgement!.resolve(false);
          return { content: [{ type: "text", text: "Reload needs attention. No reload or approval is implied." }], details: { requestId: ticket.id, status: "needs-attention" }, terminate: true };
        }
        safety(ctx, toolCallId);
        ticket.taskComplete = params.outcome === "finished";
        ticket.toolCallId = toolCallId;
        ticket.reported = Promise.withResolvers<boolean>();
        phase(ticket, "ready");
        ticket.acknowledgement!.resolve(true);
        return { content: [{ type: "text", text: "Readiness acknowledged for the existing operation. This result and run must settle before reload. Do not start another reload." }], details: { requestId: ticket.id, status: "ready" }, terminate: true };
      }
      if (params.requestId || params.outcome || params.reason) throw new Error("Preparation fields apply only to action=ready.");
      const ticket = reserve(ctx, scope, params.resume !== false, toolCallId);
      ticket.toolCallId = toolCallId;
      ticket.reported = Promise.withResolvers<boolean>();
      const cancel = () => { ticket.cancelled = true; };
      ctx.signal.addEventListener("abort", cancel, { once: true });
      if (signal && signal !== ctx.signal) signal.addEventListener("abort", cancel, { once: true });
      try { pi.sendUserMessage(`/reload+ @${ticket.id}`, { expandPromptTemplates: true }); }
      catch (error) { fail(ctx, ticket, error); throw error; }
      return { content: [{ type: "text", text: `Pi Reload (${scope}) queued, not completed. The native command waits for this exact tool result and run to settle, then reloads peers before the caller. ${ticket.resume ? "Only original unfinished tasks may resume once." : "Every participant will stay idle after reload."} No further action is due in this run.` }],
        details: { status: "queued", requestId: ticket.id, scope, resume: ticket.resume, ...loaded }, terminate: true };
    },
  });
}
