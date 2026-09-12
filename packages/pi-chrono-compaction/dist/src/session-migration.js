/** Read-only state machine over the persistent pipeline checkpoints. Restart
 * resumes those stores rather than creating a second migration cursor. Ready
 * stores do not certify mandatory coverage at a particular compaction cut. */
export function sessionMigrationStatus(input) {
    const status = (phase) => ({ phase, composerEligibility: "requires-cut-validation", checkpointOwner: "derived-stores" });
    if (!input.enabled)
        return status("disabled");
    if (input.unsafe || !input.searchEnabled || input.startup === "unavailable")
        return status("unavailable");
    if (input.startup !== "ready")
        return status("startup");
    const progress = input.progress;
    if (progress.lastSafeError)
        return status("unavailable");
    for (const phase of ["catalog", "capsules", "index"]) {
        if (progress[phase] !== "ready")
            return status(phase);
    }
    for (const phase of ["memory", "rollup"]) {
        const layer = progress[phase];
        if (layer?.state === "unavailable")
            return status("unavailable");
        if (layer?.state !== "ready")
            return status(phase);
    }
    return status("awaiting-cut-validation");
}
//# sourceMappingURL=session-migration.js.map