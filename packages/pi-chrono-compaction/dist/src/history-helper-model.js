import { createHash } from "node:crypto";
import { historyHelperDerivationIdentity, resolveHistoryHelperRole } from "./history-helper-config.js";
export const HISTORY_HELPER_MODEL_POLICY = "chrono-explicit-history-route-no-tools-v1";
// These adapters have an inspected maxTokens transport control. Codex omits an
// output cap. Unknown adapters and virtual/router models need separate support.
const SUPPORTED_APIS = new Set(["anthropic-messages", "openai-completions", "openai-responses",
    "azure-openai-responses", "google-generative-ai", "google-vertex", "mistral-conversations", "bedrock-converse-stream"]);
function plain(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function digest(model) {
    // Hash model metadata without exposing headers, endpoint paths, or credentials.
    // This is a configuration binding, not proof of remote advertised capacity.
    return createHash("sha256").update(JSON.stringify([HISTORY_HELPER_MODEL_POLICY, model])).digest("hex");
}
function rejectedRoute(model) {
    const compat = plain(model.compat), vercel = plain(compat.vercelGatewayRouting);
    return !SUPPORTED_APIS.has(model.api) || model.api === "pi-virtual"
        || /(?:^|[/:])auto(?:$|[/:])/iu.test(model.id)
        || (Array.isArray(vercel.models) && vercel.models.length > 0)
        || (Array.isArray(vercel.order) && vercel.order.length > 1)
        || (Array.isArray(vercel.only) && vercel.only.length > 1)
        // No inspected per-call no-fallback contract exists for the gateway here.
        || model.provider === "vercel-ai-gateway";
}
function capabilityValid(model) {
    const compat = plain(model.compat);
    return model.input.includes("text") && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
        && Number.isSafeInteger(model.maxTokens) && model.maxTokens >= 16
        && compat.supportsMaxOutputTokens !== false;
}
function requestModel(model) {
    const originalCompat = plain(model.compat), router = plain(originalCompat.openRouterRouting);
    // Public model metadata can enable server-side refusal fallback. A per-call
    // copy disables it without changing the registry or selected user route.
    return { ...model, compat: { ...originalCompat, allowedFallbackModels: [],
            ...(model.provider === "openrouter" || originalCompat.openRouterRouting
                ? { openRouterRouting: { ...router, allow_fallbacks: false } } : {}) } };
}
function refusal() { throw Object.assign(new Error("route-changed"), { code: "route-changed" }); }
function guardPayload(payload, model, request) {
    const body = plain(payload), config = plain(body.config), inference = plain(body.inferenceConfig);
    const cap = model.api === "anthropic-messages" ? body.max_tokens
        : model.api === "openai-completions" ? body.max_completion_tokens ?? body.max_tokens
            : ["openai-responses", "azure-openai-responses"].includes(model.api) ? body.max_output_tokens
                : ["google-generative-ai", "google-vertex"].includes(model.api) ? config.maxOutputTokens
                    : model.api === "mistral-conversations" ? body.maxTokens
                        : model.api === "bedrock-converse-stream" ? inference.maxTokens : undefined;
    const arrays = [body.tools, config.tools, plain(body.toolConfig).tools, body.fallbacks, body.models];
    if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > request.maxOutputTokens
        || arrays.some(value => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0))
        || (model.provider === "openrouter" && plain(body.provider).allow_fallbacks !== false))
        refusal();
    const text = JSON.stringify(payload);
    if (typeof text !== "string" || text.length > request.maxRequestBytes || Buffer.byteLength(text, "utf8") > request.maxRequestBytes) {
        throw Object.assign(new Error("input-too-large"), { code: "input-too-large" });
    }
}
/** Resolve only one explicit consented role. This reads catalog/auth readiness,
 * never secrets, never logs in, and never creates another model runtime.
 * Supply a live getConfig callback so revoked consent also stops queued calls. */
