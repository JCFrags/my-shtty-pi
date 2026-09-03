import {
  validateSessionKey,
  validateSnapshot,
} from "../protocol/validation.js";
import type { ProjectGlanceSnapshot } from "../protocol/model.js";

export type ProjectGlancePaneState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type SnapshotApplyResult = "applied" | "duplicate" | "stale";

export class ProjectGlancePaneModel {
  #expectedSessionKey: string | undefined;
  #snapshot: ProjectGlanceSnapshot | undefined;
  #state: ProjectGlancePaneState = "connecting";
  #revision = 0;

  constructor(expectedSessionKey?: string) {
    this.#expectedSessionKey =
      expectedSessionKey === undefined
        ? undefined
        : validateSessionKey(expectedSessionKey);
  }

  get expectedSessionKey(): string | undefined {
    return this.#expectedSessionKey;
  }

  get state(): ProjectGlancePaneState {
    return this.#state;
  }

  get snapshot(): ProjectGlanceSnapshot | undefined {
    if (!this.#snapshot) return undefined;
    return {
      ...this.#snapshot,
      current: { ...this.#snapshot.current },
      feed: this.#snapshot.feed.map((item) => ({ ...item })),
    };
  }

  setExpectedSessionKey(sessionKey: string): void {
    const next = validateSessionKey(sessionKey);
    if (this.#expectedSessionKey === next) return;
    this.#expectedSessionKey = next;
    this.#snapshot = undefined;
    this.#revision = 0;
    this.#state = "connecting";
  }

  setConnectionState(state: ProjectGlancePaneState): void {
    this.#state = state;
  }

  applySnapshot(value: unknown): SnapshotApplyResult {
    const next = validateSnapshot(value);
    if (!this.#expectedSessionKey || next.sessionKey !== this.#expectedSessionKey) {
      throw new Error("PROJECT_GLANCE_SESSION_MISMATCH");
    }
    if (next.revision < this.#revision) return "stale";
    if (next.revision === this.#revision) return "duplicate";
    this.#snapshot = next;
    this.#revision = next.revision;
    this.#state = "connected";
    return "applied";
  }
}
