export interface CatalogShadowTarget {
  readonly catalogDirectory: string;
  readonly sessionKey: string;
  readonly shardKey: string;
  readonly sourcePath: string;
}
export interface CatalogShadowProgress { readonly complete: boolean; readonly sourceBytesRead: number; readonly events: number }
export interface CatalogShadowStatus {
  readonly state: "disabled" | "idle" | "scheduled" | "running" | "cancelling" | "lagging" | "ready" | "error";
  readonly sourceBytesRead?: number;
  readonly events?: number;
  readonly errorCode?: string;
}
export type CatalogShadowRun = (target: CatalogShadowTarget, signal: AbortSignal) => Promise<CatalogShadowProgress>;
function checkedTarget(target: CatalogShadowTarget): CatalogShadowTarget {
  if (!target || Object.keys(target).sort().join(",") !== "catalogDirectory,sessionKey,shardKey,sourcePath" ||
      [target.catalogDirectory, target.sourcePath].some(value => typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.length > 4096) ||
      [target.sessionKey, target.shardKey].some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw new Error("catalog-shadow-target-invalid");
  return { ...target };
}
const sameTarget = (a: CatalogShadowTarget, b: CatalogShadowTarget): boolean => a.catalogDirectory === b.catalogDirectory && a.sessionKey === b.sessionKey && a.shardKey === b.shardKey && a.sourcePath === b.sourcePath;

/** One running caller and one replacement target, never an archive-sized queue.
 * The callback must use M03 containment. Local cancellation does not claim that
 * its process tree has exited, and a replacement waits for caller settlement.
 * No filesystem or database operation runs on the scheduling call stack.
 */
export class CatalogShadowScheduler {
  private enabled = false;
  private closed = false;
  private generation = 0;
  private pending?: CatalogShadowTarget;
  private active?: { target: CatalogShadowTarget; controller: AbortController; settled: Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  private current: CatalogShadowStatus = { state: "disabled" };
  constructor(private readonly run: CatalogShadowRun) {}
  status(): CatalogShadowStatus { return { ...this.current }; }
  schedule(target: CatalogShadowTarget, enabled: boolean): void {
    if (this.closed) return;
    if (!enabled) { this.enabled = false; this.cancel(); this.current = { state: "disabled" }; return; }
    const checked = checkedTarget(target);
    this.enabled = true;
    if (this.active && !sameTarget(this.active.target, checked)) this.cancel();
    this.pending = checked;
    if (!this.active) this.arm(0);
  }
  cancel(): void {
    this.generation++;
    this.pending = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.controller.abort();
    this.current = { state: this.active ? "cancelling" : this.enabled ? "idle" : "disabled" };
  }
  dispose(): void { this.closed = true; this.enabled = false; this.cancel(); this.current = { state: "disabled" }; }
  /** For synthetic checks or an explicit shutdown wait, not interactive hooks. */
  async drain(): Promise<void> { await this.active?.settled; }
  private arm(delay: number): void {
    if (this.timer || this.active || !this.pending || !this.enabled || this.closed) return;
    this.current = { ...this.current, state: delay ? "lagging" : "scheduled" };
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
    this.timer.unref?.();
  }
  private start(): void {
    if (this.active || !this.pending || !this.enabled || this.closed) return;
    const target = this.pending; this.pending = undefined;
    const generation = this.generation;
    const controller = new AbortController();
    this.current = { state: "running" };
    // Deferring the callback also handles synchronous callback errors uniformly.
    const active = { target, controller, settled: Promise.resolve() };
    this.active = active;
    active.settled = Promise.resolve().then(() => this.run(target, controller.signal)).then(progress => {
      if (this.closed || generation !== this.generation) return;
      if (!progress || typeof progress.complete !== "boolean" || !Number.isSafeInteger(progress.sourceBytesRead) || progress.sourceBytesRead < 0 || !Number.isSafeInteger(progress.events) || progress.events < 0) throw new Error("catalog-shadow-response-invalid");
      this.current = { state: progress.complete ? "ready" : "lagging", sourceBytesRead: progress.sourceBytesRead, events: progress.events };
      if (!progress.complete && !this.pending) this.pending = target;
    }).catch((error: unknown) => {
      if (this.closed || generation !== this.generation) return;
      const candidate = (error as { code?: unknown })?.code;
      this.current = { state: "error", errorCode: typeof candidate === "string" && /^catalog-[a-z-]{1,64}$/.test(candidate) ? candidate : "catalog-shadow-failed" };
      // No automatic rebuild or retry after corruption/capability/error refusal.
      this.pending = undefined;
    }).finally(() => {
      if (this.active === active) this.active = undefined;
      if (this.current.state === "cancelling") this.current = { state: this.enabled ? "idle" : "disabled" };
      if (this.pending && this.enabled && !this.closed) this.arm(100);
    });
  }
}
