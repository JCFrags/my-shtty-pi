import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export type PatternValue = string | string[];

export interface ToolMatchRule {
	/** Case-insensitive wildcard match. Supports * and ?. */
	name?: PatternValue;
	/** Match against sourceInfo.source. Supports * and ?. */
	source?: PatternValue;
	/** Match against sourceInfo.path. Supports * and ?. */
	path?: PatternValue;
	/** Match sourceInfo.scope. */
	scope?: PatternValue;
	/** Match sourceInfo.origin. */
	origin?: PatternValue;
	/** Short capability area retained for audit filtering. */
	area?: string;
	/** Extra task and service words retained for audit filtering. */
	aliases?: string[];
	/** Optional note shown in the audit report. */
	note?: string;
}

export interface ToolAliasRule {
	name?: PatternValue;
	source?: PatternValue;
	path?: PatternValue;
	scope?: PatternValue;
	origin?: PatternValue;
	terms: string[];
}

export interface SearchConfig {
	defaultLimit: number;
	maxLimit: number;
	minimumScore: number;
	showUnmanagedHints: boolean;
}

export interface AuditConfig {
	largeSchemaTokens: number;
}

export interface ProgressiveToolsConfig {
	version: 1;
	areas: string[];
	alwaysActive: ToolMatchRule[];
	managed: ToolMatchRule[];
	blocked: ToolMatchRule[];
	aliases: ToolAliasRule[];
	/** Short usage hints keyed by exact registered tool name. */
	summaries: Record<string, string>;
	/** Legacy search settings are accepted but not used by exact-name help. */
	search: SearchConfig;
	audit: AuditConfig;
}

export interface LoadedConfig {
	config: ProgressiveToolsConfig;
	loadedPaths: string[];
	candidatePaths: string[];
	errors: string[];
}

export type PolicyState = "core" | "managed" | "unmanaged" | "blocked";

export interface PolicyDecision {
	state: PolicyState;
	forceActive: boolean;
	aliases: string[];
	areas: string[];
	matchedRule?: ToolMatchRule;
	matchedRuleIndex?: number;
	matchedRuleSet?: "alwaysActive" | "managed" | "blocked";
}

export interface InventoryItem {
	tool: ToolInfo;
	decision: PolicyDecision;
	active: boolean;
	activatedByHelp: boolean;
	newThisSession: boolean;
	estimatedTokens: number;
	flags: string[];
}
