import type { ProjectGlanceCurrent } from "../protocol/model.js";
import {
  parseTodoSummaryChanged,
  parseTodoSummary,
  parseWorkplanSummaryChanged,
  parseWorkplanSummary,
  TODO_SUMMARY_CHANGED_EVENT,
  TODO_SUMMARY_EVENT,
  TODO_SUMMARY_REQUEST_EVENT,
  WORKPLAN_SUMMARY_CHANGED_EVENT,
  WORKPLAN_SUMMARY_EVENT,
  WORKPLAN_SUMMARY_REQUEST_EVENT,
  type TodoCurrentTask,
  type WorkplanCurrentPlan,
} from "./contracts.js";
import { formatCurrentProjection } from "./format.js";

export interface ProjectGlanceEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ProjectGlanceCurrentControllerOptions {
  eventBus: ProjectGlanceEventBus;
  onChange(current: ProjectGlanceCurrent): void;
  retryDelaysMs?: readonly number[];
}

type Source = "todo" | "workplan";

type PendingRequest = {
  requestId: string;
  branchId: string;
  epoch: number;
  retryIndex: number;
};

const DEFAULT_RETRY_DELAYS_MS = [50, 200, 1_000] as const;

export class ProjectGlanceCurrentController {
  readonly #eventBus: ProjectGlanceEventBus;
  readonly #onChange: (current: ProjectGlanceCurrent) => void;
  readonly #retryDelaysMs: readonly number[];
  readonly #removers: Array<() => void> = [];
  readonly #retryTimers = new Map<Source, Set<ReturnType<typeof setTimeout>>>();
  readonly #refreshTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly #pending = new Map<Source, PendingRequest>();
  #todo: TodoCurrentTask | undefined;
  #workplan: WorkplanCurrentPlan | undefined;
  #branchId = "root";
  #epoch = 0;
  #sequence = 0;
  #started = false;
  #disposed = false;
  #visible: ProjectGlanceCurrent = {};

