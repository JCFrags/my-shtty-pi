import { createHash } from "node:crypto";
import {
  readAncestryPage, type ObjectRef, type SessionEntryView, type StateAnchorHost, type StateScope,
} from "@context-kit/state-store";
import { restoreStateCheckpoint, STATE_CHECKPOINT_ENTRY } from "@grounded/pi-core/state-transfer";
import { STATE_EVENT_PROTOCOL, STATE_RESULT_PROTOCOL, requireExactObject, StateToolError } from "@grounded/pi-core/state";
import { validateWorkplanState, type WorkplanEvent } from "@grounded/pi-core/workplan";
import { admitWorkplanJson, LEGACY_PAGE_BYTES, planBoundary, ROOT_BYTES } from "./admission.ts";
import { applyTargetEvent, emptyWorkplanRoot, validatePlanRef, validateWorkplanRoot, type WorkplanRoot } from "./model.ts";
import type { WorkplanStore } from "./store.ts";

export const WORKPLAN_OWNED_RESULT = "context-kit:workplan-result/v1";

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function legacyWorkplanEvent(entry: SessionEntryView): WorkplanEvent | undefined {
  if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "toolResult" || entry.message.toolName !== "workplan") return undefined;
  const details = entry.message.details;
  if (!object(details) || details.ownerProtocol === WORKPLAN_OWNED_RESULT || details.protocol !== STATE_RESULT_PROTOCOL || !Object.hasOwn(details, "event")) return undefined;
  const event = details.event;
  // Preserve the legacy loader's treatment of unrelated/old result envelopes.
  if (!object(event) || event.protocol !== STATE_EVENT_PROTOCOL || event.tool !== "workplan") return undefined;
  return event as unknown as WorkplanEvent;
}
export function isLegacyWorkplanEntry(entry: SessionEntryView): boolean {
  if (entry.type === "custom" && entry.customType === STATE_CHECKPOINT_ENTRY) {
    // A malformed native checkpoint must be examined and refused, not hidden.
    return !object(entry.data) || entry.data.provider === "workplan" || !["todo", "notes"].includes(String(entry.data.provider));
  }
  return legacyWorkplanEvent(entry) !== undefined;
}

interface EvidencePage {
  version: 1;
  kind: "workplan-legacy-page";
  source: StateScope;
  fromEntryId: string | null;
  nextEntryId: string | null;
  sourcePageDigest: string;
  scanned: number;
  /** Only this provider's complete native entries, newest first. */
  entries: SessionEntryView[];
  /** Earlier scanning produced this newer page. Replay follows it forward. */
  newerPage?: ObjectRef;
}
export interface WorkplanImportCursor {
  version: 1;
  kind: "workplan-import-cursor";
  source: StateScope;
  phase: "scan" | "replay" | "complete";
  nextEntryId: string | null;
  evidence?: ObjectRef;
  replayPage?: ObjectRef;
  replayOffset: number;
  stagedRoot?: ObjectRef;
  scannedEntries: number;
  providerEntries: number;
  seenState: boolean;
}
export interface WorkplanImportProgress {
  status: "pending" | "complete";
  cursor: ObjectRef;
  phase: WorkplanImportCursor["phase"];
  scannedEntries: number;
  providerEntries: number;
  root?: WorkplanRoot;
}

