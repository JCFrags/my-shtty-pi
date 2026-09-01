export const ASK_USER_BLOCKING_REQUEST_EVENT_V1 = "pi-ask-user:blocking-request-v1";
export const ASK_USER_BLOCKING_RESPONSE_EVENT_V1 = "pi-ask-user:blocking-response-v1";
export const ASK_USER_DEFERRED_REQUEST_EVENT_V1 = "pi-ask-user:deferred-request-v1";
export const ASK_USER_DEFERRED_RESPONSE_EVENT_V1 = "pi-ask-user:deferred-response-v1";

export const ASK_USER_CORRELATION_PATTERN_V1 = /^ask_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const ASK_USER_BLOCKING_OPTION_ID_PATTERN_V1 = /^[A-Za-z0-9_-]{1,32}$/u;
export const ASK_USER_DEFERRED_OPTION_ID_PATTERN_V1 = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
export const ASK_USER_DEFERRED_QUESTION_ID_PATTERN_V1 = /^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const ASK_USER_DEFERRED_DISPLAY_ID_PATTERN_V1 = /^Q-[1-9][0-9]*$/u;
export const ASK_USER_PROVIDER_ACCEPT_TIMEOUT_MS_V1 = 250;

export interface AskUserBlockingOptionV1 {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
}

