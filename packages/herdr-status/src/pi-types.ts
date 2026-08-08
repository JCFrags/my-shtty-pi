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
}

export interface PiExtensionContext {
  cwd: string;
  model: PiModel | undefined;
  ui: PiUi;
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
  turn_start: TurnStartEvent;
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_update: ToolExecutionUpdateEvent;
  tool_execution_end: ToolExecutionEndEvent;
  model_select: ModelSelectEvent;
  thinking_level_select: ThinkingLevelSelectEvent;
  agent_settled: Record<string, never>;
  session_shutdown: Record<string, unknown>;
}

export interface PiExtensionApi {
  on<K extends keyof PiEventMap>(event: K, handler: PiEventHandler<PiEventMap[K]>): void;
  registerCommand(name: string, definition: PiCommandDefinition): void;
}
