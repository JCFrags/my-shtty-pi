import { isDeepStrictEqual } from "node:util";
import { CAPSULE_LIMITS, isCapsuleReadiness, isCapsuleWorkerRequest, type CapsuleReadiness, type CapsuleWorkerRequest } from "./capsule-contract.js";

export type CapsuleShadowTarget = Extract<CapsuleWorkerRequest, { readonly op: "derivePage" }>;
export interface CapsuleShadowProgress {
  readonly complete: boolean;
  readonly sourceBytes: number;
  readonly readiness: CapsuleReadiness;
}
export interface CapsuleShadowStatus {
  readonly state: "disabled" | "idle" | "scheduled" | "running" | "cancelling" | "lagging" | "settled" | "error";
  readonly readiness?: CapsuleReadiness;
  readonly sourceBytes?: number;
  readonly errorCode?: string;
}
export type CapsuleShadowRun = (target: CapsuleShadowTarget, signal: AbortSignal) => Promise<CapsuleShadowProgress>;

/** Default-off, one caller plus one replacement target. All store work belongs
 * in the injected contained-worker callback, never on this scheduling stack.
 * Settled means the selected derive pass ended, NOT that either layer is ready.
 * No model-facing output or current compactor state is changed here.
 */
export class CapsuleShadowScheduler {
  private enabled = false;
  private closed = false;
  private generation = 0;
  private pending?: CapsuleShadowTarget;
  private active?: { target: CapsuleShadowTarget; controller: AbortController; settled: Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  private current: CapsuleShadowStatus = { state: "disabled" };
  constructor(private readonly run: CapsuleShadowRun) {}
  status(): CapsuleShadowStatus { return structuredClone(this.current); }
  schedule(target: CapsuleShadowTarget, enabled = false): void {
    if (this.closed) return;
    if (!enabled) { this.disable(); return; }
    if (!isCapsuleWorkerRequest(target) || target.op !== "derivePage") throw new Error("capsule-shadow-target-invalid");
    const checked = structuredClone(target);
    this.enabled = true;
    if (this.active && !isDeepStrictEqual(this.active.target, checked)) this.cancel();
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
  disable(): void { this.enabled = false; this.cancel(); this.current = { state: "disabled" }; }
  dispose(): void { this.closed = true; this.disable(); }
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
    const active = { target, controller, settled: Promise.resolve() };
    this.active = active;
    active.settled = Promise.resolve().then(() => this.run(target, controller.signal)).then(progress => {
      if (this.closed || generation !== this.generation) return;
      if (!progress || typeof progress.complete !== "boolean" || !Number.isSafeInteger(progress.sourceBytes)
        || progress.sourceBytes < 0 || progress.sourceBytes > CAPSULE_LIMITS.sourceBytesPerJob
        || !isCapsuleReadiness(progress.readiness)
        || !isDeepStrictEqual(progress.readiness.identity, target.identity)
        || !isDeepStrictEqual(progress.readiness.view, target.view)) throw new Error("capsule-shadow-response-invalid");
      this.current = { state: progress.complete ? "settled" : "lagging", sourceBytes: progress.sourceBytes, readiness: structuredClone(progress.readiness) };
      // Resume via the store's durable checkpoint, not an expanding client map.
      if (!progress.complete && !this.pending) this.pending = { ...target, cursor: undefined };
    }).catch((error: unknown) => {
      if (this.closed || generation !== this.generation) return;
      const candidate = (error as { code?: unknown })?.code;
      this.current = { state: "error", errorCode: typeof candidate === "string" && /^capsule-[a-z0-9-]{1,80}$/.test(candidate) ? candidate : "capsule-shadow-failed" };
      this.pending = undefined; // Explicit reschedule only after failure.
    }).finally(() => {
      if (this.active === active) this.active = undefined;
      if (this.current.state === "cancelling") this.current = { state: this.enabled ? "idle" : "disabled" };
      if (this.pending && this.enabled && !this.closed) this.arm(100);
    });
  }
}
