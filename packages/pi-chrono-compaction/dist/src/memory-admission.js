const COMPONENTS = [
    "pendingLoad",
    "pendingBuild",
    "liveIndex",
    "queryResults",
    "retainedReferences",
];
function emptyComponents() {
    return { pendingLoad: 0, pendingBuild: 0, liveIndex: 0, queryResults: 0, retainedReferences: 0 };
}
function normalize(request) {
    const normalized = emptyComponents();
    for (const component of COMPONENTS) {
        const value = request[component] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("invalid-memory-admission-request");
        normalized[component] = value;
    }
    if (COMPONENTS.every((component) => normalized[component] === 0))
        throw new Error("invalid-memory-admission-request");
    return normalized;
}
function total(request) {
    return COMPONENTS.reduce((sum, component) => sum + request[component], 0);
}
export class MemoryAdmissionController {
    #byteLimit;
    #components = emptyComponents();
    #reservations = new Set();
    constructor(byteLimit) {
        if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0)
            throw new Error("invalid-memory-admission-limit");
        this.#byteLimit = byteLimit;
    }
    reserve(request) {
        const normalized = normalize(request);
        if (this.status().totalBytes + total(normalized) > this.#byteLimit)
            return undefined;
        const reservation = new MemoryReservation(this, normalized);
        this.#reservations.add(reservation);
        this.#add(normalized, 1);
        return reservation;
    }
    status() {
        const components = { ...this.#components };
        return Object.freeze({
            byteLimit: this.#byteLimit,
            totalBytes: total(components),
            reservations: this.#reservations.size,
            components: Object.freeze(components),
        });
    }
    move(reservation, request) {
        if (!this.#reservations.has(reservation))
            throw new Error("memory-reservation-released");
        const normalized = normalize(request);
        const prior = reservation.current();
        if (this.status().totalBytes - total(prior) + total(normalized) > this.#byteLimit)
            return false;
        this.#add(prior, -1);
        this.#add(normalized, 1);
        reservation.replace(normalized);
        return true;
    }
    release(reservation) {
        if (!this.#reservations.delete(reservation))
            return;
        this.#add(reservation.current(), -1);
        reservation.markReleased();
    }
    #add(request, direction) {
        for (const component of COMPONENTS)
            this.#components[component] += request[component] * direction;
    }
}
export class MemoryReservation {
    #controller;
    #request;
    #released = false;
    constructor(controller, request) {
        this.#controller = controller;
        this.#request = request;
    }
    move(request) {
        return this.#controller.move(this, request);
    }
    release() {
        this.#controller.release(this);
    }
    current() {
        return this.#request;
    }
    replace(request) {
        this.#request = request;
    }
    markReleased() {
        this.#released = true;
    }
    get released() {
        return this.#released;
    }
}
//# sourceMappingURL=memory-admission.js.map