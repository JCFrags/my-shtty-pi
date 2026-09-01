import { utcNow } from '../domain/clock.js';
import { fail, signalBoardError, succeed } from '../domain/errors.js';
import { isFiniteUtcTimestamp } from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { selectCatchUp } from '../domain/selectors.js';
/** Persist the fixed board-open cutoff only when it acknowledges a semantic visible change. */
export class BoardViewCheckpointService {
    #dependencies;
    #reservations = new Map();
    constructor(dependencies) {
        this.#dependencies = dependencies;
    }
    markViewed(command) {
        return this.#dependencies.queue.run(() => this.markViewedLocked(command));
    }
    /** Use this method only while the caller owns the shared runtime queue. */
    async markViewedLocked(command) {
        if (!isFiniteUtcTimestamp(command.cutoffAt)) {
            return fail(signalBoardError('SB_INVALID_ARGUMENT'));
        }
        const state = this.#dependencies.readState();
        if ((state.lastViewedAt !== undefined && command.cutoffAt <= state.lastViewedAt) ||
            selectCatchUp(state, command.cutoffAt).items.length === 0) {
            return succeed(freezeResult({ cutoffAt: command.cutoffAt, noOp: true }));
        }
        let occurredAt;
        try {
            occurredAt = utcNow(this.#dependencies.clock);
        }
        catch {
            return fail(internalError());
        }
        if (command.cutoffAt > occurredAt)
            return fail(signalBoardError('SB_STATE_CONFLICT'));
        const reservation = this.#reservations.get(command.cutoffAt) ?? {};
        this.#reservations.set(command.cutoffAt, reservation);
        try {
            reservation.commandId ??= this.#dependencies.ids.command();
            reservation.eventId ??= this.#dependencies.ids.event();
        }
        catch {
            return fail(internalError());
        }
        const event = freezeResult({
            schemaVersion: 1,
            eventId: reservation.eventId,
            eventType: 'board.viewed',
            occurredAt,
            actor: 'user',
            commandId: reservation.commandId,
            payload: { cutoffAt: command.cutoffAt },
        });
        const reduced = reduceBoardEvent(state, event);
        if (!reduced.ok)
            return fail(signalBoardError(reduced.code));
        if (reduced.idempotent) {
            this.#reservations.delete(command.cutoffAt);
            return succeed(freezeResult({ cutoffAt: command.cutoffAt, event, noOp: true }));
        }
        let appended;
        try {
            appended = await this.#dependencies.append(event);
        }
        catch {
            appended = fail(signalBoardError('SB_PERSISTENCE_FAILED'));
        }
        if (!appended.ok)
            return appended;
        this.#dependencies.swapState(reduced.state);
        await this.#dependencies.afterMutation?.();
        this.#reservations.delete(command.cutoffAt);
        try {
            await this.#dependencies.refresh(reduced.state);
        }
        catch {
            return fail(signalBoardError('SB_UI_UNAVAILABLE'));
        }
        return succeed(freezeResult({ cutoffAt: command.cutoffAt, event, noOp: false }));
    }
}
function internalError() {
    return Object.freeze({
        code: 'SB_INTERNAL',
        message: 'Signals encountered an unexpected internal error.',
        retryable: true,
    });
}
function freezeResult(value) {
    if (typeof value !== 'object' || value === null)
        return value;
    if (Array.isArray(value))
        return Object.freeze(value.map((item) => freezeResult(item)));
    const copy = {};
    for (const [key, child] of Object.entries(value))
        copy[key] = freezeResult(child);
    return Object.freeze(copy);
}
