import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MAX_ANSWER_BYTES, MAX_PENDING_QUESTIONS, QUESTION_ANSWER_MESSAGE_TYPE, QUESTION_ENTRY_TYPE,
  type ProjectGlanceQuestion, type ProjectGlanceQuestionAction, type ProjectGlanceQuestionAnswer, type ProjectGlanceQuestionAttention,
} from "./model.js";
import {
  QUESTION_ACTIVE_WORK_MS, QUESTION_MEANINGFUL_RUNS, QuestionActivityTracker, questionActiveMs,
  type QuestionActivityAggregate, type QuestionAgentEndEvent, type QuestionToolEndEvent, type QuestionToolStartEvent,
} from "./activity.js";
import { fsyncCurrentSessionFile, readCurrentReceipts, type DiskReceipts } from "./receipts.js";
import { canonical, CORRELATION, digest, keys, parseRequest, record, REQUEST_EVENT, RESPONSE_EVENT, text, type AskRequest } from "./wire.js";

export interface QuestionServiceOptions {
  events: { on(name: string, handler: (value: unknown) => void): () => void; emit(name: string, value: unknown): void };
  getContext: () => Pick<ExtensionContext, "sessionManager" | "isIdle"> | undefined;
  appendEntry: (data: unknown) => void;
  /** The adapter MUST use pi.sendMessage(message, {triggerTurn:false}). Never a native queue. */
  sendMessage: (message: { customType: string; content: string; display: boolean; details: unknown }) => void;
  onChange: () => void;
  now?: () => number;
  monotonicNow?: () => number;
}
type Context = NonNullable<ReturnType<QuestionServiceOptions["getContext"]>>;
type Entry = ReturnType<Context["sessionManager"]["getEntries"]>[number];
type ActionReceipt = { id: string; fingerprint: string; expectedRevision: number };
type ProviderReceipt = { correlationId: string; fingerprint: string; operation: "ask" | "cancel"; revision: number };
type Base = { version: 1; deltaId: string; sessionId: string; questionId: string; revision: number; at: number };
type Delta = Base & (
  | { kind: "CREATED"; displayId: string; request: AskRequest; receipt: ProviderReceipt }
  | { kind: "ANSWER"; answer: ProjectGlanceQuestionAnswer; action: ActionReceipt }
  | { kind: "CANCEL"; action?: ActionReceipt; receipt?: ProviderReceipt; notifyModel: boolean }
  | { kind: "DISMISS"; action: ActionReceipt; cause: "manual_user" | "rejected_cleanup"; notifyModel: boolean }
  | { kind: "HIDE"; action: ActionReceipt }
  | { kind: "EXPIRE"; cause: "continued_work"; notifyModel: true }
  | { kind: "ACTIVITY"; runId: string; originEntryId: string; activeMs: number; meaningful: boolean; eligibleSuccesses: number; sourceToolCallIds: string[] }
  | { kind: "DELIVERY"; sourceId: string; status: "delivered" | "failed" | "retry"; deliveryId: string; payloadDigest: string; messageEntryId?: string; action?: ActionReceipt }
);
type OwnEntry = { entryId: string; data: Delta };
type Row = {
  created: OwnEntry; latest: OwnEntry; entries: OwnEntry[]; revision: number;
  state: "pending" | "submitted" | "cancelled" | "expired" | "delivered" | "delivery_failed";
  answer?: ProjectGlanceQuestionAnswer; source?: OwnEntry; durable: boolean; failure?: string; hidden: boolean;
  activeMs: number; meaningfulRuns: Set<string>;
};
const PERSIST_FAILURE = "Question state is not confirmed in the current session file. Retry after session persistence is restored.";
const DELIVERY_FAILURE = "Answer delivery is not confirmed in the current session file. Retry to reconcile; no new turn will be started.";
const SCOPE_FAILURE = "Answer already exists on another branch or conflicts with its receipt. It was not sent again.";

