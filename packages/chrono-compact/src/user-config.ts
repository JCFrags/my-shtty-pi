import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ConfiguredRawTail = "pi" | "dynamic" | "short" | "medium" | "long" | number;

export interface UserConfig {
  readonly targetContextTokens?: number;
  readonly replayTargetTokens?: number | null;
  readonly triggerThresholdTokens?: number | null;
  readonly triggerMinimumGrowthTokens?: number;
  readonly rawTail?: ConfiguredRawTail;
  readonly dynamicRawTailMinTokens?: number;
  readonly dynamicRawTailMaxTokens?: number;
  readonly hybridSummaryEnabled?: boolean;
  readonly hybridSummaryTargetTokens?: number;
  readonly historyEditorEnabled?: boolean;
  readonly incrementalPrecomputeEnabled?: boolean;
  readonly isolatedWorkerEnabled?: boolean;
  readonly rollupShadowEnabled?: boolean;
  readonly hostWorkerSlots?: number;
  readonly workerTimeoutSeconds?: number;
  readonly workerNiceLevel?: number;
  readonly toolResultProjectionMode?: "off" | "safe" | "aggressive";
  readonly rankedSearchEnabled?: boolean;
  readonly editableMemoryEnabled?: boolean;
  readonly summaryRebaseInterval?: number;
  readonly hotSourceTokens?: number;
  readonly warmSourceTokens?: number;
}

export interface ConfigCommandResult {
  readonly config: UserConfig;
  readonly changed: boolean;
  readonly message: string;
}

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
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

