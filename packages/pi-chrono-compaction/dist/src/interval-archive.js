import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HISTORY_HELPER_PROMPT_IDENTITY, historyHelperInputKey, historySourceBindingIdentity } from "./history-helper.js";
import { historySynopsisCompatibilityItems, validateStoredHistorySynopsis } from "./history-synopsis.js";
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sameSource = (a, b) => !!a && !!b && historySourceBindingIdentity(a) === historySourceBindingIdentity(b);
function recordFor(commit, artifact) {
    const body = { schemaVersion: 1, kind: "chrono-independent-original-interval",
        commitId: commit.commitId, source: artifact.source, artifact };
    return Object.freeze({ ...body, integrityHash: digest(JSON.stringify(body)) });
}
/** Archive admission is independent from restart admission. No archive promise
 * is required to assemble, commit, or continue a restart packet. */
export class IntervalArchiveService {
    service;
    store;
    retainedJobs;
    records = new Map();
    constructor(service, store, retainedJobs = 32) {
        this.service = service;
        this.store = store;
        this.retainedJobs = retainedJobs;
        if (service.lane !== "archive" || !Number.isSafeInteger(retainedJobs) || retainedJobs < 1 || retainedJobs > 128)
            throw new Error("history-archive-lane-invalid");
    }
    schedule(commit, input, model, signal) {
        if (!commit || commit.verified !== true || typeof commit.commitId !== "string" || !commit.commitId || commit.commitId.length > 2048
            || !input || input.role !== "archive" || !sameSource(commit.source, input.source)) {
            return { settled: Promise.resolve({ status: "commit-unverified" }), cancel() { } };
        }
        const identity = digest(JSON.stringify([commit.commitId, input.source.logicalSession, input.source.branch, historyHelperInputKey(input)]));
        const prior = this.records.get(identity);
        if (prior)
            return { settled: prior.result, cancel: () => prior.ticket.cancel() };
        // Retain a finite set of receipts. Running jobs cannot be evicted to make
        // their provider slots appear free. Source history is never removed here.
        for (const [key, value] of this.records) {
            if (this.records.size < this.retainedJobs)
                break;
            if (value.status !== "pending")
                this.records.delete(key);
        }
        if (this.records.size >= this.retainedJobs)
            return { settled: Promise.resolve({ status: "queue-full" }), cancel() { } };
        const ticket = this.service.enqueue(input, model, { signal });
        const state = { ticket, result: Promise.resolve({ status: "unselected" }), status: "pending" };
        state.result = ticket.settled.then(async (result) => {
            if (result.status !== "ready") {
                state.status = result.status;
                return { status: result.status };
            }
            const record = recordFor(commit, result.artifact);
            if (this.store) {
                try {
                    await this.store.put(record);
                }
                catch {
                    state.status = "storage-failed";
                    return { status: "storage-failed" };
                }
            }
            state.status = "ready";
            return { status: "ready", record, persisted: !!this.store };
        });
        this.records.set(identity, state);
        return { settled: state.result, cancel: () => ticket.cancel() };
    }
    /** Content-free status, separate from the compaction commit result. */
    status() {
        const values = [...this.records.values()];
        return { pending: values.filter(item => item.status === "pending").length,
            ready: values.filter(item => item.status === "ready").length,
            unavailable: values.filter(item => !["pending", "ready"].includes(item.status)).length };
    }
    recover(commit) {
        return this.store?.get(commit) ?? Promise.resolve(undefined);
    }
}
function storageFailure() { throw new Error("history-archive-storage-unsafe"); }
function assertPrivate(stat, directory) {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
        || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (!directory && stat.nlink !== 1))
        storageFailure();
}
function checkedRecord(value, commit) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.schemaVersion !== 1 || record.kind !== "chrono-independent-original-interval" || record.commitId !== commit.commitId
        || !sameSource(record.source, commit.source) || !record.artifact || record.artifact.role !== "archive"
        || record.artifact.schemaVersion !== 1 || record.artifact.quality !== "structural-only"
        || !sameSource(record.artifact.source, commit.source) || !["full", "partial"].includes(record.artifact.coverage)
        || !Array.isArray(record.artifact.items) || !Array.isArray(record.artifact.notices) || !Array.isArray(record.artifact.usage))
        return undefined;
    // Legacy per-field archives stay readable. New derivations must carry the
    // coherent range account and its exact labeled compatibility projection.
    const synopsis = record.artifact.synopsis;
    if (synopsis !== undefined) {
        if (!validateStoredHistorySynopsis(synopsis)
            || JSON.stringify(record.artifact.items) !== JSON.stringify(synopsis.parts.flatMap(historySynopsisCompatibilityItems)))
            return undefined;
    }
    else if (record.artifact.derivation?.promptIdentity === HISTORY_HELPER_PROMPT_IDENTITY)
        return undefined;
    const body = { schemaVersion: record.schemaVersion, kind: record.kind, commitId: record.commitId, source: record.source, artifact: record.artifact };
    if (digest(JSON.stringify(body)) !== record.integrityHash)
        return undefined;
    return record;
}
/** Optional small private derived store. Existing history remains authoritative.
 * The native history_get owner can use get(commit) for an exact commit selector.
 * No new native current-state owner, index, model tool, or retention policy exists. */
