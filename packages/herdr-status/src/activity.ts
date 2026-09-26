import { homedir } from "node:os";
import path from "node:path";

import { animationFrame, formatElapsed, milestoneBadge, toolActivity, type Activity } from "./animation.ts";
import {
  HERDR_TITLE_FRAME_MS,
  IDLE_RECHECK_MS,
  STARTUP_TITLE_RESTORE_MS,
  TERMINAL_TITLE_FRAME_MS,
  TOOL_CLEAR_DEBOUNCE_MS,
  TOOL_UPDATE_REFRESH_MS,
  TOKEN_NAMES,
  TTL_REFRESH_MS,
  type TokenSnapshot,
} from "./constants.ts";
import { systemClock, type Clock, type TimerHandle } from "./clock.ts";
import type { ReporterStatus } from "./reporter.ts";
import { DEFAULT_SETTINGS, type SidebarSettings } from "./settings-types.ts";
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
  MessageUpdateEvent,
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
  settings?: SidebarSettings;
  inHerdr?: boolean;
  getSessionName?: () => string | undefined;
}

interface ActiveTool {
  id: string;
  name: string;
  args: unknown;
  cwd: string;
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

export function formatModel(
  model: PiModel | undefined,
  style: SidebarSettings["modelName"] = "short",
): string | undefined {
  if (!model) return undefined;
  const name = sanitizeVisible(model.name, 80);
  const id = sanitizeVisible(model.id, 80);
  if (style === "full") {
    const provider = sanitizeVisible(model.provider, 36);
    const fullName = id || name;
    if (!fullName) return undefined;
    return sanitizeVisible(!provider || fullName.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
      ? fullName : `${provider}/${fullName}`, 80);
  }
  // Astra is a deliberate alias, including IDs such as gpt-6-astra. Other
  // model names retain their version numbers, sizes, and variants.
  if (/^astra(?:$|[\s._:/-])/iu.test(name) || /(?:^|[/_-])astra(?:$|[\s._:/-])/iu.test(id)) {
    return "Astra";
  }
  return sanitizeVisible(name || id.split("/").at(-1), 48) || undefined;
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
  private readonly inHerdr: boolean;
  private readonly getSessionName: (() => string | undefined) | undefined;
  private settings: SidebarSettings;

  private cwd = process.cwd();
  private context: PiExtensionContext | undefined;
  private model: PiModel | undefined;
  private contextPercent: string | undefined;
  private sessionName: string | undefined;
  private tokens: TokenSnapshot = {};
  private readonly changedPaths = new Set<string>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private displayTool: ActiveTool | undefined;
  private toolOrder = 0;
  private turnCount = 0;
  private busy = false;
  private activeRun = false;
  private compacting = false;
  private stopped = false;
  private phase: "thinking" | "writing" = "thinking";
  private startedAt: number | undefined;
  private frameIndex = 0;
  private lastTitle: string | undefined;
  private lastDetailsAt = Number.NEGATIVE_INFINITY;
  private compactSignal: AbortSignal | undefined;
  private compactAbort: (() => void) | undefined;
  private ttlTimer: TimerHandle | undefined;
  private animationTimer: TimerHandle | undefined;
  private animationInterval = 0;
  private idleTimer: TimerHandle | undefined;
  private startupTimer: TimerHandle | undefined;
  private clearToolTimer: TimerHandle | undefined;

  constructor(
    private readonly reporter: ActivityReporter | undefined,
    options: ActivityControllerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.ttlRefreshMs = options.ttlRefreshMs ?? TTL_REFRESH_MS;
    this.toolUpdateRefreshMs = options.toolUpdateRefreshMs ?? TOOL_UPDATE_REFRESH_MS;
    this.toolClearDebounceMs = options.toolClearDebounceMs ?? TOOL_CLEAR_DEBOUNCE_MS;
    this.inHerdr = options.inHerdr ?? process.env.HERDR_ENV === "1";
    this.getSessionName = options.getSessionName;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
  }

  onSessionStart(ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.cancelTimers();
    this.clearCompaction();
    this.changedPaths.clear();
    this.activeTools.clear();
    this.displayTool = undefined;
    this.toolOrder = 0;
    this.turnCount = 0;
    this.frameIndex = 0;
    this.phase = "thinking";
    this.activeRun = !this.isIdle(ctx);
    this.busy = this.activeRun;
    // A reloaded runtime can recover activity, but not its original start time.
    this.startedAt = this.busy ? this.clock.now() : undefined;
    this.lastTitle = undefined;
    this.refreshPresentation(ctx, true);
    // Pi writes its startup title after session_start. Reapply the current
    // activity, not a captured Ready title, after that write.
    this.startupTimer = this.clock.setTimeout(() => {
      this.startupTimer = undefined;
      this.renderTitle(true);
    }, STARTUP_TITLE_RESTORE_MS);
    this.startupTimer.unref?.();
  }

  onAgentStart(ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.beginRun(ctx);
    this.clearCompaction();
    this.phase = "thinking";
    this.refreshPresentation(ctx);
  }

  onTurnStart(_event: TurnStartEvent, ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.beginRun(ctx);
    this.clearCompaction();
    this.cancelToolClear();
    this.displayTool = this.latestActiveTool();
    this.phase = "thinking";
    this.turnCount += 1;
    this.refreshPresentation(ctx);
  }

  onMessageUpdate(event: MessageUpdateEvent, ctx: PiExtensionContext): void {
    if (this.stopped || event.message.role !== "assistant") return;
    const wasBusy = this.busy;
    const oldPhase = this.phase;
    this.beginRun(ctx);
    const type = event.assistantMessageEvent?.type;
    if (type?.startsWith("thinking_") || type?.startsWith("toolcall_") || type === "start") {
      this.phase = "thinking";
    } else if (!type || type.startsWith("text_")) {
      this.phase = "writing";
    }
    const hadFinishedTool = this.activeTools.size === 0 && this.displayTool !== undefined;
    if (this.activeTools.size === 0) {
      this.cancelToolClear();
      this.displayTool = undefined;
    }
    // Stream deltas do not publish metadata or titles at token frequency.
    if (!wasBusy || oldPhase !== this.phase || hadFinishedTool || this.detailsDue()) {
      this.refreshPresentation(ctx);
    }
  }

  onToolExecutionStart(event: ToolExecutionStartEvent, ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.beginRun(ctx);
    this.cancelToolClear();
    const tool: ActiveTool = {
      id: event.toolCallId,
      name: sanitizeToolName(event.toolName),
      args: event.args,
      cwd: this.cwd,
      summary: deriveToolSummary(event.toolName, event.args, this.cwd, this.homeDirectory),
      order: ++this.toolOrder,
    };
    this.activeTools.set(tool.id, tool);
    this.displayTool = tool;
    this.refreshPresentation(ctx);
  }

  onToolExecutionUpdate(event: ToolExecutionUpdateEvent, ctx = this.context): void {
    if (this.stopped || !ctx) return;
    if (!this.activeTools.has(event.toolCallId)) {
      // Reload may happen between a tool's start and its next progress event.
      this.onToolExecutionStart(event, ctx);
      return;
    }
    this.beginRun(ctx);
    if (this.detailsDue()) this.refreshPresentation(ctx);
  }

  onToolExecutionEnd(event: ToolExecutionEndEvent, ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.beginRun(ctx);
    const tool = this.activeTools.get(event.toolCallId);
    const name = baseToolName(tool?.name || sanitizeToolName(event.toolName));
    if (!event.isError && (name === "edit" || name === "write") && tool) {
      const pathValue = firstField(asRecord(tool.args), ["path", "filePath", "file_path", "filename"]);
      const normalized = normalizeObservedPath(pathValue, tool.cwd, this.homeDirectory);
      if (normalized) this.changedPaths.add(normalized.key);
    }
    this.activeTools.delete(event.toolCallId);
    const nextTool = this.latestActiveTool();
    if (nextTool) this.displayTool = nextTool;
    this.phase = "thinking";
    this.refreshPresentation(ctx);
    if (nextTool) return;

    this.cancelToolClear();
    this.clearToolTimer = this.clock.setTimeout(() => {
      this.clearToolTimer = undefined;
      if (this.activeTools.size > 0) return;
      this.displayTool = undefined;
      this.renderTitle();
    }, this.toolClearDebounceMs);
    this.clearToolTimer.unref?.();
  }

  onBeforeCompact(ctx: PiExtensionContext, signal?: AbortSignal): void {
    if (this.stopped) return;
    this.clearCompaction();
    this.stopIdleCheck();
    this.busy = true;
    this.startedAt ??= this.clock.now();
    this.compacting = true;
    this.refreshPresentation(ctx);
    this.compactSignal = signal ?? ctx.signal;
    if (this.compactSignal) {
      this.compactAbort = () => this.onCompactFailed(this.context ?? ctx);
      this.compactSignal.addEventListener("abort", this.compactAbort, { once: true });
      if (this.compactSignal.aborted) this.compactAbort();
    }
  }

  onCompact(ctx: PiExtensionContext, willRetry = false): void {
    if (this.stopped) return;
    this.clearCompaction();
    this.phase = "thinking";
    if (willRetry) this.activeRun = true;
    if (this.activeRun) {
      // A compaction reason does not settle a run or a blocked question.
      this.busy = true;
      this.startedAt ??= this.clock.now();
      this.refreshPresentation(ctx);
    } else {
      this.settleWhenIdle(ctx);
    }
  }

  onCompactFailed(ctx: PiExtensionContext, willRetry = false): void {
    this.onCompact(ctx, willRetry);
  }

  onModelSelect(event: ModelSelectEvent, ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.recoverBusy(ctx);
    this.refreshPresentation(ctx, false, event.model);
  }

  onThinkingLevelSelect(_event: ThinkingLevelSelectEvent, ctx: PiExtensionContext): void {
    this.onSessionInfoChanged(ctx);
  }

  onSessionInfoChanged(ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.recoverBusy(ctx);
    this.refreshPresentation(ctx);
  }

  onSettingsChanged(settings: SidebarSettings, ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.settings = { ...settings };
    this.frameIndex = 0;
    this.onSessionInfoChanged(ctx);
  }

  onAgentSettled(ctx: PiExtensionContext): void {
    if (this.stopped) return;
    this.activeRun = false;
    this.clearCompaction();
    this.activeTools.clear();
    this.displayTool = undefined;
    this.cancelToolClear();
    this.phase = "thinking";
    this.settleWhenIdle(ctx);
  }

  async onSessionShutdown(ctx = this.context): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.activeRun = false;
    this.busy = false;
    this.activeTools.clear();
    this.displayTool = undefined;
    this.clearCompaction();
    this.cancelTimers();
    this.tokens = {};
    if (ctx) {
      this.context = ctx;
      this.setTitle(this.inHerdr ? "" : this.contextTitle(), true);
    }
    this.context = undefined;
    await this.reporter?.shutdownAndClear();
  }

