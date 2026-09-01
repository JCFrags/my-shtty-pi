import type { SignalBoardError } from '../domain/errors.js';
import type { ToolCommandId } from '../domain/ids.js';
import type {
  CancelQuestionCommand,
  CreateQuestionCommand,
  QuestionMutationResult,
} from '../services/question-service.js';

export const ASK_USER_DEFERRED_REQUEST_EVENT_V1 = 'pi-ask-user:deferred-request-v1';
export const ASK_USER_DEFERRED_RESPONSE_EVENT_V1 = 'pi-ask-user:deferred-response-v1';
export const ASK_USER_PROVIDER_ACCEPT_TIMEOUT_MS_V1 = 250;

const CORRELATION_PATTERN =
  /^ask_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const QUESTION_ID_PATTERN = /^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DISPLAY_ID_PATTERN = /^Q-[1-9][0-9]*$/u;

export interface AskUserDeferredOptionV1 {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type AskUserDeferredResponseSpecV1 =
  | { readonly kind: 'text'; readonly options?: readonly [] }
  | {
      readonly kind: 'single' | 'multiple' | 'single_or_text' | 'multiple_or_text';
      readonly options: readonly AskUserDeferredOptionV1[];
    };

export interface AskUserTemporaryDefaultV1 {
  readonly optionIds: readonly string[];
  readonly disclosure: string;
}

export type AskUserAttachmentV1 =
  | {
      readonly kind: 'file';
      readonly label: string;
      readonly path: string;
      readonly external?: boolean;
    }
  | {
      readonly kind: 'line_range';
      readonly label: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly external?: boolean;
    }
  | { readonly kind: 'test_run' | 'command'; readonly label: string; readonly reference: string }
  | { readonly kind: 'url'; readonly label: string; readonly url: string }
  | { readonly kind: 'note'; readonly label: string; readonly text: string };

interface AskUserDeferredProviderRequestBaseV1 {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly mode: 'deferred';
  readonly signal?: AbortSignal;
}

export interface AskUserDeferredAskProviderRequestV1 extends AskUserDeferredProviderRequestBaseV1 {
  readonly operation: 'ask';
  readonly question: string;
  readonly reason: string;
  readonly class: 'preference' | 'information' | 'reversible' | 'authorization';
  readonly response: AskUserDeferredResponseSpecV1;
  readonly recommendation?: string;
  readonly recommendedOptionIds: readonly string[];
  readonly recommendedText?: string;
  readonly temporaryDefault?: AskUserTemporaryDefaultV1;
  readonly priority?: 'normal' | 'high';
  readonly blockingPolicy?: 'never' | 'when_agent_settles';
  readonly deliveryMode?: 'steer' | 'followUp' | 'nextTurn';
  readonly affectedWork: readonly string[];
  readonly continuingWork: readonly string[];
  readonly attachments: readonly AskUserAttachmentV1[];
  readonly expiresAt?: string;
}

export interface AskUserDeferredCancelProviderRequestV1
  extends AskUserDeferredProviderRequestBaseV1 {
  readonly operation: 'cancel';
  readonly id: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export type AskUserDeferredProviderRequestV1 =
  | AskUserDeferredAskProviderRequestV1
  | AskUserDeferredCancelProviderRequestV1;

export type AskUserProviderErrorCodeV1 =
  | 'ASK_USER_INVALID_REQUEST'
  | 'ASK_USER_CORRELATION_CONFLICT'
  | 'ASK_USER_PROVIDER_UNAVAILABLE'
  | 'ASK_USER_PROVIDER_UNHEALTHY'
  | 'ASK_USER_PROVIDER_FAILURE';

export interface AskUserProviderErrorV1 {
  readonly code: AskUserProviderErrorCodeV1;
  readonly message: string;
  readonly retryable: boolean;
}

export type AskUserDeferredProviderResponseV1 =
  | {
      readonly schemaVersion: 1;
      readonly correlationId: string;
      readonly mode: 'deferred';
      readonly state: 'accepted';
    }
  | {
      readonly schemaVersion: 1;
      readonly correlationId: string;
      readonly mode: 'deferred';
      readonly state: 'queued';
      readonly operation: 'ask';
      readonly questionId: string;
      readonly displayId: string;
      readonly revision: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly correlationId: string;
      readonly mode: 'deferred';
      readonly state: 'cancelled';
      readonly operation: 'cancel';
      readonly questionId: string;
      readonly displayId: string;
      readonly revision: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly correlationId: string;
      readonly mode: 'deferred';
      readonly state: 'rejected';
      readonly error: AskUserProviderErrorV1;
    };

export interface AskUserDeferredEventBus {
  readonly on: (channel: string, handler: (data: unknown) => void) => () => void;
  readonly emit: (channel: string, data: unknown) => void;
}

export type AskUserProviderMutationResult =
  | { readonly ok: true; readonly value: QuestionMutationResult }
  | { readonly ok: false; readonly error: SignalBoardError };

export interface AskUserDeferredProviderDependencies {
  readonly createQuestion: (
    command: CreateQuestionCommand,
  ) => Promise<AskUserProviderMutationResult>;
  readonly cancelQuestion: (
    command: CancelQuestionCommand,
  ) => Promise<AskUserProviderMutationResult>;
}

export interface AskUserDeferredProviderRegistration {
  readonly reset: () => void;
  readonly shutdown: () => void;
}

interface RequestRecord {
  readonly fingerprint: string;
  readonly request: AskUserDeferredProviderRequestV1;
  readonly epoch: number;
  active: boolean;
  terminal?: AskUserDeferredProviderResponseV1;
}

/** Register the store-free Signals provider for deferred ask_user requests. */
export function registerAskUserDeferredProviderV1(
  events: AskUserDeferredEventBus,
  dependencies: AskUserDeferredProviderDependencies,
): AskUserDeferredProviderRegistration {
  const records = new Map<string, RequestRecord>();
  let closed = false;
  let epoch = 0;

  const emit = (response: AskUserDeferredProviderResponseV1): void => {
    if (!isAskUserDeferredProviderResponseV1(response)) return;
    try {
      events.emit(ASK_USER_DEFERRED_RESPONSE_EVENT_V1, response);
    } catch {
      // Durable state and retry records remain valid after response delivery fails.
    }
  };

  const removeRequestListener = events.on(ASK_USER_DEFERRED_REQUEST_EVENT_V1, (value) => {
    let correlationId: string | undefined;
    try {
      correlationId = extractCorrelation(value);
      if (!isAskUserDeferredProviderRequestV1(value)) {
        if (correlationId !== undefined) emitRejected(correlationId, invalidRequest(), emit);
        return;
      }
      const request = cloneRequest(value);
      const fingerprint = requestFingerprint(request);
      const prior = records.get(request.correlationId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          emitRejected(
            request.correlationId,
            {
              code: 'ASK_USER_CORRELATION_CONFLICT',
              message:
                'The deferred provider correlation ID was reused with different request content.',
              retryable: false,
            },
            emit,
          );
          return;
        }
        emit(accepted(request.correlationId));
        if (prior.terminal !== undefined) emit(prior.terminal);
        else if (!prior.active) {
          prior.active = true;
          void executeRecord(prior, dependencies, emit, () => closed || prior.epoch !== epoch);
        }
        return;
      }

      const record: RequestRecord = { fingerprint, request, epoch, active: true };
      records.set(request.correlationId, record);
      emit(accepted(request.correlationId));
      void executeRecord(record, dependencies, emit, () => closed || record.epoch !== epoch);
    } catch {
      if (correlationId !== undefined) emitRejected(correlationId, invalidRequest(), emit);
    }
  });

  return {
    reset() {
      if (closed) return;
      epoch += 1;
      records.clear();
    },
    shutdown() {
      if (closed) return;
      closed = true;
      epoch += 1;
      records.clear();
      try {
        removeRequestListener();
      } catch {
        // Listener cleanup is best-effort at the host boundary.
      }
    },
  };
}

async function executeRecord(
  record: RequestRecord,
  dependencies: AskUserDeferredProviderDependencies,
  emit: (response: AskUserDeferredProviderResponseV1) => void,
  isClosed: () => boolean,
): Promise<void> {
  let result: AskUserProviderMutationResult;
  try {
    const commandId = `tool:ask_user:${record.request.correlationId}` as ToolCommandId;
    result =
      record.request.operation === 'ask'
        ? await dependencies.createQuestion(createCommand(record.request, commandId))
        : await dependencies.cancelQuestion(cancelCommand(record.request, commandId));
  } catch {
    record.active = false;
    if (!isClosed()) {
      emitRejected(
        record.request.correlationId,
        {
          code: 'ASK_USER_PROVIDER_FAILURE',
          message: 'Signals could not complete the deferred ask_user operation.',
          retryable: true,
        },
        emit,
      );
    }
    return;
  }

  if (!result.ok) {
    record.active = false;
    if (!isClosed())
      emitRejected(record.request.correlationId, mapSignalsError(result.error), emit);
    return;
  }

  const terminal = terminalResponse(record.request, result.value);
  if (terminal === undefined) {
    record.active = false;
    if (!isClosed()) {
      emitRejected(
        record.request.correlationId,
        {
          code: 'ASK_USER_PROVIDER_UNHEALTHY',
          message: 'Signals returned an invalid deferred ask_user mutation result.',
          retryable: true,
        },
        emit,
      );
    }
    return;
  }
  record.terminal = terminal;
  record.active = false;
  if (!isClosed()) emit(terminal);
}

function createCommand(
  request: AskUserDeferredAskProviderRequestV1,
  commandId: ToolCommandId,
): CreateQuestionCommand {
  return {
    commandId,
    question: request.question,
    reason: request.reason,
    class: request.class,
    response: request.response,
    ...(request.recommendation === undefined ? {} : { recommendation: request.recommendation }),
    recommendedOptionIds: request.recommendedOptionIds,
    ...(request.recommendedText === undefined ? {} : { recommendedText: request.recommendedText }),
    ...(request.temporaryDefault === undefined
      ? {}
      : { temporaryDefault: request.temporaryDefault }),
    ...(request.priority === undefined ? {} : { priority: request.priority }),
    ...(request.blockingPolicy === undefined ? {} : { blockingPolicy: request.blockingPolicy }),
    ...(request.deliveryMode === undefined ? {} : { deliveryMode: request.deliveryMode }),
    affectedWork: request.affectedWork,
    continuingWork: request.continuingWork,
    attachments: request.attachments,
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
  } as CreateQuestionCommand;
}

function cancelCommand(
  request: AskUserDeferredCancelProviderRequestV1,
  commandId: ToolCommandId,
): CancelQuestionCommand {
  return {
    commandId,
    id: request.id,
    expectedRevision: request.expectedRevision,
    reason: request.reason,
  };
}

function terminalResponse(
  request: AskUserDeferredProviderRequestV1,
  result: QuestionMutationResult,
): AskUserDeferredProviderResponseV1 | undefined {
  const event = result.event;
  if (request.operation === 'ask') {
    if (
      event.eventType !== 'question.created' ||
      result.item.id !== event.payload.questionId ||
      result.item.displayId !== event.payload.displayId
    )
      return undefined;
    const response: AskUserDeferredProviderResponseV1 = {
      schemaVersion: 1,
      correlationId: request.correlationId,
      mode: 'deferred',
      state: 'queued',
      operation: 'ask',
      questionId: event.payload.questionId,
      displayId: event.payload.displayId,
      revision: event.payload.revision,
    };
    return isAskUserDeferredProviderResponseV1(response) ? Object.freeze(response) : undefined;
  }
  if (event.eventType !== 'question.cancelled' || result.item.id !== event.payload.questionId)
    return undefined;
  const response: AskUserDeferredProviderResponseV1 = {
    schemaVersion: 1,
    correlationId: request.correlationId,
    mode: 'deferred',
    state: 'cancelled',
    operation: 'cancel',
    questionId: event.payload.questionId,
    displayId: result.item.displayId,
    revision: event.payload.revision,
  };
  return isAskUserDeferredProviderResponseV1(response) ? Object.freeze(response) : undefined;
}

function mapSignalsError(error: SignalBoardError): AskUserProviderErrorV1 {
  if (
    error.code === 'SB_NOT_INITIALIZED' ||
    error.code === 'SB_CONFIG_DISABLED' ||
    error.code === 'SB_UNSUPPORTED_HOST'
  ) {
    return Object.freeze({
      code: 'ASK_USER_PROVIDER_UNAVAILABLE',
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error.code === 'SB_INTERNAL') {
    return Object.freeze({
      code: 'ASK_USER_PROVIDER_UNHEALTHY',
      message: error.message,
      retryable: error.retryable,
    });
  }
  return Object.freeze({
    code: 'ASK_USER_PROVIDER_FAILURE',
    message: error.message,
    retryable: error.retryable,
  });
}

function accepted(correlationId: string): AskUserDeferredProviderResponseV1 {
  return Object.freeze({ schemaVersion: 1, correlationId, mode: 'deferred', state: 'accepted' });
}

function emitRejected(
  correlationId: string,
  error: AskUserProviderErrorV1,
  emit: (response: AskUserDeferredProviderResponseV1) => void,
): void {
  emit(
    Object.freeze({ schemaVersion: 1, correlationId, mode: 'deferred', state: 'rejected', error }),
  );
}

function invalidRequest(): AskUserProviderErrorV1 {
  return Object.freeze({
    code: 'ASK_USER_INVALID_REQUEST',
    message: 'The deferred provider rejected an invalid version-1 request.',
    retryable: false,
  });
}

function extractCorrelation(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.correlationId !== 'string') return undefined;
  return CORRELATION_PATTERN.test(value.correlationId) ? value.correlationId : undefined;
}

function cloneRequest(request: AskUserDeferredProviderRequestV1): AskUserDeferredProviderRequestV1 {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(request)) {
    if (key !== 'signal') copy[key] = cloneFreeze(request[key as keyof typeof request]);
  }
  return Object.freeze(copy) as unknown as AskUserDeferredProviderRequestV1;
}

function cloneFreeze(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneFreeze(item)));
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = cloneFreeze(value[key]);
  return Object.freeze(copy);
}

