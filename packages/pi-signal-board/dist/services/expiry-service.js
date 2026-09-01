import { fail, signalBoardError } from '../domain/errors.js';
import { reduceBoardEvent } from '../domain/reducer.js';
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const EXPIRY_REASON = 'Question expiry elapsed.';
/** Durable expiry transitions and nearest-expiry timer decisions. */
export class ExpiryService {
    #dependencies;
    #reservedEventIds = new Map();
    #timer;
    #timerGeneration = 0;
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    /** Evaluate through the one shared mutation queue. */
    evaluateExpiry(now) {
        return this.#dependencies.queue.run(() => this.evaluateExpiryLocked(now));
    }
    /** Callable boundary for the future board-open command. */
    evaluateBoardOpen() {
        return this.#dependencies.queue.run(() => this.evaluateExpiryLocked(this.#dependencies.clock.now()));
    }
    /** Evaluate while the caller already owns the shared mutation queue. */
    async evaluateExpiryLocked(now) {
        const evaluatedAt = canonicalTimestamp(now);
        const evaluatedAtMs = Date.parse(evaluatedAt);
        const candidates = expiryCandidates(this.#dependencies.readState(), evaluatedAtMs);
        let transitioned = 0;
        let skipped = 0;
        let failed = 0;
        for (const candidate of candidates) {
            const current = this.#dependencies.readState().questions.get(candidate.questionId);
            if (!matchesCandidate(current, candidate, evaluatedAtMs)) {
                skipped += 1;
                continue;
            }
            const commandId = `system:stale:${current.id}:${current.revision}`;
            let eventId;
            try {
                eventId = this.#reservedEventIds.get(commandId) ?? this.#dependencies.ids.event();
                this.#reservedEventIds.set(commandId, eventId);
            }
            catch {
                failed += 1;
                this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
                continue;
            }
            const event = freezeCopy({
                schemaVersion: 1,
                eventId,
                eventType: 'question.staled',
                occurredAt: evaluatedAt,
                actor: 'system',
                commandId,
                payload: {
                    questionId: current.id,
                    expectedRevision: current.revision,
                    revision: current.revision + 1,
                    staleAt: evaluatedAt,
                    reason: EXPIRY_REASON,
                },
            });
            const reduced = reduceBoardEvent(this.#dependencies.readState(), event);
            if (!reduced.ok || reduced.idempotent) {
                skipped += 1;
                continue;
            }
            let appended;
            try {
                appended = await this.#dependencies.append(event);
            }
            catch {
                appended = fail(signalBoardError('SB_PERSISTENCE_FAILED'));
            }
            if (!appended.ok) {
                failed += 1;
                this.#record({ code: 'SB_PERSISTENCE_FAILED', category: 'append_rejected' });
                continue;
            }
            this.#dependencies.swapState(reduced.state);
            await this.#dependencies.afterMutation?.();
            this.#reservedEventIds.delete(commandId);
            transitioned += 1;
            try {
                await this.#dependencies.refresh(reduced.state);
            }
            catch {
                this.#record({ code: 'SB_UI_UNAVAILABLE', category: 'ui_failure' });
            }
        }
        return Object.freeze({ evaluatedAt, transitioned, skipped, failed });
    }
    /** Arm one timer for the nearest future answerable question. */
    armNearestTimerLocked(callback) {
        this.clearTimerLocked();
        let nowMs;
        try {
            nowMs = this.#dependencies.clock.now().getTime();
        }
        catch {
            this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
            return undefined;
        }
        if (!Number.isFinite(nowMs)) {
            this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
            return undefined;
        }
        const nearest = nearestFutureExpiry(this.#dependencies.readState(), nowMs);
        if (nearest === undefined)
            return undefined;
        const generation = ++this.#timerGeneration;
        const delayMs = Math.min(MAX_TIMER_DELAY_MS, nearest - nowMs);
        try {
            const handle = this.#dependencies.timers.setTimeout(async () => {
                if (generation !== this.#timerGeneration)
                    return;
                this.#timer = undefined;
                try {
                    await callback();
                }
                catch {
                    this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
                }
            }, delayMs);
            this.#timer = handle;
            unrefTimer(this.#dependencies.timers, handle);
            return handle;
        }
        catch {
            this.#timer = undefined;
            this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
            return undefined;
        }
    }
    /** Clear timer ownership before replay, replacement, or shutdown. */
    clearTimerLocked() {
        this.#timerGeneration += 1;
        const handle = this.#timer;
        this.#timer = undefined;
        if (handle === undefined)
            return;
        try {
            this.#dependencies.timers.clearTimeout(handle);
        }
        catch {
            // Cleanup is best-effort. No board content enters diagnostics.
        }
    }
    #record(record) {
        try {
            this.#dependencies.recordDiagnostic(Object.freeze(record));
        }
        catch {
            // Diagnostics must not break lifecycle work.
        }
    }
}
function expiryCandidates(state, nowMs) {
    return [...state.questions.values()]
        .filter(isAnswerableWithExpiry)
        .map((question) => ({
        questionId: question.id,
        revision: question.revision,
        expiresAt: question.expiresAt,
        expiresAtMs: Date.parse(question.expiresAt),
    }))
        .filter((candidate) => Number.isFinite(candidate.expiresAtMs) && candidate.expiresAtMs <= nowMs)
        .sort((left, right) => left.expiresAtMs - right.expiresAtMs ||
        (left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0));
}
function nearestFutureExpiry(state, nowMs) {
    let nearest;
    for (const question of state.questions.values()) {
        if (!isAnswerableWithExpiry(question))
            continue;
        const value = Date.parse(question.expiresAt);
        if (!Number.isFinite(value) || value <= nowMs)
            continue;
        if (nearest === undefined || value < nearest)
            nearest = value;
    }
    return nearest;
}
function isAnswerableWithExpiry(question) {
    return ((question.status === 'pending' || question.status === 'blocking') &&
        question.answerId === undefined &&
        question.expiresAt !== undefined);
}
function matchesCandidate(question, candidate, nowMs) {
    return (question !== undefined &&
        isAnswerableWithExpiry(question) &&
        question.revision === candidate.revision &&
        question.expiresAt === candidate.expiresAt &&
        Date.parse(question.expiresAt) <= nowMs);
}
function canonicalTimestamp(now) {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp))
        throw new TypeError('Expiry evaluation requires a valid time.');
    return new Date(timestamp).toISOString();
}
function unrefTimer(timers, handle) {
    try {
        if (timers.unref !== undefined) {
            timers.unref(handle);
            return;
        }
        if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
            const unref = handle.unref;
            if (typeof unref === 'function')
                unref.call(handle);
        }
    }
    catch {
        // unref is an optional process-liveness optimization.
    }
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
