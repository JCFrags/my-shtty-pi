import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { InventoryItem, LoadedConfig, PolicyState } from "./types.ts";

export interface AuditEntryData {
	text: string;
}

function approximateTokens(value: unknown): number {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
		return Math.ceil(text.length / 4);
	} catch {
		return 0;
	}
}

function countByPolicy(inventory: InventoryItem[], state: PolicyState): number {
	return inventory.filter((item) => item.decision.state === state).length;
}

function stateLabel(item: InventoryItem): string {
	const active = item.active ? "active" : "hidden";
	return `${item.decision.state}/${active}`;
}

function clean(value: string): string {
	return value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

function short(value: string, maximum: number): string {
	const safe = clean(value);
	if (safe.length <= maximum) return safe;
	return `${safe.slice(0, Math.max(1, maximum - 1))}…`;
}

function toolMatchesFilter(item: InventoryItem, filter: string): boolean {
	const haystack = [
		item.tool.name,
		item.tool.description,
		item.tool.sourceInfo.source,
		item.tool.sourceInfo.path,
		item.decision.state,
		item.decision.areas.join(" "),
		item.decision.aliases.join(" "),
	].join(" ").toLowerCase();
	return haystack.includes(filter.toLowerCase());
}

function buildPromptSection(options: BuildSystemPromptOptions | undefined): string[] {
	if (!options) return ["System prompt data: not available in this mode."];
	const snippets = Object.keys(options.toolSnippets ?? {}).map(clean);
	const contextTokens = (options.contextFiles ?? []).reduce((sum, file) => sum + approximateTokens(file.content), 0);
	const skillTokens = approximateTokens(options.skills ?? []);
	const appendedTokens = approximateTokens(options.appendSystemPrompt ?? "");
	const customTokens = approximateTokens(options.customPrompt ?? "");
	return [
		"System prompt inputs:",
		`  Selected tools: ${(options.selectedTools ?? []).length}`,
		`  Visible tool snippets: ${snippets.length}${snippets.length > 0 ? ` (${snippets.join(", ")})` : ""}`,
		`  Prompt guidelines: ${(options.promptGuidelines ?? []).length}`,
		`  Context files: ${(options.contextFiles ?? []).length}, about ${contextTokens} tokens`,
		`  Skills: ${(options.skills ?? []).length}, about ${skillTokens} tokens`,
		`  Appended system text: about ${appendedTokens} tokens`,
		`  Custom system prompt: about ${customTokens} tokens`,
	];
}

export function buildAuditReport(options: {
	inventory: InventoryItem[];
	loadedConfig: LoadedConfig;
	promptOptions?: BuildSystemPromptOptions;
	argument: string;
	projectConfigAllowed: boolean;
}): string {
	const argument = options.argument.trim();
	const showAll = argument.toLowerCase() === "all";
	const filter = showAll ? "" : argument;
	const nonBuiltins = options.inventory.filter((item) => item.tool.sourceInfo.source !== "builtin");
	let visible = showAll ? options.inventory : nonBuiltins;
	if (filter) visible = visible.filter((item) => toolMatchesFilter(item, filter));

	visible = [...visible].sort((left, right) => {
		if (left.decision.state !== right.decision.state) return left.decision.state.localeCompare(right.decision.state);
		return left.tool.name.localeCompare(right.tool.name);
	});

	const active = options.inventory.filter((item) => item.active);
	const hidden = options.inventory.filter((item) => !item.active);
	const activeTokens = active.reduce((sum, item) => sum + item.estimatedTokens, 0);
	const hiddenTokens = hidden.reduce((sum, item) => sum + item.estimatedTokens, 0);

	const lines: string[] = [
		"Progressive Tools audit",
		"",
		`Tools: ${options.inventory.length} total; ${active.length} active; ${hidden.length} hidden`,
		`Policy: ${countByPolicy(options.inventory, "core")} core; ${countByPolicy(options.inventory, "managed")} managed; ${countByPolicy(options.inventory, "unmanaged")} unmanaged; ${countByPolicy(options.inventory, "blocked")} blocked`,
		`Approximate tool-schema cost: ${activeTokens} active tokens; ${hiddenTokens} hidden tokens`,
		`Project config: ${options.projectConfigAllowed ? "allowed (project is trusted)" : "ignored (project is not trusted)"}`,
		"",
		...buildPromptSection(options.promptOptions),
		"",
		"Configuration:",
	];

	if (options.loadedConfig.loadedPaths.length === 0) lines.push("  No configuration files were loaded.");
	for (const path of options.loadedConfig.loadedPaths) lines.push(`  Loaded: ${clean(path)}`);
	for (const path of options.loadedConfig.candidatePaths) {
		if (!options.loadedConfig.loadedPaths.includes(path)) lines.push(`  Not present or not allowed: ${clean(path)}`);
	}
	for (const error of options.loadedConfig.errors) lines.push(`  ERROR: ${clean(error)}`);

	lines.push("", `Tools shown: ${visible.length}${showAll ? " (all)" : filter ? ` (filter: ${clean(filter)})` : " (non-built-in)"}`);
	if (visible.length === 0) {
		lines.push("  No tools match this view.");
	} else {
		for (const item of visible) {
			const source = short(item.tool.sourceInfo.source, 32);
			const flags = item.flags.length > 0 ? ` [${item.flags.join(", ")}]` : "";
			lines.push(`  ${stateLabel(item).padEnd(18)} ${String(item.estimatedTokens).padStart(5)}t  ${clean(item.tool.name)}  <${source}>${flags}`);
			lines.push(`    ${short(item.tool.description, 150)}`);
			lines.push(`    path=${clean(item.tool.sourceInfo.path)}`);
			if (item.decision.matchedRuleSet !== undefined) {
				lines.push(`    rule=${item.decision.matchedRuleSet}[${item.decision.matchedRuleIndex ?? 0}]${item.decision.matchedRule?.note ? `; ${clean(item.decision.matchedRule.note)}` : ""}`);
			}
		}
	}

	lines.push(
		"",
		"Limits:",
		"  getAllTools() exposes tool descriptions, schemas, prompt guidelines, and source data.",
		"  It does not expose promptSnippet or direct system-prompt text added by another extension.",
		"  Unknown tools stay unmanaged. This extension does not hide or activate them.",
	);

	return lines.join("\n");
}
