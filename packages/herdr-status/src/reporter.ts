import {
  ACTIVITY_TTL_MS,
  COALESCE_MS,
  FAILURE_THRESHOLD,
  MAX_BACKOFF_MS,
  MIN_REPORT_INTERVAL_MS,
  type TokenSnapshot,
} from "./constants.ts";
import { systemClock, type Clock, type TimerHandle } from "./clock.ts";
import type { MetadataTransport } from "./herdr-client.ts";
import { redactCredentials, redactHomePathPrefixes, sanitizeVisible } from "./sanitize.ts";

export interface ReporterStatus {
  lastSuccessfulReportAt?: number;
  lastError?: string;
  consecutiveFailures: number;
  nextSequence: number;
  snapshot: TokenSnapshot;
}

export interface MetadataReporterOptions {
  clock?: Clock;
  coalesceMs?: number;
  minReportIntervalMs?: number;
  ttlMs?: number;
  failureThreshold?: number;
  maxBackoffMs?: number;
  notifyPaused?: (message: string) => void;
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeVisible(redactHomePathPrefixes(redactCredentials(message)), 160) || "unknown error";
}

export class MetadataReporter {
  private readonly clock: Clock;
  private readonly coalesceMs: number;
  private readonly minReportIntervalMs: number;
  private readonly ttlMs: number;
  private readonly failureThreshold: number;
  private readonly maxBackoffMs: number;
  private readonly notifyPaused: ((message: string) => void) | undefined;

  private snapshot: TokenSnapshot = {};
  private dirty = false;
  private timer: TimerHandle | undefined;
  private inFlight: Promise<void> | undefined;
  private lastDispatchAt = Number.NEGATIVE_INFINITY;
  private backoffUntil = 0;
  private nextSequence: number;
  private consecutiveFailures = 0;
  private pausedNotificationSent = false;
  private stopped = false;
  private lastSuccessfulReportAt: number | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly transport: MetadataTransport,
    options: MetadataReporterOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    const epochSequence = Math.trunc(Math.max(0, this.clock.now())) * 1_000 + 1;
    this.nextSequence = Number.isSafeInteger(epochSequence) ? epochSequence : 1;
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.minReportIntervalMs = options.minReportIntervalMs ?? MIN_REPORT_INTERVAL_MS;
    this.ttlMs = options.ttlMs ?? ACTIVITY_TTL_MS;
    this.failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.notifyPaused = options.notifyPaused;
  }

  setSnapshot(snapshot: TokenSnapshot): void {
    if (this.stopped) return;
    this.snapshot = { ...snapshot };
    this.queueReport();
  }

  refresh(): void {
    if (this.stopped) return;
    this.queueReport();
  }

  getStatus(): ReporterStatus {
    const status: ReporterStatus = {
      consecutiveFailures: this.consecutiveFailures,
      nextSequence: this.nextSequence,
      snapshot: { ...this.snapshot },
    };
    if (this.lastSuccessfulReportAt !== undefined) {
      status.lastSuccessfulReportAt = this.lastSuccessfulReportAt;
    }
    if (this.lastError !== undefined) {
      status.lastError = this.lastError;
    }
    return status;
  }

  async shutdownAndClear(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.dirty = false;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.inFlight) {
      await this.inFlight;
    }

    const clearDelayMs = Math.max(
      0,
      this.lastDispatchAt + this.minReportIntervalMs - this.clock.now(),
    );
    if (clearDelayMs > 0) {
      await new Promise<void>((resolve) => {
        this.clock.setTimeout(resolve, clearDelayMs);
      });
    }

    const sequence = this.nextSequence++;
    try {
      await this.transport.clear(sequence);
      this.lastSuccessfulReportAt = this.clock.now();
      this.lastError = undefined;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.lastError = conciseError(error);
      this.consecutiveFailures += 1;
    }
  }

  private queueReport(): void {
    this.dirty = true;
    if (this.inFlight || this.timer !== undefined) return;
    this.schedule(this.coalesceMs);
  }

  private schedule(requestedDelayMs: number): void {
    if (this.stopped || this.timer !== undefined) return;
    const now = this.clock.now();
    const earliest = Math.max(
      now + Math.max(0, requestedDelayMs),
      this.lastDispatchAt + this.minReportIntervalMs,
      this.backoffUntil,
    );
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.tryDispatch();
    }, Math.max(0, earliest - now));
  }

  private tryDispatch(): void {
    if (this.stopped || !this.dirty) return;
    if (this.inFlight) return;

    const now = this.clock.now();
    const earliest = Math.max(
      this.lastDispatchAt + this.minReportIntervalMs,
      this.backoffUntil,
    );
    if (now < earliest) {
      this.schedule(earliest - now);
      return;
    }

    this.dirty = false;
    const snapshot = { ...this.snapshot };
    const sequence = this.nextSequence++;
    this.lastDispatchAt = now;

    this.inFlight = this.transport
      .report(snapshot, sequence, this.ttlMs)
      .then(() => {
        this.lastSuccessfulReportAt = this.clock.now();
        this.lastError = undefined;
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        this.pausedNotificationSent = false;
      })
      .catch((error: unknown) => {
        this.lastError = conciseError(error);
        this.consecutiveFailures += 1;
        this.dirty = true;

        if (this.consecutiveFailures >= this.failureThreshold) {
          const exponent = this.consecutiveFailures - this.failureThreshold;
          const delay = Math.min(1_000 * 2 ** exponent, this.maxBackoffMs);
          this.backoffUntil = this.clock.now() + delay;
          if (!this.pausedNotificationSent) {
            this.pausedNotificationSent = true;
            this.notifyPaused?.("Herdr status reporting paused after repeated failures");
          }
        }
      })
      .finally(() => {
        this.inFlight = undefined;
        if (this.dirty && !this.stopped) {
          this.schedule(0);
        }
      });
  }
}