  getChangedFileCount(): number {
    return this.changedPaths.size;
  }

  getSnapshot(): TokenSnapshot {
    return { ...this.tokens };
  }

  private isIdle(ctx: PiExtensionContext): boolean {
    try {
      return ctx.isIdle() === true;
    } catch {
      return false;
    }
  }

  private beginRun(ctx: PiExtensionContext): void {
    this.context = ctx;
    this.cwd = ctx.cwd || this.cwd;
    this.activeRun = true;
    this.busy = true;
    this.startedAt ??= this.clock.now();
    this.stopIdleCheck();
  }

  private recoverBusy(ctx: PiExtensionContext): void {
    if (!this.busy && !this.isIdle(ctx)) this.beginRun(ctx);
  }

  private settleWhenIdle(ctx: PiExtensionContext): void {
    this.context = ctx;
    if (this.isIdle(ctx)) {
      this.busy = false;
      this.startedAt = undefined;
      this.frameIndex = 0;
      this.stopIdleCheck();
    } else {
      this.busy = true;
      this.startedAt ??= this.clock.now();
      // Completion callbacks can precede Pi's idle transition. Recheck locally
      // only after completion, never infer settlement during an active run.
      if (this.idleTimer === undefined) {
        this.idleTimer = this.clock.setInterval(() => {
          if (this.context && this.isIdle(this.context)) this.settleWhenIdle(this.context);
        }, IDLE_RECHECK_MS);
        this.idleTimer.unref?.();
      }
    }
    this.refreshPresentation(ctx);
  }

