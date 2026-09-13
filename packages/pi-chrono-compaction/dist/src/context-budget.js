/** Token policy only. Native memory, source I/O, row and deadline limits are independent. */
export const MAX_CONTEXT_TOKENS = 250_000;
export const DEFAULT_CONTEXT_TOKENS = 32_000;
export const DEFAULT_RESPONSE_RESERVE_TOKENS = 16_384;
export function validateContextCeiling(tokens) {
    if (!Number.isSafeInteger(tokens) || tokens < 512 || tokens > MAX_CONTEXT_TOKENS) {
        throw new Error(`Context ceiling must be an integer from 512 to ${MAX_CONTEXT_TOKENS} tokens.`);
    }
}
/** Re-evaluate for the selected model on every operation, including after a model switch. */
export function resolveContextCeiling(configuredTokens, contextWindow, overheadTokens = 0, responseReserveTokens = DEFAULT_RESPONSE_RESERVE_TOKENS) {
    validateContextCeiling(configuredTokens);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1
        || !Number.isSafeInteger(overheadTokens) || overheadTokens < 0
        || !Number.isSafeInteger(responseReserveTokens) || responseReserveTokens < 0) {
        throw new Error("Selected model context capacity or reserved token budget is unavailable.");
    }
    const ceiling = Math.min(configuredTokens, contextWindow - overheadTokens - responseReserveTokens);
    validateContextCeiling(ceiling);
    return ceiling;
}
//# sourceMappingURL=context-budget.js.map