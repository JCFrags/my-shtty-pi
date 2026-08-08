declare module "@earendil-works/pi-tui" {
  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
    wantsKeyRelease?: boolean;
  }

  export interface TUI {
    readonly mode: "regular" | "fullscreen";
    terminal: { rows: number; columns: number };
    requestRender(force?: boolean): void;
  }
}

declare module "@earendil-works/pi-coding-agent" {
  import type { Component, TUI } from "@earendil-works/pi-tui";

  export interface ExtensionUi {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    pasteToEditor(text: string): void;
    custom<T>(
      factory: (
        tui: TUI,
        theme: unknown,
        keybindings: unknown,
        done: (result: T | undefined) => void,
      ) => Component,
      options?: {
        overlay?: boolean;
        overlayOptions?: {
          width?: number | `${number}%`;
          minWidth?: number;
          maxHeight?: number | `${number}%`;
          row?: number | `${number}%`;
          col?: number | `${number}%`;
          anchor?: string;
          margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
        };
      },
    ): Promise<T | undefined>;
  }

  export interface ExtensionCommandContext {
    cwd: string;
    mode: string;
    hasUI?: boolean;
    ui: ExtensionUi;
  }

  export interface ExtensionAPI {
    registerCommand(
      name: string,
      command: {
        description: string;
        handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
      },
    ): void;
    on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void): void;
  }
}
