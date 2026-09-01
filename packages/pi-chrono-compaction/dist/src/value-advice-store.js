import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyValueWorkerUsage } from "./value-worker-types.js";
import { stableStringify } from "./utils.js";
export const VALUE_ADVICE_STORE_SUFFIX = ".chrono-value-advice-v1";
export const VALUE_ADVICE_STORE_SCHEMA_VERSION = 1;
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const valueAdviceStorePath = (sessionPath) => `${sessionPath}${VALUE_ADVICE_STORE_SUFFIX}`;
function validHash(value) { if (!value || typeof value !== "object" || typeof value.integrityHash !== "string")
    return false; const { integrityHash, ...base } = value; return sha(stableStringify(base)) === integrityHash; }
export async function readValueAdviceManifest(path) { try {
    const value = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    return value.schemaVersion === 1 && validHash(value) ? value : undefined;
}
catch {
    return undefined;
} }
async function privateWrite(path, text) { const temporary = `${path}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`; await writeFile(temporary, text, { mode: 0o600 }); await chmod(temporary, 0o600); try {
    await rename(temporary, path);
}
finally {
    await rm(temporary, { force: true });
} }
async function processStart(pid) { try {
    return (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[21] ?? undefined;
}
catch (error) {
    return error.code === "ENOENT" ? null : undefined;
} }
async function removeDeadLock(lockPath) { try {
    const before = await stat(lockPath);
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(owner.pid) || typeof owner.processStart !== "string")
        return false;
    const actual = await processStart(owner.pid);
    if (actual === undefined || actual === owner.processStart)
        return false;
    const after = await stat(lockPath);
    if (before.ino !== after.ino)
        return false;
    const current = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof owner.nonce !== "string" || current.nonce !== owner.nonce)
        return false;
    await rm(lockPath);
    return true;
}
catch {
    return false;
} }
async function acquireOwnedLock(path, lockName) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    const lockPath = join(path, lockName);
    const start = await processStart(process.pid);
    if (!start)
        throw new Error("advice-store-busy");
    const nonce = randomBytes(16).toString("hex");
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            handle = await open(lockPath, "wx", 0o600);
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST" || attempt || !await removeDeadLock(lockPath))
                throw new Error(error.code === "EEXIST" ? "advice-store-busy" : "advice-store-write-failed");
        }
    }
    if (!handle)
        throw new Error("advice-store-busy");
    await handle.writeFile(stableStringify({ schemaVersion: 1, pid: process.pid, processStart: start, nonce, createdAt: new Date().toISOString() }));
    const inode = (await handle.stat()).ino;
    return async () => { try {
        const current = await stat(lockPath);
        if (current.ino !== inode)
            return;
        const value = JSON.parse(await readFile(lockPath, "utf8"));
        if (value.nonce === nonce)
            await rm(lockPath);
    }
    catch { }
    finally {
        await handle.close();
    } };
}
export const acquireAdviceWriter = (path) => acquireOwnedLock(path, "writer.lock");
export const acquireAdviceRun = (path) => acquireOwnedLock(path, "model.lock");
function compatible(manifest, context) { return Boolean(manifest && manifest.configurationHash === context.configurationHash && manifest.resolvedModelIdentity === context.resolvedModelIdentity && manifest.thinkingLevel === context.thinkingLevel && manifest.promptSchemaHash === context.promptSchemaHash && manifest.adviceSchemaHash === context.adviceSchemaHash); }
async function recoverAdviceDescriptors(path, context) {
    const files = [];
    const usage = emptyValueWorkerUsage();
    let observed = false;
    let allCostsAvailable = true;
    try {
        for (const fileName of await readdir(join(path, "advice"))) {
            if (!fileName.endsWith(".json"))
                continue;
            try {
                const file = JSON.parse(await readFile(join(path, "advice", fileName), "utf8"));
                if (!validHash(file))
                    continue;
                observed = true;
                usage.calls = Math.max(usage.calls, file.usage.calls);
                usage.repairCalls = Math.max(usage.repairCalls, file.usage.repairCalls);
                usage.inputTokens = Math.max(usage.inputTokens, file.usage.inputTokens);
                usage.outputTokens = Math.max(usage.outputTokens, file.usage.outputTokens);
                usage.cacheReadTokens = Math.max(usage.cacheReadTokens, file.usage.cacheReadTokens);
                usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, file.usage.cacheWriteTokens);
                usage.costMicroUsd = Math.max(usage.costMicroUsd, file.usage.costMicroUsd);
                allCostsAvailable &&= file.usage.costAvailable;
                if (file.configurationHash !== context.configurationHash || file.modelIdentity !== context.resolvedModelIdentity || file.thinkingLevel !== context.thinkingLevel || file.promptSchemaHash !== context.promptSchemaHash || file.adviceSchemaHash !== context.adviceSchemaHash)
                    continue;
                files.push({ fileName, segmentIdentity: file.segmentIdentity, configurationHash: file.configurationHash, contentHash: file.integrityHash, records: file.advice.length });
            }
            catch { }
        }
    }
    catch { }
    usage.costAvailable = observed && allCostsAvailable;
    return { files: files.sort((a, b) => a.fileName.localeCompare(b.fileName)), usage };
}
export async function commitAdviceState(path, context, patch) {
    const release = await acquireAdviceWriter(path);
    try {
        await mkdir(join(path, "advice"), { recursive: true, mode: 0o700 });
        const read = await readValueAdviceManifest(path);
        const old = compatible(read, context) ? read : undefined;
        const recovered = read ? undefined : await recoverAdviceDescriptors(path, context);
        const files = [...(read?.adviceFiles ?? recovered.files)];
        const processed = old ? [...old.processedSegmentIdentities] : files.filter((item) => item.configurationHash === context.configurationHash).map((item) => item.segmentIdentity);
        if (patch.segment) {
            const base = { schemaVersion: 1, segmentIdentity: patch.segment.identity, candidateManifestIdentity: context.candidateManifestIdentity, configurationHash: context.configurationHash, modelIdentity: context.resolvedModelIdentity, thinkingLevel: context.thinkingLevel, promptSchemaHash: context.promptSchemaHash, adviceSchemaHash: context.adviceSchemaHash, advice: patch.segment.advice, usage: patch.segment.usage };
            const file = { ...base, integrityHash: sha(stableStringify(base)) };
            const fileName = `${sha(stableStringify({ segment: patch.segment.identity, configuration: context.configurationHash, candidateManifest: context.candidateManifestIdentity }))}.json`;
            const filePath = join(path, "advice", fileName);
            try {
                await writeFile(filePath, `${stableStringify(file)}\n`, { mode: 0o600, flag: "wx" });
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                const existing = JSON.parse(await readFile(filePath, "utf8"));
                if (!validHash(existing) || existing.integrityHash !== file.integrityHash)
                    throw new Error("advice-store-corrupt");
            }
            const descriptor = { fileName, segmentIdentity: patch.segment.identity, configurationHash: context.configurationHash, contentHash: file.integrityHash, records: patch.segment.advice.length };
            const index = files.findIndex((item) => item.segmentIdentity === patch.segment.identity && item.configurationHash === context.configurationHash);
            if (index >= 0)
                files[index] = descriptor;
            else
                files.push(descriptor);
            if (!processed.includes(patch.segment.identity))
                processed.push(patch.segment.identity);
        }
        const now = new Date().toISOString();
        const base = { schemaVersion: 1, sourceSessionIdentity: context.sourceSessionIdentity, candidateStoreSchemaVersion: 1, candidateManifestIdentity: context.candidateManifestIdentity, modelSpecification: context.modelSpecification, resolvedModelIdentity: context.resolvedModelIdentity, thinkingLevel: context.thinkingLevel, promptSchemaHash: context.promptSchemaHash, adviceSchemaHash: context.adviceSchemaHash, configurationHash: context.configurationHash, processedSegmentIdentities: processed, adviceFiles: files, usage: patch.usage && patch.usage.calls > 0 ? patch.usage : read?.usage ?? recovered?.usage ?? patch.usage ?? emptyValueWorkerUsage(), consecutiveFailures: patch.consecutiveFailures ?? old?.consecutiveFailures ?? 0, circuitState: patch.circuitState ?? old?.circuitState ?? "closed", ...(patch.circuitOpenedAt ? { circuitOpenedAt: patch.circuitOpenedAt } : {}), ...(patch.circuitReopenTime ? { circuitReopenTime: patch.circuitReopenTime } : {}), ...(patch.halfOpenOwner ? { halfOpenOwner: patch.halfOpenOwner } : {}), ...(patch.lastFailureCode ? { lastFailureCode: patch.lastFailureCode } : {}), ...(patch.lastSuccessTime ? { lastSuccessTime: patch.lastSuccessTime } : {}), lastSafeStatus: patch.status, manifestGeneration: (old?.manifestGeneration ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now };
        const manifest = { ...base, integrityHash: sha(stableStringify(base)) };
        await privateWrite(join(path, "manifest.json"), `${stableStringify(manifest, 2)}\n`);
        return manifest;
    }
    finally {
        await release();
    }
}
export async function claimHalfOpenCircuit(path, context, owner, nowMs) { const release = await acquireAdviceWriter(path); try {
    const manifest = await readValueAdviceManifest(path);
    if (!compatible(manifest, context))
        return { manifest: undefined, blocked: false };
    if (manifest.circuitState === "closed")
        return { manifest, blocked: false };
    if (manifest.circuitState === "half-open")
        return { manifest, blocked: true };
    const reopen = Date.parse(manifest.circuitReopenTime ?? "");
    if (!Number.isFinite(reopen) || nowMs < reopen)
        return { manifest, blocked: true };
    const { integrityHash: _oldHash, ...old } = manifest;
    const base = { ...old, circuitState: "half-open", halfOpenOwner: owner, lastSafeStatus: "circuit-half-open", manifestGeneration: old.manifestGeneration + 1, updatedAt: new Date(nowMs).toISOString() };
    const claimed = { ...base, integrityHash: sha(stableStringify(base)) };
    await privateWrite(join(path, "manifest.json"), `${stableStringify(claimed, 2)}\n`);
    return { manifest: claimed, blocked: false };
}
finally {
    await release();
} }
export async function resetAdviceCircuit(path) { const manifest = await readValueAdviceManifest(path); if (!manifest)
    return false; const context = { sourceSessionIdentity: manifest.sourceSessionIdentity, candidateManifestIdentity: manifest.candidateManifestIdentity, modelSpecification: manifest.modelSpecification, resolvedModelIdentity: manifest.resolvedModelIdentity, thinkingLevel: manifest.thinkingLevel, promptSchemaHash: manifest.promptSchemaHash, adviceSchemaHash: manifest.adviceSchemaHash, configurationHash: manifest.configurationHash }; await commitAdviceState(path, context, { status: manifest.lastSafeStatus, usage: manifest.usage, consecutiveFailures: 0, circuitState: "closed" }); return true; }
/** Compatibility wrapper retained for direct package callers. */
export async function publishSegmentAdvice(path, input) { return commitAdviceState(path, input, { status: input.status, usage: input.usage, consecutiveFailures: input.consecutiveFailures, circuitState: input.circuitState, circuitReopenTime: input.circuitReopenTime, segment: { identity: input.segmentIdentity, advice: input.advice, usage: input.usage } }); }
export async function loadStoredAdvice(path, manifest, validRecordHashes) { const output = new Map(); for (const descriptor of manifest.adviceFiles) {
    if (descriptor.configurationHash !== manifest.configurationHash)
        continue;
    try {
        const file = JSON.parse(await readFile(join(path, "advice", descriptor.fileName), "utf8"));
        if (!validHash(file) || file.integrityHash !== descriptor.contentHash || file.configurationHash !== manifest.configurationHash)
            continue;
        for (const advice of file.advice)
            if (!validRecordHashes || validRecordHashes.get(advice.blockId) === advice.candidateIntegrityHash)
                output.set(advice.blockId, advice);
    }
    catch { }
} return output; }
export async function adviceStoreBytes(path) { let total = 0; for (const directory of [path, join(path, "advice")])
    try {
        for (const file of await readdir(directory))
            try {
                total += (await stat(join(directory, file))).size;
            }
            catch { }
    }
    catch { } return total; }
//# sourceMappingURL=value-advice-store.js.map