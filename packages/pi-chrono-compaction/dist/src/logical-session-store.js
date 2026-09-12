import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isLogicalSessionManifest, sealLogicalManifest } from "./logical-session-contract.js";
import { acquireDerivedStoreLock } from "./derived-store-lock.js";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
async function safeDirectory(path, create = false, privateLeaf = true) {
    if (!isAbsolute(path) || resolve(path) !== path)
        fail("logical-session-storage-unsafe");
    if (create)
        await mkdir(path, { recursive: true, mode: 0o700 });
    let current = "/";
    for (const part of path.split("/").filter(Boolean)) {
        current = join(current, part);
        const stat = await lstat(current).catch(error => {
            if (error.code === "ENOENT")
                throw error;
            return fail("logical-session-storage-unsafe");
        });
        if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid?.()].includes(stat.uid)
            || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000))))
            fail("logical-session-storage-unsafe");
    }
    const stat = await lstat(path);
    if (stat.uid !== process.getuid?.()
        || (privateLeaf ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)
        || await realpath(path) !== path)
        fail("logical-session-storage-unsafe");
}
export class LogicalSessionStore {
    root;
    logicalSessionId;
    constructor(root, logicalSessionId) {
        this.root = root;
        this.logicalSessionId = logicalSessionId;
        if (!isAbsolute(root) || resolve(root) !== root || !/^[0-9a-f-]{36}$/.test(logicalSessionId))
            fail("logical-session-storage-unsafe");
    }
    get directory() { return join(this.root, this.logicalSessionId); }
    get manifestPath() { return join(this.directory, "manifest.json"); }
    async read() {
        try {
            await safeDirectory(this.root);
            await safeDirectory(this.directory);
            const file = await open(this.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024)
                    fail("logical-session-storage-unsafe");
                const bytes = Buffer.alloc(stat.size + 1);
                const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
                if (bytesRead !== stat.size)
                    fail("logical-session-storage-unsafe");
                let value = undefined;
                try {
                    value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
                }
                catch {
                    fail("logical-session-manifest-invalid");
                }
                if (!isLogicalSessionManifest(value))
                    throw Object.assign(new Error("logical-session-manifest-invalid"), { code: "logical-session-manifest-invalid" });
                return value;
            }
            finally {
                await file.close();
            }
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async create(initial) {
        // The shared Pi agent directory can be readable. Chrono stores remain private.
        await safeDirectory(dirname(this.root), false, false);
        await safeDirectory(this.root, true);
        await safeDirectory(this.directory, true);
        const release = await acquireDerivedStoreLock(join(this.directory, "manifest.lock"));
        try {
            if (await this.read())
                fail("logical-session-already-exists");
            return await this.publish(sealLogicalManifest({ ...initial, revision: 1 }), undefined);
        }
        finally {
            await release();
        }
    }
    async update(expectedRevision, mutate) {
        const release = await acquireDerivedStoreLock(join(this.directory, "manifest.lock"));
        try {
            const current = await this.read();
            if (!current || current.revision !== expectedRevision)
                throw Object.assign(new Error("logical-session-revision-conflict"), { code: "logical-session-revision-conflict" });
            const next = sealLogicalManifest({ ...mutate(structuredClone(current)), revision: expectedRevision + 1 });
            return await this.publish(next, expectedRevision);
        }
        finally {
            await release();
        }
    }
    async publish(value, expectedRevision) {
        if (!isLogicalSessionManifest(value))
            fail("logical-session-manifest-invalid");
        await safeDirectory(this.directory);
        if (expectedRevision !== undefined) {
            const latest = await this.read();
            if (!latest || latest.revision !== expectedRevision)
                fail("logical-session-revision-conflict");
        }
        const temporary = join(this.directory, `.manifest-${randomUUID()}.tmp`);
        const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
            await file.writeFile(JSON.stringify(value) + "\n");
            await file.sync();
        }
        finally {
            await file.close();
        }
        try {
            await safeDirectory(this.directory);
            await rename(temporary, this.manifestPath);
            const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }
        finally {
            await unlink(temporary).catch(error => { if (error.code !== "ENOENT")
                throw error; });
        }
        return value;
    }
}
//# sourceMappingURL=logical-session-store.js.map