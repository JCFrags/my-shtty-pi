import type { EngineKeyEvent, PointerEvent } from "pixel-react";

export type InputResource = "pointer" | "keyboard" | "focus" | "viewport";
export type ReservationKind = "typing" | "pointer" | "wheel" | "chrome";
export interface InputReservationSummary {
  kind: ReservationKind;
  contextId: number | null;
  held: boolean;
}
interface Reservation {
  contextId: number | null;
  resources: readonly InputResource[];
  held: Set<string>;
  until: number;
}
export const ALL_INPUT: readonly InputResource[] = ["pointer", "keyboard", "focus", "viewport"];
const RESOURCES: Record<ReservationKind, readonly InputResource[]> = {
  typing: ["keyboard", "focus"], pointer: ALL_INPUT, wheel: ["pointer", "viewport"], chrome: ALL_INPUT,
};
const IDLE = { typing: 350, pointer: 250, wheel: 180, chrome: 350 };

/** Human priority is separate from mode and observation validity. */
export class InputArbiter {
  private readonly reservations = new Map<ReservationKind, Reservation>();
  private readonly listeners = new Set<() => void>();
  private readonly priorityListeners = new Set<(resources: readonly InputResource[]) => void | Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chromeDepth = 0;
  private pasteDepth = 0;
  private waiters = 0;
  private releasesReported = false;
  private priorityTail: Promise<void> = Promise.resolve();
  revision = 0;
  focusRevision = 0;

  constructor(private readonly shared: () => boolean, private readonly changed: () => void) {}

  setKeyReleaseReporting(reported: boolean): void { this.releasesReported = reported; }
  get pointerHeld(): boolean { return (this.reservations.get("pointer")?.held.size ?? 0) > 0; }
  get capabilities() {
    return { keyRelease: this.releasesReported ? "reported" as const : "unknown" as const,
      composition: "commit-only" as const, terminalImePreedit: false as const };
  }
  get summary(): { active: InputReservationSummary[]; waiting: boolean } {
    return { active: [...this.reservations].filter(([, item]) => this.live(item)).map(([kind, item]) =>
      ({ kind, contextId: item.contextId, held: item.held.size > 0 })), waiting: this.waiters > 0 };
  }
  onPriority(listener: (resources: readonly InputResource[]) => void | Promise<void>): () => void {
    this.priorityListeners.add(listener);
    return () => this.priorityListeners.delete(listener);
  }
  private live(item: Reservation): boolean { return item.held.size > 0 || item.until > Date.now(); }
  private reserve(kind: ReservationKind, contextId: number | null, update?: (held: Set<string>) => void, resources?: readonly InputResource[]): Promise<void> {
    const item = this.reservations.get(kind) ?? { contextId, resources: RESOURCES[kind], held: new Set<string>(), until: 0 };
    item.contextId = contextId;
    if (resources) item.resources = resources;
    update?.(item.held);
    item.until = Date.now() + IDLE[kind];
    this.reservations.set(kind, item);
    this.revision += 1;
    if (item.resources.includes("focus")) this.focusRevision += 1;
    // Fence committed operations synchronously. Native cleanup finishes before human dispatch.
    const cleanup = this.shared() || kind === "chrome"
      ? [...this.priorityListeners].map(listener => { try { return listener(item.resources); } catch { return undefined; } }) : [];
    this.priorityTail = Promise.all([this.priorityTail, ...cleanup]).then(() => undefined);
    // Keep cleanup failure visible to dispatch without an unhandled rejection for chrome-only holds.
    void this.priorityTail.catch(() => {});
    this.notify();
    return this.priorityTail;
  }
  key(event: EngineKeyEvent, contextId: number | null): Promise<void> {
    if (event.kind === "release") {
      const item = this.reservations.get("typing");
      if (item) { item.held.delete(event.key); item.until = Date.now() + IDLE.typing; this.notify(); }
      return this.priorityTail;
    }
    return this.reserve("typing", contextId, held => {
      if (this.releasesReported || event.kind === "repeat") held.add(event.key);
    }, event.mods.ctrl || event.mods.alt || event.mods.super || event.mods.shift || /^(left|right)(control|alt|super|shift)$/.test(event.key) ? ALL_INPUT : undefined);
  }
  pointer(event: Pick<PointerEvent, "kind" | "button">, contextId: number | null): Promise<void> {
    if (event.kind === "move") return this.priorityTail;
    if (event.kind === "up") {
      const item = this.reservations.get("pointer");
      if (item) { item.held.delete(event.button); item.until = Date.now() + IDLE.pointer; this.notify(); }
      return this.priorityTail;
    }
    return this.reserve("pointer", contextId, held => { if (event.button !== "none") held.add(event.button); });
  }
  wheel(contextId: number | null): Promise<void> { return this.reserve("wheel", contextId); }
  paste(contextId: number | null): Promise<void> {
    this.pasteDepth += 1;
    return this.reserve("typing", contextId, held => held.add("paste"));
  }
  finishPaste(): void {
    this.pasteDepth = Math.max(0, this.pasteDepth - 1);
    const item = this.reservations.get("typing");
    if (item && !this.pasteDepth) { item.held.delete("paste"); item.until = Date.now() + IDLE.typing; this.notify(); }
  }
  beginChrome(contextId: number | null): void {
    this.chromeDepth += 1;
    void this.reserve("chrome", contextId, held => held.add("open")).catch(() => {});
  }
  endChrome(): void {
    this.chromeDepth = Math.max(0, this.chromeDepth - 1);
    if (this.chromeDepth) return;
    const item = this.reservations.get("chrome");
    if (item) { item.held.clear(); item.until = Date.now() + IDLE.chrome; this.notify(); }
  }
  /** Call only after the browser-local physical release/reset path. */
  resetPhysical(): void {
    this.pasteDepth = 0;
    for (const [kind, item] of this.reservations) {
      if (kind === "chrome") continue;
      item.held.clear(); item.until = 0;
    }
    this.notify();
  }
  conflicts(resources: readonly InputResource[]): boolean {
    return [...this.reservations].some(([kind, item]) => (this.shared() || kind === "chrome") &&
      this.live(item) && item.resources.some(resource => resources.includes(resource)));
  }
  assertAvailable(resources: readonly InputResource[]): void {
    if (this.conflicts(resources)) throw new Error("human input has priority; input was not replayed");
  }
  async permit(resources: readonly InputResource[], guard: () => void, signal?: AbortSignal): Promise<boolean> {
    guard(); signal?.throwIfAborted();
    if (!this.conflicts(resources)) return false;
    const deadline = Date.now() + 2_000;
    this.waiters += 1;
    this.changed();
    try {
      while (this.conflicts(resources)) {
        guard(); signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("human input is busy; agent yielded without replay");
        await new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); this.listeners.delete(done); signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => { done(); reject(signal?.reason ?? new Error("input canceled")); };
          const timer = setTimeout(done, Math.min(40, deadline - Date.now()));
          this.listeners.add(done); signal?.addEventListener("abort", abort, { once: true });
        });
      }
      guard(); signal?.throwIfAborted();
      return true;
    } finally { this.waiters -= 1; this.changed(); }
  }
  private notify(): void {
    clearTimeout(this.timer);
    const now = Date.now();
    let next = Infinity;
    for (const [kind, item] of this.reservations) {
      if (!this.live(item)) this.reservations.delete(kind);
      else if (!item.held.size) next = Math.min(next, item.until - now);
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.notify(), Math.max(1, next));
    for (const listener of [...this.listeners]) listener();
    this.changed();
  }
}
