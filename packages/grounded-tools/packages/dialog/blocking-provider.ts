import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_BLOCKING_REQUEST_EVENT_V1,
  ASK_USER_BLOCKING_RESPONSE_EVENT_V1,
  blockingRequestFingerprintV1,
  type AskUserBlockingProviderRequestV1,
  type AskUserBlockingProviderResponseV1,
  type AskUserProviderErrorV1,
  isBlockingProviderRequestV1,
} from "@grounded/pi-core/ask-user-v1";

interface ActiveRecord {
  readonly fingerprint: string;
  readonly request: AskUserBlockingProviderRequestV1;
  readonly controller: AbortController;
  terminal?: AskUserBlockingProviderResponseV1;
  herdrActive: boolean;
  removeAbort: (() => void) | undefined;
  cancelTimer: (() => void) | undefined;
}

export interface BlockingProviderRuntimeOptions {
  readonly scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
}

type BlockingResponsePayload = AskUserBlockingProviderResponseV1 extends infer Response
  ? Response extends AskUserBlockingProviderResponseV1
    ? Omit<Response, "schemaVersion" | "correlationId" | "mode">
    : never
  : never;

interface BlockingUiAnswer {
  readonly kind: "option" | "text";
  readonly value: string;
}

export function registerBlockingProviderV1(
  pi: ExtensionAPI,
  options: BlockingProviderRuntimeOptions = {},
): void {
  const scheduleTimeout = options.scheduleTimeout ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  });
  const records = new Map<string, ActiveRecord>();
  let context: ExtensionContext | undefined;
  let closed = false;

  const emit = (response: AskUserBlockingProviderResponseV1) => {
    pi.events.emit(ASK_USER_BLOCKING_RESPONSE_EVENT_V1, response);
  };

  const response = (
    request: AskUserBlockingProviderRequestV1,
    value: BlockingResponsePayload,
  ): AskUserBlockingProviderResponseV1 => ({
    schemaVersion: 1,
    correlationId: request.correlationId,
    mode: "blocking",
    ...value,
  } as AskUserBlockingProviderResponseV1);

  const complete = (record: ActiveRecord, terminal: AskUserBlockingProviderResponseV1) => {
    if (record.terminal) return;
    record.terminal = terminal;
    record.cancelTimer?.();
    record.cancelTimer = undefined;
    record.removeAbort?.();
    record.removeAbort = undefined;
    if (record.herdrActive) {
      record.herdrActive = false;
      pi.events.emit("herdr:blocked", { active: false });
    }
    emit(terminal);
  };

  const abortRecord = (record: ActiveRecord, reason: "abort" | "shutdown" | "reload") => {
    complete(record, response(record.request, { state: "cancelled", reason }));
    record.controller.abort();
  };

  const attachAbort = (record: ActiveRecord, signal: AbortSignal | undefined) => {
    if (signal === undefined || record.terminal) return;
    const abort = () => abortRecord(record, "abort");
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    const previous = record.removeAbort;
    record.removeAbort = () => {
      previous?.();
      signal.removeEventListener("abort", abort);
    };
  };

  const run = async (record: ActiveRecord, ctx: ExtensionContext) => {
    try {
      const answer = await askBlockingUi(record.request, ctx, record.controller.signal);
      if (record.terminal) return;
      if (answer === null) {
        complete(record, response(record.request, { state: "cancelled", reason: "user" }));
      } else if (answer.kind === "option") {
        complete(record, response(record.request, { state: "answered", answer: { kind: "option", optionId: answer.value } }));
      } else {
        complete(record, response(record.request, { state: "answered", answer: { kind: "text", text: answer.value } }));
      }
    } catch {
      complete(record, response(record.request, { state: "cancelled", reason: "provider_failure" }));
    }
  };

  const removeRequestListener = pi.events.on(ASK_USER_BLOCKING_REQUEST_EVENT_V1, (value) => {
    const correlationId = extractCorrelation(value);
    if (!isBlockingProviderRequestV1(value)) {
      if (correlationId !== undefined) emitRejected(correlationId, invalidRequest(), emit);
      return;
    }
    const request = value;
    const fingerprint = blockingRequestFingerprintV1(request);
    const current = records.get(request.correlationId);
    if (current) {
      if (current.fingerprint !== fingerprint) {
        emitRejected(request.correlationId, {
          code: "ASK_USER_CORRELATION_CONFLICT",
          message: "The blocking provider correlation ID was reused with different request content.",
          retryable: false,
        }, emit);
        return;
      }
      emit(response(request, { state: "accepted" }));
      emit(response(request, { state: "open" }));
      if (current.terminal) emit(current.terminal);
      else attachAbort(current, request.signal);
      return;
    }
    if (closed || context === undefined || !context.hasUI) {
      emitRejected(request.correlationId, {
        code: "ASK_USER_PROVIDER_UNAVAILABLE",
        message: "The blocking Dialog provider has no active interactive Pi context.",
        retryable: true,
      }, emit);
      return;
    }

    const record: ActiveRecord = {
      fingerprint,
      request,
      controller: new AbortController(),
      herdrActive: false,
      removeAbort: undefined,
      cancelTimer: undefined,
    };
    records.set(request.correlationId, record);
    emit(response(request, { state: "accepted" }));
    record.herdrActive = true;
    pi.events.emit("herdr:blocked", { active: true, label: "Waiting for your answer" });
    emit(response(request, { state: "open" }));
    record.cancelTimer = scheduleTimeout(() => {
      complete(record, response(request, { state: "timed_out" }));
      record.controller.abort();
    }, request.timeoutMs);
    attachAbort(record, request.signal);
    if (!record.terminal) void run(record, context);
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    closed = false;
    records.clear();
  });

  pi.on("session_shutdown", (event) => {
    closed = true;
    const reason = event.reason === "reload" ? "reload" : "shutdown";
    for (const record of records.values()) {
      if (!record.terminal) abortRecord(record, reason);
    }
    removeRequestListener();
    context = undefined;
  });
}