function requestFingerprint(request: AskUserDeferredProviderRequestV1): string {
  return stableFingerprint(request);
}

function stableFingerprint(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableFingerprint(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Frozen version-1 deferred request guard. Keep it in sync with the accepted facade contract. */
export function isAskUserDeferredProviderRequestV1(
  value: unknown,
): value is AskUserDeferredProviderRequestV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.mode !== 'deferred' ||
    !validCorrelation(value.correlationId)
  )
    return false;
  if (value.signal !== undefined && !isAbortSignal(value.signal)) return false;
  if (value.operation === 'cancel') {
    return (
      hasExactKeys(value, [
        'schemaVersion',
        'correlationId',
        'operation',
        'mode',
        'id',
        'expectedRevision',
        'reason',
        'signal',
      ]) &&
      typeof value.id === 'string' &&
      (QUESTION_ID_PATTERN.test(value.id) || DISPLAY_ID_PATTERN.test(value.id)) &&
      Number.isInteger(value.expectedRevision) &&
      (value.expectedRevision as number) >= 1 &&
      nonEmpty(value.reason, 1000)
    );
  }
  if (
    value.operation !== 'ask' ||
    !hasExactKeys(value, [
      'schemaVersion',
      'correlationId',
      'operation',
      'mode',
      'question',
      'reason',
      'class',
      'response',
      'recommendation',
      'recommendedOptionIds',
      'recommendedText',
      'temporaryDefault',
      'priority',
      'blockingPolicy',
      'deliveryMode',
      'affectedWork',
      'continuingWork',
      'attachments',
      'expiresAt',
      'signal',
    ])
  )
    return false;
  if (!nonEmpty(value.question, 160) || !nonEmpty(value.reason, 4000)) return false;
  if (!['preference', 'information', 'reversible', 'authorization'].includes(value.class as string))
    return false;
  if (!validDeferredResponse(value.response)) return false;
  if (
    !validOptionalText(value.recommendation, 1000) ||
    !validOptionalText(value.recommendedText, 4000)
  )
    return false;
  if (
    !validIdList(value.recommendedOptionIds, 8) ||
    !validWorkList(value.affectedWork) ||
    !validWorkList(value.continuingWork)
  )
    return false;
  if (value.priority !== undefined && value.priority !== 'normal' && value.priority !== 'high')
    return false;
  if (
    value.blockingPolicy !== undefined &&
    value.blockingPolicy !== 'never' &&
    value.blockingPolicy !== 'when_agent_settles'
  )
    return false;
  if (
    value.deliveryMode !== undefined &&
    value.deliveryMode !== 'steer' &&
    value.deliveryMode !== 'followUp' &&
    value.deliveryMode !== 'nextTurn'
  )
    return false;
  if (value.expiresAt !== undefined && !nonEmpty(value.expiresAt, 64)) return false;
  if (
    !Array.isArray(value.attachments) ||
    value.attachments.length > 10 ||
    !value.attachments.every(validAttachment)
  )
    return false;
  if (!disjoint(value.affectedWork as readonly string[], value.continuingWork as readonly string[]))
    return false;
  const optionOrder = deferredOptionOrder(value.response);
  if (!(value.recommendedOptionIds as readonly string[]).every((id) => optionOrder.has(id)))
    return false;
  if (
    (value.response as { kind: string }).kind === 'single' ||
    (value.response as { kind: string }).kind === 'single_or_text'
  ) {
    if ((value.recommendedOptionIds as readonly string[]).length > 1) return false;
  }
  const allowsText = ['text', 'single_or_text', 'multiple_or_text'].includes(
    (value.response as { kind: string }).kind,
  );
  if (value.recommendedText !== undefined && !allowsText) return false;
  if (
    value.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(value.expiresAt as string)) ||
      Date.parse(value.expiresAt as string) <= Date.now())
  )
    return false;
  if (value.temporaryDefault === undefined) return true;
  if (
    !validTemporaryDefault(value.temporaryDefault) ||
    value.class !== 'reversible' ||
    (value.response as { kind: string }).kind === 'text'
  )
    return false;
  const temporaryIds = (value.temporaryDefault as { optionIds: readonly string[] }).optionIds;
  if (!temporaryIds.every((id) => optionOrder.has(id))) return false;
  return (
    !['single', 'single_or_text'].includes((value.response as { kind: string }).kind) ||
    temporaryIds.length === 1
  );
}