const currentScope = (host: StateAnchorHost): StateScope => ({ sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() });
function requireScope(source: StateScope, host: StateAnchorHost): void {
  if (source.sessionId !== host.sessionManager.getSessionId() || source.leafId !== host.sessionManager.getLeafId()) throw new StateToolError("STATE_CONFLICT", "Workplan import source changed. Resume only at its exact source cut");
}
function validateSource(source: StateScope): void {
  requireExactObject(source, ["sessionId", "leafId"], [], "import source", "STATE_CORRUPT");
  for (const value of [source.sessionId, source.leafId]) if (value !== null && (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 128 || /\p{Cc}/u.test(value))) throw new StateToolError("STATE_CORRUPT", "Workplan import source is invalid");
  if (source.sessionId === null) throw new StateToolError("STATE_CORRUPT", "Workplan import source has no session");
}
function counter(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new StateToolError("STATE_CORRUPT", "Workplan import counter is invalid"); }
function validateCursor(cursor: WorkplanImportCursor): void {
  admitWorkplanJson(cursor, 64 * 1024, 10_000);
  requireExactObject(cursor, ["version", "kind", "source", "phase", "nextEntryId", "replayOffset", "scannedEntries", "providerEntries", "seenState"], ["evidence", "replayPage", "stagedRoot"], "import cursor", "STATE_CORRUPT");
  if (cursor.version !== 1 || cursor.kind !== "workplan-import-cursor" || !["scan", "replay", "complete"].includes(cursor.phase) || typeof cursor.seenState !== "boolean") throw new StateToolError("STATE_CORRUPT", "Workplan import cursor is invalid");
  validateSource(cursor.source);
  for (const value of [cursor.replayOffset, cursor.scannedEntries, cursor.providerEntries]) counter(value);
  if (cursor.nextEntryId !== null && (typeof cursor.nextEntryId !== "string" || !cursor.nextEntryId || cursor.nextEntryId.length > 128)) throw new StateToolError("STATE_CORRUPT", "Workplan import continuation is invalid");
  for (const ref of [cursor.evidence, cursor.replayPage, cursor.stagedRoot]) if (ref) validatePlanRef(ref, LEGACY_PAGE_BYTES);
}
function validatePage(page: EvidencePage): void {
  admitWorkplanJson(page, LEGACY_PAGE_BYTES);
  requireExactObject(page, ["version", "kind", "source", "fromEntryId", "nextEntryId", "sourcePageDigest", "scanned", "entries"], ["newerPage"], "legacy evidence page", "STATE_CORRUPT");
  if (page.version !== 1 || page.kind !== "workplan-legacy-page" || !Array.isArray(page.entries) || page.entries.length > 32
    || typeof page.sourcePageDigest !== "string" || !/^[a-f0-9]{64}$/u.test(page.sourcePageDigest)) throw new StateToolError("STATE_CORRUPT", "Workplan evidence page is invalid");
  validateSource(page.source); counter(page.scanned);
  if (page.scanned < page.entries.length || page.scanned > 32) throw new StateToolError("STATE_CORRUPT", "Workplan source page count is invalid");
  if (page.newerPage) validatePlanRef(page.newerPage, LEGACY_PAGE_BYTES);
}

/** Each call scans at most 32 native entries or applies at most four provider
 * events. It retains normalized native provider evidence and exact page digests.
 * It does not copy unrelated conversation bodies or rewrite source JSONL.
 * Cursor objects are durable and can be passed back after process restart.
 */
