import assert from "node:assert/strict";
import test from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	buildDesiredActiveTools,
	buildInventory,
	classifyTool,
	ruleMatchesTool,
	SEARCH_TOOL_NAME,
	toolIdentity,
} from "../extensions/policy.ts";
import { rankInventory, selectManagedSearchResults, tokenize } from "../extensions/search.ts";
import type { ProgressiveToolsConfig } from "../extensions/types.ts";

function config(overrides: Partial<ProgressiveToolsConfig> = {}): ProgressiveToolsConfig {
	return {
		version: 1,
		areas: [],
		alwaysActive: [],
		managed: [],
		blocked: [],
		aliases: [],
		search: {
			defaultLimit: 3,
			maxLimit: 5,
			minimumScore: 2,
			showUnmanagedHints: true,
		},
		audit: { largeSchemaTokens: 1000 },
		...overrides,
	};
}

function tool(options: {
	name: string;
	description?: string;
	source?: string;
	path?: string;
	scope?: "user" | "project" | "temporary";
	origin?: "package" | "top-level";
	parameters?: unknown;
	promptGuidelines?: string[];
}): ToolInfo {
	return {
		name: options.name,
		description: options.description ?? `${options.name} description`,
		parameters: (options.parameters ?? { type: "object", properties: {} }) as ToolInfo["parameters"],
		promptGuidelines: options.promptGuidelines,
		sourceInfo: {
			source: options.source ?? "npm:example-tools",
			path: options.path ?? `/extensions/${options.name}.ts`,
			scope: options.scope ?? "user",
			origin: options.origin ?? "package",
		},
	};
}

test("wildcard rules match every supplied selector", () => {
	const candidate = tool({
		name: "github_pr_threads",
		source: "npm:@example/github-tools",
		path: "/synthetic/pi-agent/npm/github/extensions/pr.ts",
	});
	assert.equal(
		ruleMatchesTool(
			{
				name: "github_*",
				source: "npm:@example/*",
				path: "*/extensions/*.ts",
				scope: "user",
				origin: "package",
			},
			candidate,
		),
		true,
	);
	assert.equal(ruleMatchesTool({ name: "gitlab_*", source: "npm:@example/*" }, candidate), false);
});

