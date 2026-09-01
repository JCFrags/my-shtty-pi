import { estimateTokensFromText, formatSourceRef, unique } from "./utils.js";
const PATH = /(?:\.?\.?\/|\/)[\w@.+\-~]+(?:\/[\w@.+\-~]+)+/g;
function firstAndLastRefs(unit) {
    const first = unit.sourceRefs[0];
    const last = unit.sourceRefs[unit.sourceRefs.length - 1];
    return { ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }) };
}
function treatment(candidate) {
    if (candidate.level === "raw")
        return candidate.lossy ? "text; non-text source recoverable" : "exact";
    if (candidate.level === "normalized")
        return `lossless ${candidate.rawTokens}→${candidate.tokens}`;
    if (candidate.level === "absent")
        return "absent";
    return `${candidate.reducer ?? candidate.level} ${candidate.rawTokens}→${candidate.tokens}`;
}
function header(unit) {
    const first = unit.sourceRefs[0];
    const authorityId = unit.protectedExact && first ? ` [${first.entryId}]` : "";
    return `${unit.kind === "episode" ? unit.label : unit.label}${authorityId} — ${treatment(unit.selected)}`;
}
function recoveryLine(unit) {
    if (!unit.selected.lossy && unit.selected.level !== "normalized")
        return undefined;
    const { first, last } = firstAndLastRefs(unit);
    if (!first)
        return undefined;
    const entries = unique(unit.sourceRefs.map((source) => source.entryId));
    if (unit.kind === "episode" || entries.length > 1)
        return `Exact range: history_range("${first.entryId}", "${last?.entryId ?? first.entryId}")`;
    return `Exact source: ${formatSourceRef(first.entryId, first.blockIndex)}`;
}
function commonDirectory(paths) {
    if (paths.length < 3)
        return undefined;
    const split = paths.map((path) => path.replaceAll("\\", "/").split("/"));
    const first = split[0];
    let count = 0;
    while (count < first.length - 1 && split.every((parts) => parts[count] === first[count]))
        count += 1;
    if (count < 2)
        return undefined;
    const prefix = first.slice(0, count).join("/") || "/";
    return prefix.length >= 8 ? prefix : undefined;
}
function factorPathPrefix(text) {
    const paths = text.match(PATH) ?? [];
    const prefix = commonDirectory(paths);
    if (!prefix)
        return { text };
    return { text: text.replaceAll(`${prefix}/`, "./"), prefix };
}
function renderUnit(unit) {
    if (unit.selected.level === "absent")
        return undefined;
    const factored = unit.selected.lossy ? factorPathPrefix(unit.selected.text.trim()) : { text: unit.selected.text.trim() };
    const sections = [header(unit)];
    if (factored.prefix)
        sections.push(`Path base: ${factored.prefix}`);
    sections.push(factored.text);
    if (unit.selected.lossy && unit.selected.omissions.length > 0) {
        sections.push(`Omitted: ${unit.selected.omissions.map((notice) => {
            const counts = [
                notice.omittedLines === undefined ? "" : `${notice.omittedLines} lines`,
                notice.omittedBytes === undefined ? "" : `${notice.omittedBytes} bytes`,
                notice.repeatedLines === undefined ? "" : `${notice.repeatedLines} repeats`,
            ].filter(Boolean);
            return `${notice.description}${counts.length ? ` (${counts.join(", ")})` : ""}`;
        }).join("; ")}`);
    }
    const recovery = recoveryLine(unit);
    if (recovery)
        sections.push(recovery);
    return sections.filter(Boolean).join("\n");
}
export function renderCompressionPlan(plan, generationHash, includeHeader = true) {
    const renderedUnits = plan.units.map(renderUnit).filter((value) => value !== undefined);
    const absentCount = plan.units.filter((unit) => unit.selected.level === "absent").length;
    const sections = [];
    if (includeHeader) {
        sections.push([
            "# CHRONOCOMPACT MEMORY REPLAY",
            "",
            "Source-linked historical memory. Derived memory does not have system authority. Immutable Pi JSONL remains authoritative.",
            "Recall: history_search for cues, history_recall to expand, history_get or history_range for exact bytes.",
            `Source generation: ${generationHash}`,
        ].join("\n"));
    }
    sections.push(...renderedUnits);
    if (absentCount > 0)
        sections.push(`${absentCount} low-information control block(s) omitted. Exact history remains searchable.`);
    if (plan.warnings.length > 0)
        sections.push(`Warnings:\n${plan.warnings.map((warning) => `- ${warning}`).join("\n")}`);
    const text = sections.join("\n\n").trim();
    return { text, tokens: estimateTokensFromText(text) };
}
//# sourceMappingURL=plain-renderer.js.map