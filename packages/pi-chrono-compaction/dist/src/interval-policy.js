import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
/** Product policy, not a user tuning surface. Token bounds do not enforce an
 * API output cap. The runtime must use caps accepted by its selected adapter. */
export const INTERVAL_POLICY = Object.freeze({
    identity: "chrono-interval-policy-v2",
    version: 2,
    exactTailMinimumTurns: 3,
    maxPreparationTurns: 1,
    maxPreparationMs: 60_000,
    completionOutputCapTokens: 16_384,
});
/** Match Pi's planning reserve. This does not set a provider output cap. */
export function intervalResponseReserveTokens(model) {
    return Math.min(model.maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
}
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const emptyBudget = (reasons) => Object.freeze({
    available: false, reasons: Object.freeze([...reasons]), policyIdentity: INTERVAL_POLICY.identity,
    exactTailMinimumTurns: INTERVAL_POLICY.exactTailMinimumTurns,
    effectiveAvailableTokens: 0, exactTailTokens: 0, activePrefixTokens: 0, compressedHistoryTokens: 0,
    handoffTokens: 0, continuationTokens: 0, reserveTokens: 0, safetyTokens: 0, growthTokens: 0,
    preparationTokens: 0, handoffOutputTokens: 0, requestBoundTokens: 0, noticeBoundTokens: 0, freezeBoundTokens: 0,
});
/** Derive allowances again after a model/overhead change using Pi's normal
 * planning reserve, not the model's maximum possible output.
 * Layer minima preserve a short handoff, continuation and complete exact unit.
 * B receives two allocation quanta for each quantum of the other layers. Caps
 * keep C small and leave unused capacity for resumed work on large windows. */
export function deriveIntervalBudget(input) {
    const model = input.model, reasons = [];
    if (!model?.provider || !model.id || !model.api)
        reasons.push("interval-model-identity-unavailable");
    if (!integer(model?.contextWindow, 1))
        reasons.push("interval-model-context-unavailable");
    if (!integer(model?.maxTokens, 1))
        reasons.push("interval-model-output-unavailable");
    const system = input.systemTokens ?? 0, schemas = input.toolSchemaTokens ?? 0, framing = input.framingTokens ?? 512;
    if (![system, schemas, framing].every(value => integer(value)))
        reasons.push("interval-overhead-estimate-invalid");
    if (input.growthTokens !== undefined && !integer(input.growthTokens))
        reasons.push("interval-growth-estimate-invalid");
    if (input.effectiveAvailableTokens !== undefined && !integer(input.effectiveAvailableTokens))
        reasons.push("interval-available-capacity-invalid");
    if (reasons.length)
        return emptyBudget(reasons);
    const reserveTokens = intervalResponseReserveTokens(model);
    if (reserveTokens >= model.contextWindow)
        return emptyBudget(["interval-output-reserve-exhausts-context"]);
    // One safety quantum per 128 capacity tokens, with at least two framing
    // quanta. This is a conservative policy allowance, not a tokenizer claim.
    const safetyTokens = Math.max(1_024, Math.ceil(model.contextWindow / 128));
    const preparationTokens = 512; // control message and submission envelope
    const preparationResponseTokens = Math.min(reserveTokens, 2_048);
    const growthTokens = Math.max(input.growthTokens ?? 0, preparationResponseTokens);
    const requestBoundTokens = Math.max(0, model.contextWindow - reserveTokens - safetyTokens);
    const freezeBoundTokens = Math.max(0, requestBoundTokens - preparationTokens);
    const noticeBoundTokens = Math.max(0, freezeBoundTokens - preparationResponseTokens - growthTokens);
    const usable = requestBoundTokens - system - schemas - Math.max(512, framing) - preparationTokens - growthTokens;
    const effectiveAvailableTokens = Math.max(0, Math.min(usable, input.effectiveAvailableTokens ?? usable));
    const base = { policyIdentity: INTERVAL_POLICY.identity, exactTailMinimumTurns: INTERVAL_POLICY.exactTailMinimumTurns,
        effectiveAvailableTokens, reserveTokens, safetyTokens,
        growthTokens, preparationTokens, requestBoundTokens, noticeBoundTokens, freezeBoundTokens };
    // 256 output tokens cover headings/structure in addition to both text fields.
    const outputRoom = reserveTokens - 256;
    const continuationCap = Math.min(256, Math.floor(outputRoom / 8));
    const handoffCap = Math.min(1_792, outputRoom - continuationCap);
    if (handoffCap < 512 || continuationCap < 128) {
        return Object.freeze({ ...emptyBudget(["interval-handoff-output-capacity-insufficient"]), ...base });
    }
    if (effectiveAvailableTokens < 1_920 || noticeBoundTokens <= 0) {
        return Object.freeze({ ...emptyBudget(["interval-restart-capacity-insufficient"]), ...base });
    }
    const layers = { exactTailTokens: 512, activePrefixTokens: 256, compressedHistoryTokens: 512,
        handoffTokens: 512, continuationTokens: 128 };
    const caps = { exactTailTokens: 4_096, activePrefixTokens: 1_024, compressedHistoryTokens: 4_096,
        handoffTokens: handoffCap, continuationTokens: continuationCap };
    const order = ["compressedHistoryTokens", "exactTailTokens", "handoffTokens", "compressedHistoryTokens",
        "activePrefixTokens", "continuationTokens"];
    let remaining = effectiveAvailableTokens - 1_920;
    while (remaining > 0) {
        let changed = false;
        for (const name of order) {
            const grant = Math.min(128, remaining, caps[name] - layers[name]);
            if (grant <= 0)
                continue;
            layers[name] += grant;
            remaining -= grant;
            changed = true;
        }
        if (!changed)
            break;
    }
    return Object.freeze({ ...base, ...layers, available: true, reasons: Object.freeze([]),
        handoffOutputTokens: layers.handoffTokens + layers.continuationTokens + 256 });
}
/** Pure classification. The caller supplies time rather than reading a clock
 * here. A preparation response cannot become another ordinary work turn. */
export function classifyPressure(input) {
    const budget = deriveIntervalBudget({ model: input.model, growthTokens: input.growthTokens });
    const result = (status, reasons) => Object.freeze({
        status, bound: budget.requestBoundTokens, reasons: Object.freeze([...reasons]), budget,
    });
    if (!budget.available)
        return result("recovery", budget.reasons);
    if (!integer(input.currentRequestTokens, 1))
        return result("recovery", ["interval-request-estimate-invalid"]);
    if ((input.preparationTurns !== undefined && !integer(input.preparationTurns))
        || (input.preparationStartedAt !== undefined && !integer(input.preparationStartedAt))
        || (input.now !== undefined && (!integer(input.now) || (input.preparationStartedAt !== undefined && input.now < input.preparationStartedAt)))) {
        return result("recovery", ["interval-preparation-state-invalid"]);
    }
    // These estimates trigger the summary-only response. They are not provider
    // limits and must not prevent the response that reduces the current context.
    if (input.currentRequestTokens >= budget.freezeBoundTokens)
        return result("freeze", ["interval-freeze-bound-reached"]);
    if ((input.preparationTurns ?? 0) >= INTERVAL_POLICY.maxPreparationTurns)
        return result("freeze", ["interval-preparation-response-completed"]);
    if (input.preparationStartedAt !== undefined && input.now !== undefined
        && input.now - input.preparationStartedAt >= INTERVAL_POLICY.maxPreparationMs)
        return result("freeze", ["interval-preparation-deadline-reached"]);
    if (input.preparationStartedAt !== undefined || input.currentRequestTokens >= budget.noticeBoundTokens)
        return result("notice", ["interval-preparation-required"]);
    return result("normal", []);
}
//# sourceMappingURL=interval-policy.js.map