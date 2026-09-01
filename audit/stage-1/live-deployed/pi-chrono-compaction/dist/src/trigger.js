export function decideCompactionTrigger(input) {
    if (input.thresholdTokens === undefined) {
        return { trigger: false, reason: "extension trigger disabled; Pi controls context-pressure compaction" };
    }
    if (input.pending)
        return { trigger: false, reason: "a compaction request is already pending" };
    const current = Math.max(0, Math.floor(input.currentTokens));
    const threshold = Math.max(1, Math.floor(input.thresholdTokens));
    if (current < threshold) {
        return { trigger: false, reason: `current context ${current} is below extension threshold ${threshold}` };
    }
    if (input.lastAttemptTokens !== undefined) {
        const required = Math.max(0, Math.floor(input.minimumGrowthTokens));
        const growth = current - input.lastAttemptTokens;
        if (growth < required) {
            return {
                trigger: false,
                reason: `context grew by ${growth} token(s) since the last attempt; ${required} token(s) are required`,
            };
        }
    }
    return {
        trigger: true,
        reason: `current context ${current} reached extension threshold ${threshold}`,
    };
}
//# sourceMappingURL=trigger.js.map