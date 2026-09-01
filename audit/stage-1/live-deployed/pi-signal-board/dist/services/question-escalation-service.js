import { utcNow } from '../domain/clock.js';
import { fail, signalBoardError, succeed } from '../domain/errors.js';
import { displaySequence } from '../domain/ids.js';
import { reduceBoardEvent } from '../domain/reducer.js';
/** Durable pending-to-blocking transitions owned by the agent-settled lifecycle hook. */
export class QuestionEscalationService {
    #dependencies;
    #reservedEventIds = new Map();
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    /** Enter the shared queue for callers that do not already hold the lifecycle lock. */
    escalateConditionalQuestions() {
        return this.#dependencies.queue.run(async () => {
            let now;
            try {
                now = utcNow(this.#dependencies.clock);
            }
            catch {
                return fail(internalError());
            }
            return this.escalateConditionalQuestionsLocked(now);
        });
    }
    /** Run while the caller holds the shared mutation queue. */
    async escalateConditionalQuestionsLocked(now) {
        if (!isCanonicalTimestamp(now))
            return fail(internalError());
        try {
            return await this.#escalateLocked(now);
        }
        catch {
            return fail(internalError());
        }
    }
    async #escalateLocked(now) {
        const candidates = [...this.#dependencies.readState().questions.values()]
            .filter(isEligible)
            .sort(compareQuestions)
            .map((question) => question.id);
        const accepted = [];
        for (const questionId of candidates) {
            const state = this.#dependencies.readState();
            const current = state.questions.get(questionId);
            if (current === undefined || !isEligible(current))
                continue;
            const commandId = `system:escalate:${current.id}:${current.revision}`;
            let eventId;
            try {
                eventId = this.#reservedEventIds.get(commandId) ?? this.#dependencies.ids.event();
                this.#reservedEventIds.set(commandId, eventId);
            }
            catch {
                return fail(internalError());
            }
            const event = Object.freeze({
                schemaVersion: 1,
                eventId,
                eventType: 'question.escalated',
                occurredAt: now,
                actor: 'system',
                commandId,
                payload: Object.freeze({
                    questionId: current.id,
                    expectedRevision: current.revision,
                    revision: current.revision + 1,
                    escalatedAt: now,
                }),
            });
            const reduced = reduceBoardEvent(state, event);
            if (!reduced.ok)
                return fail(signalBoardError(reduced.code));
            if (reduced.idempotent)
                continue;
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
            await this.#dependencies.afterMutation?.();
            this.#reservedEventIds.delete(commandId);
            accepted.push(event);
            await this.#postDurable(current.displayId, reduced.state, now);
        }
        return succeed(Object.freeze({ events: Object.freeze(accepted) }));
    }
    async #postDurable(displayId, state, at) {
        if (this.#dependencies.config.notifications.questionEscalated) {
            try {
                await this.#dependencies.notify(`Signals escalated ${displayId} to blocking.`, 'warning');
            }
            catch {
                this.#recordPostDurableFailure('notification', at);
            }
        }
        try {
            await this.#dependencies.refresh(state);
        }
        catch {
            this.#recordPostDurableFailure('ui', at);
        }
    }
    #recordPostDurableFailure(area, at) {
        try {
            this.#dependencies.recordPostDurableFailure?.(area, at);
        }
        catch {
            // Diagnostics cannot reverse a durable transition.
        }
    }
}
function isEligible(question) {
    return (question.status === 'pending' &&
        question.answerId === undefined &&
        question.blockingPolicy === 'when_agent_settles');
}
function compareQuestions(left, right) {
    const leftSequence = displaySequence(left.displayId) ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = displaySequence(right.displayId) ?? Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence || (left.id < right.id ? -1 : 1);
}
function isCanonicalTimestamp(value) {
    const milliseconds = Date.parse(value);
    return (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
        Number.isFinite(milliseconds) &&
        new Date(milliseconds).toISOString() === value);
}
function internalError() {
    return Object.freeze({
        code: 'SB_INTERNAL',
        message: 'Signals encountered an unexpected internal error.',
        retryable: true,
    });
}
