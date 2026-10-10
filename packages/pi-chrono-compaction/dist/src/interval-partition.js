import { chargeRawTail } from "./context-budget.js";
/** Select complete original interactions before rendering any lossy text. The
 * caller supplies source-bound gaps and model-derived allowances. This function
 * has no user timing knobs and cannot convert a timeout into a complete unit. */
export function selectIntervalPartition(input) {
    const { units } = input;
    for (const value of [input.exactTailTokens, input.exactTailMaximumTokens, input.compressedHistoryTokens]) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("context-v4-interval-partition-budget-invalid");
    }
    if (input.exactTailTokens > input.exactTailMaximumTokens || units.length > 16_384)
        throw new Error("context-v4-interval-partition-budget-invalid");
    let end = 0;
    for (const unit of units) {
        if (!unit.complete)
            throw new Error("context-v4-interval-incomplete-interaction");
        if (!unit.events.length || unit.start !== end || !Number.isSafeInteger(unit.endExclusive) || unit.endExclusive <= unit.start) {
            throw new Error("context-v4-interval-unit-range-invalid");
        }
        end = unit.endExclusive;
    }
    if (!units.length)
        return { start: 0, compressedStart: 0, rawStart: 0, endExclusive: 0,
            prefixUnitCount: 0, compressedUnitCount: 0, exactUnitCount: 0, exactTokens: 0, exactMessages: 0,
            compressedReason: "empty", exactReason: "empty" };
    let rawUnitIndex = units.length - 1;
    const charge = (from) => chargeRawTail(units.slice(from).flatMap(unit => unit.events.map(event => event.projectedEntry)));
    let exact = charge(rawUnitIndex);
    if (exact.tokens > input.exactTailMaximumTokens)
        throw new Error("context-v4-interval-required-unit-oversized");
    const expanded = exact.tokens > input.exactTailTokens;
    while (rawUnitIndex > 0 && !expanded) {
        // Do not grow through the existing native conversion bound. The newest
        // required unit itself must pass; no exception turns a partial tail exact.
        const candidateEntries = units.slice(rawUnitIndex - 1).reduce((sum, unit) => sum + unit.events.length, 0);
        if (candidateEntries > 256)
            break;
        const candidate = charge(rawUnitIndex - 1);
        if (candidate.tokens > input.exactTailTokens)
            break;
        rawUnitIndex--;
        exact = candidate;
    }
    const rawStart = units[rawUnitIndex].start;
    // Recent compressed history is bounded by original content, not elapsed time
    // or a fixed number of turns. The factor is a versioned selection heuristic,
    // not a claimed compression ratio or permission to exceed the output budget.
    const sourceAllowance = input.compressedHistoryTokens * 4;
    let compressedUnitIndex = rawUnitIndex, recentSourceTokens = 0;
    while (compressedUnitIndex > 0) {
        const unit = units[compressedUnitIndex - 1];
        if (unit.events.length > 256)
            break;
        const tokens = chargeRawTail(unit.events.map(event => event.projectedEntry)).tokens;
        if (recentSourceTokens + tokens > sourceAllowance && compressedUnitIndex < rawUnitIndex)
            break;
        if (tokens > sourceAllowance)
            break;
        recentSourceTokens += tokens;
        compressedUnitIndex--;
    }
    let compressedReason = rawUnitIndex === 0 ? "empty" : "token-fit";
    const earliest = units[compressedUnitIndex]?.start ?? rawStart;
    const legal = new Map(units.map((unit, index) => [unit.start, index]));
    const weight = { "phase-transition": 4, wait: 3, "saved-position": 2, context: 1 };
    const eligible = (input.hints ?? []).filter(hint => hint.gap >= earliest && hint.gap < rawStart
        && legal.has(hint.gap) && units.some(unit => unit.endExclusive === hint.gap && unit.events.some(event => event.entryId === hint.sourceEntryId)));
    eligible.sort((a, b) => weight[b.kind] - weight[a.kind] || a.gap - b.gap);
    if (eligible[0]) {
        compressedUnitIndex = legal.get(eligible[0].gap);
        compressedReason = eligible[0].kind;
    }
    const compressedStart = units[compressedUnitIndex]?.start ?? rawStart;
    if (compressedStart > rawStart || rawStart > end)
        throw new Error("context-v4-interval-partition-overlap");
    return { start: 0, compressedStart, rawStart, endExclusive: end,
        prefixUnitCount: compressedUnitIndex, compressedUnitCount: rawUnitIndex - compressedUnitIndex,
        exactUnitCount: units.length - rawUnitIndex, exactTokens: exact.tokens, exactMessages: exact.messages,
        compressedReason, exactReason: expanded ? "required-unit-expanded" : "newest-complete-units" };
}
//# sourceMappingURL=interval-partition.js.map