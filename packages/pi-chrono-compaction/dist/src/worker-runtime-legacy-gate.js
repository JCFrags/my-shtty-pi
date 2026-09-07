import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { linuxProcessStartIdentity } from "./host-worker-scheduler.js";
import { defaultRuntimeDirectory, legacySchedulerDirectory, prepareRuntimeNamespace } from "./worker-runtime-namespace.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
import { stopRuntimeNamespace } from "./worker-runtime-systemd.js";
function owner(manifest) { return { schemaVersion: 1, pid: 1, processStartIdentity: manifest.initStart, nonce: manifest.nonce, createdAtMs: manifest.createdAtMs, priority: "low", jobType: "candidate-store-update" }; }
async function safeJson(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const s = await handle.stat();
        if (!s.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size < 2 || s.size > 4096)
            throw new Error("unsafe-legacy-gate-artifact");
        return JSON.parse(await handle.readFile("utf8"));
    }
    finally {
        await handle.close();
    }
}
function matches(value, expected) {
    return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === Object.keys(expected).sort().join(",") && Object.entries(expected).every(([key, item]) => value[key] === item);
}
async function readManifest(directory, legacy, name = "legacy-gate.json") {
    const m = await safeJson(join(directory, name));
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!m || Object.keys(m).sort().join(",") !== "bootId,createdAtMs,initStart,legacyNamespace,nonce,schemaVersion" || m.schemaVersion !== 1 || m.bootId !== boot || m.initStart !== linuxProcessStartIdentity(1) || !/^[a-f0-9]{32}$/.test(m.nonce) || !Number.isSafeInteger(m.createdAtMs) || m.createdAtMs <= 0 || m.legacyNamespace !== createHash("sha256").update(legacy).digest("hex"))
        throw new Error("worker-legacy-transition-required");
    return m;
}
/** Read-only check. All FOUR inhibitors and this boot's PID1 identity are required. */
export async function verifyLegacyAdmissionGate(runtimeDirectory = defaultRuntimeDirectory(), legacyDirectory = legacySchedulerDirectory()) {
    try {
        const [runtime, legacy] = await Promise.all([realpath(runtimeDirectory), realpath(legacyDirectory)]);
        const manifest = await readManifest(runtime, legacy);
        for (let slot = 0; slot < 4; slot++)
            if (!matches(await safeJson(join(legacy, `slot-${slot}.json`)), owner(manifest)))
                return false;
        return true;
    }
    catch {
        return false;
    }
}
/** Activation-only operation. Never steals/reclaims an old slot, even a dead one.
 * Callers must obtain deployment authority before using non-synthetic paths. */
export async function installLegacyAdmissionGate(options) {
    const runtime = await prepareRuntimeNamespace(options.runtimeDirectory ?? defaultRuntimeDirectory());
    const legacy = await prepareRuntimeNamespace(options.legacyDirectory ?? legacySchedulerDirectory());
    await withRuntimeMutex(join(runtime, "admission.lock"), async () => {
        if (await verifyLegacyAdmissionGate(runtime, legacy))
            return;
        try {
            await safeJson(join(runtime, "legacy-gate.disabled.json"));
            throw new Error("legacy-gate-recovery-required");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        // Refuse partial/reboot/foreign manifests. Recovery requires explicit review.
        try {
            await safeJson(join(runtime, "legacy-gate.json"));
            throw new Error("legacy-gate-recovery-required");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const manifest = { schemaVersion: 1, bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), initStart: linuxProcessStartIdentity(1) ?? "", nonce: randomBytes(16).toString("hex"), legacyNamespace: createHash("sha256").update(legacy).digest("hex"), createdAtMs: Date.now() };
        if (!manifest.initStart)
            throw new Error("worker-legacy-transition-required");
        const owned = owner(manifest);
        const installed = [];
        try {
            // Each link is atomic against unmodified old publication. No final name
            // is overwritten and every successfully published file has one link.
            for (let slot = 0; slot < 4; slot++) {
                const path = join(legacy, `slot-${slot}.json`), temporary = join(legacy, `.admission-${manifest.nonce}-${slot}`);
                const handle = await open(temporary, "wx", 0o600);
                try {
                    await handle.writeFile(JSON.stringify(owned));
                    await handle.sync();
                    await link(temporary, path);
                    installed.push(path);
                }
                finally {
                    await handle.close();
                    await rm(temporary, { force: true });
                }
            }
            if (!await options.confirmLegacyQuiescent())
                throw new Error("legacy-workers-not-quiescent");
            const path = join(runtime, `.legacy-gate-${manifest.nonce}`), output = await open(path, "wx", 0o600);
            try {
                await output.writeFile(JSON.stringify(manifest));
                await output.sync();
            }
            finally {
                await output.close();
            }
            await rename(path, join(runtime, "legacy-gate.json"));
            if (!await verifyLegacyAdmissionGate(runtime, legacy))
                throw new Error("worker-legacy-transition-required");
        }
        catch (error) {
            for (const path of installed) {
                // Read directly while the temporary hardlink may still exist. Do not
                // remove a replacement that is not this activation's exact owner.
                try {
                    if (matches(await safeJson(path), owned))
                        await rm(path);
                }
                catch { }
            }
            throw error;
        }
    });
}
/** Every production start and rollback use this same kernel-held admission lock. */
export async function withVerifiedLegacyAdmission(runtime, action, legacyDirectory = legacySchedulerDirectory()) {
    return withRuntimeMutex(join(runtime, "admission.lock"), async () => {
        if (!await verifyLegacyAdmissionGate(runtime, legacyDirectory))
            throw new Error("worker-legacy-transition-required");
        return action();
    });
}
/** Explicit rollback: block future starts, stop all new cgroups, then remove only
 * exact owned legacy inhibitors. No stop confirmation means NO legacy release. */
export async function removeLegacyAdmissionGate(runtimeDirectory = defaultRuntimeDirectory(), legacyDirectory = legacySchedulerDirectory()) {
    const runtime = await realpath(runtimeDirectory), legacy = await realpath(legacyDirectory);
    await withRuntimeMutex(join(runtime, "admission.lock"), async () => {
        let manifest;
        try {
            manifest = await readManifest(runtime, legacy, "legacy-gate.disabled.json");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            manifest = await readManifest(runtime, legacy);
            if (!await verifyLegacyAdmissionGate(runtime, legacy))
                throw new Error("worker-legacy-transition-required");
            await rename(join(runtime, "legacy-gate.json"), join(runtime, "legacy-gate.disabled.json"));
        }
        await stopRuntimeNamespace(runtime);
        for (let slot = 0; slot < 4; slot++) {
            const path = join(legacy, `slot-${slot}.json`);
            try {
                if (!matches(await safeJson(path), owner(manifest)))
                    throw new Error("legacy-inhibitor-replaced");
                await rm(path);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        await rm(join(runtime, "legacy-gate.disabled.json"));
    });
}
//# sourceMappingURL=worker-runtime-legacy-gate.js.map