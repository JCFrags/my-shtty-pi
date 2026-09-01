import { SIGNAL_BOARD_ERROR_CODES, } from '../domain/errors.js';
export const DIAGNOSTIC_CAPACITY = 100;
export const DIAGNOSTIC_CODES = [...SIGNAL_BOARD_ERROR_CODES, 'SB_REPLAY_SKIPPED'];
export const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'];
export const DIAGNOSTIC_AREAS = [
    'compatibility',
    'config',
    'replay',
    'persistence',
    'delivery',
    'ui',
    'lifecycle',
];
/** Fixed categories prevent diagnostic callers from storing exception or board text. */
export const DIAGNOSTIC_SAFE_CATEGORIES = [
    'invalid_data',
    'unsupported_version',
    'disabled',
    'command_ambiguous',
    'decode_rejected',
    'invariant_violation',
    'append_rejected',
    'host_rejected',
    'runtime_unavailable',
    'io_failure',
    'ui_unsupported',
    'ui_failure',
    'unexpected',
];
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const INVALID_CORRELATION_ID = 'sb-invalid-correlation-id';
/** Create one runtime-scoped diagnostics store with an exact 100-record ring. */
export function createDiagnostics() {
    return new BoundedDiagnostics();
}
class BoundedDiagnostics {
    #records = [];
    #counts = new Map();
    #totalRecorded = 0;
    #replayAccepted = 0;
    #replaySkipped = 0;
    #deliveryFailureCount = 0;
    #latestDeliveryFailure;
    record(input) {
        const record = normalizeRecord(input);
        if (this.#records.length === DIAGNOSTIC_CAPACITY) {
            this.#records.shift();
        }
        this.#records.push(record);
        this.#totalRecorded += 1;
        this.#counts.set(record.code, (this.#counts.get(record.code) ?? 0) + 1);
        if (record.code === 'SB_DELIVERY_FAILED') {
            this.#deliveryFailureCount += 1;
            this.#latestDeliveryFailure = Object.freeze({
                at: record.at,
                code: record.code,
                category: record.category,
            });
        }
    }
    recordUnexpectedError(record) {
        this.record({
            at: record.at,
            code: 'SB_INTERNAL',
            severity: 'error',
            area: record.area,
            category: record.category,
            correlationId: record.correlationId,
        });
    }
    snapshot() {
        const records = Object.freeze([...this.#records]);
        const counts = Object.freeze(Object.fromEntries(this.#counts));
        const replay = Object.freeze({
            accepted: this.#replayAccepted,
            skipped: this.#replaySkipped,
        });
        const base = {
            records,
            retained: records.length,
            totalRecorded: this.#totalRecorded,
            counts,
            replay,
            deliveryFailureCount: this.#deliveryFailureCount,
        };
        if (this.#latestDeliveryFailure === undefined) {
            return Object.freeze(base);
        }
        return Object.freeze({ ...base, latestDeliveryFailure: this.#latestDeliveryFailure });
    }
    count(code) {
        return code === undefined ? this.#totalRecorded : (this.#counts.get(code) ?? 0);
    }
    setReplayCounts(accepted, skipped) {
        this.#replayAccepted = safeCount(accepted);
        this.#replaySkipped = safeCount(skipped);
    }
}
function normalizeRecord(input) {
    const at = isUtcTimestamp(input.at) ? input.at : FALLBACK_TIMESTAMP;
    const code = includes(DIAGNOSTIC_CODES, input.code) ? input.code : 'SB_INTERNAL';
    const severity = includes(DIAGNOSTIC_SEVERITIES, input.severity) ? input.severity : 'error';
    const area = includes(DIAGNOSTIC_AREAS, input.area) ? input.area : 'lifecycle';
    const category = includes(DIAGNOSTIC_SAFE_CATEGORIES, input.category)
        ? input.category
        : 'unexpected';
    if (input.correlationId === undefined) {
        return Object.freeze({ at, code, severity, area, category });
    }
    return Object.freeze({
        at,
        code,
        severity,
        area,
        category,
        correlationId: SAFE_CORRELATION_ID.test(input.correlationId)
            ? input.correlationId
            : INVALID_CORRELATION_ID,
    });
}
function includes(values, value) {
    return typeof value === 'string' && values.includes(value);
}
function isUtcTimestamp(value) {
    if (typeof value !== 'string' || !ISO_UTC_TIMESTAMP.test(value)) {
        return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
