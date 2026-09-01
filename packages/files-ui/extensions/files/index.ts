import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RepositoryTree } from "../../src/filesystem.ts";
import { PreviewService } from "../../src/preview.ts";
import type { BrowserSessionState } from "../../src/types.ts";
import { FilesBrowserComponent, type BrowserTuiLike } from "../../src/ui/files-browser.ts";
import { sanitizeTerminalText } from "../../src/ui/text.ts";
import {
  FILES_PROVIDER_REQUEST_EVENT,
  FILES_PROVIDER_RESPONSE_EVENT,
  FilesProvider,
  parseFilesProviderRequest,
  providerErrorResponse,
} from "../../src/provider.ts";

export { FILES_PROVIDER_REQUEST_EVENT, FILES_PROVIDER_RESPONSE_EVENT };

export const FILES_CAPABILITY_REQUEST_EVENT = "pi-files-ui:request-capability-v1" as const;
export const FILES_CAPABILITY_EVENT = "pi-files-ui:capability-v1" as const;
export const FILES_OPEN_REQUEST_EVENT = "pi-files-ui:request-open-v1" as const;
export const FILES_OPEN_RESPONSE_EVENT = "pi-files-ui:open-response-v1" as const;

export interface FilesOpenRequest { version: 1; requestId: string; }
export interface FilesOpenResponse { version: 1; requestId: string; ok: boolean; error?: string; }

export interface FilesCapabilitySnapshot {
  version: 1;
  command: "/files";
  interactiveTuiRequired: true;
  canOpenViaEventBus: true;
  reason: "Provider-owned same-process request-open-v1 action calls the existing /files handler in the active Pi session";
}

function boundedRequestId(value: string, limit = 128): string {
  return value.trim().slice(0, limit);
}

function createSessionState(): BrowserSessionState {
  return {
    selectedPaths: new Set<string>(),
    showHidden: false,
    expandedPaths: new Set<string>(),
  };
}

interface FilesEventBus {
  on(channel: string, handler: (data: unknown) => unknown): () => void;
  emit(channel: string, data: unknown): void;
}

interface FilesExtensionRuntime {
  state: BrowserSessionState;
  active?: FilesBrowserComponent;
  currentContext?: ExtensionContext;
  provider?: FilesProvider;
  removeListeners?: () => void;
}
const FILES_RUNTIME_KEY = "__piFilesUiRuntimeV1" as const;
type FilesGlobal = typeof globalThis & { [FILES_RUNTIME_KEY]?: FilesExtensionRuntime };