/** Own-entry decoding is intentionally fail-closed. Entries are data, not instructions. */
function decode(entry: Entry): OwnEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== QUESTION_ENTRY_TYPE || !record(entry.data)) return undefined;
  const d = entry.data;
  if (d.version !== 1 || typeof d.deltaId !== "string" || typeof d.sessionId !== "string" || typeof d.questionId !== "string" || !Number.isSafeInteger(d.revision) || Number(d.revision) < 1 || !Number.isFinite(d.at)) return undefined;
  if (!["CREATED", "ANSWER", "CANCEL", "DISMISS", "HIDE", "EXPIRE", "ACTIVITY", "DELIVERY"].includes(String(d.kind))) return undefined;
  if (d.kind === "CREATED") {
    const request = parseRequest(d.request, { allowLegacyExpiresAt: true });
    if (!request || request.operation !== "ask" || typeof d.displayId !== "string" || !/^Q-[1-9][0-9]*$/u.test(d.displayId) || d.questionId !== request.correlationId.replace(/^ask_/u, "qst_") || !record(d.receipt) || d.receipt.fingerprint !== digest(d.request) || d.receipt.correlationId !== request.correlationId || d.receipt.operation !== "ask" || d.receipt.revision !== 1 || d.revision !== 1) return undefined;
  }
  if (d.kind === "ANSWER" && (!record(d.answer) || !Array.isArray(d.answer.optionIds) || !record(d.action))) return undefined;
  if (d.kind === "CANCEL" && typeof d.notifyModel !== "boolean") return undefined;
  if (d.kind === "DISMISS" && (!record(d.action) || !["manual_user", "rejected_cleanup"].includes(String(d.cause)) || typeof d.notifyModel !== "boolean")) return undefined;
  if (d.kind === "HIDE" && !record(d.action)) return undefined;
  if (d.kind === "EXPIRE" && (d.cause !== "continued_work" || d.notifyModel !== true)) return undefined;
  if (d.kind === "ACTIVITY" && (typeof d.runId !== "string" || typeof d.originEntryId !== "string" || !Number.isSafeInteger(d.activeMs) || Number(d.activeMs) < 0 || typeof d.meaningful !== "boolean" || !Number.isSafeInteger(d.eligibleSuccesses) || !Array.isArray(d.sourceToolCallIds) || d.sourceToolCallIds.length > 64 || !d.sourceToolCallIds.every((id) => text(id, 240)))) return undefined;
  if (d.kind === "DELIVERY" && (typeof d.sourceId !== "string" || typeof d.deliveryId !== "string" || typeof d.payloadDigest !== "string" || !["delivered", "failed", "retry"].includes(String(d.status)))) return undefined;
  if (d.action !== undefined && (!record(d.action) || !text(d.action.id, 240) || typeof d.action.fingerprint !== "string" || !Number.isSafeInteger(d.action.expectedRevision))) return undefined;
  if (d.receipt !== undefined && (!record(d.receipt) || typeof d.receipt.correlationId !== "string" || !CORRELATION.test(d.receipt.correlationId) || typeof d.receipt.fingerprint !== "string" || !Number.isSafeInteger(d.receipt.revision) || !["ask", "cancel"].includes(String(d.receipt.operation)))) return undefined;
  return { entryId: entry.id, data: d as unknown as Delta };
}
function actionOf(delta: Delta): ActionReceipt | undefined { return "action" in delta ? delta.action : undefined; }
function receiptOf(delta: Delta): ProviderReceipt | undefined { return "receipt" in delta ? delta.receipt : undefined; }
function normalizeAnswer(value: unknown, request: AskRequest): ProjectGlanceQuestionAnswer | undefined {
  if (!record(value) || !keys(value, ["optionIds", "text"]) || !Array.isArray(value.optionIds) || value.optionIds.length > 8 || new Set(value.optionIds).size !== value.optionIds.length || !value.optionIds.every((id) => typeof id === "string")) return undefined;
  if (value.text !== undefined && !text(value.text, MAX_ANSWER_BYTES)) return undefined;
  const answer: ProjectGlanceQuestionAnswer = { optionIds: [...value.optionIds] as string[], ...(typeof value.text === "string" ? { text: value.text.normalize("NFC").replace(/\r\n?/gu, "\n").trim() } : {}) };
  const available = new Set(request.response.options?.map((option) => option.id));
  if (!answer.optionIds.every((id) => available.has(id))) return undefined;
  const kind = request.response.kind;
  if (kind === "text" && (answer.optionIds.length !== 0 || !answer.text)) return undefined;
  if ((kind === "single" || kind === "single_or_text") && answer.optionIds.length > 1) return undefined;
  if ((kind === "single" || kind === "multiple") && (answer.text !== undefined || !answer.optionIds.length)) return undefined;
  if (kind.endsWith("_or_text") && ((!answer.optionIds.length && !answer.text) || (answer.optionIds.length > 0 && answer.text !== undefined))) return undefined;
  // Canonical option order makes equivalent checkbox selection stable.
  answer.optionIds = request.response.options?.filter((option) => answer.optionIds.includes(option.id)).map((option) => option.id) ?? [];
  if (Buffer.byteLength(canonical(answer)) > MAX_ANSWER_BYTES) return undefined;
  return answer;
}

export class ProjectGlanceQuestionService {
  private unsubscribe: (() => void) | undefined;
  private epoch = 0;
  private active = false;
  private running = false;
  private rows = new Map<string, Row>();
  private disk: DiskReceipts | undefined;
  private diskError = false;
  private scope = "";
  private lastLeafId: string | null | undefined;
  private volatileFailures = new Map<string, string>();
  private pendingReceiptIds = new Map<string, string>();
  private suppressedVolatileIds = new Set<string>();
  private editing = new Map<object, { questionId: string; expectedRevision: number }>();
  private readonly now: () => number;
  private readonly activity: QuestionActivityTracker;
  constructor(private readonly options: QuestionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.activity = new QuestionActivityTracker((aggregate, ctx) => this.recordActivity(aggregate, ctx), options.monotonicNow);
  }

