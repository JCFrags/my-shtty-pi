import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const CONFIG_KEYS = [
    "targetContextTokens",
    "replayTargetTokens",
    "triggerThresholdTokens",
    "triggerMinimumGrowthTokens",
    "rawTail",
    "dynamicRawTailMinTokens",
    "dynamicRawTailMaxTokens",
    "hybridSummaryEnabled",
    "hybridSummaryTargetTokens",
    "historyEditorEnabled",
    "valueWorkerMode", "valueWorkerModel", "valueWorkerThinking", "valueWorkerMaxInputTokensPerJob", "valueWorkerMaxOutputTokensPerJob", "valueWorkerMaxItemsPerJob", "valueWorkerTimeoutSeconds", "valueWorkerRetries", "valueWorkerHostSlots", "valueWorkerMaxCallsPerSession", "valueWorkerMaxInputTokensPerSession", "valueWorkerMaxOutputTokensPerSession", "valueWorkerMaxEstimatedCostUsd", "valueWorkerCircuitFailureLimit", "valueWorkerCircuitCooldownSeconds",
    "incrementalPrecomputeEnabled",
    "isolatedWorkerEnabled",
    "rollupShadowEnabled",
    "hostWorkerSlots",
    "workerTimeoutSeconds",
    "workerNiceLevel",
    "toolResultProjectionMode",
    "rankedSearchEnabled",
    "editableMemoryEnabled",
    "summaryRebaseInterval",
    "hotSourceTokens",
    "warmSourceTokens",
];
const COMMAND_TO_KEY = {
    "target-context": "targetContextTokens",
    "replay-target": "replayTargetTokens",
    trigger: "triggerThresholdTokens",
    "trigger-growth": "triggerMinimumGrowthTokens",
    "raw-tail": "rawTail",
    "raw-tail-min": "dynamicRawTailMinTokens",
    "raw-tail-max": "dynamicRawTailMaxTokens",
    hybrid: "hybridSummaryEnabled",
    "hybrid-tokens": "hybridSummaryTargetTokens",
    "history-classifier": "historyEditorEnabled",
    "value-worker-mode": "valueWorkerMode", "value-worker-model": "valueWorkerModel", "value-worker-thinking": "valueWorkerThinking", "value-worker-job-input": "valueWorkerMaxInputTokensPerJob", "value-worker-job-output": "valueWorkerMaxOutputTokensPerJob", "value-worker-job-items": "valueWorkerMaxItemsPerJob", "value-worker-timeout": "valueWorkerTimeoutSeconds", "value-worker-retries": "valueWorkerRetries", "value-worker-slots": "valueWorkerHostSlots", "value-worker-session-calls": "valueWorkerMaxCallsPerSession", "value-worker-session-input": "valueWorkerMaxInputTokensPerSession", "value-worker-session-output": "valueWorkerMaxOutputTokensPerSession", "value-worker-cost": "valueWorkerMaxEstimatedCostUsd", "value-worker-circuit-failures": "valueWorkerCircuitFailureLimit", "value-worker-circuit-cooldown": "valueWorkerCircuitCooldownSeconds",
    "incremental-precompute": "incrementalPrecomputeEnabled",
    "isolated-worker": "isolatedWorkerEnabled",
    "rollup-shadow": "rollupShadowEnabled",
    "worker-slots": "hostWorkerSlots",
    "worker-timeout": "workerTimeoutSeconds",
    "worker-nice": "workerNiceLevel",
    "tool-result-projection": "toolResultProjectionMode",
    "ranked-search": "rankedSearchEnabled",
    memory: "editableMemoryEnabled",
    "summary-rebase-interval": "summaryRebaseInterval",
    "hot-source-tokens": "hotSourceTokens",
    "warm-source-tokens": "warmSourceTokens",
};
export function defaultUserConfigPath() {
    return process.env.PI_CHRONO_CONFIG_PATH?.trim() || join(homedir(), ".pi", "agent", "chrono-compact.json");
}
function boundedInteger(raw, name, min, max) {
    const value = typeof raw === "number" ? raw : Number(String(raw ?? ""));
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min.toLocaleString()} to ${max.toLocaleString()}.`);
    }
    return value;
}
function booleanValue(raw, name) {
    if (typeof raw === "boolean")
        return raw;
    const value = String(raw ?? "").trim().toLowerCase();
    if (["on", "true", "yes", "1"].includes(value))
        return true;
    if (["off", "false", "no", "0"].includes(value))
        return false;
    throw new Error(`${name} must be on or off.`);
}
function projectionModeValue(raw) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (value === "off" || value === "safe" || value === "aggressive")
        return value;
    throw new Error("tool-result-projection must be off, safe, or aggressive.");
}
function rawTailValue(raw) {
    if (typeof raw === "number")
        return boundedInteger(raw, "raw-tail", 1_000, 200_000);
    const value = String(raw ?? "").trim().toLowerCase();
    if (["pi", "dynamic", "short", "medium", "long"].includes(value))
        return value;
    return boundedInteger(value, "raw-tail", 1_000, 200_000);
}
export function validateUserConfig(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("The configuration must be a JSON object.");
    const input = value;
    const config = {};
    if (input.targetContextTokens !== undefined)
        config.targetContextTokens = boundedInteger(input.targetContextTokens, "targetContextTokens", 8_000, 250_000);
    if (input.replayTargetTokens !== undefined)
        config.replayTargetTokens = input.replayTargetTokens === null ? null : boundedInteger(input.replayTargetTokens, "replayTargetTokens", 256, 25_000);
    if (input.triggerThresholdTokens !== undefined)
        config.triggerThresholdTokens = input.triggerThresholdTokens === null ? null : boundedInteger(input.triggerThresholdTokens, "triggerThresholdTokens", 8_000, 250_000);
    if (input.triggerMinimumGrowthTokens !== undefined)
        config.triggerMinimumGrowthTokens = boundedInteger(input.triggerMinimumGrowthTokens, "triggerMinimumGrowthTokens", 0, 100_000);
    if (input.rawTail !== undefined)
        config.rawTail = rawTailValue(input.rawTail);
    if (input.dynamicRawTailMinTokens !== undefined)
        config.dynamicRawTailMinTokens = boundedInteger(input.dynamicRawTailMinTokens, "dynamicRawTailMinTokens", 1_000, 200_000);
    if (input.dynamicRawTailMaxTokens !== undefined)
        config.dynamicRawTailMaxTokens = boundedInteger(input.dynamicRawTailMaxTokens, "dynamicRawTailMaxTokens", 1_000, 200_000);
    if (input.hybridSummaryEnabled !== undefined)
        config.hybridSummaryEnabled = booleanValue(input.hybridSummaryEnabled, "hybridSummaryEnabled");
    if (input.hybridSummaryTargetTokens !== undefined)
        config.hybridSummaryTargetTokens = boundedInteger(input.hybridSummaryTargetTokens, "hybridSummaryTargetTokens", 512, 16_000);
    if (input.historyEditorEnabled !== undefined)
        config.historyEditorEnabled = booleanValue(input.historyEditorEnabled, "historyEditorEnabled");
    if (input.valueWorkerMode !== undefined) {
        const v = String(input.valueWorkerMode);
        if (!["off", "shadow", "advisory"].includes(v))
            throw new Error("valueWorkerMode must be off, shadow, or advisory.");
        config.valueWorkerMode = v;
    }
    if (input.valueWorkerModel !== undefined) {
        const v = String(input.valueWorkerModel).trim();
        if (!v || v.length > 512)
            throw new Error("valueWorkerModel must be main or provider/model.");
        config.valueWorkerModel = v;
    }
    if (input.valueWorkerThinking !== undefined) {
        const v = String(input.valueWorkerThinking);
        if (!["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v))
            throw new Error("valueWorkerThinking is unsupported.");
        config.valueWorkerThinking = v;
    }
    if (input.valueWorkerMaxInputTokensPerJob !== undefined)
        config.valueWorkerMaxInputTokensPerJob = boundedInteger(input.valueWorkerMaxInputTokensPerJob, "valueWorkerMaxInputTokensPerJob", 1000, 12000);
    if (input.valueWorkerMaxOutputTokensPerJob !== undefined)
        config.valueWorkerMaxOutputTokensPerJob = boundedInteger(input.valueWorkerMaxOutputTokensPerJob, "valueWorkerMaxOutputTokensPerJob", 256, 4000);
    if (input.valueWorkerMaxItemsPerJob !== undefined)
        config.valueWorkerMaxItemsPerJob = boundedInteger(input.valueWorkerMaxItemsPerJob, "valueWorkerMaxItemsPerJob", 5, 100);
    if (input.valueWorkerTimeoutSeconds !== undefined)
        config.valueWorkerTimeoutSeconds = boundedInteger(input.valueWorkerTimeoutSeconds, "valueWorkerTimeoutSeconds", 10, 600);
    if (input.valueWorkerRetries !== undefined)
        config.valueWorkerRetries = boundedInteger(input.valueWorkerRetries, "valueWorkerRetries", 0, 2);
    if (input.valueWorkerHostSlots !== undefined)
        config.valueWorkerHostSlots = boundedInteger(input.valueWorkerHostSlots, "valueWorkerHostSlots", 1, 4);
    if (input.valueWorkerMaxCallsPerSession !== undefined)
        config.valueWorkerMaxCallsPerSession = boundedInteger(input.valueWorkerMaxCallsPerSession, "valueWorkerMaxCallsPerSession", 1, 2000);
    if (input.valueWorkerMaxInputTokensPerSession !== undefined)
        config.valueWorkerMaxInputTokensPerSession = boundedInteger(input.valueWorkerMaxInputTokensPerSession, "valueWorkerMaxInputTokensPerSession", 1000, 10000000);
    if (input.valueWorkerMaxOutputTokensPerSession !== undefined)
        config.valueWorkerMaxOutputTokensPerSession = boundedInteger(input.valueWorkerMaxOutputTokensPerSession, "valueWorkerMaxOutputTokensPerSession", 1000, 2000000);
    if (input.valueWorkerMaxEstimatedCostUsd !== undefined) {
        if (input.valueWorkerMaxEstimatedCostUsd === null)
            config.valueWorkerMaxEstimatedCostUsd = null;
        else {
            const v = Number(input.valueWorkerMaxEstimatedCostUsd);
            if (!Number.isFinite(v) || v < 0.01 || v > 1000)
                throw new Error("valueWorkerMaxEstimatedCostUsd must be null or 0.01 through 1000.");
            config.valueWorkerMaxEstimatedCostUsd = Math.round(v * 1000000) / 1000000;
        }
    }
    if (input.valueWorkerCircuitFailureLimit !== undefined)
        config.valueWorkerCircuitFailureLimit = boundedInteger(input.valueWorkerCircuitFailureLimit, "valueWorkerCircuitFailureLimit", 1, 20);
    if (input.valueWorkerCircuitCooldownSeconds !== undefined)
        config.valueWorkerCircuitCooldownSeconds = boundedInteger(input.valueWorkerCircuitCooldownSeconds, "valueWorkerCircuitCooldownSeconds", 30, 86400);
    if (input.incrementalPrecomputeEnabled !== undefined)
        config.incrementalPrecomputeEnabled = booleanValue(input.incrementalPrecomputeEnabled, "incrementalPrecomputeEnabled");
    if (input.isolatedWorkerEnabled !== undefined)
        config.isolatedWorkerEnabled = booleanValue(input.isolatedWorkerEnabled, "isolatedWorkerEnabled");
    if (input.rollupShadowEnabled !== undefined)
        config.rollupShadowEnabled = booleanValue(input.rollupShadowEnabled, "rollupShadowEnabled");
    if (input.hostWorkerSlots !== undefined)
        config.hostWorkerSlots = boundedInteger(input.hostWorkerSlots, "hostWorkerSlots", 1, 4);
    if (input.workerTimeoutSeconds !== undefined)
        config.workerTimeoutSeconds = boundedInteger(input.workerTimeoutSeconds, "workerTimeoutSeconds", 30, 3_600);
    if (input.workerNiceLevel !== undefined)
        config.workerNiceLevel = boundedInteger(input.workerNiceLevel, "workerNiceLevel", 0, 19);
    if (input.toolResultProjectionMode !== undefined)
        config.toolResultProjectionMode = projectionModeValue(input.toolResultProjectionMode);
    if (input.rankedSearchEnabled !== undefined)
        config.rankedSearchEnabled = booleanValue(input.rankedSearchEnabled, "rankedSearchEnabled");
    if (input.editableMemoryEnabled !== undefined)
        config.editableMemoryEnabled = booleanValue(input.editableMemoryEnabled, "editableMemoryEnabled");
    if (input.summaryRebaseInterval !== undefined)
        config.summaryRebaseInterval = boundedInteger(input.summaryRebaseInterval, "summaryRebaseInterval", 2, 1_000);
    if (input.hotSourceTokens !== undefined)
        config.hotSourceTokens = boundedInteger(input.hotSourceTokens, "hotSourceTokens", 1_000, 100_000);
    if (input.warmSourceTokens !== undefined)
        config.warmSourceTokens = boundedInteger(input.warmSourceTokens, "warmSourceTokens", 1_000, 500_000);
    const checked = config;
    if ((checked.dynamicRawTailMinTokens ?? 3_000) > (checked.dynamicRawTailMaxTokens ?? 6_000)) {
        throw new Error("The dynamic raw-tail minimum must not exceed the maximum.");
    }
    return checked;
}
export function loadUserConfig(path = defaultUserConfigPath()) {
    try {
        return { config: validateUserConfig(JSON.parse(readFileSync(path, "utf8"))) };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { config: {} };
        return { config: {}, warning: `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
}
export function saveUserConfig(config, path = defaultUserConfigPath()) {
    const checked = validateUserConfig(config);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
}
export function configCommandHelp() {
    return "Use /chrono-compact-settings to open the interactive ChronoCompact settings screen.";
}
function withoutKey(config, key) {
    const next = { ...config };
    delete next[key];
    return validateUserConfig(next);
}
export function applyConfigCommand(config, args) {
    const words = args.trim().split(/\s+/).filter(Boolean);
    const command = words[0]?.toLowerCase() ?? "show";
    if (command === "show")
        return { config, changed: false, message: "Current persistent overrides are shown in compactor status." };
    if (command === "help")
        return { config, changed: false, message: configCommandHelp() };
    if (command === "raw-tail-bounds") {
        if (words.length !== 3)
            throw new Error("raw-tail-bounds requires minimum and maximum token values.");
        const minimum = boundedInteger(words[1], "raw-tail-bounds minimum", 1_000, 200_000);
        const maximum = boundedInteger(words[2], "raw-tail-bounds maximum", 1_000, 200_000);
        const next = validateUserConfig({ ...config, dynamicRawTailMinTokens: minimum, dynamicRawTailMaxTokens: maximum });
        return { config: next, changed: JSON.stringify(next) !== JSON.stringify(config), message: `Set dynamic raw-tail bounds to ${minimum.toLocaleString()}–${maximum.toLocaleString()} tokens.` };
    }
    if (command === "reset") {
        const setting = words[1]?.toLowerCase();
        if (!setting)
            throw new Error("reset requires all or a setting name.");
        if (setting === "all")
            return { config: {}, changed: Object.keys(config).length > 0, message: "Reset all persistent overrides." };
        if (setting === "raw-tail-bounds") {
            const next = { ...config };
            delete next.dynamicRawTailMinTokens;
            delete next.dynamicRawTailMaxTokens;
            return { config: validateUserConfig(next), changed: config.dynamicRawTailMinTokens !== undefined || config.dynamicRawTailMaxTokens !== undefined, message: "Reset dynamic raw-tail bounds." };
        }
        const key = COMMAND_TO_KEY[setting];
        if (!key)
            throw new Error(`Unknown setting: ${setting}.`);
        return { config: withoutKey(config, key), changed: Object.prototype.hasOwnProperty.call(config, key), message: `Reset ${setting} to its environment or default value.` };
    }
    const key = COMMAND_TO_KEY[command];
    if (!key)
        throw new Error(`Unknown setting: ${command}. Use the interactive /chrono-compact-settings screen.`);
    if (words.length !== 2)
        throw new Error(`${command} requires one value.`);
    const raw = words[1] ?? "";
    let value;
    switch (key) {
        case "targetContextTokens":
            value = boundedInteger(raw, command, 8_000, 250_000);
            break;
        case "replayTargetTokens":
            value = ["auto", "derived", "pi"].includes(raw.toLowerCase()) ? null : boundedInteger(raw, command, 256, 25_000);
            break;
        case "triggerThresholdTokens":
            value = ["pi", "off", "disabled"].includes(raw.toLowerCase()) ? null : boundedInteger(raw, command, 8_000, 250_000);
            break;
        case "triggerMinimumGrowthTokens":
            value = boundedInteger(raw, command, 0, 100_000);
            break;
        case "rawTail":
            value = rawTailValue(raw);
            break;
        case "dynamicRawTailMinTokens":
            value = boundedInteger(raw, command, 1_000, 200_000);
            break;
        case "dynamicRawTailMaxTokens":
            value = boundedInteger(raw, command, 1_000, 200_000);
            break;
        case "hybridSummaryEnabled":
            value = booleanValue(raw, command);
            break;
        case "hybridSummaryTargetTokens":
            value = boundedInteger(raw, command, 512, 16_000);
            break;
        case "historyEditorEnabled":
            value = booleanValue(raw, command);
            break;
        case "valueWorkerMode":
            if (!["off", "shadow", "advisory"].includes(raw))
                throw new Error("value-worker-mode must be off, shadow, or advisory.");
            value = raw;
            break;
        case "valueWorkerModel":
            value = raw;
            break;
        case "valueWorkerThinking":
            if (!["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw))
                throw new Error("unsupported thinking level");
            value = raw;
            break;
        case "valueWorkerMaxInputTokensPerJob":
            value = boundedInteger(raw, command, 1000, 12000);
            break;
        case "valueWorkerMaxOutputTokensPerJob":
            value = boundedInteger(raw, command, 256, 4000);
            break;
        case "valueWorkerMaxItemsPerJob":
            value = boundedInteger(raw, command, 5, 100);
            break;
        case "valueWorkerTimeoutSeconds":
            value = boundedInteger(raw, command, 10, 600);
            break;
        case "valueWorkerRetries":
            value = boundedInteger(raw, command, 0, 2);
            break;
        case "valueWorkerHostSlots":
            value = boundedInteger(raw, command, 1, 4);
            break;
        case "valueWorkerMaxCallsPerSession":
            value = boundedInteger(raw, command, 1, 2000);
            break;
        case "valueWorkerMaxInputTokensPerSession":
            value = boundedInteger(raw, command, 1000, 10000000);
            break;
        case "valueWorkerMaxOutputTokensPerSession":
            value = boundedInteger(raw, command, 1000, 2000000);
            break;
        case "valueWorkerMaxEstimatedCostUsd":
            value = ["off", "disabled", "none"].includes(raw) ? null : Number(raw);
            break;
        case "valueWorkerCircuitFailureLimit":
            value = boundedInteger(raw, command, 1, 20);
            break;
        case "valueWorkerCircuitCooldownSeconds":
            value = boundedInteger(raw, command, 30, 86400);
            break;
        case "incrementalPrecomputeEnabled":
            value = booleanValue(raw, command);
            break;
        case "isolatedWorkerEnabled":
            value = booleanValue(raw, command);
            break;
        case "rollupShadowEnabled":
            value = booleanValue(raw, command);
            break;
        case "hostWorkerSlots":
            value = boundedInteger(raw, command, 1, 4);
            break;
        case "workerTimeoutSeconds":
            value = boundedInteger(raw, command, 30, 3_600);
            break;
        case "workerNiceLevel":
            value = boundedInteger(raw, command, 0, 19);
            break;
        case "toolResultProjectionMode":
            value = projectionModeValue(raw);
            break;
        case "rankedSearchEnabled":
            value = booleanValue(raw, command);
            break;
        case "editableMemoryEnabled":
            value = booleanValue(raw, command);
            break;
        case "summaryRebaseInterval":
            value = boundedInteger(raw, command, 2, 1_000);
            break;
        case "hotSourceTokens":
            value = boundedInteger(raw, command, 1_000, 100_000);
            break;
        case "warmSourceTokens":
            value = boundedInteger(raw, command, 1_000, 500_000);
            break;
    }
    const next = validateUserConfig({ ...config, [key]: value });
    return { config: next, changed: JSON.stringify(next) !== JSON.stringify(config), message: `Set ${command} to ${String(raw).toLowerCase()}.` };
}
//# sourceMappingURL=user-config.js.map