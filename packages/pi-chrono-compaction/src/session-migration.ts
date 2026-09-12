export type MigrationPhase = "disabled" | "unavailable" | "startup" | "catalog" | "capsules" | "index" | "memory" | "rollup" | "awaiting-cut-validation";

export interface MigrationStatus {
  readonly phase: MigrationPhase;
  readonly composerEligibility: "requires-cut-validation";
  readonly checkpointOwner: "derived-stores";
}

/** Read-only state machine over the persistent pipeline checkpoints. Restart
 * resumes those stores rather than creating a second migration cursor. Ready
 * stores do not certify mandatory coverage at a particular compaction cut. */
export function sessionMigrationStatus(input: {
  enabled: boolean;
  searchEnabled: boolean;
  startup: string;
  unsafe: boolean;
  progress: Record<string, unknown>;
}): MigrationStatus {
  const status = (phase: MigrationPhase): MigrationStatus => ({ phase, composerEligibility: "requires-cut-validation", checkpointOwner: "derived-stores" });
  if (!input.enabled) return status("disabled");
  if (input.unsafe || !input.searchEnabled || input.startup === "unavailable") return status("unavailable");
  if (input.startup !== "ready") return status("startup");
  const progress = input.progress;
  if (progress.lastSafeError) return status("unavailable");
  for (const phase of ["catalog", "capsules", "index"] as const) {
    if (progress[phase] !== "ready") return status(phase);
  }
  for (const phase of ["memory", "rollup"] as const) {
    const layer = progress[phase] as { state?: unknown } | undefined;
    if (layer?.state === "unavailable") return status("unavailable");
    if (layer?.state !== "ready") return status(phase);
  }
  return status("awaiting-cut-validation");
}
