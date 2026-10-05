import { reduceBlock } from "./reducers/index.js";
import { estimateTokensFromText, getRecord, truncateToTokens } from "./utils.js";
/** These limits apply before copying or reducing already-loaded source fields. */
export const CHRONOLOGICAL_REPLAY_LIMITS = Object.freeze({
    entries: 512, blocks: 16, entryUnits: 16_384, argumentUnits: 6_144,
    selectionBytes: 640 * 1024, relevanceTerms: 24, termUnits: 160,
});
/** Starting selection heuristic, not a measured optimum or another hard ceiling. */
const PREFERRED_REPLAY_TOKENS = 5000;
const safeId = (value) => typeof value === "string" && /^[\w.:-]{1,128}$/.test(value);
function relevanceMatches(text, terms) {
    let matches = 0, direct = 0;
    for (const term of terms) {
        if (text.includes(term)) {
            matches++;
            direct++;
            continue;
        }
        // Summary hints often name a topic with several words, not a source quote.
        // One hint's word overlap admits evidence but needs another signal to expand.
        const words = [...new Set(term.match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu) ?? [])]
            .filter(word => word.length >= 3 && !["the", "and", "for", "with", "from", "this", "that"].includes(word));
        if (words.filter(word => text.includes(word)).length >= 2)
            matches++;
    }
    return { relevanceMatches: matches, directMatches: direct };
}
const clip = (text, units) => {
    if (text.length <= units)
        return text;
    const marker = `\n[${text.length - units} or more UTF-16 units omitted]\n`;
    if (units <= marker.length)
        return "[omitted]".slice(0, Math.max(0, units));
    const body = units - marker.length, head = Math.ceil(body * 0.7);
    return text.slice(0, head) + marker + text.slice(text.length - (body - head));
};
/** Do not stringify a potentially large argument object before applying bounds. */
function argumentText(value) {
    let nodes = 0, units = 0, limited = false;
    const visit = (item, depth) => {
        if (++nodes > 128 || depth > 6 || units >= CHRONOLOGICAL_REPLAY_LIMITS.argumentUnits) {
            limited = true;
            return "[argument detail omitted]";
        }
        if (typeof item === "string") {
            const max = Math.max(0, Math.min(2048, CHRONOLOGICAL_REPLAY_LIMITS.argumentUnits - units));
            const text = clip(item, max);
            units += text.length;
            limited ||= text !== item;
            return text;
        }
        if (item === null || typeof item === "boolean" || typeof item === "number")
            return item;
        if (Array.isArray(item)) {
            const result = item.slice(0, 16).map(child => visit(child, depth + 1));
            if (item.length > 16) {
                limited = true;
                result.push(`[${item.length - 16} array items omitted]`);
            }
            return result;
        }
        const record = getRecord(item);
        if (record) {
            const result = Object.create(null);
            let count = 0;
            for (const key in record) {
                if (!Object.hasOwn(record, key))
                    continue;
                if (++count > 24 || units >= CHRONOLOGICAL_REPLAY_LIMITS.argumentUnits || nodes > 128) {
                    limited = true;
                    result["[omitted]"] = "additional argument fields";
                    break;
                }
                const name = clip(key, 128);
                limited ||= name !== key;
                units += name.length;
                result[name] = visit(record[key], depth + 1);
            }
            return result;
        }
        limited = true;
        return "[unsupported argument value]";
    };
    const text = JSON.stringify(visit(value, 0));
    return { text, limited };
}
/** The caller supplies Pi's complete active branch in source order, not all
 * session entries. Pi 0.85.1 has no buildSessionProjection export. Match the
 * later projection's retained-range/edit rules without copying lifetime bodies
 * or allocating a projection for every source entry. */
function captureReplayEdits(entries, cutIndex) {
    let firstContextIndex = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.type !== "compaction")
            continue;
        // Only edits retained by the latest compaction, or appended after it, apply.
        // A missing firstKeptEntryId or a retain-none boundary keeps no older entries.
        firstContextIndex = index + 1;
        for (let kept = 0; kept < index; kept++) {
            if (entries[kept].id === entry.firstKeptEntryId) {
                firstContextIndex = kept;
                break;
            }
        }
        break;
    }
    const pending = new Set();
    for (let index = cutIndex - 1; index >= Math.max(firstContextIndex, cutIndex - CHRONOLOGICAL_REPLAY_LIMITS.entries); index--) {
        const entry = entries[index];
        if (!safeId(entry.id))
            continue;
        if (entry.type === "compaction")
            break;
        pending.add(entry.id);
    }
    const edits = new Map();
    // Edits after the replay cut still affect its targets. Store at most one edit
    // per bounded candidate, and inspect replacement content only for those IDs.
    for (let index = entries.length - 1; index >= firstContextIndex && pending.size > 0; index--) {
        const entry = entries[index];
        if (entry.type !== "context_edit" || typeof entry.targetId !== "string" || !pending.delete(entry.targetId))
            continue;
        if (entry.replacement === null) {
            edits.set(entry.targetId, null);
            continue;
        }
        const replacement = getRecord(entry.replacement);
        if (!replacement || typeof replacement.content !== "string" && !Array.isArray(replacement.content)) {
            throw new Error("context-v4-replay-edit-invalid");
        }
        edits.set(entry.targetId, { content: replacement.content });
    }
    return { firstContextIndex, edits };
}
/** Recognize only empty output or the known nonterminal process envelope. A
 * poll can return evidence, a failure, or an agent handoff, so its name is not enough. */
