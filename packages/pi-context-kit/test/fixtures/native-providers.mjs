import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { HARD_LIMITS, requestChannel, responseChannel, validateResponse } from "@context-kit/protocol";
import todo from "../../todo/index.ts";
import notes from "../../notes/index.ts";
import { createWorkplanExtension } from "../../workplan/index.ts";

export const SDK_IDENTITY = Object.freeze({ package: "@earendil-works/pi-coding-agent", version: VERSION, node: process.version });
console.info(`Native provider fixture SDK: ${SDK_IDENTITY.package}@${VERSION}, Node ${process.version}`);

export async function fixtureDirectory(label = "native-providers") {
  const root = await mkdtemp(join(tmpdir(), `pi-${label}-`));
  await chmod(root, 0o700);
  await writeFile(join(root, "fixture.json"), `${JSON.stringify({ sdk: SDK_IDENTITY, label })}\n`, { mode: 0o600 });
  // Keep fixture evidence, including failed sessions. Only listeners and handles are closed here.
  return root;
}

export async function persistedSession(root) {
  const directory = join(root, "sessions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manager = SessionManager.create(root, directory);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Private native provider fixture" }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await chmod(manager.getSessionFile(), 0o600);
  return manager;
}

export class EventBus {
  listeners = new Map();
  on(name, handler) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(handler); this.listeners.set(name, listeners);
    return () => { listeners.delete(handler); if (!listeners.size) this.listeners.delete(name); };
  }
  emit(name, value) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(value); }
  count(name) { return this.listeners.get(name)?.size ?? 0; }
}

export class NativeProviderHost {
  handlers = new Map();
  tools = new Map();
  commands = new Map();
  shortcuts = new Map();
  calls = 0;
  active;
  constructor(manager, root, { providers = ["todo", "notes", "workplan"], events = new EventBus(), rejectAdapter = false } = {}) {
    this.manager = manager;
    this.root = root;
    this.events = rejectAdapter ? {
      on(name, listener) {
        if (name.startsWith("context-kit:request:")) throw new Error("Transport unavailable");
        return events.on(name, listener);
      },
      emit: (name, value) => events.emit(name, value),
      count: (name) => events.count(name),
    } : events;
    const host = this;
    this.context = { get sessionManager() { return host.manager; }, hasUI: false,
      ui: { setWidget() {}, notify() {} } };
    for (const provider of providers) {
      if (provider === "todo") todo(this, { storeRoot: join(root, "todo"), settingsPath: join(root, "todo-settings.json"), outputRoot: root });
      else if (provider === "notes") notes(this, { storeRoot: join(root, "notes"), outputRoot: root });
      else if (provider === "workplan") createWorkplanExtension(this, { storeRoot: join(root, "workplan") });
      else throw new Error(`Unknown fixture provider: ${provider}`);
    }
  }
  on(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler); this.handlers.set(name, handlers);
  }
  registerTool(tool) { this.tools.set(tool.name, tool); }
  registerCommand(name, command) { this.commands.set(name, command); }
  registerShortcut(name, shortcut) { this.shortcuts.set(name, shortcut); }
  getActiveTools() { return this.active ?? [...this.tools.keys()]; }
  appendEntry(type, data) { this.manager.appendCustomEntry(type, data); }
  scope() { return { sessionId: this.manager.getSessionId(), leafId: this.manager.getLeafId() }; }
  async lifecycle(name) {
    for (const handler of this.handlers.get(name) ?? []) await handler({ type: name }, this.context);
  }
  async persist(name, id, result) {
    const message = { role: "toolResult", toolName: name, toolCallId: id, content: result.content,
      details: result.details, isError: false, timestamp: Date.now() };
    this.manager.appendMessage(message);
    for (const handler of this.handlers.get("message_end") ?? []) await handler({ type: "message_end", message }, this.context);
  }
  async execute(name, args, { persist = true } = {}) {
    const id = `fixture-${++this.calls}`;
    const result = await this.tools.get(name).execute(id, args, new AbortController().signal, undefined, this.context);
    if (persist) await this.persist(name, id, result);
    return result;
  }
  async query(providerId, overrides = {}) {
    const request = { version: 1, requestId: `query-${++this.calls}`, providerId, scope: this.scope(), query: "",
      categories: [], limits: { records: 6, scan: 128, bytes: 8192 }, deadlineMs: Date.now() + HARD_LIMITS.waitMs, ...overrides };
    if (this.events.count(requestChannel(providerId, request.version)) === 0) return undefined;
    const getBranch = this.manager.getBranch;
    this.manager.getBranch = () => { throw new Error("Context providers must not replay native history"); };
    let remove, timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Provider response timeout: ${providerId}`)), 1500);
        remove = this.events.on(responseChannel(providerId, request.version), (response) => {
          if (response.requestId !== request.requestId) return;
          try { validateResponse(response, request); resolve(response); } catch (error) { reject(error); }
        });
        this.events.emit(requestChannel(providerId, request.version), request);
      });
    } finally { clearTimeout(timer); remove?.(); this.manager.getBranch = getBranch; }
  }
}
