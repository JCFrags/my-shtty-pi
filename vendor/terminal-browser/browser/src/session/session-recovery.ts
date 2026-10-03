import { createHash } from "node:crypto";
import { RECOVERY_WARNING, type RecoveryStatus } from "./companion-service";
import { TabRecoveryStore, type TabRecoveryLoadResult, type TabRecoveryTabs } from "./tab-recovery";

interface RecoveryHost {
  snapshot(): TabRecoveryTabs | null;
  restore(snapshot: TabRecoveryTabs): void;
  fresh(): void;
  changed(): void;
}

/** Metadata only. Pending choices and whole-session teardown never autosave tabs. */
export class SessionRecovery {
  private state: RecoveryStatus["state"];
  private readonly loaded: TabRecoveryLoadResult | null;
  private readonly revision: string | null;
  private frozen = false;
  private choosing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warning = "";

  constructor(private readonly store: TabRecoveryStore, private readonly host: RecoveryHost, pending: boolean) {
    this.loaded = pending ? store.load() : null;
    this.state = pending ? "pending" : "none";
    this.revision = this.loaded ? this.digest(this.loaded) : null;
    if (this.loaded && this.loaded.status !== "ready") this.warning = `Saved tabs are unavailable: ${this.loaded.status}.`;
  }

  get pending(): boolean { return this.state === "pending"; }
  get canRestore(): boolean { return this.pending && this.loaded?.status === "ready"; }

  status(): RecoveryStatus {
    const snapshot = this.pending ? this.loaded?.snapshot : this.host.snapshot();
    return {
      state: this.state, revision: this.pending ? this.revision : null,
      entries: snapshot?.entries.map(entry => ({ ...entry })) ?? [],
      activeIndex: snapshot?.activeIndex ?? null,
      warning: `${RECOVERY_WARNING}${this.warning ? ` ${this.warning}` : ""}`,
    };
  }

  choose(choice: "restore" | "fresh", revision: string): RecoveryStatus {
    if (!this.pending || this.choosing || revision !== this.revision) throw new Error("Recovery choice is no longer pending or its revision changed.");
    if (this.digest(this.store.load()) !== this.revision) throw new Error("Saved recovery metadata changed. Reopen this owner before choosing.");
    if (choice !== "restore" && choice !== "fresh") throw new Error("Invalid recovery choice.");
    if (choice === "restore" && !this.canRestore) throw new Error("No valid saved tabs are available to restore.");
    this.choosing = true;
    try {
      if (choice === "restore") {
        const snapshot = this.loaded!.snapshot!;
        this.host.restore({ entries: snapshot.entries.map(entry => ({ ...entry })), activeIndex: snapshot.activeIndex });
      } else {
        const result = this.store.clear();
        if (result !== "cleared" && result !== "missing") throw new Error(`Fresh start refused: recovery storage ${result}.`);
        this.host.fresh();
      }
      this.state = choice === "restore" ? "restored" : "fresh";
    } finally { this.choosing = false; }
    this.saveNow();
    this.host.changed();
    return this.status();
  }

  changed(immediate: boolean): void {
    if (this.pending || this.choosing || this.frozen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (immediate) this.saveNow();
    else this.timer = setTimeout(() => { this.timer = null; this.saveNow(); }, 200);
  }

  freeze(): void {
    if (this.frozen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.saveNow();
    this.frozen = true;
  }

  releaseFreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.saveNow();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private saveNow(): void {
    if (this.pending || this.choosing || this.frozen) return;
    const snapshot = this.host.snapshot();
    const result = snapshot ? this.store.save(snapshot) : "too-large";
    const warning = result === "saved" ? "" : `Tab recovery save was not confirmed: ${result}.`;
    if (warning !== this.warning) { this.warning = warning; this.host.changed(); }
  }

  private digest(result: TabRecoveryLoadResult): string {
    return createHash("sha256").update(JSON.stringify([this.store.key, result])).digest("hex");
  }
}
