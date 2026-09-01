export class LifecycleCorrelator {
    #state = { kind: "none" };
    get state() {
        return this.#state;
    }
    pending() {
        return this.#state.kind === "pending" || this.#state.kind === "accepted"
            ? this.#state.assignment
            : undefined;
    }
    activeAssignment() {
        return this.#state.kind === "accepted" || this.#state.kind === "bound"
            ? this.#state.assignment
            : undefined;
    }
    deliver(assignment, safe) {
        if (assignment.agentId !== safe.agentId ||
            assignment.generation !== safe.generation ||
            assignment.piSessionId !== safe.sessionId)
            throw new Error("PI_IDENTITY_MISMATCH");
        if (!safe.idle || safe.pendingMessages > 0) {
            if (this.#state.kind !== "none" &&
                this.#state.assignment.id === assignment.id)
                return "already_accepted";
            throw new Error("AGENT_NOT_IDLE");
        }
        if (this.#state.kind !== "none" && this.#state.kind !== "settled") {
            if (this.#state.assignment.id === assignment.id)
                return "already_accepted";
            throw new Error("AGENT_NOT_IDLE");
        }
        if (this.#state.kind === "settled" &&
            this.#state.assignment.id === assignment.id)
            return "already_accepted";
        this.#state = { kind: "pending", assignment, customEntryWritten: false };
        return "accepted";
    }
    markCustomEntryWritten() {
        if (this.#state.kind !== "pending")
            throw new Error("ASSIGNMENT_NOT_PENDING");
        this.#state = { ...this.#state, customEntryWritten: true };
    }
    accept(now = new Date().toISOString()) {
        if (this.#state.kind === "accepted" ||
            this.#state.kind === "bound" ||
            this.#state.kind === "settled")
            return;
        if (this.#state.kind !== "pending")
            throw new Error("ASSIGNMENT_NOT_PENDING");
        this.#state = {
            kind: "accepted",
            assignment: this.#state.assignment,
            acceptedAt: now,
        };
    }
    lifecycle(event) {
        if (event.type === "agent_settled" || event.type === "agent_end") {
            if (this.#state.kind === "bound" && this.matches(event)) {
                if (event.type === "agent_settled") {
                    this.#state = {
                        kind: "settled",
                        assignment: this.#state.assignment,
                        piSessionId: this.#state.piSessionId,
                        agentCycleId: this.#state.agentCycleId,
                        firstTurnIndex: this.#state.firstTurnIndex,
                    };
                    return "settled";
                }
                return "ignored";
            }
            return "manual";
        }
        if (event.type !== "before_agent_start" &&
            event.type !== "agent_start" &&
            event.type !== "turn_start")
            return "ignored";
        if (this.#state.kind === "accepted" &&
            this.matches(event) &&
            event.agentCycleId &&
            event.turnIndex !== undefined) {
            this.#state = {
                kind: "bound",
                assignment: this.#state.assignment,
                piSessionId: event.piSessionId,
                agentCycleId: event.agentCycleId,
                firstTurnIndex: event.turnIndex,
            };
            return "bound";
        }
        return "manual";
    }
    cancel() {
        if (this.#state.kind !== "none")
            this.#state = { kind: "none" };
    }
    exportState() {
        return this.#state;
    }
    restorePersisted(kind, assignment, safe, agentCycleId, firstTurnIndex) {
        if (assignment.agentId !== safe.agentId ||
            assignment.generation !== safe.generation ||
            assignment.piSessionId !== safe.sessionId)
            return;
        if (kind === "accepted")
            this.#state = { kind, assignment, acceptedAt: new Date().toISOString() };
        else if (agentCycleId && Number.isSafeInteger(firstTurnIndex))
            this.#state = {
                kind,
                assignment,
                piSessionId: safe.sessionId,
                agentCycleId,
                firstTurnIndex: firstTurnIndex,
            };
    }
    restoreAssignment(assignment, safe) {
        if (assignment.agentId === safe.agentId &&
            assignment.generation === safe.generation &&
            assignment.piSessionId === safe.sessionId)
            this.#state = {
                kind: "accepted",
                assignment,
                acceptedAt: new Date().toISOString(),
            };
    }
    restoreState(state, safe) {
        if (state.kind === "none")
            return;
        const assignment = state.assignment;
        if (assignment.agentId !== safe.agentId ||
            assignment.generation !== safe.generation ||
            assignment.piSessionId !== safe.sessionId)
            return;
        if (state.kind === "pending")
            this.#state = { kind: "pending", assignment, customEntryWritten: true };
        else if (state.kind === "accepted")
            this.#state = state;
        else
            this.#state = state;
    }
    matches(event) {
        const assignment = this.#state.kind === "settled" || this.#state.kind === "bound"
            ? this.#state.assignment
            : this.pending();
        return (!!assignment &&
            assignment.agentId === event.agentId &&
            assignment.generation === event.generation &&
            assignment.piSessionId === event.piSessionId &&
            (assignment.assignmentGeneration === event.assignmentGeneration ||
                event.assignmentGeneration === undefined));
    }
}
