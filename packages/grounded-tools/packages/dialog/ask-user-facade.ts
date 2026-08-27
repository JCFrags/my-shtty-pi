import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type EventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import {
  ASK_USER_BLOCKING_REQUEST_EVENT_V1,
  ASK_USER_BLOCKING_RESPONSE_EVENT_V1,
  ASK_USER_DEFERRED_REQUEST_EVENT_V1,
  ASK_USER_DEFERRED_RESPONSE_EVENT_V1,
  ASK_USER_PROVIDER_ACCEPT_TIMEOUT_MS_V1,
  type AskUserBlockingProviderRequestV1,
  type AskUserBlockingProviderResponseV1,
  type AskUserDeferredAskProviderRequestV1,
  type AskUserDeferredCancelProviderRequestV1,
  type AskUserDeferredProviderRequestV1,
  type AskUserDeferredProviderResponseV1,
  type AskUserProviderErrorV1,
  type AskUserResultV1,
  isBlockingProviderRequestV1,
  isBlockingProviderResponseV1,
  isDeferredProviderRequestV1,
  isDeferredProviderResponseV1,
} from "@grounded/pi-core/ask-user-v1";

function oneOf<const Schemas extends readonly TSchema[]>(schemas: Schemas) {
  return Type.Unsafe<Static<Schemas[number]>>({ oneOf: schemas });
}

const blockingOption = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_-]{1,32}$" }),
  label: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  preview: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
}, { additionalProperties: false });

const blockingAsk = Type.Object({
  operation: StringEnum(["ask"] as const),
  mode: StringEnum(["blocking"] as const),
  question: Type.String({ minLength: 1, maxLength: 160 }),
  explanation: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  response: Type.Object({
    kind: StringEnum(["single_or_text"] as const),
    options: Type.Array(blockingOption, { minItems: 2, maxItems: 4 }),
  }, { additionalProperties: false }),
  timeoutMs: Type.Integer({ minimum: 10_000, maximum: 86_400_000 }),
}, { additionalProperties: false });

const deferredOption = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" }),
  label: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });
const deferredTextResponse = Type.Object({
  kind: StringEnum(["text"] as const),
  options: Type.Optional(Type.Array(deferredOption, { maxItems: 0 })),
}, { additionalProperties: false });
const deferredOptionResponse = Type.Object({
  kind: StringEnum(["single", "multiple", "single_or_text", "multiple_or_text"] as const),
  options: Type.Array(deferredOption, { minItems: 2, maxItems: 8 }),
}, { additionalProperties: false });
const deferredResponse = oneOf([deferredTextResponse, deferredOptionResponse] as const);
const deferredId = oneOf([
  Type.String({ minLength: 1, maxLength: 64, pattern: "^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  Type.String({ minLength: 1, maxLength: 32, pattern: "^Q-[1-9][0-9]*$" }),
] as const);
const optionId = Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" });
const optionIds = Type.Array(optionId, { maxItems: 8, uniqueItems: true });
const workItems = Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20, uniqueItems: true });
const attachmentLabel = Type.String({ minLength: 1, maxLength: 160 });
const attachment = oneOf([
  Type.Object({ kind: StringEnum(["file"] as const), label: attachmentLabel, path: Type.String({ minLength: 1, maxLength: 1000 }), external: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ kind: StringEnum(["line_range"] as const), label: attachmentLabel, path: Type.String({ minLength: 1, maxLength: 1000 }), startLine: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }), endLine: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }), external: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ kind: StringEnum(["test_run", "command"] as const), label: attachmentLabel, reference: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
  Type.Object({ kind: StringEnum(["url"] as const), label: attachmentLabel, url: Type.String({ minLength: 1, maxLength: 2000, format: "uri" }) }, { additionalProperties: false }),
  Type.Object({ kind: StringEnum(["note"] as const), label: attachmentLabel, text: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
] as const);

const deferredAsk = Type.Object({
  operation: StringEnum(["ask"] as const),
  mode: StringEnum(["deferred"] as const),
  question: Type.String({ minLength: 1, maxLength: 160 }),
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
  class: StringEnum(["preference", "information", "reversible", "authorization"] as const),
  response: deferredResponse,
  recommendation: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  recommendedOptionIds: Type.Optional(optionIds),
  recommendedText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  temporaryDefault: Type.Optional(Type.Object({
    optionIds: Type.Array(optionId, { minItems: 1, maxItems: 8, uniqueItems: true }),
    disclosure: Type.String({ minLength: 1, maxLength: 1000 }),
  }, { additionalProperties: false })),
  priority: Type.Optional(StringEnum(["normal", "high"] as const)),
  escalationPolicy: Type.Optional(StringEnum(["never", "when_agent_settles"] as const)),
  deliveryMode: Type.Optional(StringEnum(["steer", "followUp", "nextTurn"] as const)),
  affectedWork: Type.Optional(workItems),
  continuingWork: Type.Optional(workItems),
  attachments: Type.Optional(Type.Array(attachment, { maxItems: 10 })),
  expiresAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64, format: "date-time" })),
}, { additionalProperties: false });

