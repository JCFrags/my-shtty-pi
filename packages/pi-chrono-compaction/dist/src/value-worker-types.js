export const VALUE_ADVICE_SCHEMA_VERSION = 1;
export const VALUE_WORKER_THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_VALUE_WORKER_SETTINGS = Object.freeze({ mode: "off", model: "main", thinking: "inherit", maxInputTokensPerJob: 6000, maxOutputTokensPerJob: 1500, maxItemsPerJob: 40, timeoutSeconds: 90, retries: 1, hostSlots: 1, maxCallsPerSession: 100, maxInputTokensPerSession: 250000, maxOutputTokensPerSession: 50000, circuitFailureLimit: 3, circuitCooldownSeconds: 1800 });
export const emptyValueWorkerUsage = () => ({ calls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0, costAvailable: false });
//# sourceMappingURL=value-worker-types.js.map