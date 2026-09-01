import { byteCount, estimateTokensFromText, lineCount, truncateToTokens } from "../utils.js";
import { collapseAdjacentRepeatedLines, normalizeTerminalText } from "./normalize.js";
export function reduceGenericText(context) {
    const normalized = normalizeTerminalText(context.block.exactText);
    const originalLines = normalized.text.split("\n");
    const collapsed = collapseAdjacentRepeatedLines(originalLines);
    const head = collapsed.lines.slice(0, Math.min(24, collapsed.lines.length));
    const tail = collapsed.lines.slice(Math.max(head.length, collapsed.lines.length - 18));
    let text = [...head, ...(tail.length > 0 ? ["…", ...tail] : [])].join("\n");
    text = truncateToTokens(text, context.maxTokens, "\n…[middle content omitted]…\n");
    const omissions = [...normalized.omissions];
    if (collapsed.repeatedLines > 0) {
        omissions.push({
            description: `${collapsed.repeatedLines} adjacent repeated line(s) collapsed`,
            repeatedLines: collapsed.repeatedLines,
        });
    }
    const omittedLines = Math.max(0, originalLines.length - lineCount(text));
    const omittedBytes = Math.max(0, byteCount(context.block.exactText) - byteCount(text));
    if (omittedLines > 0 || omittedBytes > 0) {
        omissions.push({ description: "Middle content omitted; beginning and end retained", omittedLines, omittedBytes });
    }
    return {
        text,
        reducer: "generic-text",
        version: "1.0.0",
        lossy: estimateTokensFromText(text) < context.block.rawTokens || omissions.length > 0,
        omissions,
        metadata: { originalLines: originalLines.length },
    };
}
//# sourceMappingURL=generic.js.map