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
	/** Short capability area for the model-visible capability map. */
	area?: string;
	/** Extra task and service words used by search. */
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
	activatedBySearch: boolean;
	newThisSession: boolean;
	estimatedTokens: number;
	flags: string[];
}

export interface RankedTool {
	item: InventoryItem;
	score: number;
	matchedTerms: string[];
}
