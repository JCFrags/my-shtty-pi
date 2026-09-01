import { STATUS_ID, WIDGET_ID } from '../constants.js';
import { renderStatusText } from './status/index.js';
import { renderWidgetLines } from './widget/index.js';
/**
 * Own the two namespaced Pi UI surfaces for one session runtime.
 * Every host call is isolated so a missing or failed surface stays recoverable.
 */
export function createSignalBoardUiAdapter(context, diagnostics) {
    return new RuntimeUiAdapter(context, diagnostics);
}
class RuntimeUiAdapter {
    #context;
    #diagnostics;
    #disposed = false;
    #widgetActive = false;
    #statusActive = false;
    #diagnosticTime = '1970-01-01T00:00:00.000Z';
    constructor(context, diagnostics) {
        this.#context = context;
        this.#diagnostics = diagnostics;
    }
    refresh(input) {
        if (this.#disposed)
            return;
        this.#diagnosticTime = normalizeTimestamp(input.currentTime);
        if (!this.hasUi()) {
            this.clearInstalledSurfaces();
            return;
        }
        if (!input.config.enabled) {
            this.clearBoth();
            return;
        }
        this.refreshWidget(input);
        this.refreshStatus(input);
    }
    clear() {
        if (this.#disposed)
            return;
        this.clearInstalledSurfaces();
    }
    dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        if (this.#widgetActive || this.#statusActive || this.hasUi())
            this.clearBoth();
    }
    hasUi() {
        try {
            return this.#context.hasUI;
        }
        catch {
            this.recordUiUnavailable('ui_unsupported');
            return false;
        }
    }
    refreshWidget(input) {
        if (!input.config.widget.enabled) {
            this.setWidget(undefined);
            return;
        }
        const render = (width) => renderWidgetLines(input.state, input.config, {
            completedWindowCutoff: input.completedWindowCutoff,
            currentTime: input.currentTime,
            effectiveCommand: input.effectiveCommand,
            width,
        });
        let probe;
        try {
            probe = render(80);
        }
        catch {
            this.recordUiUnavailable('ui_failure');
            this.setWidget(undefined);
            return;
        }
        if (probe.length === 0) {
            this.setWidget(undefined);
            return;
        }
        this.setWidget(() => ({
            render: (width) => {
                try {
                    return [...render(width)];
                }
                catch {
                    this.recordUiUnavailable('ui_failure');
                    return [];
                }
            },
            invalidate: () => undefined,
        }));
    }
    refreshStatus(input) {
        if (!input.config.status.enabled) {
            this.setStatus(undefined);
            return;
        }
        try {
            this.setStatus(renderStatusText(input.state, input.currentTime, input.config.status.hideWhenClear));
        }
        catch {
            this.recordUiUnavailable('ui_failure');
            this.setStatus(undefined);
        }
    }
    clearInstalledSurfaces() {
        if (this.#widgetActive)
            this.setWidget(undefined);
        if (this.#statusActive)
            this.setStatus(undefined);
    }
    clearBoth() {
        this.setWidget(undefined);
        this.setStatus(undefined);
    }
    setWidget(content) {
        const succeeded = this.callSurface('setWidget', (method, receiver) => {
            method.call(receiver, WIDGET_ID, content, { placement: 'aboveEditor' });
        });
        if (succeeded)
            this.#widgetActive = content !== undefined;
    }
    setStatus(text) {
        const succeeded = this.callSurface('setStatus', (method, receiver) => {
            method.call(receiver, STATUS_ID, text);
        });
        if (succeeded)
            this.#statusActive = text !== undefined;
    }
    callSurface(name, invoke) {
        try {
            const ui = this.#context.ui;
            const method = ui?.[name];
            if (typeof method !== 'function') {
                this.recordUiUnavailable('ui_unsupported');
                return false;
            }
            invoke(method, ui);
            return true;
        }
        catch {
            this.recordUiUnavailable('ui_failure');
            return false;
        }
    }
    recordUiUnavailable(category) {
        this.#diagnostics.record({
            at: this.#diagnosticTime,
            code: 'SB_UI_UNAVAILABLE',
            severity: 'warning',
            area: 'ui',
            category,
        });
    }
}
/** Compute the exact inclusive completion cutoff from one injected clock read. */
export function completionWindowCutoff(currentTime, minutes) {
    const duration = Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 0;
    return new Date(currentTime.getTime() - duration).toISOString();
}
function normalizeTimestamp(value) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds)
        ? new Date(milliseconds).toISOString()
        : '1970-01-01T00:00:00.000Z';
}
