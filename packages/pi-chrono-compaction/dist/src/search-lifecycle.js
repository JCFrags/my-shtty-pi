const pending = () => ({ catalog: "pending", capsules: "pending", index: "pending" });
const same = (a, b) => Object.keys(a).every(key => a[key] === b[key]);
function checked(target) {
    if (!target || Object.keys(target).sort().join(",") !== "catalogDirectory,leafId,sessionKey,shardKey,sourcePath" ||
        [target.sourcePath, target.catalogDirectory].some(x => typeof x !== "string" || !x.startsWith("/") || x.length > 4096 || x.includes("\0")) ||
        [target.sessionKey, target.shardKey].some(x => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x)) ||
        typeof target.leafId !== "string" || !target.leafId || target.leafId.length > 1024)
        throw new Error("search-lifecycle-target-invalid");
    return { ...target };
}
/** One bounded step per timer, one active caller, one coalesced replacement.
 * Queries do not call schedule(). Cancellation awaits worker settlement before
 * replacement; stale results cannot make a new branch look ready. */
export class SearchLifecycleScheduler {
    step;
    delayMs;
    closed = false;
    enabled = false;
    epoch = 0;
    queued;
    active;
    timer;
    current = { state: "disabled", ...pending() };
    constructor(step, delayMs = 100) {
        this.step = step;
        this.delayMs = delayMs;
    }
    status() { return { ...this.current }; }
    schedule(target) {
        if (this.closed)
            return;
        const copy = checked(target);
        this.enabled = true;
        if (this.active && !same(this.active.target, copy))
            this.cancel();
        this.queued = copy;
        if (!this.active)
            this.arm(0);
    }
    cancel() {
        this.epoch++;
        this.queued = undefined;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.active?.controller.abort();
        this.current = { state: this.active ? "cancelling" : this.enabled ? "idle" : "disabled", ...pending() };
    }
    disable() { this.enabled = false; this.cancel(); this.current = { state: "disabled", ...pending() }; }
    dispose() { this.closed = true; this.disable(); }
    async drain() { await this.active?.settled; }
    arm(delay) {
        if (this.timer || this.active || !this.queued || !this.enabled || this.closed)
            return;
        this.current = { ...this.current, state: delay ? "lagging" : "scheduled" };
        this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
        this.timer.unref?.();
    }
    start() {
        if (this.active || !this.queued || !this.enabled || this.closed)
            return;
        const target = this.queued;
        this.queued = undefined;
        const epoch = this.epoch;
        const active = { target, controller: new AbortController(), settled: Promise.resolve() };
        this.active = active;
        this.current = { ...this.current, state: "running" };
        active.settled = Promise.resolve().then(() => this.step(target, active.controller.signal)).then(progress => {
            if (this.closed || epoch !== this.epoch)
                return;
            if (!progress || [progress.catalog, progress.capsules, progress.index].some(x => !["pending", "lagging", "ready"].includes(x)) ||
                (progress.waitingForAppend !== undefined && typeof progress.waitingForAppend !== "boolean") ||
                (progress.memory !== undefined && !["pending", "lagging", "ready", "error"].includes(progress.memory)) ||
                (progress.rollup !== undefined && !["pending", "lagging", "ready", "error"].includes(progress.rollup)))
                throw new Error("search-lifecycle-response-invalid");
            const complete = progress.catalog === "ready" && progress.capsules === "ready" && progress.index === "ready"
                && (progress.memory === undefined || progress.memory === "ready" || progress.memory === "error")
                && (progress.rollup === undefined || progress.rollup === "ready" || progress.rollup === "error");
            this.current = { ...progress, state: complete ? "ready" : "lagging" };
            if (!complete && !progress.waitingForAppend && !this.queued)
                this.queued = target;
        }).catch((error) => {
            if (this.closed || epoch !== this.epoch)
                return;
            const code = error?.code;
            this.current = { ...this.current, state: "error", errorCode: typeof code === "string" && /^(search|catalog|capsule)-[a-z0-9-]{1,80}$/.test(code) ? code : "search-lifecycle-failed" };
            this.queued = undefined;
        }).finally(() => {
            if (this.active === active)
                this.active = undefined;
            if (this.current.state === "cancelling")
                this.current = { state: this.enabled ? "idle" : "disabled", ...pending() };
            this.arm(this.delayMs);
        });
    }
}
//# sourceMappingURL=search-lifecycle.js.map