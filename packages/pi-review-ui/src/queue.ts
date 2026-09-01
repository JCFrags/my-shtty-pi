export interface QueuePosition {
  current: number;
  total: number;
}

export interface QueueRunContext {
  signal: AbortSignal;
  getPosition(): QueuePosition;
  onPositionChange(listener: (position: QueuePosition) => void): () => void;
}

export class QueueAbortError extends Error {
  readonly blockReason: string;

  constructor(blockReason: string) {
    super(blockReason);
    this.name = "QueueAbortError";
    this.blockReason = blockReason;
  }
}

type QueueRunner = (context: QueueRunContext) => Promise<unknown>;

interface QueueItem {
  id: number;
  runner: QueueRunner;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  controller: AbortController;
  externalSignal?: AbortSignal;
  removeExternalAbort?: () => void;
  positionListeners: Set<(position: QueuePosition) => void>;
  settled: boolean;
}

export class ReviewQueue {
  private readonly pending: QueueItem[] = [];
  private active: QueueItem | undefined;
  private nextId = 1;
  private batchTotal = 0;
  private batchCompleted = 0;

  get size(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  enqueue<T>(runner: (context: QueueRunContext) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    if (this.size === 0) {
      this.batchTotal = 0;
      this.batchCompleted = 0;
    }

    let resolveItem!: (value: T | PromiseLike<T>) => void;
    let rejectItem!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveItem = resolve;
      rejectItem = reject;
    });

    const item: QueueItem = {
      id: this.nextId++,
      runner: runner as QueueRunner,
      resolve: (value) => resolveItem(value as T),
      reject: rejectItem,
      controller: new AbortController(),
      positionListeners: new Set<(position: QueuePosition) => void>(),
      settled: false,
      ...(externalSignal ? { externalSignal } : {}),
    };

    this.batchTotal += 1;
    this.pending.push(item);
    this.attachExternalAbort(item);
    this.notifyActivePosition();
    this.pump();
    return promise;
  }

  abortAll(blockReason: string): void {
    const error = new QueueAbortError(blockReason);
    if (this.active && !this.active.controller.signal.aborted) {
      this.active.controller.abort(error);
    }

    const queued = this.pending.splice(0);
    for (const item of queued) {
      this.batchTotal = Math.max(this.batchCompleted + (this.active ? 1 : 0), this.batchTotal - 1);
      this.settleRejected(item, error);
    }
    this.notifyActivePosition();

    if (!this.active) this.resetBatchIfIdle();
  }

  private attachExternalAbort(item: QueueItem): void {
    const signal = item.externalSignal;
    if (!signal) return;

    const abort = (): void => {
      const reason = new QueueAbortError("Review aborted: tool call was cancelled");
      if (this.active === item) {
        if (!item.controller.signal.aborted) item.controller.abort(reason);
        return;
      }

      const index = this.pending.indexOf(item);
      if (index >= 0) {
        this.pending.splice(index, 1);
        this.batchTotal = Math.max(this.batchCompleted + (this.active ? 1 : 0), this.batchTotal - 1);
        this.settleRejected(item, reason);
        this.notifyActivePosition();
        this.resetBatchIfIdle();
      }
    };

    if (signal.aborted) {
      queueMicrotask(abort);
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    item.removeExternalAbort = (): void => signal.removeEventListener("abort", abort);
  }

  private pump(): void {
    if (this.active || this.pending.length === 0) return;
    const item = this.pending.shift();
    if (!item || item.settled) {
      this.pump();
      return;
    }

    this.active = item;
    this.notifyPosition(item);

    const context: QueueRunContext = {
      signal: item.controller.signal,
      getPosition: () => this.getPositionFor(item),
      onPositionChange: (listener) => {
        item.positionListeners.add(listener);
        listener(this.getPositionFor(item));
        return () => item.positionListeners.delete(listener);
      },
    };

    const runPromise = Promise.resolve().then(() => item.runner(context));
    // If an abort wins the race, consume any later runner rejection so the
    // agent loop never receives an unhandled rejection.
    void runPromise.catch(() => undefined);
    let removeInternalAbortListener = (): void => {};
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const rejectForAbort = (): void => {
        const reason = item.controller.signal.reason;
        reject(reason instanceof Error ? reason : new QueueAbortError("Review aborted"));
      };
      if (item.controller.signal.aborted) {
        rejectForAbort();
      } else {
        item.controller.signal.addEventListener("abort", rejectForAbort, { once: true });
        removeInternalAbortListener = () => item.controller.signal.removeEventListener("abort", rejectForAbort);
      }
    });

    void (async () => {
      let succeeded = false;
      let value: unknown;
      let failure: unknown;
      try {
        value = await Promise.race([runPromise, abortPromise]);
        succeeded = true;
      } catch (error: unknown) {
        failure = error;
      }

      removeInternalAbortListener();
      if (this.active === item) {
        this.active = undefined;
        this.batchCompleted += 1;
        item.positionListeners.clear();
        this.pump();
        this.resetBatchIfIdle();
      }

      if (succeeded) this.settleResolved(item, value);
      else this.settleRejected(item, failure);
    })();
  }

  private getPositionFor(item: QueueItem): QueuePosition {
    if (this.active === item) {
      return {
        current: Math.min(this.batchCompleted + 1, Math.max(1, this.batchTotal)),
        total: Math.max(1, this.batchTotal),
      };
    }

    const pendingIndex = this.pending.indexOf(item);
    return {
      current: Math.max(1, this.batchCompleted + (this.active ? 1 : 0) + pendingIndex + 1),
      total: Math.max(1, this.batchTotal),
    };
  }

  private notifyActivePosition(): void {
    if (this.active) this.notifyPosition(this.active);
  }

  private notifyPosition(item: QueueItem): void {
    const position = this.getPositionFor(item);
    for (const listener of item.positionListeners) listener(position);
  }

  private settleResolved(item: QueueItem, value: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.removeExternalAbort?.();
    item.resolve(value);
  }

  private settleRejected(item: QueueItem, error: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.removeExternalAbort?.();
    item.reject(error);
  }

  private resetBatchIfIdle(): void {
    if (this.size !== 0) return;
    this.batchTotal = 0;
    this.batchCompleted = 0;
  }
}