export interface AskUserDeferredOptionV1 {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface AskUserDeferredTextResponseV1 {
  readonly kind: "text";
  readonly options?: readonly [];
}

export interface AskUserDeferredOptionResponseV1 {
  readonly kind: "single" | "multiple" | "single_or_text" | "multiple_or_text";
  readonly options: readonly AskUserDeferredOptionV1[];
}

export type AskUserDeferredResponseSpecV1 =
  | AskUserDeferredTextResponseV1
  | AskUserDeferredOptionResponseV1;

export interface AskUserTemporaryDefaultV1 {
  readonly optionIds: readonly string[];
  readonly disclosure: string;
}

export type AskUserAttachmentV1 =
  | { readonly kind: "file"; readonly label: string; readonly path: string; readonly external?: boolean }
  | {
      readonly kind: "line_range";
      readonly label: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly external?: boolean;
    }
  | { readonly kind: "test_run" | "command"; readonly label: string; readonly reference: string }
  | { readonly kind: "url"; readonly label: string; readonly url: string }
  | { readonly kind: "note"; readonly label: string; readonly text: string };

interface AskUserProviderRequestBaseV1 {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface AskUserBlockingProviderRequestV1 extends AskUserProviderRequestBaseV1 {
  readonly operation: "ask";
  readonly mode: "blocking";
  readonly question: string;
  readonly explanation?: string;
  readonly response: {
    readonly kind: "single_or_text";
    readonly options: readonly AskUserBlockingOptionV1[];
  };
  readonly timeoutMs: number;
}

export interface AskUserDeferredAskProviderRequestV1 extends AskUserProviderRequestBaseV1 {
  readonly operation: "ask";
  readonly mode: "deferred";
  readonly question: string;
  readonly reason: string;
  readonly class: "preference" | "information" | "reversible" | "authorization";
  readonly response: AskUserDeferredResponseSpecV1;
  readonly recommendation?: string;
  readonly recommendedOptionIds: readonly string[];
  readonly recommendedText?: string;
  readonly temporaryDefault?: AskUserTemporaryDefaultV1;
  readonly priority?: "normal" | "high";
  readonly blockingPolicy?: "never" | "when_agent_settles";
  readonly deliveryMode?: "steer" | "followUp" | "nextTurn";
  readonly affectedWork: readonly string[];
  readonly continuingWork: readonly string[];
  readonly attachments: readonly AskUserAttachmentV1[];
  readonly expiresAt?: string;
}

export interface AskUserDeferredCancelProviderRequestV1 extends AskUserProviderRequestBaseV1 {
  readonly operation: "cancel";
  readonly mode: "deferred";
  readonly id: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export type AskUserDeferredProviderRequestV1 =
  | AskUserDeferredAskProviderRequestV1
  | AskUserDeferredCancelProviderRequestV1;

export type AskUserProviderErrorCodeV1 =
  | "ASK_USER_INVALID_REQUEST"
  | "ASK_USER_CORRELATION_CONFLICT"
  | "ASK_USER_PROVIDER_UNAVAILABLE"
  | "ASK_USER_PROVIDER_UNHEALTHY"
  | "ASK_USER_PROVIDER_FAILURE";

export interface AskUserProviderErrorV1 {
  readonly code: AskUserProviderErrorCodeV1;
  readonly message: string;
  readonly retryable: boolean;
}

interface AskUserBlockingProviderResponseBaseV1 {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly mode: "blocking";
}

export type AskUserBlockingProviderResponseV1 =
  | (AskUserBlockingProviderResponseBaseV1 & { readonly state: "accepted" | "open" })
  | (AskUserBlockingProviderResponseBaseV1 & {
      readonly state: "answered";
      readonly answer:
        | { readonly kind: "option"; readonly optionId: string }
        | { readonly kind: "text"; readonly text: string };
    })
  | (AskUserBlockingProviderResponseBaseV1 & {
      readonly state: "cancelled";
      readonly reason: "user" | "abort" | "shutdown" | "reload" | "provider_failure";
    })
  | (AskUserBlockingProviderResponseBaseV1 & { readonly state: "timed_out" })
  | (AskUserBlockingProviderResponseBaseV1 & {
      readonly state: "rejected";
      readonly error: AskUserProviderErrorV1;
    });

interface AskUserDeferredProviderResponseBaseV1 {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly mode: "deferred";
}

export type AskUserDeferredProviderResponseV1 =
  | (AskUserDeferredProviderResponseBaseV1 & { readonly state: "accepted" })
  | (AskUserDeferredProviderResponseBaseV1 & {
      readonly state: "queued";
      readonly operation: "ask";
      readonly questionId: string;
      readonly displayId: string;
      readonly revision: number;
    })
  | (AskUserDeferredProviderResponseBaseV1 & {
      readonly state: "cancelled";
      readonly operation: "cancel";
      readonly questionId: string;
      readonly displayId: string;
      readonly revision: number;
    })
  | (AskUserDeferredProviderResponseBaseV1 & {
      readonly state: "rejected";
      readonly error: AskUserProviderErrorV1;
    });

export type AskUserBlockingResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly operation: "ask";
      readonly mode: "blocking";
      readonly correlationId: string;
      readonly status: "answered";
      readonly answer:
        | { readonly kind: "option"; readonly optionId: string }
        | { readonly kind: "text"; readonly text: string };
    }
  | {
      readonly schemaVersion: 1;
      readonly operation: "ask";
      readonly mode: "blocking";
      readonly correlationId: string;
      readonly status: "cancelled";
      readonly reason: "user" | "abort" | "shutdown" | "reload" | "provider_failure";
    }
  | {
      readonly schemaVersion: 1;
      readonly operation: "ask";
      readonly mode: "blocking";
      readonly correlationId: string;
      readonly status: "timed_out";
    };

export type AskUserDeferredResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly operation: "ask";
      readonly mode: "deferred";
      readonly correlationId: string;
      readonly status: "queued";
      readonly questionId: string;
      readonly displayId: string;
      readonly revision: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly operation: "cancel";
      readonly mode: "deferred";
      readonly correlationId: string;
      readonly status: "cancelled";
      readonly questionId: string;
      readonly displayId: string;
      readonly revision: number;
    };

export type AskUserResultV1 = AskUserBlockingResultV1 | AskUserDeferredResultV1;

export function isBlockingProviderRequestV1(value: unknown): value is AskUserBlockingProviderRequestV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "correlationId", "operation", "mode", "question", "explanation", "response", "timeoutMs", "signal"])) return false;
  if (value.schemaVersion !== 1 || value.operation !== "ask" || value.mode !== "blocking") return false;
  if (!validCorrelation(value.correlationId) || !nonEmpty(value.question, 160)) return false;
  if (value.explanation !== undefined && !nonEmpty(value.explanation, 4000)) return false;
  if (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 10_000 || (value.timeoutMs as number) > 86_400_000) return false;
  if (value.signal !== undefined && !isAbortSignal(value.signal)) return false;
  if (!isRecord(value.response) || !hasExactKeys(value.response, ["kind", "options"]) || value.response.kind !== "single_or_text" || !Array.isArray(value.response.options)) return false;
  return validOptions(value.response.options, ASK_USER_BLOCKING_OPTION_ID_PATTERN_V1, 4, true);
}

