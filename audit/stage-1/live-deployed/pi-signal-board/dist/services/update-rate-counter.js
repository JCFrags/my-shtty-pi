import { fail, signalBoardError, succeed } from '../domain/errors.js';
/** Runtime-owned committed update mutation count for the current assistant turn. */
export class TurnUpdateRateCounter {
    #committed = 0;
    get committed() {
        return this.#committed;
    }
    check(limit) {
        if (!Number.isSafeInteger(limit) || limit < 1 || this.#committed >= limit) {
            return fail(signalBoardError('SB_LIMIT_EXCEEDED'));
        }
        return succeed(undefined);
    }
    /** Call only after append and state swap both succeed. */
    commit() {
        this.#committed += 1;
    }
    /** Wire this method to the runtime turn_start reset hook. */
    reset() {
        this.#committed = 0;
    }
}