  private context(): Context | undefined {
    try {
      const ctx = this.options.getContext();
      if (!ctx || typeof ctx.isIdle !== "function" || !ctx.sessionManager) return undefined;
      const sm = ctx.sessionManager;
      return [sm.getSessionId, sm.getSessionFile, sm.getEntries, sm.getBranch, sm.getLeafId].every((fn) => typeof fn === "function") ? ctx : undefined;
    } catch { return undefined; }
  }
  private changed(): void { try { this.options.onChange(); } catch { /* A UI observer cannot turn a durable receipt into a provider rejection. */ } }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.epoch++;
    this.unsubscribe = this.options.events.on(REQUEST_EVENT, (value) => this.receive(value));
    this.sync();
  }
  stop(): void {
    this.active = false;
    this.epoch++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.activity.stop();
    this.editing.clear();
    this.suppressedVolatileIds.clear();
    this.rows.clear();
    this.disk = undefined;
    this.volatileFailures.clear();
    this.pendingReceiptIds.clear();
    this.scope = "";
    this.lastLeafId = undefined;
  }
  get questions(): ProjectGlanceQuestion[] {
    return [...this.rows.values()].flatMap((row) => {
      const failure = this.volatileFailures.get(row.created.data.questionId) ?? (!row.durable ? PERSIST_FAILURE : row.failure);
      if (row.hidden || this.suppressedVolatileIds.has(row.created.data.questionId) || (["cancelled", "expired", "delivered"].includes(row.state) && !failure)) return [];
      const data = row.created.data;
      if (data.kind !== "CREATED") return [];
      const q = data.request;
      return [{ id: data.questionId, displayId: data.displayId, revision: row.revision,
        state: failure || row.state === "delivery_failed" ? "delivery_failed" as const : row.state === "pending" ? "pending" as const : "submitted" as const,
        question: q.question, reason: q.reason, response: structuredClone(q.response),
        ...(q.recommendation !== undefined ? { recommendation: q.recommendation } : {}),
        recommendedOptionIds: [...q.recommendedOptionIds],
        ...(q.recommendedText !== undefined ? { recommendedText: q.recommendedText } : {}),
        ...(q.temporaryDefault !== undefined ? { temporaryDefault: structuredClone(q.temporaryDefault) } : {}),
        ...(row.answer ? { answer: structuredClone(row.answer) } : {}), ...(failure ? { failure } : {}),
      }];
    });
  }
  get pendingCount(): number { return this.questions.length; }
  get hiddenAttention(): ProjectGlanceQuestionAttention[] {
    return [...this.rows.values()].flatMap((row) => {
      if (!row.hidden || (row.state !== "submitted" && row.state !== "delivery_failed") || row.created.data.kind !== "CREATED") return [];
      const failure = this.volatileFailures.get(row.created.data.questionId) ?? row.failure;
      return [{ questionId: row.created.data.questionId, displayId: row.created.data.displayId, revision: row.revision,
        state: failure ? "delivery_failed" as const : row.state, retryAvailable: !!failure || row.state === "delivery_failed",
        message: failure ?? (row.state === "delivery_failed" ? DELIVERY_FAILURE : "Answer is saved and awaiting safe-idle delivery.") }];
    });
  }
  get hiddenAttentionCount(): number { return this.hiddenAttention.length; }
  private capacityCount(): number {
    // A hidden cancellation notice still owns an outbox slot until insertion succeeds.
    // Otherwise four new questions plus its delivery failure could exceed the projection cap.
    return [...this.rows.values()].filter((row) => !this.suppressedVolatileIds.has(row.created.data.questionId) && (["pending", "submitted", "delivery_failed"].includes(row.state) || !row.durable || this.volatileFailures.has(row.created.data.questionId) || (row.state === "cancelled" && !!row.source && "notifyModel" in row.source.data && row.source.data.notifyModel))).length;
  }

  agentStart(ctx: Context): void { this.activity.agentStart(ctx); }
  toolStart(event: QuestionToolStartEvent, ctx: Context): void { this.activity.toolStart(event, ctx); }
  toolEnd(event: QuestionToolEndEvent, ctx: Context): void { this.activity.toolEnd(event, ctx); }
  uiPromptStart(ctx: Context): void { this.activity.uiPromptStart(ctx); }
  uiPromptEnd(ctx: Context): void { this.activity.uiPromptEnd(ctx); }
  agentEnd(event: QuestionAgentEndEvent, ctx: Context): void { this.activity.agentEnd(event, ctx); }
  agentSettled(ctx: Context): void { this.activity.agentSettled(ctx); this.sync(); }
  sessionTree(_ctx?: Context): void { this.activity.sessionTree(); this.editing.clear(); }

  setEditing(owner: object, value: { questionId: string; expectedRevision: number; active: boolean }): boolean {
    if (!owner || !record(value) || typeof value.questionId !== "string" || !Number.isSafeInteger(value.expectedRevision)) return false;
    if (!value.active) { this.editing.delete(owner); this.sync(); return true; }
    const ctx = this.context();
    if (!ctx) return false;
    this.restore(ctx);
    const row = this.rows.get(value.questionId);
    if (!row || row.state !== "pending" || row.revision !== value.expectedRevision || !row.durable) return false;
    this.editing.set(owner, { questionId: value.questionId, expectedRevision: value.expectedRevision });
    return true;
  }
  releaseEditing(owner: object): void { if (this.editing.delete(owner)) this.sync(); }
  private isEditing(row: Row): boolean {
    return [...this.editing.values()].some((value) => value.questionId === row.created.data.questionId && value.expectedRevision === row.revision);
  }

  /** Restore active ancestry, apply qualified expiry, then perform idle history insertion. */
  sync(): void {
    if (!this.active || this.running) return;
    this.running = true;
    const epoch = this.epoch;
    try {
      const ctx = this.context();
      if (!ctx) { this.rows.clear(); return; }
      this.restore(ctx);
      // If creation became durable after its provider acknowledgement failed, a user
      // dismissal first hides the unusable slot and this pass retires it durably.
      for (const questionId of [...this.suppressedVolatileIds]) {
        const row = this.rows.get(questionId);
        if (!row || row.state !== "pending") { this.suppressedVolatileIds.delete(questionId); continue; }
        if (!row.durable) continue;
        if (this.persist(ctx, { ...this.base(ctx, row), kind: "CANCEL", notifyModel: false })) this.suppressedVolatileIds.delete(questionId);
        if (!this.active || this.epoch !== epoch) return;
        this.restore(ctx);
      }
      if (ctx.isIdle()) for (const row of [...this.rows.values()]) {
        if (row.state !== "pending" || !row.durable || row.activeMs < QUESTION_ACTIVE_WORK_MS || row.meaningfulRuns.size < QUESTION_MEANINGFUL_RUNS || this.isEditing(row)) continue;
        this.persist(ctx, { ...this.base(ctx, row), kind: "EXPIRE", cause: "continued_work", notifyModel: true });
        if (!this.active || this.epoch !== epoch) return;
        this.restore(ctx);
      }
      for (const row of [...this.rows.values()]) {
        const sourceNotifies = row.source && "notifyModel" in row.source.data && row.source.data.notifyModel;
        if (row.durable && row.source && (row.state === "submitted" || ((row.state === "cancelled" || row.state === "expired") && sourceNotifies))) this.deliver(ctx, row);
        if (!this.active || this.epoch !== epoch) return;
      }
      this.restore(ctx);
    } catch {
      for (const row of this.rows.values()) row.failure = PERSIST_FAILURE;
    } finally {
      this.running = false;
      this.changed();
    }
  }

  private recordActivity(aggregate: QuestionActivityAggregate, ctx: Pick<ExtensionContext, "sessionManager">): void {
    if (!this.active || this.running || this.context()?.sessionManager !== ctx.sessionManager) return;
    const current = this.context();
    if (!current) return;
    this.restore(current);
    const branch = current.sessionManager.getBranch();
    const position = new Map(branch.map((entry, index) => [entry.id, index]));
    for (const row of [...this.rows.values()]) {
      const createdAt = position.get(row.created.entryId);
      if (row.state !== "pending" || !row.durable || createdAt === undefined || this.isEditing(row)) continue;
      const spans = aggregate.spans.filter((span) => {
        const anchorAt = span.startAnchorId === null ? undefined : position.get(span.startAnchorId);
        if (anchorAt === undefined || anchorAt < createdAt) return false;
        return branch.some((entry, index) => index > createdAt && entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === span.toolCallId && !entry.message.isError);
      });
      const sourceToolCallIds = [...new Set(spans.map((span) => span.toolCallId))];
      if (!sourceToolCallIds.length) continue;
      const activeMs = questionActiveMs(spans);
      const meaningful = spans.some((span) => span.strong) || sourceToolCallIds.length >= 3;
      const deltaId = `activity_${digest([row.created.data.questionId, row.created.entryId, aggregate.runId])}`;
      if (row.entries.some((entry) => entry.data.deltaId === deltaId)) continue;
      this.persist(current, {
        version: 1, deltaId, sessionId: row.created.data.sessionId, questionId: row.created.data.questionId,
        revision: row.revision, at: this.now(), kind: "ACTIVITY", runId: aggregate.runId,
        originEntryId: row.created.entryId, activeMs, meaningful,
        eligibleSuccesses: sourceToolCallIds.length, sourceToolCallIds,
      });
      this.restore(current);
    }
  }

  applyAction(action: ProjectGlanceQuestionAction, actionId: string): boolean {
    try { return this.applyVerifiedAction(action, actionId); }
    catch { this.changed(); return false; }
  }
  private applyVerifiedAction(action: ProjectGlanceQuestionAction, actionId: string): boolean {
    if (!this.active || this.running || !text(actionId, 240) || !record(action) || !["question_answer", "question_cancel", "question_dismiss", "question_hide", "question_retry"].includes(String(action.type)) || !Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 1) return false;
    const allowed = action.type === "question_answer" ? ["type", "questionId", "expectedRevision", "answer"] : ["type", "questionId", "expectedRevision"];
    if (!keys(action, allowed)) return false;
    const ctx = this.context();
    if (!ctx) return false;
    this.restore(ctx);
    const row = this.rows.get(action.questionId);
    if (!row || row.created.data.kind !== "CREATED") return false;
    const answer = action.type === "question_answer" ? normalizeAnswer(action.answer, row.created.data.request) : undefined;
    if (action.type === "question_answer" && !answer) return false;
    const fingerprint = digest({ ...action, ...(answer ? { answer } : {}) });
    const previous = this.ownHistory(ctx).filter((entry) => actionOf(entry.data)?.id === actionId);
    if (previous.length) {
      return row.durable && previous.length === 1 && actionOf(previous[0]!.data)?.fingerprint === fingerprint && previous[0]!.data.questionId === action.questionId && this.onBranch(ctx, previous[0]!) && this.confirmed(previous[0]!);
    }
    if (row.revision !== action.expectedRevision) return false;
    if (!row.durable) {
      if (action.type === "question_dismiss" || action.type === "question_cancel") {
        this.suppressedVolatileIds.add(action.questionId); this.changed(); return true;
      }
      return false;
    }
    const receipt = { id: actionId, fingerprint, expectedRevision: action.expectedRevision };
    let delta: Delta;
    if (action.type === "question_answer") {
      if (row.state !== "pending") return false;
      delta = { ...this.base(ctx, row), kind: "ANSWER", answer: answer!, action: receipt };
    } else if (action.type === "question_dismiss" || action.type === "question_cancel") {
      if (row.state !== "pending") return false;
      delta = { ...this.base(ctx, row), kind: "DISMISS", action: receipt, cause: "manual_user", notifyModel: true };
    } else if (action.type === "question_hide") {
      if ((row.state !== "submitted" && row.state !== "delivery_failed") || !row.source || row.hidden) return false;
      delta = { ...this.base(ctx, row), kind: "HIDE", action: receipt };
    } else {
      if (row.state !== "delivery_failed" && !this.volatileFailures.has(action.questionId)) return false;
      const message = row.source ? this.message(row) : undefined;
      delta = { ...this.base(ctx, row), kind: "DELIVERY", status: "retry", sourceId: row.source?.data.deltaId ?? row.created.data.deltaId, deliveryId: message?.details.deliveryId ?? "", payloadDigest: message?.details.payloadDigest ?? "", action: receipt };
    }
    const success = this.persist(ctx, delta);
    this.sync();
    return success;
  }

  private receive(input: unknown): void {
    if (!record(input) || typeof input.correlationId !== "string" || !CORRELATION.test(input.correlationId)) return;
    const correlationId = input.correlationId;
    const epoch = this.epoch;
    const original = this.context();
    const originalSessionId = original?.sessionManager.getSessionId();
    const originalLeafId = original?.sessionManager.getLeafId();
    const emit = (body: Record<string, unknown>): void => { this.options.events.emit(RESPONSE_EVENT, { schemaVersion: 1, correlationId, mode: "deferred", ...body }); };
    const reject = (code = "ASK_USER_INVALID_REQUEST", message = "This deferred question request is not supported.", retryable = false): void => emit({ state: "rejected", error: { code, message, retryable } });
    emit({ state: "accepted" });
    try {
      if (!this.active || this.epoch !== epoch || (input.signal instanceof AbortSignal && input.signal.aborted)) { reject("ASK_USER_PROVIDER_UNAVAILABLE", "The question provider is no longer active.", true); return; }
      const request = parseRequest(input);
      if (!request) { reject(); return; }
      const ctx = this.context();
      if (!ctx || this.running) { reject("ASK_USER_PROVIDER_UNAVAILABLE", "The question provider is temporarily unavailable.", true); return; }
      if (ctx.sessionManager !== original?.sessionManager || ctx.sessionManager.getSessionId() !== originalSessionId || (originalLeafId ? !ctx.sessionManager.getBranch().some((entry) => entry.id === originalLeafId) : ctx.sessionManager.getLeafId() !== originalLeafId)) { reject("ASK_USER_CORRELATION_CONFLICT", "The question scope changed before acceptance completed."); return; }
      this.restore(ctx);
      const fingerprint = digest(request);
      const replay = this.ownHistory(ctx).filter((entry) => receiptOf(entry.data)?.correlationId === correlationId);
      if (replay.length) {
        const entry = replay[0]!;
        const receipt = receiptOf(entry.data)!;
        if (replay.length !== 1 || receipt.fingerprint !== fingerprint || !this.onBranch(ctx, entry)) { reject("ASK_USER_CORRELATION_CONFLICT", "The request identity belongs to a different payload or branch."); return; }
        if (!this.confirmed(entry)) { reject("ASK_USER_PROVIDER_FAILURE", PERSIST_FAILURE, true); return; }
        const row = this.rows.get(entry.data.questionId);
        if (!row || row.created.data.kind !== "CREATED") { reject(); return; }
        emit(this.result(receipt, row.created.data.questionId, row.created.data.displayId));
        return;
      }
      let delta: Delta;
      let displayId: string;
      if (request.operation === "ask") {
        if (this.capacityCount() >= MAX_PENDING_QUESTIONS) { reject("ASK_USER_INVALID_REQUEST", "Question capacity is full."); return; }
        const questionId = request.correlationId.replace(/^ask_/u, "qst_");
        if (this.ownHistory(ctx).some((entry) => entry.data.questionId === questionId)) { reject("ASK_USER_CORRELATION_CONFLICT", "The question identity already exists."); return; }
        const maximum = this.ownHistory(ctx).reduce((max, entry) => entry.data.kind === "CREATED" ? Math.max(max, Number(entry.data.displayId.slice(2))) : max, 0);
        if (!Number.isSafeInteger(maximum + 1)) { reject(); return; }
        displayId = `Q-${maximum + 1}`;
        delta = { version: 1, deltaId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), questionId, revision: 1, at: this.now(), kind: "CREATED", displayId, request, receipt: { correlationId, fingerprint, operation: "ask", revision: 1 } };
      } else {
        const row = [...this.rows.values()].find((item) => item.created.data.questionId === request.id || (item.created.data.kind === "CREATED" && item.created.data.displayId === request.id));
        if (!row || row.created.data.kind !== "CREATED" || row.state !== "pending" || !row.durable || row.revision !== request.expectedRevision) { reject("ASK_USER_INVALID_REQUEST", "The question is no longer pending at that revision."); return; }
        displayId = row.created.data.displayId;
        delta = { ...this.base(ctx, row), kind: "CANCEL", notifyModel: false, receipt: { correlationId, fingerprint, operation: "cancel", revision: row.revision + 1 } };
      }
      if (!this.active || this.epoch !== epoch || (input.signal instanceof AbortSignal && input.signal.aborted)) { reject("ASK_USER_PROVIDER_UNAVAILABLE", "The question request was interrupted.", true); return; }
      if (!this.persist(ctx, delta)) { reject("ASK_USER_PROVIDER_FAILURE", PERSIST_FAILURE, true); this.sync(); return; }
      emit(this.result(receiptOf(delta)!, delta.questionId, displayId));
      this.sync();
    } catch {
      reject("ASK_USER_PROVIDER_FAILURE", "The question provider could not confirm the operation.", true);
    }
  }

  private result(receipt: ProviderReceipt, questionId: string, displayId: string): Record<string, unknown> {
    return { state: receipt.operation === "ask" ? "queued" : "cancelled", operation: receipt.operation, questionId, displayId, revision: receipt.revision };
  }
  private ownHistory(ctx: Context): OwnEntry[] { return ctx.sessionManager.getEntries().flatMap((entry) => { const own = decode(entry); return own ? [own] : []; }); }
  private onBranch(ctx: Context, entry: OwnEntry): boolean { return entry.data.sessionId === ctx.sessionManager.getSessionId() && ctx.sessionManager.getBranch().some((item) => item.id === entry.entryId); }
  private confirmed(entry: OwnEntry): boolean { return !this.diskError && this.disk?.entries.get(entry.entryId) === digest(entry.data); }
  private base(ctx: Context, row: Row): Base { return { version: 1, deltaId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), questionId: row.created.data.questionId, revision: row.revision + 1, at: this.now() }; }
  private refreshDisk(ctx: Context): void {
    const branch = ctx.sessionManager.getBranch();
    const entryIds = new Set(branch.flatMap((entry) => decode(entry) ? [entry.id] : []));
    const messageEntryIds = new Set(branch.flatMap((entry) => entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE ? [entry.id] : []));
    try { this.disk = readCurrentReceipts(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId(), { entryIds, messageEntryIds }); this.diskError = false; }
    catch { this.disk = undefined; this.diskError = true; }
  }
  private restore(ctx: Context): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const own = branch.flatMap((entry) => { const item = decode(entry); return item && item.data.sessionId === sessionId ? [item] : []; });
    // Ordinary appends (including another CREATED delta) do not establish a new scope.
    const navigated = this.lastLeafId !== undefined && this.lastLeafId !== null && !branch.some((entry) => entry.id === this.lastLeafId);
    if (sessionId !== this.scope || navigated) { this.volatileFailures.clear(); this.pendingReceiptIds.clear(); this.scope = sessionId; }
    this.lastLeafId = ctx.sessionManager.getLeafId();
    if (own.length) this.refreshDisk(ctx);
    else { this.disk = { entries: new Map(), messages: new Map() }; this.diskError = false; }
    const rows = new Map<string, Row>();
    for (const entry of own) {
      const d = entry.data;
      if (d.kind === "CREATED") {
        if (rows.has(d.questionId)) { rows.get(d.questionId)!.failure = SCOPE_FAILURE; continue; }
        rows.set(d.questionId, { created: entry, latest: entry, entries: [entry], revision: 1, state: "pending", durable: this.confirmed(entry), hidden: false, activeMs: 0, meaningfulRuns: new Set() });
        continue;
      }
      const row = rows.get(d.questionId);
      if (!row) continue;
      if (d.kind === "ACTIVITY") {
        if (d.revision !== row.revision || d.originEntryId !== row.created.entryId || row.meaningfulRuns.has(d.runId) || !this.confirmed(entry)) continue;
        row.entries.push(entry);
        row.activeMs = Math.min(Number.MAX_SAFE_INTEGER, row.activeMs + d.activeMs);
        if (d.meaningful) row.meaningfulRuns.add(d.runId);
        continue;
      }
      if (d.revision !== row.revision + 1) { row.failure = SCOPE_FAILURE; continue; }
      row.entries.push(entry); row.latest = entry; row.revision = d.revision; row.durable &&= this.confirmed(entry);
      if (d.kind === "ANSWER") {
        if (row.state !== "pending" || row.created.data.kind !== "CREATED" || !normalizeAnswer(d.answer, row.created.data.request)) { row.failure = SCOPE_FAILURE; continue; }
        row.answer = d.answer; row.source = entry; row.state = "submitted";
      } else if (d.kind === "CANCEL" || d.kind === "DISMISS") {
        if (row.state !== "pending") { row.failure = SCOPE_FAILURE; continue; }
        row.state = "cancelled"; if (d.notifyModel) row.source = entry;
      } else if (d.kind === "EXPIRE") {
        if (row.state !== "pending") { row.failure = SCOPE_FAILURE; continue; }
        row.state = "expired"; row.source = entry;
      } else if (d.kind === "HIDE") {
        if ((row.state !== "submitted" && row.state !== "delivery_failed") || !row.source) { row.failure = SCOPE_FAILURE; continue; }
        row.hidden = true;
      } else if (d.kind === "DELIVERY") {
        if (!row.source && d.status === "retry" && d.sourceId === row.created.data.deltaId && row.state === "pending") delete row.failure;
        else if (row.source?.data.deltaId === d.sourceId) {
          if (d.status === "delivered") { row.state = "delivered"; delete row.failure; }
          if (d.status === "failed") { row.state = "delivery_failed"; row.failure = DELIVERY_FAILURE; }
          if (d.status === "retry") { row.state = "submitted"; delete row.failure; }
        } else row.failure = SCOPE_FAILURE;
      }
    }
    this.rows = rows;
    for (const [owner, value] of this.editing) {
      const row = rows.get(value.questionId);
      if (!row || row.state !== "pending" || row.revision !== value.expectedRevision) this.editing.delete(owner);
    }
    for (const [id, row] of rows) {
      const waiting = this.pendingReceiptIds.get(id);
      if (row.durable && waiting && row.entries.some((entry) => entry.data.deltaId === waiting)) {
        this.volatileFailures.delete(id);
        this.pendingReceiptIds.delete(id);
      }
    }
  }
  private sameContext(ctx: Context, requiredEntry?: string): boolean {
    if (!this.active) return false;
    const current = this.context();
    return !!current && current.sessionManager === ctx.sessionManager && current.sessionManager.getSessionId() === ctx.sessionManager.getSessionId() && (!requiredEntry || current.sessionManager.getBranch().some((entry) => entry.id === requiredEntry));
  }
  private persist(ctx: Context, data: Delta): boolean {
    const epoch = this.epoch;
    const row = this.rows.get(data.questionId);
    if (ctx.sessionManager.getSessionId() !== data.sessionId || !this.sameContext(ctx, row?.latest.entryId)) return false;
    const entryData = (entry: Entry): unknown => "data" in entry ? entry.data : undefined;
    const matches = () => ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE && record(entry.data) && entry.data.deltaId === data.deltaId);
    let existing = matches();
    if (existing.length > 1 || (existing.length === 1 && digest(entryData(existing[0]!)) !== digest(data))) return false;
    if (existing.length === 0) {
      try { this.options.appendEntry(data); } catch { /* Memory may already be ahead of disk; reconcile by deterministic deltaId. */ }
    }
    if (epoch !== this.epoch || ctx.sessionManager.getSessionId() !== data.sessionId || !this.sameContext(ctx)) return false;
    let flushed = true;
    try { fsyncCurrentSessionFile(ctx.sessionManager.getSessionFile()); } catch { flushed = false; }
    this.refreshDisk(ctx);
    existing = matches();
    const found = existing.length === 1 && digest(entryData(existing[0]!)) === digest(data) ? existing[0] : undefined;
    const success = flushed && !!found && this.disk?.entries.get(found.id) === digest(data);
    if (!success) {
      this.volatileFailures.set(data.questionId, PERSIST_FAILURE);
      this.pendingReceiptIds.set(data.questionId, data.deltaId);
    } else {
      this.volatileFailures.delete(data.questionId);
      this.pendingReceiptIds.delete(data.questionId);
    }
    return success;
  }
  private message(row: Row): { customType: string; content: string; display: boolean; details: { version: number; sessionId: string; questionId: string; sourceId: string; originEntryId: string; deliveryId: string; payloadDigest: string } } {
    const created = row.created.data;
    if (created.kind !== "CREATED" || !row.source) throw new Error("Missing question source.");
    const source = row.source.data;
    const payload = source.kind === "ANSWER"
      ? { questionId: created.questionId, displayId: created.displayId, question: created.request.question, outcome: "answered", answer: row.answer, selectedOptions: created.request.response.options?.filter((option) => row.answer?.optionIds.includes(option.id)) ?? [] }
      : { questionId: created.questionId, displayId: created.displayId, question: created.request.question, outcome: source.kind === "EXPIRE" ? "expired unanswered after continued work" : "dismissed unanswered by user" };
    const content = `Deferred question update (inserted while idle; no new turn requested):\n${canonical(payload)}`;
    const deliveryId = `glance_${digest({ sessionId: created.sessionId, questionId: created.questionId, sourceId: source.deltaId })}`;
    return { customType: QUESTION_ANSWER_MESSAGE_TYPE, content, display: true, details: { version: 1, sessionId: created.sessionId, questionId: created.questionId, sourceId: source.deltaId, originEntryId: row.created.entryId, deliveryId, payloadDigest: digest(content) } };
  }
  private deliver(ctx: Context, row: Row): void {
    if (!row.source || row.failure || ctx.sessionManager.getSessionId() !== row.created.data.sessionId || !ctx.isIdle() || !this.sameContext(ctx, row.source.entryId)) return;
    const message = this.message(row);
    const markers = (): Entry[] => ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE && record(entry.details) && entry.details.deliveryId === message.details.deliveryId);
    let found = markers();
    let flushed = true;
    if (!found.length) {
      // Final scope/idle check and send are synchronous. The adapter cannot trigger a run.
      if (!ctx.isIdle() || !this.sameContext(ctx, row.source.entryId)) return;
      try { this.options.sendMessage(message); } catch { /* Reconcile even if a host listener threw after append. */ }
      try { fsyncCurrentSessionFile(ctx.sessionManager.getSessionFile()); } catch { flushed = false; }
      found = markers();
    }
    try { fsyncCurrentSessionFile(ctx.sessionManager.getSessionFile()); } catch { flushed = false; }
    if (!this.sameContext(ctx, row.source.entryId)) return;
    this.refreshDisk(ctx);
    const entry = found.length === 1 ? found[0] : undefined;
    const onBranch = !!entry && ctx.sessionManager.getBranch().some((item) => item.id === entry.id);
    const exact = entry?.type === "custom_message" && digest(entry.content) === message.details.payloadDigest && digest(entry.details) === digest(message.details);
    const disk = entry ? this.disk?.messages.get(entry.id) : undefined;
    const delivered = flushed && onBranch && exact && disk?.deliveryId === message.details.deliveryId && disk.payloadDigest === message.details.payloadDigest && disk.contentDigest === message.details.payloadDigest && disk.detailsDigest === digest(message.details);
    const data: Delta = { ...this.base(ctx, row), kind: "DELIVERY", sourceId: row.source.data.deltaId, status: delivered ? "delivered" : "failed", deliveryId: message.details.deliveryId, payloadDigest: message.details.payloadDigest, ...(delivered && entry ? { messageEntryId: entry.id } : {}) };
    this.persist(ctx, data);
    if (found.length && (!onBranch || !exact)) this.volatileFailures.set(row.created.data.questionId, SCOPE_FAILURE);
  }
}