test("built-ins stay protected without being force-activated and the loader stays active", () => {
	const builtin = tool({ name: "read", source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" });
	const loader = tool({ name: SEARCH_TOOL_NAME, source: "local:/broker" });
	assert.equal(classifyTool(builtin, config()).state, "core");
	assert.equal(classifyTool(loader, config()).state, "core");
	assert.equal(classifyTool(builtin, config()).forceActive, false);
	assert.equal(classifyTool(loader, config()).forceActive, true);
});

test("unknown extension tools stay unmanaged", () => {
	assert.equal(classifyTool(tool({ name: "unknown_service_call" }), config()).state, "unmanaged");
});

test("approved source rules manage new tools from that source", () => {
	const approved = config({
		managed: [{ source: "npm:@example/github-tools", area: "GitHub", aliases: ["pull request", "review"] }],
	});
	const decision = classifyTool(tool({ name: "new_pr_tool", source: "npm:@example/github-tools" }), approved);
	assert.equal(decision.state, "managed");
	assert.deepEqual(decision.areas, ["GitHub"]);
	assert.deepEqual(decision.aliases, ["pull request", "review"]);
});

test("blocked rules take priority", () => {
	const candidate = tool({ name: "dangerous_deploy", source: "npm:@example/cloud" });
	const decision = classifyTool(
		candidate,
		config({
			alwaysActive: [{ source: "npm:@example/cloud" }],
			managed: [{ source: "npm:@example/cloud" }],
			blocked: [{ name: "dangerous_*" }],
		}),
	);
	assert.equal(decision.state, "blocked");
});

test("a non-built-in core-name override is not auto-managed", () => {
	const replacement = tool({ name: "bash", source: "npm:replacement-tools" });
	const managed = classifyTool(replacement, config({ managed: [{ source: "npm:replacement-tools" }] }));
	assert.equal(managed.state, "unmanaged");
	const blocked = classifyTool(replacement, config({ blocked: [{ name: "bash", source: "npm:replacement-tools" }] }));
	assert.equal(blocked.state, "blocked");
});

test("inventory detects a new source that reuses an existing tool name", () => {
	const original = tool({ name: "service_lookup", source: "npm:old-source", path: "/old/tool.ts" });
	const replacement = tool({ name: "service_lookup", source: "npm:new-source", path: "/new/tool.ts" });
	const inventory = buildInventory({
		tools: [replacement],
		activeTools: new Set([replacement.name]),
		activatedManaged: new Set(),
		initialToolIdentities: new Set([toolIdentity(original)]),
		config: config(),
	});
	assert.equal(inventory[0].newThisSession, true);
	assert.ok(inventory[0].flags.includes("new-this-session"));
});

test("active-set policy hides unactivated managed tools and keeps unknown tools unchanged", () => {
	const tools = [
		tool({ name: "read", source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" }),
		tool({ name: SEARCH_TOOL_NAME, source: "local:/broker" }),
		tool({ name: "github_pr_get", source: "npm:github-tools" }),
		tool({ name: "unmanaged_tool", source: "npm:other-tools" }),
		tool({ name: "blocked_tool", source: "npm:bad-tools" }),
	];
	const inventory = buildInventory({
		tools,
		activeTools: new Set(tools.map((item) => item.name)),
		activatedManaged: new Set(),
		initialToolIdentities: new Set(tools.map(toolIdentity)),
		config: config({
			managed: [{ source: "npm:github-tools" }],
			blocked: [{ source: "npm:bad-tools" }],
		}),
	});
	assert.deepEqual(
		buildDesiredActiveTools({
			current: tools.map((item) => item.name),
			inventory,
			activatedManaged: new Set(),
		}),
		["read", SEARCH_TOOL_NAME, "unmanaged_tool"],
	);
	assert.deepEqual(
		buildDesiredActiveTools({
			current: ["read", SEARCH_TOOL_NAME, "unmanaged_tool"],
			inventory,
			activatedManaged: new Set(["github_pr_get"]),
		}),
		["read", SEARCH_TOOL_NAME, "unmanaged_tool", "github_pr_get"],
	);
});

test("explicit blocked rules retire built-in names without activating other built-ins", () => {
	const read = tool({ name: "read", source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" });
	const grep = tool({ name: "grep", source: "builtin", path: "builtin:grep", scope: "temporary", origin: "top-level" });
	const loader = tool({ name: SEARCH_TOOL_NAME, source: "local:/broker" });
	const tools = [read, grep, loader];
	const policy = config({ blocked: [{ name: ["grep", "find", "fuzzy_find"] }] });
	const inventory = buildInventory({
		tools,
		activeTools: new Set([read.name, grep.name]),
		activatedManaged: new Set(),
		initialToolIdentities: new Set(tools.map(toolIdentity)),
		config: policy,
	});
	assert.equal(classifyTool(grep, policy).state, "blocked");
	assert.deepEqual(
		buildDesiredActiveTools({ current: [read.name, grep.name], inventory, activatedManaged: new Set() }),
		[read.name, SEARCH_TOOL_NAME],
	);
});

test("search ranks aliases and task words", () => {
	const weather = tool({ name: "lookup_city", description: "Read current conditions for a place." });
	const issues = tool({ name: "search_issues", description: "Search project work items." });
	const cfg = config({
		managed: [
			{ name: weather.name, area: "weather", aliases: ["forecast", "temperature"] },
			{ name: issues.name, area: "issue tracking", aliases: ["bug", "ticket", "backlog"] },
		],
	});
	const inventory = buildInventory({
		tools: [weather, issues],
		activeTools: new Set(),
		activatedManaged: new Set(),
		initialToolIdentities: new Set([toolIdentity(weather), toolIdentity(issues)]),
		config: cfg,
	});
	const ranked = rankInventory("find the current city temperature forecast", inventory);
	assert.equal(ranked[0].item.tool.name, "lookup_city");
	assert.ok(ranked[0].score > 0);
	assert.ok(ranked[0].matchedTerms.includes("temperature"));
});


test("the result limit applies before partitioning active and hidden matches", () => {
	const activeTool = tool({ name: "github_general", description: "General GitHub work." });
	const hiddenTool = tool({ name: "github_review_threads", description: "Read GitHub pull request review threads." });
	const cfg = config({
		managed: [
			{ name: activeTool.name, aliases: ["GitHub review"] },
			{ name: hiddenTool.name, aliases: ["GitHub review threads"] },
		],
	});
	const inventory = buildInventory({
		tools: [activeTool, hiddenTool],
		activeTools: new Set([activeTool.name]),
		activatedManaged: new Set([activeTool.name]),
		initialToolIdentities: new Set([toolIdentity(activeTool), toolIdentity(hiddenTool)]),
		config: cfg,
	});
	const ranked = rankInventory("GitHub review", inventory);
	const selection = selectManagedSearchResults(ranked, { limit: 1, minimumScore: 1 });
	assert.deepEqual(selection.toActivate.map((match) => match.item.tool.name), []);
	assert.deepEqual(selection.alreadyActive.map((match) => match.item.tool.name), [activeTool.name]);
});

test("reset and restart remove discovered managed tools without duplicating active names", () => {
	const read = tool({ name: "read", source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" });
	const loader = tool({ name: SEARCH_TOOL_NAME, source: "local:/broker" });
	const managed = tool({ name: "web_search", description: "Search the web." });
	const tools = [read, loader, managed];
	const cfg = config({ managed: [{ name: managed.name }] });
	const inventory = buildInventory({
		tools,
		activeTools: new Set([read.name, loader.name, managed.name]),
		activatedManaged: new Set([managed.name]),
		initialToolIdentities: new Set(tools.map(toolIdentity)),
		config: cfg,
	});
	assert.deepEqual(
		buildDesiredActiveTools({
			current: [read.name, loader.name, managed.name, managed.name],
			inventory,
			activatedManaged: new Set([managed.name]),
		}),
		[read.name, loader.name, managed.name],
	);
	assert.deepEqual(
		buildDesiredActiveTools({
			current: [read.name, loader.name, managed.name],
			inventory,
			activatedManaged: new Set(),
		}),
		[read.name, loader.name],
	);
});

test("tokenization removes common filler words", () => {
	const terms = tokenize("Please use the GitHub PR review tools");
	assert.ok(terms.includes("github"));
	assert.ok(terms.includes("pr"));
	assert.ok(terms.includes("review"));
	assert.equal(terms.includes("please"), false);
});
