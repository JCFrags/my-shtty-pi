// IPC-only one-shot entry. The shared runtime establishes OS limits before Node
// loads this file. IPC payloads are bounded JSON strings, never complete indexes.
import { HISTORY_WORKER_CAPS, historyRefusal } from "./history-worker-contract.js";
import { handleHistoryWorkerRequest } from "./history-worker-handler.js";

process.once("message", async (request: unknown) => {
  let response: string;
  if (typeof request !== "string" || request.length > HISTORY_WORKER_CAPS.requestBytes || Buffer.byteLength(request) > HISTORY_WORKER_CAPS.requestBytes) {
    response = JSON.stringify(historyRefusal("history-request-limit"));
  } else {
    response = await handleHistoryWorkerRequest(request, (stage) => {
      process.send?.(JSON.stringify({ status: "stage", stage }));
    });
  }
  if (!process.send) { process.exitCode = 1; return; }
  process.send(response, () => { process.disconnect(); });
});
