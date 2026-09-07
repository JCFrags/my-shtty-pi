import { prepareRuntimeNamespace } from "./worker-runtime-namespace.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
import { WORKER_LIMITS } from "./worker-runtime-limits.js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
function startIdentity(text) { const end = text.lastIndexOf(") "); if (end < 0)
    return undefined; const token = text.slice(end + 2).trim().split(/\s+/)[19]; return token && /^\d+$/.test(token) ? token : undefined; }
export function linuxProcessStartIdentity(pid = process.pid) { try {
    return startIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"));
}
catch {
    return undefined;
} }
function ownerAlive(owner) {
    if (process.platform !== "linux")
        return undefined;
    try {
        const text = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
        const current = startIdentity(text);
        return current === undefined ? undefined : current === owner.processStartIdentity;
    }
    catch (error) {
        return error.code === "ENOENT" ? false : undefined;
    }
}
export function defaultSchedulerDirectory() { return `/run/user/${process.getuid?.()}/chrono-runtime`; }
async function readOwner(path) { try {
    const metadata = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o600 || metadata.size < 2 || metadata.size > 1_000)
        return undefined;
    const value = JSON.parse(await readFile(path, "utf8"));
    const keys = Object.keys(value).sort().join(",");
    return value && (keys === "createdAtMs,jobType,nonce,pid,priority,processStartIdentity,schemaVersion" || keys === "createdAtMs,jobType,key,nonce,pid,priority,processStartIdentity,schemaVersion") && (value.key === undefined || /^[a-f0-9]{64}$/.test(value.key)) && value.schemaVersion === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.processStartIdentity === "string" && value.processStartIdentity.length > 0 && value.processStartIdentity.length <= 64 && /^[a-f0-9]{32}$/.test(value.nonce) && Number.isSafeInteger(value.createdAtMs) && value.createdAtMs > 0 && (value.priority === "high" || value.priority === "low") && (value.jobType === "replay-compaction" || value.jobType === "candidate-store-update" || value.jobType === "rollup-shadow") ? value : undefined;
}
catch {
    return undefined;
} }
const malformedArtifacts = new Map();
async function removeDead(path, malformedStableMs) { const owner = await readOwner(path); if (!owner) {
    try {
        const value = await lstat(path);
        const fingerprint = `${String(value.dev)}:${String(value.ino)}:${value.size}:${value.mtimeMs}`;
        const prior = malformedArtifacts.get(path);
        if (!prior || prior.fingerprint !== fingerprint) {
            malformedArtifacts.set(path, { fingerprint, firstSeenMs: Date.now() });
            return false;
        }
        if (Date.now() - prior.firstSeenMs < malformedStableMs)
            return false;
        const again = await lstat(path);
        const current = `${String(again.dev)}:${String(again.ino)}:${again.size}:${again.mtimeMs}`;
        if (current !== fingerprint || await readOwner(path))
            return false;
        await rm(path, { force: true });
        malformedArtifacts.delete(path);
        return true;
    }
    catch {
        malformedArtifacts.delete(path);
        return false;
    }
} malformedArtifacts.delete(path); const alive = ownerAlive(owner); if (alive === false) {
    const again = await readOwner(path);
    if (again?.nonce === owner.nonce) {
        await rm(path, { force: true });
        return true;
    }
} return false; }
async function cleanup(directory, malformedStableMs) { for (const name of await readdir(directory)) {
    if (!name.startsWith("ticket-") && !name.startsWith("slot-") && !/^\.(?:ticket|slot)-.+\.tmp$/.test(name))
        continue;
    await removeDead(join(directory, name), malformedStableMs);
} }
async function publishOwner(directory, name, owner) { const finalPath = join(directory, name); const temporary = join(directory, `.${name}-${owner.nonce}.tmp`); try {
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(JSON.stringify(owner));
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temporary, finalPath);
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
}
finally {
    await rm(temporary, { force: true });
} }
function wait(ms, signal) { return new Promise((resolve, reject) => { if (signal?.aborted)
    return reject(new Error("worker-aborted")); let settled = false; const cleanup = () => signal?.removeEventListener("abort", onAbort); const finish = (error) => { if (settled)
    return; settled = true; clearTimeout(timer); cleanup(); if (error)
    reject(error);
else
    resolve(); }; const onAbort = () => finish(new Error("worker-aborted")); const timer = setTimeout(() => finish(), ms); try {
    signal?.addEventListener("abort", onAbort, { once: true });
}
catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
    return;
} if (signal?.aborted)
    onAbort(); }); }
