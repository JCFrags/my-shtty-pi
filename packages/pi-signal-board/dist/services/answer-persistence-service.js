import { utcNow } from '../domain/clock.js';
import { ERROR_DEFINITIONS, fail, fieldError, signalBoardError, succeed, } from '../domain/errors.js';
import { isCommandId, isQuestionId } from '../domain/ids.js';
import { answerMatchesRecommendation, sameSemanticValue, validAnswerValue, } from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
const MAX_ID_ATTEMPTS = 128;
/** Persist one validated answer before any later delivery operation can start. */
export class AnswerPersistenceService {
    #dependencies;
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    answerQuestion(command) {
        return this.#dependencies.queue.run(() => this.answerQuestionLocked(command));
    }
    /** Use only while the shared runtime mutation queue is already held. */
    async answerQuestionLocked(command) {
        const basic = validateCommand(command);
        if (!basic.ok)
            return basic;
        const state = this.#dependencies.readState();
        const question = state.questions.get(command.questionId);
        if (question === undefined)
            return fail(signalBoardError('SB_NOT_FOUND'));
        if (command.expectedRevision !== question.revision) {
            return fail(signalBoardError('SB_REVISION_MISMATCH'));
        }
        const normalized = normalizeAnswerValue(command.value, question);
        if (!normalized.ok)
            return normalized;
        if (command.source === 'recommendation' &&
            !answerMatchesRecommendation(normalized.value, question)) {
            return invalid('value', 'invalid_value');
        }
        const priorByCommand = state.commandResults.get(command.commandId);
        if (priorByCommand !== undefined) {
            return this.#resolvePriorCommand(state, command, normalized.value, priorByCommand);
        }
        if (question.answerId !== undefined) {
            return this.#resolveExistingAnswer(state, question, command, normalized.value);
        }
        if (!isAnswerable(question))
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        let answeredAt;
        let answerId;
        let eventId;
        try {
            answeredAt = utcNow(this.#dependencies.clock);
            answerId = allocateAnswerId(this.#dependencies.ids, state);
            eventId = allocateEventId(this.#dependencies.ids, state);
        }
        catch {
            return fail(internalError());
        }
        const event = freezeCopy({
            schemaVersion: 1,
            eventId,
            eventType: 'question.answered',
            occurredAt: answeredAt,
            actor: 'user',
            commandId: command.commandId,
            payload: {
                questionId: question.id,
                expectedRevision: command.expectedRevision,
                answer: {
                    id: answerId,
                    questionId: question.id,
                    questionDisplayId: question.displayId,
                    questionRevision: question.revision,
                    source: command.source,
                    value: normalized.value,
                    answeredAt,
                },
            },
        });
        const reduced = reduceBoardEvent(state, event);
        if (!reduced.ok || reduced.idempotent) {
            return fail(signalBoardError(reduced.ok ? 'SB_STATE_CONFLICT' : reduced.code));
        }
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
        const answer = reduced.state.answers.get(answerId);
        if (answer === undefined)
            return fail(internalError());
        const result = resultFor(answer, event, false, question.deliveryMode);
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
            // The accepted answer remains durable. Lifecycle diagnostics own this failure.
        }
        return refreshFailed ? fail(signalBoardError('SB_UI_UNAVAILABLE')) : succeed(result);
    }
    #resolvePriorCommand(state, command, value, prior) {
        if (prior.eventType !== 'question.answered')
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const payload = prior.semanticPayload;
        if (payload.questionId !== command.questionId ||
            payload.expectedRevision !== command.expectedRevision ||
            payload.answer.source !== command.source ||
            !sameSemanticValue(payload.answer.value, value)) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const answer = state.answers.get(payload.answer.id);
        const question = state.questions.get(payload.questionId);
        if (answer === undefined || question === undefined) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        return succeed(resultFor(answer, eventFromPrior(command.commandId, prior.eventId, payload), true, question.deliveryMode));
    }
    #resolveExistingAnswer(state, question, command, value) {
        const answer = state.answers.get(question.answerId);
        if (answer === undefined ||
            answer.questionRevision !== command.expectedRevision ||
            answer.source !== command.source ||
            !sameSemanticValue(answer.value, value)) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const original = findAnswerEvent(state, answer);
        if (original === undefined)
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        return succeed(resultFor(answer, original, true, question.deliveryMode));
    }
}
function validateCommand(command) {
    if (!isCommandId(command.commandId) || !command.commandId.startsWith('ui:')) {
        return invalid('commandId', 'invalid_value');
    }
    if (!isQuestionId(command.questionId))
        return invalid('questionId', 'invalid_value');
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
        return invalid('expectedRevision', 'out_of_range');
    }
    if (command.source !== 'manual' && command.source !== 'recommendation') {
        return invalid('source', 'unsupported');
    }
    return succeed(undefined);
}
function normalizeAnswerValue(value, question) {
    if (!isRecord(value) || value.kind !== question.response.kind) {
        return invalid('value.kind', 'invalid_value');
    }
    let normalized;
    switch (value.kind) {
        case 'single': {
            if (!exact(value, ['kind', 'optionId']) || typeof value.optionId !== 'string') {
                return invalid('value.optionId', 'invalid_value');
            }
            normalized = { kind: 'single', optionId: value.optionId };
            break;
        }
        case 'multiple': {
            if (!exact(value, ['kind', 'optionIds']))
                return invalid('value', 'invalid_value');
            const ids = normalizeOptionIds(value.optionIds, question, true);
            if (!ids.ok || ids.value.length === 0)
                return invalid('value.optionIds', 'invalid_value');
            normalized = { kind: 'multiple', optionIds: ids.value };
            break;
        }
        case 'text': {
            if (!exact(value, ['kind', 'text']))
                return invalid('value', 'invalid_value');
            const text = normalizeText(value.text);
            if (!text.ok)
                return text;
            normalized = { kind: 'text', text: text.value };
            break;
        }
        case 'single_or_text': {
            if (!exact(value, ['kind'], ['optionId', 'text']))
                return invalid('value', 'invalid_value');
            const optionId = value.optionId;
            if (optionId !== undefined && typeof optionId !== 'string') {
                return invalid('value.optionId', 'invalid_value');
            }
            const text = value.text === undefined
                ? succeed(undefined)
                : normalizeText(value.text);
            if (!text.ok)
                return text;
            if (optionId === undefined && text.value === undefined)
                return invalid('value', 'required');
            normalized = {
                kind: 'single_or_text',
                ...(optionId === undefined ? {} : { optionId: optionId }),
                ...(text.value === undefined ? {} : { text: text.value }),
            };
            break;
        }
        case 'multiple_or_text': {
            if (!exact(value, ['kind', 'optionIds'], ['text']))
                return invalid('value', 'invalid_value');
            const ids = normalizeOptionIds(value.optionIds, question, false);
            if (!ids.ok)
                return ids;
            const text = value.text === undefined
                ? succeed(undefined)
                : normalizeText(value.text);
            if (!text.ok)
                return text;
            if (ids.value.length === 0 && text.value === undefined)
                return invalid('value', 'required');
            normalized = {
                kind: 'multiple_or_text',
                optionIds: ids.value,
                ...(text.value === undefined ? {} : { text: text.value }),
            };
            break;
        }
        default:
            return invalid('value.kind', 'unsupported');
    }
    return validAnswerValue(normalized, question)
        ? succeed(freezeCopy(normalized))
        : invalid('value', 'invalid_value');
}
function normalizeOptionIds(input, question, requireOne) {
    if (!Array.isArray(input) || (requireOne && input.length === 0) || input.length > 8) {
        return invalid('value.optionIds', 'invalid_value');
    }
    if (input.some((id) => typeof id !== 'string') || new Set(input).size !== input.length) {
        return invalid('value.optionIds', 'invalid_value');
    }
    const supplied = new Set(input);
    const options = question.response.options ?? [];
    if ([...supplied].some((id) => !options.some((option) => option.id === id))) {
        return invalid('value.optionIds', 'invalid_value');
    }
    return succeed(Object.freeze(options.filter((option) => supplied.has(option.id)).map((option) => option.id)));
}
function normalizeText(input) {
    if (typeof input !== 'string')
        return invalid('value.text', 'invalid_type');
    const normalized = sanitizeText(input, TEXT_FIELD_POLICIES.answerText);
    if (!normalized.ok) {
        return invalid('value.text', normalized.reason === 'empty'
            ? 'required'
            : normalized.reason === 'too_long'
                ? 'too_long'
                : 'invalid_value');
    }
    return succeed(normalized.value);
}
function allocateAnswerId(ids, state) {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
        const id = ids.answer();
        if (!state.answers.has(id))
            return id;
    }
    throw new Error('Answer ID collision limit reached.');
}
function allocateEventId(ids, state) {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
        const id = ids.event();
        if (!state.acceptedEventIds.has(id))
            return id;
    }
    throw new Error('Event ID collision limit reached.');
}
function findAnswerEvent(state, answer) {
    for (const [commandId, result] of state.commandResults) {
        if (result.eventType !== 'question.answered' || result.eventId !== answer.lastEventId)
            continue;
        const payload = result.semanticPayload;
        if (payload.answer.id === answer.id)
            return eventFromPrior(commandId, result.eventId, payload);
    }
    return undefined;
}
function eventFromPrior(commandId, eventId, payload) {
    return freezeCopy({
        schemaVersion: 1,
        eventId,
        eventType: 'question.answered',
        occurredAt: payload.answer.answeredAt,
        actor: 'user',
        commandId,
        payload,
    });
}
function resultFor(answer, event, noOp, mode) {
    return freezeCopy({
        answer,
        event,
        delivery: {
            answerId: answer.id,
            questionId: answer.questionId,
            questionRevision: answer.questionRevision,
            value: answer.value,
            source: answer.source,
            status: 'recorded',
            mode,
        },
        noOp,
    });
}
function isAnswerable(question) {
    return ((question.status === 'pending' || question.status === 'blocking') &&
        question.answerId === undefined);
}
function invalid(path, reason) {
    return fail(signalBoardError('SB_INVALID_ARGUMENT', [fieldError(path, reason)]));
}
function internalError() {
    return Object.freeze({
        code: 'SB_INTERNAL',
        message: ERROR_DEFINITIONS.SB_INTERNAL.message,
        retryable: ERROR_DEFINITIONS.SB_INTERNAL.retryable,
    });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value, required, optional = []) {
    const allowed = new Set([...required, ...optional]);
    return (required.every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => allowed.has(key)));
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
