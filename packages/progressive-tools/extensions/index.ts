import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildAuditReport, type AuditEntryData } from "./audit.ts";
import { loadConfig } from "./config.ts";
import {
	buildDesiredActiveTools,
	buildInventory,
	isSameToolList,
	SEARCH_TOOL_NAME,
	toolIdentity,
} from "./policy.ts";
import { rankInventory, selectManagedSearchResults } from "./search.ts";
import type { InventoryItem, LoadedConfig } from "./types.ts";

const AUDIT_ENTRY_TYPE = "pi-progressive-tools:audit";

interface BrokerState {
	activatedManaged: Set<string>;
	initialToolIdentities: Set<string>;
	initialized: boolean;
}

interface PolicySnapshot {
	loadedConfig: LoadedConfig;
	inventory: InventoryItem[];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

function describeTool(tool: ToolInfo): string {
	const text = cleanText(tool.description);
	return text.length <= 140 ? text : `${text.slice(0, 139)}…`;
}

function searchToolDescription(): string {
	const loaded = loadConfig(process.cwd(), { includeProject: false });
	const areas = loaded.config.areas
		.map(cleanText)
		.filter(Boolean)
		.slice(0, 12);
	const base =
		"Find and enable approved hidden Pi tools for a task or service. Search before declaring a specialized capability unavailable.";
	return areas.length > 0 ? `${base} Configured areas: ${areas.join(", ")}.` : base;
}

function createInventory(pi: ExtensionAPI, ctx: ExtensionContext, state: BrokerState): PolicySnapshot {
	const loadedConfig = loadConfig(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
	const tools = pi.getAllTools();
	const activeTools = new Set(pi.getActiveTools());
	if (!state.initialized) {
		state.initialToolIdentities = new Set(tools.map(toolIdentity));
		state.initialized = true;
	}
	const inventory = buildInventory({
		tools,
		activeTools,
		activatedManaged: state.activatedManaged,
		initialToolIdentities: state.initialToolIdentities,
		config: loadedConfig.config,
	});
	return { loadedConfig, inventory };
}

function enforcePolicy(pi: ExtensionAPI, ctx: ExtensionContext, state: BrokerState): PolicySnapshot {
	const snapshot = createInventory(pi, ctx, state);
	const current = pi.getActiveTools();
	const decisionByName = new Map(snapshot.inventory.map((item) => [item.tool.name, item.decision]));

	for (const name of [...state.activatedManaged]) {
		if (decisionByName.get(name)?.state !== "managed") state.activatedManaged.delete(name);
	}

	const next = buildDesiredActiveTools({
		current,
		inventory: snapshot.inventory,
		activatedManaged: state.activatedManaged,
	});
	if (!isSameToolList(current, next)) pi.setActiveTools(next);

	// Return an inventory that reflects the applied policy.
	return createInventory(pi, ctx, state);
}

function formatSearchResult(options: {
	query: string;
	matches: InventoryItem[];
	added: string[];
	unmanagedHints: InventoryItem[];
	configErrorCount: number;
}): string {
	const lines: string[] = [];
	if (options.matches.length > 0) {
		if (options.added.length > 0) lines.push(`Loaded tools: ${options.added.map(cleanText).join(", ")}`);
		const alreadyActive = options.matches
			.map((item) => item.tool.name)
			.filter((name) => !options.added.includes(name));
		if (alreadyActive.length > 0) {
			lines.push(`Matching tools already active: ${alreadyActive.map(cleanText).join(", ")}`);
		}
		lines.push("Matches:");
		for (const item of options.matches) lines.push(`- ${cleanText(item.tool.name)}: ${describeTool(item.tool)}`);
	} else {
		lines.push(`No approved hidden tools matched: ${cleanText(options.query)}`);
	}

	if (options.unmanagedHints.length > 0) {
		lines.push(
			`${options.unmanagedHints.length} matching unmanaged tool(s) exist. Their metadata was not added to model context.`,
		);
		lines.push("The user can inspect them with /tool-audit and approve them in progressive-tools.json.");
	}

	if (options.configErrorCount > 0) {
		lines.push(`Configuration has ${options.configErrorCount} error(s). The user can run /tool-audit.`);
	}
	return lines.join("\n");
}

export default function progressiveToolsExtension(pi: ExtensionAPI): void {
	const state: BrokerState = {
		activatedManaged: new Set<string>(),
		initialToolIdentities: new Set<string>(),
		initialized: false,
	};

	pi.registerTool({
		name: SEARCH_TOOL_NAME,
		label: "Search Tools",
		description: searchToolDescription(),
		parameters: Type.Object({
			query: Type.String({
				description: "Task, service, or missing capability. Do not guess a tool name.",
			}),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Maximum number of approved tools to load.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = createInventory(pi, ctx, state);
			const ranked = rankInventory(params.query, snapshot.inventory);
			const configuredLimit = params.limit ?? snapshot.loadedConfig.config.search.defaultLimit;
			const limit = Math.max(1, Math.min(configuredLimit, snapshot.loadedConfig.config.search.maxLimit));
			const minimumScore = snapshot.loadedConfig.config.search.minimumScore;

			const selection = selectManagedSearchResults(ranked, { limit, minimumScore });
			const toActivate = selection.toActivate.map((match) => match.item);
			const alreadyActive = selection.alreadyActive.map((match) => match.item);
			const matches = [...toActivate, ...alreadyActive];
			for (const item of toActivate) state.activatedManaged.add(item.tool.name);

			const active = pi.getActiveTools();
			const added = toActivate.map((item) => item.tool.name);
			if (added.length > 0) {
				// Keep this change purely additive so Pi can use native deferred loading when supported.
				pi.setActiveTools(unique([...active, ...added]));
			}

			const unmanagedHints =
				matches.length === 0 && snapshot.loadedConfig.config.search.showUnmanagedHints
					? ranked
							.filter(
								(match) =>
									match.item.decision.state === "unmanaged" &&
									match.item.tool.sourceInfo.source !== "builtin" &&
									match.score >= minimumScore,
							)
							.slice(0, Math.min(3, limit))
							.map((match) => match.item)
					: [];

			return {
				content: [
					{
						type: "text",
						text: formatSearchResult({
							query: params.query,
							matches,
							added,
							unmanagedHints,
							configErrorCount: snapshot.loadedConfig.errors.length,
						}),
					},
				],
				details: {
					query: params.query,
					matches: [...selection.toActivate, ...selection.alreadyActive].map((match) => ({
						name: match.item.tool.name,
						score: match.score,
						matchedTerms: match.matchedTerms,
						wasActive: match.item.active,
					})),
					added,
					unmanagedHintCount: unmanagedHints.length,
				},
			};
		},
	});

	pi.registerEntryRenderer<AuditEntryData>(AUDIT_ENTRY_TYPE, (entry, _options, theme) => {
		return new Text(theme.fg("muted", entry.data?.text ?? ""), 0, 0);
	});

	pi.registerCommand("tool-audit", {
		description: "Show active, hidden, managed, unmanaged, and blocked tools. Use 'all' to include built-ins.",
		handler: async (args, ctx) => {
			const snapshot = createInventory(pi, ctx, state);
			const report = buildAuditReport({
				inventory: snapshot.inventory,
				loadedConfig: snapshot.loadedConfig,
				promptOptions: ctx.getSystemPromptOptions(),
				argument: args,
				projectConfigAllowed: ctx.isProjectTrusted(),
			});
			pi.appendEntry<AuditEntryData>(AUDIT_ENTRY_TYPE, { text: report });
			ctx.ui.notify("Tool audit added to the session. It is not sent to the model.", "info");
		},
	});

	pi.registerCommand("tool-reset", {
		description: "Hide tools loaded by search_tools and return to the configured base tool set.",
		handler: async (_args, ctx) => {
			state.activatedManaged.clear();
			enforcePolicy(pi, ctx, state);
			ctx.ui.notify("Managed tools were reset. Tool removal can reduce prompt-cache reuse on the next request.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		state.activatedManaged.clear();
		state.initialToolIdentities = new Set(pi.getAllTools().map(toolIdentity));
		state.initialized = true;
		const snapshot = enforcePolicy(pi, ctx, state);
		if (snapshot.loadedConfig.errors.length > 0) {
			ctx.ui.notify("Progressive Tools found configuration errors. Run /tool-audit.", "warning");
		}
	});

	pi.on("input", (_event, ctx) => {
		// Re-scan the live Pi tool catalog before each user turn. This catches tools
		// that another extension registered after session_start.
		enforcePolicy(pi, ctx, state);
		return { action: "continue" };
	});
}
