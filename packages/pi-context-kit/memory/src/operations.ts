import { at, eventTime, fail, integer, LIMITS, object, plain, sealRecord, sha, sourceLinks, text, validity, type MemoryRecord, type Origin, type SourceLink } from "./contracts.ts";
import type { Change, MemoryStore, Meta } from "./store.ts";

export type Action = "remember" | "update" | "forget" | "promote" | "propose" | "accept" | "reject";
export interface OperationContext { operationId: string; origin: Origin; now?: string }
const common = ["text", "scope", "confidence", "eventTime", "validity", "sources", "reason"];
const keys: Record<Action, string[]> = {
  remember: [...common, "supersedesMemoryId", "expectedSupersededRevision"], update: [...common, "memoryId", "expectedRevision"],
  forget: ["memoryId", "expectedRevision", "reason"], promote: ["memoryId", "expectedRevision", "reason"], propose: common,
  accept: ["memoryId", "expectedRevision", "targetMemoryId", "expectedTargetRevision", "reason"], reject: ["memoryId", "expectedRevision", "reason"],
};
function confidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail("confidence-invalid");
  return value;
}
export function validateOperation(action: Action, raw: unknown): Record<string, any> {
  if (!keys[action]) fail("action-invalid");
  const input = object(plain(raw), keys[action]);
  for (const key of ["memoryId", "supersedesMemoryId", "targetMemoryId"]) if (input[key] !== undefined) text(input[key]);
  for (const key of ["expectedRevision", "expectedTargetRevision", "expectedSupersededRevision"]) if (input[key] !== undefined) integer(input[key]);
  if (["update", "forget", "promote", "accept", "reject"].includes(action)) text(input.memoryId);
  if (["accept", "reject"].includes(action)) integer(input.expectedRevision);
  if (["remember", "update", "propose"].includes(action)) text(input.text, LIMITS.text);
  if (input.scope !== undefined) text(input.scope, 256);
  if (input.reason !== undefined) text(input.reason, 1024);
  if (input.confidence !== undefined) confidence(input.confidence);
  if (input.eventTime !== undefined) eventTime(input.eventTime);
  if (input.validity !== undefined) validity(input.validity);
  if (input.sources !== undefined) sourceLinks(input.sources);
  if (input.targetMemoryId !== undefined) integer(input.expectedTargetRevision);
  if (input.expectedTargetRevision !== undefined && !input.targetMemoryId || input.expectedSupersededRevision !== undefined && !input.supersedesMemoryId) fail("input-invalid");
  return input;
}
export function buildOperation(store: MemoryStore, meta: Meta, action: Action, raw: unknown, context: OperationContext): Change {
  const input = validateOperation(action, raw), sequence = meta.recordedSequence + 1;
  const recordedAt = at(context.now ?? new Date().toISOString());
  if (recordedAt < meta.lastRecordedAt) fail("clock-regressed");
  text(context.operationId); text(context.origin.sessionId); text(context.origin.leafId); text(context.origin.toolCallId);
  const sourceRef = `memory-tool:${context.origin.toolCallId}`;
  const source: SourceLink = { identity: `memory-operation:${meta.storeId}:${context.operationId}`, kind: "operation", role: "operation_origin", derivation: "original", verification: "operation_origin" };
  function previous(id: string, kind: MemoryRecord["kind"], expected?: number): MemoryRecord {
    const record = store.get(id);
    if (!record) fail("not-found");
    if (record.kind !== kind) fail("kind-conflict");
    if (record.protected) fail("protected");
    if (expected !== undefined && record.revision !== expected) fail("revision-conflict");
    return record;
  }
  function revise(prior: MemoryRecord, patch: Partial<MemoryRecord>, operation = action): MemoryRecord {
    const { revisionHash, ...body } = prior;
    return sealRecord({ ...body, ...patch, revision: prior.revision + 1, previousHash: revisionHash,
      recordedAt, recordedSequence: sequence, origin: { ...context.origin }, operation,
      sourceRef, sources: [source, ...prior.sources.filter(item => item.kind !== "operation")].slice(0, LIMITS.sources),
      ...(input.reason === undefined ? {} : { reason: input.reason }) });
  }
  function create(kind: MemoryRecord["kind"], fields: Record<string, any>): MemoryRecord {
    return sealRecord({ schemaVersion: 1, memoryId: sha(`${meta.storeId}\n${context.operationId}\n${kind}`).slice(0, 20), revision: 1,
      kind, state: kind === "knowledge" ? "current" : "pending", text: fields.text.trim(), scope: fields.scope ?? "session",
      authority: "ordinary", protected: false, confidence: fields.confidence ?? 1, createdAt: recordedAt, recordedAt,
      recordedSequence: sequence, eventTime: eventTime(fields.eventTime), validity: validity(fields.validity),
      origin: { ...context.origin }, originalOrigin: { ...context.origin }, sources: [source, ...sourceLinks(fields.sources)],
      sourceRef, operation: action, previousHash: null, useCount: 0,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: input.supersedesMemoryId }) });
  }
  if (action === "remember" || action === "propose") {
    const created = create(action === "remember" ? "knowledge" : "proposal", input), records = [created];
    if (input.supersedesMemoryId) records.push(revise(previous(input.supersedesMemoryId, "knowledge", input.expectedSupersededRevision), { state: "superseded" }));
    return { records };
  }
  if (action === "accept" || action === "reject") {
    const proposal = previous(input.memoryId, "proposal", input.expectedRevision);
    if (proposal.state !== "pending") fail("proposal-resolved");
    if (action === "reject") return { records: [revise(proposal, { state: "rejected" })] };
    const acceptedFields = { text: proposal.text, scope: proposal.scope, confidence: proposal.confidence,
      eventTime: proposal.eventTime, validity: proposal.validity, derivedFromMemoryId: proposal.memoryId };
    let accepted: MemoryRecord;
    if (input.targetMemoryId) {
      const prior = previous(input.targetMemoryId, "knowledge", input.expectedTargetRevision);
      accepted = revise(prior, { ...acceptedFields, state: "current" });
    } else accepted = create("knowledge", { ...acceptedFields, sources: [] });
    const { revisionHash: _hash, ...body } = accepted;
    accepted = sealRecord({ ...body, derivedFromMemoryId: proposal.memoryId, sources: [source, ...proposal.sources.filter(item => item.kind !== "operation")] });
    return { records: [accepted, revise(proposal, { state: "accepted", acceptedMemoryId: accepted.memoryId, acceptedRevision: accepted.revision })] };
  }
  const prior = previous(input.memoryId, "knowledge", input.expectedRevision);
  if (action === "forget") return { records: [revise(prior, { state: "demoted" })] };
  if (action === "promote") return { records: [revise(prior, { state: "current", useCount: prior.useCount + 1, promotedUntilSequence: sequence + 8 })] };
  let updated = revise(prior, { text: input.text.trim(), scope: input.scope ?? prior.scope, confidence: input.confidence ?? prior.confidence,
    eventTime: input.eventTime === undefined ? prior.eventTime : eventTime(input.eventTime),
    validity: input.validity === undefined ? prior.validity : validity(input.validity), state: "current" });
  if (input.sources !== undefined) {
    const { revisionHash: _hash, ...body } = updated;
    updated = sealRecord({ ...body, sources: [source, ...sourceLinks(input.sources)] });
  }
  return { records: [updated] };
}
