import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DurableGlanceRepository, CaptureMode, PageInput, BodyInput } from "../history/contracts.js";
import { createDurableGlanceRepository } from "../history/store.js";
import { defaultHistoryDatabasePath } from "../history/schema.js";
import type { ProjectGlanceSnapshot } from "../protocol/model.js";

/** Incremental capture for the selected session only. It never discovers session files. */
export class ProjectGlanceHistoryController {
  #repository: DurableGlanceRepository | undefined;
  #lastLeaf: string | null | undefined;
  #sessionKey: string | undefined;
  #branchId: string | undefined;
  #needsReconcile = true;
  #status: NonNullable<ProjectGlanceSnapshot["archive"]> = { inboxCount: 0, historyCount: 0, commitSeq: 0, state: "importing" };

  constructor(private readonly environment: NodeJS.ProcessEnv, private readonly factory: (path: string) => DurableGlanceRepository = createDurableGlanceRepository) {}

  get status(): NonNullable<ProjectGlanceSnapshot["archive"]> { return { ...this.#status }; }
  get branchId(): string | undefined { return this.#branchId; }

  sync(sessionKey: string, manager: ExtensionContext["sessionManager"], mode: CaptureMode = "append"): string | undefined {
    try {
      const repository = this.#repository ??= this.factory(defaultHistoryDatabasePath(this.environment));
      const leaf = manager.getLeafId();
      const initial = this.#sessionKey !== sessionKey || this.#needsReconcile;
      if (!initial && mode !== "tree" && leaf === this.#lastLeaf) {
        this.#refreshCounts();
        return this.#branchId;
      }
      const checkpoint = repository.checkpoint(sessionKey);
      const entries = manager.getEntries();
      const startOrdinal = checkpoint?.nextOrdinal ?? 0;
      if (startOrdinal > entries.length || (startOrdinal > 0 && entries[startOrdinal - 1]?.id !== checkpoint?.lastEntryId)) {
        throw new Error("GLANCE_HISTORY_SOURCE_CHANGED");
      }
      const reconcile = initial || mode === "tree";
      const result = repository.capture({
        sessionKey,
        sourceSessionId: manager.getSessionId(),
        mode: reconcile ? (mode === "tree" ? "tree" : "initial") : "append",
        startOrdinal,
        entries: entries.slice(startOrdinal),
        activeLeafId: leaf,
        ...(reconcile ? { activePathIds: manager.getBranch().map((entry) => entry.id) } : {}),
        ...(!reconcile && this.#branchId ? { currentBranchId: this.#branchId } : {}),
      });
      this.#sessionKey = sessionKey;
      this.#branchId = result.branchId;
      this.#lastLeaf = leaf;
      this.#needsReconcile = false;
      this.#refreshCounts();
      return result.branchId;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  page(input: PageInput) {
    try { return this.#ready(input.branchId).page(input); }
    catch (error) { this.fail(error); throw new Error("GLANCE_HISTORY_READ_FAILED"); }
  }

  body(input: BodyInput) {
    try { return this.#ready(input.branchId).body(input); }
    catch (error) { this.fail(error); throw new Error("GLANCE_HISTORY_READ_FAILED"); }
  }

  archive(branchId: string, itemId: string, actionId: string): boolean {
    try {
      const result = this.#ready(branchId).archive({ branchId, itemId, actionId, archivedAt: new Date().toISOString(), source: "action" });
      this.#refreshCounts();
      return result.accepted;
    } catch (error) { this.fail(error); return false; }
  }

  fail(_error: unknown): void {
    // Do not expose database paths, SQL, or source text in transport diagnostics.
    this.#status = { ...this.#status, state: "error", errorCode: "history_storage_failed" };
    this.#needsReconcile = true;
  }

  close(): void {
    this.#repository?.close();
    this.#repository = undefined;
    this.#lastLeaf = undefined;
    this.#sessionKey = undefined;
    this.#branchId = undefined;
    this.#needsReconcile = true;
    this.#status = { inboxCount: 0, historyCount: 0, commitSeq: 0, state: "importing" };
  }

  #ready(branchId: string): DurableGlanceRepository {
    if (!this.#repository || branchId !== this.#branchId || this.#status.state !== "ready") throw new Error("GLANCE_HISTORY_NOT_READY");
    return this.#repository;
  }

  #refreshCounts(): void {
    if (!this.#repository || !this.#branchId) return;
    const counts = this.#repository.counts(this.#branchId);
    this.#status = { inboxCount: counts.inbox, historyCount: counts.history, commitSeq: counts.commitSeq, state: "ready" };
  }
}
