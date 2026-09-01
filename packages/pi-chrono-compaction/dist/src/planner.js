import { estimateTokensFromText } from "./utils.js";
export function candidateEstimatedCost(unit, candidate) {
    if (candidate.level === "absent")
        return 0;
    const labelTokens = unit.kind === "episode" ? 20 : 16;
    const omissionTokens = candidate.omissions.reduce((sum, omission) => sum + estimateTokensFromText(omission.description) + 4, 0);
    const retrievalTokens = unit.kind === "episode" ? 14 : candidate.lossy ? 12 : 0;
    return labelTokens + candidate.tokens + omissionTokens + retrievalTokens;
}
function frontierFor(unit) {
    const points = unit.candidates
        .map((candidate) => ({ candidate, cost: candidateEstimatedCost(unit, candidate) }))
        .sort((a, b) => a.cost - b.cost || a.candidate.utility - b.candidate.utility);
    const frontier = [];
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (const point of points) {
        if (point.candidate.utility <= bestUtility + 1e-9)
            continue;
        frontier.push(point);
        bestUtility = point.candidate.utility;
    }
    if (frontier.length === 0)
        throw new Error(`Unit ${unit.id} has no usable representation candidates`);
    return frontier;
}
function nextUpgrade(state, stateIndex, config, totalUnits) {
    const fromIndex = state.selectedIndex;
    const toIndex = fromIndex + 1;
    const from = state.frontier[fromIndex];
    const to = state.frontier[toIndex];
    if (!from || !to)
        return undefined;
    const deltaCost = to.cost - from.cost;
    if (deltaCost <= 0)
        return undefined;
    const recency = totalUnits <= 1 ? 1 : stateIndex / (totalUnits - 1);
    const recencyBonus = 1 + recency * config.recentExactBiasFraction * 1.75;
    const weightedGain = (to.candidate.utility - from.candidate.utility) * state.unit.importance * recencyBonus;
    return {
        stateIndex,
        fromIndex,
        toIndex,
        deltaCost,
        weightedGain,
        ratio: weightedGain / deltaCost,
    };
}
export function planCompression(units, targetTokens, config) {
    const states = units.map((unit) => ({ unit, frontier: frontierFor(unit), selectedIndex: 0 }));
    let used = states.reduce((sum, state) => sum + (state.frontier[0]?.cost ?? 0), 0);
    const warnings = [];
    if (used > targetTokens) {
        warnings.push(`Minimum safe representations require approximately ${used} tokens, exceeding the ${targetTokens}-token target.`);
    }
    while (used < targetTokens) {
        const upgrades = states
            .map((state, index) => nextUpgrade(state, index, config, states.length))
            .filter((upgrade) => upgrade !== undefined)
            .filter((upgrade) => used + upgrade.deltaCost <= targetTokens)
            .sort((a, b) => b.ratio - a.ratio || b.weightedGain - a.weightedGain || a.stateIndex - b.stateIndex);
        const chosen = upgrades[0];
        if (!chosen)
            break;
        if (chosen.ratio + 1e-9 < config.minMarginalUtilityPerToken) {
            warnings.push(`Planner left approximately ${Math.max(0, targetTokens - used)} token(s) unused because remaining upgrades were below the minimum marginal-value threshold (${config.minMarginalUtilityPerToken}).`);
            break;
        }
        const state = states[chosen.stateIndex];
        if (!state || state.selectedIndex !== chosen.fromIndex)
            continue;
        state.selectedIndex = chosen.toIndex;
        used += chosen.deltaCost;
    }
    const planned = states.map((state) => ({
        ...state.unit,
        selected: state.frontier[state.selectedIndex].candidate,
    }));
    return {
        targetTokens,
        estimatedTokens: used,
        rawTokens: units.reduce((sum, unit) => sum + unit.rawTokens, 0),
        units: planned,
        warnings,
    };
}
//# sourceMappingURL=planner.js.map