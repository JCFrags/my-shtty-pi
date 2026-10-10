import { randomUUID } from "node:crypto";
import { lstatSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { dirname, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CompanionClient, PiBrowserBridge, ReceiverConflict } from "./bridge.js";
import type { ClosePreview, ReceiverStatus } from "./bridge.js";
import type { BrowserConnection, ConnectionInventory, ControlMode, ToolContext } from "./client.js";
import { LOADED_IDENTITY, startupReceipt } from "./identity.js";
import { ASSOCIATION_TYPE, PI_ORIGIN_ENV, associationEntry, defaultOwner, launchInstruction, ownerLabel, parsePiOrigin, readAssociation, readAssociationState, sameOwner, samePiOrigin, selectedOwner, sessionIdentity } from "./owner-binding.js";
import type { PiOrigin, SelectedOwner } from "./owner-binding.js";

function shown(value: string, limit = 512): string { return JSON.stringify(value.slice(0, limit)); }
function ownerContext(ctx: ExtensionContext, owner: SelectedOwner, signal?: AbortSignal, origin?: PiOrigin): ToolContext {
  return { cwd: owner.projectDir, sessionId: ctx.sessionManager.getSessionId(), owner, signal, origin };
}
function receiverSummary(status: ReceiverStatus): string {
  return `Browser: ${shown(status.browserSessionKey, 256)}\nRuntime: ${shown(status.runtimeInstanceId, 128)}\nMode: ${status.mode}\nShared page updates preference: ${status.updates.enabled ? "On" : "Off"}${status.updates.suspended ? " (suspended until explicit opt-in)" : ""}`;
}

interface OriginState {
  ctx: ExtensionContext;
  manager: ExtensionContext["sessionManager"];
  storage: string;
  epoch: number;
  origin: PiOrigin;
  abort: AbortController;
  restoreEnvironment(): void;
  watcher?: FSWatcher;
  watchPath?: string;
  instancesDirectory?: string;
  debounce?: ReturnType<typeof setTimeout>;
  scan?: Promise<void>;
  dirty: boolean;
  blocked: boolean;
}

export interface BrowserMenuOptions {
  watch?: (directory: string, changed: (event: string, name: string | null) => void) => FSWatcher;
}

/** Command-only resource. Loading the factory registers handlers, but starts no resources. */
export default function browserMenu(pi: ExtensionAPI, client = new CompanionClient(), bridge = new PiBrowserBridge(pi, client), options: BrowserMenuOptions = {}): void {
  let cleanupReceipt = () => {};
  let lifecycle = 0;
  let menuOpen = false;
  let active: OriginState | undefined;
  const calls = new Map<string, OriginState>();
  const valid = (state: OriginState) => active === state && !state.abort.signal.aborted && state.epoch === lifecycle &&
    state.manager === state.ctx.sessionManager && state.storage === sessionIdentity(state.ctx);
  const invalidate = () => {
    lifecycle++;
    const state = active;
    active = undefined;
    calls.clear();
    if (!state) return;
    state.abort.abort();
    state.watcher?.close();
    if (state.debounce) clearTimeout(state.debounce);
    state.restoreEnvironment();
  };
  const current = (ctx: ExtensionContext): OriginState => {
    if (active && valid(active) && active.manager === ctx.sessionManager && active.storage === sessionIdentity(ctx)) {
      active.ctx = ctx;
      return active;
    }
    invalidate();
    const origin = parsePiOrigin({ schemaVersion: 1, generation: randomUUID(), piSessionId: ctx.sessionManager.getSessionId(),
      piSessionFile: ctx.sessionManager.getSessionFile() ?? null });
    const previous = process.env[PI_ORIGIN_ENV];
    const bytes = JSON.stringify(origin);
    process.env[PI_ORIGIN_ENV] = bytes;
    return active = { ctx, manager: ctx.sessionManager, storage: sessionIdentity(ctx), epoch: lifecycle, origin,
      abort: new AbortController(), dirty: false, blocked: false,
      restoreEnvironment() {
        if (process.env[PI_ORIGIN_ENV] !== bytes) return;
        if (previous === undefined) delete process.env[PI_ORIGIN_ENV]; else process.env[PI_ORIGIN_ENV] = previous;
      } };
  };
  const fail = (state: OriginState, error: unknown) => {
    if (!valid(state) || state.blocked) return;
    state.blocked = true;
    if (state.ctx.hasUI) state.ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Automatic connection paused. Use /browser Connect existing browser or Reconnect receiver. No action was replayed.`, "warning");
  };
  const route = (state: OriginState): ToolContext => ({ cwd: state.ctx.cwd, sessionId: state.origin.piSessionId, signal: state.abort.signal });
  const schedule = (state: OriginState) => {
    if (!valid(state) || state.blocked || state.debounce) return;
    state.debounce = setTimeout(() => {
      state.debounce = undefined;
      if (valid(state)) void rescan(state);
    }, 100);
    state.debounce.unref();
  };
  const armWatch = (state: OriginState, directory: string) => {
    if (!valid(state)) return;
    if (state.instancesDirectory && state.instancesDirectory !== directory) throw new Error("Browser discovery directory changed. Inspect terminal-browser doctor --json.");
    state.instancesDirectory = directory;
    let target = directory;
    for (let depth = 0; ; depth++) {
      try {
        const info = lstatSync(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser discovery path is not a directory.");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || depth >= 3 || dirname(target) === target) throw error;
        target = dirname(target);
      }
    }
    if (state.watchPath === target) return;
    state.watcher?.close();
    state.watchPath = undefined;
    const child = relative(target, directory).split(sep)[0];
    const changed = (_event: string, name: string | null) => {
      if (!valid(state) || (name !== null && (child ? name !== child : !name.endsWith(".json")))) return;
      state.dirty = true;
      schedule(state);
    };
    const watcher = options.watch ? options.watch(target, changed) : watch(target, { persistent: false }, (event, name) => changed(event, name === null ? null : name.toString()));
    state.watcher = watcher;
    state.watchPath = target;
    watcher.on("error", error => {
      if (!valid(state) || state.watcher !== watcher) return;
      watcher.close();
      state.watcher = undefined;
      state.watchPath = undefined;
      fail(state, new Error(`Browser connection watch failed (${(error as NodeJS.ErrnoException).code ?? "unknown"}). Inspect terminal-browser doctor --json.`));
    });
    // Cover a browser that appeared between the first inventory read and watch registration.
    state.dirty = true;
  };
  const matching = (inventory: ConnectionInventory, owner: SelectedOwner) => inventory.sessions.filter(entry => entry.owner && sameOwner(selectedOwner(entry.owner), owner));
  const scan = async (state: OriginState) => {
    const association = readAssociationState(state.ctx);
    const associationId = association?.entryId;
    const inventory = await client.discover(route(state));
    if (!valid(state)) return;
    armWatch(state, inventory.instancesDirectory);
    if (menuOpen || bridge.isConnected(state.ctx) || bridge.requiresExplicitReconnect?.(state.ctx) ||
        readAssociationState(state.ctx)?.entryId !== associationId || !inventory.identity) return;
    if (association?.association.owner === null) return;
    const candidates = association?.association.owner ? matching(inventory, association.association.owner)
      : inventory.sessions.filter(entry => entry.owner && samePiOrigin(entry.origin, state.origin));
    if (candidates.length > 1) throw new Error("More than one browser matches this conversation. Choose one with /browser Connect existing browser.");
    const entry = candidates[0];
    if (!entry?.owner) return;
    const owner = selectedOwner(entry.owner);
    const status = await client.status(ownerContext(state.ctx, owner, state.abort.signal),
      { browserSessionKey: entry.key, runtimeInstanceId: inventory.identity.instanceId });
    if (!valid(state) || menuOpen || bridge.requiresExplicitReconnect?.(state.ctx) || readAssociationState(state.ctx)?.entryId !== associationId) return;
    if (status.binding) throw new ReceiverConflict(status);
    if (!association) pi.appendEntry(ASSOCIATION_TYPE, associationEntry(state.ctx, owner));
    if (!valid(state)) return;
    await bridge.connect(state.ctx, status);
  };
  const rescan = (state: OriginState): Promise<void> => {
    if (!valid(state) || state.blocked || menuOpen || !state.ctx.hasUI || bridge.isConnected(state.ctx) || bridge.requiresExplicitReconnect?.(state.ctx)) return Promise.resolve();
    state.dirty = true;
    if (state.scan) return state.scan;
    state.scan = (async () => {
      for (let count = 0; count < 2 && valid(state) && state.dirty && !state.blocked; count++) {
        state.dirty = false;
        await scan(state);
      }
    })().catch(error => fail(state, error)).finally(() => {
      state.scan = undefined;
      if (state.dirty) schedule(state);
    });
    return state.scan;
  };
  const pause = async (_event: unknown, ctx: ExtensionContext) => {
    invalidate();
    await bridge.disconnect().catch(error => {
      if (ctx.hasUI) ctx.ui.notify(`Browser receiver cleanup was not confirmed: ${String(error)}. Reconnect explicitly.`, "warning");
    });
  };
  pi.on("session_before_switch", pause);
  pi.on("session_before_fork", pause);
  pi.on("session_before_tree", pause);
  pi.on("session_start", async (_event, ctx) => {
    const manager = ctx.sessionManager, storage = sessionIdentity(ctx), epoch = lifecycle + 1;
    await pause(_event, ctx);
    if (epoch !== lifecycle || manager !== ctx.sessionManager || storage !== sessionIdentity(ctx)) return;
    const state = current(ctx);
    cleanupReceipt();
    const names = new Set(["browser_open", "browser_observe", "browser_act", "browser_tabs", "browser_control"]);
    const toolNames = pi.getAllTools().map(tool => tool.name).filter(name => names.has(name));
    const loadedIdentity = { ...LOADED_IDENTITY, loadedResources: ["dist/menu.js", ...(toolNames.length === 5 ? ["dist/extension.js"] : [])], toolNames };
    cleanupReceipt = startupReceipt(loadedIdentity);
    pi.events.emit("terminal-browser:loaded", loadedIdentity);
    await rescan(state);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const manager = ctx.sessionManager, storage = sessionIdentity(ctx), epoch = lifecycle + 1;
    await pause(_event, ctx);
    if (epoch !== lifecycle || manager !== ctx.sessionManager || storage !== sessionIdentity(ctx)) return;
    await rescan(current(ctx));
  });
  pi.on("session_shutdown", async (event, ctx) => {
    try { await pause(event, ctx); } finally { cleanupReceipt(); cleanupReceipt = () => {}; }
  });
  pi.on("tool_call", (event, ctx) => {
    const state = current(ctx);
    if (calls.size >= 128) calls.delete(calls.keys().next().value!);
    calls.set(event.toolCallId, state);
  });
  pi.on("tool_result", async (event, ctx) => {
    const state = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    if (!state || event.isError || !valid(state) || state.manager !== ctx.sessionManager || state.storage !== sessionIdentity(ctx)) return;
    state.ctx = ctx;
    await rescan(state);
  });
  pi.on("user_bash", async (_event, ctx) => { await rescan(current(ctx)); });
  pi.on("before_agent_start", async (_event, ctx) => {
    const state = current(ctx);
    await rescan(state);
    if (valid(state)) return bridge.beforePrompt(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    const state = current(ctx);
    await rescan(state);
    if (valid(state)) return bridge.atTurnEnd(ctx);
  });
  pi.on("context", (event, ctx) => ({ messages: bridge.filterContext(event.messages, ctx) }));

  pi.registerCommand("browser", {
    description: "Manage the exact associated browser, control mode, page sharing, settings, and owned close",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/browser needs Pi's interactive or dialog-capable RPC UI.");
      if (args.trim()) { ctx.ui.notify("Use /browser without arguments to open the menu.", "info"); return; }
      if (menuOpen) { ctx.ui.notify("The browser menu is already open.", "warning"); return; }
      menuOpen = true;
      const state = current(ctx);
      const epoch = lifecycle;
      const storage = sessionIdentity(ctx);
      const manager = ctx.sessionManager;
      const check = () => {
        if (!valid(state) || epoch !== lifecycle || manager !== ctx.sessionManager || storage !== sessionIdentity(ctx)) throw new Error("Pi conversation changed. Open /browser again.");
      };
      const wait = async <T>(result: Promise<T>): Promise<T> => { const value = await result; check(); return value; };
      const notify = (text: string) => { check(); ctx.ui.notify(text, "info"); };
      const requireConnection = async () => {
        check();
        if (!bridge.isConnected(ctx)) throw new Error("Browser link paused. Choose Reconnect receiver first.");
        return wait(bridge.refresh(ctx));
      };
      const reconnect = async (expected?: { browserSessionKey: string; runtimeInstanceId: string }) => {
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
      const inventory = async () => {
        const value = await wait(client.discover(route(state)));
        try { armWatch(state, value.instancesDirectory); } catch (error) { fail(state, error); }
        return value;
      };
      const pinFor = (value: ConnectionInventory, entry: BrowserConnection) => {
        if (!value.identity) throw new Error("No verified browser runtime is open. Launch in a separate visible terminal, then choose Connect existing browser.");
        return { browserSessionKey: entry.key, runtimeInstanceId: value.identity.instanceId };
      };
      const saveOwner = async (owner: SelectedOwner) => {
        await wait(bridge.disconnect());
        check();
        pi.appendEntry(ASSOCIATION_TYPE, associationEntry(ctx, owner));
        state.blocked = false;
      };
      const connectExisting = async () => {
        const value = await inventory();
        const entries = value.sessions.filter(entry => entry.owner !== null);
        if (!entries.length) { notify("No owned browser is open. Use Open/focus browser or run terminal-browser open in a separate visible terminal, then choose Connect existing browser."); return; }
        const labels = entries.map((entry, index) => `${index + 1}. ${[entry.terminal, entry.tab, entry.pane].filter(Boolean).map(place => shown(place!, 128)).join(" ") || "Visible terminal"}; ${ownerLabel(selectedOwner(entry.owner))}; project ${shown(entry.owner!.projectDir, 4096)}`);
        const choice = await wait(ctx.ui.select("Connect an existing browser to this conversation", labels));
        if (!choice) return;
        const index = labels.indexOf(choice);
        if (index < 0) throw new Error("Browser selection changed. Open Connect existing browser again.");
        const entry = entries[index];
        const owner = selectedOwner(entry.owner);
        const fresh = await inventory();
        const currentEntry = fresh.sessions.find(candidate => candidate.key === entry.key && candidate.owner && sameOwner(selectedOwner(candidate.owner), owner));
        if (!currentEntry || fresh.identity?.instanceId !== value.identity?.instanceId) throw new Error("Selected browser changed. Choose the current browser again. Nothing was connected.");
        const status = await wait(client.status(ownerContext(ctx, owner, state.abort.signal), pinFor(fresh, currentEntry)));
        await saveOwner(owner);
        await reconnect(status);
      };
      const disconnect = async () => {
        check();
        const cleaning = bridge.disconnect();
        pi.appendEntry(ASSOCIATION_TYPE, associationEntry(ctx, null));
        await wait(cleaning);
        notify("Disconnected this Pi receiver. The browser remains open. Automatic association stays off until you choose Open/focus browser or Connect existing browser.");
      };
      const open = async () => {
        state.blocked = false;
        let value = await inventory();
        const saved = readAssociation(ctx)?.association.owner;
        const origins = saved ? [] : value.sessions.filter(entry => entry.owner && samePiOrigin(entry.origin, state.origin));
        if (origins.length > 1) throw new Error("More than one browser was opened by this conversation. Use Connect existing browser to choose one.");
        const owner = saved ?? (origins[0]?.owner ? selectedOwner(origins[0].owner) : defaultOwner(ctx));
        if (!owner) {
          notify("Run terminal-browser open in a separate visible terminal, then choose Connect existing browser. Pi will not take over its own terminal.");
          return;
        }
        let matches = matching(value, owner);
        if (matches.length > 1) throw new Error("More than one browser claims this owner. Use terminal-browser doctor --json before reconnecting.");
        if (!matches.length && owner.kind === "native") {
          notify(saved ? `${launchInstruction(owner)}\nLaunch in a separate visible terminal, then choose Reconnect receiver. Pi will not take over its own terminal.`
            : "Run terminal-browser open in a separate visible terminal, then choose Connect existing browser. Pi will not take over its own terminal.");
          return;
        }
        if (!saved || !sameOwner(saved, owner)) await saveOwner(owner);
        if (!matches.length) {
          await wait(client.open(ownerContext(ctx, owner, state.abort.signal, state.origin)));
          value = await inventory();
          matches = matching(value, owner);
          if (matches.length !== 1) throw new Error("The launched browser has no single verified connection. Inspect terminal-browser doctor --json. Do not launch another browser.");
        } else if (owner.kind === "herdr") {
          await wait(client.open(ownerContext(ctx, owner, state.abort.signal, state.origin)));
        }
        const status = await wait(client.status(ownerContext(ctx, owner, state.abort.signal), pinFor(value, matches[0])));
        if (!bridge.isConnected(ctx)) await reconnect(status);
        if (owner.kind === "native") notify("Connected to the existing owned browser. Focus its visible terminal manually. Connection did not capture or resume input.");
      };
      const selectMode = async (selected?: ControlMode) => {
        const status = await requireConnection();
        const value = selected ?? await wait(ctx.ui.select(
          `Control: ${status.mode}. Shared updates preference: ${status.updates.enabled ? "On" : "Off"}${status.updates.suspended ? " (suspended)" : ""}. Selecting Shared explicitly allows page screenshots when the preference is On, without starting a reply.`,
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
        const selected = await wait(ctx.ui.select("Browser settings", ["Connect existing browser", "Disconnect this Pi receiver", "Shared page updates", "Network blocking (profile-wide)"]));
        if (selected === "Connect existing browser") await connectExisting();
        if (selected === "Disconnect this Pi receiver") await disconnect();
        if (selected === "Network blocking (profile-wide)") await blocking();
        if (selected === "Shared page updates") {
          const status = await requireConnection();
          const value = await wait(ctx.ui.select(`Shared page updates preference: ${status.updates.enabled ? "On" : "Off"}${status.updates.suspended ? " (suspended)" : ""}. Choosing On explicitly allows page screenshots in Shared mode. It does not start a reply.`, ["On", "Off"]));
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
        const item = await wait(ctx.ui.select(`Browser: ${selected ? ownerLabel(selected) : "No browser associated"}${status ? `; ${status.mode}; Shared updates preference ${status.updates.enabled ? "On" : "Off"}${status.updates.suspended ? " (suspended)" : ""}` : "; receiver paused"}`, [
          "Open/focus browser", "Connect existing browser", "Reconnect receiver", "Return control to agent", "Control mode", "Send current page", "Settings", "Close owned browser",
        ]));
        if (!item) return;
        if (item === "Settings") await settings();
        else if (item === "Connect existing browser") await connectExisting();
        else if (item === "Reconnect receiver") {
          state.blocked = false;
          if (!selected) await connectExisting();
          else {
            const value = await inventory();
            const entries = matching(value, selected);
            if (entries.length !== 1) throw new Error("No single open browser matches the saved owner. Use Open/focus browser or Connect existing browser.");
            await reconnect(pinFor(value, entries[0]));
          }
        } else if (item === "Open/focus browser") await open();
        else if (item === "Return control to agent") await selectMode("agent");
        else if (item === "Control mode") await selectMode();
        else if (item === "Send current page") await send();
        else if (item === "Close owned browser") await close();
      } catch (error) {
        if (valid(state) && epoch === lifecycle) {
          state.blocked = true;
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
      } finally {
        menuOpen = false;
        if (valid(state) && state.dirty) schedule(state);
      }
    },
  });
}
