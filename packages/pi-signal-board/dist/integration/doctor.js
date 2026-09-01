import { COMMAND_INVOCATION, PRODUCT_NAME, PRODUCT_VERSION, SHORTCUT_DISPLAY, SUPPORTED_NODE_RANGE, SUPPORTED_PI_RANGE, } from '../constants.js';
export function createSessionHealthSnapshot(input) {
    const status = !input.compatibility.supported
        ? 'unsupported'
        : !input.config.config.enabled
            ? 'disabled'
            : input.diagnostics.totalRecorded > 0 || input.config.warnings.length > 0
                ? 'degraded'
                : 'healthy';
    return Object.freeze({ ...input, status });
}
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
function formatCompatibility(fact) {
    const detected = fact.detectedVersion === undefined
        ? 'unresolved'
        : SAFE_VERSION.test(fact.detectedVersion)
            ? fact.detectedVersion
            : 'invalid';
    return `${detected} (${fact.status})`;
}
function formatWarning(warning) {
    const category = warning.safeCategory === undefined ? '' : `:${warning.safeCategory}`;
    return `${warning.source}:${warning.reason}${category}`;
}
function formatDiagnosticCounts(snapshot) {
    const counts = Object.entries(snapshot.counts)
        .filter((entry) => typeof entry[1] === 'number' && entry[1] > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => `${code}=${count}`);
    return counts.length === 0 ? 'none' : counts.join(', ');
}
/** Format diagnostics without board content, paths, exceptions, or stack data. */
export function formatDoctorReport(health, effectiveCommand = COMMAND_INVOCATION, shortcutAvailability = 'available') {
    const warningCategories = health.config.warnings.map(formatWarning);
    const diagnostics = health.diagnostics;
    return [
        'SIGNALS DOCTOR',
        '',
        `Status: ${health.status}`,
        `Extension: ${PRODUCT_NAME} ${PRODUCT_VERSION}`,
        `Supported Node range: ${SUPPORTED_NODE_RANGE}`,
        `Supported Pi range: ${SUPPORTED_PI_RANGE}`,
        `Node: ${formatCompatibility(health.compatibility.node)}`,
        `Pi host: ${formatCompatibility(health.compatibility.pi)}`,
        `Mode: ${health.mode}`,
        `Project trust: ${health.projectTrusted ? 'trusted' : 'untrusted'}`,
        `Config sources: defaults=applied; global=${health.config.sources.global}; project=${health.config.sources.project}`,
        `Config warnings: ${health.config.warnings.length}`,
        `Config warning categories: ${warningCategories.length === 0 ? 'none' : warningCategories.join(', ')}`,
        `Effective config: ${health.config.config.enabled ? 'enabled' : 'disabled'}`,
        `Session: ${health.persistence}`,
        `Board runtime: ${health.status}; lifecycle generation is content-free`,
        'Board counts: active=0; updates=0; questions=0; decisions=0; unread=0',
        `Replay counts: accepted=${diagnostics.replay.accepted}; skipped=${diagnostics.replay.skipped}`,
        `Delivery failures: ${diagnostics.deliveryFailureCount}`,
        `Diagnostics: total=${diagnostics.totalRecorded}; retained=${diagnostics.retained}`,
        `Diagnostic codes: ${formatDiagnosticCounts(diagnostics)}`,
        `Command: ${effectiveCommand}`,
        `Shortcut: ${SHORTCUT_DISPLAY} (${shortcutAvailability})`,
        '',
        'No paths, board content, exception text, or stack traces are included.',
    ].join('\n');
}
export function formatM0Usage() {
    return [
        'Signals M0 diagnostic shell. Board actions are not available and no state changed.',
        `Usage: ${COMMAND_INVOCATION} doctor`,
    ].join('\n');
}