  constructor(options: ProjectGlanceCurrentControllerOptions) {
    this.#eventBus = options.eventBus;
    this.#onChange = options.onChange;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#removers.push(
      this.#eventBus.on(TODO_SUMMARY_EVENT, (value) => this.#acceptTodo(value)),
      this.#eventBus.on(WORKPLAN_SUMMARY_EVENT, (value) => this.#acceptWorkplan(value)),
      this.#eventBus.on(TODO_SUMMARY_CHANGED_EVENT, (value) => this.#changed("todo", value)),
      this.#eventBus.on(WORKPLAN_SUMMARY_CHANGED_EVENT, (value) => this.#changed("workplan", value)),
    );
  }

  get branchId(): string {
    return this.#branchId;
  }

  get current(): ProjectGlanceCurrent {
    return { ...this.#visible };
  }

  start(branchId: string): void {
    if (this.#disposed) return;
    if (this.#started) {
      this.onSessionTree(branchId);
      return;
    }
    this.#started = true;
    this.#branchId = branchId || "root";
    this.#epoch += 1;
    this.#scheduleRefresh();
  }

  onSessionTree(branchId: string): void {
    if (this.#disposed) return;
    this.#started = true;
    this.#epoch += 1;
    this.#branchId = branchId || "root";
    this.#pending.clear();
    this.#cancelRetries();
    this.#cancelRefreshTimers();
    this.#todo = undefined;
    this.#workplan = undefined;
    this.#publish();
    this.#scheduleRefresh();
  }

  refresh(): void {
    if (!this.#disposed && this.#started) {
      this.#cancelRefreshTimers();
      this.#requestAll();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#started = false;
    this.#epoch += 1;
    this.#pending.clear();
    this.#cancelRetries();
    this.#cancelRefreshTimers();
    for (const remove of this.#removers.splice(0)) remove();
  }

  #requestAll(): void {
    this.#request("todo");
    this.#request("workplan");
  }

  #scheduleRefresh(): void {
    const epoch = this.#epoch;
    const timer = setTimeout(() => {
      this.#refreshTimers.delete(timer);
      if (!this.#started || this.#disposed || epoch !== this.#epoch) return;
      this.#requestAll();
    }, 0);
    timer.unref?.();
    this.#refreshTimers.add(timer);
  }

  #request(source: Source): void {
    if (!this.#started || this.#disposed) return;
    const requestId = `project-glance-${this.#epoch}-${source}-${++this.#sequence}`;
    const request: PendingRequest = { requestId, branchId: this.#branchId, epoch: this.#epoch, retryIndex: 0 };
    this.#pending.set(source, request);
    const channel = source === "todo" ? TODO_SUMMARY_REQUEST_EVENT : WORKPLAN_SUMMARY_REQUEST_EVENT;
    try {
      this.#eventBus.emit(channel, { version: 1, requestId, branchId: this.#branchId });
    } catch {
      // A provider is optional; the bounded retry path handles a failed emit.
    }
    this.#scheduleRetry(source, request);
  }

  #scheduleRetry(source: Source, request: PendingRequest): void {
    if (request.retryIndex >= this.#retryDelaysMs.length) return;
    const delay = Math.max(0, this.#retryDelaysMs[request.retryIndex] ?? 0);
    const timer = setTimeout(() => {
      this.#retryTimers.get(source)?.delete(timer);
      const current = this.#pending.get(source);
      if (!current || current.requestId !== request.requestId || current.epoch !== this.#epoch || !this.#started || this.#disposed) return;
      const next = { ...current, retryIndex: current.retryIndex + 1 };
      this.#pending.set(source, next);
      const channel = source === "todo" ? TODO_SUMMARY_REQUEST_EVENT : WORKPLAN_SUMMARY_REQUEST_EVENT;
      try {
        this.#eventBus.emit(channel, { version: 1, requestId: next.requestId, branchId: next.branchId });
      } catch {
        // Continue through the finite retry budget.
      }
      this.#scheduleRetry(source, next);
    }, delay);
    timer.unref?.();
    const timers = this.#retryTimers.get(source) ?? new Set<ReturnType<typeof setTimeout>>();
    timers.add(timer);
    this.#retryTimers.set(source, timers);
  }

  #changed(source: Source, value: unknown): void {
    if (!this.#started || this.#disposed) return;
    const accepted = source === "todo"
      ? parseTodoSummaryChanged(value, this.#branchId)
      : parseWorkplanSummaryChanged(value, this.#branchId);
    if (!accepted) return;
    this.#request(source);
  }

  #acceptTodo(value: unknown): void {
    const pending = this.#pending.get("todo");
    if (!pending || pending.epoch !== this.#epoch || pending.branchId !== this.#branchId) return;
    const parsed = parseTodoSummary(value, pending.requestId, this.#branchId);
    if (!parsed) return;
    this.#pending.delete("todo");
    this.#cancelRetries("todo");
    this.#todo = parsed.task;
    this.#publish();
  }

  #acceptWorkplan(value: unknown): void {
    const pending = this.#pending.get("workplan");
    if (!pending || pending.epoch !== this.#epoch || pending.branchId !== this.#branchId) return;
    const parsed = parseWorkplanSummary(value, pending.requestId, this.#branchId);
    if (!parsed) return;
    this.#pending.delete("workplan");
    this.#cancelRetries("workplan");
    this.#workplan = parsed.plan;
    this.#publish();
  }

  #publish(): void {
    const next = formatCurrentProjection(this.#todo, this.#workplan);
    if (JSON.stringify(next) === JSON.stringify(this.#visible)) return;
    this.#visible = next;
    try {
      this.#onChange({ ...next });
    } catch {
      // A relay may be stopping concurrently; source state remains safe.
    }
  }

  #cancelRetries(source?: Source): void {
    const sources: Source[] = source ? [source] : ["todo", "workplan"];
    for (const item of sources) {
      const timers = this.#retryTimers.get(item);
      if (!timers) continue;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      this.#retryTimers.delete(item);
    }
  }

  #cancelRefreshTimers(): void {
    for (const timer of this.#refreshTimers) clearTimeout(timer);
    this.#refreshTimers.clear();
  }
}
