import { byteCount, estimateTokensFromText, lineCount, truncateToTokens, unique } from "../utils.js";
import { normalizeTerminalText } from "./normalize.js";
export function looksLikeDiff(text) {
    return /(?:^diff --git |^@@\s+-\d|^Index: |^---\s+\S+\n\+\+\+\s+\S+)/m.test(text);
}
function parseDiff(lines) {
    const files = [];
    const hunks = [];
    const criticalLines = [];
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
        const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (fileMatch?.[2])
            files.push(fileMatch[2]);
        const indexFile = line.match(/^Index:\s+(.+)$/)?.[1];
        if (indexFile)
            files.push(indexFile);
        if (line.startsWith("@@"))
            hunks.push(line);
        if (line.startsWith("+") && !line.startsWith("+++"))
            additions += 1;
        if (line.startsWith("-") && !line.startsWith("---"))
            deletions += 1;
        if (/(?:export\b|public\b|interface\b|type\b|schema\b|migration\b|CREATE TABLE|ALTER TABLE|DROP TABLE|test\(|describe\(|it\(|expect\(|assert|throw|error|deprecated|breaking)/i.test(line)) {
            criticalLines.push(line);
        }
    }
    return { files: unique(files), additions, deletions, hunks, criticalLines: unique(criticalLines) };
}
function selectedDiff(lines, critical) {
    const selected = new Set();
    const criticalSet = new Set(critical);
    lines.forEach((line, index) => {
        if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
            selected.add(index);
        }
        if (criticalSet.has(line)) {
            for (let cursor = Math.max(0, index - 3); cursor <= Math.min(lines.length - 1, index + 5); cursor += 1)
                selected.add(cursor);
        }
    });
    if (selected.size === 0) {
        for (let index = 0; index < Math.min(lines.length, 80); index += 1)
            selected.add(index);
    }
    const output = [];
    let previous = -2;
    for (const index of [...selected].sort((a, b) => a - b)) {
        if (index > previous + 1 && output.length > 0)
            output.push("…");
        output.push(lines[index] ?? "");
        previous = index;
    }
    return output;
}
export function reduceDiff(context) {
    const normalized = normalizeTerminalText(context.block.exactText);
    const lines = normalized.text.split("\n");
    const stats = parseDiff(lines);
    const selected = selectedDiff(lines, stats.criticalLines);
    const sections = [
        `Files changed (${stats.files.length}):${stats.files.length > 0 ? `\n${stats.files.map((file) => `- ${file}`).join("\n")}` : " unknown"}`,
        `Additions: ${stats.additions}`,
        `Deletions: ${stats.deletions}`,
        stats.hunks.length > 0 ? `Hunks: ${stats.hunks.slice(0, 30).join(" | ")}` : "",
        `\nSelected exact diff hunks:\n${selected.join("\n")}`,
    ].filter(Boolean);
    let text = sections.join("\n");
    text = truncateToTokens(text, context.maxTokens, "\n…[additional diff hunks omitted]…\n");
    const omittedLines = Math.max(0, lines.length - lineCount(text));
    const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
    const omissions = [...normalized.omissions];
    if (omittedLines > 0 || omittedBytes > 0) {
        omissions.push({
            description: "Mechanical or non-critical diff hunks omitted; file list, counts, symbols, schema/API/test changes retained",
            omittedLines,
            omittedBytes,
        });
    }
    return {
        text,
        reducer: "git-diff",
        version: "1.0.0",
        lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
        omissions,
        metadata: { ...stats },
    };
}
//# sourceMappingURL=diff.js.map