/** Pi-side scheduling only: no SQLite, source reads, or archive-sized queues. */
export interface SearchLifecycleTarget {
  readonly sourcePath: string;
  readonly sessionKey: string;
  readonly shardKey: string;
  readonly catalogDirectory: string;
  readonly leafId: string;
}
export type SearchLayerState = "pending" | "lagging" | "ready";
export interface SearchLifecycleProgress {
  readonly catalog: SearchLayerState;
  readonly capsules: SearchLayerState;
  readonly index: SearchLayerState;
  /** An incomplete JSONL tail waits for the next real lifecycle event. */
  readonly waitingForAppend?: boolean;
}
export interface SearchLifecycleStatus extends SearchLifecycleProgress {
  readonly state: "disabled" | "idle" | "scheduled" | "running" | "cancelling" | "lagging" | "ready" | "error";
  readonly errorCode?: string;
}
export type SearchLifecycleStep = (target: SearchLifecycleTarget, signal: AbortSignal) => Promise<SearchLifecycleProgress>;
const pending = (): SearchLifecycleProgress => ({ catalog: "pending", capsules: "pending", index: "pending" });
const same = (a: SearchLifecycleTarget, b: SearchLifecycleTarget): boolean => Object.keys(a).every(key => a[key as keyof SearchLifecycleTarget] === b[key as keyof SearchLifecycleTarget]);
function checked(target: SearchLifecycleTarget): SearchLifecycleTarget {
  if (!target || Object.keys(target).sort().join(",") !== "catalogDirectory,leafId,sessionKey,shardKey,sourcePath" ||
    [target.sourcePath, target.catalogDirectory].some(x => typeof x !== "string" || !x.startsWith("/") || x.length > 4096 || x.includes("\0")) ||
    [target.sessionKey, target.shardKey].some(x => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x)) ||
    typeof target.leafId !== "string" || !target.leafId || target.leafId.length > 1024) throw new Error("search-lifecycle-target-invalid");
  return { ...target };
}
/** One bounded step per timer, one active caller, one coalesced replacement.
 * Queries do not call schedule(). Cancellation awaits worker settlement before
 * replacement; stale results cannot make a new branch look ready. */
export class SearchLifecycleScheduler {
  private closed = false;
  private enabled = false;
  private epoch = 0;
  private queued?: SearchLifecycleTarget;
  private active?: { target: SearchLifecycleTarget; controller: AbortController; settled: Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  private current: SearchLifecycleStatus = { state: "disabled", ...pending() };
  constructor(private readonly step: SearchLifecycleStep, private readonly delayMs = 100) {}
  status(): SearchLifecycleStatus { return { ...this.current }; }
  schedule(target: SearchLifecycleTarget): void {
    if (this.closed) return;
    const copy = checked(target);
    this.enabled = true;
    if (this.active && !same(this.active.target, copy)) this.cancel();
    this.queued = copy;
    if (!this.active) this.arm(0);
  }
  cancel(): void {
    this.epoch++;
    this.queued = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.controller.abort();
    this.current = { state: this.active ? "cancelling" : this.enabled ? "idle" : "disabled", ...pending() };
  }
  disable(): void { this.enabled = false; this.cancel(); this.current = { state: "disabled", ...pending() }; }
  dispose(): void { this.closed = true; this.disable(); }
  async drain(): Promise<void> { await this.active?.settled; }
  private arm(delay: number): void {
    if (this.timer || this.active || !this.queued || !this.enabled || this.closed) return;
    this.current = { ...this.current, state: delay ? "lagging" : "scheduled" };
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
    this.timer.unref?.();
  }
  private start(): void {
    if (this.active || !this.queued || !this.enabled || this.closed) return;
    const target = this.queued; this.queued = undefined;
    const epoch = this.epoch;
    const active = { target, controller: new AbortController(), settled: Promise.resolve() };
    this.active = active;
    this.current = { ...this.current, state: "running" };
    active.settled = Promise.resolve().then(() => this.step(target, active.controller.signal)).then(progress => {
      if (this.closed || epoch !== this.epoch) return;
      if (!progress || [progress.catalog, progress.capsules, progress.index].some(x => !["pending", "lagging", "ready"].includes(x)) ||
        (progress.waitingForAppend !== undefined && typeof progress.waitingForAppend !== "boolean")) throw new Error("search-lifecycle-response-invalid");
      const complete = progress.catalog === "ready" && progress.capsules === "ready" && progress.index === "ready";
      this.current = { ...progress, state: complete ? "ready" : "lagging" };
      if (!complete && !progress.waitingForAppend && !this.queued) this.queued = target;
    }).catch((error: unknown) => {
      if (this.closed || epoch !== this.epoch) return;
      const code = (error as { code?: unknown })?.code;
      this.current = { ...this.current, state: "error", errorCode: typeof code === "string" && /^(search|catalog|capsule)-[a-z0-9-]{1,80}$/.test(code) ? code : "search-lifecycle-failed" };
      this.queued = undefined;
    }).finally(() => {
      if (this.active === active) this.active = undefined;
      if (this.current.state === "cancelling") this.current = { state: this.enabled ? "idle" : "disabled", ...pending() };
      this.arm(this.delayMs);
    });
  }
}
