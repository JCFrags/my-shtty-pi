import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERSION = "0.3.0";
const HANDOFFS = Symbol.for("pi-reload-all.handoffs.v1");
const TIMEOUT = 30_000;
const LIMIT = 8192;
interface Identity { pid: number; instanceId: string; sessionId: string }
interface Result extends Identity { status: "reloaded" | "skipped" | "unknown"; stopped: boolean; resumed: boolean; reason?: string }
interface Request { requestId: string; action: "status" | "reload"; target?: Identity }
interface Reply { requestId: string; identity?: Identity; version?: string; sha256?: string; busy?: boolean; result?: Result; error?: string }
type Scope = "self" | "all";
interface Ticket {
  id: string; sessionId: string; generation: number; expiresAt: number; stopped: boolean;
  scope?: Scope; resume?: boolean; cancelled?: boolean; started?: boolean; dispatched?: boolean; summary?: string;
  toolCallId?: string; reported?: ReturnType<typeof Promise.withResolvers<boolean>>;
  result: ReturnType<typeof Promise.withResolvers<Result>>;
}
interface Handoff { ticket: Ticket; old: Identity; finished: Promise<boolean> }
interface LegacyHandoff {
  request: { id: string; sessionId: string; resume: boolean; signal?: AbortSignal };
  previousInstanceId: string; finished: Promise<boolean>;
}
const LEGACY_HANDOFFS = Symbol.for("pi-self-reload.handoffs.v1");
const shared = globalThis as typeof globalThis & { [HANDOFFS]?: Map<string, Handoff> };
const handoffs = shared[HANDOFFS] ??= new Map<string, Handoff>();

function directory(): string {
  if (!process.getuid) throw new Error("/reload-all needs local Unix sockets.");
  const root = process.env.PI_RELOAD_ALL_DIR ?? join(tmpdir(), `pi-reload-all-${process.getuid()}`);
  if (!isAbsolute(root)) throw new Error("PI_RELOAD_ALL_DIR must be absolute.");
  mkdirSync(root, { mode: 0o700, recursive: true });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("The reload-all directory must be a private, owned directory (mode 0700).");
  }
  return root;
}

// One request per connection. A timeout is uncertain, not permission to retry.
export function contact(path: string, request: Request): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = "";
    const timer = setTimeout(() => finish(new Error("Peer timed out; do not repeat an uncertain reload.")), TIMEOUT);
    function finish(error?: Error, reply?: Reply) {
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
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > LIMIT) throw new Error("Unsafe reload-all lock.");
    throw new Error("Another /reload-all is in progress, or a stopped coordinator left fleet.lock. Inspect its owner before removing a stale lock.");
  }
  return () => { if (readFileSync(path, "utf8") === owner) unlinkSync(path); };
}