export function isAskUserDeferredProviderResponseV1(
  value: unknown,
): value is AskUserDeferredProviderResponseV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.mode !== 'deferred' ||
    !validCorrelation(value.correlationId) ||
    typeof value.state !== 'string'
  )
    return false;
  if (value.state === 'accepted')
    return hasExactKeys(value, ['schemaVersion', 'correlationId', 'mode', 'state']);
  if (value.state === 'rejected')
    return (
      hasExactKeys(value, ['schemaVersion', 'correlationId', 'mode', 'state', 'error']) &&
      validError(value.error)
    );
  if (value.state !== 'queued' && value.state !== 'cancelled') return false;
  return (
    hasExactKeys(value, [
      'schemaVersion',
      'correlationId',
      'mode',
      'state',
      'operation',
      'questionId',
      'displayId',
      'revision',
    ]) &&
    value.operation === (value.state === 'queued' ? 'ask' : 'cancel') &&
    typeof value.questionId === 'string' &&
    QUESTION_ID_PATTERN.test(value.questionId) &&
    typeof value.displayId === 'string' &&
    DISPLAY_ID_PATTERN.test(value.displayId) &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1
  );
}

function validDeferredResponse(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'options']) ||
    typeof value.kind !== 'string'
  )
    return false;
  if (value.kind === 'text')
    return (
      value.options === undefined || (Array.isArray(value.options) && value.options.length === 0)
    );
  if (
    !['single', 'multiple', 'single_or_text', 'multiple_or_text'].includes(value.kind) ||
    !Array.isArray(value.options)
  )
    return false;
  return validOptions(value.options, 8);
}

