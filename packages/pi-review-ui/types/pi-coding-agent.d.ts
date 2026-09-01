declare module "@earendil-works/pi-coding-agent" {
  import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

  export interface EditToolInput {
    path: string;
    edits: Array<{
      oldText?: string;
      newText?: string;
      startAnchor?: string;
      endAnchor?: string;
      contentLines?: string[];
    }>;
    expectedDigest?: string;
  }

  export interface WriteToolInput {
    path: string;
    content: string;
    expectedDigest?: string;
  }

  export interface EditToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: "edit";
    input: EditToolInput;
  }

  export interface WriteToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: "write";
    input: WriteToolInput;
  }

  export interface CustomToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }

  export type ToolCallEvent = EditToolCallEvent | WriteToolCallEvent | CustomToolCallEvent;

  export interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
  }

  export type ExtensionMode = "tui" | "rpc" | "json" | "print";

  export type ThemeColor =
    | "accent" | "border" | "borderAccent" | "borderMuted" | "success" | "error"
    | "warning" | "muted" | "dim" | "text" | "toolTitle" | "toolOutput"
    | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";
  export type ThemeBg = "selectedBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

  export interface Theme {
    fg(name: ThemeColor, text: string): string;
    bg(name: ThemeBg, text: string): string;
    bold(text: string): string;
  }

  export interface ExtensionUIContext {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: unknown,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions | (() => OverlayOptions);
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T>;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    mode: ExtensionMode;
    hasUI: boolean;
    cwd: string;
    signal: AbortSignal | undefined;
  }

  export interface TurnStartEvent {
    type: "turn_start";
    turnIndex: number;
    timestamp: number;
  }

  export interface TurnEndEvent {
    type: "turn_end";
    turnIndex: number;
  }

  export interface SessionStartEvent {
    type: "session_start";
    reason: "startup" | "reload" | "new" | "resume" | "fork";
  }

  export interface SessionShutdownEvent {
    type: "session_shutdown";
    reason: "quit" | "reload" | "new" | "resume" | "fork";
  }

  export interface SessionBeforeSwitchEvent {
    type: "session_before_switch";
    reason: "new" | "resume";
    targetSessionFile?: string;
  }

  export interface SessionBeforeForkEvent {
    type: "session_before_fork";
    entryId: string;
    position: "before" | "at";
  }

  export interface ResourcesDiscoverEvent {
    type: "resources_discover";
    cwd: string;
    reason: "startup" | "reload";
  }

  export interface SourceInfo {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  }

  export interface ToolInfo {
    name: string;
    sourceInfo: SourceInfo;
  }

  export interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  }

  export interface ExtensionAPI {
    events: EventBus;
    getAllTools(): ToolInfo[];
    on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void): void;
    on(event: "turn_start", handler: (event: TurnStartEvent, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "turn_end", handler: (event: TurnEndEvent, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "session_before_switch", handler: (event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "session_before_fork", handler: (event: SessionBeforeForkEvent, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "resources_discover", handler: (event: ResourcesDiscoverEvent, ctx: ExtensionContext) => void | Promise<void>): void;
  }

  export type ExtensionFactory = (pi: ExtensionAPI) => void;

  export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
  export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
  export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean;

  export interface EditOperations {
    readFile(absolutePath: string): Promise<Buffer>;
    writeFile(absolutePath: string, content: string): Promise<void>;
    access(absolutePath: string): Promise<void>;
  }

  export interface EditToolDefinition {
    execute(
      toolCallId: string,
      input: EditToolInput,
      signal?: AbortSignal,
      onUpdate?: unknown,
      context?: unknown,
    ): Promise<unknown>;
  }

  export function createEditToolDefinition(
    cwd: string,
    options?: { operations?: EditOperations },
  ): EditToolDefinition;

  export function generateUnifiedPatch(
    path: string,
    oldContent: string,
    newContent: string,
    contextLines?: number,
  ): string;
}
