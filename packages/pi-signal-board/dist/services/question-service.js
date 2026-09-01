import { utcNow } from '../domain/clock.js';
import { ERROR_DEFINITIONS, fail, fieldError, signalBoardError, succeed, } from '../domain/errors.js';
import { isCommandId, isQuestionId, questionDisplayId } from '../domain/ids.js';
import { isFiniteUtcTimestamp, sameSemanticValue } from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
import { selectActionableQuestions } from '../domain/selectors.js';
import { guardUnsafeQuestion, normalizeCreateQuestionSpec, normalizeReviseQuestionSpec, } from '../questions/validation/index.js';
const DISPLAY_ID = /^Q-[1-9][0-9]*$/u;
/** Durable create, full-replacement revise, and cancel service for agent questions. */
export class QuestionService {
    #dependencies;
    #reservedEventId;
    #reservedQuestionId;
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    createQuestion(command) {
        return this.#dependencies.queue.run(() => this.#createLocked(command));
    }
    reviseQuestion(command) {
        return this.#dependencies.queue.run(() => this.#reviseLocked(command));
    }
    cancelQuestion(command) {
        return this.#dependencies.queue.run(() => this.#cancelLocked(command));
    }
    dismissQuestion(command) {
        return this.#dependencies.queue.run(() => this.dismissQuestionLocked(command));
    }
    /** Use only while the shared runtime mutation queue is already held. */
    dismissQuestionLocked(command) {
        return this.#dismissLocked(command);
    }
    async #createLocked(command) {
        const commandError = validateToolCommandId(command.commandId);
        if (commandError !== undefined)
            return commandError;
        const state = this.#dependencies.readState();
        const prior = state.commandResults.get(command.commandId);
        if (prior !== undefined)
            return this.#resolvePriorCreate(state, command, prior);
        let occurredAt;
        try {
            occurredAt = utcNow(this.#dependencies.clock);
        }
        catch {
            return fail(internalError());
        }
        const spec = this.#normalizeCreate(command, occurredAt);
        if (!spec.ok)
            return spec;
        const safe = guardUnsafeQuestion(spec.value);
        if (!safe.ok)
            return safe;
        if (selectActionableQuestions(state).length >=
            this.#dependencies.config.limits.maxActionableQuestions) {
            return fail(signalBoardError('SB_LIMIT_EXCEEDED'));
        }
        const rate = this.#checkRate();
        if (!rate.ok)
            return rate;
        let eventId;
        let questionId;
        try {
            eventId = this.#reserveEventId();
            questionId = this.#reserveQuestionId();
        }
        catch {
            return fail(internalError());
        }
        const event = freezeCopy({
            schemaVersion: 1,
            eventId,
            eventType: 'question.created',
            occurredAt,
            actor: 'agent',
            commandId: command.commandId,
            payload: {
                questionId,
                displayId: questionDisplayId(state.counters.nextQuestion),
                revision: 1,
                createdAt: occurredAt,
                spec: safe.value,
            },
        });
        return this.#persistLocked(state, event, true);
    }
    async #reviseLocked(command) {
        const basic = validateMutationCommand(command.commandId, command.id, command.expectedRevision);
        if (!basic.ok)
            return basic;
        const state = this.#dependencies.readState();
        const prior = state.commandResults.get(command.commandId);
        if (prior !== undefined)
            return this.#resolvePriorRevise(state, command, prior);
        const current = resolveQuestion(state, command.id);
        if (!current.ok)
            return current;
        if (current.value === undefined)
            return fail(signalBoardError('SB_NOT_FOUND'));
        if (command.expectedRevision !== current.value.revision) {
            return fail(signalBoardError('SB_REVISION_MISMATCH'));
        }
        if (!isAnswerable(current.value))
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        let occurredAt;
        try {
            occurredAt = utcNow(this.#dependencies.clock);
        }
        catch {
            return fail(internalError());
        }
        const spec = this.#normalizeRevise(command, occurredAt);
        if (!spec.ok)
            return spec;
        const summary = sanitizeRequired(command.revisionSummary, TEXT_FIELD_POLICIES.revisionSummary, 'revisionSummary');
        if (!summary.ok)
            return summary;
        const safe = guardUnsafeQuestion(spec.value);
        if (!safe.ok)
            return safe;
        if (sameSemanticValue(questionSemantic(current.value), safe.value)) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const rate = this.#checkRate();
        if (!rate.ok)
            return rate;
        let eventId;
        try {
            eventId = this.#reserveEventId();
        }
        catch {
            return fail(internalError());
        }
        const event = freezeCopy({
            schemaVersion: 1,
            eventId,
            eventType: 'question.revised',
            occurredAt,
            actor: 'agent',
            commandId: command.commandId,
            payload: {
                questionId: current.value.id,
                expectedRevision: command.expectedRevision,
                revision: command.expectedRevision + 1,
                updatedAt: occurredAt,
                revisionSummary: summary.value,
                spec: safe.value,
            },
        });
        return this.#persistLocked(state, event, false);
    }
    async #cancelLocked(command) {
        const basic = validateMutationCommand(command.commandId, command.id, command.expectedRevision);
        if (!basic.ok)
            return basic;
        const state = this.#dependencies.readState();
        const prior = state.commandResults.get(command.commandId);
        if (prior !== undefined)
            return this.#resolvePriorCancel(state, command, prior);
        const current = resolveQuestion(state, command.id);
        if (!current.ok)
            return current;
        if (current.value === undefined)
            return fail(signalBoardError('SB_NOT_FOUND'));
        if (command.expectedRevision !== current.value.revision) {
            return fail(signalBoardError('SB_REVISION_MISMATCH'));
        }
        if (!isAnswerable(current.value))
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const reason = sanitizeRequired(command.reason, TEXT_FIELD_POLICIES.transitionReason, 'reason');
        if (!reason.ok)
            return reason;
        const rate = this.#checkRate();
        if (!rate.ok)
            return rate;
        let occurredAt;
        let eventId;
        try {
            occurredAt = utcNow(this.#dependencies.clock);
            eventId = this.#reserveEventId();
        }
        catch {
            return fail(internalError());
        }
        const event = freezeCopy({
            schemaVersion: 1,
            eventId,
            eventType: 'question.cancelled',
            occurredAt,
            actor: 'agent',
            commandId: command.commandId,
            payload: {
                questionId: current.value.id,
                expectedRevision: command.expectedRevision,
                revision: command.expectedRevision + 1,
                cancelledAt: occurredAt,
                reason: reason.value,
            },
        });
        return this.#persistLocked(state, event, false);
    }
    async #dismissLocked(command) {
        const basic = validateUserMutationCommand(command.commandId, command.id, command.expectedRevision);
        if (!basic.ok)
            return basic;
        if (!isFiniteUtcTimestamp(command.dismissedAt) ||
            command.reason !== 'user_dismissed' ||
            command.source !== 'board') {
            return invalid('dismissal', 'invalid_value');
        }
        const state = this.#dependencies.readState();
        const prior = state.commandResults.get(command.commandId);
        if (prior !== undefined)
            return this.#resolvePriorDismiss(state, command, prior);
        const current = resolveQuestion(state, command.id);
        if (!current.ok)
            return current;
        if (current.value === undefined)
            return fail(signalBoardError('SB_NOT_FOUND'));
        if (command.expectedRevision !== current.value.revision) {
            return fail(signalBoardError('SB_REVISION_MISMATCH'));
        }
        if (!isAnswerable(current.value))
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        let eventId;
        try {
            eventId = this.#reserveEventId();
        }
        catch {
            return fail(internalError());
        }
        const event = freezeCopy({
            schemaVersion: 1,
            eventId,
            eventType: 'question.dismissed',
            occurredAt: command.dismissedAt,
            actor: 'user',
            commandId: command.commandId,
            payload: {
                questionId: current.value.id,
                expectedRevision: command.expectedRevision,
                revision: command.expectedRevision + 1,
                dismissedAt: command.dismissedAt,
            },
        });
        return this.#persistLocked(state, event, false, false);
    }
    async #persistLocked(state, event, created, commitRate = true) {
        const reduced = reduceBoardEvent(state, event);
        if (!reduced.ok)
            return fail(signalBoardError(reduced.code));
        if (reduced.idempotent)
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        let appended;
        try {
            appended = await this.#dependencies.append(event);
        }
        catch {
            return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
        }
        if (!appended.ok)
            return appended;
        this.#dependencies.swapState(reduced.state);
        if (commitRate)
            this.#dependencies.rateCounter.commit();
        this.#reservedEventId = undefined;
        if (created)
            this.#reservedQuestionId = undefined;
        const item = reduced.state.questions.get(event.payload.questionId);
        if (item === undefined)
            return fail(internalError());
        const result = frozenResult(item, event, false);
        let refreshFailed = false;
        try {
            await this.#dependencies.refresh(reduced.state);
        }
        catch {
            refreshFailed = true;
        }
        try {
            await this.#dependencies.afterMutationLocked?.();
        }
        catch {
            // The accepted question remains durable and exposed. Lifecycle diagnostics own the error.
        }
        return refreshFailed ? fail(signalBoardError('SB_UI_UNAVAILABLE')) : succeed(result);
    }
    #resolvePriorCreate(state, command, prior) {
        if (prior.eventType !== 'question.created')
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const payload = prior.semanticPayload;
        const normalized = this.#normalizeCreate(command, payload.createdAt);
        if (!normalized.ok || !sameSemanticValue(normalized.value, payload.spec)) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const current = state.questions.get(payload.questionId);
        if (current === undefined)
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const event = createdEventFromPrior(command.commandId, prior.eventId, payload);
        return succeed(frozenResult(current, event, true));
    }
    #resolvePriorRevise(state, command, prior) {
        if (prior.eventType !== 'question.revised')
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const payload = prior.semanticPayload;
        const current = state.questions.get(payload.questionId);
        const summary = sanitizeRequired(command.revisionSummary, TEXT_FIELD_POLICIES.revisionSummary, 'revisionSummary');
        const normalized = this.#normalizeRevise(command, payload.updatedAt);
        if (current === undefined ||
            !lookupMatches(command.id, current) ||
            command.expectedRevision !== payload.expectedRevision ||
            !summary.ok ||
            summary.value !== payload.revisionSummary ||
            !normalized.ok ||
            !sameSemanticValue(normalized.value, payload.spec)) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const event = revisedEventFromPrior(command.commandId, prior.eventId, payload);
        return succeed(frozenResult(current, event, true));
    }
    #resolvePriorCancel(state, command, prior) {
        if (prior.eventType !== 'question.cancelled')
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const payload = prior.semanticPayload;
        const current = state.questions.get(payload.questionId);
        const reason = sanitizeRequired(command.reason, TEXT_FIELD_POLICIES.transitionReason, 'reason');
        if (current === undefined ||
            !lookupMatches(command.id, current) ||
            command.expectedRevision !== payload.expectedRevision ||
            !reason.ok ||
            reason.value !== payload.reason) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const event = cancelledEventFromPrior(command.commandId, prior.eventId, payload);
        return succeed(frozenResult(current, event, true));
    }
    #resolvePriorDismiss(state, command, prior) {
        if (prior.eventType !== 'question.dismissed') {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const payload = prior.semanticPayload;
        const current = state.questions.get(payload.questionId);
        if (current === undefined ||
            !lookupMatches(command.id, current) ||
            command.expectedRevision !== payload.expectedRevision ||
            command.dismissedAt !== payload.dismissedAt ||
            command.reason !== 'user_dismissed' ||
            command.source !== 'board') {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const event = dismissedEventFromPrior(command.commandId, prior.eventId, payload);
        return succeed(frozenResult(current, event, true));
    }
    #normalizeCreate(command, now) {
        return normalizeCreateQuestionSpec(command, {
            config: this.#dependencies.config,
            cwd: this.#dependencies.cwd,
            currentTimestamp: now,
        });
    }
    #normalizeRevise(command, now) {
        return normalizeReviseQuestionSpec(command, {
            config: this.#dependencies.config,
            cwd: this.#dependencies.cwd,
            currentTimestamp: now,
        });
    }
    #checkRate() {
        return this.#dependencies.rateCounter.check(this.#dependencies.config.limits.maxQuestionMutationsPerTurn);
    }
    #reserveEventId() {
        this.#reservedEventId ??= this.#dependencies.ids.event();
        return this.#reservedEventId;
    }
    #reserveQuestionId() {
        this.#reservedQuestionId ??= this.#dependencies.ids.question();
        return this.#reservedQuestionId;
    }
}
function resolveQuestion(state, id) {
    if (typeof id !== 'string' || (!isQuestionId(id) && !DISPLAY_ID.test(id))) {
        return invalid('id', 'invalid_value');
    }
    return succeed(isQuestionId(id)
        ? state.questions.get(id)
        : [...state.questions.values()].find((item) => item.displayId === id));
}
function validateMutationCommand(commandId, id, expectedRevision) {
    const commandError = validateToolCommandId(commandId);
    if (commandError !== undefined)
        return commandError;
    if (typeof id !== 'string' || (!isQuestionId(id) && !DISPLAY_ID.test(id))) {
        return invalid('id', 'invalid_value');
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        return invalid('expectedRevision', 'out_of_range');
    }
    return succeed(undefined);
}
function validateToolCommandId(commandId) {
    return isCommandId(commandId) && commandId.startsWith('tool:')
        ? undefined
        : invalid('commandId', 'invalid_value');
}
function validateUserMutationCommand(commandId, id, expectedRevision) {
    if (!isCommandId(commandId) || !commandId.startsWith('ui:')) {
        return invalid('commandId', 'invalid_value');
    }
    if (typeof id !== 'string' || (!isQuestionId(id) && !DISPLAY_ID.test(id))) {
        return invalid('id', 'invalid_value');
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        return invalid('expectedRevision', 'out_of_range');
    }
    return succeed(undefined);
}
function isAnswerable(item) {
    return (item.status === 'pending' || item.status === 'blocking') && item.answerId === undefined;
}
function lookupMatches(id, item) {
    return id === item.id || id === item.displayId;
}
function questionSemantic(item) {
    return {
        question: item.question,
        reason: item.reason,
        class: item.class,
        response: item.response,
        ...(item.recommendation === undefined ? {} : { recommendation: item.recommendation }),
        recommendedOptionIds: item.recommendedOptionIds,
        ...(item.recommendedText === undefined ? {} : { recommendedText: item.recommendedText }),
        ...(item.temporaryDefault === undefined ? {} : { temporaryDefault: item.temporaryDefault }),
        priority: item.priority,
        blockingPolicy: item.blockingPolicy,
        deliveryMode: item.deliveryMode,
        affectedWork: item.affectedWork,
        continuingWork: item.continuingWork,
        attachments: item.attachments,
        ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
    };
}
function createdEventFromPrior(commandId, eventId, payload) {
    return freezeCopy({
        schemaVersion: 1,
        eventId,
        eventType: 'question.created',
        occurredAt: payload.createdAt,
        actor: 'agent',
        commandId,
        payload,
    });
}
function revisedEventFromPrior(commandId, eventId, payload) {
    return freezeCopy({
        schemaVersion: 1,
        eventId,
        eventType: 'question.revised',
        occurredAt: payload.updatedAt,
        actor: 'agent',
        commandId,
        payload,
    });
}
function dismissedEventFromPrior(commandId, eventId, payload) {
    return freezeCopy({
        schemaVersion: 1,
        eventId,
        eventType: 'question.dismissed',
        occurredAt: payload.dismissedAt,
        actor: 'user',
        commandId,
        payload,
    });
}
function cancelledEventFromPrior(commandId, eventId, payload) {
    return freezeCopy({
        schemaVersion: 1,
        eventId,
        eventType: 'question.cancelled',
        occurredAt: payload.cancelledAt,
        actor: 'agent',
        commandId,
        payload,
    });
}
function sanitizeRequired(value, policy, path) {
    if (typeof value !== 'string')
        return invalid(path, value === undefined ? 'required' : 'invalid_type');
    const normalized = sanitizeText(value, policy);
    if (normalized.ok)
        return succeed(normalized.value);
    return invalid(path, normalized.reason === 'empty'
        ? 'required'
        : normalized.reason === 'too_long'
            ? 'too_long'
            : 'invalid_value');
}
function frozenResult(item, event, noOp) {
    return freezeCopy({ item, event, noOp });
}
function invalid(path, reason) {
    return fail(signalBoardError('SB_INVALID_ARGUMENT', [fieldError(path, reason)]));
}
function internalError() {
    const definition = ERROR_DEFINITIONS.SB_INTERNAL;
    return Object.freeze({
        code: 'SB_INTERNAL',
        message: definition.message,
        retryable: definition.retryable,
    });
}
function freezeCopy(value) {
    if (typeof value !== 'object' || value === null)
        return value;
    if (Array.isArray(value))
        return Object.freeze(value.map((item) => freezeCopy(item)));
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
        if (child !== undefined)
            copy[key] = freezeCopy(child);
    }
    return Object.freeze(copy);
}
