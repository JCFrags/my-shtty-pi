import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { COMMAND_INVOCATION, STATUS_ID, WIDGET_ID } from '../constants.js';
import { fail, signalBoardError } from '../domain/errors.js';
import { createEmptyBoardState } from '../domain/reducer.js';
import { replayBranch } from '../persistence/replay.js';
import { RuntimeSlot } from '../runtime/slot.js';
import { createDiagnostics } from '../services/diagnostics.js';
import { MutationQueue } from '../services/mutation-queue.js';
import { evaluateHostCompatibility } from './compatibility.js';
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';
/** Owns one extension-instance queue and every session runtime generation. */
export class RuntimeLifecycle {
    queue = new MutationQueue();
    slot = new RuntimeSlot();
    #adapters;
    #nextGeneration = 0;
    #registered = false;
    constructor(adapters) {
        this.#adapters = adapters;
    }
    register(pi) {
        if (this.#registered)
            return;
        this.#registered = true;
        pi.on('session_start', async (_event, context) => {
            await this.start(context);
        });
        pi.on('session_tree', async (_event, context) => {
            await this.replaceTree(context);
        });
        pi.on('turn_start', async () => {
            await this.turnStart();
        });
        pi.on('agent_settled', async () => {
            await this.agentSettled();
        });
        pi.on('session_shutdown', async () => {
            await this.shutdown();
        });
    }
    async start(context) {
        await this.queue.run(async () => {
            const previous = this.slot.current();
            if (previous !== undefined)
                this.disposeLocked(previous);
            const generation = ++this.#nextGeneration;
            const diagnostics = createDiagnostics();
            const at = safeTimestamp(this.#adapters.now);
            const trusted = safeTrust(context, diagnostics, at);
            const compatibility = safeCompatibility(this.#adapters, diagnostics, at);
            if (!compatibility.supported) {
                diagnostics.record({
                    at,
                    code: 'SB_UNSUPPORTED_HOST',
                    severity: 'error',
                    area: 'compatibility',
                    category: 'unsupported_version',
                });
            }
            const config = await safeConfig(this.#adapters, context, trusted, diagnostics, at);
            recordConfigWarnings(config.warnings, diagnostics, at);
            let replay;
            let replayFailed = false;
            try {
                replay = this.#adapters.replay(context.sessionManager.getBranch());
            }
            catch {
                replayFailed = true;
                replay = emptyReplay();
                recordInternal(diagnostics, at, 'replay');
            }
            recordReplay(replay, diagnostics, at);
            const runtime = {
                generation,
                identity: safeIdentity(context, generation),
                treeRevision: 0,
                context,
                queue: this.queue,
                compatibility,
                config,
                diagnostics,
                state: replay.state,
                status: initialStatus(compatibility, config, replayFailed || diagnostics.count('SB_INTERNAL') > 0),
                timer: undefined,
                disposed: false,
                disposeCount: 0,
                notifications: new Set(),
            };
            this.slot.replaceLocked(runtime);
            if (runtime.status === 'healthy') {
                try {
                    await this.#adapters.hooks.evaluateExpiryLocked?.(runtime);
                    await this.#adapters.hooks.recoverDeliveryLocked?.(runtime);
                    await this.refreshLocked(runtime);
                    await this.armTimerLocked(runtime);
                    if (runtime.config.warnings.length > 0 || replay.warnings.length > 0) {
                        this.notifyStartupOnceLocked(runtime);
                    }
                }
                catch {
                    recordInternal(runtime.diagnostics, at, 'lifecycle');
                    runtime.status = 'degraded';
                    this.clearTimerLocked(runtime);
                    this.clearSurfacesLocked(runtime);
                    this.notifyStartupOnceLocked(runtime);
                }
            }
            else {
                this.clearSurfacesLocked(runtime);
                this.notifyStartupOnceLocked(runtime);
            }
        });
    }
    async replaceTree(context) {
        await this.queue.run(async () => {
            const runtime = this.slot.current();
            if (runtime === undefined || runtime.disposed)
                return;
            this.clearTimerLocked(runtime);
            runtime.treeRevision += 1;
            let replay;
            try {
                replay = this.#adapters.replay(context.sessionManager.getBranch());
            }
            catch {
                replay = emptyReplay();
                runtime.status = 'degraded';
                recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'replay');
            }
            runtime.state = replay.state;
            recordReplay(replay, runtime.diagnostics, safeTimestamp(this.#adapters.now));
            if (runtime.status === 'healthy') {
                try {
                    await this.refreshLocked(runtime);
                    await this.armTimerLocked(runtime);
                }
                catch {
                    recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
                    this.clearTimerLocked(runtime);
                    this.clearSurfacesLocked(runtime);
                }
            }
            else {
                this.clearSurfacesLocked(runtime);
            }
        });
    }
    async turnStart() {
        await this.queue.run(async () => {
            const runtime = this.healthyRuntimeLocked();
            if (runtime === undefined)
                return;
            try {
                await this.#adapters.hooks.resetTurnRateCountersLocked?.(runtime);
            }
            catch {
                recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
            }
        });
    }
    async agentSettled() {
        await this.queue.run(async () => {
            const runtime = this.healthyRuntimeLocked();
            if (runtime === undefined)
                return;
            try {
                await this.#adapters.hooks.evaluateExpiryLocked?.(runtime);
                await this.#adapters.hooks.escalateConditionalQuestionsLocked?.(runtime);
            }
            catch {
                recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
            }
            finally {
                await this.refreshLocked(runtime);
                await this.rearmTimerContainedLocked(runtime);
            }
        });
    }
    /** Evaluate expiry at the board-open boundary without adding board UI. */
    evaluateBoardOpen() {
        return this.runHealthy(async (runtime) => {
            const evaluation = await runtime.expiryService?.evaluateExpiryLocked(this.#adapters.now());
            if (evaluation === undefined)
                throw new Error('Expiry service is unavailable.');
            await this.rearmTimerContainedLocked(runtime);
            return evaluation;
        });
    }
    /** Persist one normal board-close checkpoint through the shared runtime queue. */
    markBoardViewed(cutoffAt, expected) {
        return this.queue.run(async () => {
            const access = this.slot.requireHealthyLocked();
            if (!access.ok) {
                const code = access.error.code === 'SB_DISABLED'
                    ? 'SB_CONFIG_DISABLED'
                    : access.error.code === 'SB_INTERNAL'
                        ? undefined
                        : access.error.code;
                return code === undefined ? fail(internalPublicError()) : fail(signalBoardError(code));
            }
            if (access.value.generation !== expected.generation ||
                access.value.identity.token !== expected.identityToken ||
                access.value.treeRevision !== expected.treeRevision) {
                return fail(signalBoardError('SB_STATE_CONFLICT'));
            }
            const service = access.value.boardViewCheckpointService;
            if (service === undefined)
                return fail(internalPublicError());
            try {
                return await service.markViewedLocked({ cutoffAt });
            }
            catch {
                recordInternal(access.value.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
                return fail(internalPublicError());
            }
        });
    }
    /** Complete timer work after a service mutation that already owns this queue. */
    async mutationBoundaryLocked(runtime) {
        const current = this.slot.current();
        if (current?.generation !== runtime.generation ||
            current.disposed ||
            current.status !== 'healthy') {
            return;
        }
        await this.#adapters.hooks.evaluateExpiryLocked?.(current);
        await this.rearmTimerContainedLocked(current);
    }
    async shutdown() {
        await this.queue.run(() => {
            const runtime = this.slot.current();
            if (runtime === undefined)
                return;
            const generation = runtime.generation;
            this.disposeLocked(runtime);
            this.slot.clearIfGenerationLocked(generation);
        });
    }
    /** Public mutation access enters the same queue used by all lifecycle work. */
    runHealthy(operation) {
        return this.queue.run(async () => {
            const access = this.slot.requireHealthyLocked();
            if (!access.ok)
                return access;
            try {
                return { ok: true, value: await operation(access.value) };
            }
            catch {
                recordInternal(access.value.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
                return {
                    ok: false,
                    error: {
                        code: 'SB_INTERNAL',
                        message: 'Signals startup did not complete safely.',
                        retryable: true,
                    },
                };
            }
        });
    }
    doctorSnapshot(context) {
        return this.slot.doctorSnapshot(context);
    }
    healthyRuntimeLocked() {
        const runtime = this.slot.current();
        return runtime !== undefined && !runtime.disposed && runtime.status === 'healthy'
            ? runtime
            : undefined;
    }
    async refreshLocked(runtime) {
        try {
            await this.#adapters.hooks.refreshLocked?.(runtime);
        }
        catch {
            runtime.diagnostics.record({
                at: safeTimestamp(this.#adapters.now),
                code: 'SB_UI_UNAVAILABLE',
                severity: 'warning',
                area: 'ui',
                category: 'ui_failure',
            });
            this.clearSurfacesLocked(runtime);
        }
    }
    async rearmTimerContainedLocked(runtime) {
        this.clearTimerLocked(runtime);
        try {
            await this.armTimerLocked(runtime);
        }
        catch {
            recordInternal(runtime.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
            this.clearTimerLocked(runtime);
        }
    }
    async armTimerLocked(runtime) {
        if (runtime.disposed || runtime.status !== 'healthy')
            return;
        const generation = runtime.generation;
        const handle = await this.#adapters.hooks.armTimerLocked?.(runtime, async () => {
            await this.queue.run(async () => {
                const current = this.slot.current();
                if (current?.generation !== generation || current.disposed)
                    return;
                current.timer = undefined;
                try {
                    await this.#adapters.hooks.onTimerLocked?.(current);
                    await this.refreshLocked(current);
                    await this.armTimerLocked(current);
                }
                catch {
                    recordInternal(current.diagnostics, safeTimestamp(this.#adapters.now), 'lifecycle');
                    current.status = 'degraded';
                    this.clearTimerLocked(current);
                    this.clearSurfacesLocked(current);
                }
            });
        });
        if (this.slot.current()?.generation !== generation || runtime.disposed) {
            if (handle !== undefined)
                this.safeClearHandle(handle);
            return;
        }
        runtime.timer = handle;
    }
    disposeLocked(runtime) {
        if (runtime.disposed)
            return;
        runtime.disposed = true;
        runtime.disposeCount += 1;
        this.clearTimerLocked(runtime);
        this.disposeSurfacesLocked(runtime);
        runtime.notifications.clear();
    }
    clearTimerLocked(runtime) {
        const handle = runtime.timer;
        runtime.timer = undefined;
        if (handle !== undefined)
            this.safeClearHandle(handle);
    }
    safeClearHandle(handle) {
        try {
            this.#adapters.hooks.clearTimer?.(handle);
        }
        catch {
            // Timer cleanup is best-effort and content-free.
        }
    }
    clearSurfacesLocked(runtime) {
        if (runtime.ui !== undefined) {
            try {
                runtime.ui.clear();
                return;
            }
            catch {
                this.recordUiCleanupFailure(runtime);
            }
        }
        this.clearSurfacesFallback(runtime);
    }
    disposeSurfacesLocked(runtime) {
        if (runtime.ui !== undefined) {
            try {
                runtime.ui.dispose();
                return;
            }
            catch {
                this.recordUiCleanupFailure(runtime);
            }
        }
        this.clearSurfacesFallback(runtime);
    }
    clearSurfacesFallback(runtime) {
        safeUiCall(runtime, 'widget', () => runtime.context.ui.setWidget(WIDGET_ID, undefined));
        safeUiCall(runtime, 'status', () => runtime.context.ui.setStatus(STATUS_ID, undefined));
    }
    recordUiCleanupFailure(runtime) {
        runtime.diagnostics.record({
            at: FALLBACK_TIMESTAMP,
            code: 'SB_UI_UNAVAILABLE',
            severity: 'warning',
            area: 'ui',
            category: 'ui_failure',
        });
    }
    notifyStartupOnceLocked(runtime) {
        if (runtime.notifications.has('startup'))
            return;
        runtime.notifications.add('startup');
        const message = runtime.status === 'unsupported'
            ? `Signals is unavailable on this host. Run ${COMMAND_INVOCATION} doctor.`
            : runtime.status === 'disabled'
                ? `Signals is disabled. Run ${COMMAND_INVOCATION} doctor.`
                : runtime.status === 'healthy'
                    ? `Signals started with recoverable warnings. Run ${COMMAND_INVOCATION} doctor.`
                    : `Signals startup failed safely. Run ${COMMAND_INVOCATION} doctor.`;
        safeUiCall(runtime, 'notification', () => runtime.context.ui.notify(message, 'warning'));
    }
}
function initialStatus(compatibility, config, degraded) {
    if (!compatibility.supported)
        return 'unsupported';
    if (!config.config.enabled)
        return 'disabled';
    if (degraded)
        return 'degraded';
    return 'healthy';
}
function emptyReplay() {
    return Object.freeze({
        state: createEmptyBoardState(),
        acceptedEvents: 0,
        skippedEvents: 0,
        warnings: Object.freeze([]),
    });
}
function safeCompatibility(adapters, diagnostics, at) {
    try {
        return adapters.evaluateCompatibility();
    }
    catch {
        recordInternal(diagnostics, at, 'compatibility');
        return evaluateHostCompatibility({ nodeVersion: process.versions.node, piVersion: undefined });
    }
}
async function safeConfig(adapters, context, trusted, diagnostics, at) {
    try {
        return await adapters.loadConfig({ cwd: context.cwd, isProjectTrusted: () => trusted });
    }
    catch {
        recordInternal(diagnostics, at, 'config');
        const warning = {
            source: 'global',
            reason: 'unreadable',
            safeCategory: 'io_error',
        };
        return Object.freeze({
            config: DEFAULT_CONFIG,
            sources: Object.freeze({
                global: 'rejected',
                project: trusted ? 'rejected' : 'not_read_untrusted',
            }),
            warnings: Object.freeze([warning]),
        });
    }
}
function safeTrust(context, diagnostics, at) {
    try {
        return context.isProjectTrusted();
    }
    catch {
        recordInternal(diagnostics, at, 'lifecycle');
        return false;
    }
}
function safeIdentity(context, generation) {
    let persistence = 'ephemeral';
    let source = `ephemeral:${generation}`;
    try {
        const file = context.sessionManager.getSessionFile();
        persistence = file === undefined ? 'ephemeral' : 'persistent';
        source = `${persistence}:${context.sessionManager.getSessionId()}`;
    }
    catch {
        // Use the generation-only fallback without exposing session metadata.
    }
    return Object.freeze({
        persistence,
        token: createHash('sha256').update(source).digest('hex').slice(0, 12),
    });
}
function recordConfigWarnings(warnings, diagnostics, at) {
    for (const _warning of warnings) {
        diagnostics.record({
            at,
            code: 'SB_CONFIG_INVALID',
            severity: 'warning',
            area: 'config',
            category: 'invalid_data',
        });
    }
}
function recordReplay(replay, diagnostics, at) {
    diagnostics.setReplayCounts(replay.acceptedEvents, replay.skippedEvents);
    for (const _warning of replay.warnings) {
        diagnostics.record({
            at,
            code: 'SB_REPLAY_SKIPPED',
            severity: 'warning',
            area: 'replay',
            category: 'decode_rejected',
        });
    }
}
function recordInternal(diagnostics, at, area) {
    diagnostics.record({
        at,
        code: 'SB_INTERNAL',
        severity: 'error',
        area,
        category: 'unexpected',
    });
}
function safeUiCall(runtime, _surface, operation) {
    try {
        operation();
    }
    catch {
        runtime.diagnostics.record({
            at: FALLBACK_TIMESTAMP,
            code: 'SB_UI_UNAVAILABLE',
            severity: 'warning',
            area: 'ui',
            category: 'ui_failure',
        });
    }
}
function internalPublicError() {
    return Object.freeze({
        code: 'SB_INTERNAL',
        message: 'Signals encountered an unexpected internal error.',
        retryable: true,
    });
}
function safeTimestamp(now) {
    try {
        return now().toISOString();
    }
    catch {
        return FALLBACK_TIMESTAMP;
    }
}
export const DEFAULT_REPLAY_ADAPTER = replayBranch;