export function createPrivateIntervalArchiveStore(directory, maximumBytes) {
    if (!isAbsolute(directory) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8 * 1024 * 1024)
        storageFailure();
    const path = (commit) => join(directory, `${digest(JSON.stringify([commit.source.logicalSession, commit.source.branch, commit.commitId]))}.json`);
    const directorySafe = async (create) => {
        if (create)
            await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
            assertPrivate(await lstat(directory), true);
            return true;
        }
        catch (error) {
            if (error.code === "ENOENT" && !create)
                return false;
            throw error;
        }
    };
    const get = async (commit) => {
        if (!commit || commit.verified !== true || !await directorySafe(false))
            return undefined;
        let handle;
        try {
            handle = await open(path(commit), constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        try {
            const before = await handle.stat();
            assertPrivate(before, false);
            if (before.size > maximumBytes)
                storageFailure();
            // The maximum is checked before allocation. Never read an unbounded file.
            const buffer = Buffer.alloc(before.size + 1);
            let read = 0;
            while (read < buffer.length) {
                const chunk = await handle.read(buffer, read, buffer.length - read, read);
                if (!chunk.bytesRead)
                    break;
                read += chunk.bytesRead;
            }
            const after = await handle.stat();
            if (read !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
                storageFailure();
            let value;
            try {
                value = JSON.parse(buffer.subarray(0, read).toString("utf8"));
            }
            catch {
                storageFailure();
            }
            const record = checkedRecord(value, commit);
            if (!record)
                storageFailure();
            return record;
        }
        finally {
            await handle.close();
        }
    };
    return {
        get,
        async put(record) {
            const commit = { verified: true, commitId: record.commitId, source: record.source };
            if (!checkedRecord(record, commit))
                storageFailure();
            const text = JSON.stringify(record);
            if (text.length > maximumBytes || Buffer.byteLength(text, "utf8") > maximumBytes)
                storageFailure();
            await directorySafe(true);
            const target = path(commit), temporary = join(directory, `.archive-${randomBytes(16).toString("hex")}.tmp`);
            const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                await handle.writeFile(text, "utf8");
                await handle.sync();
                await handle.close();
                try {
                    await link(temporary, target);
                }
                catch (error) {
                    if (error.code !== "EEXIST")
                        throw error;
                    const existing = await get(commit);
                    if (!existing || existing.integrityHash !== record.integrityHash)
                        storageFailure();
                }
            }
            finally {
                await handle.close().catch(() => undefined);
                await unlink(temporary);
            }
        },
    };
}
//# sourceMappingURL=interval-archive.js.map