import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HISTORY_WORKER_CAPS, validateHistoryWorkerRequestWire, type HistoryWorkerRequest, type HistoryWorkerTransport } from "./history-worker-contract.js";
import { validateHistoryWorkerWire } from "./history-worker-dispatch.js";
import { runBoundedWorker, WorkerRuntimeError } from "./worker-runtime.js";

const SIDECAR_READ_BUDGET = 4 * 256 * 1024;
const RUNTIME_REFUSALS = new Set([
  "worker-aborted", "worker-timeout", "worker-resource-limit", "worker-crashed", "worker-internal-error",
  "worker-response-too-large", "worker-protocol-error", "worker-entrypoint-unavailable",
  "worker-source-limit", "worker-capability-unavailable", "worker-containment-unavailable", "worker-legacy-transition-required",
  "scheduler-timeout", "scheduler-queue-full", "scheduler-policy-mismatch",
]);

/** Production and synthetic callers share the same contained runtime. A supplied
 * schedulerDirectory is only for isolated synthetic acceptance tests. */
export function createHistoryRuntimeTransport(options: { slots?: number | (() => number); schedulerDirectory?: string } = {}): HistoryWorkerTransport {
  return {
    isolation: "os-bounded-child-v1",
    async run(wire, caps, signal) {
      try {
        validateHistoryWorkerRequestWire(wire);
        if (Object.keys(HISTORY_WORKER_CAPS).some((key) => caps[key as keyof typeof caps] !== HISTORY_WORKER_CAPS[key as keyof typeof caps])) {
          throw new Error("history-caps-invalid");
        }
        const request = JSON.parse(wire) as HistoryWorkerRequest;
        const sessionKey = createHash("sha256").update(request.path).digest("hex");
        const { value } = await runBoundedWorker<string, string>({
          entryPath: fileURLToPath(new URL("./history-worker-entry.js", import.meta.url)),
          request: wire,
          identity: { schemaVersion: 1, kind: `history-${request.operation.kind}`, sessionKey },
          caps: {
            deadlineMs: Date.now() + caps.timeoutMs,
            sourceBytes: Math.max(1, request.source.size + (request.operation.kind === "recall" && request.operation.promotion ? SIDECAR_READ_BUDGET : 0)),
            responseBytes: caps.responseBytes,
            memoryBytes: caps.memoryBytes,
            heapMiB: caps.heapMiB,
          },
          slots: typeof options.slots === "function" ? options.slots() : options.slots,
          schedulerDirectory: options.schedulerDirectory,
          signal,
          priority: "low",
          validateRequest(value) {
            validateHistoryWorkerRequestWire(value);
            return value as string;
          },
          validateResponse: validateHistoryWorkerWire,
        });
        return value;
      } catch (error) {
        const runtimeCode = error instanceof WorkerRuntimeError ? error.code : error instanceof Error ? error.message : undefined;
        const code = runtimeCode && RUNTIME_REFUSALS.has(runtimeCode)
          ? `history-${runtimeCode}` : signal?.aborted ? "history-worker-aborted" : "history-worker-failed";
        return JSON.stringify({ status: "refused", code });
      }
    },
  };
}
