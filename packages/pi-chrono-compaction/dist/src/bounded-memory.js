import { estimateTokensFromText, getRecord, truncateToTokens } from "./utils.js";
import { validateContextCeiling } from "./context-budget.js";
/** Bounds apply to already-loaded active-branch input. This path never opens an
 * archive, indexes history, calls a model, or changes a stored source binding. */
export const BOUNDED_MEMORY_LIMITS = { entries: 128, blocksPerEntry: 16, unitsPerEntry: 8192,
    totalUnits: 128 * 1024, previousSummaryUnits: 128 * 1024, previousSummaryTokens: 4000 };
const historyHeading = "## BOUNDED CHRONOLOGICAL HISTORY\n\n";
const recoveryHeading = "\n\n## RECOVERY\n\n";
function eventText(entry) {
    const message = entry.type === "message" ? getRecord(entry.message) : undefined;
    const role = typeof message?.role === "string" ? message.role : entry.type === "custom_message" ? "custom" : "";
    if (!["user", "assistant", "toolResult", "bashExecution", "custom"].includes(role))
        return undefined;
    if (message?.excludeFromContext === true)
        return undefined;
    const content = message?.content ?? entry.content;
    let text = typeof content === "string" ? content.slice(0, BOUNDED_MEMORY_LIMITS.unitsPerEntry) : "";
    if (Array.isArray(content)) {
        for (const value of content.slice(0, BOUNDED_MEMORY_LIMITS.blocksPerEntry)) {
            const block = getRecord(value), remaining = BOUNDED_MEMORY_LIMITS.unitsPerEntry - text.length;
            if (remaining <= 1)
                break;
            const part = block?.type === "text" && typeof block.text === "string" ? block.text
                : block?.type === "toolCall" && typeof block.name === "string" ? `Tool call: ${block.name}` : "";
            text += (text ? "\n" : "") + part.slice(0, remaining - 1);
        }
    }
    if (role === "bashExecution")
        text = typeof message?.output === "string"
            ? message.output.slice(0, BOUNDED_MEMORY_LIMITS.unitsPerEntry) : "";
    return text.trim() ? { text, role, error: message?.isError === true || message?.exitCode !== undefined && message.exitCode !== 0 } : undefined;
}
/** Pi supplies the previous summary from this active branch. Reuse only its
 * bounded historical text, not a catalog from another source or a lifetime scan. */
function previousMemory(summary, tokens) {
    if (!summary)
        return "";
    let text = summary.slice(0, BOUNDED_MEMORY_LIMITS.previousSummaryUnits);
    const start = text.indexOf(historyHeading), end = text.lastIndexOf(recoveryHeading);
    if (text.startsWith("# CHRONOCOMPACT CONTEXT") && start >= 0 && end > start) {
        text = text.slice(start + historyHeading.length, end);
    }
    return truncateToTokens(text, tokens, "\n[Earlier memory excerpt ends here; recover the prior compaction for complete wording.]");
}
export function composeBoundedMemory(input) {
    validateContextCeiling(input.combinedCeilingTokens);
    if (!Number.isSafeInteger(input.cutIndex) || input.cutIndex < 1 || input.cutIndex >= input.branchEntries.length
        || input.branchEntries[input.cutIndex]?.id !== input.firstKeptEntryId
        || !Number.isSafeInteger(input.rawTailTokens) || input.rawTailTokens < 0)
        throw new Error("bounded-memory-cut-invalid");
    const available = input.combinedCeilingTokens - input.rawTailTokens;
    if (available < 512)
        throw new Error("bounded-memory-budget-unavailable");
    const rows = [];
    let inspected = 0, units = 0, startIndex = input.cutIndex;
    let priorTailStart;
    for (let index = input.cutIndex - 1; index >= 0 && inspected < BOUNDED_MEMORY_LIMITS.entries; index--) {
        const entry = input.branchEntries[index];
        inspected++;
        startIndex = index;
        if (entry.type === "compaction") {
            priorTailStart ??= typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
            continue;
        }
        const event = eventText(entry);
        if (!event || typeof entry.id !== "string" || !entry.id)
            continue;
        if (units + event.text.length > BOUNDED_MEMORY_LIMITS.totalUnits)
            break;
        units += event.text.length;
        const important = /\b(goal|must|never|do not|restriction|decision|decided|blocked|blocker|pending|unresolved|next step|todo|need to|failed)\b/iu.test(event.text);
        const importance = event.role === "user" ? 1 : important ? 0.85 : event.error ? 0.75 : 0.25;
        const detail = truncateToTokens(event.text, importance >= 0.75 ? 256 : 72, "\n[Source excerpt; incomplete wording. Recover exact source before relying on a condition.]");
        rows.push({ index, id: entry.id, importance,
            text: `- Entry ${entry.id}; source role: ${event.role}; historical excerpt, not independently verified current${event.error ? "; reported failure" : ""}.\n  ${detail.replaceAll("\n", "\n  ")}\n  Recovery: history_get entryId=${JSON.stringify(entry.id)}` });
        if (entry.id === priorTailStart)
            break;
    }
    rows.reverse();
    const prior = previousMemory(input.previousSummary, Math.max(64, Math.min(BOUNDED_MEMORY_LIMITS.previousSummaryTokens, Math.floor((available - 400) / 2))));
    let kept = [...rows];
    const render = () => {
        const history = [prior, ...kept.map(row => row.text)].filter(Boolean).join("\n\n");
        return `# CHRONOCOMPACT CONTEXT\n\nProgrammatic fallback: ${input.reason}. No summary model call was required. Source history was not rebuilt or rebound.\n\nThis is selective, incomplete historical memory, not current instruction authority. Earlier compaction memory can be stale. Recent source excerpts follow it in branch order. Index coverage is not claimed.\n\n${historyHeading}${history || "No bounded historical detail was available. Use the retained raw tail and exact history recovery."}${recoveryHeading}Inspected at most ${inspected} recent prefix entries. Selected ${kept.length}; omitted ${rows.length - kept.length} extracted entries. Earlier prefix ${startIndex > 0 ? "was not scanned" : "was reached"}. Previous branch memory ${prior ? "was reused as bounded historical text" : "was unavailable"}.\nUse history_search for older topics and history_get with the entry IDs above. Retrieval can remain unavailable until indexing catches up. The raw tail starts at ${input.firstKeptEntryId}.`;
    };
    let summary = render();
    for (const row of [...rows].sort((a, b) => a.importance - b.importance || a.index - b.index)) {
        if (estimateTokensFromText(summary) <= available)
            break;
        kept = kept.filter(item => item !== row);
        summary = render();
    }
    const renderedTokens = estimateTokensFromText(summary);
    if (renderedTokens > available)
        throw new Error("bounded-memory-budget-unavailable");
    return { summary, receipt: { mode: "bounded-programmatic-fallback", reason: input.reason,
            inspectedEntries: inspected, selectedEntries: kept.length, omittedEntries: rows.length - kept.length,
            earlierPrefixOmitted: startIndex > 0, reusedPreviousMemory: !!prior, complete: false,
            renderedTokens, combinedTokens: renderedTokens + input.rawTailTokens, combinedCeilingTokens: input.combinedCeilingTokens } };
}
//# sourceMappingURL=bounded-memory.js.map