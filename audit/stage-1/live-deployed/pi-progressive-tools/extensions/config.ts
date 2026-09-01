import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	AuditConfig,
	LoadedConfig,
	PatternValue,
	ProgressiveToolsConfig,
	SearchConfig,
	ToolAliasRule,
	ToolMatchRule,
} from "./types.ts";

const PACKAGE_CONFIG_PATH = fileURLToPath(new URL("../progressive-tools.config.json", import.meta.url));
const USER_CONFIG_NAME = "progressive-tools.json";

const DEFAULT_SEARCH: SearchConfig = {
	defaultLimit: 3,
	maxLimit: 5,
	minimumScore: 2,
	showUnmanagedHints: true,
};

const DEFAULT_AUDIT: AuditConfig = {
	largeSchemaTokens: 1000,
};

const DEFAULT_CONFIG: ProgressiveToolsConfig = {
	version: 1,
	areas: [],
	alwaysActive: [],
	managed: [],
	blocked: [],
	aliases: [],
	search: DEFAULT_SEARCH,
	audit: DEFAULT_AUDIT,
};

interface PartialConfig {
	version?: unknown;
	areas?: unknown;
	alwaysActive?: unknown;
	managed?: unknown;
	blocked?: unknown;
	aliases?: unknown;
	search?: unknown;
	audit?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
}

function normalizePattern(value: unknown): PatternValue | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	const values = normalizeStringArray(value);
	return values.length > 0 ? values : undefined;
}

function hasSelector(rule: ToolMatchRule | ToolAliasRule): boolean {
	return Boolean(rule.name || rule.source || rule.path || rule.scope || rule.origin);
}

function normalizeMatchRule(value: unknown): ToolMatchRule | undefined {
	if (!isRecord(value)) return undefined;
	const rule: ToolMatchRule = {
		name: normalizePattern(value.name),
		source: normalizePattern(value.source),
		path: normalizePattern(value.path),
		scope: normalizePattern(value.scope),
		origin: normalizePattern(value.origin),
		area: typeof value.area === "string" && value.area.trim() ? value.area.trim() : undefined,
		aliases: normalizeStringArray(value.aliases),
		note: typeof value.note === "string" && value.note.trim() ? value.note.trim() : undefined,
	};
	return hasSelector(rule) ? rule : undefined;
}

function normalizeAliasRule(value: unknown): ToolAliasRule | undefined {
	if (!isRecord(value)) return undefined;
	const rule: ToolAliasRule = {
		name: normalizePattern(value.name),
		source: normalizePattern(value.source),
		path: normalizePattern(value.path),
		scope: normalizePattern(value.scope),
		origin: normalizePattern(value.origin),
		terms: normalizeStringArray(value.terms),
	};
	return hasSelector(rule) && rule.terms.length > 0 ? rule : undefined;
}

function normalizeRuleArray(value: unknown): ToolMatchRule[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizeMatchRule).filter((rule): rule is ToolMatchRule => Boolean(rule));
}

function normalizeAliasArray(value: unknown): ToolAliasRule[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizeAliasRule).filter((rule): rule is ToolAliasRule => Boolean(rule));
}

function positiveInteger(value: unknown, fallback: number, minimum = 1, maximum = 100_000): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function normalizeSearch(value: unknown): Partial<SearchConfig> {
	if (!isRecord(value)) return {};
	const result: Partial<SearchConfig> = {};
	if (value.defaultLimit !== undefined) {
		result.defaultLimit = positiveInteger(value.defaultLimit, DEFAULT_SEARCH.defaultLimit, 1, 20);
	}
	if (value.maxLimit !== undefined) {
		result.maxLimit = positiveInteger(value.maxLimit, DEFAULT_SEARCH.maxLimit, 1, 20);
	}
	if (value.minimumScore !== undefined) {
		result.minimumScore = positiveInteger(value.minimumScore, DEFAULT_SEARCH.minimumScore, 1, 100);
	}
	if (typeof value.showUnmanagedHints === "boolean") result.showUnmanagedHints = value.showUnmanagedHints;
	return result;
}

function normalizeAudit(value: unknown): Partial<AuditConfig> {
	if (!isRecord(value)) return {};
	const result: Partial<AuditConfig> = {};
	if (value.largeSchemaTokens !== undefined) {
		result.largeSchemaTokens = positiveInteger(value.largeSchemaTokens, DEFAULT_AUDIT.largeSchemaTokens, 1, 1_000_000);
	}
	return result;
}

function readLayer(path: string): { value?: PartialConfig; error?: string } {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) return { error: `${path}: the root value must be a JSON object` };
		return { value: parsed as PartialConfig };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `${path}: ${message}` };
	}
}

function appendLayer(target: ProgressiveToolsConfig, layer: PartialConfig, path: string, errors: string[]): void {
	if (layer.version !== undefined && layer.version !== 1) {
		errors.push(`${path}: unsupported config version ${String(layer.version)}; expected 1`);
		return;
	}

	target.areas = uniqueStrings([...target.areas, ...normalizeStringArray(layer.areas)]);
	target.alwaysActive.push(...normalizeRuleArray(layer.alwaysActive));
	target.managed.push(...normalizeRuleArray(layer.managed));
	target.blocked.push(...normalizeRuleArray(layer.blocked));
	target.aliases.push(...normalizeAliasArray(layer.aliases));
	target.search = { ...target.search, ...normalizeSearch(layer.search) };
	target.audit = { ...target.audit, ...normalizeAudit(layer.audit) };
}

export interface LoadConfigOptions {
	/** Read project-local configuration only after Pi has marked the project as trusted. */
	includeProject?: boolean;
}

export function getConfigPaths(cwd: string): { packagePath: string; userPath: string; projectPath: string } {
	return {
		packagePath: PACKAGE_CONFIG_PATH,
		userPath: join(getAgentDir(), USER_CONFIG_NAME),
		projectPath: join(cwd, CONFIG_DIR_NAME, USER_CONFIG_NAME),
	};
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): LoadedConfig {
	const config: ProgressiveToolsConfig = {
		...DEFAULT_CONFIG,
		areas: [],
		alwaysActive: [],
		managed: [],
		blocked: [],
		aliases: [],
		search: { ...DEFAULT_SEARCH },
		audit: { ...DEFAULT_AUDIT },
	};
	const paths = getConfigPaths(cwd);
	const candidatePaths = [paths.packagePath, paths.userPath, paths.projectPath];
	const pathsToRead = [paths.packagePath, paths.userPath];
	if (options.includeProject === true) pathsToRead.push(paths.projectPath);
	const loadedPaths: string[] = [];
	const errors: string[] = [];

	for (const path of pathsToRead) {
		const layer = readLayer(path);
		if (layer.error) {
			errors.push(layer.error);
			continue;
		}
		if (!layer.value) continue;
		loadedPaths.push(path);
		appendLayer(config, layer.value, path, errors);
	}

	config.search.maxLimit = Math.max(config.search.maxLimit, config.search.defaultLimit);
	config.search.defaultLimit = Math.min(config.search.defaultLimit, config.search.maxLimit);

	const ruleAreas = [...config.alwaysActive, ...config.managed]
		.map((rule) => rule.area)
		.filter((area): area is string => Boolean(area));
	config.areas = uniqueStrings([...config.areas, ...ruleAreas]);

	return { config, loadedPaths, candidatePaths, errors };
}
