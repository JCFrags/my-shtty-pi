import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERSION = "0.1.0";
const READINESS_EVENT = "grounded:session-transition-readiness:v1";

interface Request {
  id: string;
  sessionId: string;
  signal?: AbortSignal;
}

export default function selfReload(pi: ExtensionAPI): void {
  // Capture loaded bytes, not whatever a later edit leaves at this path.
  const loaded = {
    version: VERSION,
    instanceId: randomUUID(),
    sha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  };
  let pending: Request | undefined;
  let alive = true;
  let handling = false;

  function checkSafety(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") throw new Error("Pi-SelfReload requires interactive Pi (TUI mode).");
    if (ctx.hasPendingMessages()) throw new Error("Reload refused: queued messages must finish first.");
    if (ctx.ui.getEditorText().length > 0) throw new Error("Reload refused: preserve the unsent editor draft first.");

    let replies = 0;
    let invalid = false;
    let busy = false;
    // This optional public protocol needs no Grounded import or dependency.
    pi.events.emit(READINESS_EVENT, {
      protocolVersion: 1,
      accept(value: { protocolVersion?: unknown; runningProcesses?: unknown; openSessions?: unknown } | undefined) {
        replies++;
        if (value?.protocolVersion !== 1 || !Number.isSafeInteger(value.runningProcesses)
          || !Number.isSafeInteger(value.openSessions) || Number(value.runningProcesses) < 0 || Number(value.openSessions) < 0) {
          invalid = true;
          return;
        }
        busy ||= Number(value.runningProcesses) > 0 || Number(value.openSessions) > 0;
      },
    });
    if (invalid) throw new Error("Reload refused: invalid process-readiness response.");
    if (busy) throw new Error("Reload refused: running managed processes or open shell sessions must settle first.");
    if (replies === 0 && pi.getAllTools().some(({ name }) => name === "process" || name === "grounded_process")) {
      throw new Error("Reload refused: the process owner has no readiness response. Check jobs and use native /reload when safe.");
    }
  }

  function reserve(ctx: ExtensionContext, signal?: AbortSignal): Request {
    if (!alive || signal?.aborted) throw new Error("Reload request cancelled.");
    if (pending) throw new Error("A self-reload is already pending. Do not request another reload.");
    checkSafety(ctx);
    const request = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), signal };
    pending = request;
    return request;
  }

  pi.on("session_shutdown", () => {
    alive = false;
    pending = undefined;
  });
  pi.on("session_tree", () => { pending = undefined; });

  pi.registerCommand("self-reload", {
    description: "Reload this Pi session when safe, or inspect loaded identity with /self-reload status",
    handler: async (args, ctx) => {
      if (args.trim() === "status") {
        ctx.ui.notify(`Pi-SelfReload ${loaded.version}, instance ${loaded.instanceId}, SHA-256 ${loaded.sha256}, pending ${Boolean(pending)}`, "info");
        return;
      }
      if (handling) {
        ctx.ui.notify("A self-reload is already pending.", "warning");
        return;
      }
      const token = args.trim();
      if (token && (!pending || token !== pending.id)) throw new Error("Invalid or expired self-reload request.");
      const request = token ? pending! : reserve(ctx, ctx.signal);
      handling = true;
      try {
        // The tool does not await this command. Waiting inside execute would deadlock.
        await ctx.waitForIdle();
        if (!alive || pending !== request) {
          handling = false;
          return;
        }
        if (request.signal?.aborted || ctx.sessionManager.getSessionId() !== request.sessionId) {
          pending = undefined;
          handling = false;
          ctx.ui.notify("Self-reload cancelled. The run was aborted or the session changed.", "warning");
          return;
        }
        checkSafety(ctx);
        if (!ctx.isIdle()) throw new Error("Reload refused: Pi became busy again.");
      } catch (error) {
        pending = undefined;
        handling = false;
        throw error;
      }
      pending = undefined;
      // Reload invalidates this runtime. Do not read pi or ctx after this call.
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: "self_reload",
    label: "Pi-SelfReload",
    description: "Reload this interactive Pi session through the native /reload API. Use action=status to read the loaded version and instance. Before reload, save task state and check background jobs. Call reload alone as the last action: it ends the current run and waits for idle. It refuses editor drafts, queued messages, and reported Grounded jobs/shell sessions. Other extensions may stop their own resources on reload. A queued result is not completion; use Pi's reload notification and a later status call to verify. No automatic model continuation.",
    promptSnippet: "Reload this Pi session safely, or inspect its loaded self-reload identity",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("reload"), Type.Literal("status")], { default: "reload" })),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "status") {
        const details = { ...loaded, pending: Boolean(pending), mode: ctx.mode };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
      const request = reserve(ctx, signal);
      try {
        // Pi 0.99.1 treats extension-origin text literally unless expansion is explicit.
        // Command dispatch happens immediately; waitForIdle above defers the reload.
        pi.sendUserMessage(`/self-reload ${request.id}`, { expandPromptTemplates: true });
      } catch (error) {
        pending = undefined;
        throw error;
      }
      return {
        content: [{ type: "text", text: "Self-reload queued for the end of this run, not yet completed. Pi will report the reload result. No further action is needed in this run." }],
        details: { status: "queued", requestId: request.id, ...loaded },
        terminate: true,
      };
    },
  });
}
