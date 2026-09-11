import { Worker } from "node:worker_threads";
import type { ImportProgress, ImportResult, ImportSelectedInput } from "./contracts.js";

interface WorkerMessage {
  type: "progress" | "result" | "error";
  progress?: ImportProgress;
  result?: ImportResult;
  code?: string;
}

export async function importSelectedSession(databasePath: string, input: ImportSelectedInput): Promise<ImportResult> {
  if (typeof input.selectedPath !== "string" || !input.selectedPath.startsWith("/")) throw new Error("GLANCE_HISTORY_IMPORT_SELECTION_REQUIRED");
  return new Promise<ImportResult>((resolve, reject) => {
    const abortBuffer = new SharedArrayBuffer(4);
    const abortState = new Int32Array(abortBuffer);
    const worker = new Worker(new URL("./import-worker.js", import.meta.url), {
      workerData: { databasePath, selectedPath: input.selectedPath, expectedSessionId: input.expectedSessionId, abortBuffer },
    });
    let settled = false;
    const finish = (error?: Error, result?: ImportResult): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("GLANCE_HISTORY_IMPORT_FAILED"));
    };
    const abort = (): void => { Atomics.store(abortState, 0, 1); Atomics.notify(abortState, 0); };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress" && message.progress) input.onProgress?.(message.progress);
      else if (message.type === "result" && message.result) finish(undefined, message.result);
      else if (message.type === "error") finish(new Error(message.code ?? "GLANCE_HISTORY_IMPORT_FAILED"));
    });
    worker.once("error", () => finish(new Error("GLANCE_HISTORY_IMPORT_WORKER_FAILED")));
    worker.once("exit", (code) => { if (!settled && code !== 0) finish(new Error("GLANCE_HISTORY_IMPORT_WORKER_FAILED")); });
  });
}