  private refreshPresentation(ctx: PiExtensionContext, force = false, model = ctx.model): void {
    this.context = ctx;
    this.cwd = ctx.cwd || this.cwd;
    this.model = model;
    this.contextPercent = formatContextPercent(ctx);
    this.sessionName = this.getSessionName?.();
    this.lastDetailsAt = this.clock.now();
    this.publish(force);
    this.syncTimers();
    this.renderTitle();
  }

  private detailsDue(): boolean {
    return this.clock.now() - this.lastDetailsAt >= this.toolUpdateRefreshMs;
  }

  private modelContext(): string {
    if (!this.busy && !this.settings.detailsWhenIdle) return "";
    const model = this.settings.model ? formatModel(this.model, this.settings.modelName) : undefined;
    const context = this.settings.context ? this.contextPercent : undefined;
    // Keep the percentage visible even when a full model ID reaches the limit.
    const modelLimit = 80 - (context ? context.length + 1 : 0);
    return [model ? this.clean(model, modelLimit) : undefined, context].filter(Boolean).join(" ");
  }

  private publish(force = false): void {
    const snapshot: TokenSnapshot = {};
    const modelContext = this.modelContext();
    if (modelContext) snapshot.model_context = modelContext;
    if (this.busy || this.settings.detailsWhenIdle) {
      const count = this.changedPaths.size;
      if (this.settings.changedFiles) snapshot.changed_files = `${count} ${count === 1 ? "file" : "files"}`;
      if (this.settings.turns) snapshot.turn = `turn ${this.turnCount}`;
    }
    for (const name of TOKEN_NAMES) {
      const value = snapshot[name];
      if (value !== undefined) snapshot[name] = this.clean(value, 80);
    }
    if (force || TOKEN_NAMES.some((name) => snapshot[name] !== this.tokens[name])) {
      this.tokens = snapshot;
      this.reporter?.setSnapshot(snapshot);
    }
  }