export function isDeferredProviderRequestV1(value: unknown): value is AskUserDeferredProviderRequestV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== "deferred" || !validCorrelation(value.correlationId)) return false;
  if (value.signal !== undefined && !isAbortSignal(value.signal)) return false;
  if (value.operation === "cancel") {
    return hasExactKeys(value, ["schemaVersion", "correlationId", "operation", "mode", "id", "expectedRevision", "reason", "signal"])
      && typeof value.id === "string"
      && (ASK_USER_DEFERRED_QUESTION_ID_PATTERN_V1.test(value.id) || ASK_USER_DEFERRED_DISPLAY_ID_PATTERN_V1.test(value.id))
      && Number.isInteger(value.expectedRevision)
      && (value.expectedRevision as number) >= 1
      && nonEmpty(value.reason, 1000);
  }
  if (value.operation !== "ask" || !hasExactKeys(value, ["schemaVersion", "correlationId", "operation", "mode", "question", "reason", "class", "response", "recommendation", "recommendedOptionIds", "recommendedText", "temporaryDefault", "priority", "blockingPolicy", "deliveryMode", "affectedWork", "continuingWork", "attachments", "expiresAt", "signal"])) return false;
  if (!nonEmpty(value.question, 160) || !nonEmpty(value.reason, 4000)) return false;
  if (!["preference", "information", "reversible", "authorization"].includes(value.class as string)) return false;
  if (!validDeferredResponse(value.response)) return false;
  if (!validOptionalText(value.recommendation, 1000) || !validOptionalText(value.recommendedText, 4000)) return false;
  if (!validIdList(value.recommendedOptionIds, 8) || !validWorkList(value.affectedWork) || !validWorkList(value.continuingWork)) return false;
  if (value.priority !== undefined && value.priority !== "normal" && value.priority !== "high") return false;
  if (value.blockingPolicy !== undefined && value.blockingPolicy !== "never" && value.blockingPolicy !== "when_agent_settles") return false;
  if (value.deliveryMode !== undefined && value.deliveryMode !== "steer" && value.deliveryMode !== "followUp" && value.deliveryMode !== "nextTurn") return false;
  if (value.expiresAt !== undefined && !nonEmpty(value.expiresAt, 64)) return false;
  if (!Array.isArray(value.attachments) || value.attachments.length > 10 || !value.attachments.every(validAttachment)) return false;
  if (!disjoint(value.affectedWork as readonly string[], value.continuingWork as readonly string[])) return false;
  const optionOrder = deferredOptionOrder(value.response);
  if (!(value.recommendedOptionIds as readonly string[]).every((id) => optionOrder.has(id))) return false;
  if ((value.response as { kind: string }).kind === "single" || (value.response as { kind: string }).kind === "single_or_text") {
    if ((value.recommendedOptionIds as readonly string[]).length > 1) return false;
  }
  const allowsText = ["text", "single_or_text", "multiple_or_text"].includes((value.response as { kind: string }).kind);
  if (value.recommendedText !== undefined && !allowsText) return false;
  if (value.expiresAt !== undefined && (!Number.isFinite(Date.parse(value.expiresAt as string)) || Date.parse(value.expiresAt as string) <= Date.now())) return false;
  if (value.temporaryDefault === undefined) return true;
  if (!validTemporaryDefault(value.temporaryDefault) || value.class !== "reversible" || (value.response as { kind: string }).kind === "text") return false;
  const temporaryIds = (value.temporaryDefault as { optionIds: readonly string[] }).optionIds;
  if (!temporaryIds.every((id) => optionOrder.has(id))) return false;
  return !(["single", "single_or_text"].includes((value.response as { kind: string }).kind)) || temporaryIds.length === 1;
}

export function isBlockingProviderResponseV1(value: unknown): value is AskUserBlockingProviderResponseV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== "blocking" || !validCorrelation(value.correlationId) || typeof value.state !== "string") return false;
  if (value.state === "accepted" || value.state === "open" || value.state === "timed_out") return hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state"]);
  if (value.state === "cancelled") return hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state", "reason"])
    && ["user", "abort", "shutdown", "reload", "provider_failure"].includes(value.reason as string);
  if (value.state === "rejected") return hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state", "error"]) && validError(value.error);
  if (value.state !== "answered" || !hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state", "answer"]) || !isRecord(value.answer)) return false;
  return value.answer.kind === "option"
    ? hasExactKeys(value.answer, ["kind", "optionId"]) && ASK_USER_BLOCKING_OPTION_ID_PATTERN_V1.test(value.answer.optionId as string)
    : value.answer.kind === "text" && hasExactKeys(value.answer, ["kind", "text"]) && nonEmpty(value.answer.text, 4000);
}

export function isDeferredProviderResponseV1(value: unknown): value is AskUserDeferredProviderResponseV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== "deferred" || !validCorrelation(value.correlationId) || typeof value.state !== "string") return false;
  if (value.state === "accepted") return hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state"]);
  if (value.state === "rejected") return hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state", "error"]) && validError(value.error);
  if (value.state !== "queued" && value.state !== "cancelled") return false;
  return hasExactKeys(value, ["schemaVersion", "correlationId", "mode", "state", "operation", "questionId", "displayId", "revision"])
    && value.operation === (value.state === "queued" ? "ask" : "cancel")
    && typeof value.questionId === "string"
    && ASK_USER_DEFERRED_QUESTION_ID_PATTERN_V1.test(value.questionId)
    && typeof value.displayId === "string"
    && ASK_USER_DEFERRED_DISPLAY_ID_PATTERN_V1.test(value.displayId)
    && Number.isInteger(value.revision)
    && (value.revision as number) >= 1;
}