const deferredCancel = Type.Object({
  operation: StringEnum(["cancel"] as const),
  mode: StringEnum(["deferred"] as const),
  id: deferredId,
  expectedRevision: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });

export const ASK_USER_PARAMETERS_V1 = oneOf([blockingAsk, deferredAsk, deferredCancel] as const);
export type AskUserToolInputV1 = Static<typeof ASK_USER_PARAMETERS_V1>;

export interface GroundedDialogSettingsV1 {
  readonly askUserV1?: boolean;
}

export function groundedDialogSettingsPath(): string {
  return join(getAgentDir(), "grounded-dialog.json");
}

export function loadAskUserV1Enabled(path?: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path ?? groundedDialogSettingsPath(), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as GroundedDialogSettingsV1).askUserV1 === true;
  } catch {
    return false;
  }
}

export function registerAskUserFacadeV1(pi: ExtensionAPI): void {
  const correlations = new Map<string, { readonly fingerprint: string; readonly correlationId: string }>();
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask one strict version-1 question in explicit blocking mode, or create or cancel one deferred Signals question. The selected provider must be present and healthy.",
    promptSnippet: "Ask a user question through an explicit blocking or deferred provider",
    promptGuidelines: [
      "Use ask_user with mode=blocking only when work cannot safely continue without the answer.",
      "Use ask_user with mode=deferred only when useful independent work can continue.",
      "Never change ask_user mode automatically.",
    ],
    parameters: ASK_USER_PARAMETERS_V1,
    executionMode: "sequential",
    async execute(toolCallId, input, signal) {
      const fingerprint = stableFingerprint(input);
      const prior = correlations.get(toolCallId);
      if (prior !== undefined && prior.fingerprint !== fingerprint) {
        throw providerError({
          code: "ASK_USER_CORRELATION_CONFLICT",
          message: "The ask_user tool call ID was reused with different request content.",
          retryable: false,
        });
      }
      const correlationId = prior?.correlationId ?? `ask_${randomUUID()}`;
      if (prior === undefined) correlations.set(toolCallId, { fingerprint, correlationId });
      const request = buildProviderRequest(input, correlationId, signal);
      const result = request.mode === "blocking"
        ? normalizeBlocking(await dispatchBlocking(pi.events, request), request)
        : normalizeDeferred(await dispatchDeferred(pi.events, request), request);
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: result,
      };
    },
  });
}

function buildProviderRequest(input: AskUserToolInputV1, correlationId: string, signal: AbortSignal | undefined): AskUserBlockingProviderRequestV1 | AskUserDeferredProviderRequestV1 {
  if (input.mode === "blocking") {
    const request: AskUserBlockingProviderRequestV1 = {
      schemaVersion: 1,
      correlationId,
      operation: "ask",
      mode: "blocking",
      question: input.question,
      ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
      response: input.response,
      timeoutMs: input.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
    if (!isBlockingProviderRequestV1(request)) throw invalidInput();
    return request;
  }
  if (input.operation === "cancel") {
    const request: AskUserDeferredCancelProviderRequestV1 = {
      schemaVersion: 1,
      correlationId,
      operation: "cancel",
      mode: "deferred",
      id: input.id,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      ...(signal === undefined ? {} : { signal }),
    };
    if (!isDeferredProviderRequestV1(request)) throw invalidInput();
    return request;
  }
  const request: AskUserDeferredAskProviderRequestV1 = {
    schemaVersion: 1,
    correlationId,
    operation: "ask",
    mode: "deferred",
    question: input.question,
    reason: input.reason,
    class: input.class,
    response: input.response as AskUserDeferredAskProviderRequestV1["response"],
    ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
    recommendedOptionIds: input.recommendedOptionIds ?? [],
    ...(input.recommendedText === undefined ? {} : { recommendedText: input.recommendedText }),
    ...(input.temporaryDefault === undefined ? {} : { temporaryDefault: input.temporaryDefault }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.escalationPolicy === undefined ? {} : { blockingPolicy: input.escalationPolicy }),
    ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
    affectedWork: input.affectedWork ?? [],
    continuingWork: input.continuingWork ?? [],
    attachments: input.attachments ?? [],
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(signal === undefined ? {} : { signal }),
  };
  if (!isDeferredProviderRequestV1(request)) throw invalidInput();
  return request;
}

function dispatchBlocking(bus: EventBus, request: AskUserBlockingProviderRequestV1): Promise<AskUserBlockingProviderResponseV1> {
  return dispatchProvider(bus, ASK_USER_BLOCKING_REQUEST_EVENT_V1, ASK_USER_BLOCKING_RESPONSE_EVENT_V1, request, isBlockingProviderResponseV1, true);
}

function dispatchDeferred(bus: EventBus, request: AskUserDeferredProviderRequestV1): Promise<AskUserDeferredProviderResponseV1> {
  return dispatchProvider(bus, ASK_USER_DEFERRED_REQUEST_EVENT_V1, ASK_USER_DEFERRED_RESPONSE_EVENT_V1, request, isDeferredProviderResponseV1, false);
}

function dispatchProvider<Response extends AskUserBlockingProviderResponseV1 | AskUserDeferredProviderResponseV1>(
  bus: EventBus,
  requestEvent: string,
  responseEvent: string,
  request: AskUserBlockingProviderRequestV1 | AskUserDeferredProviderRequestV1,
  guard: (value: unknown) => value is Response,
  needsOpen: boolean,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let accepted = false;
    let open = false;
    let settled = false;
    let remove = () => {};
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      remove();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(providerError({
      code: "ASK_USER_PROVIDER_UNAVAILABLE",
      message: `No ${request.mode} ask_user provider accepted the version-1 request.`,
      retryable: true,
    }))), ASK_USER_PROVIDER_ACCEPT_TIMEOUT_MS_V1);
    remove = bus.on(responseEvent, (value) => {
      if (!isRecord(value) || value.correlationId !== request.correlationId) return;
      if (!guard(value)) {
        finish(() => reject(providerError({ code: "ASK_USER_PROVIDER_UNHEALTHY", message: "The ask_user provider emitted an invalid version-1 response.", retryable: false })));
        return;
      }
      if (value.state === "rejected") {
        const rejected = value as unknown as Extract<Response, { state: "rejected" }>;
        finish(() => reject(providerError(rejected.error)));
        return;
      }
      if (value.state === "accepted") {
        accepted = true;
        clearTimeout(timer);
        return;
      }
      if (value.state === "open") {
        if (!accepted || !needsOpen) {
          finish(() => reject(unhealthyLifecycle()));
          return;
        }
        open = true;
        return;
      }
      if (!accepted || (needsOpen && !open)) {
        finish(() => reject(unhealthyLifecycle()));
        return;
      }
      finish(() => resolve(value));
    });
    try {
      bus.emit(requestEvent, request);
    } catch {
      finish(() => reject(providerError({ code: "ASK_USER_PROVIDER_UNHEALTHY", message: "The ask_user provider failed while accepting the request.", retryable: true })));
    }
  });
}

