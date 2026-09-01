import { ANSWER_CUSTOM_TYPE } from '../constants.js';
import { utcNow } from '../domain/clock.js';
import { fail, signalBoardError, succeed } from '../domain/errors.js';
import { reduceBoardEvent } from '../domain/reducer.js';
const MAX_ID_ATTEMPTS = 128;
const INSTRUCTION = 'Process this answer once. Deduplicate by answerId and call signal_board_ack with the outcome.';
/** Deliver persisted answers at least once. The immutable answer ID is the consumer deduplication key. */
export class AnswerDeliveryService {
    #dependencies;
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    deliver(answerId) {
        return this.#dependencies.queue.run(() => this.deliverLocked(answerId));
    }
    async recoverLocked() {
        const candidates = [...this.#dependencies.readState().answers.values()]
            .filter((answer) => answer.deliveryStatus === 'recorded' || answer.deliveryStatus === 'failed')
            .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt) || left.id.localeCompare(right.id));
        const delivered = [];
        for (const answer of candidates) {
            const result = await this.deliverLocked(answer.id);
            if (!result.ok)
                return result;
            delivered.push(result.value);
        }
        return succeed(Object.freeze(delivered));
    }
    /** Use only while the shared runtime mutation queue is already held. */
    async deliverLocked(answerId) {
        const state = this.#dependencies.readState();
        const answer = state.answers.get(answerId);
        if (answer === undefined)
            return fail(signalBoardError('SB_NOT_FOUND'));
        if (answer.deliveryStatus === 'queued' || answer.deliveryStatus === 'acknowledged') {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const question = state.questions.get(answer.questionId);
        if (question === undefined || question.answerId !== answer.id) {
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        }
        const details = answerDetails(answer, question);
        const attempt = answer.deliveryAttempts.length + 1;
        let occurredAt;
        let eventId;
        try {
            occurredAt = utcNow(this.#dependencies.clock);
            eventId = allocateEventId(this.#dependencies.ids, state);
        }
        catch {
            return fail(internalError());
        }
        const commandId = `system:delivery:${answer.id}:${attempt}`;
        let sent = false;
        try {
            this.#dependencies.sendMessage({
                customType: ANSWER_CUSTOM_TYPE,
                content: JSON.stringify(details),
                display: this.#dependencies.config.debug.showAnswerMessages,
                details,
            }, { triggerTurn: true, deliverAs: question.deliveryMode });
            sent = true;
        }
        catch {
            sent = false;
        }
        const event = freezeCopy(sent
            ? {
                schemaVersion: 1,
                eventId,
                eventType: 'answer.delivery_queued',
                occurredAt,
                actor: 'system',
                commandId,
                payload: {
                    answerId: answer.id,
                    questionId: question.id,
                    attempt,
                    at: occurredAt,
                    mode: question.deliveryMode,
                },
            }
            : {
                schemaVersion: 1,
                eventId,
                eventType: 'answer.delivery_failed',
                occurredAt,
                actor: 'system',
                commandId,
                payload: {
                    answerId: answer.id,
                    questionId: question.id,
                    attempt,
                    at: occurredAt,
                    mode: question.deliveryMode,
                    errorCode: 'SB_DELIVERY_FAILED',
                    errorCategory: 'host_rejected',
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
        const current = reduced.state.answers.get(answer.id);
        if (current === undefined)
            return fail(internalError());
        try {
            await this.#dependencies.refresh(reduced.state);
        }
        catch {
            // Delivery remains durable. The board can refresh on its next boundary.
        }
        try {
            await this.#dependencies.afterMutationLocked?.();
        }
        catch {
            // Delivery remains durable. Lifecycle diagnostics own this failure.
        }
        return sent
            ? succeed(freezeCopy({ answer: current, event, details }))
            : fail(signalBoardError('SB_DELIVERY_FAILED'));
    }
}
function answerDetails(answer, question) {
    const temporaryDefault = question.temporaryDefault;
    return freezeCopy({
        schemaVersion: 1,
        answerId: answer.id,
        questionId: question.id,
        questionDisplayId: question.displayId,
        questionRevision: answer.questionRevision,
        question: question.question,
        answer: normalizeAnswer(answer.value, question),
        answeredAt: answer.answeredAt,
        ...(temporaryDefault === undefined
            ? {}
            : {
                temporaryDefault: {
                    ...temporaryDefault,
                    conflictsWithAnswer: conflictsWithDefault(answer.value, temporaryDefault.optionIds),
                },
            }),
        instruction: INSTRUCTION,
    });
}
function normalizeAnswer(value, question) {
    const label = (id) => question.response.options?.find((option) => option.id === id)?.label ?? id;
    switch (value.kind) {
        case 'single':
            return { kind: value.kind, optionId: value.optionId, optionLabel: label(value.optionId) };
        case 'multiple':
            return {
                kind: value.kind,
                options: value.optionIds.map((optionId) => ({ optionId, optionLabel: label(optionId) })),
            };
        case 'text':
            return value;
        case 'single_or_text':
            return {
                kind: value.kind,
                ...(value.optionId === undefined
                    ? {}
                    : { optionId: value.optionId, optionLabel: label(value.optionId) }),
                ...(value.text === undefined ? {} : { text: value.text }),
            };
        case 'multiple_or_text':
            return {
                kind: value.kind,
                options: value.optionIds.map((optionId) => ({ optionId, optionLabel: label(optionId) })),
                ...(value.text === undefined ? {} : { text: value.text }),
            };
    }
}
function conflictsWithDefault(value, defaultIds) {
    const selected = value.kind === 'single' || value.kind === 'single_or_text'
        ? value.optionId === undefined
            ? []
            : [value.optionId]
        : value.kind === 'multiple' || value.kind === 'multiple_or_text'
            ? value.optionIds
            : [];
    return (selected.length !== defaultIds.length || selected.some((id, index) => id !== defaultIds[index]));
}
function allocateEventId(ids, state) {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
        const id = ids.event();
        if (!state.acceptedEventIds.has(id))
            return id;
    }
    throw new Error('Event ID collision limit reached.');
}
function internalError() {
    return Object.freeze({
        code: 'SB_INTERNAL',
        message: 'Signals encountered an unexpected internal error.',
        retryable: true,
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
