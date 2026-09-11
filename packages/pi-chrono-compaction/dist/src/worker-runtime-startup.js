import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, readdir, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const MAX_AUTHORIZATION_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PROCESS_SCAN_BYTES = 64 * 1024 * 1024;
const PROCESS_ARG_BYTES = 128 * 1024;
const PROCESS_SCAN_MS = 10_000;
const CONFIGURATION_KEYS = ["hostWorkerSlots", "workerTimeoutSeconds", "workerNiceLevel", "isolatedWorkerEnabled"];
const REQUIRED_WORKERS = [
    "catalog-worker-entry.js", "capsule-worker-entry.js", "search-v3-worker-entry.js",
    "compaction-worker-entry.js", "history-worker-entry.js", "worker-runtime-bootstrap.js", "worker-runtime-bridge.js",
];
function fail(code) { throw new Error(code); }
function need(value, code) { if (!value)
    fail(code); }
function exact(value, keys) { return Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function present(path) { try {
    await lstat(path);
    return true;
}
catch (error) {
    if (error.code === "ENOENT")
        return false;
    throw error;
} }
async function withStartupLock(path, action) {
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const stat = await handle.stat();
        need(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600, "unsafe-startup-lock");
        const child = spawn("/usr/bin/flock", ["--exclusive", "--timeout", "15", "/proc/self/fd/3", process.execPath, "-e", "process.stdout.write('ready');process.stdin.resume()"], { stdio: ["pipe", "pipe", "ignore", handle.fd], env: { PATH: "/usr/bin:/bin" } });
        const closed = new Promise(resolve => child.once("close", () => resolve()));
        await new Promise((resolve, reject) => {
            child.stdout.once("data", () => resolve());
            child.once("error", () => reject(new Error("worker-startup-unavailable")));
            child.once("exit", () => reject(new Error("worker-startup-timeout")));
        });
        try {
            return await action();
        }
        finally {
            child.stdin.end();
            await closed;
        }
    }
    finally {
        await handle.close();
    }
}
async function safeAncestors(path) {
    const uid = process.getuid?.();
    need(isAbsolute(path) && resolve(path) === path, "noncanonical-path");
    let part = "/";
    for (const component of path.slice(1).split("/").filter(Boolean)) {
        part = join(part, component);
        const stat = await lstat(part);
        need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.uid === 0 || stat.uid === uid), "unsafe-ancestor");
        need(!(stat.mode & 0o022) || (stat.uid === 0 && !!(stat.mode & 0o1000)), "writable-ancestor");
    }
    need(await realpath(path) === path, "noncanonical-path");
}
async function safeBytes(path, maximum, privateMode = false) {
    await safeAncestors(dirname(path));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        need(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && !(stat.mode & 0o022) && stat.size <= maximum, "unsafe-file");
        if (privateMode)
            need((stat.mode & 0o777) === 0o600, "unsafe-file");
        const bytes = Buffer.alloc(maximum + 1);
        let offset = 0;
        while (offset <= maximum) {
            const { bytesRead } = await handle.read(bytes, offset, maximum + 1 - offset, offset);
            if (bytesRead === 0)
                return bytes.subarray(0, offset);
            offset += bytesRead;
        }
        fail("file-bound");
    }
    finally {
        await handle.close();
    }
}
async function privateDirectory(path) {
    await safeAncestors(path);
    const stat = await lstat(path);
    need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700, "unsafe-namespace");
    return stat;
}
async function recursiveJs(root, current = "") {
    const directory = join(root, current), stat = await lstat(directory);
    need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o022), "unsafe-dist-directory");
    const result = [];
    for (const name of (await readdir(directory)).sort()) {
        const relative = current ? `${current}/${name}` : name, path = join(root, relative), item = await lstat(path);
        need(!item.isSymbolicLink(), "unsafe-dist-entry");
        if (item.isDirectory())
            result.push(...await recursiveJs(root, relative));
        else if (item.isFile() && name.endsWith(".js"))
            result.push(relative);
    }
    return result;
}
function parseAuthorization(value) {
    need(!!value && typeof value === "object" && !Array.isArray(value), "authorization-invalid");
    const a = value;
    need(exact(a, ["schemaVersion", "purpose", "package", "configuration", "policy", "workerProcessBasenames"]), "authorization-invalid");
    need(a.schemaVersion === 1 && a.purpose === "chrono-trusted-fresh-boot-startup", "authorization-invalid");
    need(!!a.package && exact(a.package, ["path", "name", "version", "sourceCommit", "files"]), "authorization-invalid");
    need(a.package.name === "pi-chrono-compact" && typeof a.package.version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(a.package.version) && a.package.version.length <= 64 && /^[a-f0-9]{40}$/.test(a.package.sourceCommit), "authorization-identity-mismatch");
    need(isAbsolute(a.package.path) && resolve(a.package.path) === a.package.path, "authorization-invalid");
    need(!!a.configuration && exact(a.configuration, ["path", "projectionKeys", "projectionSha256"]), "authorization-invalid");
    need(isAbsolute(a.configuration.path) && resolve(a.configuration.path) === a.configuration.path && JSON.stringify(a.configuration.projectionKeys) === JSON.stringify(CONFIGURATION_KEYS) && /^[a-f0-9]{64}$/.test(a.configuration.projectionSha256), "authorization-invalid");
    need(!!a.policy && exact(a.policy, ["schemaVersion"]) && a.policy.schemaVersion === 2, "authorization-invalid");
    need(Array.isArray(a.workerProcessBasenames) && a.workerProcessBasenames.length <= 32 && a.workerProcessBasenames.every(name => typeof name === "string" && /^[A-Za-z0-9._-]+\.js$/.test(name)) && REQUIRED_WORKERS.every(name => a.workerProcessBasenames.includes(name)), "authorization-invalid");
    need(!!a.package.files && typeof a.package.files === "object" && !Array.isArray(a.package.files) && Object.keys(a.package.files).length > 1 && Object.entries(a.package.files).every(([path, digest]) => (/^package\.json$|^dist\/src\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(path) && typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))), "authorization-invalid");
    return a;
}
async function verifyPackage(a) {
    await safeAncestors(a.package.path);
    const entries = Object.keys(a.package.files).sort();
    need(entries.includes("package.json"), "authorization-manifest-mismatch");
    const actual = (await recursiveJs(join(a.package.path, "dist/src"))).map(path => `dist/src/${path}`).concat("package.json").sort();
    need(JSON.stringify(entries) === JSON.stringify(actual), "authorization-manifest-mismatch");
    for (const path of entries)
        need(hash(await safeBytes(join(a.package.path, path), path === "package.json" ? 65536 : MAX_FILE_BYTES)) === a.package.files[path], "authorized-package-mismatch");
    const manifest = JSON.parse((await safeBytes(join(a.package.path, "package.json"), 65536)).toString());
    need(manifest.name === a.package.name && manifest.version === a.package.version, "authorization-identity-mismatch");
}
async function loadApis(packagePath) {
    const load = (name) => import(pathToFileURL(join(packagePath, "dist/src", `${name}.js`)).href);
    const [namespace, gate, systemd, limits] = await Promise.all([load("worker-runtime-namespace"), load("worker-runtime-legacy-gate"), load("worker-runtime-systemd"), load("worker-runtime-limits")]);
    return { defaultRuntimeDirectory: namespace.defaultRuntimeDirectory, legacySchedulerDirectory: namespace.legacySchedulerDirectory, verifyLegacyAdmissionGate: gate.verifyLegacyAdmissionGate, installLegacyAdmissionGate: gate.installLegacyAdmissionGate, runtimeUnitName: systemd.runtimeUnitName, runtimeUnitState: systemd.runtimeUnitState, limits: limits.WORKER_LIMITS };
}
function verifyLimits(limits) {
    need(JSON.stringify(limits.slots) === '{"min":1,"max":4}' && JSON.stringify(limits.timeoutSeconds) === '{"min":30,"max":3600}' && JSON.stringify(limits.nice) === '{"min":0,"max":19}' && limits.hostMemoryBytes === 2 * 1024 * 1024 * 1024 && limits.sourceBytes === 256 * 1024 * 1024, "authorized-limits-mismatch");
}
async function configuration(a, limits) {
    const raw = JSON.parse((await safeBytes(a.configuration.path, 65536)).toString());
    const projection = Object.fromEntries(CONFIGURATION_KEYS.map(key => [key, raw[key]]));
    need(hash(JSON.stringify(projection)) === a.configuration.projectionSha256, "configured-policy-drift");
    const slots = projection.hostWorkerSlots, timeout = projection.workerTimeoutSeconds, nice = projection.workerNiceLevel;
    need(Number.isInteger(slots) && slots >= limits.slots.min && slots <= limits.slots.max && Number.isInteger(timeout) && timeout >= limits.timeoutSeconds.min && timeout <= limits.timeoutSeconds.max && Number.isInteger(nice) && nice >= limits.nice.min && nice <= limits.nice.max && projection.isolatedWorkerEnabled === true, "configured-policy-invalid");
    return projection;
}
async function processQuiescent(names) {
    const deadline = performance.now() + PROCESS_SCAN_MS, pids = (await readdir("/proc")).filter(name => /^\d+$/.test(name));
    if (pids.length > 8192)
        return false;
    let total = 0;
    for (const pid of pids) {
        if (performance.now() > deadline)
            return false;
        let handle;
        try {
            if ((await lstat(`/proc/${pid}`)).uid !== process.getuid?.())
                continue;
            handle = await open(`/proc/${pid}/cmdline`, constants.O_RDONLY | constants.O_NOFOLLOW);
            const buffer = Buffer.alloc(PROCESS_ARG_BYTES + 1), read = await handle.read(buffer, 0, buffer.length, 0);
            total += read.bytesRead;
            if (read.bytesRead === buffer.length || total > PROCESS_SCAN_BYTES)
                return false;
            if (buffer.subarray(0, read.bytesRead).toString().split("\0").some(argument => names.includes(basename(argument))))
                return false;
        }
        catch (error) {
            if (!["ENOENT", "ESRCH"].includes(error.code ?? ""))
                return false;
        }
        finally {
            await handle?.close();
        }
    }
    return performance.now() <= deadline;
}
async function doubleQuiescent(names, check) {
    if (!await check(names))
        return false;
    await new Promise(resolve => setTimeout(resolve, 100));
    return check(names);
}
async function inactive(apis, runtime) {
    const states = await Promise.all(Array.from({ length: 4 }, (_, slot) => apis.runtimeUnitState(apis.runtimeUnitName(runtime, slot))));
    need(states.every(state => state === "inactive"), "fixed-unit-not-inactive");
}
function validOwner(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const owner = value, keys = Object.keys(owner).sort().join(",");
    return (keys === "createdAtMs,jobType,key,nonce,pid,priority,processStartIdentity,schemaVersion" || keys === "createdAtMs,jobType,nonce,pid,priority,processStartIdentity,schemaVersion")
        && owner.schemaVersion === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
        && typeof owner.processStartIdentity === "string" && owner.processStartIdentity.length > 0 && owner.processStartIdentity.length <= 64
        && typeof owner.nonce === "string" && /^[a-f0-9]{32}$/.test(owner.nonce)
        && Number.isSafeInteger(owner.createdAtMs) && owner.createdAtMs > 0
        && (owner.priority === "high" || owner.priority === "low")
        && ["replay-compaction", "candidate-store-update", "rollup-shadow"].includes(owner.jobType)
        && (owner.key === undefined || (typeof owner.key === "string" && /^[a-f0-9]{64}$/.test(owner.key)));
}
function validTurns(value) {
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 128
        && Object.entries(value).every(([key, item]) => /^[a-f0-9]{64}$/.test(key) && Number.isSafeInteger(item));
}
function validState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !exact(value, ["schemaVersion", "category", "stage"]))
        return false;
    const state = value;
    return state.schemaVersion === 1 && ["replay-compaction", "candidate-store-update", "rollup-shadow", "history-search", "other"].includes(state.category)
        && typeof state.stage === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(state.stage);
}
async function artifactJson(path, maximum = 16384) {
    try {
        return JSON.parse((await safeBytes(path, maximum, true)).toString());
    }
    catch (error) {
        if (error instanceof Error && /^[a-z][a-z0-9-]{0,80}$/.test(error.message))
            throw error;
        fail("malformed-scheduler-artifact");
    }
}
async function safeRuntimeEntries(runtime, policy) {
    const names = await readdir(runtime);
    need(names.length <= 256, "runtime-artifact-bound");
    for (const name of names) {
        const path = join(runtime, name);
        if (name === "policy.json")
            need((await safeBytes(path, 1024, true)).toString() === policy, "policy-mismatch");
        else if (name === "admission.lock" || name === "queue.lock")
            await safeBytes(path, 0, true);
        else if (name === "legacy-gate.json")
            await safeBytes(path, 4096, true);
        else if (/^(?:ticket-[a-f0-9]{32}|slot-[0-3])\.json$/.test(name)) {
            const owner = await artifactJson(path, 1000);
            need(validOwner(owner), "malformed-scheduler-artifact");
            if (name.startsWith("ticket-"))
                need(name === `ticket-${owner.nonce}.json`, "malformed-scheduler-artifact");
        }
        else if (name === "turns.json")
            need(validTurns(await artifactJson(path)), "malformed-scheduler-artifact");
        else if (/^state-[0-3]\.json$/.test(name))
            need(validState(await artifactJson(path, 4096)), "malformed-scheduler-artifact");
        else if (/^\.(?:ticket-[a-f0-9]{32}|slot-[0-3])\.json-[a-f0-9]{32}\.tmp$/.test(name)) {
            const owner = await artifactJson(path, 1000), nonces = name.match(/[a-f0-9]{32}/g) ?? [];
            need(validOwner(owner) && nonces.at(-1) === owner.nonce && (!name.startsWith(".ticket-") || nonces[0] === owner.nonce), "malformed-scheduler-artifact");
        }
        else if (/^\.policy\.json-[a-f0-9]{32}\.tmp$/.test(name))
            need((await safeBytes(path, 1024, true)).toString() === policy, "policy-mismatch");
        else if (/^\.turns-[a-f0-9]{32}\.tmp$/.test(name))
            need(validTurns(await artifactJson(path)), "malformed-scheduler-artifact");
        else if (/^\.state-[a-f0-9]{16}$/.test(name))
            need(validState(await artifactJson(path, 4096)), "malformed-scheduler-artifact");
        else
            fail("partial-or-foreign-namespace");
    }
}
async function safeLegacyEntries(legacy) {
    const names = (await readdir(legacy)).sort();
    need(JSON.stringify(names) === JSON.stringify(["slot-0.json", "slot-1.json", "slot-2.json", "slot-3.json"]), "partial-or-foreign-namespace");
    for (const name of names)
        await safeBytes(join(legacy, name), 4096, true);
}
async function initializeTrustedWorkerRuntimeInner(options) {
    need(process.platform === "linux" && Number.isInteger(process.getuid?.()) && process.getuid?.() !== 0, "linux-user-required");
    need(isAbsolute(options.authorizationPath) && resolve(options.authorizationPath) === options.authorizationPath, "authorization-path-required");
    await privateDirectory(dirname(options.authorizationPath));
    const a = parseAuthorization(JSON.parse((await safeBytes(options.authorizationPath, MAX_AUTHORIZATION_BYTES, true)).toString()));
    if (options.expectedPackagePath !== undefined) {
        need(isAbsolute(options.expectedPackagePath) && resolve(options.expectedPackagePath) === options.expectedPackagePath, "expected-package-path-invalid");
        need(await realpath(options.expectedPackagePath) === options.expectedPackagePath && a.package.path === options.expectedPackagePath, "authorization-package-path-mismatch");
    }
    await verifyPackage(a);
    const apis = options.testOnly?.apis ?? await loadApis(a.package.path);
    verifyLimits(apis.limits);
    const config = await configuration(a, apis.limits);
    const policy = JSON.stringify({ schemaVersion: 2, slots: config.hostWorkerSlots, memoryBytes: apis.limits.hostMemoryBytes });
    const runtime = options.testOnly?.runtimeDirectory ?? apis.defaultRuntimeDirectory();
    const legacy = options.testOnly?.legacyDirectory ?? apis.legacySchedulerDirectory();
    const lock = options.testOnly?.lockPath ?? `/run/user/${process.getuid?.()}/chrono-runtime-startup.lock`;
    need([runtime, legacy, lock].every(path => isAbsolute(path) && resolve(path) === path), "noncanonical-path");
    await safeAncestors(dirname(runtime));
    await safeAncestors(dirname(legacy));
    await privateDirectory(dirname(lock));
    const quiescent = options.testOnly?.processQuiescent ?? processQuiescent;
    return withStartupLock(lock, async () => {
        const r = await present(runtime), l = await present(legacy);
        if (r && l) {
            await privateDirectory(runtime);
            await privateDirectory(legacy);
            await safeRuntimeEntries(runtime, policy);
            await safeLegacyEntries(legacy);
            need((await safeBytes(join(runtime, "policy.json"), 1024, true)).toString() === policy, "policy-mismatch");
            need(await apis.verifyLegacyAdmissionGate(runtime, legacy), "gate-not-verified");
            return { ready: true, changed: false, sourceCommit: a.package.sourceCommit };
        }
        need(!r && !l, "partial-or-foreign-namespace");
        await inactive(apis, runtime);
        need(await doubleQuiescent(a.workerProcessBasenames, quiescent), "legacy-not-quiescent");
        await mkdir(runtime, { mode: 0o700 });
        const ri = await privateDirectory(runtime);
        await mkdir(legacy, { mode: 0o700 });
        const li = await privateDirectory(legacy);
        const identities = async () => { const rr = await privateDirectory(runtime), ll = await privateDirectory(legacy); need(rr.dev === ri.dev && rr.ino === ri.ino && ll.dev === li.dev && ll.ino === li.ino, "namespace-replaced"); };
        const empty = async () => { need((await readdir(runtime)).length === 0 && (await readdir(legacy)).length === 0, "partial-or-foreign-namespace"); };
        await configuration(a, apis.limits);
        await inactive(apis, runtime);
        need(await doubleQuiescent(a.workerProcessBasenames, quiescent), "legacy-not-quiescent");
        await empty();
        await identities();
        const handle = await open(join(runtime, "policy.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(policy);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await identities();
        await apis.installLegacyAdmissionGate({ runtimeDirectory: runtime, legacyDirectory: legacy, confirmLegacyQuiescent: async () => {
                await identities();
                await configuration(a, apis.limits);
                await inactive(apis, runtime);
                const runtimeNames = (await readdir(runtime)).sort(), legacyNames = (await readdir(legacy)).sort();
                need(JSON.stringify(runtimeNames) === JSON.stringify(["admission.lock", "policy.json"]), "partial-or-foreign-namespace");
                need(JSON.stringify(legacyNames) === JSON.stringify(["slot-0.json", "slot-1.json", "slot-2.json", "slot-3.json"]), "partial-or-foreign-namespace");
                need((await safeBytes(join(runtime, "policy.json"), 1024, true)).toString() === policy, "policy-mismatch");
                await safeBytes(join(runtime, "admission.lock"), 0, true);
                for (const name of legacyNames)
                    await safeBytes(join(legacy, name), 4096, true);
                return doubleQuiescent(a.workerProcessBasenames, quiescent);
            } });
        await identities();
        await safeRuntimeEntries(runtime, policy);
        await safeLegacyEntries(legacy);
        need((await safeBytes(join(runtime, "policy.json"), 1024, true)).toString() === policy && await apis.verifyLegacyAdmissionGate(runtime, legacy), "gate-not-verified");
        await configuration(a, apis.limits);
        await inactive(apis, runtime);
        need(await doubleQuiescent(a.workerProcessBasenames, quiescent), "legacy-not-quiescent");
        return { ready: true, changed: true, sourceCommit: a.package.sourceCommit };
    });
}
/** Refusals expose only stable codes, never package/configuration paths or file content. */
export async function initializeTrustedWorkerRuntime(options) {
    try {
        return await initializeTrustedWorkerRuntimeInner(options);
    }
    catch (error) {
        const message = error instanceof Error && /^[a-z][a-z0-9-]{0,80}$/.test(error.message) ? error.message : "worker-startup-refused";
        throw new Error(message);
    }
}
//# sourceMappingURL=worker-runtime-startup.js.map