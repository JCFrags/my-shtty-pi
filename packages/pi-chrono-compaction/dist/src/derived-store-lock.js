import { randomBytes } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
async function linuxProcessStart(pid) {
    if (process.platform !== "linux")
        return "unverifiable";
    try {
        const text = await readFile(`/proc/${pid}/stat`, "utf8");
        return text.slice(text.lastIndexOf(")") + 2).split(" ")[19] ?? "unverifiable";
    }
    catch (error) {
        return error.code === "ENOENT" ? "missing" : "unverifiable";
    }
}
function validOwner(value) {
    if (!value || typeof value !== "object")
        return false;
    const owner = value;
    return owner.schemaVersion === 1 && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 &&
        typeof owner.processStartIdentity === "string" && owner.processStartIdentity.length > 0 &&
        typeof owner.nonce === "string" && /^[a-f0-9]{32}$/.test(owner.nonce) &&
        typeof owner.creationTime === "string";
}
async function readOwner(path) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        throw new Error("derived-store-lock-owner-unverifiable");
    }
    if (!validOwner(parsed))
        throw new Error("derived-store-lock-owner-unverifiable");
    return parsed;
}
export async function acquireDerivedStoreLock(lockPath, options = {}) {
    const readStart = options.readProcessStart ?? linuxProcessStart;
    const processStartIdentity = await readStart(process.pid);
    if (processStartIdentity === "missing" || processStartIdentity === "unverifiable")
        throw new Error("derived-store-lock-owner-unverifiable");
    const owner = {
        schemaVersion: 1,
        pid: process.pid,
        processStartIdentity,
        nonce: randomBytes(16).toString("hex"),
        creationTime: new Date().toISOString(),
    };
    let handle;
    try {
        handle = await open(lockPath, "wx", 0o600);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        const existing = await readOwner(lockPath);
        const currentStart = await readStart(existing.pid);
        if (currentStart === "unverifiable")
            throw new Error("derived-store-lock-owner-unverifiable");
        if (currentStart !== "missing" && currentStart === existing.processStartIdentity)
            throw new Error("derived-store-busy");
        const before = await stat(lockPath);
        const again = await readOwner(lockPath);
        const after = await stat(lockPath);
        if (before.ino !== after.ino || again.pid !== existing.pid ||
            again.processStartIdentity !== existing.processStartIdentity || again.nonce !== existing.nonce) {
            throw new Error("derived-store-lock-replaced");
        }
        await rm(lockPath);
        handle = await open(lockPath, "wx", 0o600);
    }
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    const inode = (await handle.stat()).ino;
    return async () => {
        await handle.close();
        try {
            const currentStat = await stat(lockPath);
            const current = await readOwner(lockPath);
            if (currentStat.ino === inode && current.pid === owner.pid &&
                current.processStartIdentity === owner.processStartIdentity && current.nonce === owner.nonce) {
                await rm(lockPath);
            }
        }
        catch {
            // A missing, malformed, or replacement lock is not owned by this release.
        }
    };
}
//# sourceMappingURL=derived-store-lock.js.map