export default function reloadAll(pi: ExtensionAPI): void {
  const instanceId = randomUUID();
  const loaded = { version: VERSION, instanceId, sha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex") };
  let alive = true;
  let generation = 0;
  let blocked = 0;
  let uiPrompts = 0;
  let running = false;
  const activeTools = new Set<string>();
  let coordinating = false;
  let pending: Ticket | undefined;
  let server: Server | undefined;
  let socketPath: string | undefined;
  let current: ExtensionContext | undefined;

  const identity = (ctx: ExtensionContext): Identity => ({ pid: process.pid, instanceId, sessionId: ctx.sessionManager.getSessionId() });
  const result = (ctx: ExtensionContext, ticket: Ticket, status: Result["status"], reason?: string, resumed = false): Result =>
    ({ ...identity(ctx), status, stopped: ticket.stopped, resumed, ...(reason ? { reason } : {}) });

  function safety(ctx: ExtensionContext, ownToolCallId?: string): void {
    if (ctx.mode !== "tui") throw new Error("Pi Reload requires interactive Pi.");
    if (blocked || uiPrompts) throw new Error("Waiting for a user answer or approval.");
    if (ctx.hasPendingMessages()) throw new Error("Queued input is present.");
    if (ctx.ui.getEditorText()) throw new Error("An unsent editor draft is present.");
    // Do not abort a tool with a possibly incomplete side effect. A later call can
    // reload this peer at its next model-stream boundary instead.
    if ([...activeTools].some(id => id !== ownToolCallId)) throw new Error("A tool is executing; preserve its result first.");
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
    if (invalid || busy) throw new Error("Managed jobs or shell sessions are not ready for reload.");
    if (!replies && pi.getAllTools().some(tool => ["process", "grounded_process"].includes(tool.name))) {
      throw new Error("The process owner has no readiness response.");
    }
  }

  function wake(ctx: ExtensionContext, ticket: Ticket): boolean {
    if (!ticket.stopped || ticket.resume === false || ticket.cancelled || !alive || blocked || uiPrompts || Date.now() > ticket.expiresAt || ticket.generation !== generation || identity(ctx).sessionId !== ticket.sessionId
      || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText()) return false;
    pi.sendMessage({
      customType: "reload-all-continuation",
      content: "Pi Reload loaded a fresh runtime and the native reload handler returned. This operation stopped your active run. Continue only the previously authorized unfinished work from the existing conversation and saved task state. Check self_reload status and native reload diagnostics. Do not repeat an uncertain side effect, reload again because of this message, or restart a completed task. This message grants no new authorization.",
      display: true,
      details: { requestId: ticket.id, instanceId },
    }, { triggerTurn: true });
    return true;
  }

  async function localReload(ctx: ExtensionCommandContext, ticket: Ticket): Promise<Result> {
    if (ticket.started) return ticket.result.promise;
    ticket.started = true;
    const old = identity(ctx);
    try {
      safety(ctx);
      if (!alive || ticket.cancelled || Date.now() > ticket.expiresAt || ticket.generation !== generation || old.sessionId !== ticket.sessionId) throw new Error("Request cancelled, expired, or session changed.");
      if (!ctx.isIdle()) {
        const signal = ctx.signal;
        if (!running || !signal || signal.aborted) throw new Error("The operation is already stopping or is not an active agent run.");
        // No await between the current state check and native abort. Do not use
        // Herdr's earlier working/done snapshot to decide who needs a wake.
        ctx.abort();
        ticket.stopped = signal.aborted;
        if (!ticket.stopped) throw new Error("Native interruption was not confirmed.");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ctx.waitForIdle(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native stop did not settle in time.")), 15_000);
        })]);
      } finally { clearTimeout(timer); }
      safety(ctx);
      if (!alive || ticket.cancelled || Date.now() > ticket.expiresAt || ticket.generation !== generation || identity(ctx).sessionId !== old.sessionId || !ctx.isIdle()) throw new Error("Cancellation, expiry, new input, work, or a session change prevented reload.");
    } catch (error) {
      pending = undefined;
      const resumed = alive && wake(ctx, ticket);
      const receipt: Result = { ...old, status: "skipped", stopped: ticket.stopped, resumed, reason: (error as Error).message };
      ticket.result.resolve(receipt);
      return receipt;
    }
    const completion = Promise.withResolvers<boolean>();
    const handoff = { ticket, old, finished: completion.promise };
    handoffs.set(old.sessionId, handoff);
    try {
      await ctx.reload();
      // Only plain handoff data is used after runtime invalidation.
      completion.resolve(true);
    } catch {
      completion.resolve(false);
    }
    // If the package disappeared or native reload returned without a new factory,
    // do not invent success or send a continuation through a stale context.
    const timer = setTimeout(() => ticket.result.resolve({ ...old, status: "unknown", stopped: ticket.stopped, resumed: false,
      reason: "No fresh-runtime acknowledgement. Check this agent's native reload diagnostics." }), 2000);
    const receipt = await ticket.result.promise;
    clearTimeout(timer);
    if (handoffs.get(old.sessionId) === handoff) handoffs.delete(old.sessionId);
    return receipt;
  }

  function reserve(ctx: ExtensionContext, scope: Scope, resume = true, ownToolCallId?: string): Ticket {
    if (!alive) throw new Error("Runtime is shutting down.");
    if (coordinating || pending) throw new Error("Another reload is already pending.");
    safety(ctx, ownToolCallId);
    const ticket: Ticket = { id: randomUUID(), sessionId: identity(ctx).sessionId, generation, scope, resume,
      expiresAt: Date.now() + 25_000, stopped: false, result: Promise.withResolvers<Result>() };
    pending = ticket;
    return ticket;
  }

  async function prepareTool(ctx: ExtensionCommandContext, ticket: Ticket): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Preserve the tool result before reloading. Only a sole, successfully
      // reported terminating call can own this run's continuation.
      await Promise.race([(async () => {
        if (!await ticket.reported!.promise) throw new Error("The reload tool did not report a terminating result.");
        await ctx.waitForIdle();
      })(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The reload tool's run did not settle in time.")), 15_000);
      })]);
      safety(ctx);
      if (!alive || ticket.cancelled || Date.now() > ticket.expiresAt || ticket.generation !== generation
        || identity(ctx).sessionId !== ticket.sessionId || !ctx.isIdle()) throw new Error("The reload request was cancelled, expired, or changed.");
      ticket.stopped = true;
      return true;
    } catch (error) {
      pending = undefined;
      ticket.result.resolve(result(ctx, ticket, "skipped", (error as Error).message));
      ctx.ui.notify(`Pi Reload skipped: ${(error as Error).message}`, "warning");
      return false;
    } finally { clearTimeout(timer); }
  }

  async function fleetStatus() {
    const replies = await Promise.all(peers(directory()).map(path => contact(path, { requestId: randomUUID(), action: "status" }).catch(() => undefined)));
    return replies.filter((reply): reply is Reply & { identity: Identity } => Boolean(reply?.identity));
  }

  async function runRequest(ctx: ExtensionCommandContext, ticket: Ticket): Promise<void> {
    if (ticket.dispatched) throw new Error("This reload request is already running.");
    ticket.dispatched = true;
    if (ticket.toolCallId && !await prepareTool(ctx, ticket)) return;
    let root: string | undefined;
    const receipts: Array<Reply | { error: string }> = [];
    try {
      root = ticket.scope === "all" ? directory() : undefined;
      if (root) {
        safety(ctx);
        if (ticket.cancelled || ticket.generation !== generation || identity(ctx).sessionId !== ticket.sessionId) throw new Error("The fleet request was cancelled or changed.");
        const unlock = coordinatorLock(root);
        coordinating = true;
        try {
          for (const path of peers(root).filter(path => path !== socketPath)) {
            try {
              const status = await contact(path, { requestId: randomUUID(), action: "status" });
              if (!status.identity) { receipts.push(status); continue; }
              receipts.push(await contact(path, { requestId: randomUUID(), action: "reload", target: status.identity }));
            } catch (error) { receipts.push({ error: (error as Error).message }); }
          }
        } finally { unlock(); coordinating = false; }
        const reloaded = receipts.filter(reply => "result" in reply && reply.result?.status === "reloaded").length;
        const resumed = receipts.filter(reply => "result" in reply && reply.result?.resumed).length;
        ticket.summary = `Reload-all peers: ${reloaded} reloaded, ${resumed} resumed, ${receipts.length - reloaded} skipped or unconfirmed`;
        const details = receipts.flatMap(reply => {
          const note = "error" in reply && reply.error ? reply.error : "result" in reply ? reply.result?.reason : undefined;
          const id = "identity" in reply ? reply.identity : undefined;
          return note ? [`${id ? `PID ${id.pid}` : "Unavailable peer"}: ${note}`] : [];
        });
        ctx.ui.notify([ticket.summary, ...details].join("\n"), reloaded === receipts.length ? "info" : "warning");
      }
    } catch (error) {
      pending = undefined;
      ticket.result.resolve(result(ctx, ticket, "skipped", (error as Error).message));
      throw error;
    }
    // Peer deadlines do not consume the caller's own native-stop allowance.
    ticket.expiresAt = Date.now() + 25_000;
    const own = await localReload(ctx, ticket);
    // Only plain receipts and captured paths are used after invalidation.
    if (root) writeFileSync(join(root, "last-result.json"), JSON.stringify({ at: new Date().toISOString(), peers: receipts, caller: own }, null, 2), { mode: 0o600 });
  }

  pi.events.on("herdr:blocked", (event: { active?: boolean }) => { blocked = Math.max(0, blocked + (event.active ? 1 : -1)); });
  pi.on("agent_start", () => { running = true; });
  pi.on("agent_settled", () => { running = false; });
  pi.on("ui_prompt_start", () => { uiPrompts++; });
  pi.on("ui_prompt_end", () => { uiPrompts = Math.max(0, uiPrompts - 1); });
  pi.on("tool_execution_start", event => { activeTools.add(event.toolCallId); });
  pi.on("tool_execution_end", event => {
    activeTools.delete(event.toolCallId);
    if (pending?.toolCallId === event.toolCallId) {
      pending.reported!.resolve(event.toolName === "self_reload" && !event.isError && event.result?.terminate === true
        && event.result?.details?.requestId === pending.id);
    }
  });
  pi.on("session_tree", () => { generation++; });
  pi.on("input", event => { if (event.source !== "extension") generation++; });
  pi.on("session_shutdown", () => {
    alive = false;
    server?.close();
    if (socketPath) { try { unlinkSync(socketPath); } catch { /* Already closed. */ } }
  });
  pi.on("session_start", async (event, ctx) => {
    current = ctx;
    if (ctx.mode !== "tui") return;
    const root = directory();
    socketPath = join(root, `${process.pid}-${instanceId}.sock`);
    if (Buffer.byteLength(socketPath) > 100) throw new Error("Reload-all socket path is too long.");
    server = createServer(socket => {
      let text = "", handled = false;
      socket.setTimeout(TIMEOUT, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", async chunk => {
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
          reply.version = loaded.version;
          reply.sha256 = loaded.sha256;
          if (request.action === "status") reply.busy = !current.isIdle();
          else if (request.action === "reload") {
            if (pending || coordinating) throw new Error("Another reload is in progress.");
            if (!request.target || request.target.pid !== process.pid || request.target.instanceId !== instanceId
              || request.target.sessionId !== reply.identity.sessionId) throw new Error("Target identity changed.");
            safety(current);
            const ticket: Ticket = { id: request.requestId, sessionId: reply.identity.sessionId, generation, expiresAt: Date.now() + 25_000, stopped: false, result: Promise.withResolvers<Result>() };
            pending = ticket;
            pi.sendUserMessage(`/reload-all --agent ${ticket.id}`, { expandPromptTemplates: true });
            reply.result = await ticket.result.promise;
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
    if (event.reason !== "reload") return;
    const id = identity(ctx);
    let handoff = handoffs.get(id.sessionId);
    if (!handoff) {
      // One-time compatibility for a loaded 0.2.0 tool activating this extension.
      // Consume its plain handoff, not its old implementation or context.
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
    pending = claimed.ticket; // Refuse another reload until this native handler returns.
    void claimed.finished.then(finished => {
      pending = undefined;
      if (!finished || !alive) {
        claimed.ticket.result.resolve({ ...id, status: "unknown", stopped: claimed.ticket.stopped, resumed: false, reason: "Native reload did not complete." });
        return;
      }
      // The previous runtime's branch generation is not a new runtime's counter.
      const ticket = { ...claimed.ticket, generation: 0 };
      const resumed = wake(ctx, ticket);
      const receipt = result(ctx, ticket, "reloaded", ticket.stopped && !resumed ? ticket.resume === false ? "Caller continuation disabled." : "Continuation skipped because new input, cancellation, or work is present." : undefined, resumed);
      ctx.ui.notify(`${ticket.summary ?? "Pi Reload"}: this agent reloaded${resumed ? " and resumed" : "; no new work started"}. Check native reload diagnostics.`, "info");
      claimed.ticket.result.resolve(receipt);
    }).catch(() => claimed.ticket.result.resolve({ ...id, status: "unknown", stopped: claimed.ticket.stopped, resumed: false, reason: "Fresh-runtime acknowledgement failed." }));
  });

  function command(scope: Scope) {
    return async (args: string, ctx: ExtensionCommandContext) => {
      const argument = args.trim();
      if (argument.startsWith("--agent ") || argument.startsWith("--request ")) {
        const ticket = pending;
        if (!ticket || ![`--agent ${ticket.id}`, `--request ${ticket.id}`].includes(argument)) throw new Error("Invalid reload request.");
        await runRequest(ctx, ticket);
        return;
      }
      if (argument === "status") {
        if (scope === "self") {
          ctx.ui.notify(`Pi Reload ${loaded.version}, instance ${instanceId}, SHA-256 ${loaded.sha256}, pending ${Boolean(pending)}`, "info");
        } else {
          const live = await fleetStatus();
          ctx.ui.notify(`Reload-all: ${live.length} participating local Pi agents.\n${live.map(reply => `PID ${reply.identity.pid}: ${reply.busy ? "working" : "idle"}`).join("\n")}\nExisting sessions need one initial safe /reload to participate.`, "info");
        }
        return;
      }
      if (argument && !(scope === "self" && argument === "--no-resume")) throw new Error(`Use /${scope === "self" ? "self-reload [--no-resume]" : "reload-all"}, or status.`);
      await runRequest(ctx, reserve(ctx, scope, argument !== "--no-resume"));
    };
  }

  pi.registerCommand("self-reload", {
    description: "Reload this Pi session safely; --no-resume stays idle, status shows loaded identity",
    handler: command("self"),
  });
  pi.registerCommand("reload-all", {
    description: "Reload local Pi agents; resume only stopped runs. status lists participating agents",
    handler: command("all"),
  });

  pi.registerTool({
    name: "self_reload",
    label: "Pi Reload",
    description: "Reload interactive Pi through its native reload handler. Default scope=self refreshes only your session when loaded extensions, tools, or other reloadable resources are stale or inconsistent after a correction. Use scope=all only for an approved local Pi extension rollout after the updated resources are installed, not merely pushed. Reload does not install, build, repair arbitrary environment faults, or fix a failed dependency. Use action=status to inspect loaded identity or fleet participants. Save task state and finish useful jobs first. Call reload alone as the final action. The sole tool result ends your run, then the common engine checks safety and reloads peers before the caller. Only runs stopped by this request can resume once after the native handler returns. Idle/completed peers stay idle. resume=false disables only the caller's continuation. Drafts, queued input, questions, other tools, managed jobs, and open shell sessions block or skip reload. Other extensions may stop their own resources. A queued result is not completion. After wake, check loaded status and native diagnostics. Do not retry an uncertain reload.",
    promptSnippet: "Safely reload this Pi session for stale tools, or explicitly reload local agents after installed updates",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("reload"), Type.Literal("status")], { default: "reload" })),
      scope: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("all")], { default: "self", description: "Current session by default. Use all only for an approved installed update rollout." })),
      resume: Type.Optional(Type.Boolean({ default: true, description: "Continue the requesting run once after reload. False keeps the caller idle. Never wakes idle peers. Ignored for status." })),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const scope = params.scope ?? "self";
      if (params.action === "status") {
        const details = { ...loaded, pending: Boolean(pending), mode: ctx.mode, scope,
          ...(scope === "all" ? { participants: await fleetStatus() } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
      if (pending || coordinating) throw new Error("Another reload is already pending.");
      const assistant = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
      if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Reload requires a direct assistant tool call.");
      const calls = assistant.message.content.filter(block => block.type === "toolCall");
      if (calls.length !== 1 || calls[0].id !== toolCallId || calls[0].name !== "self_reload") throw new Error("Call reload alone, not in a mixed or nested tool batch.");
      if (!running || ctx.isIdle() || !ctx.signal || ctx.signal.aborted || signal?.aborted) throw new Error("The requesting run is absent or already stopping.");
      const ticket = reserve(ctx, scope, params.resume !== false, toolCallId);
      ticket.toolCallId = toolCallId;
      ticket.reported = Promise.withResolvers<boolean>();
      const cancel = () => { ticket.cancelled = true; };
      ctx.signal.addEventListener("abort", cancel, { once: true });
      if (signal && signal !== ctx.signal) signal.addEventListener("abort", cancel, { once: true });
      try {
        // Explicit expansion dispatches a native command. Never await its idle
        // wait from execute(), because this tool keeps the run busy.
        pi.sendUserMessage(`/self-reload --request ${ticket.id}`, { expandPromptTemplates: true });
      } catch (error) { pending = undefined; throw error; }
      return {
        content: [{ type: "text", text: `Pi Reload (${scope}) queued, not completed. The native command will wait for this tool result and run to settle. ${ticket.resume ? "The fresh runtime can continue this requesting run once." : "The caller will stay idle."} No further action is due in this run.` }],
        details: { status: "queued", requestId: ticket.id, scope, resume: ticket.resume, ...loaded },
        terminate: true,
      };
    },
  });
}
