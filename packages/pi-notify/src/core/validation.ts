import { CronExpressionParser } from "cron-parser";
import type { AckInput, BindingInput, BindInput, ClaimInput, DestinationInput, EventInput, JobInput, LeaseInput, NoteFields, PiTask, ResourceNote, Trigger } from "../contracts.ts";

export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message); this.name = "ServiceError"; this.code = code; this.status = status;
  }
}
export function fail(code: string, message: string, status = 400): never { throw new ServiceError(code, message, status); }
export function object(value: unknown, label: string, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_input", `${label} must be an object.`);
  const record = value as Record<string, any>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail("unknown_field", `${label}.${key} is not supported.`);
  return record;
}
export function version(record: Record<string, any>) {
  if (record.schemaVersion !== 1) fail("unsupported_version", "schemaVersion must be 1.");
}
export function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail("invalid_input", `${label} must be a nonempty string of at most ${max} characters.`);
}
export function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail("invalid_id", `${label} must use 1–128 letters, digits, dots, underscores, colons, or hyphens.`);
}
export function integer(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("invalid_input", `${label} must be an integer from ${min} to ${max}.`);
}
export function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("invalid_time", `${label} must be an ISO 8601 timestamp with seconds and an explicit offset or Z.`);
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maxDay || Number(value.slice(11, 13)) > 23) fail("invalid_time", `${label} is not a valid calendar timestamp.`);
  return Date.parse(value);
}
function strings(value: unknown, label: string, maxItems = 64, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) fail("invalid_input", `${label} must be an array with ${allowEmpty ? "0" : "1"}–${maxItems} strings.`);
  value.forEach((item, i) => text(item, `${label}[${i}]`));
}
export function noteFields(value: unknown): asserts value is NoteFields {
  const note = object(value, "note", ["purpose", "owner", "references", "repairContext"]);
  text(note.purpose, "note.purpose"); text(note.owner, "note.owner", 256);
  strings(note.references, "note.references", 32, true); text(note.repairContext, "note.repairContext");
}
export function validateNote(value: unknown): ResourceNote {
  const note = object(value, "note", ["schemaVersion", "resourceId", "kind", "purpose", "owner", "references", "repairContext"]);
  version(note); text(note.resourceId, "resourceId", 160);
  if (!["service", "job", "destination", "resource"].includes(note.kind) || !note.resourceId.startsWith(`${note.kind}:`)) fail("invalid_resource", "resourceId must start with the resource kind and a colon.");
  id(note.resourceId.slice(note.kind.length + 1), "resource identity");
  noteFields({ purpose: note.purpose, owner: note.owner, references: note.references, repairContext: note.repairContext });
  return note as ResourceNote;
}
export function nextCron(trigger: Extract<Trigger, {kind: "cron"}>, after: number): number {
  try {
    return CronExpressionParser.parse(trigger.expression, { currentDate: after, tz: trigger.timeZone, strict: true }).next().getTime();
  } catch { return fail("invalid_cron", "Cron must be a valid six-field expression with a possible future occurrence. Use an explicit IANA timezone."); }
}
export function validateTrigger(value: unknown): Trigger {
  if (!value || typeof value !== "object") fail("invalid_trigger", "trigger must be an object.");
  const kind = (value as any).kind;
  if (kind === "once") {
    const t = object(value, "trigger", ["kind", "at"]); timestamp(t.at, "trigger.at");
  } else if (kind === "cron") {
    const t = object(value, "trigger", ["kind", "expression", "timeZone", "startAt"]);
    text(t.expression, "trigger.expression", 256); text(t.timeZone, "trigger.timeZone", 128);
    if (t.expression.split(/\s+/).length !== 6 || /H/.test(t.expression)) fail("invalid_cron", "Use six cron fields including seconds. Random H fields are not supported.");
    try { new Intl.DateTimeFormat("en", { timeZone: t.timeZone }); } catch { fail("invalid_timezone", "trigger.timeZone must be a known IANA timezone."); }
    if (t.startAt !== undefined) timestamp(t.startAt, "trigger.startAt");
    nextCron(t as Extract<Trigger, {kind: "cron"}>, t.startAt ? Date.parse(t.startAt) : Date.now());
  } else if (kind === "event") {
    const t = object(value, "trigger", ["kind", "source", "types", "subject"]);
    id(t.source, "trigger.source"); strings(t.types, "trigger.types", 32);
    t.types.forEach((type: unknown) => id(type, "event type"));
    if (new Set(t.types).size !== t.types.length) fail("invalid_trigger", "trigger.types must not contain duplicates.");
    if (t.subject !== undefined) text(t.subject, "trigger.subject", 512);
  } else fail("invalid_trigger", "trigger.kind must be once, cron, or event.");
  return value as Trigger;
}
function piTask(value: unknown, destinationId: string, trigger: Trigger): asserts value is PiTask {
  const task = object(value, "piTask", ["name", "purpose", "targetId", "trigger", "onWake", "context", "authority", "completionCriteria", "resultDestination", "validity"]);
  text(task.name, "piTask.name", 256); text(task.purpose, "piTask.purpose"); id(task.targetId, "piTask.targetId");
  if (task.targetId !== destinationId) fail("target_mismatch", "piTask.targetId must equal destinationId.");
  validateTrigger(task.trigger);
  if (canonical(task.trigger) !== canonical(trigger)) fail("trigger_mismatch", "piTask.trigger must exactly match the job trigger.");
  text(task.onWake, "piTask.onWake", 16_384); strings(task.context, "piTask.context", 64, true);
  const authority = object(task.authority, "piTask.authority", ["allowedActions", "limits"]);
  strings(authority.allowedActions, "piTask.authority.allowedActions"); strings(authority.limits, "piTask.authority.limits");
  strings(task.completionCriteria, "piTask.completionCriteria");
  const result = object(task.resultDestination, "piTask.resultDestination", ["kind"]);
  if (result.kind !== "delivery-result") fail("invalid_result_destination", "v1 supports only delivery-result. Outcomes are stored on the delivery, not forwarded to another destination.");
  const validity = object(task.validity, "piTask.validity", ["expiresAt", "stopConditions"]);
  timestamp(validity.expiresAt, "piTask.validity.expiresAt"); strings(validity.stopConditions, "piTask.validity.stopConditions");
}
export function validateDestination(value: unknown): DestinationInput {
  const input = object(value, "destination", ["schemaVersion", "id", "kind", "note"]);
  version(input); id(input.id, "id"); noteFields(input.note);
  if (!["pull", "pi"].includes(input.kind)) fail("invalid_destination", "destination.kind must be pull or pi.");
  return input as DestinationInput;
}
export function validateJob(value: unknown): JobInput {
  const input = object(value, "job", ["schemaVersion", "id", "destinationId", "trigger", "note", "piTask", "expiresAt", "missedRun", "graceMs", "retry"]);
  version(input); id(input.id, "id"); id(input.destinationId, "destinationId"); noteFields(input.note);
  const trigger = validateTrigger(input.trigger);
  if (input.piTask !== undefined) piTask(input.piTask, input.destinationId, trigger);
  if (input.expiresAt !== undefined) timestamp(input.expiresAt, "expiresAt");
  if (input.missedRun !== undefined && !["skip", "fire-once"].includes(input.missedRun)) fail("invalid_input", "missedRun must be skip or fire-once.");
  if (input.graceMs !== undefined) integer(input.graceMs, "graceMs", 0, 86_400_000);
  if (input.retry !== undefined) {
    const retry = object(input.retry, "retry", ["maxAttempts", "initialDelayMs", "maxDelayMs"]);
    integer(retry.maxAttempts, "retry.maxAttempts", 1, 20); integer(retry.initialDelayMs, "retry.initialDelayMs", 100, 3_600_000);
    integer(retry.maxDelayMs, "retry.maxDelayMs", retry.initialDelayMs, 86_400_000);
  }
  return input as JobInput;
}
export function validateEvent(value: unknown): EventInput {
  const event = object(value, "event", ["schemaVersion", "id", "source", "type", "subject", "occurredAt", "data"]);
  version(event); id(event.id, "id"); id(event.source, "source"); id(event.type, "type");
  if (event.subject !== undefined) text(event.subject, "subject", 512);
  timestamp(event.occurredAt, "occurredAt"); json(event.data, "data");
  return event as EventInput;
}
export function json(value: unknown, label: string, depth = 0): void {
  if (depth > 32) fail("invalid_input", `${label} exceeds the JSON nesting limit.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => json(item, label, depth + 1)); return; }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const v of Object.values(value)) json(v, label, depth + 1);
    return;
  }
  fail("invalid_input", `${label} must be finite JSON data.`);
}
export function validateLease(value: unknown, kind: "bind" | "binding" | "claim" | "lease" | "ack"): BindInput | BindingInput | ClaimInput | LeaseInput | AckInput {
  const keys = ["schemaVersion", "ownerId", "ttlMs"];
  if (kind !== "bind") keys.push("bindingToken");
  if (kind === "claim") keys.push("waitMs", "leaseMs");
  if (kind === "lease" || kind === "ack") keys.push("leaseToken", "leaseMs");
  if (kind === "ack") keys.push("outcome", "result", "error", "retryAfterMs");
  const input = object(value, kind, keys); version(input); id(input.ownerId, "ownerId");
  if (kind !== "bind") text(input.bindingToken, "bindingToken", 128);
  if (kind === "lease" || kind === "ack") text(input.leaseToken, "leaseToken", 128);
  if (input.ttlMs !== undefined) integer(input.ttlMs, "ttlMs", 1000, 300_000);
  if (input.leaseMs !== undefined) integer(input.leaseMs, "leaseMs", 1000, 300_000);
  if (input.waitMs !== undefined) integer(input.waitMs, "waitMs", 0, 25_000);
  if (kind === "ack") {
    if (!["delivered", "completed", "retry", "failed"].includes(input.outcome)) fail("invalid_outcome", "outcome must be delivered, completed, retry, or failed.");
    if (input.result !== undefined) json(input.result, "result");
    if (input.error !== undefined) text(input.error, "error", 2048);
    if (input.retryAfterMs !== undefined) integer(input.retryAfterMs, "retryAfterMs", 100, 86_400_000);
  }
  return input as any;
}
/** Stable object-key ordering for idempotency, not for authentication. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
