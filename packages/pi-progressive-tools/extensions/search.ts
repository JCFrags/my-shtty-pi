import type { InventoryItem, RankedTool } from "./types.ts";

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"do",
	"for",
	"from",
	"get",
	"has",
	"have",
	"i",
	"in",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"please",
	"that",
	"the",
	"this",
	"to",
	"tool",
	"tools",
	"use",
	"using",
	"want",
	"with",
]);

function normalizeBasic(value: string): string {
	return value
		.replace(/[_./:@\\-]+/g, " ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function normalize(value: string): string {
	return normalizeBasic(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

export function tokenize(value: string): string[] {
	const basicTerms = normalizeBasic(value).split(/\s+/);
	const camelTerms = normalize(value).split(/\s+/);
	return unique([...basicTerms, ...camelTerms]).filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function tokenSet(value: string): Set<string> {
	return new Set(tokenize(value));
}

function partialTokenMatch(term: string, candidates: ReadonlySet<string>): boolean {
	if (term.length < 4) return false;
	for (const candidate of candidates) {
		if (candidate.length < 4) continue;
		if (candidate.includes(term) || term.includes(candidate)) return true;
	}
	return false;
}

function scoreItem(query: string, queryTerms: string[], item: InventoryItem): RankedTool {
	const queryPhrase = normalize(query);
	const namePhrase = normalize(item.tool.name);
	const descriptionPhrase = normalize(item.tool.description);
	const aliasesPhrase = normalize(item.decision.aliases.join(" "));
	const areasPhrase = normalize(item.decision.areas.join(" "));
	const sourcePhrase = normalize(`${item.tool.sourceInfo.source} ${item.tool.sourceInfo.path}`);
	const parameterPhrase = normalize(safeStringify(item.tool.parameters).slice(0, 30_000));

	const nameTokens = tokenSet(namePhrase);
	const descriptionTokens = tokenSet(descriptionPhrase);
	const aliasTokens = tokenSet(aliasesPhrase);
	const areaTokens = tokenSet(areasPhrase);
	const sourceTokens = tokenSet(sourcePhrase);
	const parameterTokens = tokenSet(parameterPhrase);

	let score = 0;
	const matchedTerms: string[] = [];

	if (queryPhrase && namePhrase === queryPhrase) score += 12;
	else if (queryPhrase && namePhrase.includes(queryPhrase)) score += 8;

	if (queryPhrase && aliasesPhrase.includes(queryPhrase)) score += 7;
	if (queryPhrase && areasPhrase.includes(queryPhrase)) score += 5;
	if (queryPhrase.length >= 4 && descriptionPhrase.includes(queryPhrase)) score += 5;

	for (const term of queryTerms) {
		let termScore = 0;
		if (nameTokens.has(term)) termScore = Math.max(termScore, 5);
		if (aliasTokens.has(term)) termScore = Math.max(termScore, 4);
		if (areaTokens.has(term)) termScore = Math.max(termScore, 3);
		if (descriptionTokens.has(term)) termScore = Math.max(termScore, 3);
		if (sourceTokens.has(term)) termScore = Math.max(termScore, 2);
		if (parameterTokens.has(term)) termScore = Math.max(termScore, 1);

		if (termScore === 0 && partialTokenMatch(term, nameTokens)) termScore = 2;
		if (termScore === 0 && partialTokenMatch(term, aliasTokens)) termScore = 2;
		if (termScore === 0 && partialTokenMatch(term, descriptionTokens)) termScore = 1;

		if (termScore > 0) {
			score += termScore;
			matchedTerms.push(term);
		}
	}

	// Prefer tools that match several distinct request terms.
	if (matchedTerms.length >= 2) score += matchedTerms.length;
	if (item.active) score += 1;

	return { item, score, matchedTerms: unique(matchedTerms) };
}

export function rankInventory(query: string, inventory: InventoryItem[]): RankedTool[] {
	const queryTerms = unique(tokenize(query));
	if (!query.trim() || queryTerms.length === 0) return [];

	return inventory
		.map((item) => scoreItem(query, queryTerms, item))
		.filter((ranked) => ranked.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			if (left.item.active !== right.item.active) return left.item.active ? -1 : 1;
			return left.item.tool.name.localeCompare(right.item.tool.name);
		});
}

export function selectManagedSearchResults(
	ranked: RankedTool[],
	options: { limit: number; minimumScore: number },
): { toActivate: RankedTool[]; alreadyActive: RankedTool[] } {
	const selected = ranked
		.filter((match) => match.item.decision.state === "managed" && match.score >= options.minimumScore)
		.slice(0, options.limit);
	return {
		toActivate: selected.filter((match) => !match.item.active),
		alreadyActive: selected.filter((match) => match.item.active),
	};
}