export async function importWorkplanStep(store: WorkplanStore, host: StateAnchorHost, cursorRef?: ObjectRef, signal?: AbortSignal): Promise<WorkplanImportProgress> {
  return store.exclusive(async () => {
    let cursor: WorkplanImportCursor;
    cursorRef ??= await store.owner.readProgress<ObjectRef>(host, "workplan-import-v1");
    if (cursorRef) {
      cursor = await store.owner.objects.read<WorkplanImportCursor>(cursorRef, { maxBytes: 64 * 1024, validate: validateCursor, signal });
      requireScope(cursor.source, host);
    } else {
      const resolved = await store.resolve(host, signal);
      if (resolved.status === "ready") throw new StateToolError("STATE_CONFLICT", "Workplan already has an owned root at this source cut");
      if (resolved.status === "pending") throw new StateToolError("STATE_CONFLICT", "Workplan ancestry lookup is pending. Retry before starting import");
      cursor = { version: 1, kind: "workplan-import-cursor", source: currentScope(host), phase: "scan", nextEntryId: host.sessionManager.getLeafId(), replayOffset: 0, scannedEntries: 0, providerEntries: 0, seenState: false };
    }
    let root: WorkplanRoot | undefined;
    if (cursor.phase === "scan") {
      const page = await readAncestryPage(host.sessionManager, { fromEntryId: cursor.nextEntryId, maxEntries: 32, maxBytes: LEGACY_PAGE_BYTES - 64 * 1024, signal });
      requireScope(cursor.source, host);
      const entries = page.entries.filter(isLegacyWorkplanEntry);
      const evidence: EvidencePage = {
        version: 1, kind: "workplan-legacy-page", source: cursor.source,
        fromEntryId: cursor.nextEntryId, nextEntryId: page.nextEntryId, sourcePageDigest: page.digest, scanned: page.scanned,
        entries, ...(cursor.evidence ? { newerPage: cursor.evidence } : {}),
      };
      const evidenceRef = await store.owner.objects.publish(evidence, { maxBytes: LEGACY_PAGE_BYTES, validate: validatePage, signal });
      cursor = { ...cursor, nextEntryId: page.nextEntryId, evidence: evidenceRef,
        scannedEntries: cursor.scannedEntries + page.scanned, providerEntries: cursor.providerEntries + entries.length,
        ...(page.complete ? { phase: "replay" as const, replayPage: evidenceRef } : {}),
      };
    } else if (cursor.phase === "replay") {
      root = cursor.stagedRoot ? await store.owner.objects.read<WorkplanRoot>(cursor.stagedRoot, { maxBytes: ROOT_BYTES + 512, validate: validateWorkplanRoot, signal }) : emptyWorkplanRoot();
      let applied = 0, pages = 0;
      while (cursor.replayPage && applied < 4 && pages < 4) {
        const page = await store.owner.objects.read<EvidencePage>(cursor.replayPage, { maxBytes: LEGACY_PAGE_BYTES, validate: validatePage, signal });
        requireScope(page.source, host);
        while (cursor.replayOffset < page.entries.length && applied < 4) {
          const entry = page.entries[page.entries.length - 1 - cursor.replayOffset]!;
          const checkpoint = restoreStateCheckpoint(entry, "workplan", validateWorkplanState);
          if (checkpoint) {
            if (cursor.seenState) throw new StateToolError("STATE_CORRUPT", "Workplan checkpoint follows existing state");
            root = await store.stageNativeState(checkpoint, signal);
            cursor.seenState = true;
          } else {
            const event = legacyWorkplanEvent(entry);
            if (event) {
              admitWorkplanJson(event, LEGACY_PAGE_BYTES);
              const planId = event.action === "create" ? undefined : event.data.planId;
              const plan = typeof planId === "string" ? await store.readSelected(root!, planId, signal) : undefined;
              await planBoundary(signal);
              const operation = applyTargetEvent(root!, plan, event);
              const nextPlan = operation.state.plans.at(-1)!;
              root = await store.stagePlan(root!, nextPlan, operation.state, signal);
              cursor.seenState = true;
            }
          }
          cursor.replayOffset++; applied++;
        }
        if (cursor.replayOffset === page.entries.length) {
          cursor = { ...cursor, replayOffset: 0 };
          if (page.newerPage) cursor.replayPage = page.newerPage; else delete cursor.replayPage;
        }
        pages++;
      }
      cursor.stagedRoot = await store.owner.objects.publish(root, { maxBytes: ROOT_BYTES + 512, validate: validateWorkplanRoot, signal });
      if (!cursor.replayPage) cursor.phase = "complete";
    } else {
      if (!cursor.stagedRoot) throw new StateToolError("STATE_CORRUPT", "Completed Workplan import has no staged root");
      root = await store.owner.objects.read<WorkplanRoot>(cursor.stagedRoot, { maxBytes: ROOT_BYTES + 512, validate: validateWorkplanRoot, signal });
    }
    requireScope(cursor.source, host);
    const nextRef = await store.owner.objects.publish(cursor, { maxBytes: 64 * 1024, validate: validateCursor, signal });
    await store.owner.writeProgress(host, "workplan-import-v1", nextRef);
    return { status: cursor.phase === "complete" ? "complete" : "pending", cursor: nextRef, phase: cursor.phase,
      scannedEntries: cursor.scannedEntries, providerEntries: cursor.providerEntries, ...(root && cursor.phase === "complete" ? { root } : {}),
    };
  });
}

