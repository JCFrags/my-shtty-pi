/** Process-local authorization for one explicitly named fresh physical session.
 * It never carries across a resume, fork, switch or extension reload. */
export class SessionCanary {
    requestedSession;
    sourcePath;
    initialized = false;
    permitted = false;
    refusal;
    refuse(reason) {
        this.refusal = reason;
        return { cancel: true };
    }
    constructor(requestedSession) {
        this.requestedSession = requestedSession;
    }
    requested(sessionId) {
        return typeof this.requestedSession === "string" && this.requestedSession === sessionId;
    }
    start(sessionId, sourcePath, entries) {
        this.permitted = false;
        if (this.initialized || !this.requested(sessionId)) {
            this.initialized = true;
            return;
        }
        this.initialized = true;
        // Setup metadata is permitted, but no conversation, inherited continuation,
        // compaction or custom instruction can be adopted as a fresh canary.
        if (!sourcePath || entries.length > 16 || entries.some(entry => !["model_change", "thinking_level_change", "session_info"].includes(entry.type)))
            return;
        this.sourcePath = sourcePath;
        this.permitted = true;
    }
    active(sessionId, sourcePath) {
        return this.permitted && this.requested(sessionId) && sourcePath === this.sourcePath;
    }
    stop() { this.permitted = false; }
}
//# sourceMappingURL=session-canary.js.map