export const VALUE_ADVICE_CONFIDENCE_THRESHOLD = 0.6;
function floor(unit) { return unit.protectedExact || unit.kind === "user" || unit.kind === "custom_message" || unit.importanceReasons.some(x => /unresolved|blocker|required exact|current resource|current conflict|hard.keep|tool pair/i.test(x)); }
export function applyValueAdvice(units, advice, mode) { let applied = 0, ignored = 0, protectedRejected = 0; const next = units.map(unit => { const a = advice.get(unit.id); if (!a || a.confidence < VALUE_ADVICE_CONFIDENCE_THRESHOLD) {
    if (a)
        ignored++;
    return unit;
} if (floor(unit)) {
    if (a.action === "compress" || a.importance === "low")
        protectedRejected++;
    return unit;
} let delta = 0; if (a.action === "keep" || a.importance === "critical" || a.importance === "high")
    delta = Math.min(25, a.confidence * 25);
else if (a.action === "compress" || a.importance === "low")
    delta = -Math.min(15, a.confidence * 15); if (delta === 0)
    return unit; applied++; return mode === "advisory" ? { ...unit, importance: Math.max(1, unit.importance + delta), importanceReasons: [...unit.importanceReasons, "bounded background value advice"] } : unit; }); return { units: next, metrics: { applied, ignored, protectedRejected } }; }
//# sourceMappingURL=value-advice-application.js.map