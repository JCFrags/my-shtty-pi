import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HANDOFFS = Symbol.for("pi-reload-all.handoffs.v1");
const TIMEOUT = 30_000;
const LIMIT = 8192;
interface Identity { pid: number; instanceId: string; sessionId: string }
interface Result extends Identity { status: "reloaded" | "skipped" | "unknown"; stopped: boolean; resumed: boolean; reason?: string }
interface Request { requestId: string; action: "status" | "reload"; target?: Identity }
interface Reply { requestId: string; identity?: Identity; busy?: boolean; result?: Result; error?: string }
interface Ticket { id: string; sessionId: string; generation: number; expiresAt: number; stopped: boolean; started?: boolean; result: ReturnType<typeof Promise.withResolvers<Result>>; summary?: string }
interface Handoff { ticket: Ticket; old: Identity; finished: Promise<boolean> }
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
  let alive = true;
  let generation = 0;
  let blocked = 0;
  let uiPrompts = 0;
  let running = false;
  let activeTools = 0;
  let coordinating = false;
  let pending: Ticket | undefined;
  let server: Server | undefined;
  let socketPath: string | undefined;
  let current: ExtensionContext | undefined;

  const identity = (ctx: ExtensionContext): Identity => ({ pid: process.pid, instanceId, sessionId: ctx.sessionManager.getSessionId() });
  const result = (ctx: ExtensionContext, ticket: Ticket, status: Result["status"], reason?: string, resumed = false): Result =>
    ({ ...identity(ctx), status, stopped: ticket.stopped, resumed, ...(reason ? { reason } : {}) });

  function safety(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") throw new Error("/reload-all requires interactive Pi.");
    if (blocked || uiPrompts) throw new Error("Waiting for a user answer or approval.");
    if (ctx.hasPendingMessages()) throw new Error("Queued input is present.");
    if (ctx.ui.getEditorText()) throw new Error("An unsent editor draft is present.");
    // Do not abort a tool with a possibly incomplete side effect. A later call can
    // reload this peer at its next model-stream boundary instead.
    if (activeTools) throw new Error("A tool is executing; preserve its result first.");
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
    if (!ticket.stopped || !alive || blocked || uiPrompts || Date.now() > ticket.expiresAt || ticket.generation !== generation || identity(ctx).sessionId !== ticket.sessionId
      || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText()) return false;
    pi.sendMessage({
      customType: "reload-all-continuation",
      content: "The user requested /reload-all. This operation interrupted your active run. Continue only the previously authorized unfinished work from the existing conversation and saved task state. Check the reload diagnostics. Do not repeat an uncertain side effect or restart a completed task. This message grants no new authorization.",
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
      if (!alive || Date.now() > ticket.expiresAt || ticket.generation !== generation || old.sessionId !== ticket.sessionId) throw new Error("Request expired or session changed.");
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
      if (!alive || Date.now() > ticket.expiresAt || ticket.generation !== generation || identity(ctx).sessionId !== old.sessionId || !ctx.isIdle()) throw new Error("Expiry, new input, work, or a session change prevented reload.");
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

  pi.events.on("herdr:blocked", (event: { active?: boolean }) => { blocked = Math.max(0, blocked + (event.active ? 1 : -1)); });
  pi.on("agent_start", () => { running = true; });
  pi.on("agent_settled", () => { running = false; });
  pi.on("ui_prompt_start", () => { uiPrompts++; });
  pi.on("ui_prompt_end", () => { uiPrompts = Math.max(0, uiPrompts - 1); });
  pi.on("tool_execution_start", () => { activeTools++; });
  pi.on("tool_execution_end", () => { activeTools = Math.max(0, activeTools - 1); });
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
    const handoff = handoffs.get(id.sessionId);
    if (!handoff || handoff.old.instanceId === instanceId) return;
    handoffs.delete(id.sessionId);
    pending = handoff.ticket; // Refuse another reload until this native handler returns.
    void handoff.finished.then(finished => {
      pending = undefined;
      if (!finished || !alive) {
        handoff.ticket.result.resolve({ ...id, status: "unknown", stopped: handoff.ticket.stopped, resumed: false, reason: "Native reload did not complete." });
        return;
      }
      // The previous runtime's branch generation is not a new runtime's counter.
      const ticket = { ...handoff.ticket, generation: 0 };
      const resumed = wake(ctx, ticket);
      const receipt = result(ctx, ticket, "reloaded", ticket.stopped && !resumed ? "Continuation skipped because new input or work is present." : undefined, resumed);
      ctx.ui.notify(`${ticket.summary ?? "Reload-all"}: this agent reloaded${resumed ? " and resumed" : "; no new work started"}. Check native reload diagnostics.`, "info");
      handoff.ticket.result.resolve(receipt);
    }).catch(() => handoff.ticket.result.resolve({ ...id, status: "unknown", stopped: handoff.ticket.stopped, resumed: false, reason: "Fresh-runtime acknowledgement failed." }));
  });

  pi.registerCommand("reload-all", {
    description: "Reload local Pi agents; resume only interrupted runs. status lists participating agents",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument.startsWith("--agent ")) {
        const ticket = pending;
        if (!ticket || argument !== `--agent ${ticket.id}`) throw new Error("Invalid reload-all request.");
        await localReload(ctx, ticket);
        return;
      }
      if (argument && argument !== "status") throw new Error("Use /reload-all or /reload-all status.");
      if (coordinating || pending) throw new Error("Another reload is in progress.");
      const root = directory();
      if (argument === "status") {
        const replies = await Promise.all(peers(root).map(path => contact(path, { requestId: randomUUID(), action: "status" }).catch(() => undefined)));
        const live = replies.filter(reply => reply?.identity);
        ctx.ui.notify(`Reload-all: ${live.length} participating local Pi agents.\n${live.map(reply => `PID ${reply!.identity!.pid}: ${reply!.busy ? "working" : "idle"}`).join("\n")}\nExisting sessions need one initial safe /reload to participate.`, "info");
        return;
      }
      safety(ctx);
      const original = identity(ctx);
      const originalGeneration = generation;
      const unlock = coordinatorLock(root);
      coordinating = true;
      const receipts: Array<Reply | { error: string }> = [];
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
      const summary = `Reload-all peers: ${reloaded} reloaded, ${resumed} resumed, ${receipts.length - reloaded} skipped or unconfirmed`;
      const details = receipts.flatMap(reply => {
        const note = "error" in reply && reply.error ? reply.error : "result" in reply ? reply.result?.reason : undefined;
        const id = "identity" in reply ? reply.identity : undefined;
        return note ? [`${id ? `PID ${id.pid}` : "Unavailable peer"}: ${note}`] : [];
      });
      ctx.ui.notify([summary, ...details].join("\n"), reloaded === receipts.length ? "info" : "warning");
      const ticket: Ticket = { id: randomUUID(), sessionId: original.sessionId, generation: originalGeneration, expiresAt: Date.now() + 25_000, stopped: false, result: Promise.withResolvers<Result>(), summary };
      pending = ticket;
      const own = await localReload(ctx, ticket);
      // Filesystem receipts contain only local identities and outcomes, never prompts.
      writeFileSync(join(root, "last-result.json"), JSON.stringify({ at: new Date().toISOString(), peers: receipts, caller: own }, null, 2), { mode: 0o600 });
    },
  });
}
