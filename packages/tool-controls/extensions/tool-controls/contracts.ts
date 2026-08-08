export type MaybePromise<T> = T | Promise<T>;

export type ToolStatus = "pending" | "running" | "success" | "error" | string;

export interface ToolExpansionState {
  toolCallId: string;
  toolName: string;
  turnIndex: number;
  status: ToolStatus;
  expanded: boolean;
}

export interface ToolExpansionSelector {
  scope?: "currentTurn" | string;
}

/**
 * Structural view of Pi's first-class component mouse event. The patched Pi
 * build owns event parsing; this package only reads already-decoded fields.
 */
export interface ComponentMouseEvent {
  kind?: unknown;
  type?: unknown;
  action?: unknown;
  button?: unknown;
  row?: unknown;
  col?: unknown;
  x?: unknown;
  y?: unknown;
  column?: unknown;
  localRow?: unknown;
  localCol?: unknown;
  delta?: unknown;
  deltaY?: unknown;
  direction?: unknown;
  [key: string]: unknown;
}

export interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  handleMouse?(event: ComponentMouseEvent): void;
  dispose?(): void;
  focused?: boolean;
}

export interface TerminalLike {
  rows?: number;
  columns?: number;
}

export interface TuiLike {
  mode?: "regular" | "fullscreen" | string;
  terminal?: TerminalLike;
  requestRender(force?: boolean): void;
}

export interface ThemeLike {
  fg?(role: string, text: string): string;
  bold?(text: string): string;
}

export interface KeybindingsLike {
  matches?(data: string, keybinding: string): boolean;
}

export type WidgetFactory = (tui: TuiLike, theme: ThemeLike) => ComponentLike;

export interface OverlayOptionsLike {
  width?: number | `${number}%`;
  minWidth?: number;
  maxHeight?: number | `${number}%`;
  anchor?: string;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  nonCapturing?: boolean;
}

export type OverlayFactory<T> = (
  tui: TuiLike,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: (result: T) => void,
) => ComponentLike | Promise<ComponentLike>;

export type ToolExpansionChangeUnsubscribe =
  | undefined
  | void
  | (() => void)
  | { unsubscribe(): void }
  | { dispose(): void };

/**
 * A deliberately structural API surface. Runtime imports from Pi core are
 * avoided so an older Pi can load this extension and enter compatibility mode.
 */
export interface ExtensionUIContextLike {
  setWidget(
    key: string,
    content: string[] | WidgetFactory | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  custom<T>(
    factory: OverlayFactory<T>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptionsLike | (() => OverlayOptionsLike);
    },
  ): Promise<T>;
  notify(message: string, type?: "info" | "warning" | "error"): void;

  getToolsExpanded?(): boolean;
  setToolsExpanded?(expanded: boolean): MaybePromise<void>;

  getToolExpansionStates?(selector?: ToolExpansionSelector): MaybePromise<unknown>;
  setToolExpanded?(toolCallId: string, expanded: boolean): MaybePromise<unknown>;
  setToolGroupExpanded?(selector: ToolExpansionSelector, expanded: boolean): MaybePromise<unknown>;
  onToolExpansionChange?(listener: (change?: unknown) => void): ToolExpansionChangeUnsubscribe;

  /** Optional patched-build capability advertisements, detected structurally. */
  capabilities?: Record<string, unknown>;
  supportsComponentMouse?: boolean;
}

export interface ExtensionContextLike {
  ui: ExtensionUIContextLike;
  mode?: string;
}

export interface ExtensionCommandOptionsLike {
  description?: string;
  handler(args: string, ctx: ExtensionContextLike): Promise<void> | void;
}

export interface ExtensionApiLike {
  on(
    event: string,
    handler: (event: unknown, ctx: ExtensionContextLike) => Promise<unknown> | unknown,
  ): void;
  registerCommand(name: string, options: ExtensionCommandOptionsLike): void;
}

export type ToolGroup = "currentTurn" | "failed" | "running" | "session";

export const REQUIRED_PATCHED_CAPABILITIES = [
  "Component.handleMouse",
  "getToolExpansionStates()",
  "setToolExpanded()",
  "setToolGroupExpanded()",
  "onToolExpansionChange()",
] as const;
