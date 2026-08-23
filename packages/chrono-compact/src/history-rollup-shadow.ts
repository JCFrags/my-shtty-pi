import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveSourceLedgerBranch } from "./ledger-branch.js";
import {
  createHistoryRollupRuntime,
  loadHistoryBranchManifest,
  loadHistoryRollupManifest,
  updateHistoryRollupStore,
} from "./history-rollup-store.js";
import { renderHistoryRollupPrototype } from "./history-rollup-renderer.js";
import { updateSourceLedger } from "./source-ledger.js";
import { estimateTokensFromText } from "./utils.js";
import type { HistoryDynamicContext } from "./history-value.js";

export const ROLLUP_SHADOW_SCHEMA_VERSION = 2;
export const ROLLUP_SHADOW_SUFFIX = ".chrono-rollup-shadow-v2.jsonl";
export const MAX_ROLLUP_SHADOW_RECORDS = 1000;
export const MAX_ROLLUP_SHADOW_BYTES = 4 * 1024 * 1024;

export interface RollupShadowQualityMetrics {
  readonly restrictionCueCoverage: number;
  readonly blockerCoverage: number;
  readonly unresolvedFailureCoverage: number;
  readonly currentResourceCoverage: number;
  readonly invalidReferences: number;
  readonly invalidRanges: number;
  readonly cutLines: number;
  readonly falseCompletions: number;
  readonly unsupportedIdentifiers: number;
  readonly unsupportedQuotations: number;
  readonly unsupportedNumbers: number;
  readonly missingRecoveryRoutes: number;
}

export interface RollupShadowPayload {
  readonly schemaVersion: 2;
  readonly generation: number;
  readonly sourceTokenCount: number;
  readonly currentReplayTokenCount: number;
  readonly rollupTokenCount: number;
  readonly currentQuality: RollupShadowQualityMetrics;
  readonly rollupQuality: RollupShadowQualityMetrics;
  readonly updateTimeMs: number;
  readonly renderTimeMs: number;
  readonly sourceBytesRead: number;
  readonly nodeBytesRead: number;
  readonly queryNodes: number;
  readonly workerTimerDelayMs: number;
  readonly validationIssueCounts: Readonly<Record<string, number>>;
  readonly currentReplayHash: string;
  readonly rollupOutputHash: string;
  readonly safeStatus: "ok" | "validation-failed" | "store-busy-snapshot" | "empty-prefix";
  readonly modelCalls: 0;
  readonly networkCalls: 0;
}

export interface RollupShadowRequestInput {
  readonly sessionPath: string;
  readonly branchLeafId: string;
  readonly firstKeptEntryId: string;
  readonly currentReplayText: string;
  readonly hardTokenBound: number;
  readonly targetTokenBound: number;
  readonly retentionHints: string;
  readonly dynamicContext?: Omit<HistoryDynamicContext, "retentionHints">;
  readonly signal?: AbortSignal;
  readonly persist?: boolean;
}

export interface RollupShadowStatus {
  readonly records: number;
  readonly lastSafeStatus: string;
  readonly currentReplayTokens: { readonly p50: number; readonly maximum: number };
  readonly rollupTokens: { readonly p50: number; readonly maximum: number };
  readonly currentRestrictionCueCoverage: number;
  readonly rollupRestrictionCueCoverage: number;
  readonly currentBlockerCoverage: number;
  readonly rollupBlockerCoverage: number;
  readonly currentUnresolvedFailureCoverage: number;
  readonly rollupUnresolvedFailureCoverage: number;
  readonly currentResourceCoverage: number;
  readonly rollupResourceCoverage: number;
  readonly invalidReferenceCount: number;
  readonly cutLineCount: number;
  readonly falseCompletionCount: number;
  readonly unsupportedFactCount: number;
  readonly updateTimeMs: { readonly p50: number; readonly maximum: number };
  readonly renderTimeMs: { readonly p50: number; readonly maximum: number };
  readonly workerTimerDelayMs: { readonly p50: number; readonly maximum: number };
}

function fullHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function currentReplayQuality(
  text: string,
  result?: Awaited<ReturnType<typeof renderHistoryRollupPrototype>>,
): RollupShadowQualityMetrics {
  const records = [...new Map((result?.plan ?? [])
    .filter(line => line.included && line.record)
    .map(line => [line.record!.id, line.record!])).values()];
  const coverage = (select: (record: (typeof records)[number]) => boolean): number => {
    const selected = records.filter(select);
    if (!selected.length) return 1;
    const visible = selected.filter(record => record.sourceRefs.some(ref => text.includes(ref.entryId))).length;
    return visible / selected.length;
  };
  return {
    restrictionCueCoverage: coverage(record => record.category === "restriction" && ["current", "conflict"].includes(record.lifecycle)),
    blockerCoverage: coverage(record => record.category === "blocker" && record.lifecycle !== "resolved"),
    unresolvedFailureCoverage: coverage(record => record.category === "failure" && record.lifecycle === "unresolved"),
    currentResourceCoverage: coverage(record => record.category === "resource-state" && ["current", "unknown"].includes(record.lifecycle)),
    invalidReferences: 0,
    invalidRanges: 0,
    cutLines: 0,
    falseCompletions: 0,
    unsupportedIdentifiers: 0,
    unsupportedQuotations: 0,
    unsupportedNumbers: 0,
    missingRecoveryRoutes: 0,
  };
}

function rollupQuality(result: Awaited<ReturnType<typeof renderHistoryRollupPrototype>>): RollupShadowQualityMetrics {
  return {
    restrictionCueCoverage: result.quality.restrictionCueCoverage,
    blockerCoverage: result.quality.blockerCoverage,
    unresolvedFailureCoverage: result.quality.unresolvedFailureCoverage,
    currentResourceCoverage: result.quality.currentResourceCoverage,
    invalidReferences: result.quality.invalidSourceReferences,
    invalidRanges: result.quality.invalidSourceRanges,
    cutLines: result.quality.cutLines,
    falseCompletions: result.quality.falseCompletions,
    unsupportedIdentifiers: result.quality.unsupportedIdentifiers,
    unsupportedQuotations: result.quality.unsupportedQuotations,
    unsupportedNumbers: result.quality.unsupportedNumbers,
    missingRecoveryRoutes: result.quality.missingRecoveryRoutes,
  };
}

function issueCounts(issues: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue] = (counts[issue] ?? 0) + 1;
  return counts;
}

function sidecarPath(sessionPath: string): string {
  return `${sessionPath}${ROLLUP_SHADOW_SUFFIX}`;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, text, { mode: 0o600 });
  const handle = await open(temporary, "r");
  await handle.sync();
  await handle.close();
  await rename(temporary, path);
  await chmod(path, 0o600);
  try {
    const directory = await open(dirname(path), "r");
    await directory.sync();
    await directory.close();
  } catch {
    // Directory sync is not supported on every platform.
  }
}

const PAYLOAD_KEYS = [
  "schemaVersion", "generation", "sourceTokenCount", "currentReplayTokenCount", "rollupTokenCount",
  "currentQuality", "rollupQuality", "updateTimeMs", "renderTimeMs", "sourceBytesRead", "nodeBytesRead",
  "queryNodes", "workerTimerDelayMs", "validationIssueCounts", "currentReplayHash", "rollupOutputHash",
  "safeStatus", "modelCalls", "networkCalls",
] as const;
const QUALITY_KEYS = [
  "restrictionCueCoverage", "blockerCoverage", "unresolvedFailureCoverage", "currentResourceCoverage",
  "invalidReferences", "invalidRanges", "cutLines", "falseCompletions", "unsupportedIdentifiers",
  "unsupportedQuotations", "unsupportedNumbers", "missingRecoveryRoutes",
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function safeQuality(value: unknown): value is RollupShadowQualityMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, QUALITY_KEYS) && QUALITY_KEYS.every(key =>
    typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= 0);
}

function safePayload(value: unknown): value is RollupShadowPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const integers = ["generation", "sourceTokenCount", "currentReplayTokenCount", "rollupTokenCount", "sourceBytesRead", "nodeBytesRead", "queryNodes"];
  const times = ["updateTimeMs", "renderTimeMs", "workerTimerDelayMs"];
  const issueCounts = record.validationIssueCounts;
  return exactKeys(record, PAYLOAD_KEYS) && record.schemaVersion === 2 &&
    integers.every(key => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0) &&
    times.every(key => typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= 0) &&
    safeQuality(record.currentQuality) && safeQuality(record.rollupQuality) &&
    !!issueCounts && typeof issueCounts === "object" && !Array.isArray(issueCounts) &&
    Object.entries(issueCounts).every(([key, count]) => /^[a-z0-9-]{1,64}$/.test(key) && Number.isSafeInteger(count) && (count as number) >= 0) &&
    typeof record.currentReplayHash === "string" && /^[a-f0-9]{64}$/.test(record.currentReplayHash) &&
    typeof record.rollupOutputHash === "string" && /^[a-f0-9]{64}$/.test(record.rollupOutputHash) &&
    ["ok", "validation-failed", "store-busy-snapshot", "empty-prefix"].includes(String(record.safeStatus)) &&
    record.modelCalls === 0 && record.networkCalls === 0;
}

