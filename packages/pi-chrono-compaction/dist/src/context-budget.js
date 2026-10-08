import { createHash } from "node:crypto";
import { convertToLlm, estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
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
export const CONTEXT_ESTIMATOR = "pi-message-estimator-and-utf16-ceil-div4-v1";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const textTokens = (text) => Math.ceil(text.length / 4);
/** Capture public request inputs only. Source paths, credentials and tool execute
 * functions are neither retained nor hashed. Full active schema JSON is charged. */
export function captureContextBudget(input) {
    if (!input.model.provider || !input.model.id || !input.model.api || !Number.isSafeInteger(input.model.maxTokens)
        || input.model.maxTokens < 0 || !Number.isSafeInteger(input.framingTokens) || input.framingTokens < 0)
        throw new Error("context-v4-budget-invalid");
    const tools = [...new Set(input.activeTools)].sort().map(name => {
        const tool = input.allTools.find(value => value.name === name);
        if (!tool || tool.parameters === undefined)
            throw new Error("context-v4-tool-schema-unavailable");
        const json = JSON.stringify({ name, description: tool.description, parameters: tool.parameters });
        return { name, tokens: textTokens(json), hash: sha(json) };
    });
    const systemTokens = textTokens(input.systemPrompt), toolSchemaTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);
    // A fixed transport allowance plus a per-schema allowance complements the
    // explicit schema and message estimates. It is not an exact tokenizer claim.
    const framingTokens = Math.max(512, input.framingTokens) + tools.length * 32;
    return { model: { ...input.model }, configuredTokens: input.configuredTokens,
        responseReserveTokens: input.responseReserveTokens, systemTokens, systemHash: sha(input.systemPrompt), tools,
        toolSchemaTokens, framingTokens,
        effectiveCeilingTokens: resolveContextCeiling(input.configuredTokens, input.model.contextWindow, systemTokens + toolSchemaTokens + framingTokens, input.responseReserveTokens),
        estimator: CONTEXT_ESTIMATOR,
        qualification: "Estimated public-hook request, not an exact model tokenizer or final provider payload. Includes Pi compaction conversion, complete raw-tail messages, system, active schemas, framing allowance and response reserve. Later context/payload extensions and provider serialization can change the request." };
}
/** Full fallback for the current conversation projection, not lifetime history.
 * Pi 1.1's ordinary context hook hides persisted system messages. Charge the
 * effective public system prompt and active schemas once in every path. */
