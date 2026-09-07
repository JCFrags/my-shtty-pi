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
  #collapsed = new Set<string>();
  #selectedId: string | undefined;
  #focusSerial = 0;
  #focusRequested = false;

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

  get visibleFeed(): ProjectGlanceSnapshot["feed"] {
    if (!this.#snapshot) return [];
    const dismissed = new Set(this.#snapshot.uiState?.dismissedIds ?? []);
    return this.#snapshot.feed.filter((item) => !dismissed.has(item.id));
  }

  get unreadCount(): number {
    const read = new Set(this.#snapshot?.uiState?.readIds ?? []);
    return this.visibleFeed.filter((item) => !read.has(item.id)).length;
  }

  get selectedId(): string | undefined {
    return this.#selectedId;
  }

  isExpanded(id: string): boolean {
    return !this.#collapsed.has(id);
  }

  toggleExpanded(id: string): void {
    if (this.#collapsed.has(id)) this.#collapsed.delete(id);
    else this.#collapsed.add(id);
  }

  consumeFocusRequest(): boolean {
    const value = this.#focusRequested;
    this.#focusRequested = false;
    return value;
  }

  focusOldestUnread(): string | undefined {
    const read = new Set(this.#snapshot?.uiState?.readIds ?? []);
    this.#selectedId = this.visibleFeed.find((item) => !read.has(item.id))?.id;
    return this.#selectedId;
  }

  selectRelative(delta: number): void {
    const feed = this.visibleFeed;
    if (feed.length === 0) return;
    const selectedIndex = Math.max(0, feed.findIndex((item) => item.id === this.#selectedId));
    const nextIndex = Math.max(0, Math.min(feed.length - 1, selectedIndex + delta));
    this.#selectedId = feed[nextIndex]?.id;
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
    this.#focusSerial = 0;
    this.#focusRequested = false;
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
    if ((next.focusSerial ?? 0) > this.#focusSerial) {
      this.#focusRequested = true;
      this.#focusSerial = next.focusSerial ?? 0;
    }
    this.#awaitingGenerationSnapshot = false;
    this.#state = "connected";
    if (!this.#selectedId || !this.visibleFeed.some((item) => item.id === this.#selectedId)) this.focusOldestUnread();
    return "applied";
  }
}
