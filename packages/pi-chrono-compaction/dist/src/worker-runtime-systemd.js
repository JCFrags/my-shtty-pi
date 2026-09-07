import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { MAX_WORKER_RESPONSE_BYTES } from "./compaction-worker-protocol.js";
import { WORKER_LIMITS } from "./worker-runtime-limits.js";
const controllerEnvironment = () => ({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus` });
export function runtimeUnitName(directory, slot) {
    return `chrono-runtime-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}-${slot}.service`;
}
async function control(...args) {
    return new Promise((resolve, reject) => execFile("/usr/bin/systemctl", ["--user", ...args], { env: controllerEnvironment(), timeout: 15000, maxBuffer: 65536 }, (error, stdout) => error ? reject(new Error("worker-containment-unavailable")) : resolve(stdout.trim())));
}
export async function runtimeUnitState(unit) {
    try {
        return await control("show", unit, "--property=ActiveState", "--value");
    }
    catch {
        return "unknown";
    }
}
/** Unit identity is the atomic host slot. KillMode=control-group keeps it occupied through stop cleanup while
 * any descendant lives; no PID or metadata file is an occupancy authority. */
export class ContainedWorker extends EventEmitter {
    unit;
    process;
    responseLimit;
    heapMiB;
    stderr;
    exitCode = null;
    killed = false;
    closePromise;
    stopped;
    buffer = Buffer.alloc(0);
    bytes = 0;
    readyResolve;
    readyReject;
    ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    constructor(unit, process, responseLimit = MAX_WORKER_RESPONSE_BYTES, heapMiB) {
        super();
        this.unit = unit;
        this.process = process;
        this.responseLimit = responseLimit;
        this.heapMiB = heapMiB;
        this.stderr = process.stderr;
        process.stdout.on("data", (chunk) => {
            this.bytes += chunk.length;
            if (this.bytes > this.responseLimit + 65536) {
                this.emit("limit", "worker-response-too-large");
                return;
            }
            this.buffer = Buffer.concat([this.buffer, chunk]);
            for (;;) {
                const end = this.buffer.indexOf(10);
                if (end < 0)
                    break;
                const line = this.buffer.subarray(0, end);
                this.buffer = this.buffer.subarray(end + 1);
                if (line.length > this.responseLimit + 128 && line.toString("utf8") !== '{"kind":"runtime-ready"}') {
                    this.emit("limit", "worker-response-too-large");
                    continue;
                }
                try {
                    const value = JSON.parse(line.toString("utf8"));
                    if (value.kind === "runtime-ready")
                        this.readyResolve();
                    else if (value.kind === "runtime-limit" && ["worker-source-limit", "worker-response-too-large"].includes(value.code))
                        this.emit("limit", value.code);
                    else if (value.kind === "runtime-exit")
                        this.emit("worker-exit", value.code, value.signal);
                    else if (value.kind === "runtime-message")
                        this.emit("message", value.value);
                    else
                        this.emit("limit", "worker-protocol-error");
                }
                catch {
                    this.emit("limit", "worker-protocol-error");
                }
            }
        });
        process.on("error", () => this.readyReject(new Error("worker-containment-unavailable")));
        this.closePromise = new Promise(resolve => process.on("close", (code, signal) => {
            this.exitCode = code;
            this.readyReject(new Error("worker-containment-unavailable"));
            this.emit("exit", code, signal);
            resolve();
        }));
    }
    send(request, entry, callback, sourceBytes = WORKER_LIMITS.sourceBytes, transport = "ipc") {
        this.process.stdin.write(JSON.stringify({ request, entry, sourceBytes, transport, responseBytes: this.responseLimit, heapMiB: this.heapMiB }) + "\n", callback);
    }
    async result() { try {
        return await control("show", this.unit, "--property=Result", "--value");
    }
    catch {
        return "unknown";
    } }
    stop() {
        return this.stopped ??= (async () => {
            this.killed = true;
            // systemctl stop waits for the stop job, including SIGKILL of every member.
            // Do not release a scheduler lease if the manager cannot confirm stopping.
            const before = await runtimeUnitState(this.unit);
            if (before !== "inactive") {
                try {
                    await control("stop", this.unit);
                }
                catch (error) {
                    if (await runtimeUnitState(this.unit) !== "inactive")
                        throw error;
                }
            }
            const state = await runtimeUnitState(this.unit);
            if (state !== "inactive" && state !== "failed")
                throw new Error("worker-containment-stop-unconfirmed");
            this.process.stdin.destroy();
            await this.closePromise;
            await control("reset-failed", this.unit).catch(() => { });
        })();
    }
}
export async function startContainedWorker(directory, slot, slots, timeoutMs, memoryBytes, responseBytes = MAX_WORKER_RESPONSE_BYTES, heapMiB, signal) {
    if (process.platform !== "linux" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("worker-containment-unavailable");
    const unit = runtimeUnitName(directory, slot);
    const state = await runtimeUnitState(unit);
    if (["active", "activating", "deactivating", "reloading"].includes(state))
        throw new Error("runtime-slot-busy");
    if (state === "unknown")
        throw new Error("worker-containment-unavailable");
    if (state === "failed")
        await control("reset-failed", unit);
    const share = Math.floor(WORKER_LIMITS.hostMemoryBytes / slots);
    const requestedMemory = memoryBytes ?? share;
    if (!Number.isSafeInteger(requestedMemory) || requestedMemory < 64 * 1024 * 1024 || requestedMemory > share)
        throw new Error("worker-protocol-error");
    const memory = Math.floor(requestedMemory / 4096) * 4096;
    const properties = ["Type=exec", "ExitType=main", "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=1s", `RuntimeMaxSec=${Math.max(1, Math.ceil(timeoutMs))}ms`, `MemoryMax=${memory}`, "MemorySwapMax=0", "OOMPolicy=kill", "TasksMax=64", "NoNewPrivileges=yes", "UMask=0077", "StandardError=pipe"];
    // --pipe overrides StandardError; do not send source or diagnostics to journal.
    const description = `ChronoCompact-${randomBytes(16).toString("hex")}`;
    const child = spawn("/usr/bin/systemd-run", ["--user", "--quiet", "--wait", "--pipe", `--unit=${unit}`, `--description=${description}`, ...properties.filter(p => p !== "StandardError=pipe").map(p => `--property=${p}`), "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", process.execPath, fileURLToPath(new URL("./worker-runtime-bridge.js", import.meta.url))], { env: controllerEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    const worker = new ContainedWorker(unit, child, responseBytes, heapMiB);
    // A bounded startup wait must also stop the service before giving capacity back.
    let timeout;
    let abort = () => { };
    const interrupted = new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("worker-containment-unavailable")), 10000);
        abort = () => reject(new Error("worker-aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted)
            abort();
    });
    try {
        await Promise.race([worker.ready, interrupted]);
        if (signal?.aborted)
            throw new Error("worker-aborted");
        const group = await control("show", unit, "--property=ControlGroup", "--value");
        if (!group.startsWith("/user.slice/") || group.includes(".."))
            throw new Error("worker-containment-unavailable");
        const actual = (await readFile(`/sys/fs/cgroup${group}/memory.max`, "utf8")).trim();
        const swap = (await readFile(`/sys/fs/cgroup${group}/memory.swap.max`, "utf8")).trim();
        if (actual !== String(memory) || swap !== "0")
            throw new Error("worker-containment-unavailable");
        return worker;
    }
    catch {
        // A losing concurrent start must never stop the winning service.
        const owned = await control("show", unit, "--property=Description", "--value").catch(() => "unknown");
        if (owned === description)
            await worker.stop();
        else {
            child.stdin.destroy();
            child.kill("SIGKILL");
        }
        if (signal?.aborted)
            throw new Error("worker-aborted");
        throw new Error(owned !== description && (await runtimeUnitState(unit)) === "active" ? "runtime-slot-busy" : "worker-containment-unavailable");
    }
    finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}
/** Called only under the namespace admission lock during explicit rollback. */
export async function stopRuntimeNamespace(directory) {
    for (let slot = 0; slot < WORKER_LIMITS.slots.max; slot++) {
        const unit = runtimeUnitName(directory, slot);
        const state = await runtimeUnitState(unit);
        if (state === "unknown")
            throw new Error("worker-containment-stop-unconfirmed");
        if (state !== "inactive")
            await control("stop", unit);
        const after = await runtimeUnitState(unit);
        if (after !== "inactive" && after !== "failed")
            throw new Error("worker-containment-stop-unconfirmed");
        await control("reset-failed", unit).catch(() => { });
    }
}
//# sourceMappingURL=worker-runtime-systemd.js.map