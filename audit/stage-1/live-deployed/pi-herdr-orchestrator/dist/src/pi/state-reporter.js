import { validateHeartbeatState } from "./registration.js";
export class PiStateReporter {
    heartbeatMs;
    #transport;
    #now;
    #setTimer;
    #clearTimer;
    #inFlight = false;
    #pending;
    #lastSentAt = Number.NEGATIVE_INFINITY;
    #timer;
    #onError;
    constructor(transport, options = {}) {
        this.#transport = transport;
        this.heartbeatMs = options.heartbeatMs ?? 5_000;
        if (!Number.isSafeInteger(this.heartbeatMs) ||
            this.heartbeatMs < 0 ||
            this.heartbeatMs > 60_000)
            throw new Error("PI_HEARTBEAT_INTERVAL_INVALID");
        this.#now = options.now ?? Date.now;
        this.#setTimer =
            options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
        this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
        this.#onError = options.onError ?? (() => undefined);
    }
    get pending() {
        return this.#pending !== undefined || this.#inFlight;
    }
    report(state) {
        this.#pending = validateHeartbeatState(state);
        if (this.#inFlight)
            return "coalesced";
        const delay = Math.max(0, this.#lastSentAt + this.heartbeatMs - this.#now());
        if (delay > 0) {
            this.#schedule(delay);
            return "coalesced";
        }
        void this.#drain();
        return "sent";
    }
    dispose() {
        if (this.#timer !== undefined)
            this.#clearTimer(this.#timer);
        this.#timer = undefined;
        this.#pending = undefined;
    }
    #schedule(delay) {
        if (this.#timer !== undefined)
            return;
        this.#timer = this.#setTimer(() => {
            this.#timer = undefined;
            void this.#drain();
        }, delay);
    }
    async #drain() {
        if (this.#inFlight || this.#pending === undefined)
            return;
        const state = this.#pending;
        this.#pending = undefined;
        this.#inFlight = true;
        try {
            await this.#transport.heartbeat(state);
            this.#lastSentAt = this.#now();
        }
        catch (error) {
            this.#onError(error);
        }
        finally {
            this.#inFlight = false;
            if (this.#pending !== undefined) {
                const delay = Math.max(0, this.#lastSentAt + this.heartbeatMs - this.#now());
                if (delay > 0)
                    this.#schedule(delay);
                else
                    void this.#drain();
            }
        }
    }
}
export function createStateReporter(transport, options) {
    return new PiStateReporter(transport, options);
}
