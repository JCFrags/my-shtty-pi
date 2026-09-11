import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = () => { throw Object.assign(new Error("search-v3-rollout-unsafe"), { code: "search-v3-rollout-unsafe" }); };
function identity(value) {
    if (!value.sessionId || value.sessionId.length > 1024 || !isAbsolute(value.sourcePath) || value.sourcePath.length > 4096)
        return fail();
    return { sessionKey: digest(`pi-session-v1\0${value.sessionId}`), sourceKey: digest(`pi-jsonl-v1\0${value.sourcePath}`) };
}
export function sessionRolloutPath(directory, value) {
    const keys = identity(value);
    if (!isAbsolute(directory) || resolve(directory) !== directory)
        return fail();
    return join(directory, `${digest(`${keys.sessionKey}:${keys.sourceKey}`)}.json`);
}
async function safeDirectory(directory) {
    let current = "/";
    for (const part of directory.split("/").filter(Boolean)) {
        current = join(current, part);
        const s = await lstat(current);
        if (!s.isDirectory() || s.isSymbolicLink() || ![0, process.getuid?.()].includes(s.uid) ||
            ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000))))
            fail();
    }
    const s = await lstat(directory);
    if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700 || await realpath(directory) !== directory)
        fail();
}
/** One owner-only record for this exact session and source, never history I/O. */
export async function readSessionRollout(directory, value) {
    const path = sessionRolloutPath(directory, value), keys = identity(value);
    try {
        await safeDirectory(directory);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const s = await file.stat();
            if (!s.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 4096)
                return fail();
            const buffer = Buffer.alloc(4097);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 4096)
                return fail();
            const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
            if (Object.keys(record).sort().join(",") !== "enabled,schemaVersion,sessionKey,sourceKey" || record.schemaVersion !== 1 ||
                record.sessionKey !== keys.sessionKey || record.sourceKey !== keys.sourceKey || typeof record.enabled !== "boolean")
                return fail();
            return record.enabled;
        }
        finally {
            await file.close();
        }
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        return fail();
    }
}
/** Used by deployment and explicit disable/enable; default loading never writes. */
export async function writeSessionRollout(directory, value, enabled) {
    if (typeof enabled !== "boolean")
        return fail();
    const path = sessionRolloutPath(directory, value);
    await safeDirectory(dirname(directory));
    try {
        await mkdir(directory, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    await safeDirectory(directory);
    await readSessionRollout(directory, value); // refuse an existing unsafe record
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, ...identity(value), enabled }) + "\n");
        await file.sync();
    }
    finally {
        await file.close();
    }
    try {
        await safeDirectory(directory);
        await rename(temporary, path);
    }
    finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT")
            throw error; });
    }
}
//# sourceMappingURL=session-rollout.js.map