export function estimateCurrentRequestTokens(input) {
    let tokens = textTokens(input.systemPrompt) + 512;
    for (const name of new Set(input.activeTools)) {
        const tool = input.allTools.find(value => value.name === name);
        if (!tool || tool.parameters === undefined)
            throw new Error("context-v4-tool-schema-unavailable");
        tokens += textTokens(JSON.stringify({ name, description: tool.description, parameters: tool.parameters })) + 32;
    }
    for (const value of input.messages) {
        const message = value;
        if (message.role === "system")
            continue;
        const converted = convertToLlm([value]);
        tokens += converted.length ? converted.reduce((sum, item) => sum + estimateTokens(item) + 32, 0)
            : textTokens(JSON.stringify(value)) + 32;
    }
    if (!Number.isFinite(tokens) || tokens <= 0)
        throw new Error("session-agent-summary-headroom-unavailable");
    return tokens;
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** Match Pi's successful, positive assistant-usage semantics. Invalid numbers
 * refuse rather than become a zero-cost observation. */
function assistantUsageTokens(value) {
    const message = object(value), usage = object(message?.usage);
    if (message?.role !== "assistant" || ["aborted", "error"].includes(String(message.stopReason)) || !usage)
        return undefined;
    const fields = ["totalTokens", "input", "output", "cacheRead", "cacheWrite"];
    if (fields.some(name => typeof usage[name] !== "number" || !Number.isFinite(usage[name]) || Number(usage[name]) < 0)) {
        throw new Error("session-agent-summary-headroom-unavailable");
    }
    const tokens = Number(usage.totalTokens) || Number(usage.input) + Number(usage.output) + Number(usage.cacheRead) + Number(usage.cacheWrite);
    return tokens > 0 ? tokens : undefined;
}
/** Replay public Pi 1.1 system state only for accounting. No transcript or
 * provider request is changed. Older hosts without persisted state charge the
 * full current overhead instead of assuming it was in the observed request. */
function systemState(messages) {
    const content = [], sections = new Map(), tools = new Map();
    let found = false;
    for (const value of messages) {
        const message = object(value);
        if (message?.role !== "system")
            continue;
        found = true;
        const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
            ? message.content.map(object).filter(block => block?.type === "text").map(block => String(block.text)).join("\n") : "";
        if (text)
            content.push(text);
        for (const [name, text] of Object.entries(object(message.sections) ?? {})) {
            if (text === null)
                sections.delete(name);
            else if (typeof text === "string")
                sections.set(name, text);
            else
                throw new Error("session-agent-summary-headroom-unavailable");
        }
        if ((message.toolsRemoved !== undefined && !Array.isArray(message.toolsRemoved))
            || (message.toolsAdded !== undefined && !Array.isArray(message.toolsAdded)))
            throw new Error("session-agent-summary-headroom-unavailable");
        for (const value of (message.toolsRemoved ?? [])) {
            const tool = object(value);
            if (typeof tool?.name !== "string")
                throw new Error("session-agent-summary-headroom-unavailable");
            tools.delete(tool.name);
        }
        for (const value of (message.toolsAdded ?? [])) {
            const tool = object(value);
            if (typeof tool?.name !== "string" || typeof tool.description !== "string" || tool.parameters === undefined) {
                throw new Error("session-agent-summary-headroom-unavailable");
            }
            tools.set(tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters });
        }
    }
    return found ? { prompt: [...content, ...sections.values()].filter(Boolean).join("\n\n"), tools: [...tools.values()] } : undefined;
}
const schemaTokens = (tool) => textTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
/** Use provider-backed usage only on the current native branch, after its
 * latest edit/compaction/model boundary. Pi's public count already includes
 * estimated trailing growth, not just the last response. Count unseen hook
 * messages and effective prompt/schema growth without restoring the inflated
 * full-history estimate as a permanent floor. */
export function estimateCurrentRequestBudget(input) {
    const projectionTokens = estimateCurrentRequestTokens(input), reported = input.nativeTokens;
    if (reported != null && (!Number.isFinite(reported) || reported < 0))
        throw new Error("session-agent-summary-headroom-unavailable");
    const fallback = () => ({ tokens: projectionTokens, projectionTokens, nativeTokens: null });
    if (reported == null || reported === 0)
        return fallback();
    let anchor, usageTokens = 0;
    for (let index = input.branchEntries.length - 1; index >= 0; index--) {
        const entry = input.branchEntries[index];
        if (["context_edit", "compaction", "model_change", "thinking_level_change"].includes(entry.type))
            return fallback();
        if (entry.type !== "message")
            continue;
        const tokens = assistantUsageTokens(entry.message);
        if (tokens === undefined)
            continue;
        const message = object(entry.message);
        if (message.provider !== input.model.provider || message.model !== input.model.id || message.api !== input.model.api)
            return fallback();
        anchor = entry;
        usageTokens = tokens;
        break;
    }
    // No provider-backed observation: the public number can itself be a native
    // heuristic. Keep it conservatively, but do not use it to discount transport.
    if (!anchor)
        return { ...fallback(), tokens: Math.max(projectionTokens, reported) };
    const signature = JSON.stringify(anchor.message);
    const lastMatch = (messages) => {
        for (let index = messages.length - 1; index >= 0; index--) {
            if (object(messages[index])?.role === "assistant" && JSON.stringify(messages[index]) === signature)
                return index;
        }
        return -1;
    };
    const nativeIndex = lastMatch(input.nativeMessages), index = lastMatch(input.messages);
    const conversation = (messages) => messages.filter(value => object(value)?.role !== "system");
    if (nativeIndex < 0 || index < 0 || JSON.stringify(conversation(input.nativeMessages.slice(0, nativeIndex + 1)))
        !== JSON.stringify(conversation(input.messages.slice(0, index + 1))))
        return fallback();
    const baseline = systemState(input.nativeMessages.slice(0, nativeIndex + 1));
    let overheadGrowth = Math.max(0, textTokens(input.systemPrompt) - textTokens(baseline?.prompt ?? ""));
    for (const name of new Set(input.activeTools)) {
        const current = input.allTools.find(tool => tool.name === name);
        const prior = baseline?.tools.find(tool => tool.name === name);
        overheadGrowth += Math.max(0, schemaTokens(current) - (prior ? schemaTokens(prior) : 0)) + (prior ? 0 : 32);
    }
    const trailing = estimateCurrentRequestTokens({ ...input, messages: input.messages.slice(index + 1), systemPrompt: "", activeTools: [] }) - 512;
    // Pi includes persisted system deltas in its native trailing estimate. Charge
    // them only after the usage anchor, including definitions the old SDK omits.
    let systemGrowth = 0;
    for (const value of input.nativeMessages.slice(nativeIndex + 1)) {
        if (object(value)?.role !== "system")
            continue;
        systemGrowth += textTokens(JSON.stringify(value)) + 32;
    }
    const tokens = Math.max(reported, usageTokens + trailing + systemGrowth) + Math.max(0, overheadGrowth - systemGrowth);
    return { tokens, projectionTokens, nativeTokens: reported };
}
/** Recheck the final public payload against the admitted projection. Native
 * usage remains an estimated floor, not proof of exact provider tokenization.
 * Positive serialization/late growth is added to that floor.
 * Codex ciphertext length is not a tokenizer estimate. Only a positive native
 * observation permits that known replay field to use the native bound instead.
 * With null usage or an unknown API, retain the full transport estimate. */
