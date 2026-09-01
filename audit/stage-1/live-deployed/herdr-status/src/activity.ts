import { homedir } from "node:os";

import {
  TOOL_CLEAR_DEBOUNCE_MS,
  TOOL_UPDATE_REFRESH_MS,
  TOKEN_NAMES,
  TTL_REFRESH_MS,
  type TokenSnapshot,
} from "./constants.ts";
import { systemClock, type Clock, type TimerHandle } from "./clock.ts";
import type { ReporterStatus } from "./reporter.ts";
import {
  normalizeObservedPath,
  redactCredentials,
  redactHomePathPrefixes,
  sanitizeFirstCommandLine,
  sanitizeSummary,
  sanitizeToolName,
  sanitizeVisible,
} from "./sanitize.ts";
import type {
  ModelSelectEvent,
  PiExtensionContext,
  PiModel,
  ThinkingLevelSelectEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  TurnStartEvent,
} from "./pi-types.ts";

export interface ActivityReporter {
  setSnapshot(snapshot: TokenSnapshot): void;
  refresh(): void;
  getStatus(): ReporterStatus;
  shutdownAndClear(): Promise<void>;
}

export interface ActivityControllerOptions {
  clock?: Clock;
  homeDirectory?: string;
  ttlRefreshMs?: number;
  toolUpdateRefreshMs?: number;
  toolClearDebounceMs?: number;
}

