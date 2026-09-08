import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
/** Worker-only source access. This counter does NOT include native SQLite I/O. */
export const CATALOG_SOURCE_CHUNK_BYTES = 64 * 1024;
export const CATALOG_SOURCE_ANCHOR_BYTES = 16 * 1024;
export const CATALOG_SOURCE_JOB_BYTES = 8 * 1024 * 1024;
export class CatalogSourceError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "CatalogSourceError";
    }
}
const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function safeError(error) {
    if (error instanceof CatalogSourceError)
        throw error;
    const code = error?.code;
    throw new CatalogSourceError(code === "ELOOP" ? "catalog-source-unsafe" : code === "ENOENT" ? "catalog-source-changed" : "catalog-source-io");
}
/** Open once, read bounded ranges, close within one contained job. No source writes.
 * No-follow checks are not a security boundary against a malicious same-UID
 * ancestor rename. The final component is opened with O_NOFOLLOW and pinned by fd.
 */
export class CatalogSource {
    budget;
    identity;
    size;
    fd;
    used = 0;
    filename;
    constructor(filename, budget = CATALOG_SOURCE_JOB_BYTES) {
        this.budget = budget;
        if (!isAbsolute(filename) || filename.includes("\0") || !validInteger(budget) || budget < 1 || budget > CATALOG_SOURCE_JOB_BYTES)
            throw new CatalogSourceError("catalog-source-range");
        this.filename = resolve(filename);
        let fd;
        try {
            const parts = this.filename.split(sep).filter(Boolean);
            let path = "";
            for (const part of parts) {
                path += sep + part;
                if (lstatSync(path).isSymbolicLink())
                    throw new CatalogSourceError("catalog-source-unsafe");
            }
            fd = openSync(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = fstatSync(fd, { bigint: true });
            if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 18n) !== 0n)
                throw new CatalogSourceError("catalog-source-unsafe");
            const size = Number(stat.size);
            if (!validInteger(size))
                throw new CatalogSourceError("catalog-source-range");
            this.fd = fd;
            this.size = size;
            this.identity = { device: String(stat.dev), inode: String(stat.ino) };
            this.assertCurrent();
        }
        catch (error) {
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                }
                catch { /* preserve safe original error */ }
            }
            safeError(error);
        }
    }
    get bytesRead() { return this.used; }
    get remainingBytes() { return this.budget - this.used; }
    close() { if (this.fd >= 0) {
        const fd = this.fd;
        this.fd = -1;
        try {
            closeSync(fd);
        }
        catch (error) {
            safeError(error);
        }
    } }
    assertCurrent(minimumSize = this.size) {
        if (!validInteger(minimumSize) || minimumSize > this.size)
            throw new CatalogSourceError("catalog-source-range");
        try {
            const current = lstatSync(this.filename, { bigint: true });
            const pinned = fstatSync(this.fd, { bigint: true });
            for (const stat of [current, pinned]) {
                if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== this.identity.device || String(stat.ino) !== this.identity.inode || stat.size < BigInt(minimumSize))
                    throw new CatalogSourceError("catalog-source-changed");
            }
        }
        catch (error) {
            safeError(error);
        }
    }
    read(offset, length) {
        if (!validInteger(offset) || !validInteger(length) || length > CATALOG_SOURCE_CHUNK_BYTES || offset > this.size || length > this.size - offset)
            throw new CatalogSourceError("catalog-source-range");
        if (length > this.remainingBytes)
            throw new CatalogSourceError("catalog-source-budget");
        const bytes = Buffer.allocUnsafe(length);
        try {
            let done = 0;
            while (done < length) {
                const count = readSync(this.fd, bytes, done, length - done, offset + done);
                if (count === 0)
                    throw new CatalogSourceError("catalog-source-changed");
                done += count;
                this.used += count;
            }
            return bytes;
        }
        catch (error) {
            safeError(error);
        }
    }
    /** Bounded anchors detect sampled changes, NOT every historical prefix rewrite. */
    snapshot(size = this.size) {
        if (!validInteger(size) || size > this.size)
            throw new CatalogSourceError("catalog-source-range");
        const first = Math.min(size, CATALOG_SOURCE_ANCHOR_BYTES);
        const spans = [{ offset: 0, length: first }];
        if (size > first)
            spans.push({ offset: Math.max(first, size - CATALOG_SOURCE_ANCHOR_BYTES), length: Math.min(size - first, CATALOG_SOURCE_ANCHOR_BYTES) });
        const anchors = spans.map(span => ({ ...span, sha256: digest(this.read(span.offset, span.length)) }));
        this.assertCurrent(size);
        return { schemaVersion: 1, identity: this.identity, size, anchors };
    }
    verify(snapshot) {
        if (snapshot?.schemaVersion !== 1 || !validInteger(snapshot.size) || snapshot.size > this.size || snapshot.identity?.device !== this.identity.device || snapshot.identity?.inode !== this.identity.inode)
            throw new CatalogSourceError("catalog-source-changed");
        const first = Math.min(snapshot.size, CATALOG_SOURCE_ANCHOR_BYTES);
        const expected = [{ offset: 0, length: first }];
        if (snapshot.size > first)
            expected.push({ offset: Math.max(first, snapshot.size - CATALOG_SOURCE_ANCHOR_BYTES), length: Math.min(snapshot.size - first, CATALOG_SOURCE_ANCHOR_BYTES) });
        if (!Array.isArray(snapshot.anchors) || snapshot.anchors.length !== expected.length)
            throw new CatalogSourceError("catalog-source-range");
        snapshot.anchors.forEach((anchor, index) => {
            const span = expected[index];
            if (anchor.offset !== span.offset || anchor.length !== span.length || !/^[a-f0-9]{64}$/.test(anchor.sha256))
                throw new CatalogSourceError("catalog-source-range");
            this.verifyRange(anchor);
        });
        this.assertCurrent(snapshot.size);
    }
    /** Selected-byte recovery verifies the complete bounded hashed span, not just
     * its returned subrange. Callers store these hashes atomically with offsets. */
    verifyRange(anchor) {
        if (!/^[a-f0-9]{64}$/.test(anchor.sha256))
            throw new CatalogSourceError("catalog-source-range");
        const bytes = this.read(anchor.offset, anchor.length);
        if (digest(bytes) !== anchor.sha256)
            throw new CatalogSourceError("catalog-source-changed");
        return bytes;
    }
}
//# sourceMappingURL=catalog-source.js.map