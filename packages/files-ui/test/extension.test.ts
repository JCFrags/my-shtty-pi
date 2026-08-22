import assert from "node:assert/strict";
import test from "node:test";
import filesExtension from "../extensions/files/index.ts";
import type { FilesBrowserComponent } from "../src/ui/files-browser.ts";
import { withTempDirectory, writeFile } from "./helpers.ts";

interface RegisteredCommand {
  description: string;
  handler(args: string, ctx: TestContext): Promise<void> | void;
}

interface TestContext {
  cwd: string;
  mode: string;
  hasUI: boolean;
  ui: {
    notifications: string[];
    pastes: string[];
    notify(message: string): void;
    pasteToEditor(text: string): void;
    custom<T>(
      factory: (tui: TestTui, theme: unknown, keybindings: unknown, done: (result: T | undefined) => void) => FilesBrowserComponent,
      options?: unknown,
    ): Promise<T | undefined>;
  };
}

interface TestTui {
  mode: "fullscreen";
  terminal: { rows: number; columns: number };
  requestRender(): void;
}

test("registers /files, loads a package component, never pastes automatically, and cleans up on shutdown", async () => {
  await withTempDirectory("pi-files-extension", async (root) => {
    await writeFile(root, "file.txt", "value");
    const commands = new Map<string, RegisteredCommand>();
    const handlers = new Map<string, Array<(event: unknown, ctx: TestContext) => Promise<void> | void>>();
    const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const pi = {
      registerCommand(name: string, command: RegisteredCommand): void {
        commands.set(name, command);
      },
      on(event: string, handler: (event: unknown, ctx: TestContext) => Promise<void> | void): void {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      events: {
        on(channel: string, handler: (data: unknown) => void) {
          const list = eventHandlers.get(channel) ?? [];
          list.push(handler);
          eventHandlers.set(channel, list);
          return () => eventHandlers.set(channel, list.filter((entry) => entry !== handler));
        },
        emit(channel: string, data: unknown) {
          emitted.push({ channel, data });
          for (const handler of eventHandlers.get(channel) ?? []) handler(data);
        },
      },
    };
    filesExtension(pi as never);
    const command = commands.get("files");
    assert.ok(command);
    assert.match(command?.description ?? "", /Browse repository files/);
    const capabilityRequest = eventHandlers.get("pi-files-ui:request-capability-v1")?.[0];
    assert.ok(capabilityRequest);
    capabilityRequest?.({ requestId: "cap-1" });
    assert.deepEqual((emitted.at(-1)?.data as any).capability, {
      version: 1,
      command: "/files",
      interactiveTuiRequired: true,
      canOpenViaEventBus: true,
      reason: "Provider-owned same-process request-open-v1 action calls the existing /files handler in the active Pi session",
    });

    let component: FilesBrowserComponent | undefined;
    let markComponentReady: (() => void) | undefined;
    const componentReady = new Promise<void>((resolve) => {
      markComponentReady = resolve;
    });
    const tui: TestTui = {
      mode: "fullscreen",
      terminal: { rows: 20, columns: 100 },
      requestRender: () => {},
    };
    const notifications: string[] = [];
    const pastes: string[] = [];
    const context: TestContext = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: {
        notifications,
        pastes,
        notify(message: string): void {
          notifications.push(message);
        },
        pasteToEditor(text: string): void {
          pastes.push(text);
        },
        custom<T>(factory: (tui: TestTui, theme: unknown, keybindings: unknown, done: (result: T | undefined) => void) => FilesBrowserComponent): Promise<T | undefined> {
          return new Promise<T | undefined>((resolve) => {
            component = factory(tui, {}, {}, resolve);
            component.render(tui.terminal.columns);
            markComponentReady?.();
          });
        },
      },
    };
    const commandPromise = Promise.resolve(command?.handler("", context));
    await componentReady;
    assert.ok(component);
    assert.deepEqual(pastes, []);
    assert.equal(component?.isDisposed, false);

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    await commandPromise;
    assert.equal(component?.isDisposed, true);

    // The host can reuse this extension instance for a new session. Provider
    // listeners must remain live and bind to the new provider.
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const providerRequest = eventHandlers.get("pi-files-ui:provider-request-v1")?.[0];
    assert.ok(providerRequest);
    providerRequest?.({ version: 1, requestId: "reload-1", action: "snapshot" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const providerResponse = emitted.find((entry) => (entry.data as any)?.requestId === "reload-1");
    assert.equal((providerResponse?.data as any)?.ok, true);
    assert.notEqual((providerResponse?.data as any)?.error, "No active Files provider");
  });
});

test("/files refuses non-interactive mode without touching the editor", async () => {
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerCommand(name: string, command: RegisteredCommand): void {
      commands.set(name, command);
    },
    on(): void {},
    events: { on(): () => void { return () => {}; }, emit(): void {} },
  };
  filesExtension(pi as never);
  const notifications: string[] = [];
  const pastes: string[] = [];
  const context: TestContext = {
    cwd: process.cwd(),
    mode: "json",
    hasUI: false,
    ui: {
      notifications,
      pastes,
      notify(message: string): void {
        notifications.push(message);
      },
      pasteToEditor(text: string): void {
        pastes.push(text);
      },
      async custom(): Promise<undefined> {
        throw new Error("custom UI must not be called");
      },
    },
  };
  await commands.get("files")?.handler("", context);
  assert.deepEqual(pastes, []);
  assert.ok(notifications.some((message) => /requires Pi's interactive TUI/.test(message)));
});
