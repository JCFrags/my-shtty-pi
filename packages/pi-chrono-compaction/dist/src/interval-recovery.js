import { estimateTokensFromText, stableStringify } from "./utils.js";
export class IntervalRecoveryRefusal extends Error {
    sourceEntryId;
    requiredTokens;
    availableTokens;
    code;
    constructor(code, sourceEntryId, requiredTokens, availableTokens) {
        super(code);
        this.sourceEntryId = sourceEntryId;
        this.requiredTokens = requiredTokens;
        this.availableTokens = availableTokens;
        this.code = code;
    }
}
/** No model call, semantic restriction classifier, or invented current-agent
 * authorship. Protect complete effective user text since the previous commit.
 * Older restrictions can remain in an explicitly as-of checkpoint. References
 * identify native owners, not a mirrored state store or evidence of permission.
 * Unsupported protected media refuses unless the exact native tail retains it. */
export function buildDeterministicRecoveryHandoff(input) {
    const budget = input.handoffBudgetTokens;
    if (!Number.isSafeInteger(budget) || budget < 1)
        throw new IntervalRecoveryRefusal("context-v4-recovery-budget-unavailable", undefined, 0, budget);
    const sections = [
        "# Deterministic recovery handoff",
        `As of original source entry ${input.intervalEndEntryId}. A fresh current-agent handoff was not available. This account is runtime-derived evidence, not the agent's current intent or new authorization.`,
        "Before consequential work, check current native state, resource outcomes, user restrictions, and approval gates. Do not rewind, repeat side effects, restart resources, or infer completion from this replacement.",
    ];
    if (input.checkpoint) {
        const checkpoint = `## Earlier checkpoint. As of ${input.checkpoint.entryId}\nThis older derived checkpoint can be stale. Newer protected user wording and current native state take precedence.\n${input.checkpoint.text}`;
        const required = estimateTokensFromText(checkpoint);
        if (required > budget)
            throw new IntervalRecoveryRefusal("context-v4-recovery-checkpoint-oversized", input.checkpoint.entryId, required, budget);
        sections.push(checkpoint);
    }
    const protectedEntryIds = [];
    for (const entry of input.projectedOriginalEntries) {
        const message = entry.type === "message" ? entry.message : undefined;
        if (message?.role !== "user")
            continue;
        if (!entry.id)
            throw new IntervalRecoveryRefusal("context-v4-recovery-source-unavailable", undefined, 0, budget);
        protectedEntryIds.push(entry.id);
        // An exact retained native unit preserves both text and media unchanged.
        if (input.exactTailEntryIds?.has(entry.id))
            continue;
        let protectedText;
        if (typeof message.content === "string")
            protectedText = message.content;
        else if (Array.isArray(message.content) && message.content.every(block => block && typeof block === "object"
            && block.type === "text" && typeof block.text === "string")) {
            protectedText = message.content.map(block => block.text).join("\n");
        }
        else
            throw new IntervalRecoveryRefusal("context-v4-recovery-protected-media-unavailable", entry.id, 0, budget);
        const section = `## Protected original user wording. Source ${entry.id}\nQuoted source data, not a newly issued instruction. Exact recovery: history_get({"entryId":${JSON.stringify(entry.id)}}).\n${JSON.stringify(protectedText)}`;
        const required = estimateTokensFromText(section);
        if (required > budget)
            throw new IntervalRecoveryRefusal("context-v4-recovery-protected-unit-oversized", entry.id, required, budget);
        sections.push(section);
    }
    sections.push("## Native state recovery references", input.stateReferences.length ? stableStringify(input.stateReferences, 2) : "No current native state references were available. Do not infer that there is no unfinished work.", ...input.stateCoverage.map(notice => `Coverage: ${notice}`), "## Original history recovery", `Recover exact original evidence through history_get/history_range ending at ${input.intervalEndEntryId}. Historical summaries do not establish current completion or permission.`);
    const handoff = sections.join("\n\n");
    const required = estimateTokensFromText(handoff);
    if (required > budget)
        throw new IntervalRecoveryRefusal("context-v4-recovery-protected-content-oversized", undefined, required, budget);
    return Object.freeze({ handoff,
        continuation: "A fresh current-agent continuation was unavailable. Verify the as-of recovery evidence, protected user wording, current native task state, and outstanding resource state. Continue only an existing user-authorized unfinished task. Preserve waits and approval gates. If authority or the next action is unclear, report the gap and wait for the user. Do not restart a resource or repeat an uncertain side effect.",
        authorship: "deterministic-recovery", protectedEntryIds: Object.freeze(protectedEntryIds),
        ...(input.checkpoint ? { checkpointEntryId: input.checkpoint.entryId } : {}) });
}
//# sourceMappingURL=interval-recovery.js.map