export function resolveHistoryHelperModel(ctx, role, getConfig) {
    const selection = resolveHistoryHelperRole(getConfig(), role);
    if (!selection)
        return { status: "unselected" };
    const original = ctx.modelRegistry.find(selection.provider, selection.model);
    if (!original)
        return { status: "model-unavailable" };
    if (original.provider !== selection.provider || original.id !== selection.model || rejectedRoute(original))
        return { status: "route-unavailable" };
    if (!capabilityValid(original))
        return { status: "capability-unavailable" };
    if (!ctx.modelRegistry.hasConfiguredAuth(original))
        return { status: "auth-unavailable" };
    const originalIdentity = digest(original);
    const identity = `${historyHelperDerivationIdentity(getConfig(), role)}:${originalIdentity}`;
    const prepared = requestModel(original);
    const inputLimits = plain(plain(original).inputLimits);
    const requestBytes = inputLimits.maxRequestBytes;
    const model = Object.freeze({
        role, selection: Object.freeze({ ...selection }), identity,
        contextWindow: original.contextWindow, maxOutputTokens: original.maxTokens,
        ...(typeof requestBytes === "number" && Number.isSafeInteger(requestBytes) && requestBytes > 0 ? { maxRequestBytes: requestBytes } : {}),
        async call(request) {
            if (request.signal.aborted)
                throw Object.assign(new Error("cancelled"), { code: "cancelled" });
            const selected = resolveHistoryHelperRole(getConfig(), role);
            const current = ctx.modelRegistry.find(selection.provider, selection.model);
            if (!selected || selected.provider !== selection.provider || selected.model !== selection.model
                || !current || digest(current) !== originalIdentity || !ctx.modelRegistry.hasConfiguredAuth(current))
                refusal();
            if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 16 || request.maxOutputTokens > original.maxTokens
                || !Number.isSafeInteger(request.maxRequestBytes) || request.maxRequestBytes < 1
                || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
                refusal();
            const context = { systemPrompt: request.system, tools: [],
                messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }] };
            // SDK 0.85.1 and installed 1.1.0 registry.complete delegates directly to
            // ModelRuntime. Agent request hooks are separate caller callbacks. This
            // public request-local guard never emits native before_provider_request.
            // Do not pass an invented instrument:false option or inherit Agent hooks.
            let guarded = false;
            const options = { maxTokens: request.maxOutputTokens,
                signal: request.signal, timeoutMs: request.timeoutMs, maxRetries: 0, cacheRetention: "none",
                onPayload(payload, effectiveModel) {
                    if (request.signal.aborted)
                        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
                    const selectedNow = resolveHistoryHelperRole(getConfig(), role);
                    const currentNow = ctx.modelRegistry.find(selection.provider, selection.model);
                    if (!selectedNow || selectedNow.provider !== selection.provider || selectedNow.model !== selection.model
                        || !currentNow || digest(currentNow) !== originalIdentity)
                        refusal();
                    if (effectiveModel.provider !== selection.provider || effectiveModel.id !== selection.model || effectiveModel.api !== original.api)
                        refusal();
                    guardPayload(payload, effectiveModel, request);
                    guarded = true;
                    // Keep the provider payload unchanged. Missing effective caps (such
                    // as ChatGPT sign-in) refuse before dispatch, not after paid output.
                    return undefined;
                },
                ...(prepared.api === "anthropic-messages" ? { thinkingEnabled: false } : {}),
                ...(["anthropic-messages", "openai-completions", "openai-responses", "azure-openai-responses", "google-generative-ai", "google-vertex", "mistral-conversations"].includes(prepared.api) ? { toolChoice: "none" } : {}) };
            // Request-time credentials remain private to the one configured provider.
            // No apiKey, env, headers, provider fallback, or current main model is read.
            const response = await ctx.modelRegistry.complete(prepared, context, options);
            const text = response.content.filter(item => item.type === "text").map(item => item.text).join("\n");
            return { text, stopReason: response.stopReason, usage: response.usage,
                routeMatches: guarded && response.provider === selection.provider && response.model === selection.model && response.api === original.api,
                hasToolCalls: response.content.some(item => item.type === "toolCall") };
        },
    });
    return { status: "ready", model };
}
//# sourceMappingURL=history-helper-model.js.map