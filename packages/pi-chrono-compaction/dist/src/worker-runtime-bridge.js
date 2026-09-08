import { fileURLToPath } from "node:url";
import { WORKER_LIMITS } from "./worker-runtime-limits.js";
import { fork, spawn } from "node:child_process";
import { MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES, MAX_WORKER_STDERR_BYTES } from "./compaction-worker-protocol.js";
// Only the fixed bridge path is in unit arguments. Requests and private paths
// cross pipes; no content goes to a journal or shared result artifact.
process.stdout.write('{"kind":"runtime-ready"}\n');
let input = Buffer.alloc(0);
let started = false;
process.stdin.on("data", (chunk) => {
    if (started || input.length + chunk.length > MAX_WORKER_REQUEST_BYTES + 8192)
        process.exit(65);
    input = Buffer.concat([input, chunk]);
    const end = input.indexOf(10);
    if (end < 0)
        return;
    started = true;
    try {
        const { entry, request, sourceBytes = WORKER_LIMITS.sourceBytes, responseBytes = MAX_WORKER_RESPONSE_BYTES, transport = "ipc", heapMiB } = JSON.parse(input.subarray(0, end).toString("utf8"));
        input = Buffer.alloc(0);
        const bootstrap = fileURLToPath(new URL("./worker-runtime-bootstrap.js", import.meta.url));
        const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
        const execArgv = heapMiB === undefined ? [] : [`--max-old-space-size=${heapMiB}`];
        const child = transport === "stdio" ? spawn(process.execPath, [...execArgv, bootstrap, "stdio"], { stdio: ["pipe", "pipe", "pipe"], env }) : fork(bootstrap, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env, execArgv, serialization: "json" });
        let outputBytes = 0, stderrBytes = 0;
        const output = (bytes) => { outputBytes += bytes.length; if (outputBytes > responseBytes + 65536)
            process.exit(67); process.stdout.write(bytes); };
        child.stderr?.on("data", (bytes) => { stderrBytes += bytes.length; if (stderrBytes <= MAX_WORKER_STDERR_BYTES)
            process.stderr.write(bytes);
        else
            process.exit(66); });
        const message = (value) => output(Buffer.from(JSON.stringify({ kind: "runtime-message", value }) + "\n"));
        let stdioBuffer = Buffer.alloc(0), stdioBytes = 0;
        child.stdout?.on("data", (bytes) => {
            stdioBytes += bytes.length;
            if (stdioBytes > responseBytes + 65536)
                process.exit(67);
            stdioBuffer = Buffer.concat([stdioBuffer, bytes]);
            for (;;) {
                const end = stdioBuffer.indexOf(10);
                if (end < 0)
                    return;
                const line = stdioBuffer.subarray(0, end);
                stdioBuffer = stdioBuffer.subarray(end + 1);
                try {
                    message(JSON.parse(line.toString("utf8")));
                }
                catch {
                    process.exit(65);
                }
            }
        });
        child.on("message", message);
        child.on("error", () => process.exit(68));
        child.on("close", (code, signal) => { if (code === 69)
            process.stdout.write('{"kind":"runtime-limit","code":"worker-source-limit"}\n'); process.stdout.write(JSON.stringify({ kind: "runtime-exit", code, signal }) + "\n", () => process.exit(code ?? 1)); });
        const initialization = { entry, request, sourceBytes };
        if (transport === "stdio")
            child.stdin.write(JSON.stringify(initialization) + "\n");
        else
            child.send(initialization);
    }
    catch {
        process.exit(65);
    }
});
// Main-process exit triggers systemd whole-cgroup cleanup before unit release.
process.stdin.on("end", () => process.exit(0));
//# sourceMappingURL=worker-runtime-bridge.js.map