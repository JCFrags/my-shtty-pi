import { Type } from "typebox";
import { CHECK_IDS } from "./audits.ts";
import { TOPICS } from "./types.ts";
const enumeration = (values: readonly string[]) => Type.Union(values.map(value => Type.Literal(value)));
const page = { offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) };
const view = Type.Optional(enumeration(["summary", "detailed"]));
export const Parameters = Type.Union([
  Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("inspect"), topics: Type.Array(enumeration(TOPICS), { minItems: 1, maxItems: TOPICS.length, uniqueItems: true }), view, ...page }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list_checks"), ...page }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("audit"), checkIds: Type.Array(enumeration(CHECK_IDS), { minItems: 1, maxItems: CHECK_IDS.length, uniqueItems: true }), view, ...page }, { additionalProperties: false }),
]);
const FieldSchema = Type.Object({ id: Type.String(), value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), unit: Type.String(), basis: enumeration(["reported", "estimated", "component-attested", "unknown"]), note: Type.Optional(Type.String()) });
export const Output = Type.Object({
  schemaVersion: Type.Literal(1), kind: enumeration(["report", "checks"]), reportId: Type.String(), startedAt: Type.String(), endedAt: Type.String(), scope: Type.Literal("current Pi process/session"),
  requestedTopics: Type.Array(enumeration(TOPICS)), requestedChecks: Type.Array(Type.String()),
  providers: Type.Array(Type.Object({ provider: Type.String(), observedAt: Type.String(), source: Type.String(), scope: Type.String(), availability: enumeration(["available", "partial", "unavailable"]), errorCode: Type.Optional(Type.String()), fields: Type.Array(FieldSchema), limits: Type.Array(Type.String()) })),
  findings: Type.Array(Type.Object({ checkId: Type.String(), outcome: enumeration(["pass", "warn", "fail", "unknown", "skipped"]), severity: enumeration(["info", "warning", "error"]), explanation: Type.String(), evidence: Type.Array(Type.String()), nextInspection: Type.String() })),
  checks: Type.Array(Type.Object({ id: Type.String(), purpose: Type.String(), topics: Type.Array(enumeration(TOPICS)), evidenceNeeds: Type.Array(Type.String()), limits: Type.String() })),
  complete: Type.Boolean(), page: Type.Object({ offset: Type.Integer(), limit: Type.Integer(), total: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), truncated: Type.Boolean() }), limits: Type.Array(Type.String()),
});
