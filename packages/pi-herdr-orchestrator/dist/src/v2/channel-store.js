import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rm, stat, unlink, watch, writeFile, } from "node:fs/promises";
import { join } from "node:path";
import { domainDirectoryFor } from "./store.js";
const MAX_FILE_BYTES = 24 * 1024, MAX_PENDING_PER_RUN = 256;
export class ChannelStoreError extends Error {
    code;
    constructor(code) {
        super(code);
        this.name = "ChannelStoreError";
        this.code = code;
    }
}
async function readJson(path) {
    try {
        if ((await stat(path)).size > MAX_FILE_BYTES)
            throw new ChannelStoreError("CHANNEL_RECORD_TOO_LARGE");
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (e) {
        if (e instanceof ChannelStoreError)
            throw e;
        throw new ChannelStoreError(e.code === "ENOENT"
            ? "RESULT_NOT_READY"
            : "CHANNEL_RECORD_MALFORMED");
    }
}
function validRunId(id) {
    return /^r-[0-9a-f-]{36}$/u.test(id);
}
export class ChannelStore {
    domainId;
    directory;
    eventsDirectory;
    resultsDirectory;
    constructor(domainId) {
        this.domainId = domainId;
        this.directory = domainDirectoryFor(domainId);
        this.eventsDirectory = join(this.directory, "events");
        this.resultsDirectory = join(this.directory, "results");
    }
    async ensure() {
        await mkdir(this.eventsDirectory, { recursive: true, mode: 0o700 });
        await mkdir(this.resultsDirectory, { recursive: true, mode: 0o700 });
        await Promise.all([this.directory, this.eventsDirectory, this.resultsDirectory].map((p) => chmod(p, 0o700).catch(() => undefined)));
    }
    async runDirectory(runId) {
        if (!validRunId(runId))
            throw new ChannelStoreError("INVALID_RUN_ID");
        await this.ensure();
        const d = join(this.eventsDirectory, runId);
        await mkdir(d, { recursive: true, mode: 0o700 });
        await chmod(d, 0o700).catch(() => undefined);
        return d;
    }
    async immutable(path, value) {
        await this.ensure();
        const tmp = join(this.directory, `.${process.pid}.${randomUUID()}.tmp`);
        await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600).catch(() => undefined);
        try {
            await link(tmp, path);
            return true;
        }
        catch (e) {
            if (e.code === "EEXIST")
                return false;
            throw e;
        }
        finally {
            await unlink(tmp).catch(() => undefined);
        }
    }
    async appendEvent(base, deliveredSequence) {
        const d = await this.runDirectory(base.runId);
        for (let attempt = 0; attempt < 8; attempt++) {
            const names = (await readdir(d))
                .filter((n) => /^\d{12}\.json$/u.test(n))
                .sort();
            if (names.length >= MAX_PENDING_PER_RUN)
                throw new ChannelStoreError("RUN_EVENT_CAPACITY_REACHED");
            const maximum = names.length ? Number(names.at(-1).slice(0, 12)) : 0;
            const sequence = Math.max(deliveredSequence, maximum) + 1;
            const event = { ...base, sequence };
            if (await this.immutable(join(d, `${String(sequence).padStart(12, "0")}.json`), event))
                return event;
        }
        throw new ChannelStoreError("CHANNEL_EVENT_CONFLICT");
    }
    resultPath(runId) {
        if (!validRunId(runId))
            throw new ChannelStoreError("INVALID_RUN_ID");
        return join(this.resultsDirectory, `${runId}.json`);
    }
    async complete(requested) {
        const result = {
            ...requested,
            completedAt: new Date().toISOString(),
        }, path = this.resultPath(result.runId);
        if (await this.immutable(path, result))
            return { result, duplicate: false };
        const existing = await readJson(path);
        const same = existing.version === requested.version &&
            existing.domainId === requested.domainId &&
            existing.agentId === requested.agentId &&
            existing.runId === requested.runId &&
            existing.agentGeneration === requested.agentGeneration &&
            existing.assignmentGeneration === requested.assignmentGeneration &&
            existing.status === requested.status &&
            existing.summary === requested.summary &&
            existing.finalResult === requested.finalResult;
        if (!same)
            throw new ChannelStoreError("COMPLETION_CONFLICT");
        return { result: existing, duplicate: true };
    }
    async cancel(requested) {
        const result = {
            ...requested,
            completedAt: new Date().toISOString(),
        }, path = this.resultPath(result.runId);
        if (await this.immutable(path, result))
            return { result, cancelled: true };
        return { result: await readJson(path), cancelled: false };
    }
    async result(runId) {
        try {
            return await readJson(this.resultPath(runId));
        }
        catch (e) {
            if (e instanceof ChannelStoreError && e.code === "RESULT_NOT_READY")
                return undefined;
            throw e;
        }
    }
    async events(runIds) {
        const events = [];
        for (const runId of runIds) {
            const d = await this.runDirectory(runId);
            const names = (await readdir(d))
                .filter((n) => /^\d{12}\.json$/u.test(n))
                .sort();
            for (const name of names)
                events.push(await readJson(join(d, name)));
        }
        const wanted = new Set(runIds), legacyNames = (await readdir(this.eventsDirectory))
            .filter((n) => /^[0-9]{13}-[0-9a-f-]{36}\.json$/u.test(n))
            .sort(), perRun = new Map();
        for (const name of legacyNames) {
            const old = await readJson(join(this.eventsDirectory, name));
            if (old.version !== 1 ||
                typeof old.runId !== "string" ||
                !wanted.has(old.runId))
                continue;
            const sequence = (perRun.get(old.runId) ?? 0) + 1;
            perRun.set(old.runId, sequence);
            events.push({
                version: 2,
                sequence,
                kind: old.kind === "progress" ? "progress" : "message",
                domainId: String(old.domainId),
                agentId: String(old.agentId),
                runId: old.runId,
                agentGeneration: Number(old.agentGeneration),
                assignmentGeneration: Number(old.assignmentGeneration),
                target: String(old.target),
                summary: String(old.summary),
                createdAt: String(old.createdAt),
                legacyEventId: name.slice(0, -5),
            });
        }
        return events;
    }
    async discardLegacy(eventIds) {
        for (const eventId of eventIds)
            if (/^[0-9]{13}-[0-9a-f-]{36}$/u.test(eventId))
                await unlink(join(this.eventsDirectory, `${eventId}.json`)).catch((e) => {
                    if (e.code !== "ENOENT")
                        throw e;
                });
    }
    async acknowledge(runId, through) {
        const d = await this.runDirectory(runId);
        for (const name of await readdir(d)) {
            if (/^\d{12}\.json$/u.test(name) && Number(name.slice(0, 12)) <= through)
                await unlink(join(d, name)).catch((e) => {
                    if (e.code !== "ENOENT")
                        throw e;
                });
        }
        await rm(d, { recursive: false }).catch(() => undefined);
    }
    async waitForChange(runIds, timeoutMs) {
        if (timeoutMs <= 0)
            return;
        const directories = await Promise.all(runIds.map((id) => this.runDirectory(id)));
        await this.ensure();
        const controllers = directories
            .map(() => new AbortController())
            .concat(new AbortController());
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                controllers.forEach((c) => c.abort());
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            const consume = async (d, signal) => {
                try {
                    for await (const _ of watch(d, { signal })) {
                        finish();
                        break;
                    }
                }
                catch {
                    finish();
                }
            };
            directories.forEach((d, i) => void consume(d, controllers[i].signal));
            void consume(this.resultsDirectory, controllers.at(-1).signal);
        });
    }
}
