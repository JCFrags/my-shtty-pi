import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const VALUE_ADVICE_SCHEMA_VERSION = 1 as const;
export const VALUE_WORKER_THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ValueWorkerMode = "off" | "shadow" | "advisory";
export type ValueWorkerThinking = "inherit" | ModelThinkingLevel;
export type ValueWorkerStatusCode = "off" | "candidate-store-required" | "candidate-store-not-ready" | "no-pending-segments" | "no-eligible-items" | "scheduled" | "waiting-for-slot" | "running" | "shadow-complete" | "advisory-complete" | "model-not-found" | "model-auth-unavailable" | "model-capability-unsupported" | "thinking-unsupported" | "provider-timeout" | "provider-rate-limit" | "provider-temporary-failure" | "invalid-response" | "repair-failed" | "budget-exhausted" | "cost-unavailable" | "cost-limit-unenforceable" | "circuit-open" | "circuit-half-open" | "cancelled" | "advice-store-busy" | "advice-store-corrupt" | "advice-store-write-failed" | "unknown-value-worker-failure";

export interface ValueWorkerSettings {
  readonly mode: ValueWorkerMode;
  readonly model: string;
  readonly thinking: ValueWorkerThinking;
  readonly maxInputTokensPerJob: number;
  readonly maxOutputTokensPerJob: number;
  readonly maxItemsPerJob: number;
  readonly timeoutSeconds: number;
  readonly retries: number;
  readonly hostSlots: number;
  readonly maxCallsPerSession: number;
  readonly maxInputTokensPerSession: number;
  readonly maxOutputTokensPerSession: number;
  /** Authoritative monetary boundary. One USD is 1,000,000 micro-USD. */
  readonly maxEstimatedCostMicroUsd?: number;
  readonly circuitFailureLimit: number;
  readonly circuitCooldownSeconds: number;
}
export const DEFAULT_VALUE_WORKER_SETTINGS: ValueWorkerSettings = Object.freeze({ mode: "off", model: "main", thinking: "inherit", maxInputTokensPerJob: 6000, maxOutputTokensPerJob: 1500, maxItemsPerJob: 40, timeoutSeconds: 90, retries: 1, hostSlots: 1, maxCallsPerSession: 100, maxInputTokensPerSession: 250000, maxOutputTokensPerSession: 50000, circuitFailureLimit: 3, circuitCooldownSeconds: 1800 });

export type AdviceBand = "high" | "medium" | "low";
export interface ValueWorkerItem { readonly itemId: string; readonly sourceRole: "assistant" | "tool" | "user" | "custom" | "other"; readonly blockKind: string; readonly candidateKind: string; readonly error: boolean; readonly unresolved: boolean; readonly reproducible: boolean; readonly resourceKind?: string; readonly candidateLevels: readonly string[]; readonly candidateTokenSizes: readonly number[]; readonly staticImportance: "critical" | "high" | "normal" | "low"; readonly compressionRisk: AdviceBand; readonly excerpt?: string; readonly textBounded: boolean; readonly identifierCount: number; readonly duplicate: boolean; readonly ageBand: "old" | "middle" | "recent"; readonly safetyFloor: boolean; }
export type SemanticClass = "instruction" | "goal" | "decision" | "plan" | "blocker" | "failure" | "result" | "evidence" | "resource" | "status" | "routine" | "duplicate" | "unknown";
export interface ValueAdvice { readonly itemId: string; readonly semanticClass: SemanticClass; readonly importance: "critical" | "high" | "normal" | "low"; readonly compressionRisk: AdviceBand; readonly reuseLikelihood: AdviceBand; readonly uniqueness: AdviceBand; readonly action: "keep" | "compress" | "neutral"; readonly confidence: number; }
export interface ParsedValueAdvice { readonly advice: readonly ValueAdvice[]; readonly rejected: number; readonly unknown: number; readonly duplicates: number; readonly needsRepair: boolean; readonly status: "valid" | "invalid-top-level"; }
export interface ValueWorkerUsage { calls: number; repairCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicroUsd: number; costAvailable: boolean; }
export const emptyValueWorkerUsage = (): ValueWorkerUsage => ({ calls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0, costAvailable: false });
