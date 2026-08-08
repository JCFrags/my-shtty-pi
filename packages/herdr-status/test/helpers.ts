import type { Clock, TimerHandle } from "../src/clock.ts";
import type { TokenSnapshot } from "../src/constants.ts";
import type { MetadataTransport } from "../src/herdr-client.ts";
import type {
  PiCommandDefinition,
  PiExtensionApi,
  PiExtensionContext,
  PiEventHandler,
  PiEventMap,
  PiModel,
} from "../src/pi-types.ts";
import type { ReporterStatus } from "../src/reporter.ts";

interface FakeTimer {
  id: number;
  at: number;
  callback: () => void;
  intervalMs?: number;
}

export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(initialTimeMs = 0) {
    this.current = initialTimeMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return this.addTimer(callback, delayMs);
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const handle = this.addTimer(callback, intervalMs);
    const timer = this.timers.get(handle as unknown as number);
    if (timer) timer.intervalMs = intervalMs;
    return handle;
  }

  clearInterval(handle: TimerHandle): void {
    this.clearTimeout(handle);
  }

  async tick(milliseconds: number): Promise<void> {
    const target = this.current + milliseconds;
    let iterations = 0;

    while (true) {
      if (++iterations > 10_000) throw new Error("fake clock timer loop exceeded limit");
      const next = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;

      this.current = next.at;
      this.timers.delete(next.id);
      if (next.intervalMs !== undefined) {
        this.timers.set(next.id, {
          ...next,
          at: this.current + next.intervalMs,
        });
      }
      next.callback();
      await flushMicrotasks();
    }

    this.current = target;
    await flushMicrotasks();
  }

  private addTimer(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      at: this.current + Math.max(0, delayMs),
      callback,
    });
    return id as unknown as TimerHandle;
  }
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export interface CapturedReport {
  snapshot: TokenSnapshot;
  sequence: number;
  ttlMs: number;
}

export class CapturingTransport implements MetadataTransport {
  readonly reports: CapturedReport[] = [];
  readonly clears: number[] = [];
  reportError: Error | undefined;
  clearError: Error | undefined;

  async report(snapshot: TokenSnapshot, sequence: number, ttlMs: number): Promise<void> {
    this.reports.push({ snapshot: { ...snapshot }, sequence, ttlMs });
    if (this.reportError) throw this.reportError;
  }

  async clear(sequence: number): Promise<void> {
    this.clears.push(sequence);
    if (this.clearError) throw this.clearError;
  }
}

export class CapturingActivityReporter {
  readonly snapshots: TokenSnapshot[] = [];
  refreshCount = 0;
  shutdownCount = 0;

  setSnapshot(snapshot: TokenSnapshot): void {
    this.snapshots.push({ ...snapshot });
  }

  refresh(): void {
    this.refreshCount += 1;
  }

  getStatus(): ReporterStatus {
    return {
      consecutiveFailures: 0,
      nextSequence: 1,
      snapshot: this.latestSnapshot(),
    };
  }

  async shutdownAndClear(): Promise<void> {
    this.shutdownCount += 1;
  }

  latestSnapshot(): TokenSnapshot {
    return { ...(this.snapshots.at(-1) ?? {}) };
  }
}

export class FakePi implements PiExtensionApi {
  readonly handlers = new Map<string, PiEventHandler<unknown>[]>();
  readonly commands = new Map<string, PiCommandDefinition>();

  on<K extends keyof PiEventMap>(event: K, handler: PiEventHandler<PiEventMap[K]>): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler as PiEventHandler<unknown>);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, definition: PiCommandDefinition): void {
    this.commands.set(name, definition);
  }

  async emit(event: string, value: unknown, context: PiExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(value, context);
    }
  }
}

export interface ContextHarness {
  context: PiExtensionContext;
  notifications: { message: string; type: string | undefined }[];
  setContextPercent(percent: number | null): void;
  setModel(model: PiModel | undefined): void;
}

export function createContext(
  cwd = "/workspace/test/project",
  model: PiModel | undefined = {
    id: "gpt-5.6-pro",
    name: "GPT-5.6 Pro",
    provider: "openai",
    contextWindow: 200_000,
  },
  initialPercent: number | null = 25,
): ContextHarness {
  let currentPercent = initialPercent;
  let currentModel: PiModel | undefined = model;
  const notifications: { message: string; type: string | undefined }[] = [];
  const context: PiExtensionContext = {
    cwd,
    get model() {
      return currentModel;
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    getContextUsage() {
      if (currentPercent === null) {
        return { tokens: null, contextWindow: 200_000, percent: null };
      }
      return {
        tokens: Math.round((currentPercent / 100) * 200_000),
        contextWindow: 200_000,
        percent: currentPercent,
      };
    },
  };

  return {
    context,
    notifications,
    setContextPercent(percent) {
      currentPercent = percent;
    },
    setModel(nextModel) {
      currentModel = nextModel;
    },
  };
}