function priorityValue(value) { return value === "high" ? 0 : 1; }
export async function acquireHostWorkerSlot(options) {
    const slots = options.slots ?? 1;
    if (!Number.isInteger(slots) || slots < WORKER_LIMITS.slots.min || slots > WORKER_LIMITS.slots.max)
        throw new Error("host worker slots must be from 1 through 4");
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 900_000)), pollMs = Math.min(1000, Math.max(20, Math.floor(options.pollMs ?? 75)));
    const malformedStableMs = Math.max(50, Math.floor(options.malformedStableMs ?? 5_000));
    const directory = await prepareRuntimeNamespace(options.directory ?? defaultSchedulerDirectory());
    const transaction = (action) => withRuntimeMutex(join(directory, "queue.lock"), action);
    const nonce = randomBytes(16).toString("hex");
    const key = options.sessionKey ?? createHash("sha256").update(String(process.pid)).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error("invalid-scheduler-key");
    const owner = { schemaVersion: 1, pid: process.pid, processStartIdentity: linuxProcessStartIdentity() ?? "unverified", nonce, createdAtMs: Date.now(), priority: options.priority, jobType: options.jobType, key };
    const ticketName = `ticket-${nonce}.json`, ticketPath = join(directory, ticketName), started = Date.now();
    let maximumPosition = 1;
    await transaction(async () => {
        await cleanup(directory, malformedStableMs);
        if (options.enforcePolicy) {
            const policy = JSON.stringify({ schemaVersion: 1, slots, memoryBytes: WORKER_LIMITS.hostMemoryBytes });
            const path = join(directory, "policy.json");
            try {
                const handle = await open(path, "wx", 0o600);
                try {
                    await handle.writeFile(policy);
                }
                finally {
                    await handle.close();
                }
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                const metadata = await lstat(path);
                if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 || await readFile(path, "utf8") !== policy)
                    throw new Error("scheduler-policy-mismatch");
            }
        }
        const names = (await readdir(directory)).filter(x => x.startsWith("ticket-"));
        let sameKey = 0;
        for (const name of names) {
            if ((await readOwner(join(directory, name)))?.key === key)
                sameKey++;
        }
        if (names.length >= WORKER_LIMITS.queueTickets || sameKey >= WORKER_LIMITS.sessionTickets)
            throw new Error("scheduler-queue-full");
        if (!await publishOwner(directory, ticketName, owner))
            throw new Error("scheduler-ticket-collision");
    });
    try {
        for (;;) {
            if (options.signal?.aborted)
                throw new Error("worker-aborted");
            if (Date.now() - started >= timeoutMs)
                throw new Error("scheduler-timeout");
            const acquired = await transaction(async () => {
                await cleanup(directory, malformedStableMs);
                const tickets = [];
                for (const name of (await readdir(directory)).filter(x => x.startsWith("ticket-"))) {
                    const value = await readOwner(join(directory, name));
                    if (value)
                        tickets.push(value);
                }
                let turns = {};
                const turnsPath = join(directory, "turns.json");
                try {
                    const metadata = await lstat(turnsPath);
                    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0 && metadata.size <= 16384) {
                        const value = JSON.parse(await readFile(turnsPath, "utf8"));
                        if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([k, v]) => /^[a-f0-9]{64}$/.test(k) && Number.isSafeInteger(v)))
                            turns = value;
                    }
                }
                catch { }
                const now = Date.now();
                const rank = (ticket) => now - ticket.createdAtMs >= WORKER_LIMITS.starvationMs ? -1 : priorityValue(ticket.priority);
                tickets.sort((a, b) => rank(a) - rank(b) || (rank(a) === -1 ? a.createdAtMs - b.createdAtMs : (turns[a.key ?? ""] ?? 0) - (turns[b.key ?? ""] ?? 0)) || a.createdAtMs - b.createdAtMs || a.nonce.localeCompare(b.nonce));
                const index = tickets.findIndex(x => x.nonce === nonce);
                maximumPosition = Math.max(maximumPosition, index + 1);
                // Only the head claims a slot. Selection and publication share one kernel transaction.
                if (index !== 0)
                    return undefined;
                for (let slot = 0; slot < slots; slot++) {
                    if (!await publishOwner(directory, `slot-${slot}.json`, owner))
                        continue;
                    turns[key] = now;
                    const entries = Object.entries(turns).sort((a, b) => b[1] - a[1]).slice(0, 128);
                    const temporary = join(directory, `.turns-${nonce}.tmp`);
                    const handle = await open(temporary, "wx", 0o600);
                    try {
                        await handle.writeFile(JSON.stringify(Object.fromEntries(entries)));
                    }
                    finally {
                        await handle.close();
                    }
                    await (await import("node:fs/promises")).rename(temporary, turnsPath);
                    await rm(ticketPath, { force: true });
                    return slot;
                }
                return undefined;
            });
            if (acquired !== undefined) {
                let released = false;
                return { slot: acquired, slots, queueWaitMs: Date.now() - started, queuePosition: maximumPosition, release: async () => { if (released)
                        return; await transaction(async () => { const path = join(directory, `slot-${acquired}.json`); const current = await readOwner(path); if (current?.nonce === nonce)
                        await rm(path, { force: true }); await rm(ticketPath, { force: true }); }); released = true; } };
            }
            await wait(pollMs, options.signal);
        }
    }
    finally {
        await rm(ticketPath, { force: true });
    }
}
export async function schedulerArtifactCounts(directory = defaultSchedulerDirectory()) { try {
    const names = await readdir(directory);
    return { tickets: names.filter(x => x.startsWith("ticket-")).length, slots: names.filter(x => x.startsWith("slot-")).length };
}
catch {
    return { tickets: 0, slots: 0 };
} }
//# sourceMappingURL=host-worker-scheduler.js.map