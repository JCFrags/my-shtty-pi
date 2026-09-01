import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export const STATE_EVENT_PROTOCOL = "grounded-state-event/v1" as const;
export const STATE_RESULT_PROTOCOL = "grounded-state-result/v1" as const;

export type StateToolName = "notes" | "workplan";

export interface StateEvent<TAction extends string = string, TData = unknown> {
  protocol: typeof STATE_EVENT_PROTOCOL;
  tool: StateToolName;
  action: TAction;
  baseStateRevision: number;
  stateRevision: number;
  at: string;
  data: TData;
}

export interface StateToolDetails<TEvent = StateEvent, TResult = unknown> {
  protocol: typeof STATE_RESULT_PROTOCOL;
  action: string;
  event?: TEvent;
  result: TResult;
  page?: {
    cursor: number;
    limit: number;
    nextCursor?: number;
    total: number;
  };
  fullOutputPath?: string;
}

export type StateErrorCode =
  | "STATE_INVALID_INPUT"
  | "STATE_NOT_FOUND"
  | "STATE_REVISION_MISMATCH"
  | "STATE_LIMIT_EXCEEDED"
  | "STATE_INVALID_LINK"
  | "STATE_INVALID_TRANSITION"
  | "STATE_CONFLICT"
  | "STATE_EVIDENCE_REQUIRED"
  | "STATE_CORRUPT"
  | "STATE_CANCELLED";

export class StateToolError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, safeMessage: string) {
    super(`${code}: ${safeMessage}`);
    this.name = "StateToolError";
    this.code = code;
  }
}

export function stateError(code: StateErrorCode, safeMessage: string): never {
  throw new StateToolError(code, safeMessage);
}

export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) stateError("STATE_CANCELLED", "The operation was cancelled");
}

export function normalizeStateText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function requireCodePoints(value: string, maximum: number, field: string): void {
  const count = codePointLength(value);
  if (count > maximum) stateError("STATE_LIMIT_EXCEEDED", `${field} has ${count} code points; maximum is ${maximum}`);
}

export function requireUtf8(value: string, maximum: number, field: string): void {
  const count = utf8Length(value);
  if (count > maximum) stateError("STATE_LIMIT_EXCEEDED", `${field} has ${count} UTF-8 bytes; maximum is ${maximum}`);
}

export function requireNonBlank(value: string, field: string): void {
  if (!/\S/u.test(value)) stateError("STATE_INVALID_INPUT", `${field} must contain non-white-space text`);
}

export function isPlainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) valid = value.every((item) => isPlainJson(item, seen));
  else valid = Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value as Record<string, unknown>).every((item) => isPlainJson(item, seen));
  seen.delete(value);
  return valid;
}

export function requirePlainJson(value: unknown, field = "value"): void {
  if (!isPlainJson(value)) stateError("STATE_CORRUPT", `${field} is not plain JSON`);
}

export function isExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

export function requireExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  field = "object",
  code: StateErrorCode = "STATE_INVALID_INPUT",
): asserts value is Record<string, unknown> {
  if (!isExactObject(value, required, optional)) stateError(code, `${field} has an invalid shape`);
}

export function requireString(value: unknown, field: string, code: StateErrorCode = "STATE_INVALID_INPUT"): asserts value is string {
  if (typeof value !== "string") stateError(code, `${field} must be a string`);
}

export function requireStringArray(
  value: unknown,
  field: string,
  code: StateErrorCode = "STATE_INVALID_INPUT",
): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    stateError(code, `${field} must be an array of strings`);
  }
}

export function requireSafeInteger(
  value: unknown,
  field: string,
  minimum = 0,
  code: StateErrorCode = "STATE_INVALID_INPUT",
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) stateError(code, `${field} must be a safe integer of at least ${minimum}`);
}

export function requireUnique(values: readonly string[], field: string, code: StateErrorCode = "STATE_INVALID_LINK"): void {
  if (new Set(values).size !== values.length) stateError(code, `${field} contains a duplicate value`);
}

export function numericIdParts(id: string): number[] {
  const values = id.match(/\d+/g);
  return values ? values.map(Number) : [];
}