export default function filesExtension(pi: ExtensionAPI): void {
  const eventBus = (pi as ExtensionAPI & { events?: FilesEventBus }).events;
  const emitEvent = (channel: string, data: unknown): void => { eventBus?.emit(channel, data); };
  const global = globalThis as FilesGlobal;
  const previous = global[FILES_RUNTIME_KEY];
  previous?.removeListeners?.();
  let state = previous?.state ?? createSessionState();
  let active = previous?.active;
  let currentContext = previous?.currentContext;
  let provider = previous?.provider;
  const runtime: FilesExtensionRuntime = { state, ...(active ? { active } : {}), ...(currentContext ? { currentContext } : {}), ...(provider ? { provider } : {}) };
  global[FILES_RUNTIME_KEY] = runtime;
  const capability: FilesCapabilitySnapshot = {
    version: 1,
    command: "/files",
    interactiveTuiRequired: true,
    canOpenViaEventBus: true,
    reason: "Provider-owned same-process request-open-v1 action calls the existing /files handler in the active Pi session",
  };
  const emitCapability = (requestId?: string) => {
    emitEvent(FILES_CAPABILITY_EVENT, { version: 1, ...(requestId ? { requestId } : {}), capability });
  };
  const removeCapabilityListener = eventBus?.on(FILES_CAPABILITY_REQUEST_EVENT, (data: unknown) => {
    const request = data && typeof data === "object" ? data as { requestId?: unknown } : {};
    emitCapability(typeof request.requestId === "string" ? request.requestId.slice(0, 128) : undefined);
  }) ?? (() => {});

  const removeProviderListener = eventBus?.on(FILES_PROVIDER_REQUEST_EVENT, async (data: unknown) => {
    const request = parseFilesProviderRequest(data);
    if (!request) return;
    try {
      if (!provider) throw new Error("No active Files provider");
      const result = await provider.handle(request);
      emitEvent(FILES_PROVIDER_RESPONSE_EVENT, { ...result, requestId: request.requestId });
    } catch (error) {
      emitEvent(FILES_PROVIDER_RESPONSE_EVENT, providerErrorResponse(request.requestId, error));
    }
  }) ?? (() => {});

  const removeOpenListener = eventBus?.on(FILES_OPEN_REQUEST_EVENT, async (data: unknown) => {
    const request = data && typeof data === "object" ? data as Partial<FilesOpenRequest> : {};
    const requestId = typeof request.requestId === "string" ? boundedRequestId(request.requestId) : "";
    if (!requestId) return;
    try {
      if (!currentContext) throw new Error("No active Pi session");
      await openFiles(currentContext);
      emitEvent(FILES_OPEN_RESPONSE_EVENT, { version: 1, requestId, ok: true } satisfies FilesOpenResponse);
    } catch (error) {
      emitEvent(FILES_OPEN_RESPONSE_EVENT, { version: 1, requestId, ok: false, error: boundedRequestId(error instanceof Error ? error.message : String(error), 240) } satisfies FilesOpenResponse);
    }
  }) ?? (() => {});

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    runtime.currentContext = ctx;
    if (!active) {
      state = createSessionState();
      runtime.state = state;
    }
    provider?.dispose();
    provider = undefined;
    delete runtime.provider;
    {
      const nextProvider = new FilesProvider(ctx, emitEvent);
      try {
        await nextProvider.initialize();
        provider = nextProvider;
        runtime.provider = nextProvider;
        provider.publishState();
      } catch { nextProvider.dispose(); }
    }
    emitCapability();
  });

  pi.on("session_shutdown", () => {
    active?.close();
    active = undefined;
    delete runtime.active;
    state = createSessionState();
    runtime.state = state;
    // Keep provider event listeners registered across session shutdown. Pi may
    // reuse the extension instance for the next session; session_start then
    // installs a new provider before correlated requests are handled.
    provider?.dispose();
    provider = undefined;
    currentContext = undefined;
    delete runtime.provider;
    delete runtime.currentContext;
  });

  const openFiles = async (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui" || ctx.hasUI === false) {
        ctx.ui.notify("/files requires Pi's interactive TUI", "error");
        return;
      }
      if (active && !active.isDisposed) {
        ctx.ui.notify("The files browser is already open", "warning");
        return;
      }

      const tree = new RepositoryTree(ctx.cwd);
      try {
        await tree.initialize();
      } catch (error) {
        tree.dispose();
        ctx.ui.notify(
          `Could not open ${sanitizeTerminalText(ctx.cwd)}: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
          "error",
        );
        return;
      }
      const preview = new PreviewService(tree);

      let component: FilesBrowserComponent | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, _theme, _keybindings, done) => {
            component = new FilesBrowserComponent({
              tree,
              preview,
              tui: tui as BrowserTuiLike,
              ui: ctx.ui,
              done: () => done(undefined),
              state,
              onDispose: () => {
                if (active === component) {
                  active = undefined;
                  delete runtime.active;
                }
              },
            });
            active = component;
            runtime.active = component;
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "100%",
              maxHeight: "100%",
              row: 0,
              col: 0,
              margin: 0,
              anchor: "top-left",
            },
          },
        );
      } catch (error) {
        ctx.ui.notify(
          `The files browser closed with an error: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
          "error",
        );
      } finally {
        component?.dispose();
        if (!component) tree.dispose();
        if (active === component) {
          active = undefined;
          delete runtime.active;
        }
      }
  };

  runtime.removeListeners = () => {
    removeCapabilityListener();
    removeProviderListener();
    removeOpenListener();
  };

  // A reload can evaluate this extension after session_start. Re-publish the
  // transferred live provider so the new listener set becomes authoritative.
  provider?.publishState();

  pi.registerCommand("files", {
    description: "Browse repository files and paste selected paths or bounded contents into the editor",
    handler: async (_args, ctx) => { await openFiles(ctx); },
  });
}
