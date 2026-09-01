import { byteCount, estimateTokensFromText, extractIdentifiers, getBoolean, getNumber, getRecord, getString, lineCount, truncateToTokens, unique, } from "../utils.js";
import { normalizeTerminalText } from "./normalize.js";
export function looksLikeSearchOutput(context) {
    const name = context.block.toolName ?? "";
    return /^(?:grep|rg|search|find)$/i.test(name) || /^(?:[^:\n]+):\d+:/m.test(context.block.exactText);
}
function parseMatch(raw) {
    const withLine = raw.match(/^(.+?):(\d+):(.*)$/);
    if (withLine?.[1] && withLine[2] && withLine[3] !== undefined) {
        return { file: withLine[1], line: Number.parseInt(withLine[2], 10), text: withLine[3], raw };
    }
    const pathOnly = raw.match(/^(.+?)(?::\s+|\s+-\s+)(.+)$/);
    if (pathOnly?.[1] && pathOnly[2])
        return { file: pathOnly[1], text: pathOnly[2], raw };
    return undefined;
}
function searchMetadata(context) {
    const args = context.block.toolArguments ?? {};
    const details = getRecord(context.block.attributes.details);
    const query = getString(args.pattern) ?? getString(args.query) ?? getString(args.regex) ?? getString(args.name) ?? getString(args.glob);
    const scope = getString(args.path) ?? getString(args.cwd) ?? getString(args.directory) ?? getString(args.root) ?? getString(details?.path);
    const truncated = getBoolean(details?.truncated) ?? getBoolean(details?.wasTruncated);
    const totalMatches = getNumber(details?.totalMatches) ?? getNumber(details?.count);
    return { query, scope, truncated, totalMatches };
}
export function reduceSearchOutput(context) {
    const normalized = normalizeTerminalText(context.block.exactText);
    const lines = normalized.text.split("\n").filter((line) => line.trim().length > 0);
    const matches = lines.map(parseMatch).filter((match) => match !== undefined);
    const metadata = searchMetadata(context);
    const downstreamTerms = extractIdentifiers(context.laterText).slice(0, 40);
    const sorted = [...matches].sort((a, b) => {
        const aRelevant = downstreamTerms.some((term) => a.raw.includes(term)) ? 1 : 0;
        const bRelevant = downstreamTerms.some((term) => b.raw.includes(term)) ? 1 : 0;
        return bRelevant - aRelevant;
    });
    const representative = sorted.slice(0, 40);
    const files = unique(matches.map((match) => match.file));
    const query = getString(metadata.query);
    const scope = getString(metadata.scope);
    const explicitTotal = getNumber(metadata.totalMatches);
    const truncated = getBoolean(metadata.truncated);
    const sections = [];
    if (query)
        sections.push(`Query: ${query}`);
    if (scope)
        sections.push(`Scope: ${scope}`);
    sections.push(`Matches observed: ${explicitTotal ?? matches.length}`);
    sections.push(`Files with matches (${files.length}):${files.length > 0 ? `\n${files.slice(0, 80).map((file) => `- ${file}`).join("\n")}` : " none"}`);
    if (truncated !== undefined)
        sections.push(`Original result exhaustive: ${String(!truncated)}`);
    sections.push(`\nRepresentative exact matches${downstreamTerms.length > 0 ? " (downstream-referenced matches prioritized)" : ""}:\n${representative.length > 0 ? representative.map((match) => match.raw).join("\n") : lines.slice(0, 40).join("\n")}`);
    let text = sections.join("\n");
    text = truncateToTokens(text, context.maxTokens, "\n…[additional search matches omitted]…\n");
    const omittedLines = Math.max(0, lines.length - lineCount(text));
    const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
    const omissions = [...normalized.omissions];
    if (omittedLines > 0 || omittedBytes > 0) {
        omissions.push({
            description: "Repeated or lower-relevance search matches omitted; query, scope, counts, files, and representative exact matches retained",
            omittedLines,
            omittedBytes,
        });
    }
    return {
        text,
        reducer: "search-results",
        version: "1.0.0",
        lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
        omissions,
        metadata: { ...metadata, parsedMatches: matches.length, files },
    };
}
//# sourceMappingURL=search.js.map