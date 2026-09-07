import { pathToFileURL } from "node:url";
import { installWorkerReadBudget } from "./worker-runtime-read-budget.js";
import { MAX_WORKER_REQUEST_BYTES } from "./compaction-worker-protocol.js";

interface Initialization { entry: string; request: unknown; sourceBytes: number; }
async function initialize(value: Initialization, stdio: boolean): Promise<void> {
  // Trusted module loading is under the cgroup cap; data reads start after import.
  await import(pathToFileURL(value.entry).href);
  installWorkerReadBudget(value.sourceBytes);
  if (stdio) { process.stdin.unshift(Buffer.from(JSON.stringify(value.request) + "\n")); process.stdin.resume(); }
  else process.emit("message", value.request, undefined);
}
if (process.argv[2] === "stdio") {
  let input = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    if (input.length + chunk.length > MAX_WORKER_REQUEST_BYTES + 8192) process.exit(65);
    input = Buffer.concat([input, chunk]);
    const end = input.indexOf(10); if (end < 0) return;
    process.stdin.pause(); process.stdin.removeListener("data", receive);
    try { void initialize(JSON.parse(input.subarray(0, end).toString("utf8")), true).catch(() => process.exit(68)); }
    catch { process.exit(65); }
  };
  process.stdin.on("data", receive);
} else process.once("message", value => { void initialize(value as Initialization, false).catch(() => process.exit(68)); });

const unexpected = (error: unknown) => process.exit((error as { code?: unknown })?.code === "worker-source-limit" ? 69 : 68);
process.on("uncaughtException", unexpected);
process.on("unhandledRejection", unexpected);