  private currentActivity(): Activity {
    if (this.compacting) return { kind: "compacting", label: "Compacting memory" };
    if (this.displayTool) return toolActivity(this.displayTool.name);
    return { kind: this.phase, label: this.phase === "writing" ? "Writing" : "Thinking" };
  }

  private contextTitle(): string {
    const project = this.clean(path.basename(this.cwd) || this.cwd, 28);
    // Generic terminal titles retain the session, project, and model at idle.
    // Sidebar detail hiding affects metadata, not this terminal identity.
    const model = this.settings.model ? formatModel(this.model, this.settings.modelName) : undefined;
    return `π ${[this.clean(this.sessionName ?? "", 46), project, model].filter(Boolean).join(" · ")}`;
  }

  private renderTitle(force = false): void {
    if (this.stopped) return;
    let activity = "";
    if (this.settings.activity) {
      if (this.busy) {
        const current = this.currentActivity();
        const frame = animationFrame(this.settings.animation, current.kind, this.frameIndex++, Number.parseFloat(this.contextPercent ?? "0"));
        activity = `${frame} ${this.clean(current.label, 34)}`;
        if (this.settings.elapsed) {
          const elapsed = Math.max(0, this.clock.now() - (this.startedAt ?? this.clock.now()));
          const badge = milestoneBadge(elapsed);
          activity += ` · ${formatElapsed(elapsed)}${badge ? ` ${badge}` : ""}`;
        }
      } else if (this.settings.idle === "ready") {
        activity = "✓ Ready";
      }
    }
    const title = this.inHerdr ? activity : [activity, this.contextTitle()].filter(Boolean).join(" │ ");
    this.setTitle(title, force);
  }

