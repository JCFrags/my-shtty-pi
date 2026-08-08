import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type {
	InventoryItem,
	PatternValue,
	PolicyDecision,
	ProgressiveToolsConfig,
	ToolAliasRule,
	ToolMatchRule,
} from "./types.ts";

export const SEARCH_TOOL_NAME = "search_tools";

const CORE_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export function toolIdentity(tool: ToolInfo): string {
	return `${tool.name}\u0000${tool.sourceInfo.source}\u0000${tool.sourceInfo.path}`;
}

function asArray(value: PatternValue | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
	const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(value: string, pattern: PatternValue | undefined): boolean {
	const patterns = asArray(pattern);
	if (patterns.length === 0) return true;
	return patterns.some((candidate) => wildcardToRegExp(candidate).test(value));
}

export function ruleMatchesTool(rule: ToolMatchRule | ToolAliasRule, tool: ToolInfo): boolean {
	return (
		matchesPattern(tool.name, rule.name) &&
		matchesPattern(tool.sourceInfo.source, rule.source) &&
		matchesPattern(tool.sourceInfo.path, rule.path) &&
		matchesPattern(tool.sourceInfo.scope, rule.scope) &&
		matchesPattern(tool.sourceInfo.origin, rule.origin)
	);
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}

function matchingRules(rules: ToolMatchRule[], tool: ToolInfo): Array<{ rule: ToolMatchRule; index: number }> {
	const result: Array<{ rule: ToolMatchRule; index: number }> = [];
	for (let index = 0; index < rules.length; index += 1) {
		const rule = rules[index];
		if (ruleMatchesTool(rule, tool)) result.push({ rule, index });
	}
	return result;
}

function aliasesForTool(config: ProgressiveToolsConfig, tool: ToolInfo, rules: ToolMatchRule[]): string[] {
	const values: string[] = [];
	for (const rule of rules) values.push(...(rule.aliases ?? []));
	for (const rule of config.aliases) {
		if (ruleMatchesTool(rule, tool)) values.push(...rule.terms);
	}
	return uniqueStrings(values);
}

function areasForRules(rules: ToolMatchRule[]): string[] {
	return uniqueStrings(rules.map((rule) => rule.area ?? ""));
}

export function classifyTool(tool: ToolInfo, config: ProgressiveToolsConfig): PolicyDecision {
	// The broker never hides Pi built-ins, but it also must not activate a
	// built-in that Pi or the user left inactive. The loader itself is the only
	// unconditional core tool here.
	if (tool.sourceInfo.source === "builtin") {
		return {
			state: "core",
			forceActive: false,
			aliases: [],
			areas: [],
		};
	}
	if (tool.name === SEARCH_TOOL_NAME) {
		return {
			state: "core",
			forceActive: true,
			aliases: [],
			areas: [],
		};
	}

	const blocked = matchingRules(config.blocked, tool);
	if (blocked.length > 0) {
		const rules = blocked.map((match) => match.rule);
		return {
			state: "blocked",
			forceActive: false,
			aliases: aliasesForTool(config, tool, rules),
			areas: areasForRules(rules),
			matchedRule: blocked[0].rule,
			matchedRuleIndex: blocked[0].index,
			matchedRuleSet: "blocked",
		};
	}

	// A non-built-in tool that replaced a core tool name is not auto-managed.
	// The audit flags it. An explicit blocked rule can still disable it.
	if (CORE_TOOL_NAMES.has(tool.name)) {
		return {
			state: "unmanaged",
			forceActive: false,
			aliases: aliasesForTool(config, tool, []),
			areas: [],
		};
	}

	const alwaysActive = matchingRules(config.alwaysActive, tool);
	if (alwaysActive.length > 0) {
		const rules = alwaysActive.map((match) => match.rule);
		return {
			state: "core",
			forceActive: true,
			aliases: aliasesForTool(config, tool, rules),
			areas: areasForRules(rules),
			matchedRule: alwaysActive[0].rule,
			matchedRuleIndex: alwaysActive[0].index,
			matchedRuleSet: "alwaysActive",
		};
	}

	const managed = matchingRules(config.managed, tool);
	if (managed.length > 0) {
		const rules = managed.map((match) => match.rule);
		return {
			state: "managed",
			forceActive: false,
			aliases: aliasesForTool(config, tool, rules),
			areas: areasForRules(rules),
			matchedRule: managed[0].rule,
			matchedRuleIndex: managed[0].index,
			matchedRuleSet: "managed",
		};
	}

	return {
		state: "unmanaged",
		forceActive: false,
		aliases: aliasesForTool(config, tool, []),
		areas: [],
	};
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

export function estimateToolTokens(tool: ToolInfo): number {
	const characters = safeStringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
	}).length;
	return Math.max(1, Math.ceil(characters / 4));
}

export function buildInventory(options: {
	tools: ToolInfo[];
	activeTools: ReadonlySet<string>;
	activatedManaged: ReadonlySet<string>;
	initialToolIdentities: ReadonlySet<string>;
	config: ProgressiveToolsConfig;
}): InventoryItem[] {
	return options.tools.map((tool) => {
		const decision = classifyTool(tool, options.config);
		const estimatedTokens = estimateToolTokens(tool);
		const flags: string[] = [];

		if ((tool.promptGuidelines?.length ?? 0) > 0) flags.push("prompt-guidelines");
		if (estimatedTokens >= options.config.audit.largeSchemaTokens) flags.push("large-schema");
		if (CORE_TOOL_NAMES.has(tool.name) && tool.sourceInfo.source !== "builtin") flags.push("core-name-override");
		if (!options.initialToolIdentities.has(toolIdentity(tool))) flags.push("new-this-session");
		if (options.activatedManaged.has(tool.name)) flags.push("loaded-by-search");

		return {
			tool,
			decision,
			active: options.activeTools.has(tool.name),
			activatedBySearch: options.activatedManaged.has(tool.name),
			newThisSession: !options.initialToolIdentities.has(toolIdentity(tool)),
			estimatedTokens,
			flags,
		};
	});
}

export function buildDesiredActiveTools(options: {
	current: string[];
	inventory: InventoryItem[];
	activatedManaged: ReadonlySet<string>;
}): string[] {
	const decisionByName = new Map(options.inventory.map((item) => [item.tool.name, item.decision]));
	const desired: string[] = [];

	for (const name of options.current) {
		const decision = decisionByName.get(name);
		if (!decision) {
			desired.push(name);
			continue;
		}
		if (decision.state === "blocked") continue;
		if (decision.state === "managed" && !options.activatedManaged.has(name)) continue;
		desired.push(name);
	}

	for (const item of options.inventory) {
		const shouldBeActive =
			item.decision.forceActive ||
			(item.decision.state === "managed" && options.activatedManaged.has(item.tool.name));
		if (shouldBeActive && !desired.includes(item.tool.name)) desired.push(item.tool.name);
	}

	return [...new Set(desired)];
}

export function isSameToolList(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}