interface ActiveTool {
  id: string;
  name: string;
  args: unknown;
  summary: string;
  order: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstField(record: Record<string, unknown> | undefined, names: readonly string[]): unknown {
  if (!record) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return undefined;
}

function baseToolName(toolName: string): string {
  return toolName.toLowerCase().split(/[.:/]/u).at(-1) ?? toolName.toLowerCase();
}

function summaryWithDetail(prefix: string, detail: string): string {
  return sanitizeSummary(detail ? `${prefix} ${detail}` : prefix);
}

export function deriveToolSummary(
  toolName: unknown,
  args: unknown,
  cwd: string,
  homeDirectory = homedir(),
): string {
  const safeTool = sanitizeToolName(toolName);
  const baseName = baseToolName(safeTool);
  const input = asRecord(args);
  const pathValue = firstField(input, ["path", "filePath", "file_path", "filename"]);
  const observedPath = normalizeObservedPath(pathValue, cwd, homeDirectory)?.display ?? "";

  switch (baseName) {
    case "read":
      return summaryWithDetail("reading", observedPath);
    case "edit":
    case "write":
      return summaryWithDetail("editing", observedPath);
    case "grep": {
      const pattern = sanitizeVisible(
        firstField(input, ["pattern", "query", "search", "needle"]),
        48,
      );
      return summaryWithDetail("searching", pattern);
    }
    case "find": {
      const pattern = sanitizeVisible(
        firstField(input, ["pattern", "query", "name", "glob"]),
        48,
      );
      return summaryWithDetail("searching", pattern);
    }
    case "ls":
    case "list":
      return summaryWithDetail("listing", observedPath || ".");
    case "bash":
    case "shell":
    case "exec": {
      const command = sanitizeFirstCommandLine(
        firstField(input, ["command", "cmd", "script"]),
        homeDirectory,
      );
      return summaryWithDetail("running", command);
    }
    default:
      return summaryWithDetail("using", safeTool || "tool");
  }
}

export function formatModel(model: PiModel | undefined): string | undefined {
  if (!model) return undefined;
  const provider = sanitizeVisible(model.provider, 36);
  const id = sanitizeVisible(model.id || model.name, 72);
  const name = id || sanitizeVisible(model.name, 72);
  if (!name) return undefined;
  if (!provider || name.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
    return sanitizeVisible(name);
  }
  return sanitizeVisible(`${provider}/${name}`);
}

export function formatContextPercent(ctx: PiExtensionContext): string | undefined {
  const percent = ctx.getContextUsage()?.percent;
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return undefined;
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

export function idleSummary(changedFileCount: number): string {
  if (changedFileCount <= 0) return "idle";
  return sanitizeSummary(
    `idle · ${changedFileCount} ${changedFileCount === 1 ? "file" : "files"} changed`,
  );
}

export class ActivityController {
  private readonly clock: Clock;
  private readonly homeDirectory: string;
  private readonly ttlRefreshMs: number;
  private readonly toolUpdateRefreshMs: number;
  private readonly toolClearDebounceMs: number;

  private cwd = process.cwd();
  private tokens: TokenSnapshot = {};
  private readonly changedPaths = new Set<string>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private toolOrder = 0;
  private activeTurn = false;
  private ttlTimer: TimerHandle | undefined;
  private clearToolTimer: TimerHandle | undefined;
  private lastToolRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly reporter: ActivityReporter,
    options: ActivityControllerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.ttlRefreshMs = options.ttlRefreshMs ?? TTL_REFRESH_MS;
    this.toolUpdateRefreshMs = options.toolUpdateRefreshMs ?? TOOL_UPDATE_REFRESH_MS;
    this.toolClearDebounceMs = options.toolClearDebounceMs ?? TOOL_CLEAR_DEBOUNCE_MS;
  }

  onSessionStart(ctx: PiExtensionContext): void {
    this.cancelTimers();
    this.cwd = ctx.cwd || process.cwd();
    this.changedPaths.clear();
    this.activeTools.clear();
    this.toolOrder = 0;
    this.activeTurn = false;
    this.lastToolRefreshAt = Number.NEGATIVE_INFINITY;
    this.tokens = {
      summary: "waiting for model",
      changed_files: "0",
      turn: "0",
    };
    this.updateModelAndContext(ctx);
    this.publish();
  }

  onTurnStart(event: TurnStartEvent, ctx: PiExtensionContext): void {
    this.cwd = ctx.cwd || this.cwd;
    this.cancelToolClear();
    this.activeTools.clear();
    const turnIndex = Number.isFinite(event.turnIndex) ? Math.trunc(event.turnIndex) : 0;
    this.tokens.turn = String(Math.max(0, turnIndex));
    this.tokens.summary = "waiting for model";
    delete this.tokens.tool;
    this.activeTurn = true;
    this.updateModelAndContext(ctx);
    this.startTtlRefresh();
    this.publish();
  }

  onToolExecutionStart(event: ToolExecutionStartEvent, ctx: PiExtensionContext): void {
    this.cwd = ctx.cwd || this.cwd;
    this.cancelToolClear();
    const tool: ActiveTool = {
      id: event.toolCallId,
      name: sanitizeToolName(event.toolName),
      args: event.args,
      summary: deriveToolSummary(event.toolName, event.args, this.cwd, this.homeDirectory),
      order: ++this.toolOrder,
    };
    this.activeTools.set(tool.id, tool);
    this.activeTurn = true;
    this.applyCurrentTool(tool);
    this.updateModelAndContext(ctx);
    this.lastToolRefreshAt = this.clock.now();
    this.startTtlRefresh();
    this.publish();
  }

  onToolExecutionUpdate(_event: ToolExecutionUpdateEvent): void {
    const now = this.clock.now();
    if (now - this.lastToolRefreshAt < this.toolUpdateRefreshMs) return;
    this.lastToolRefreshAt = now;
    this.reporter.refresh();
  }

  onToolExecutionEnd(event: ToolExecutionEndEvent, ctx: PiExtensionContext): void {
    this.cwd = ctx.cwd || this.cwd;
    const tool = this.activeTools.get(event.toolCallId);
    const effectiveName = tool?.name || sanitizeToolName(event.toolName);

    if (!event.isError && (baseToolName(effectiveName) === "edit" || baseToolName(effectiveName) === "write")) {
      const pathValue = firstField(asRecord(tool?.args), ["path", "filePath", "file_path", "filename"]);
      const normalized = normalizeObservedPath(pathValue, this.cwd, this.homeDirectory);
      if (normalized) this.changedPaths.add(normalized.key);
      this.tokens.changed_files = String(this.changedPaths.size);
    }

    this.activeTools.delete(event.toolCallId);
    this.updateModelAndContext(ctx);

    const nextTool = this.latestActiveTool();
    if (nextTool) {
      this.applyCurrentTool(nextTool);
      this.publish();
      return;
    }

    // Publish the changed-file count immediately while leaving the just-finished
    // activity visible briefly, then clear the tool in one debounced update.
    this.publish();
    this.cancelToolClear();
    this.clearToolTimer = this.clock.setTimeout(() => {
      this.clearToolTimer = undefined;
      if (this.activeTools.size > 0) return;
      delete this.tokens.tool;
      if (this.activeTurn) this.tokens.summary = "waiting for model";
      this.publish();
    }, this.toolClearDebounceMs);
  }

  onModelSelect(event: ModelSelectEvent, ctx: PiExtensionContext): void {
    const model = formatModel(event.model);
    if (model) this.tokens.model = model;
    else delete this.tokens.model;
    this.updateContext(ctx);
    this.publish();
  }

  onThinkingLevelSelect(_event: ThinkingLevelSelectEvent, ctx: PiExtensionContext): void {
    this.updateModelAndContext(ctx);
    this.publish();
  }

  onAgentSettled(ctx: PiExtensionContext): void {
    this.cwd = ctx.cwd || this.cwd;
    this.activeTurn = false;
    this.activeTools.clear();
    this.cancelToolClear();
    this.stopTtlRefresh();
    delete this.tokens.tool;
    this.tokens.summary = idleSummary(this.changedPaths.size);
    this.updateModelAndContext(ctx);
    this.publish();
  }

  async onSessionShutdown(): Promise<void> {
    this.activeTurn = false;
    this.activeTools.clear();
    this.cancelTimers();
    await this.reporter.shutdownAndClear();
  }

  getChangedFileCount(): number {
    return this.changedPaths.size;
  }

  getSnapshot(): TokenSnapshot {
    return { ...this.tokens };
  }

  private updateModelAndContext(ctx: PiExtensionContext): void {
    const model = formatModel(ctx.model);
    if (model) this.tokens.model = model;
    else delete this.tokens.model;
    this.updateContext(ctx);
  }

  private updateContext(ctx: PiExtensionContext): void {
    const context = formatContextPercent(ctx);
    if (context) this.tokens.context = context;
    else delete this.tokens.context;
  }

  private applyCurrentTool(tool: ActiveTool): void {
    this.tokens.tool = tool.name;
    this.tokens.summary = tool.summary;
  }

  private latestActiveTool(): ActiveTool | undefined {
    let latest: ActiveTool | undefined;
    for (const tool of this.activeTools.values()) {
      if (!latest || tool.order > latest.order) latest = tool;
    }
    return latest;
  }

  private publish(): void {
    const sanitized: TokenSnapshot = {};
    for (const name of TOKEN_NAMES) {
      const value = this.tokens[name];
      if (value === undefined) continue;
      const normalized = sanitizeVisible(
        redactHomePathPrefixes(redactCredentials(String(value)), this.homeDirectory),
        name === "summary" ? 60 : 80,
      );
      if (normalized) sanitized[name] = normalized;
    }
    this.tokens = sanitized;
    this.reporter.setSnapshot(this.tokens);
  }

  private startTtlRefresh(): void {
    if (this.ttlTimer !== undefined) return;
    this.ttlTimer = this.clock.setInterval(() => this.reporter.refresh(), this.ttlRefreshMs);
  }

  private stopTtlRefresh(): void {
    if (this.ttlTimer === undefined) return;
    this.clock.clearInterval(this.ttlTimer);
    this.ttlTimer = undefined;
  }

  private cancelToolClear(): void {
    if (this.clearToolTimer === undefined) return;
    this.clock.clearTimeout(this.clearToolTimer);
    this.clearToolTimer = undefined;
  }

  private cancelTimers(): void {
    this.stopTtlRefresh();
    this.cancelToolClear();
  }
}
