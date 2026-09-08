export const FAULT_SCENARIOS = Object.freeze([
  "process-death-between-operations",
  "partial-write",
  "missing-manifest",
  "corrupt-manifest",
  "missing-segment",
  "corrupt-segment",
  "stale-ownership",
  "malformed-ownership",
  "pid-reuse",
  "worker-crash",
  "worker-timeout",
  "worker-resource-termination",
  "concurrent-writers",
  "source-append",
  "source-replacement",
  "source-truncation",
  "transaction-abort",
] as const);

export type FaultScenario = typeof FAULT_SCENARIOS[number];
export type FaultAction = "eio" | "enospc" | "short-write" | "abort" | "process-death";
export interface FaultPoint {
  readonly operation: string;
  readonly occurrence?: number;
  readonly action: FaultAction;
  readonly shortBytes?: number;
}
export interface FaultEvent {
  readonly operation: string;
  readonly occurrence: number;
  readonly action: FaultAction;
}

export class InjectedFault extends Error {
  readonly code: string;
  readonly operation: string;
  constructor(action: FaultAction, operation: string) {
    const code = action === "eio" ? "EIO" : action === "enospc" ? "ENOSPC" : action === "abort" ? "ABORT_ERR" : "SYNTHETIC_PROCESS_DEATH";
    super(`injected-${action}`);
    this.name = "InjectedFault";
    this.code = code;
    this.operation = operation;
  }
}

export class FaultController {
  readonly #points: readonly FaultPoint[];
  readonly #counts = new Map<string, number>();
  readonly events: FaultEvent[] = [];

  constructor(points: readonly FaultPoint[]) {
    if (!Array.isArray(points) || points.length > 128) throw new Error("fault-plan-invalid");
    this.#points = Object.freeze(points.map((point) => {
      if (!point || typeof point.operation !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(point.operation)) throw new Error("fault-operation-invalid");
      if (!(["eio", "enospc", "short-write", "abort", "process-death"] as const).includes(point.action)) throw new Error("fault-action-invalid");
      const occurrence = point.occurrence ?? 1;
      if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 1_000_000) throw new Error("fault-occurrence-invalid");
      if (point.action === "short-write" && (!Number.isSafeInteger(point.shortBytes) || (point.shortBytes ?? -1) < 0)) throw new Error("fault-short-write-invalid");
      return Object.freeze({ ...point, occurrence });
    }));
  }

  next(operation: string): FaultPoint | undefined {
    const occurrence = (this.#counts.get(operation) ?? 0) + 1;
    this.#counts.set(operation, occurrence);
    const point = this.#points.find((candidate) => candidate.operation === operation && (candidate.occurrence ?? 1) === occurrence);
    if (point) this.events.push(Object.freeze({ operation, occurrence, action: point.action }));
    return point;
  }

  before(operation: string): { readonly shortBytes?: number } {
    const point = this.next(operation);
    if (!point) return {};
    if (point.action === "short-write") return { shortBytes: point.shortBytes };
    throw new InjectedFault(point.action, operation);
  }

  count(operation: string): number { return this.#counts.get(operation) ?? 0; }
}

export function instrumentOperations<T extends Record<string, (...args: any[]) => any>>(operations: T, controller: FaultController): T {
  return new Proxy(operations, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: any[]) => {
        const decision = controller.before(property);
        if (decision.shortBytes === undefined) return value.apply(target, args);
        const requested = args.find((argument) => Buffer.isBuffer(argument) || argument instanceof Uint8Array);
        const bounded = Math.min(decision.shortBytes, requested?.byteLength ?? decision.shortBytes);
        return { bytesWritten: bounded, buffer: requested };
      };
    },
  });
}

export function corruptJson(text: string): string {
  if (typeof text !== "string" || text.length === 0) throw new Error("fault-json-invalid");
  return `${text.slice(0, Math.max(0, text.length - 1))}!`;
}

export function truncateBytes(text: string, retainedBytes: number): string {
  const bytes = Buffer.from(text);
  if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0 || retainedBytes > bytes.length) throw new Error("fault-truncation-invalid");
  return bytes.subarray(0, retainedBytes).toString("utf8");
}

export function mutateByte(text: string, offset: number): string {
  const bytes = Buffer.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) throw new Error("fault-mutation-invalid");
  bytes[offset] = bytes[offset] === 0x78 ? 0x79 : 0x78;
  return bytes.toString("utf8");
}

export function syntheticOwner(kind: "live" | "stale" | "malformed" | "pid-reuse"): unknown {
  if (kind === "malformed") return { schemaVersion: 1, pid: "invalid" };
  return Object.freeze({ schemaVersion: 1, pid: kind === "stale" ? 999_999_999 : 4242, processStartIdentity: kind === "pid-reuse" ? "old-start" : "current-start", nonce: "0123456789abcdef0123456789abcdef", createdAtMs: 1, priority: "low", jobType: "replay-compaction" });
}
