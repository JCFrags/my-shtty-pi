import type { SessionEntryLike } from "./types.js";

/** Process-local authorization for one explicitly named fresh physical session.
 * It never carries across a resume, fork, switch or extension reload. */
export class SessionCanary {
  private sourcePath: string | undefined;
  private initialized = false;
  private permitted = false;
  refusal: "session-ineligible" | "mandatory-coverage-incomplete" | "selection-unavailable" | "summary-unavailable" | "composition-refused" | "operation-failed" | undefined;

  refuse(reason: NonNullable<SessionCanary["refusal"]>): { cancel: true } {
    this.refusal = reason;
    return { cancel: true };
  }
  constructor(private readonly requestedSession: unknown) {}

  requested(sessionId: string): boolean {
    return typeof this.requestedSession === "string" && this.requestedSession === sessionId;
  }

  start(sessionId: string, sourcePath: string | undefined, entries: readonly SessionEntryLike[]): void {
    this.permitted = false;
    if (this.initialized || !this.requested(sessionId)) { this.initialized = true; return; }
    this.initialized = true;
    // Setup metadata is permitted, but no conversation, inherited continuation,
    // compaction or custom instruction can be adopted as a fresh canary.
    if (!sourcePath || entries.length > 16 || entries.some(entry =>
      !["model_change", "thinking_level_change", "session_info"].includes(entry.type))) return;
    this.sourcePath = sourcePath;
    this.permitted = true;
  }

  active(sessionId: string, sourcePath: string | undefined): boolean {
    return this.permitted && this.requested(sessionId) && sourcePath === this.sourcePath;
  }

  stop(): void { this.permitted = false; }
}
