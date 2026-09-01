import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stableStringify } from "./utils.js";
export const VALUE_MODEL_SCHEDULER_DIRECTORY = join(tmpdir(), `pi-chrono-value-model-${process.getuid?.() ?? "user"}`);
async function start(pid) { try {
    return (await readFile(`/proc/${pid}/stat`, `utf8`)).split(" ")[21] ?? undefined;
}
catch (error) {
    return error.code === "ENOENT" ? null : undefined;
} }
async function alive(owner) { if (!owner || !Number.isInteger(owner.pid) || typeof owner.processStart !== "string")
    return undefined; const current = await start(owner.pid); return current === null ? false : current === undefined ? undefined : current === owner.processStart; }
export async function acquireValueModelSlot(options) {
    const begun = Date.now(), dir = options.directory ?? VALUE_MODEL_SCHEDULER_DIRECTORY;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const processStart = await start(process.pid);
    if (!processStart)
        throw new Error("scheduler-owner-unverifiable");
    const nonce = randomBytes(16).toString("hex");
    while (true) {
        if (options.signal?.aborted)
            throw new Error("cancelled");
        if (Date.now() - begun >= options.timeoutMs)
            throw new Error("scheduler-timeout");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        for (const name of await readdir(dir)) {
            if (!name.startsWith("slot-"))
                continue;
            const p = join(dir, name);
            try {
                const before = await stat(p);
                const owner = JSON.parse(await readFile(p, "utf8"));
                const state = await alive(owner);
                if (state === false) {
                    const after = await stat(p);
                    const current = JSON.parse(await readFile(p, "utf8"));
                    if (before.ino === after.ino && current.nonce === owner.nonce)
                        await rm(p, { force: true });
                }
            }
            catch { /* Unverifiable owners and replacement owners remain. */ }
        }
        for (let i = 0; i < Math.max(1, Math.min(4, options.slots)); i++) {
            const p = join(dir, `slot-${i}.json`);
            let h;
            try {
                h = await open(p, "wx", 0o600);
            }
            catch (e) {
                if (e.code === "EEXIST")
                    continue;
                throw e;
            }
            await h.writeFile(stableStringify({ protocolVersion: 1, pid: process.pid, processStart, nonce, createdAt: new Date().toISOString(), jobType: "value-model" }));
            const inode = (await h.stat()).ino;
            return { waitMs: Date.now() - begun, release: async () => { try {
                    const s = await stat(p);
                    if (s.ino !== inode)
                        return;
                    const x = JSON.parse(await readFile(p, "utf8"));
                    if (x.nonce === nonce)
                        await rm(p, { force: true });
                }
                finally {
                    await h.close();
                    try {
                        if ((await readdir(dir)).length === 0)
                            await rm(dir, { recursive: true, force: true });
                    }
                    catch { }
                } } };
        }
        await new Promise((resolve, reject) => { const finish = () => { options.signal?.removeEventListener("abort", abort); resolve(); }; const t = setTimeout(finish, 50); const abort = () => { clearTimeout(t); options.signal?.removeEventListener("abort", abort); reject(new Error("cancelled")); }; options.signal?.addEventListener("abort", abort, { once: true }); });
    }
}
//# sourceMappingURL=value-worker-scheduler.js.map