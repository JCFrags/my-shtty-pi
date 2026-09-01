import { SHORTCUT, SHORTCUT_DESCRIPTION } from '../constants.js';
/** Register the fixed shortcut once. A host conflict leaves the command path unchanged. */
export function registerSignalBoardShortcut(pi, dependencies) {
    try {
        pi.registerShortcut(SHORTCUT, {
            description: SHORTCUT_DESCRIPTION,
            handler: async (context) => {
                try {
                    await dependencies.openBoard(context);
                }
                catch {
                    try {
                        dependencies.onFailure(context);
                    }
                    catch {
                        // A failed diagnostic surface must not escape the shortcut boundary.
                    }
                }
            },
        });
        return Object.freeze({ availability: 'available' });
    }
    catch {
        return Object.freeze({ availability: 'unavailable' });
    }
}
