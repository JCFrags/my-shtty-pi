import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildAuditReport, type AuditEntryData } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { buildCatalog, cleanText, formatHelp, formatToolList, permittedInventory, toolSummary } from "./catalog.ts";
import {
	buildDesiredActiveTools,
	buildInventory,
	isSameToolList,
	HELP_TOOL_NAME,
	LIST_TOOL_NAME,
	toolIdentity,
} from "./policy.ts";
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

export default function progressiveToolsExtension(pi: ExtensionAPI): void {
	const state: BrokerState = {
		activatedManaged: new Set<string>(),
		initialToolIdentities: new Set<string>(),
		initialized: false,
	};

	pi.registerTool({
		name: HELP_TOOL_NAME,
		label: "Tool Help",
		description: "Get concise usage guidance for exact registered tool names and enable managed tools. This does not run tool operations or return schemas. Call newly enabled tools on the next model response.",
		promptSnippet: "Get tool guidance and enable managed tools by exact name",
		parameters: Type.Object({
			names: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 20,
				description: "Exact native tool names from the tool catalog or list_tools. No aliases or task queries.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = createInventory(pi, ctx, state);
			const byName = new Map(snapshot.inventory.map((item) => [item.tool.name, item]));
			// Validate the whole request before changing activation. A failed execute
			// must not leave partial additions without Pi's deferred-loading marker.
			const matches = unique(params.names).map((name) => {
				const item = byName.get(name);
				if (!item) throw new Error(`Tool "${cleanText(name)}" is not registered or is unavailable in this session. Use list_tools for exact names.`);
				if (item.decision.state === "blocked") throw new Error(`Tool "${cleanText(name)}" is blocked by policy.`);
				if (!item.active && item.decision.state !== "managed") {
					throw new Error(`Tool "${cleanText(name)}" is inactive and is not managed by this extension. The user can inspect it with /tool-audit.`);
				}
				return item;
			});
			const active = pi.getActiveTools();
			const added = matches.filter((item) => !active.includes(item.tool.name)).map((item) => item.tool.name);
			const text = formatHelp(matches, snapshot.loadedConfig.config, added);
			if (added.length > 0) {
				// Keep this change inside execute and purely additive for native loading.
				pi.setActiveTools(unique([...active, ...added]));
			}
			for (const item of matches) {
				if (item.decision.state === "managed") state.activatedManaged.add(item.tool.name);
			}
			return {
				content: [{ type: "text", text }],
				details: { names: matches.map((item) => item.tool.name), added },
			};
		},
	});

	pi.registerTool({
		name: LIST_TOOL_NAME,
		label: "List Tools",
		description: "List exact registered names and short usage hints for active or policy-managed tools. Does not return schemas, enable tools, or run operations.",
		promptSnippet: "List tool names and short usage hints without schemas",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const snapshot = createInventory(pi, ctx, state);
			const inventory = permittedInventory(snapshot.inventory);
			return {
				content: [{ type: "text", text: formatToolList(inventory, snapshot.loadedConfig.config, true) || "No permitted tools are registered." }],
				details: {
					tools: inventory.map((item) => ({
						name: item.tool.name,
						active: item.active,
						summary: toolSummary(item.tool, snapshot.loadedConfig.config),
					})),
				},
			};
		},
	});

	pi.registerEntryRenderer<AuditEntryData>(AUDIT_ENTRY_TYPE, (entry, _options, theme) => {
		return new Text(theme.fg("muted", entry.data?.text ?? ""), 0, 0);
	});

	pi.registerCommand("tool-audit", {
		description: "Show active, inactive, managed, unmanaged, and blocked tools. Use 'all' to include built-ins.",
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
		description: "Hide managed tools enabled by tool_help and return to the configured base tool set.",
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

	pi.on("before_agent_start", (event, ctx) => {
		const snapshot = createInventory(pi, ctx, state);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildCatalog(snapshot.inventory, snapshot.loadedConfig.config)}`,
		};
	});

	pi.on("input", (_event, ctx) => {
		// Re-scan the live Pi tool catalog before each user turn. This catches tools
		// that another extension registered after session_start.
		enforcePolicy(pi, ctx, state);
		return { action: "continue" };
	});
}