function routineStatus(text) {
    const body = text.replace(/^Tool error: false\n\n/, "").trim();
    return !body || body === "No processes" || body === "No live sessions"
        || /^\[still running\]\nprocess_id: [\w.:-]+\npid: (?:\d+|unknown)\nlog_path: [^\n]+$/.test(body);
}
function routineTool(name, args) {
    if (name === "history_status" || name === "telemetry_status")
        return true;
    const action = getRecord(args)?.action;
    return typeof action === "string" && (name === "process" && ["poll", "list"].includes(action)
        || name === "session" && ["status", "list"].includes(action)
        || name === "orchestrate" && ["wait", "inspect", "list", "status"].includes(action)
        || name === "subagent_channel" && action === "progress");
}
function extractParts(entry, edit) {
    if (edit === null)
        return;
    const message = entry.type === "message" ? getRecord(entry.message) : undefined;
    const role = typeof message?.role === "string" ? message.role : entry.type === "custom_message" ? "custom" : "";
    if (!["user", "assistant", "toolResult", "bashExecution", "custom"].includes(role) || message?.excludeFromContext === true)
        return;
    const customType = message?.customType ?? entry.customType;
    // Compaction control and internal state stay recoverable in source, not nested in replay.
    if (role === "custom" && typeof customType === "string" && /^chrono-(?:context|session-agent-summary|session-summary|summary-request)/.test(customType))
        return;
    if (role === "toolResult" && message?.toolName === "request_compaction" && message.isError === false)
        return;
    const parts = [];
    let remaining = CHRONOLOGICAL_REPLAY_LIMITS.entryUnits;
    const add = (label, value, kind, toolName, limited = false) => {
        if (remaining <= 128)
            return;
        const text = clip(value, remaining);
        remaining -= text.length;
        parts.push({ label, text, kind, ...(toolName ? { toolName } : {}), limited: limited || text !== value });
    };
    const kind = role === "user" ? "user" : role === "toolResult" ? "tool_result" : role === "custom" ? "custom_message" : "assistant_text";
    const name = typeof message?.toolName === "string" ? clip(message.toolName, 128) : undefined;
    // Keep source role and metadata. Extraction accepts both strings and blocks,
    // including Pi's string-to-text-block normalization for assistant/tool edits.
    const content = edit && role !== "bashExecution" ? edit.content : message?.content ?? entry.content;
    let nonText = 0, controlCalls = 0;
    const calls = [];
    if (typeof content === "string")
        add("", content, kind, name);
    else if (Array.isArray(content)) {
        let visited = 0;
        for (const value of content.slice(0, CHRONOLOGICAL_REPLAY_LIMITS.blocks)) {
            if (remaining <= 128)
                break;
            visited++;
            const block = getRecord(value);
            if (block?.type === "text" && typeof block.text === "string")
                add("", block.text, kind, name);
            else if (block?.type === "toolCall" && typeof block.name === "string") {
                if (block.name === "request_compaction") {
                    controlCalls++;
                    continue;
                }
                const args = argumentText(block.arguments);
                calls.push({ ...(typeof block.id === "string" && block.id.length <= 512 ? { id: block.id } : {}),
                    routine: routineTool(block.name, block.arguments) });
                add(`Tool call: ${clip(block.name, 128)}`, args.text, "tool_call", clip(block.name, 128), args.limited);
            }
            else
                nonText++;
        }
        if (visited < content.length)
            parts.push({ label: "", text: `[${content.length - visited} content blocks omitted]`, kind, limited: true });
    }
    if (role === "bashExecution") {
        if (typeof message?.command === "string")
            add("Command", message.command, "tool_call", "bash");
        if (typeof message?.output === "string")
            add("Output", message.output, "bash_execution", "bash");
    }
    if (controlCalls > 0 && parts.length === 0)
        return;
    if (nonText)
        parts.push({ label: "", text: `[${nonText} non-text blocks omitted]`, kind, limited: true });
    const error = message?.isError === true || typeof message?.exitCode === "number" && message.exitCode !== 0;
    const outcome = typeof message?.exitCode === "number" ? `Exit code: ${message.exitCode}` : role === "toolResult" && typeof message?.isError === "boolean" ? `Tool error: ${message.isError}` : "";
    if (outcome)
        parts.unshift({ label: "", text: outcome, kind, limited: false });
    const label = role === "toolResult" ? `Tool result${name ? `: ${name}` : ""}` : role === "bashExecution" ? "Shell execution" : role === "custom" ? "Extension message" : role === "user" ? "User" : "Assistant";
    const hasText = parts.some(part => part.kind === "assistant_text" && !!part.text.trim());
    const toolOnly = role === "toolResult" || role === "bashExecution" || role === "assistant" && !hasText && calls.length > 0;
    const statusOnly = role === "toolResult" && routineStatus(parts.map(part => part.text).join("\n\n"));
    const routine = toolOnly && (calls.length > 0 ? calls.every(call => call.routine) : statusOnly && routineTool(name ?? ""));
    const resultCallId = role === "toolResult" && typeof message?.toolCallId === "string" && message.toolCallId.length <= 512
        ? message.toolCallId : undefined;
    return parts.length ? { parts, role: label, error, toolOnly, routine, statusOnly, calls, resultCallId } : undefined;
}
function partRepresentation(part, entry, index, maxTokens, relevance) {
    if (estimateTokensFromText(part.text) <= maxTokens)
        return part.text;
    // Keep user wording and arguments as explicit excerpts, not synthetic claims.
    if (part.kind === "user" || part.kind === "tool_call")
        return truncateToTokens(part.text, maxTokens, "\n[Source wording omitted]\n");
    const block = { id: `${entry.id}:${index}`, entryId: entry.id, entryIndex: index,
        kind: part.kind, label: part.label, exactText: part.text, rawTokens: estimateTokensFromText(part.text),
        sourceRefs: [{ entryId: entry.id }], protectedExact: false, reproducible: false, unresolved: false,
        exactIdentifiers: [], attributes: {}, ...(part.toolName ? { toolName: part.toolName } : {}) };
    const reduced = reduceBlock({ block, maxTokens, laterText: relevance });
    return reduced.text + (reduced.lossy ? "\n[Reduced source excerpts; recover the entry for complete wording.]" : "");
}
/** Capture only a bounded suffix of the complete active branch. Edit/compaction
 * metadata is checked through its full leaf; lifetime text is never copied. */
