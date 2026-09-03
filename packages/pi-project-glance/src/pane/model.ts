import {
  validateGeneration,
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

export interface ProjectGlanceRelayIdentity {
  sessionKey: string;
  generation: string;
}

export class ProjectGlancePaneModel {
  #expectedSessionKey: string | undefined;
  #expectedGeneration: string | undefined;
  #snapshot: ProjectGlanceSnapshot | undefined;
  #state: ProjectGlancePaneState = "connecting";
  #revision = 0;
  #awaitingGenerationSnapshot = false;

  constructor(expectedSessionKey?: string, expectedGeneration?: string) {
    this.#expectedSessionKey =
      expectedSessionKey === undefined
        ? undefined
        : validateSessionKey(expectedSessionKey);
    this.#expectedGeneration =
      expectedGeneration === undefined
        ? undefined
        : validateGeneration(expectedGeneration);
    this.#awaitingGenerationSnapshot = this.#expectedGeneration !== undefined;
  }

  get expectedSessionKey(): string | undefined {
    return this.#expectedSessionKey;
  }

  get expectedGeneration(): string | undefined {
    return this.#expectedGeneration;
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
    const nextSessionKey = validateSessionKey(sessionKey);
    if (this.#expectedSessionKey === nextSessionKey) return;
    this.#expectedSessionKey = nextSessionKey;
    this.#snapshot = undefined;
    this.#revision = 0;
    this.#awaitingGenerationSnapshot = this.#expectedGeneration !== undefined;
    this.#state = "connecting";
  }

  setExpectedRelay(identity: ProjectGlanceRelayIdentity): void {
    const nextSessionKey = validateSessionKey(identity.sessionKey);
    const nextGeneration = validateGeneration(identity.generation);
    const sessionChanged = this.#expectedSessionKey !== nextSessionKey;
    const generationChanged = this.#expectedGeneration !== nextGeneration;
    if (!sessionChanged && !generationChanged) return;

    this.#expectedSessionKey = nextSessionKey;
    this.#expectedGeneration = nextGeneration;
    this.#revision = 0;
    this.#awaitingGenerationSnapshot = true;
    if (sessionChanged) {
      this.#snapshot = undefined;
      this.#state = "connecting";
    } else {
      // Keep the last safe snapshot while the new relay generation is being
      // authenticated, but never reuse the old generation's revision gate.
      this.#state = "reconnecting";
    }
  }

  setConnectionState(state: ProjectGlancePaneState): void {
    if (state === "connected" && this.#awaitingGenerationSnapshot) {
      this.#state = this.#snapshot ? "reconnecting" : "connecting";
      return;
    }
    this.#state = state;
  }

  applySnapshot(
    value: unknown,
    identity?: string | ProjectGlanceRelayIdentity,
  ): SnapshotApplyResult {
    const next = validateSnapshot(value);
    const generation =
      typeof identity === "string" ? identity : identity?.generation;
    const sessionKey =
      typeof identity === "object" ? identity.sessionKey : undefined;
    if (!this.#expectedSessionKey || next.sessionKey !== this.#expectedSessionKey) {
      throw new Error("PROJECT_GLANCE_SESSION_MISMATCH");
    }
    if (sessionKey !== undefined && sessionKey !== this.#expectedSessionKey) {
      throw new Error("PROJECT_GLANCE_SESSION_MISMATCH");
    }
    if (
      this.#expectedGeneration !== undefined &&
      (generation === undefined || generation !== this.#expectedGeneration)
    ) {
      throw new Error("PROJECT_GLANCE_GENERATION_MISMATCH");
    }
    if (next.revision < this.#revision) return "stale";
    if (next.revision === this.#revision) return "duplicate";
    this.#snapshot = next;
    this.#revision = next.revision;
    this.#awaitingGenerationSnapshot = false;
    this.#state = "connected";
    return "applied";
  }
}
