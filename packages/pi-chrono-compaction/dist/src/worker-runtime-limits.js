/** One contract for user configuration, protocol validation, and the controller. */
export const WORKER_LIMITS = Object.freeze({
    slots: { min: 1, max: 4 },
    timeoutSeconds: { min: 30, max: 3600 },
    nice: { min: 0, max: 19 },
    hostMemoryBytes: 2 * 1024 * 1024 * 1024,
    sourceBytes: 256 * 1024 * 1024,
    queueTickets: 128,
    sessionTickets: 8,
    coalescedJobs: 64,
    waitersPerJob: 64,
    starvationMs: 5000,
    minMarginalUtilityPerToken: { min: 0, max: 100 },
});
export function inRange(value, range, integer = true) {
    return typeof value === "number" && Number.isFinite(value) && (!integer || Number.isInteger(value)) && value >= range.min && value <= range.max;
}
//# sourceMappingURL=worker-runtime-limits.js.map