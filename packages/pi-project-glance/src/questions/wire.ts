import { createHash } from "node:crypto";
import { MAX_QUESTION_BYTES, type ProjectGlanceQuestionResponse } from "./model.js";

export const REQUEST_EVENT = "pi-ask-user:deferred-request-v1";
export const RESPONSE_EVENT = "pi-ask-user:deferred-response-v1";
export const CORRELATION = /^ask_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPTION = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
export const QUESTION_ID = /^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function keys(value: RecordValue, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}
const optionalText = (value: unknown, max: number): boolean => value === undefined || text(value, max);
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function list(value: unknown, max: number, check: (value: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(check) && new Set(value).size === value.length;
}
function optionIds(value: unknown): value is string[] {
  return list(value, 8, (item) => typeof item === "string" && OPTION.test(item));
}
function response(value: unknown): value is ProjectGlanceQuestionResponse {
  if (!record(value) || !keys(value, ["kind", "options"])) return false;
  if (value.kind === "text") return value.options === undefined || (Array.isArray(value.options) && value.options.length === 0);
  if (!["single", "multiple", "single_or_text", "multiple_or_text"].includes(String(value.kind)) || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 8) return false;
  const ids = new Set<string>();
  return value.options.every((option: unknown) => {
    if (!record(option) || !keys(option, ["id", "label", "description"]) || typeof option.id !== "string" || !OPTION.test(option.id) || ids.has(option.id) || !text(option.label, 160) || !optionalText(option.description, 500)) return false;
    ids.add(option.id);
    return true;
  });
}
function attachment(value: unknown): boolean {
  if (!record(value) || !text(value.label, 160)) return false;
  switch (value.kind) {
    case "file": return keys(value, ["kind", "label", "path", "external"]) && text(value.path, 1000) && (value.external === undefined || typeof value.external === "boolean");
    case "line_range": return keys(value, ["kind", "label", "path", "external", "startLine", "endLine"]) && text(value.path, 1000) && integer(value.startLine, 1, 2147483647) && integer(value.endLine, Number(value.startLine), 2147483647) && (value.external === undefined || typeof value.external === "boolean");
    case "command": case "test_run": return keys(value, ["kind", "label", "reference"]) && text(value.reference, 1000);
    case "note": return keys(value, ["kind", "label", "text"]) && text(value.text, 4000);
    case "url": {
      if (!keys(value, ["kind", "label", "url"]) || !text(value.url, 2000)) return false;
      try { new URL(value.url); return true; } catch { return false; }
    }
    default: return false;
  }
}
export interface AskRequest {
  schemaVersion: 1; correlationId: string; operation: "ask"; mode: "deferred";
  question: string; reason: string; class: "preference" | "information" | "reversible";
  response: ProjectGlanceQuestionResponse;
  recommendedOptionIds: string[]; affectedWork: string[]; continuingWork: string[]; attachments: RecordValue[];
  recommendation?: string; recommendedText?: string;
  temporaryDefault?: { optionIds: string[]; disclosure: string };
  priority?: "normal" | "high"; blockingPolicy?: "never"; deliveryMode?: "nextTurn";
}
export interface CancelRequest {
  schemaVersion: 1; correlationId: string; operation: "cancel"; mode: "deferred";
  id: string; expectedRevision: number; reason: string;
}
export type Request = AskRequest | CancelRequest;
/** Canonical order and whitespace make fingerprints independent of object key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\t/gu, " ").trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (record(value)) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, normalize(item)]));
  return value;
}
/** Independent implementation of the public deferred V1 wire schema, narrowed to non-blocking next-natural-turn delivery. */
export function parseRequest(input: unknown, options: { allowLegacyExpiresAt?: boolean } = {}): Request | undefined {
  if (!record(input) || input.schemaVersion !== 1 || input.mode !== "deferred" || typeof input.correlationId !== "string" || !CORRELATION.test(input.correlationId)) return undefined;
  if (input.signal !== undefined && (!(input.signal instanceof AbortSignal))) return undefined;
  const { signal: _signal, ...wire } = input;
  const value = wire;
  if (value.operation === "cancel") {
    if (!keys(value, ["schemaVersion", "correlationId", "operation", "mode", "id", "expectedRevision", "reason"]) || typeof value.id !== "string" || !(QUESTION_ID.test(value.id) || /^Q-[1-9][0-9]*$/u.test(value.id)) || !integer(value.expectedRevision) || !text(value.reason, 1000)) return undefined;
    return normalize(value) as CancelRequest;
  }
  if (value.operation !== "ask" || !keys(value, ["schemaVersion", "correlationId", "operation", "mode", "question", "reason", "class", "response", "recommendation", "recommendedOptionIds", "recommendedText", "temporaryDefault", "priority", "blockingPolicy", "deliveryMode", "affectedWork", "continuingWork", "attachments", ...(options.allowLegacyExpiresAt ? ["expiresAt"] : [])])) return undefined;
  if (!text(value.question, 160) || !text(value.reason, 4000) || !["preference", "information", "reversible"].includes(String(value.class)) || !response(value.response)) return undefined;
  if (!optionalText(value.recommendation, 1000) || !optionalText(value.recommendedText, 4000) || !optionIds(value.recommendedOptionIds)) return undefined;
  if (!list(value.affectedWork, 20, (item) => text(item, 240)) || !list(value.continuingWork, 20, (item) => text(item, 240)) || value.affectedWork.some((item) => value.continuingWork instanceof Array && value.continuingWork.includes(item))) return undefined;
  if (!Array.isArray(value.attachments) || value.attachments.length > 10 || !value.attachments.every(attachment)) return undefined;
  if ((value.priority !== undefined && value.priority !== "normal" && value.priority !== "high") || (value.blockingPolicy !== undefined && value.blockingPolicy !== "never") || (value.deliveryMode !== undefined && value.deliveryMode !== "nextTurn")) return undefined;
  if (value.expiresAt !== undefined && (!options.allowLegacyExpiresAt || !text(value.expiresAt, 64) || !/^\d{4}-\d{2}-\d{2}T/u.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt)))) return undefined;
  const ids = new Set(value.response.options?.map((option) => option.id));
  const single = ["single", "single_or_text"].includes(value.response.kind);
  if (!value.recommendedOptionIds.every((id) => ids.has(id)) || (single && value.recommendedOptionIds.length > 1)) return undefined;
  if (value.recommendedText !== undefined && !["text", "single_or_text", "multiple_or_text"].includes(value.response.kind)) return undefined;
  if (value.temporaryDefault !== undefined) {
    const temp = value.temporaryDefault;
    if (!record(temp) || !keys(temp, ["optionIds", "disclosure"]) || value.class !== "reversible" || value.response.kind === "text" || !optionIds(temp.optionIds) || temp.optionIds.length === 0 || !temp.optionIds.every((id) => ids.has(id)) || (single && temp.optionIds.length !== 1) || !text(temp.disclosure, 1000)) return undefined;
  }
  const normalizedSource = normalize(value) as RecordValue;
  // Legacy records remain decodable, but wall-clock expiry is intentionally discarded.
  if (options.allowLegacyExpiresAt) delete normalizedSource.expiresAt;
  const normalized = normalizedSource;
  if (Buffer.byteLength(canonical(normalized), "utf8") > MAX_QUESTION_BYTES) return undefined;
  // Revalidate normalized lists: whitespace normalization must not create duplicate or overlapping metadata.
  if (canonical(normalized) !== canonical(value) && value.expiresAt === undefined) return parseRequest(normalized, options);
  return normalized as unknown as AskRequest;
}
