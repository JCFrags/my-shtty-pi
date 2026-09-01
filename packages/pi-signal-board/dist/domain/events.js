/** Use at the default branch of a switch to require compile-time event exhaustiveness. */
export function assertNeverBoardEvent(event) {
    throw new TypeError(`Unhandled BoardEvent: ${String(event)}`);
}