export function blockingRequestFingerprintV1(request: AskUserBlockingProviderRequestV1): string {
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    correlationId: request.correlationId,
    operation: request.operation,
    mode: request.mode,
    question: request.question,
    ...(request.explanation === undefined ? {} : { explanation: request.explanation }),
    response: request.response,
    timeoutMs: request.timeoutMs,
  });
}

function validDeferredResponse(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "options"]) || typeof value.kind !== "string") return false;
  if (value.kind === "text") return value.options === undefined || (Array.isArray(value.options) && value.options.length === 0);
  if (!["single", "multiple", "single_or_text", "multiple_or_text"].includes(value.kind) || !Array.isArray(value.options)) return false;
  return validOptions(value.options, ASK_USER_DEFERRED_OPTION_ID_PATTERN_V1, 8, false);
}

function validOptions(options: readonly unknown[], pattern: RegExp, maximum: number, preview: boolean): boolean {
  if (options.length < 2 || options.length > maximum) return false;
  const ids = new Set<string>();
  for (const option of options) {
    const allowed = preview ? ["id", "label", "description", "preview"] : ["id", "label", "description"];
    if (!isRecord(option) || !hasExactKeys(option, allowed) || typeof option.id !== "string" || !pattern.test(option.id) || ids.has(option.id)) return false;
    if (!nonEmpty(option.label, 160) || !validOptionalText(option.description, 500)) return false;
    if (preview && !validOptionalText(option.preview, 20_000)) return false;
    ids.add(option.id);
  }
  return true;
}

function validIdList(value: unknown, maximum: number): boolean {
  return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && ASK_USER_DEFERRED_OPTION_ID_PATTERN_V1.test(item));
}

function validWorkList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 20 && new Set(value).size === value.length
    && value.every((item) => nonEmpty(item, 240));
}

function validTemporaryDefault(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["optionIds", "disclosure"])
    && Array.isArray(value.optionIds) && value.optionIds.length >= 1 && validIdList(value.optionIds, 8)
    && nonEmpty(value.disclosure, 1000);
}

function validAttachment(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string" || !nonEmpty(value.label, 160)) return false;
  if (value.kind === "file") {
    return hasExactKeys(value, ["kind", "label", "path", "external"])
      && nonEmpty(value.path, 1000)
      && (value.external === undefined || typeof value.external === "boolean");
  }
  if (value.kind === "line_range") {
    return hasExactKeys(value, ["kind", "label", "path", "startLine", "endLine", "external"])
      && nonEmpty(value.path, 1000)
      && Number.isInteger(value.startLine) && (value.startLine as number) >= 1
      && Number.isInteger(value.endLine) && (value.endLine as number) >= (value.startLine as number)
      && (value.external === undefined || typeof value.external === "boolean");
  }
  if (value.kind === "test_run" || value.kind === "command") {
    return hasExactKeys(value, ["kind", "label", "reference"]) && nonEmpty(value.reference, 1000);
  }
  if (value.kind === "url") {
    if (!hasExactKeys(value, ["kind", "label", "url"]) || !nonEmpty(value.url, 2000)) return false;
    try { new URL(value.url); return true; } catch { return false; }
  }
  return value.kind === "note"
    && hasExactKeys(value, ["kind", "label", "text"])
    && nonEmpty(value.text, 4000);
}

function deferredOptionOrder(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.options)) return new Set();
  return new Set(value.options.flatMap((option) => isRecord(option) && typeof option.id === "string" ? [option.id] : []));
}

function disjoint(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.every((item) => !values.has(item));
}

function validError(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["code", "message", "retryable"])
    && ["ASK_USER_INVALID_REQUEST", "ASK_USER_CORRELATION_CONFLICT", "ASK_USER_PROVIDER_UNAVAILABLE", "ASK_USER_PROVIDER_UNHEALTHY", "ASK_USER_PROVIDER_FAILURE"].includes(value.code as string)
    && nonEmpty(value.message, 1000) && typeof value.retryable === "boolean";
}

function validCorrelation(value: unknown): value is string {
  return typeof value === "string" && ASK_USER_CORRELATION_PATTERN_V1.test(value);
}

function validOptionalText(value: unknown, maximum: number): boolean {
  return value === undefined || nonEmpty(value, maximum);
}

function nonEmpty(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim().length > 0;
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}