const COMMAND_TO_KEY: Readonly<Record<string, ConfigKey>> = {
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

export function defaultUserConfigPath(): string {
  return process.env.PI_CHRONO_CONFIG_PATH?.trim() || join(homedir(), ".pi", "agent", "chrono-compact.json");
}

function boundedInteger(raw: unknown, name: string, min: number, max: number): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min.toLocaleString()} to ${max.toLocaleString()}.`);
  }
  return value;
}

function booleanValue(raw: unknown, name: string): boolean {
  if (typeof raw === "boolean") return raw;
  const value = String(raw ?? "").trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(value)) return true;
  if (["off", "false", "no", "0"].includes(value)) return false;
  throw new Error(`${name} must be on or off.`);
}

function projectionModeValue(raw: unknown): "off" | "safe" | "aggressive" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "safe" || value === "aggressive") return value;
  throw new Error("tool-result-projection must be off, safe, or aggressive.");
}

function rawTailValue(raw: unknown): ConfiguredRawTail {
  if (typeof raw === "number") return boundedInteger(raw, "raw-tail", 1_000, 200_000);
  const value = String(raw ?? "").trim().toLowerCase();
  if (["pi", "dynamic", "short", "medium", "long"].includes(value)) return value as ConfiguredRawTail;
  return boundedInteger(value, "raw-tail", 1_000, 200_000);
}

export function validateUserConfig(value: unknown): UserConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The configuration must be a JSON object.");
  const input = value as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  if (input.targetContextTokens !== undefined) config.targetContextTokens = boundedInteger(input.targetContextTokens, "targetContextTokens", 8_000, 250_000);
  if (input.replayTargetTokens !== undefined) config.replayTargetTokens = input.replayTargetTokens === null ? null : boundedInteger(input.replayTargetTokens, "replayTargetTokens", 256, 25_000);
  if (input.triggerThresholdTokens !== undefined) config.triggerThresholdTokens = input.triggerThresholdTokens === null ? null : boundedInteger(input.triggerThresholdTokens, "triggerThresholdTokens", 8_000, 250_000);
  if (input.triggerMinimumGrowthTokens !== undefined) config.triggerMinimumGrowthTokens = boundedInteger(input.triggerMinimumGrowthTokens, "triggerMinimumGrowthTokens", 0, 100_000);
  if (input.rawTail !== undefined) config.rawTail = rawTailValue(input.rawTail);
  if (input.dynamicRawTailMinTokens !== undefined) config.dynamicRawTailMinTokens = boundedInteger(input.dynamicRawTailMinTokens, "dynamicRawTailMinTokens", 1_000, 200_000);
  if (input.dynamicRawTailMaxTokens !== undefined) config.dynamicRawTailMaxTokens = boundedInteger(input.dynamicRawTailMaxTokens, "dynamicRawTailMaxTokens", 1_000, 200_000);
  if (input.hybridSummaryEnabled !== undefined) config.hybridSummaryEnabled = booleanValue(input.hybridSummaryEnabled, "hybridSummaryEnabled");
  if (input.hybridSummaryTargetTokens !== undefined) config.hybridSummaryTargetTokens = boundedInteger(input.hybridSummaryTargetTokens, "hybridSummaryTargetTokens", 512, 16_000);
  if (input.historyEditorEnabled !== undefined) config.historyEditorEnabled = booleanValue(input.historyEditorEnabled, "historyEditorEnabled");
  if (input.incrementalPrecomputeEnabled !== undefined) config.incrementalPrecomputeEnabled = booleanValue(input.incrementalPrecomputeEnabled, "incrementalPrecomputeEnabled");
  if (input.isolatedWorkerEnabled !== undefined) config.isolatedWorkerEnabled = booleanValue(input.isolatedWorkerEnabled, "isolatedWorkerEnabled");
  if (input.rollupShadowEnabled !== undefined) config.rollupShadowEnabled = booleanValue(input.rollupShadowEnabled, "rollupShadowEnabled");
  if (input.hostWorkerSlots !== undefined) config.hostWorkerSlots = boundedInteger(input.hostWorkerSlots, "hostWorkerSlots", 1, 4);
  if (input.workerTimeoutSeconds !== undefined) config.workerTimeoutSeconds = boundedInteger(input.workerTimeoutSeconds, "workerTimeoutSeconds", 30, 3_600);
  if (input.workerNiceLevel !== undefined) config.workerNiceLevel = boundedInteger(input.workerNiceLevel, "workerNiceLevel", 0, 19);
  if (input.toolResultProjectionMode !== undefined) config.toolResultProjectionMode = projectionModeValue(input.toolResultProjectionMode);
  if (input.rankedSearchEnabled !== undefined) config.rankedSearchEnabled = booleanValue(input.rankedSearchEnabled, "rankedSearchEnabled");
  if (input.editableMemoryEnabled !== undefined) config.editableMemoryEnabled = booleanValue(input.editableMemoryEnabled, "editableMemoryEnabled");
  if (input.summaryRebaseInterval !== undefined) config.summaryRebaseInterval = boundedInteger(input.summaryRebaseInterval, "summaryRebaseInterval", 2, 1_000);
  if (input.hotSourceTokens !== undefined) config.hotSourceTokens = boundedInteger(input.hotSourceTokens, "hotSourceTokens", 1_000, 100_000);
  if (input.warmSourceTokens !== undefined) config.warmSourceTokens = boundedInteger(input.warmSourceTokens, "warmSourceTokens", 1_000, 500_000);
  const checked = config as UserConfig;
  if ((checked.dynamicRawTailMinTokens ?? 3_000) > (checked.dynamicRawTailMaxTokens ?? 6_000)) {
    throw new Error("The dynamic raw-tail minimum must not exceed the maximum.");
  }
  return checked;
}

export function loadUserConfig(path = defaultUserConfigPath()): { config: UserConfig; warning?: string } {
  try {
    return { config: validateUserConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
    return { config: {}, warning: `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function saveUserConfig(config: UserConfig, path = defaultUserConfigPath()): void {
  const checked = validateUserConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function configCommandHelp(): string {
  return "Use /chrono-compact-settings to open the interactive ChronoCompact settings screen.";
}

function withoutKey(config: UserConfig, key: ConfigKey): UserConfig {
  const next = { ...config } as Record<string, unknown>;
  delete next[key];
  return validateUserConfig(next);
}

export function applyConfigCommand(config: UserConfig, args: string): ConfigCommandResult {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const command = words[0]?.toLowerCase() ?? "show";
  if (command === "show") return { config, changed: false, message: "Current persistent overrides are shown in compactor status." };
  if (command === "help") return { config, changed: false, message: configCommandHelp() };
  if (command === "raw-tail-bounds") {
    if (words.length !== 3) throw new Error("raw-tail-bounds requires minimum and maximum token values.");
    const minimum = boundedInteger(words[1], "raw-tail-bounds minimum", 1_000, 200_000);
    const maximum = boundedInteger(words[2], "raw-tail-bounds maximum", 1_000, 200_000);
    const next = validateUserConfig({ ...config, dynamicRawTailMinTokens: minimum, dynamicRawTailMaxTokens: maximum });
    return { config: next, changed: JSON.stringify(next) !== JSON.stringify(config), message: `Set dynamic raw-tail bounds to ${minimum.toLocaleString()}–${maximum.toLocaleString()} tokens.` };
  }
  if (command === "reset") {
    const setting = words[1]?.toLowerCase();
    if (!setting) throw new Error("reset requires all or a setting name.");
    if (setting === "all") return { config: {}, changed: Object.keys(config).length > 0, message: "Reset all persistent overrides." };
    if (setting === "raw-tail-bounds") {
      const next = { ...config } as Record<string, unknown>;
      delete next.dynamicRawTailMinTokens;
      delete next.dynamicRawTailMaxTokens;
      return { config: validateUserConfig(next), changed: config.dynamicRawTailMinTokens !== undefined || config.dynamicRawTailMaxTokens !== undefined, message: "Reset dynamic raw-tail bounds." };
    }
    const key = COMMAND_TO_KEY[setting];
    if (!key) throw new Error(`Unknown setting: ${setting}.`);
    return { config: withoutKey(config, key), changed: Object.prototype.hasOwnProperty.call(config, key), message: `Reset ${setting} to its environment or default value.` };
  }
  const key = COMMAND_TO_KEY[command];
  if (!key) throw new Error(`Unknown setting: ${command}. Use the interactive /chrono-compact-settings screen.`);
  if (words.length !== 2) throw new Error(`${command} requires one value.`);
  const raw = words[1] ?? "";
  let value: unknown;
  switch (key) {
    case "targetContextTokens": value = boundedInteger(raw, command, 8_000, 250_000); break;
    case "replayTargetTokens": value = ["auto", "derived", "pi"].includes(raw.toLowerCase()) ? null : boundedInteger(raw, command, 256, 25_000); break;
    case "triggerThresholdTokens": value = ["pi", "off", "disabled"].includes(raw.toLowerCase()) ? null : boundedInteger(raw, command, 8_000, 250_000); break;
    case "triggerMinimumGrowthTokens": value = boundedInteger(raw, command, 0, 100_000); break;
    case "rawTail": value = rawTailValue(raw); break;
    case "dynamicRawTailMinTokens": value = boundedInteger(raw, command, 1_000, 200_000); break;
    case "dynamicRawTailMaxTokens": value = boundedInteger(raw, command, 1_000, 200_000); break;
    case "hybridSummaryEnabled": value = booleanValue(raw, command); break;
    case "hybridSummaryTargetTokens": value = boundedInteger(raw, command, 512, 16_000); break;
    case "historyEditorEnabled": value = booleanValue(raw, command); break;
    case "incrementalPrecomputeEnabled": value = booleanValue(raw, command); break;
    case "isolatedWorkerEnabled": value = booleanValue(raw, command); break;
    case "rollupShadowEnabled": value = booleanValue(raw, command); break;
    case "hostWorkerSlots": value = boundedInteger(raw, command, 1, 4); break;
    case "workerTimeoutSeconds": value = boundedInteger(raw, command, 30, 3_600); break;
    case "workerNiceLevel": value = boundedInteger(raw, command, 0, 19); break;
    case "toolResultProjectionMode": value = projectionModeValue(raw); break;
    case "rankedSearchEnabled": value = booleanValue(raw, command); break;
    case "editableMemoryEnabled": value = booleanValue(raw, command); break;
    case "summaryRebaseInterval": value = boundedInteger(raw, command, 2, 1_000); break;
    case "hotSourceTokens": value = boundedInteger(raw, command, 1_000, 100_000); break;
    case "warmSourceTokens": value = boundedInteger(raw, command, 1_000, 500_000); break;
  }
  const next = validateUserConfig({ ...config, [key]: value });
  return { config: next, changed: JSON.stringify(next) !== JSON.stringify(config), message: `Set ${command} to ${String(raw).toLowerCase()}.` };
}