export function estimateProviderRequestTokens(input) {
    if (!input.api || !Number.isFinite(input.projectionTokens) || input.projectionTokens <= 0
        || !Number.isFinite(input.admittedTokens) || input.admittedTokens <= 0
        || (input.nativeTokens != null && (!Number.isFinite(input.nativeTokens) || input.nativeTokens < 0))
        || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
        throw new Error("session-agent-summary-headroom-unavailable");
    }
    const payload = input.payload;
    let accountingPayload = payload;
    if (input.api === "openai-codex-responses" && Array.isArray(payload.input)) {
        const items = payload.input.map(value => {
            if (!value || typeof value !== "object" || Array.isArray(value))
                return value;
            const item = value;
            if (item.type !== "reasoning" || item.encrypted_content == null)
                return item;
            if (typeof item.encrypted_content !== "string")
                throw new Error("session-agent-summary-headroom-unavailable");
            // Do not alter the request or remove visible summaries and unknown fields.
            return input.nativeTokens != null && input.nativeTokens > 0 ? { ...item, encrypted_content: "" } : item;
        });
        accountingPayload = { ...payload, input: items };
    }
    const serialized = JSON.stringify(accountingPayload);
    if (!serialized)
        throw new Error("session-agent-summary-headroom-unavailable");
    const payloadTokens = textTokens(serialized) + 512;
    const calibrated = input.nativeTokens != null && input.nativeTokens > 0 && KNOWN_PROVIDER_APIS.has(input.api);
    const tokens = Math.max(input.admittedTokens, input.nativeTokens ?? 0) + Math.max(0, payloadTokens - input.projectionTokens);
    return calibrated ? tokens : Math.max(tokens, payloadTokens);
}
const KNOWN_PROVIDER_APIS = new Set(["openai-completions", "mistral-conversations", "openai-responses", "azure-openai-responses",
    "openai-codex-responses", "anthropic-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "pi-messages"]);
/** Public conversion includes Pi's compaction prefix and <summary> wrapper. */
export function chargeCompactionSummary(summary) {
    return convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }])
        .reduce((sum, message) => sum + estimateTokens(message), 0) + 32;
}
/** Match Pi's retained-tail reconstruction. Old compaction metadata is not a
 * second summary. No image or tool-result body is shortened. */
export function chargeRawTail(entries) {
    if (entries.length > 256)
        throw new Error("context-v4-tail-bound-exceeded");
    const converted = convertToLlm(entries.filter(entry => entry.type !== "compaction")
        .flatMap(entry => sessionEntryToContextMessages(entry)));
    return { tokens: converted.reduce((sum, message) => sum + estimateTokens(message) + 32, 0), messages: converted.length };
}
//# sourceMappingURL=context-budget.js.map