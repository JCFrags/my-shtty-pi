import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

/** Product policy, not a user tuning surface. Token bounds do not enforce an
 * API output cap. The runtime must use caps accepted by its selected adapter. */
export const INTERVAL_POLICY = Object.freeze({
  identity: "chrono-interval-policy-v1" as const,
  version: 1 as const,
  maxPreparationTurns: 1,
  maxPreparationMs: 60_000,
  completionOutputCapTokens: 16_384,
});

export interface IntervalPolicyModel {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly contextWindow: number;
  /** Registry output ceiling, including reasoning where the adapter shares it. */
  readonly maxTokens: number;
}
/** Match Pi's planning reserve. This does not set a provider output cap. */
export function intervalResponseReserveTokens(model: IntervalPolicyModel): number {
  return Math.min(model.maxTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
}
export interface IntervalLayerBudget {
  readonly available: boolean;
  readonly reasons: readonly string[];
  readonly policyIdentity: typeof INTERVAL_POLICY.identity;
  readonly effectiveAvailableTokens: number;
  readonly exactTailTokens: number;
  readonly activePrefixTokens: number;
  readonly compressedHistoryTokens: number;
  readonly handoffTokens: number;
  readonly continuationTokens: number;
  readonly reserveTokens: number;
  readonly safetyTokens: number;
  readonly growthTokens: number;
  readonly preparationTokens: number;
  readonly handoffOutputTokens: number;
  /** Total request input, before output and safety, including normal overhead. */
  readonly requestBoundTokens: number;
  readonly noticeBoundTokens: number;
  readonly freezeBoundTokens: number;
}
export interface IntervalBudgetInput {
  readonly model: IntervalPolicyModel;
  readonly systemTokens?: number;
  readonly toolSchemaTokens?: number;
  readonly framingTokens?: number;
  readonly growthTokens?: number;
  /** Additional cap AFTER overhead/reserves. Cannot increase usable capacity. */
  readonly effectiveAvailableTokens?: number;
}
export interface IntervalPressureInput {
  readonly model: IntervalPolicyModel;
  readonly currentRequestTokens: number;
  readonly growthTokens?: number;
  readonly preparationStartedAt?: number;
  readonly preparationTurns?: number;
  /** Caller clock in milliseconds. Supply with preparationStartedAt for expiry.
   * Omitting it disables the time comparison, not the one-response bound. */
  readonly now?: number;
}
export interface IntervalPressure {
  readonly status: "normal" | "notice" | "freeze" | "recovery";
  readonly bound: number;
  readonly reasons: readonly string[];
  readonly budget: IntervalLayerBudget;
}

const integer = (value: number, minimum = 0): boolean => Number.isSafeInteger(value) && value >= minimum;
const emptyBudget = (reasons: readonly string[]): IntervalLayerBudget => Object.freeze({
  available: false, reasons: Object.freeze([...reasons]), policyIdentity: INTERVAL_POLICY.identity,
  effectiveAvailableTokens: 0, exactTailTokens: 0, activePrefixTokens: 0, compressedHistoryTokens: 0,
  handoffTokens: 0, continuationTokens: 0, reserveTokens: 0, safetyTokens: 0, growthTokens: 0,
  preparationTokens: 0, handoffOutputTokens: 0, requestBoundTokens: 0, noticeBoundTokens: 0, freezeBoundTokens: 0,
});

/** Derive allowances again after a model/overhead change using Pi's normal
 * planning reserve, not the model's maximum possible output.
 * Layer minima preserve a short handoff, continuation and complete exact unit.
 * B receives two allocation quanta for each quantum of the other layers. Caps
 * keep C small and leave unused capacity for resumed work on large windows. */
export function deriveIntervalBudget(input: IntervalBudgetInput): IntervalLayerBudget {
  const model = input.model, reasons: string[] = [];
  if (!model?.provider || !model.id || !model.api) reasons.push("interval-model-identity-unavailable");
  if (!integer(model?.contextWindow, 1)) reasons.push("interval-model-context-unavailable");
  if (!integer(model?.maxTokens, 1)) reasons.push("interval-model-output-unavailable");
  const system = input.systemTokens ?? 0, schemas = input.toolSchemaTokens ?? 0, framing = input.framingTokens ?? 512;
  if (![system, schemas, framing].every(value => integer(value))) reasons.push("interval-overhead-estimate-invalid");
  if (input.growthTokens !== undefined && !integer(input.growthTokens)) reasons.push("interval-growth-estimate-invalid");
  if (input.effectiveAvailableTokens !== undefined && !integer(input.effectiveAvailableTokens)) reasons.push("interval-available-capacity-invalid");
  if (reasons.length) return emptyBudget(reasons);
  const reserveTokens = intervalResponseReserveTokens(model);
  if (reserveTokens >= model.contextWindow) return emptyBudget(["interval-output-reserve-exhausts-context"]);
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
  const base = { policyIdentity: INTERVAL_POLICY.identity, effectiveAvailableTokens, reserveTokens, safetyTokens,
    growthTokens, preparationTokens, requestBoundTokens, noticeBoundTokens, freezeBoundTokens };
  // 256 output tokens cover headings/structure in addition to both text fields.
  const outputRoom = reserveTokens - 256;
  const continuationCap = Math.min(1_024, Math.floor(outputRoom / 8));
  const handoffCap = Math.min(4_096, outputRoom - continuationCap);
  if (handoffCap < 512 || continuationCap < 128) {
    return Object.freeze({ ...emptyBudget(["interval-handoff-output-capacity-insufficient"]), ...base });
  }
  if (effectiveAvailableTokens < 1_920 || noticeBoundTokens <= 0) {
    return Object.freeze({ ...emptyBudget(["interval-restart-capacity-insufficient"]), ...base });
  }
  const layers = { exactTailTokens: 512, activePrefixTokens: 256, compressedHistoryTokens: 512,
    handoffTokens: 512, continuationTokens: 128 };
  const caps = { exactTailTokens: 8_192, activePrefixTokens: 4_096, compressedHistoryTokens: 16_384,
    handoffTokens: handoffCap, continuationTokens: continuationCap };
  const order = ["compressedHistoryTokens", "exactTailTokens", "handoffTokens", "compressedHistoryTokens",
    "activePrefixTokens", "continuationTokens"] as const;
  let remaining = effectiveAvailableTokens - 1_920;
  while (remaining > 0) {
    let changed = false;
    for (const name of order) {
      const grant = Math.min(128, remaining, caps[name] - layers[name]);
      if (grant <= 0) continue;
      layers[name] += grant; remaining -= grant; changed = true;
    }
    if (!changed) break;
  }
  return Object.freeze({ ...base, ...layers, available: true, reasons: Object.freeze([]),
    handoffOutputTokens: layers.handoffTokens + layers.continuationTokens + 256 });
}

/** Pure classification. The caller supplies time rather than reading a clock
 * here. A preparation response cannot become another ordinary work turn. */
export function classifyPressure(input: IntervalPressureInput): IntervalPressure {
  const budget = deriveIntervalBudget({ model: input.model, growthTokens: input.growthTokens });
  const result = (status: IntervalPressure["status"], reasons: readonly string[]): IntervalPressure => Object.freeze({
    status, bound: budget.requestBoundTokens, reasons: Object.freeze([...reasons]), budget,
  });
  if (!budget.available) return result("recovery", budget.reasons);
  if (!integer(input.currentRequestTokens, 1)) return result("recovery", ["interval-request-estimate-invalid"]);
  if ((input.preparationTurns !== undefined && !integer(input.preparationTurns))
    || (input.preparationStartedAt !== undefined && !integer(input.preparationStartedAt))
    || (input.now !== undefined && (!integer(input.now) || (input.preparationStartedAt !== undefined && input.now < input.preparationStartedAt)))) {
    return result("recovery", ["interval-preparation-state-invalid"]);
  }
  // These estimates trigger the summary-only response. They are not provider
  // limits and must not prevent the response that reduces the current context.
  if (input.currentRequestTokens >= budget.freezeBoundTokens) return result("freeze", ["interval-freeze-bound-reached"]);
  if ((input.preparationTurns ?? 0) >= INTERVAL_POLICY.maxPreparationTurns) return result("freeze", ["interval-preparation-response-completed"]);
  if (input.preparationStartedAt !== undefined && input.now !== undefined
    && input.now - input.preparationStartedAt >= INTERVAL_POLICY.maxPreparationMs) return result("freeze", ["interval-preparation-deadline-reached"]);
  if (input.preparationStartedAt !== undefined || input.currentRequestTokens >= budget.noticeBoundTokens) return result("notice", ["interval-preparation-required"]);
  return result("normal", []);
}
