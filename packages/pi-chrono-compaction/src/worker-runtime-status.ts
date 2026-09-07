import { constants } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { defaultRuntimeDirectory } from "./worker-runtime-namespace.js";
import { WORKER_LIMITS } from "./worker-runtime-limits.js";
import { runtimeUnitName, runtimeUnitState } from "./worker-runtime-systemd.js";
import { verifyLegacyAdmissionGate } from "./worker-runtime-legacy-gate.js";

const CATEGORIES = ["replay-compaction", "candidate-store-update", "rollup-shadow", "history-search", "other"] as const;
export type RuntimeCategory = typeof CATEGORIES[number];
export interface RuntimeHostStatus {
  readonly schemaVersion: 1;
  readonly containmentAvailable: boolean;
  readonly legacyAdmissionBlocked: boolean;
  readonly configuredSlots: number | null;
  readonly active: number;
  readonly queued: number;
  readonly malformedArtifacts: number;
  readonly jobs: readonly { readonly slot: number; readonly category: RuntimeCategory; readonly stage: string }[];
  readonly limits: { readonly hostMemoryBytes: number; readonly sourceBytes: number; readonly queueTickets: number; readonly perSessionTickets: number; readonly waitersPerJob: number; readonly starvationMs: number };
}
async function boundedJson(path: string, maxBytes = 4096): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || s.size > maxBytes) throw new Error("unsafe-status-artifact");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
export function runtimeCategory(kind: string): RuntimeCategory { return CATEGORIES.includes(kind as RuntimeCategory) ? kind as RuntimeCategory : "other"; }
/** Paths/requests/errors are never accepted as stage text. */
export function runtimeStage(value: unknown): string | undefined {
  const stage = typeof value === "string" ? value : value && typeof value === "object" ? (value as { stage?: unknown }).stage : undefined;
  return typeof stage === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(stage) ? stage : undefined;
}
export async function publishRuntimeStage(directory: string, slot: number, category: RuntimeCategory, stage: string): Promise<void> {
  if (!runtimeStage(stage)) return;
  const path = join(directory, `state-${slot}.json`), temporary = join(directory, `.state-${randomBytes(8).toString("hex")}`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, category, stage })); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
/** Bounded read-only host view. Active counts come from systemd, never owner JSON. */
export async function runtimeHostStatus(options: { readonly schedulerDirectory?: string } = {}): Promise<RuntimeHostStatus> {
  const directory = options.schedulerDirectory ?? defaultRuntimeDirectory();
  let configuredSlots: number | null = null, queued = 0, malformedArtifacts = 0;
  try {
    const policy = await boundedJson(join(directory, "policy.json")) as { slots?: number; memoryBytes?: number };
    if (Number.isInteger(policy.slots) && policy.slots! >= 1 && policy.slots! <= 4 && policy.memoryBytes === WORKER_LIMITS.hostMemoryBytes) configuredSlots = policy.slots!;
  } catch {}
  try {
    const names = (await readdir(directory)).filter(name => name.startsWith("ticket-"));
    for (const name of names.slice(0, WORKER_LIMITS.queueTickets)) {
      try {
        const ticket = await boundedJson(join(directory, name)) as { schemaVersion?: number; priority?: string; jobType?: string; nonce?: string };
        if (ticket.schemaVersion === 1 && (ticket.priority === "high" || ticket.priority === "low") && typeof ticket.jobType === "string" && typeof ticket.nonce === "string" && /^[a-f0-9]{32}$/.test(ticket.nonce)) queued++; else malformedArtifacts++;
      } catch { malformedArtifacts++; }
    }
    malformedArtifacts += Math.max(0, names.length - WORKER_LIMITS.queueTickets);
  } catch {}
  const jobs: { slot: number; category: RuntimeCategory; stage: string }[] = [];
  const states = await Promise.all(Array.from({ length: WORKER_LIMITS.slots.max }, (_, slot) => runtimeUnitState(runtimeUnitName(directory, slot))));
  for (let slot = 0; slot < states.length; slot++) {
    if (!["active", "activating", "deactivating", "reloading"].includes(states[slot]!)) continue;
    let category: RuntimeCategory = "other", stage = "controller-running";
    try {
      const state = await boundedJson(join(directory, `state-${slot}.json`)) as { schemaVersion?: number; category?: RuntimeCategory; stage?: string };
      if (state.schemaVersion === 1 && CATEGORIES.includes(state.category!) && runtimeStage(state.stage)) { category = state.category!; stage = state.stage!; }
    } catch {}
    jobs.push({ slot, category, stage });
  }
  return { schemaVersion: 1, containmentAvailable: process.platform === "linux" && states.every(state => state !== "unknown"), legacyAdmissionBlocked: await verifyLegacyAdmissionGate(directory), configuredSlots, active: jobs.length, queued, malformedArtifacts, jobs, limits: { hostMemoryBytes: WORKER_LIMITS.hostMemoryBytes, sourceBytes: WORKER_LIMITS.sourceBytes, queueTickets: WORKER_LIMITS.queueTickets, perSessionTickets: WORKER_LIMITS.sessionTickets, waitersPerJob: WORKER_LIMITS.waitersPerJob, starvationMs: WORKER_LIMITS.starvationMs } };
}