export function compareNumericIds(left: string, right: string): number {
  const a = numericIdParts(left);
  const b = numericIdParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    stateError("STATE_LIMIT_EXCEEDED", "The state revision cannot increase safely");
  }
  return current + 1;
}

export function makeStateEvent<TAction extends string, TData>(
  tool: StateToolName,
  action: TAction,
  baseStateRevision: number,
  at: string,
  data: TData,
): StateEvent<TAction, TData> {
  return {
    protocol: STATE_EVENT_PROTOCOL,
    tool,
    action,
    baseStateRevision,
    stateRevision: nextRevision(baseStateRevision),
    at,
    data,
  };
}

export function validateStateEventEnvelope(
  value: unknown,
  tool: StateToolName,
  currentRevision: number,
): asserts value is StateEvent {
  requirePlainJson(value, "event");
  requireExactObject(
    value,
    ["protocol", "tool", "action", "baseStateRevision", "stateRevision", "at", "data"],
    [],
    "event",
    "STATE_CORRUPT",
  );
  if (value.protocol !== STATE_EVENT_PROTOCOL) stateError("STATE_CORRUPT", "The event protocol is invalid");
  if (value.tool !== tool) stateError("STATE_CORRUPT", "The event tool is invalid");
  if (typeof value.action !== "string") stateError("STATE_CORRUPT", "The event action is invalid");
  requireSafeInteger(value.baseStateRevision, "baseStateRevision", 0, "STATE_CORRUPT");
  requireSafeInteger(value.stateRevision, "stateRevision", 1, "STATE_CORRUPT");
  if (value.baseStateRevision !== currentRevision) stateError("STATE_CORRUPT", "The event base state revision is not current");
  if (value.stateRevision !== currentRevision + 1) stateError("STATE_CORRUPT", "The event state revision is not next");
  if (typeof value.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at)) {
    stateError("STATE_CORRUPT", "The event time is invalid");
  }
  const timestamp = Date.parse(value.at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.at) {
    stateError("STATE_CORRUPT", "The event time is invalid");
  }
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export interface StateOutputResult {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
  shownLines: number;
  totalLines: number;
  shownBytes: number;
  totalBytes: number;
}

export async function writePrivateStateOutput(
  prefix: "grounded-notes" | "grounded-workplan",
  output: string,
  signal?: AbortSignal,
  temporaryRoot = tmpdir(),
): Promise<string> {
  cancelled(signal);
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(temporaryRoot, `${prefix}-`));
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.chmod(0o700);
    } finally {
      await directoryHandle.close();
    }
    cancelled(signal);
    const path = join(directory, "full-output.txt");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(output, "utf8");
      await file.chmod(0o600);
      cancelled(signal);
    } finally {
      await file.close();
    }
    return path;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (signal?.aborted) stateError("STATE_CANCELLED", "The operation was cancelled");
    throw error;
  }
}

export async function boundedStateOutput(
  output: string,
  prefix: "grounded-notes" | "grounded-workplan",
  signal?: AbortSignal,
  options: { maxBytes?: number; maxLines?: number; temporaryRoot?: string } = {},
): Promise<StateOutputResult> {
  cancelled(signal);
  const truncated = truncateHead(output, {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
  });
  if (!truncated.truncated) {
    return {
      text: truncated.content,
      truncated: false,
      shownLines: truncated.outputLines,
      totalLines: truncated.totalLines,
      shownBytes: truncated.outputBytes,
      totalBytes: truncated.totalBytes,
    };
  }
  const fullOutputPath = await writePrivateStateOutput(prefix, output, signal, options.temporaryRoot);
  const notice = `[Output truncated exactly: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output: ${fullOutputPath}]`;
  return {
    text: `${truncated.content}\n\n${notice}`,
    truncated: true,
    fullOutputPath,
    shownLines: truncated.outputLines,
    totalLines: truncated.totalLines,
    shownBytes: truncated.outputBytes,
    totalBytes: truncated.totalBytes,
  };
}

export function clipUtf8(value: string, maximum: number): string {
  if (utf8Length(value) <= maximum) return value;
  let result = "";
  for (const point of value) {
    if (utf8Length(`${result}${point}`) > maximum) break;
    result += point;
  }
  return result;
}
