export const ROLLUP_SHADOW_FAILURE_STAGES = [
  "request-validation",
  "scheduler-wait",
  "child-start",
  "source-bind",
  "source-ledger-update",
  "prefix-validation",
  "rollup-manifest-load",
  "rollup-update",
  "rollup-render",
  "rollup-validation",
  "shadow-sidecar-read",
  "shadow-sidecar-write",
  "response-validation",
  "cleanup",
  "unknown-stage",
] as const;

export type RollupShadowFailureStage = typeof ROLLUP_SHADOW_FAILURE_STAGES[number];

export const ROLLUP_SHADOW_FAILURE_CODES = [
  "shadow-source-changed",
  "shadow-invalid-cut",
  "shadow-empty-prefix",
  "shadow-ledger-unavailable",
  "shadow-ledger-corrupt",
  "shadow-store-busy",
  "shadow-manifest-corrupt",
  "shadow-node-corrupt",
  "shadow-node-too-large",
  "shadow-open-context-limit",
  "shadow-memory-gate",
  "shadow-update-failed",
  "shadow-render-failed",
  "shadow-validation-failed",
  "shadow-sidecar-read-failed",
  "shadow-sidecar-write-failed",
  "shadow-response-too-large",
  "shadow-protocol-error",
  "worker-timeout",
  "worker-aborted",
  "worker-crashed",
  "unknown-worker-failure",
] as const;

export type RollupShadowFailureCode = typeof ROLLUP_SHADOW_FAILURE_CODES[number];

export interface RollupShadowFailureContext {
  readonly sourceFileBytes?: number;
  readonly sourceLedgerEntries?: number;
  readonly branchEntries?: number;
  readonly treeLevels?: number;
  readonly leafCount?: number;
  readonly rollupCount?: number;
  readonly reachableNodeBytes?: number;
  readonly currentMemoryBytes?: number;
  readonly sourceBytesRead?: number;
  readonly nodeBytesRead?: number;
  readonly nodeBytes?: number;
  readonly nodeTypeCode?: number;
  readonly responseBytes?: number;
}

export interface ClassifiedRollupShadowFailure {
  readonly stage: RollupShadowFailureStage;
  readonly code: RollupShadowFailureCode;
  readonly context?: RollupShadowFailureContext;
}

const ERROR_CODE_MAP: Readonly<Record<string, RollupShadowFailureCode>> = {
  "source-changed": "shadow-source-changed",
  "invalid-cut": "shadow-invalid-cut",
  "empty-prefix": "shadow-empty-prefix",
  "no-session-file": "shadow-ledger-unavailable",
  "source-ledger-unavailable": "shadow-ledger-unavailable",
  "source-ledger-corrupt": "shadow-ledger-corrupt",
  "history-rollup-store-busy": "shadow-store-busy",
  "history-rollup-manifest-corrupt": "shadow-manifest-corrupt",
  "history-rollup-integrity": "shadow-manifest-corrupt",
  "history-rollup-node-corrupt": "shadow-node-corrupt",
  "history-rollup-existing-node-corrupt": "shadow-node-corrupt",
  "history-rollup-node-type": "shadow-node-corrupt",
  "history-rollup-node-too-large": "shadow-node-too-large",
  "history-rollup-open-context-limit": "shadow-open-context-limit",
  "shadow-memory-gate": "shadow-memory-gate",
  "history-rollup-update-failed": "shadow-update-failed",
  "history-rollup-render-failed": "shadow-render-failed",
  "history-rollup-validation-failed": "shadow-validation-failed",
  "rollup-shadow-sidecar-read-failed": "shadow-sidecar-read-failed",
  "rollup-shadow-sidecar-write-failed": "shadow-sidecar-write-failed",
  "worker-response-too-large": "shadow-response-too-large",
  "worker-protocol-error": "shadow-protocol-error",
  "worker-timeout": "worker-timeout",
  "worker-aborted": "worker-aborted",
  "worker-crashed": "worker-crashed",
};

export function classifyRollupShadowFailure(
  stage: RollupShadowFailureStage,
  error: unknown,
  context?: RollupShadowFailureContext,
): ClassifiedRollupShadowFailure {
  const rawCode = (error as { code?: unknown })?.code;
  const rawMessage = error instanceof Error ? error.message : undefined;
  const identity = typeof rawCode === "string" ? rawCode : rawMessage;
  const code = identity ? ERROR_CODE_MAP[identity] : undefined;
  if (code) return { stage, code, ...(context ? { context } : {}) };
  const fallback: RollupShadowFailureCode = stage === "source-bind"
    ? "shadow-ledger-unavailable"
    : stage === "source-ledger-update"
      ? "shadow-ledger-corrupt"
      : stage === "prefix-validation"
        ? "shadow-invalid-cut"
        : stage === "rollup-manifest-load"
          ? "shadow-manifest-corrupt"
          : stage === "rollup-update"
            ? "shadow-update-failed"
            : stage === "rollup-render"
              ? "shadow-render-failed"
              : stage === "rollup-validation"
                ? "shadow-validation-failed"
                : stage === "shadow-sidecar-read"
                  ? "shadow-sidecar-read-failed"
                  : stage === "shadow-sidecar-write"
                    ? "shadow-sidecar-write-failed"
                    : stage === "response-validation"
                      ? "shadow-protocol-error"
                      : "unknown-worker-failure";
  return { stage, code: fallback, ...(context ? { context } : {}) };
}

const SAFE_CONTEXT_KEYS = new Set<keyof RollupShadowFailureContext>([
  "sourceFileBytes", "sourceLedgerEntries", "branchEntries", "treeLevels", "leafCount", "rollupCount",
  "reachableNodeBytes", "currentMemoryBytes", "sourceBytesRead", "nodeBytesRead", "nodeBytes", "nodeTypeCode", "responseBytes",
]);

export function safeFailureContext(value: RollupShadowFailureContext | undefined): RollupShadowFailureContext | undefined {
  if (!value) return undefined;
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SAFE_CONTEXT_KEYS.has(key as keyof RollupShadowFailureContext) && typeof item === "number" && Number.isSafeInteger(item) && item >= 0) output[key] = item;
  }
  return Object.keys(output).length ? output as RollupShadowFailureContext : undefined;
}
