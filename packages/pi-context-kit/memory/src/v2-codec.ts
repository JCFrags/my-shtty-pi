import { createHash } from "node:crypto";
import { fail, integer } from "./contracts.ts";

/** Pure V2 event/hash/reducer semantics from pi-chrono-compaction/src/memory-store.ts and utils.ts.
 * The incremental reducer avoids replaying the full prefix for each converted event.
 * No configured authority loader, file access, extension factory, or runtime resources are imported.
 */
export type V2Action = "remember" | "update" | "promote" | "touch" | "demote" | "forget";
export interface V2Event {
  schemaVersion: 2; eventId: string; memoryId: string; action: V2Action; timestamp: string; turn: number;
  previousEventHash: string; eventHash: string; sourceRef: string; scope: string;
  authority: "ordinary" | "system" | "user" | "project" | "skill"; confidence: number;
  text?: string; reason?: string; supersedesMemoryId?: string;
  authoritativeSourceHash?: string; authoritativeSourceIdentity?: string; authoritativeVerifier?: "configured-file-v1";
}
export interface V2Head {
  memoryId: string; text: string; sourceRef: string; scope: string; authority: V2Event["authority"]; protected: boolean;
  confidence: number; state: "current" | "superseded" | "demoted"; createdAt: string; updatedAt: string;
  createdTurn: number; lastUsedTurn: number; useCount: number; promotedUntilTurn?: number; supersedesMemoryId?: string; lastEventHash: string;
}
export interface V2Input {
  action: V2Action; memoryId: string; timestamp: string; turn: number; sourceRef: string;
  scope?: string; authority?: V2Event["authority"]; confidence?: number; text?: string; reason?: string; supersedesMemoryId?: string;
}
const PROTECTED = new Set<V2Event["authority"]>(["system", "user", "project", "skill"]);
const hash20 = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 20);
export function v2Stringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const record = input as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) result[key] = normalize(record[key]);
    return result;
  };
  return JSON.stringify(normalize(value));
}
function validate(event: V2Event, previousHash: string): void {
  const { eventHash, ...payload } = event;
  if (event.schemaVersion !== 2 || event.previousEventHash !== previousHash || hash20(v2Stringify(payload)) !== eventHash) fail("export-v2-integrity");
  integer(event.turn, 0);
  if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) fail("export-v2-confidence");
  if (event.action === "remember" && PROTECTED.has(event.authority)) {
    const sourceHash = createHash("sha256").update(event.text ?? "").digest("hex");
    const sourceIdentity = hash20(`${event.authority}\n${event.sourceRef}\n${sourceHash}\nconfigured-file-v1`);
    if (event.authoritativeVerifier !== "configured-file-v1" || event.authoritativeSourceHash !== sourceHash
      || event.authoritativeSourceIdentity !== sourceIdentity || !["project", "skill"].includes(event.authority)
      || !event.sourceRef.startsWith(`${event.authority}:`)) fail("export-v2-protected-integrity");
  }
}
export class V2Replay {
  readonly events: V2Event[] = [];
  readonly heads = new Map<string, V2Head>();
  private apply(event: V2Event): void {
    const memories = this.heads, existing = memories.get(event.memoryId);
    if (event.action === "remember") {
      if (existing) fail("export-v2-duplicate-memory");
      memories.set(event.memoryId, {
        memoryId: event.memoryId, text: event.text!, sourceRef: event.sourceRef, scope: event.scope, authority: event.authority,
        protected: PROTECTED.has(event.authority), confidence: event.confidence, state: "current", createdAt: event.timestamp,
        updatedAt: event.timestamp, createdTurn: event.turn, lastUsedTurn: event.turn, useCount: 0,
        ...(event.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: event.supersedesMemoryId }), lastEventHash: event.eventHash,
      });
      if (event.supersedesMemoryId) {
        const superseded = memories.get(event.supersedesMemoryId);
        if (superseded?.protected && !PROTECTED.has(event.authority)) fail("export-v2-protected");
        if (superseded) memories.set(event.supersedesMemoryId, { ...superseded, state: "superseded", updatedAt: event.timestamp });
      }
      return;
    }
    if (!existing) fail("export-v2-unknown-memory");
    if (existing.protected) fail("export-v2-protected");
    if (event.action === "update") memories.set(event.memoryId, { ...existing, text: event.text!, sourceRef: event.sourceRef,
      scope: event.scope, confidence: event.confidence, state: "current", updatedAt: event.timestamp, lastEventHash: event.eventHash });
    else if (event.action === "touch") memories.set(event.memoryId, { ...existing, updatedAt: event.timestamp,
      lastUsedTurn: event.turn, useCount: existing.useCount + 1, lastEventHash: event.eventHash });
    else if (event.action === "promote") memories.set(event.memoryId, { ...existing, state: "current", updatedAt: event.timestamp,
      lastUsedTurn: event.turn, useCount: existing.useCount + 1, promotedUntilTurn: event.turn + 8, lastEventHash: event.eventHash });
    else memories.set(event.memoryId, { ...existing, state: "demoted", updatedAt: event.timestamp, lastEventHash: event.eventHash });
  }
  load(event: V2Event): void {
    validate(event, this.events.at(-1)?.eventHash ?? "0".repeat(64));
    this.apply(event); this.events.push(event);
  }
  /** Ordinary creation follows the V2 builder. Protected prefix events can only enter through load. */
  append(input: V2Input): V2Event {
    const text = input.text?.trim();
    if ((input.action === "remember" || input.action === "update") && !text) fail("export-v2-text");
    const prior = this.heads.get(input.memoryId), authority = input.authority ?? prior?.authority ?? "ordinary";
    const scope = input.scope?.trim() || prior?.scope || "session", confidence = input.confidence ?? prior?.confidence ?? 1;
    if (input.action !== "remember" && !prior) fail("export-v2-unknown-memory");
    if (prior?.protected || input.supersedesMemoryId && this.heads.get(input.supersedesMemoryId)?.protected || PROTECTED.has(authority)) fail("export-v2-protected");
    const previousEventHash = this.events.at(-1)?.eventHash ?? "0".repeat(64);
    const eventId = hash20(`${previousEventHash}\n${input.memoryId}\n${input.action}\n${input.timestamp}\n${input.turn}`).slice(0, 24);
    const withoutHash: Omit<V2Event, "eventHash"> = {
      schemaVersion: 2, eventId, memoryId: input.memoryId, action: input.action, timestamp: input.timestamp, turn: input.turn,
      previousEventHash, sourceRef: input.sourceRef, scope, authority, confidence,
      ...(text === undefined ? {} : { text }), ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: input.supersedesMemoryId }),
    };
    const event = Object.freeze({ ...withoutHash, eventHash: hash20(v2Stringify(withoutHash)) });
    this.load(event); return event;
  }
}