function normalizeBlocking(
  response: AskUserBlockingProviderResponseV1,
  request: AskUserBlockingProviderRequestV1,
): AskUserResultV1 {
  const base = { schemaVersion: 1 as const, operation: "ask" as const, mode: "blocking" as const, correlationId: response.correlationId };
  if (response.state === "answered") {
    if (response.answer.kind === "option") {
      const optionId = response.answer.optionId;
      if (!request.response.options.some((option) => option.id === optionId)) throw unhealthyLifecycle();
    }
    return { ...base, status: "answered", answer: response.answer };
  }
  if (response.state === "cancelled") return { ...base, status: "cancelled", reason: response.reason };
  if (response.state === "timed_out") return { ...base, status: "timed_out" };
  throw unhealthyLifecycle();
}

function normalizeDeferred(
  response: AskUserDeferredProviderResponseV1,
  request: AskUserDeferredProviderRequestV1,
): AskUserResultV1 {
  if (response.state === "queued" && request.operation === "ask") return { schemaVersion: 1, operation: "ask", mode: "deferred", correlationId: response.correlationId, status: "queued", questionId: response.questionId, displayId: response.displayId, revision: response.revision };
  if (response.state === "cancelled" && request.operation === "cancel") return { schemaVersion: 1, operation: "cancel", mode: "deferred", correlationId: response.correlationId, status: "cancelled", questionId: response.questionId, displayId: response.displayId, revision: response.revision };
  throw unhealthyLifecycle();
}

function resultText(result: AskUserResultV1): string {
  if (result.mode === "blocking") {
    if (result.status === "answered") return result.answer.kind === "option" ? `User selected option ${result.answer.optionId}.` : `User answered: ${result.answer.text}`;
    if (result.status === "timed_out") return "The blocking question timed out.";
    return `The blocking question was cancelled (${result.reason}).`;
  }
  return result.status === "queued"
    ? `Queued ${result.displayId} revision ${result.revision}. Continue only independent work; do not assume an answer.`
    : `Cancelled ${result.displayId} revision ${result.revision}.`;
}

function invalidInput(): Error {
  return providerError({ code: "ASK_USER_INVALID_REQUEST", message: "ask_user input failed version-1 semantic validation.", retryable: false });
}

function unhealthyLifecycle(): Error {
  return providerError({ code: "ASK_USER_PROVIDER_UNHEALTHY", message: "The ask_user provider emitted an invalid lifecycle transition.", retryable: false });
}

function providerError(error: AskUserProviderErrorV1): Error {
  return new Error(`ask_user failed (${error.code}): ${error.message}`);
}

function stableFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFingerprint(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
