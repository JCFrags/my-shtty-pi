import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CompanionClient, PiBrowserBridge, ReceiverConflict } from "./bridge.js";
import type { ClosePreview, ReceiverStatus } from "./bridge.js";
import { defaultCommandRunner } from "./client.js";
import type { ControlMode, ToolContext } from "./client.js";
import { LOADED_IDENTITY, startupReceipt } from "./identity.js";
import { ASSOCIATION_TYPE, associationEntry, herdrOwner, launchInstruction, nativeOwner, ownerLabel, readAssociation, sessionIdentity } from "./owner-binding.js";
import type { SelectedOwner } from "./owner-binding.js";

function shown(value: string, limit = 512): string { return JSON.stringify(value.slice(0, limit)); }
function ownerContext(ctx: ExtensionContext, owner: SelectedOwner): ToolContext {
  return { cwd: owner.projectDir, sessionId: ctx.sessionManager.getSessionId(), owner };
}
function receiverSummary(status: ReceiverStatus): string {
  return `Browser: ${shown(status.browserSessionKey, 256)}\nRuntime: ${shown(status.runtimeInstanceId, 128)}\nMode: ${status.mode}\nShared page updates: ${status.updates.enabled ? "On" : "Off"}`;
}

/** Command-only resource. Loading the factory registers handlers, but starts no resources. */
export default function browserMenu(pi: ExtensionAPI, client = new CompanionClient(), bridge = new PiBrowserBridge(pi, client)): void {
  let cleanupReceipt = () => {};
  let lifecycle = 0;
  let menuOpen = false;

  const pause = async (_event: unknown, ctx: ExtensionContext) => {
    lifecycle++;
    await bridge.disconnect().catch(error => {
      if (ctx.hasUI) ctx.ui.notify(`Browser receiver cleanup was not confirmed: ${String(error)}. Reconnect explicitly.`, "warning");
    });
  };
  pi.on("session_before_switch", pause);
  pi.on("session_before_fork", pause);
  pi.on("session_before_tree", pause);
  pi.on("session_start", async (_event, ctx) => {
    await pause(_event, ctx);
    cleanupReceipt();
    const names = new Set(["browser_open", "browser_observe", "browser_act", "browser_tabs", "browser_control"]);
    const toolNames = pi.getAllTools().map(tool => tool.name).filter(name => names.has(name));
    const loadedIdentity = { ...LOADED_IDENTITY, loadedResources: ["dist/menu.js", ...(toolNames.length === 5 ? ["dist/extension.js"] : [])], toolNames };
    cleanupReceipt = startupReceipt(loadedIdentity);
    pi.events.emit("terminal-browser:loaded", loadedIdentity);
    if (!ctx.hasUI || !readAssociation(ctx)) return;
    await bridge.connect(ctx).catch(error => ctx.ui.notify(`${String(error)} Open /browser to reconnect.`, "warning"));
  });
  pi.on("session_tree", async (event, ctx) => {
    lifecycle++;
    if (event.newLeafId === event.oldLeafId || !ctx.hasUI) return;
    await bridge.connect(ctx).catch(error => ctx.ui.notify(`${String(error)} Open /browser to reconnect.`, "warning"));
  });
  pi.on("session_shutdown", async (event, ctx) => {
    try { await pause(event, ctx); } finally { cleanupReceipt(); cleanupReceipt = () => {}; }
  });
  pi.on("before_agent_start", (_event, ctx) => bridge.beforePrompt(ctx));
  pi.on("turn_end", (_event, ctx) => bridge.atTurnEnd(ctx));
  pi.on("context", (event, ctx) => ({ messages: bridge.filterContext(event.messages, ctx) }));

  pi.registerCommand("browser", {
    description: "Manage the exact associated browser, control mode, page sharing, settings, and owned close",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/browser needs Pi's interactive or dialog-capable RPC UI.");
      if (args.trim()) { ctx.ui.notify("Use /browser without arguments to open the menu.", "info"); return; }
      if (menuOpen) { ctx.ui.notify("The browser menu is already open.", "warning"); return; }
      menuOpen = true;
      const epoch = lifecycle;
      const storage = sessionIdentity(ctx);
      const check = () => {
        if (epoch !== lifecycle || storage !== sessionIdentity(ctx)) throw new Error("Pi conversation changed. Open /browser again.");
      };
      const wait = async <T>(result: Promise<T>): Promise<T> => { const value = await result; check(); return value; };
      const notify = (text: string) => { check(); ctx.ui.notify(text, "info"); };
      const requireConnection = async () => {
        check();
        if (!bridge.isConnected(ctx)) throw new Error("Browser link paused. Choose Reconnect receiver first.");
        return wait(bridge.refresh(ctx));
      };
      const reconnect = async (expected?: ReceiverStatus) => {
        try { await wait(bridge.connect(ctx, expected)); }
        catch (error) {
          if (!(error instanceof ReceiverConflict)) throw error;
          const status = error.status;
          const binding = status.binding!;
          const confirmed = await wait(ctx.ui.confirm("Replace this exact receiver?",
            `${receiverSummary(status)}\nBinding: ${binding.bindingId}\nReceiver: ${binding.receiverKind} ${shown(binding.receiverSessionId)}\nGeneration: ${binding.receiverGeneration}\nReplace only this binding with the current Pi conversation?`));
          if (!confirmed) return;
          await wait(bridge.connect(ctx, status, binding.bindingId));
        }
      };
      const associate = async () => {
        const currentHerdr = herdrOwner(ctx.cwd);
        const selection = await wait(ctx.ui.select("Associate this Pi conversation with an exact owner", [
          ...(currentHerdr ? ["This Herdr pane"] : []), "Native CLI session", "Disconnect this Pi receiver",
        ]));
        if (!selection) return;
        if (selection === "Disconnect this Pi receiver") {
          const cleaning = bridge.disconnect();
          pi.appendEntry(ASSOCIATION_TYPE, associationEntry(ctx, null));
          await wait(cleaning);
          notify("Disconnected this Pi receiver. The browser remains open.");
          return;
        }
        let owner: SelectedOwner;
        if (selection === "This Herdr pane") owner = currentHerdr!;
        else {
          const id = await wait(ctx.ui.input("Exact native launch session ID", ctx.sessionManager.getSessionId()));
          if (!id) return;
          const project = await wait(ctx.ui.input("Fixed browser launch project directory", ctx.cwd));
          if (!project) return;
          owner = nativeOwner(id.trim(), project);
        }
        const route = ownerContext(ctx, owner);
        let status: ReceiverStatus | undefined;
        try { status = await wait(client.status(route)); }
        catch (error) {
          check();
          // A missing owner may be saved for a later explicit launch, but is never attached by guessing.
          if (!/SESSION_NOT_FOUND/.test(String(error))) throw error;
        }
        const confirmed = await wait(ctx.ui.confirm("Use this exact browser owner?",
          `${ownerLabel(owner)}\nLaunch project: ${shown(owner.projectDir, 4096)}\n${status ? receiverSummary(status) : `No browser is open for this owner.\n${launchInstruction(owner)}`}\nAssociate only with Pi session ${ctx.sessionManager.getSessionId()}?${owner.kind === "native" ? " This overrides Herdr routing." : ""}`));
        if (!confirmed) return;
        const cleaning = bridge.disconnect();
        pi.appendEntry(ASSOCIATION_TYPE, associationEntry(ctx, owner));
        await wait(cleaning);
        if (status) await reconnect(status);
        else notify(`${launchInstruction(owner)}\nThen use /browser Open/focus or Reconnect receiver. Pi will not take over its own terminal.`);
      };
      const selectMode = async (selected?: ControlMode) => {
        const status = await requireConnection();
        const value = selected ?? await wait(ctx.ui.select(
          `Control: ${status.mode}. Shared updates: ${status.updates.enabled ? "On" : "Off"}. Shared shares page screenshots with this Pi session, without starting a reply.`,
          ["Agent", "Human", "Shared"]));
        if (!value) return;
        const next = value.toLowerCase() as ControlMode;
        if (next !== "shared") bridge.suppressAutomatic();
        await wait(bridge.command(ctx, ["agent", "control", "--mode", next, "--control-epoch", String(status.controlEpoch)]));
        await wait(bridge.refresh(ctx, true));
        notify(`Control: ${next}. No reply or previous action was started.`);
      };
      const send = async () => {
        const status = await requireConnection();
        if (!status.receiverOnline || status.pendingShareId) throw new Error("The exact receiver is not waiting, or a share is pending. No page was sent.");
        const format = await wait(ctx.ui.select("Send current page and request a reply", ["Link/title", "Viewport screenshot"]));
        if (!format) return;
        const preview = await wait(bridge.command(ctx, ["session", "human", "capture", "--format", "link"]));
        if (typeof preview?.url !== "string" || preview.url.length > 8192 || typeof preview.title !== "string" || preview.title.length > 512 ||
            !Number.isSafeInteger(preview.contextId) || preview.contextId < 1 || !Number.isSafeInteger(preview.documentGeneration) || preview.documentGeneration < 0) {
          throw new Error("Browser returned no exact page preview. Nothing was sent.");
        }
        const confirmed = await wait(ctx.ui.confirm("Send and request reply?",
          `${receiverSummary(status)}\nPi session: ${ctx.sessionManager.getSessionId()}\nUntrusted title: ${shown(preview.title)}\nUntrusted URL: ${shown(preview.url, 8192)}\nFormat: ${format}. Screenshots can include private page data.\nIf Pi is busy, the reply is queued after current work. Your draft is unchanged. A changed page will refuse this Send.`));
        if (!confirmed) return;
        const result = await wait(bridge.command(ctx, ["session", "human", "share", "--format", format === "Link/title" ? "link" : "visual",
          "--context", String(preview.contextId), "--document-generation", String(preview.documentGeneration), ...bridge.bindingFlags()]));
        if (result?.status !== "queued" || typeof result.shareId !== "string") throw new Error("Share outcome unknown. Do not resend automatically.");
        notify("Page share queued in the browser receiver. Pi submission will be reported separately. No automatic retry.");
      };
      const blocking = async () => {
        await requireConnection();
        const status = await wait(bridge.command(ctx, ["session", "human", "blocking", "status"]));
        const choice = await wait(ctx.ui.select(`Network blocking (profile-wide). ${JSON.stringify(status).slice(0, 4096)}`, [
          "Enable", "Disable", "Allow exact site", "Remove site exception", "Clear displayed-page diagnostics", "Rebuild bundled filter cache",
        ]));
        if (!choice) return;
        const actions: Record<string, string> = { Enable: "enable", Disable: "disable", "Allow exact site": "allow-site", "Remove site exception": "block-site",
          "Clear displayed-page diagnostics": "clear-diagnostics", "Rebuild bundled filter cache": "reload" };
        let site: string | undefined;
        if (choice === "Allow exact site" || choice === "Remove site exception") {
          site = await wait(ctx.ui.input("Exact hostname or HTTP(S) URL"));
          if (!site) return;
        }
        const confirmed = await wait(ctx.ui.confirm("Change network blocking?",
          `${choice}${site ? `: ${shown(site, 2048)}` : ""}. Enable/disable and exceptions affect the shared browser profile, including other owners. Clearing diagnostics affects the displayed context. Rebuild uses bundled filters, not a network update. Control does not resume.`));
        if (!confirmed) return;
        await wait(bridge.command(ctx, ["session", "human", "blocking", actions[choice], ...(site ? ["--site", site] : [])]));
        notify("Browser blocking setting updated. Control did not resume.");
      };
      const settings = async () => {
        const selected = await wait(ctx.ui.select("Browser settings", ["Owner association", "Shared page updates", "Network blocking (profile-wide)"]));
        if (selected === "Owner association") await associate();
        if (selected === "Network blocking (profile-wide)") await blocking();
        if (selected === "Shared page updates") {
          const status = await requireConnection();
          const value = await wait(ctx.ui.select(`Shared page updates: ${status.updates.enabled ? "On" : "Off"}. On shares page screenshots with this Pi session only in Shared mode. It does not start a reply.`, ["On", "Off"]));
          if (!value) return;
          if (value === "Off") bridge.suppressAutomatic();
          await wait(bridge.command(ctx, ["session", "updates", "--enabled", String(value === "On"), ...bridge.bindingFlags()]));
          await wait(bridge.refresh(ctx, true));
        }
      };
      const close = async () => {
        const status = await requireConnection();
        const preview = await wait(bridge.command(ctx, ["session", "human", "close", "--preview"])) as ClosePreview;
        if (!preview || typeof preview.revision !== "string" || !preview.revision || preview.revision.length > 256 ||
            !Array.isArray(preview.contexts) || preview.contexts.length > 128 || !Array.isArray(preview.transfers) || preview.transfers.length > 64 ||
            preview.contexts.some(item => !item || !Number.isSafeInteger(item.contextId) || item.contextId < 1 ||
              !["tab", "popup"].includes(item.contextKind) || typeof item.title !== "string" || item.title.length > 512) ||
            preview.transfers.some(item => !item || typeof item.id !== "string" || !item.id || item.id.length > 128 ||
              !Number.isSafeInteger(item.contextId) || item.contextId < 1 || typeof item.state !== "string" || item.state.length > 64)) {
          throw new Error("Browser returned no bounded close scope. Nothing was closed.");
        }
        const scope = preview.contexts.map(item => `${item.contextKind} ${item.contextId}: ${shown(String(item.title), 100)}`).join("\n");
        const transfers = preview.transfers.map(item => `${shown(item.id, 128)} (context ${item.contextId}, ${shown(item.state, 64)})`).join("\n") || "None";
        const confirmed = await wait(ctx.ui.confirm("Close only this owned browser?",
          `${receiverSummary(status)}\nExact contexts:\n${scope || "None"}\nTransfers:\n${transfers}\nTransient page data can be lost. Native beforeunload decisions remain in the browser. A refusal or new context stops the remaining close. Other browser owners and the daemon remain open.`));
        if (!confirmed) return;
        bridge.suppressAutomatic();
        const result = await wait(bridge.command(ctx, ["session", "human", "close", "--confirm", preview.revision]));
        if (result?.status === "closed") { await wait(bridge.disconnect().catch(() => {})); notify("Owned browser closed. Other owners were not closed."); }
        else if (["partial", "decision-required", "refused", "unknown"].includes(result?.status)) {
          await wait(bridge.refresh(ctx, true));
          notify(`Close status: ${result.status}. Remaining contexts: ${JSON.stringify(result.remainingContextIds)}. Check the native browser. Control remains Human; no automatic retry or resume.`);
        } else throw new Error("Close outcome unknown. Inspect the browser; do not replay the request.");
      };
      try {
        const selected = readAssociation(ctx)?.association.owner;
        const status = bridge.isConnected(ctx) ? bridge.status : undefined;
        const item = await wait(ctx.ui.select(`Browser: ${selected ? ownerLabel(selected) : "No browser associated"}${status ? `; ${status.mode}; Shared updates ${status.updates.enabled ? "On" : "Off"}` : "; receiver paused"}`, [
          "Open/focus browser", "Reconnect receiver", "Return control to agent", "Control mode", "Send current page", "Settings", "Close owned browser",
        ]));
        if (!item) return;
        if (item === "Settings") await settings();
        else if (item === "Reconnect receiver") {
          if (!selected) await associate();
          else await reconnect();
        } else if (item === "Open/focus browser") {
          if (!selected) { await associate(); return; }
          // The owner runner never uses a neighbor or launches into Pi's own terminal.
          await wait(defaultCommandRunner({ context: ownerContext(ctx, selected), args: ["companion", "open"] }));
          if (!bridge.isConnected(ctx)) await reconnect();
          if (selected.kind === "native") notify("Owned browser attached. Focus its visible terminal manually.");
        } else if (item === "Return control to agent") await selectMode("agent");
        else if (item === "Control mode") await selectMode();
        else if (item === "Send current page") await send();
        else if (item === "Close owned browser") await close();
      } catch (error) {
        if (epoch === lifecycle) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      } finally { menuOpen = false; }
    },
  });
}
