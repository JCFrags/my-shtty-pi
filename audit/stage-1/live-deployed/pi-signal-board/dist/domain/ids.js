import { randomUUID } from 'node:crypto';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UPDATE_ID_PATTERN = /^upd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const QUESTION_ID_PATTERN = /^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ANSWER_ID_PATTERN = /^ans_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMAND_ID_PATTERN = /^(?:tool:[A-Za-z0-9._:|-]{1,240}|(?:ui|system):[A-Za-z0-9._:-]{1,240})$/u;
const UPDATE_DISPLAY_ID_PATTERN = /^U-[1-9][0-9]*$/u;
const QUESTION_DISPLAY_ID_PATTERN = /^Q-[1-9][0-9]*$/u;
const DECISION_DISPLAY_ID_PATTERN = /^D-[1-9][0-9]*$/u;
const MAX_UNIQUE_ID_ATTEMPTS = 128;
class CryptoUuidSource {
    nextUuid() {
        return randomUUID();
    }
}
/**
 * Prefixed UUIDv4 generator with collision protection for one runtime.
 * Construct one instance per Signals runtime. Do not share it globally.
 */
export class RuntimeIdGenerator {
    uuidSource;
    #issued = new Set();
    constructor(uuidSource = new CryptoUuidSource()) {
        this.uuidSource = uuidSource;
    }
    event() {
        return this.nextPrefixed('evt_');
    }
    update() {
        return this.nextPrefixed('upd_');
    }
    question() {
        return this.nextPrefixed('qst_');
    }
    answer() {
        return this.nextPrefixed('ans_');
    }
    command() {
        return this.nextPrefixed('ui:');
    }
    nextPrefixed(prefix) {
        for (let attempt = 0; attempt < MAX_UNIQUE_ID_ATTEMPTS; attempt += 1) {
            const uuid = this.uuidSource.nextUuid();
            if (!UUID_V4_PATTERN.test(uuid)) {
                throw new TypeError('UUID source must provide a lowercase UUIDv4.');
            }
            const id = `${prefix}${uuid}`;
            if (!this.#issued.has(id)) {
                this.#issued.add(id);
                return id;
            }
        }
        throw new Error('UUID source could not provide a unique ID.');
    }
}
/** Deterministic UUID source for tests. It fails rather than adding random fallback data. */
export class SequenceUuidSource {
    #values;
    constructor(values) {
        this.#values = [...values];
    }
    nextUuid() {
        const value = this.#values.shift();
        if (value === undefined) {
            throw new Error('Deterministic UUID sequence is exhausted.');
        }
        return value;
    }
}
export function isUpdateId(value) {
    return value.length <= 64 && UPDATE_ID_PATTERN.test(value);
}
export function isQuestionId(value) {
    return value.length <= 64 && QUESTION_ID_PATTERN.test(value);
}
export function isAnswerId(value) {
    return value.length <= 64 && ANSWER_ID_PATTERN.test(value);
}
export function isEventId(value) {
    return value.length <= 64 && EVENT_ID_PATTERN.test(value);
}
export function isCommandId(value) {
    return value.length <= 256 && COMMAND_ID_PATTERN.test(value);
}
export function isUuid(value) {
    return UUID_PATTERN.test(value);
}
export function isUuidV4(value) {
    return UUID_V4_PATTERN.test(value);
}
export function updateDisplayId(sequence) {
    return makeDisplayId('U', sequence);
}
export function questionDisplayId(sequence) {
    return makeDisplayId('Q', sequence);
}
export function decisionDisplayId(sequence) {
    return makeDisplayId('D', sequence);
}
export function displaySequence(value) {
    if (!UPDATE_DISPLAY_ID_PATTERN.test(value) &&
        !QUESTION_DISPLAY_ID_PATTERN.test(value) &&
        !DECISION_DISPLAY_ID_PATTERN.test(value)) {
        return undefined;
    }
    const sequence = Number(value.slice(2));
    return Number.isSafeInteger(sequence) ? sequence : undefined;
}
function makeDisplayId(prefix, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new RangeError('Display sequence must be a positive safe integer.');
    }
    const value = `${prefix}-${sequence}`;
    if (value.length > 32) {
        throw new RangeError('Display ID exceeds its schema length.');
    }
    return value;
}