  private clean(value: string, length: number): string {
    return sanitizeVisible(redactHomePathPrefixes(redactCredentials(value), this.homeDirectory), length);
  }

  private canSetTitle(): boolean {
    return Boolean(this.context && this.context.hasUI !== false && (!this.context.mode || this.context.mode === "tui"));
  }

  private setTitle(value: string, force = false): void {
    if (!this.canSetTitle()) return;
    const title = this.clean(value, this.inHerdr ? 72 : 140);
    if (!force && title === this.lastTitle) return;
    try {
      this.context?.ui.setTitle(title);
      this.lastTitle = title;
    } catch {
      // Presentation must not interrupt an agent run or extension shutdown.
    }
  }

  private latestActiveTool(): ActiveTool | undefined {
    let latest: ActiveTool | undefined;
    for (const tool of this.activeTools.values()) {
      if (!latest || tool.order > latest.order) latest = tool;
    }
    return latest;
  }

  private syncTimers(): void {
    const interval = this.busy && this.settings.activity && this.canSetTitle()
      ? this.settings.animation === "still"
        ? this.settings.elapsed ? 1_000 : 0
        : this.inHerdr ? HERDR_TITLE_FRAME_MS : TERMINAL_TITLE_FRAME_MS
      : 0;
    if (interval !== this.animationInterval) {
      if (this.animationTimer !== undefined) this.clock.clearInterval(this.animationTimer);
      this.animationTimer = undefined;
      this.animationInterval = interval;
      if (interval > 0) {
        // Only terminal-title rendering runs at animation frequency.
        this.animationTimer = this.clock.setInterval(() => this.renderTitle(), interval);
        this.animationTimer.unref?.();
      }
    }
    const needsRefresh = Boolean(this.reporter && Object.keys(this.tokens).length > 0);
    if (needsRefresh && this.ttlTimer === undefined) {
      this.ttlTimer = this.clock.setInterval(() => {
        if (!this.context) return;
        this.refreshPresentation(this.context);
        this.reporter?.refresh();
      }, this.ttlRefreshMs);
      this.ttlTimer.unref?.();
    } else if (!needsRefresh && this.ttlTimer !== undefined) {
      this.clock.clearInterval(this.ttlTimer);
      this.ttlTimer = undefined;
    }
  }

  private clearCompaction(): void {
    this.compacting = false;
    if (this.compactSignal && this.compactAbort) this.compactSignal.removeEventListener("abort", this.compactAbort);
    this.compactSignal = undefined;
    this.compactAbort = undefined;
  }

  private stopIdleCheck(): void {
    if (this.idleTimer !== undefined) this.clock.clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  private cancelToolClear(): void {
    if (this.clearToolTimer !== undefined) this.clock.clearTimeout(this.clearToolTimer);
    this.clearToolTimer = undefined;
  }

  private cancelTimers(): void {
    this.stopIdleCheck();
    this.cancelToolClear();
    if (this.ttlTimer !== undefined) this.clock.clearInterval(this.ttlTimer);
    if (this.animationTimer !== undefined) this.clock.clearInterval(this.animationTimer);
    if (this.startupTimer !== undefined) this.clock.clearTimeout(this.startupTimer);
    this.ttlTimer = undefined;
    this.animationTimer = undefined;
    this.startupTimer = undefined;
    this.animationInterval = 0;
  }
}