export function captureChronologicalReplay(entries, cutIndex, relevance = []) {
    if (!Number.isSafeInteger(cutIndex) || cutIndex < 1 || cutIndex >= entries.length
        || !safeId(entries[cutIndex]?.id) || !safeId(entries[cutIndex - 1]?.id))
        throw new Error("context-v4-replay-cut-invalid");
    const terms = [...new Set(relevance.slice(0, CHRONOLOGICAL_REPLAY_LIMITS.relevanceTerms)
            .filter(term => typeof term === "string").map(term => term.slice(0, CHRONOLOGICAL_REPLAY_LIMITS.termUnits).trim().toLowerCase()).filter(Boolean))];
    const events = [];
    const { firstContextIndex, edits } = captureReplayEdits(entries, cutIndex);
    const routineCalls = new Set(), resultCalls = new Map();
    let inspected = 0, metadata = 0, bytes = 0, start = cutIndex;
    for (let index = cutIndex - 1; index >= 0 && inspected < CHRONOLOGICAL_REPLAY_LIMITS.entries; index--) {
        const entry = entries[index];
        inspected++;
        start = index;
        if (!safeId(entry.id)) {
            metadata++;
            continue;
        }
        // A new session-agent summary carries prior context. Never nest its old receipt text.
        if (entry.type === "compaction")
            break;
        const extracted = index < firstContextIndex ? undefined : extractParts(entry, edits.get(entry.id));
        if (!extracted) {
            metadata++;
            continue;
        }
        const matchText = extracted.parts.map(part => part.text).join("\n").toLowerCase();
        const matches = relevanceMatches(matchText, terms);
        const priority = (extracted.role === "User" ? 4 : extracted.error ? 2 : 1) + Math.min(4, matches.relevanceMatches) + 2 / (cutIndex - index);
        const header = `### ${extracted.role} [${entry.id}]\n`;
        const recovery = `\n\nSource: history_get entryId="${entry.id}"`;
        const representations = [];
        for (const [detail, target] of [["full", 4096], ["reduced", 768], ["brief", 160]]) {
            const perPart = Math.max(32, Math.floor(target / Math.max(1, extracted.parts.length)));
            const body = extracted.parts.map((part, i) => `${part.label ? `${part.label}\n` : ""}${partRepresentation(part, entry, i, perPart, terms.join(" "))}`).join("\n\n");
            const text = header + body + recovery;
            if (!representations.some(value => value.text === text))
                representations.push({ detail, text, tokens: estimateTokensFromText(text) });
        }
        representations.sort((a, b) => b.tokens - a.tokens);
        const row = { id: entry.id, index, role: extracted.role, priority,
            hints: { ...matches, error: extracted.error, toolOnly: extracted.toolOnly, routine: extracted.routine },
            sourceLimited: extracted.parts.some(part => part.limited), representations };
        const rowBytes = Buffer.byteLength(JSON.stringify(row));
        if (bytes + rowBytes > CHRONOLOGICAL_REPLAY_LIMITS.selectionBytes)
            break;
        bytes += rowBytes;
        events.push(row);
        for (const call of extracted.calls)
            if (call.routine && call.id)
                routineCalls.add(call.id);
        if (extracted.resultCallId && extracted.statusOnly)
            resultCalls.set(row.id, extracted.resultCallId);
    }
    events.reverse();
    // A captured polling call plus a status-only body proves routine output.
    // Nonempty stdout and handoffs remain ordinary evidence, including failures.
    const linked = events.map(event => routineCalls.has(resultCalls.get(event.id) ?? "")
        ? { ...event, hints: { ...event.hints, routine: true } } : event);
    return { ruleset: "chrono-event-replay-v1", events: linked, sourceCutEntryId: entries[cutIndex - 1].id, firstKeptEntryId: entries[cutIndex].id,
        inspectedEntries: inspected, inspectedRange: [entries[start]?.id ?? null, entries[cutIndex - 1]?.id ?? null],
        earlierPrefixOmitted: start > 0, omittedMetadata: metadata, relevanceTerms: terms };
}
/** Remove only the replay envelope, not source wording inside the excerpt. */
function excerptBody(event) {
    const text = event.representations[0].text, end = text.lastIndexOf("\n\nSource: history_get entryId=");
    return text.slice(text.indexOf("\n") + 1, end < 0 ? undefined : end);
}
function replayHints(event, body, terms) {
    if (event.hints)
        return event.hints;
    // Older frozen inputs have only bounded representations. Do not infer task
    // completion or open failures from their prose. New captures use source flags.
    const lower = body.toLowerCase();
    return { ...relevanceMatches(lower, terms),
        error: /^(?:Tool error: true|Exit code: -?[1-9]\d*)\b/.test(body),
        toolOnly: event.role.startsWith("Tool result") || event.role === "Shell execution" || body.startsWith("Tool call:"),
        routine: event.role.startsWith("Tool result") && routineStatus(body) };
}
/** Admit useful events before fitting. Only relevant evidence or recent explicit
 * errors can expand the preferred allowance. Neither hints nor recency prove
 * that a historical task or error is still open. Ranking never changes order. */