function validOptions(options: readonly unknown[], maximum: number): boolean {
  if (options.length < 2 || options.length > maximum) return false;
  const ids = new Set<string>();
  for (const option of options) {
    if (
      !isRecord(option) ||
      !hasExactKeys(option, ['id', 'label', 'description']) ||
      typeof option.id !== 'string' ||
      !OPTION_ID_PATTERN.test(option.id) ||
      ids.has(option.id)
    )
      return false;
    if (!nonEmpty(option.label, 160) || !validOptionalText(option.description, 500)) return false;
    ids.add(option.id);
  }
  return true;
}

function validIdList(value: unknown, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' && OPTION_ID_PATTERN.test(item))
  );
}

function validWorkList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    new Set(value).size === value.length &&
    value.every((item) => nonEmpty(item, 240))
  );
}

function validTemporaryDefault(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['optionIds', 'disclosure']) &&
    Array.isArray(value.optionIds) &&
    value.optionIds.length >= 1 &&
    validIdList(value.optionIds, 8) &&
    nonEmpty(value.disclosure, 1000)
  );
}

function validAttachment(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string' || !nonEmpty(value.label, 160))
    return false;
  if (value.kind === 'file') {
    return (
      hasExactKeys(value, ['kind', 'label', 'path', 'external']) &&
      nonEmpty(value.path, 1000) &&
      (value.external === undefined || typeof value.external === 'boolean')
    );
  }
  if (value.kind === 'line_range') {
    return (
      hasExactKeys(value, ['kind', 'label', 'path', 'startLine', 'endLine', 'external']) &&
      nonEmpty(value.path, 1000) &&
      Number.isInteger(value.startLine) &&
      (value.startLine as number) >= 1 &&
      Number.isInteger(value.endLine) &&
      (value.endLine as number) >= (value.startLine as number) &&
      (value.external === undefined || typeof value.external === 'boolean')
    );
  }
  if (value.kind === 'test_run' || value.kind === 'command') {
    return hasExactKeys(value, ['kind', 'label', 'reference']) && nonEmpty(value.reference, 1000);
  }
  if (value.kind === 'url') {
    if (!hasExactKeys(value, ['kind', 'label', 'url']) || !nonEmpty(value.url, 2000)) return false;
    try {
      new URL(value.url);
      return true;
    } catch {
      return false;
    }
  }
  return (
    value.kind === 'note' &&
    hasExactKeys(value, ['kind', 'label', 'text']) &&
    nonEmpty(value.text, 4000)
  );
}

function deferredOptionOrder(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.options)) return new Set();
  return new Set(
    value.options.flatMap((option) =>
      isRecord(option) && typeof option.id === 'string' ? [option.id] : [],
    ),
  );
}

function disjoint(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.every((item) => !values.has(item));
}

function validError(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'message', 'retryable']) &&
    [
      'ASK_USER_INVALID_REQUEST',
      'ASK_USER_CORRELATION_CONFLICT',
      'ASK_USER_PROVIDER_UNAVAILABLE',
      'ASK_USER_PROVIDER_UNHEALTHY',
      'ASK_USER_PROVIDER_FAILURE',
    ].includes(value.code as string) &&
    nonEmpty(value.message, 1000) &&
    typeof value.retryable === 'boolean'
  );
}

function validCorrelation(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_PATTERN.test(value);
}

function validOptionalText(value: unknown, maximum: number): boolean {
  return value === undefined || nonEmpty(value, maximum);
}

function nonEmpty(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim().length > 0
  );
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function'
  );
}
