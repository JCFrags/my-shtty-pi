import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { LIMITS } from "./limits.js";
const noFollow = constants.O_NOFOLLOW ?? 0;
export async function openPrivateRegular(path) {
    const handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    const uid = process.getuid?.();
    if (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (uid !== undefined && stat.uid !== uid)) {
        await handle.close();
        throw new Error(`Unsafe private file: ${path}`);
    }
    if ((stat.mode & 0o077) !== 0) {
        await handle.close();
        throw new Error(`Unsafe private file mode: ${path}`);
    }
    return handle;
}
export async function readPrivateRegular(path) {
    const handle = await openPrivateRegular(path);
    try {
        return await handle.readFile("utf8");
    }
    finally {
        await handle.close();
    }
}
export async function* readPrivateLines(path, observe) {
    const handle = await openPrivateRegular(path);
    observe?.(await handle.stat());
    let stream;
    try {
        stream = handle.createReadStream({ autoClose: true });
    }
    catch (error) {
        await handle.close();
        throw error;
    }
    let buffer = Buffer.alloc(0);
    try {
        for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (buffer.length + bytes.length > LIMITS.maxLineBytes &&
                bytes.indexOf(0x0a) < 0)
                throw new Error("Private line exceeds the maximum size.");
            buffer = Buffer.concat([buffer, bytes]);
            if (buffer.length > LIMITS.maxLineBytes && buffer.indexOf(0x0a) < 0)
                throw new Error("Private line exceeds the maximum size.");
            let newline = buffer.indexOf(0x0a);
            while (newline >= 0) {
                if (newline > LIMITS.maxLineBytes)
                    throw new Error("Private line exceeds the maximum size.");
                let line = buffer.subarray(0, newline);
                yield line.toString("utf8");
                buffer = buffer.subarray(newline + 1);
                newline = buffer.indexOf(0x0a);
            }
            if (buffer.length > LIMITS.maxLineBytes)
                throw new Error("Private line exceeds the maximum size.");
        }
        if (buffer.length)
            throw new Error("Private file ends with an incomplete line.");
    }
    finally {
        const streamCompletion = finished(stream, { cleanup: true });
        stream.destroy();
        await streamCompletion.catch((error) => {
            if (error.code !== "ERR_STREAM_PREMATURE_CLOSE" &&
                error.code !== "ABORT_ERR")
                throw error;
        });
    }
}
export async function createPrivateExclusive(path, content) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
    }
    finally {
        await handle.close();
    }
}
export async function replacePrivateRegular(path, content) {
    await verifyPrivatePath(path);
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await createPrivateExclusive(temporary, content);
        await rename(temporary, path);
        const directory = await open(dirname(path), constants.O_RDONLY);
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT")
                throw error;
        });
    }
}
export async function verifyPrivatePath(path) {
    const stat = await lstat(path);
    const uid = process.getuid?.();
    if (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o077) !== 0)
        throw new Error(`Unsafe private file: ${path}`);
}