async function askBlockingUi(
  request: AskUserBlockingProviderRequestV1,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<BlockingUiAnswer | null> {
  const options = request.response.options.map((option, index) => {
    const description = option.description ? ` — ${option.description}` : "";
    const preview = option.preview ? `\nPreview:\n${option.preview}` : "";
    return `${index + 1}. ${option.label}${description}${preview}`;
  });
  const custom = "Type something";
  const title = request.explanation ? `${request.question}\n${request.explanation}` : request.question;
  const ui = ctx.ui as typeof ctx.ui & {
    select(title: string, values: string[], options?: { signal?: AbortSignal }): Promise<string | undefined>;
    input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  };
  const selected = await ui.select(title, [...options, custom], { signal });
  if (selected === undefined) return null;
  if (selected === custom) {
    const text = (await ui.input(request.question, "Your answer", { signal }))?.trim();
    return text ? { kind: "text", value: text } : null;
  }
  const index = options.indexOf(selected);
  const option = request.response.options[index];
  if (index < 0 || option === undefined) throw new Error("Dialog returned an unknown option.");
  return { kind: "option", value: option.id };
}

function emitRejected(
  correlationId: string,
  error: AskUserProviderErrorV1,
  emit: (response: AskUserBlockingProviderResponseV1) => void,
): void {
  emit({ schemaVersion: 1, correlationId, mode: "blocking", state: "rejected", error });
}

function invalidRequest(): AskUserProviderErrorV1 {
  return {
    code: "ASK_USER_INVALID_REQUEST",
    message: "The blocking provider rejected an invalid version-1 request.",
    retryable: false,
  };
}

function extractCorrelation(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("correlationId" in value)) return undefined;
  const correlationId = (value as { correlationId?: unknown }).correlationId;
  return typeof correlationId === "string" ? correlationId : undefined;
}
