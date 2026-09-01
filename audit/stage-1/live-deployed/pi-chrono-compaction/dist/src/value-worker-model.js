import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
export async function resolveValueWorkerModel(ctx, settings) {
    let model;
    if (settings.model === "main")
        model = ctx.model;
    else {
        const slash = settings.model.indexOf("/");
        if (slash < 1)
            return { status: "model-not-found" };
        model = ctx.modelRegistry.find(settings.model.slice(0, slash), settings.model.slice(slash + 1));
    }
    if (!model)
        return { status: "model-not-found" };
    if (!ctx.modelRegistry.hasConfiguredAuth(model))
        return { status: "model-auth-unavailable" };
    const thinking = settings.thinking === "inherit" ? (ctx.thinkingLevel ?? "off") : settings.thinking;
    if (!getSupportedThinkingLevels(model).includes(thinking))
        return { status: "thinking-unsupported" };
    return { status: "ready", model, identity: `${model.provider}/${model.id}`, thinking, costAvailable: modelPricesAvailable(model) };
}
export function createPiValueModelCall(ctx) {
    const registry = ctx.modelRegistry;
    return { call: (model, prompt, options) => registry.complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { maxTokens: Math.min(model.maxTokens, options.maxTokens), ...(options.thinking === "off" ? {} : { reasoning: options.thinking }), signal: options.signal, cacheRetention: "none" }) };
}
export function assistantText(response) { return response.content.flatMap((x) => x.type === "text" ? [x.text] : []).join("\n").trim(); }
export function usdToMicroUsd(value) { if (!Number.isFinite(value) || value < 0)
    return undefined; const result = Math.ceil(value * 1_000_000); return Number.isSafeInteger(result) ? result : undefined; }
export function modelPricesAvailable(model) { return [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every((x) => Number.isFinite(x) && x >= 0); }
/** Pi prices are USD per million tokens, which is numerically micro-USD per token. */
export function upperBoundCostMicroUsd(model, inputTokens, outputTokens) {
    if (!modelPricesAvailable(model))
        return undefined;
    return Math.ceil(inputTokens * model.cost.input) + Math.ceil(outputTokens * model.cost.output);
}
export function actualCostMicroUsd(model, usage) {
    const provider = usdToMicroUsd(usage.cost.total);
    if (provider !== undefined && provider > 0)
        return provider;
    if (!modelPricesAvailable(model))
        return undefined;
    return Math.ceil(usage.input * model.cost.input) + Math.ceil(usage.output * model.cost.output) + Math.ceil(usage.cacheRead * model.cost.cacheRead) + Math.ceil(usage.cacheWrite * model.cost.cacheWrite);
}
export function classifyProviderFailure(error, signal) {
    if (signal?.aborted)
        return { status: "cancelled", transient: false };
    const values = [];
    let current = error;
    for (let i = 0; i < 4 && current && typeof current === "object"; i++) {
        const item = current;
        values.push(item.status, item.statusCode, item.code, item.type, item.name);
        current = item.cause;
    }
    const statuses = values.filter((x) => Number.isInteger(x));
    const codes = new Set(values.filter((x) => typeof x === "string").map((x) => x.toUpperCase()));
    if (statuses.some((x) => [401, 403].includes(x)) || ["AUTHENTICATION_ERROR", "UNAUTHORIZED", "FORBIDDEN"].some((x) => codes.has(x)))
        return { status: "model-auth-unavailable", transient: false };
    if (statuses.some((x) => [408, 425].includes(x)) || ["ABORTERROR", "TIMEOUTERROR", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].some((x) => codes.has(x)))
        return { status: "provider-timeout", transient: true };
    if (statuses.includes(429) || codes.has("RATE_LIMIT") || codes.has("RATE_LIMITED"))
        return { status: "provider-rate-limit", transient: true };
    if (statuses.some((x) => [500, 502, 503, 504].includes(x)) || ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].some((x) => codes.has(x)))
        return { status: "provider-temporary-failure", transient: true };
    return { status: "unknown-value-worker-failure", transient: false };
}
//# sourceMappingURL=value-worker-model.js.map