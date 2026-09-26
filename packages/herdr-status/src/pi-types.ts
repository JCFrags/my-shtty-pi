export interface PiModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  setTitle(title: string): void;
}

export interface PiExtensionContext {
  cwd: string;
  model: PiModel | undefined;
  ui: PiUi;
  mode?: string;
  hasUI?: boolean;
  signal?: AbortSignal | undefined;
  isIdle(): boolean;
  getContextUsage(): PiContextUsage | undefined;
}

export interface SessionStartEvent {
  reason?: string;
}

export interface TurnStartEvent {
  turnIndex: number;
  timestamp?: number;
}

export interface ToolExecutionStartEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult?: unknown;
}

export interface ToolExecutionEndEvent {
  toolCallId: string;
  toolName: string;
  result?: unknown;
  isError: boolean;
}

export interface ModelSelectEvent {
  model: PiModel;
  previousModel?: PiModel;
  source?: string;
}

export interface ThinkingLevelSelectEvent {
  level?: string;
  previousLevel?: string;
}

export interface MessageUpdateEvent {
  message: { role: string };
  assistantMessageEvent?: { type: string };
}

export interface SessionBeforeCompactEvent {
  signal: AbortSignal;
  reason?: string;
  willRetry?: boolean;
}

export interface SessionCompactEvent {
  reason?: string;
  willRetry?: boolean;
}

export interface PiCommandDefinition {
  description?: string;
  handler(args: string, ctx: PiExtensionContext): void | Promise<void>;
}

export type PiEventHandler<TEvent = unknown> = (
  event: TEvent,
  ctx: PiExtensionContext,
) => void | Promise<void>;

export interface PiEventMap {
  session_start: SessionStartEvent;
  before_agent_start: Record<string, unknown>;
  agent_start: Record<string, unknown>;
  turn_start: TurnStartEvent;
  message_update: MessageUpdateEvent;
  session_before_compact: SessionBeforeCompactEvent;
  session_compact: SessionCompactEvent;
  session_compact_failed: SessionCompactEvent;
  session_info_changed: Record<string, unknown>;
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_update: ToolExecutionUpdateEvent;
  tool_execution_end: ToolExecutionEndEvent;
  model_select: ModelSelectEvent;
  thinking_level_select: ThinkingLevelSelectEvent;
  agent_settled: Record<string, never>;
  session_shutdown: Record<string, unknown>;
}

export interface PiExtensionApi {
  getSessionName?(): string | undefined;
  on<K extends keyof PiEventMap>(event: K, handler: PiEventHandler<PiEventMap[K]>): void;
  registerCommand(name: string, definition: PiCommandDefinition): void;
}