export async function readRollupShadowRecords(sessionPath: string): Promise<RollupShadowPayload[]> {
  try {
    const text = await readFile(sidecarPath(sessionPath), "utf8");
    return text.split("\n").filter(Boolean).flatMap(line => {
      try {
        const value: unknown = JSON.parse(line);
        return safePayload(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export async function appendRollupShadowRecord(sessionPath: string, payload: RollupShadowPayload): Promise<void> {
  const path = sidecarPath(sessionPath);
  const line = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(line) > MAX_ROLLUP_SHADOW_BYTES) throw new Error("rollup-shadow-record-too-large");
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // A missing sidecar starts a new append-only metric log.
  }
  const rawLines = raw.split("\n").filter(Boolean);
  const records = await readRollupShadowRecords(sessionPath);
  const existingIsSafe = rawLines.length === records.length;
  if (
    existingIsSafe &&
    records.length < MAX_ROLLUP_SHADOW_RECORDS &&
    Buffer.byteLength(raw) + Buffer.byteLength(line) <= MAX_ROLLUP_SHADOW_BYTES
  ) {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    return;
  }
  const retained = [...records, payload].slice(-MAX_ROLLUP_SHADOW_RECORDS);
  while (retained.length > 1) {
    const text = `${retained.map(record => JSON.stringify(record)).join("\n")}\n`;
    if (Buffer.byteLength(text) <= MAX_ROLLUP_SHADOW_BYTES) {
      await atomicWrite(path, text);
      return;
    }
    retained.shift();
  }
  await atomicWrite(path, `${JSON.stringify(retained[0])}\n`);
}

export async function runRollupShadowEvaluation(input: RollupShadowRequestInput): Promise<RollupShadowPayload> {
  if (input.signal?.aborted) throw Object.assign(new Error("worker-aborted"), { code: "worker-aborted" });
  const runtime = createHistoryRollupRuntime(input.sessionPath);
  const ledger = runtime.ledger = await updateSourceLedger(input.sessionPath);
  const firstKept = ledger.entryById.get(input.firstKeptEntryId);
  if (!firstKept || firstKept.parentId !== input.branchLeafId) {
    throw Object.assign(new Error("invalid-cut"), { code: "invalid-cut" });
  }
  const branch = resolveSourceLedgerBranch(ledger, input.branchLeafId);
  if (branch.entries.length === 0) {
    const empty: RollupShadowPayload = {
      schemaVersion: 2,
      generation: 1,
      sourceTokenCount: 0,
      currentReplayTokenCount: estimateTokensFromText(input.currentReplayText),
      rollupTokenCount: 0,
      currentQuality: currentReplayQuality(input.currentReplayText),
      rollupQuality: currentReplayQuality(""),
      updateTimeMs: 0,
      renderTimeMs: 0,
      sourceBytesRead: 0,
      nodeBytesRead: 0,
      queryNodes: 0,
      workerTimerDelayMs: 0,
      validationIssueCounts: {},
      currentReplayHash: fullHash(input.currentReplayText),
      rollupOutputHash: fullHash(""),
      safeStatus: "empty-prefix",
      modelCalls: 0,
      networkCalls: 0,
    };
    if (input.persist !== false) await appendRollupShadowRecord(input.sessionPath, empty);
    return empty;
  }
  let updateTimeMs = 0;
  let sourceBytesRead = 0;
  let safeStatus: RollupShadowPayload["safeStatus"] = "ok";
  try {
    const updated = await updateHistoryRollupStore(runtime, input.branchLeafId, { signal: input.signal });
    updateTimeMs = updated.updateElapsedMs;
    sourceBytesRead = updated.sourceBytesRead;
  } catch (error) {
    if (!String((error as Error).message).includes("busy")) throw error;
    const manifest = await loadHistoryRollupManifest(runtime);
    const branchManifest = manifest ? await loadHistoryBranchManifest(runtime) : undefined;
    if (!manifest || !branchManifest || branchManifest.branchLeafId !== input.branchLeafId) throw error;
    safeStatus = "store-busy-snapshot";
  }
  const result = await renderHistoryRollupPrototype(runtime, ledger, {
    targetTokens: input.targetTokenBound,
    hardTokens: input.hardTokenBound,
    dynamicContext: {
      retentionHints: input.retentionHints,
      ...input.dynamicContext,
    },
  });
  if (!result.validation.ok) safeStatus = "validation-failed";
  const payload: RollupShadowPayload = {
    schemaVersion: 2,
    generation: (await readRollupShadowRecords(input.sessionPath)).length + 1,
    sourceTokenCount: runtime.branchManifest?.sourceEntryCount
      ? Math.ceil((runtime.branchManifest.sourceByteCoverage ?? 0) / 4)
      : 0,
    currentReplayTokenCount: estimateTokensFromText(input.currentReplayText),
    rollupTokenCount: result.quality.outputTokens,
    currentQuality: currentReplayQuality(input.currentReplayText, result),
    rollupQuality: rollupQuality(result),
    updateTimeMs,
    renderTimeMs: result.quality.renderMs,
    sourceBytesRead: sourceBytesRead + result.quality.sourceBytesReadDuringRender,
    nodeBytesRead: result.quality.nodeBytesReadDuringRender,
    queryNodes: result.quality.queryNodesVisited,
    workerTimerDelayMs: Math.max(result.quality.timerDelayMs, runtime.branchManifest ? 0 : 0),
    validationIssueCounts: issueCounts(result.validation.issues),
    currentReplayHash: fullHash(input.currentReplayText),
    rollupOutputHash: fullHash(result.text),
    safeStatus,
    modelCalls: 0,
    networkCalls: 0,
  };
  if (input.persist !== false) await appendRollupShadowRecord(input.sessionPath, payload);
  return payload;
}

function distribution(values: readonly number[]): { p50: number; maximum: number } {
  if (!values.length) return { p50: 0, maximum: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!, maximum: sorted.at(-1)! };
}

function latest(records: readonly RollupShadowPayload[], select: (record: RollupShadowPayload) => number): number {
  return records.length ? select(records.at(-1)!) : 0;
}

export async function getRollupShadowStatus(sessionPath: string): Promise<RollupShadowStatus> {
  const records = await readRollupShadowRecords(sessionPath);
  return {
    records: records.length,
    lastSafeStatus: records.at(-1)?.safeStatus ?? "none",
    currentReplayTokens: distribution(records.map(record => record.currentReplayTokenCount)),
    rollupTokens: distribution(records.map(record => record.rollupTokenCount)),
    currentRestrictionCueCoverage: latest(records, record => record.currentQuality.restrictionCueCoverage),
    rollupRestrictionCueCoverage: latest(records, record => record.rollupQuality.restrictionCueCoverage),
    currentBlockerCoverage: latest(records, record => record.currentQuality.blockerCoverage),
    rollupBlockerCoverage: latest(records, record => record.rollupQuality.blockerCoverage),
    currentUnresolvedFailureCoverage: latest(records, record => record.currentQuality.unresolvedFailureCoverage),
    rollupUnresolvedFailureCoverage: latest(records, record => record.rollupQuality.unresolvedFailureCoverage),
    currentResourceCoverage: latest(records, record => record.currentQuality.currentResourceCoverage),
    rollupResourceCoverage: latest(records, record => record.rollupQuality.currentResourceCoverage),
    invalidReferenceCount: records.reduce((sum, record) => sum + record.rollupQuality.invalidReferences, 0),
    cutLineCount: records.reduce((sum, record) => sum + record.rollupQuality.cutLines, 0),
    falseCompletionCount: records.reduce((sum, record) => sum + record.rollupQuality.falseCompletions, 0),
    unsupportedFactCount: records.reduce((sum, record) => sum + record.rollupQuality.unsupportedIdentifiers + record.rollupQuality.unsupportedQuotations + record.rollupQuality.unsupportedNumbers, 0),
    updateTimeMs: distribution(records.map(record => record.updateTimeMs)),
    renderTimeMs: distribution(records.map(record => record.renderTimeMs)),
    workerTimerDelayMs: distribution(records.map(record => record.workerTimerDelayMs)),
  };
}

export function rollupShadowSidecarPath(sessionPath: string): string {
  return sidecarPath(sessionPath);
}