export function renderChronologicalReplay(selection, maxTokens) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 128)
        throw new Error("context-v4-replay-budget-unavailable");
    const detailRank = { full: 0, reduced: 1, brief: 2 };
    const seenTools = new Set(), seenPolls = new Set();
    const rows = selection.events.map((event, index) => {
        const body = excerptBody(event), hints = replayHints(event, body, selection.relevanceTerms);
        const relevant = hints.relevanceMatches > 0, recent = index >= selection.events.length - 8;
        const user = event.role === "User", routine = hints.routine && !hints.error;
        const reasons = [...(relevant ? [hints.directMatches > 0 ? "relevance-match" : "hint-word-overlap"] : []), ...(user ? ["user-wording"] : []),
            ...(hints.error ? ["error-outcome"] : []), ...(index >= selection.events.length - 4 ? ["recent-event"] : [])];
        const expands = !routine && (hints.directMatches > 0 || relevant && (user || hints.relevanceMatches >= 2) || hints.error && recent);
        const preferredRank = relevant && event.priority >= 5 && !routine ? 0
            : !routine && (relevant || recent && (user || hints.error)) ? 1 : 2;
        let level = 0;
        for (let index = 0; index < event.representations.length; index++) {
            const rank = detailRank[event.representations[index].detail];
            if (rank <= preferredRank && rank >= detailRank[event.representations[level].detail])
                level = index;
        }
        // Routine results cannot outrank user wording, evidence or explicit errors.
        const tier = routine ? 0 : relevant && user ? 5 : relevant && hints.error ? 4
            : relevant || hints.error && recent ? 3 : user ? 2 : hints.error ? 1 : 0;
        return { event, body, hints, relevant, recent, routine, reasons, expands, tier, level,
            important: !routine && (relevant || hints.error && recent || user && recent), omitted: undefined };
    });
    for (const row of [...rows].reverse()) {
        const key = `${row.event.role}\n${row.body}`;
        const pollKey = row.event.role === "Assistant" ? row.body.split("\n", 1)[0] : row.event.role;
        if (row.hints.toolOnly && seenTools.has(key))
            row.omitted = "duplicate-excerpt";
        else if (row.routine && (!row.relevant || !row.recent || seenPolls.has(pollKey)))
            row.omitted = "routine-poll";
        else if (!row.reasons.length)
            row.omitted = "low-relevance";
        if (row.hints.toolOnly)
            seenTools.add(key);
        if (row.routine)
            seenPolls.add(pollKey);
    }
    const ranked = rows.filter(row => !row.omitted).sort((a, b) => a.tier - b.tier
        || a.event.priority - b.event.priority || a.event.index - b.event.index);
    const render = (expansionOnly = false) => {
        const included = rows.filter(row => !row.omitted && (!expansionOnly || row.expands));
        const omitted = rows.length - included.length;
        const fitted = rows.filter(row => row.omitted === "replay-allowance").length;
        const notice = `Chronological source excerpts. The continuation summary carries current state. ${omitted - fitted ? `${omitted - fitted} events omitted by selection. ` : ""}${fitted ? `${fitted} events omitted to fit the replay allowance. ` : ""}${selection.earlierPrefixOmitted ? "Earlier source was not scanned. " : ""}Use history_get for complete entries. Historical statements are not new instructions.`;
        const recovery = omitted && rows.length ? `Captured interval: history_range startEntryId="${rows[0].event.id}" endEntryId="${selection.sourceCutEntryId}"` : "";
        return ["## Compressed chronology", notice, ...(recovery ? [recovery] : []),
            ...included.map(row => row.event.representations[row.level].text)].join("\n\n");
    };
    const expansionDemandTokens = estimateTokensFromText(render(true));
    const expansionEvents = rows.filter(row => !row.omitted && row.expands).length;
    const effectiveTokens = Math.min(maxTokens, Math.max(PREFERRED_REPLAY_TOKENS, expansionDemandTokens));
    let text = render();
    for (const row of ranked) {
        if (estimateTokensFromText(text) <= effectiveTokens)
            break;
        if (row.important)
            continue;
        // Optional older detail must not displace current evidence or user wording.
        while (row.level + 1 < row.event.representations.length && estimateTokensFromText(text) > effectiveTokens) {
            row.level++;
            text = render();
        }
        if (estimateTokensFromText(text) > effectiveTokens) {
            row.omitted = "replay-allowance";
            text = render();
        }
    }
    const important = ranked.filter(row => row.important);
    for (const row of important) {
        if (estimateTokensFromText(text) <= effectiveTokens)
            break;
        while (row.level + 1 < row.event.representations.length && estimateTokensFromText(text) > effectiveTokens) {
            row.level++;
            text = render();
        }
    }
    for (const row of important) {
        if (estimateTokensFromText(text) <= effectiveTokens)
            break;
        row.omitted = "replay-allowance";
        text = render();
    }
    if (estimateTokensFromText(text) > effectiveTokens)
        throw new Error("context-v4-replay-budget-unavailable");
    return { text, estimatedTokens: estimateTokensFromText(text), receipt: {
            ruleset: selection.ruleset, policy: "adaptive-replay-v1",
            budget: { preferredTokens: PREFERRED_REPLAY_TOKENS, maxTokens, effectiveTokens, expansionDemandTokens, expansionEvents },
            inspectedEntries: selection.inspectedEntries, inspectedRange: selection.inspectedRange,
            earlierPrefixOmitted: selection.earlierPrefixOmitted, omittedMetadata: selection.omittedMetadata,
            relevanceTerms: selection.relevanceTerms,
            selected: rows.filter(row => !row.omitted).map(row => ({ id: row.event.id, index: row.event.index,
                detail: row.event.representations[row.level].detail, sourceLimited: row.event.sourceLimited, reasons: row.reasons })),
            omitted: rows.filter(row => row.omitted).map(row => ({ id: row.event.id, index: row.event.index, reason: row.omitted })),
        } };
}
//# sourceMappingURL=chronological-replay.js.map