/** Finalization is distinct from preparation. Failed or deferred Pi binding
 * leaves the immutable cursor usable and does not expose the staged root.
 */
export async function finishWorkplanImport(store: WorkplanStore, host: StateAnchorHost, cursorRef: ObjectRef, signal?: AbortSignal): Promise<void> {
  await store.exclusive(async () => {
    const cursor = await store.owner.objects.read<WorkplanImportCursor>(cursorRef, { maxBytes: 64 * 1024, validate: validateCursor, signal });
    if (cursor.phase !== "complete" || !cursor.stagedRoot || !cursor.evidence) throw new StateToolError("STATE_CONFLICT", "Workplan import has not reached its complete source cut");
    const resolved = await store.resolve(host, signal);
    if (resolved.status === "pending") throw new StateToolError("STATE_CONFLICT", "Workplan source lookup is pending");
    if (resolved.status === "ready") {
      if (resolved.snapshot.rootRef.hash === cursor.stagedRoot.hash && resolved.snapshot.importReceipt
        && resolved.snapshot.origin.sessionId === cursor.source.sessionId && resolved.snapshot.origin.leafId === cursor.source.leafId) return;
      throw new StateToolError("STATE_CONFLICT", "Workplan source already has a different owned root");
    }
    requireScope(cursor.source, host);
    const root = await store.owner.objects.read<WorkplanRoot>(cursor.stagedRoot, { maxBytes: ROOT_BYTES + 512, validate: validateWorkplanRoot, signal });
    await store.commitRoot(host, root, { expectedCommitId: null, signal, importReceipt: {
      importer: "context-kit/workplan-legacy/v1", source: cursor.source,
      coverage: { scannedEntries: cursor.scannedEntries, providerEntries: cursor.providerEntries, complete: true,
        sourceDigest: createHash("sha256").update(JSON.stringify(cursor.evidence)).digest("hex") },
      evidence: cursor.evidence,
    } });
  });
}

/** Fresh rollover/rollback checkpoints can bootstrap during one bounded
 * lifecycle call. Older branches use the resumable explicit importer instead.
 * The complete ancestry must fit one page and contain one Workplan checkpoint,
 * with no earlier or later Workplan events. Owner-binding hints are not state.
 */
export async function bootstrapWorkplanCheckpoint(store: WorkplanStore, host: StateAnchorHost, signal?: AbortSignal): Promise<boolean> {
  return store.exclusive(async () => {
    const resolved = await store.resolve(host, signal);
    if (resolved.status !== "legacy") return false;
    const source = currentScope(host);
    const page = await readAncestryPage(host.sessionManager, { fromEntryId: source.leafId, maxEntries: 32, maxBytes: LEGACY_PAGE_BYTES - 64 * 1024, signal });
    requireScope(source, host);
    if (!page.complete) return false;
    const entries = page.entries.filter(isLegacyWorkplanEntry);
    if (entries.length !== 1 || entries[0]!.type !== "custom" || entries[0]!.customType !== STATE_CHECKPOINT_ENTRY) return false;
    const state = restoreStateCheckpoint(entries[0]!, "workplan", validateWorkplanState);
    if (!state) throw new StateToolError("STATE_CORRUPT", "Workplan bootstrap checkpoint is invalid");
    const root = await store.stageNativeState(state, signal);
    const evidence: EvidencePage = { version: 1, kind: "workplan-legacy-page", source, fromEntryId: source.leafId,
      nextEntryId: null, sourcePageDigest: page.digest, scanned: page.scanned, entries };
    const evidenceRef = await store.owner.objects.publish(evidence, { maxBytes: LEGACY_PAGE_BYTES, validate: validatePage, signal });
    requireScope(source, host);
    await store.commitRoot(host, root, { expectedCommitId: null, signal, importReceipt: {
      importer: "context-kit/workplan-checkpoint/v1", source,
      coverage: { scannedEntries: page.scanned, providerEntries: 1, complete: true, sourceDigest: page.digest }, evidence: evidenceRef,
    } });
    return true;
  });
}
