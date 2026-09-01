import { selectBoardCounts } from '../../domain/selectors.js';
/** Build the no-color footer status from accepted selector counts. */
export function renderStatusText(state, currentTime, hideWhenClear = true) {
    const counts = selectBoardCounts(state, currentTime);
    if (counts.actionableQuestions === 0 && counts.activeUpdates === 0 && counts.unread === 0) {
        return hideWhenClear ? undefined : 'Signals: clear';
    }
    const unread = counts.unread > 0 ? ` ${counts.unread} new` : '';
    return `Signals: ${counts.actionableQuestions}Q ${counts.activeUpdates}U${unread}`;
}
