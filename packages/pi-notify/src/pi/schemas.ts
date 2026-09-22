import { Type } from "typebox";
import type { Json, JobInput, ResourceNote } from "../contracts.ts";

const text = (maxLength = 4096) => Type.String({ minLength: 1, maxLength });
const id = () => Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" });
const strings = () => Type.Array(text(), { minItems: 1, maxItems: 32 });
const choice = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: values });
const trigger = Type.Union([
  Type.Object({ kind: choice(["once"]), at: text() }, { additionalProperties: false }),
  Type.Object({ kind: choice(["cron"]), expression: text(256), timeZone: text(128), startAt: Type.Optional(text()) }, { additionalProperties: false }),
  Type.Object({ kind: choice(["event"]), source: id(), types: Type.Array(id(), { minItems: 1, maxItems: 32 }), subject: Type.Optional(text(512)) }, { additionalProperties: false }),
]);
const note = {
  purpose: text(), owner: text(256), references: Type.Array(text(), { maxItems: 32 }), repairContext: text(),
};
export const jobSchema = Type.Object({
  schemaVersion: Type.Literal(1), id: id(), destinationId: id(), trigger,
  note: Type.Object(note, { additionalProperties: false }),
  piTask: Type.Object({
    name: text(256), purpose: text(), targetId: id(), trigger, onWake: text(16_384), context: strings(),
    authority: Type.Object({ allowedActions: strings(), limits: strings() }, { additionalProperties: false }),
    completionCriteria: strings(),
    resultDestination: Type.Object({ kind: choice(["delivery-result"]) }, { additionalProperties: false }),
    validity: Type.Object({ expiresAt: text(), stopConditions: strings() }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  expiresAt: Type.Optional(text()), missedRun: Type.Optional(choice(["skip", "fire-once"])),
  graceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
  retry: Type.Optional(Type.Object({ maxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
    initialDelayMs: Type.Integer({ minimum: 100, maximum: 3_600_000 }), maxDelayMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export interface NotifyToolInput {
  action: "status" | "create" | "list" | "inspect" | "pause" | "resume" | "cancel" | "notes" | "note";
  id?: string;
  kind?: "job" | "delivery" | "destination" | "note";
  limit?: number;
  offset?: number;
  job?: JobInput;
  note?: ResourceNote;
}
export const notifySchema = Type.Unsafe<NotifyToolInput>(Type.Object({
  action: choice(["status", "create", "list", "inspect", "pause", "resume", "cancel", "notes", "note"]),
  id: Type.Optional(id()), kind: Type.Optional(choice(["job", "delivery", "destination", "note"])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), offset: Type.Optional(Type.Integer({ minimum: 0 })),
  job: Type.Optional(jobSchema),
  note: Type.Optional(Type.Object({ schemaVersion: Type.Literal(1), resourceId: text(160),
    kind: choice(["service", "job", "destination", "resource"]), ...note }, { additionalProperties: false })),
}, { additionalProperties: false }));
export interface CompleteInput { deliveryId: string; status: "completed" | "failed"; result: Json }
export const completeSchema = Type.Unsafe<CompleteInput>(Type.Object({
  deliveryId: id(), status: choice(["completed", "failed"]),
  result: Type.Object({ summary: text(), evidence: Type.Array(text(), { maxItems: 32 }),
    remaining: Type.Array(text(), { maxItems: 32 }) }, { additionalProperties: false }),
}, { additionalProperties: false }));
