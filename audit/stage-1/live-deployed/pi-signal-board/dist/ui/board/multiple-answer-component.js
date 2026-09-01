import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { sanitizeOneLine } from '../../domain/sanitization.js';
const MINIMUM_WIDTH = 50;
const SAFE_TEXT_LIMIT = 10_000;
const RESIZE_MESSAGE = 'Multiple answer selection requires at least 50 columns. Resize the terminal or press Esc.';
/** Keyboard-only multiple selection. It returns intent data and never mutates product state. */
export class MultipleAnswerComponent {
    host;
    completion;
    displayId;
    options;
    selected = new Set();
    textSupported;
    textPresent;
    selectedIndex = 0;
    closed = false;
    constructor(options) {
        this.host = options.tui;
        this.completion = options.done;
        this.displayId = safe(options.displayId);
        this.options = options.options;
        this.textSupported = options.textSupported;
        this.textPresent = options.textPresent ?? false;
        const known = new Set(options.options.map((option) => option.id));
        for (const id of options.selectedOptionIds ?? []) {
            if (known.has(id))
                this.selected.add(id);
        }
    }
    render(requestedWidth) {
        const width = normalizeWidth(requestedWidth);
        if (width === 0)
            return [];
        if (width < MINIMUM_WIDTH)
            return wrapPlain(RESIZE_MESSAGE, width);
        const lines = [
            truncateToWidth(`Answer ${this.displayId} · select one or more`, width, ''),
            '─'.repeat(width),
        ];
        for (let index = 0; index < this.options.length; index += 1) {
            const option = this.options[index];
            const marker = index === this.selectedIndex ? '> ' : '  ';
            const checked = this.selected.has(option.id) ? '[x]' : '[ ]';
            const prefix = `${marker}${checked} `;
            const available = Math.max(0, width - visibleWidth(prefix));
            lines.push(`${prefix}${safe(truncateToWidth(safe(option.label), available, available > 1 ? '…' : ''))}`);
        }
        if (this.textSupported) {
            lines.push(this.textPresent ? 'Text answer: [present]' : 'Text answer: [none]');
        }
        lines.push('─'.repeat(width));
        const footer = this.textSupported
            ? ['↑↓/jk move', 'Space toggle', 'Enter submit', 'T text', 'Esc cancel']
            : ['↑↓/jk move', 'Space toggle', 'Enter submit', 'Esc cancel'];
        lines.push(...packLabels(footer, width));
        return lines.map((line) => visibleWidth(line) <= width ? line : safe(truncateToWidth(line, width, '')));
    }
    handleInput(data) {
        if (this.closed)
            return;
        if (matchesKey(data, Key.escape)) {
            this.finish(Object.freeze({ kind: 'cancelled' }));
            return;
        }
        if (matchesKey(data, Key.up) || data === 'k') {
            this.move(-1);
            return;
        }
        if (matchesKey(data, Key.down) || data === 'j') {
            this.move(1);
            return;
        }
        if (matchesKey(data, Key.space)) {
            this.toggle();
            return;
        }
        if (this.textSupported && data.toLowerCase() === 't') {
            this.finishResult('text');
            return;
        }
        if (matchesKey(data, Key.enter) && (this.selected.size > 0 || this.textPresent)) {
            this.finishResult('submit');
        }
    }
    invalidate() {
        if (!this.closed)
            this.host?.requestRender();
    }
    dispose() {
        this.closed = true;
        this.host = undefined;
        this.completion = undefined;
        this.selected.clear();
    }
    move(direction) {
        if (this.options.length === 0)
            return;
        this.selectedIndex =
            (this.selectedIndex + direction + this.options.length) % this.options.length;
        this.changed();
    }
    toggle() {
        const option = this.options[this.selectedIndex];
        if (option === undefined)
            return;
        if (this.selected.has(option.id))
            this.selected.delete(option.id);
        else
            this.selected.add(option.id);
        this.changed();
    }
    finishResult(kind) {
        const optionIds = Object.freeze(this.options.filter((option) => this.selected.has(option.id)).map((option) => option.id));
        this.finish(Object.freeze({ kind, optionIds }));
    }
    changed() {
        this.host?.requestRender();
    }
    finish(result) {
        const done = this.completion;
        this.closed = true;
        this.host = undefined;
        this.completion = undefined;
        done?.(result);
    }
}
function safe(value) {
    const result = sanitizeOneLine(value, SAFE_TEXT_LIMIT);
    return result.ok ? result.value : '';
}
function normalizeWidth(width) {
    return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
}
function packLabels(labels, width) {
    const lines = [];
    for (const label of labels) {
        const current = lines.at(-1);
        const candidate = current === undefined ? label : `${current} · ${label}`;
        if (current === undefined)
            lines.push(label);
        else if (visibleWidth(candidate) <= width)
            lines[lines.length - 1] = candidate;
        else
            lines.push(label);
    }
    return lines.flatMap((line) => (visibleWidth(line) <= width ? [line] : wrapPlain(line, width)));
}
function wrapPlain(value, width) {
    if (width <= 0)
        return [];
    const words = value.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current.length === 0 ? word : `${current} ${word}`;
        if (visibleWidth(candidate) <= width) {
            current = candidate;
        }
        else {
            if (current.length > 0)
                lines.push(current);
            current = safe(truncateToWidth(word, width, ''));
        }
    }
    if (current.length > 0)
        lines.push(current);
    return lines;
}
