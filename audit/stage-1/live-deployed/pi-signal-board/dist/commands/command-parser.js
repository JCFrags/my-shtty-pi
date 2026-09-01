import { BOARD_TABS } from '../ui/board/model.js';
const TAB_SET = new Set(BOARD_TABS);
/** Parse only the exact case-sensitive Signals command grammar. */
export function parseSignalBoardCommand(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return Object.freeze({ kind: 'open' });
    const tokens = trimmed.split(/\s+/u);
    if (tokens.length !== 1)
        return Object.freeze({ kind: 'usage' });
    const token = tokens[0];
    if (TAB_SET.has(token)) {
        return Object.freeze({ kind: 'open', tab: token });
    }
    if (token === 'summary')
        return Object.freeze({ kind: 'summary' });
    if (token === 'doctor')
        return Object.freeze({ kind: 'doctor' });
    return Object.freeze({ kind: 'usage' });
}
