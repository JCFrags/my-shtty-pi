import { compactWhitespace, estimateTokensFromText, getString, truncateToTokens, unique } from "./utils.js";
function turnRanges(units, blocksById) {
    const starts = [];
    units.forEach((unit, index) => {
        if (unit.kind === "user" || unit.kind === "custom_message")
            starts.push(index);
    });
    if (starts.length === 0 && units.length > 0)
        starts.push(0);
    const ranges = [];
    starts.forEach((start, index) => {
        const end = (starts[index + 1] ?? units.length) - 1;
        if (end < start)
            return;
        const slice = units.slice(start, end + 1);
        const rawTokens = slice.reduce((sum, unit) => sum + unit.rawTokens, 0);
        const completed = slice.some((unit) => {
            if (unit.kind !== "assistant_text")
                return false;
            const block = blocksById.get(unit.id);
            return getString(block?.attributes.phase) === "final" && block?.unresolved !== true;
        });
        const mergeable = slice.every((unit) => !unit.protectedExact);
        ranges.push({ start, end, rawTokens, completed, mergeable });
    });
    return ranges;
}
function bestCompactCandidate(unit) {
    const candidates = [...unit.candidates].filter((candidate) => candidate.level !== "absent");
    return (candidates.find((candidate) => candidate.level === "reduced" || candidate.level === "semantic") ??
        candidates.find((candidate) => candidate.level === "normalized") ??
        candidates[0] ??
        unit.candidates[0]);
}
function episodeBody(units, config) {
    const request = units.find((unit) => unit.kind === "user" || unit.kind === "custom_message");
    const finals = units.filter((unit) => unit.kind === "assistant_text");
    const final = finals[finals.length - 1];
    const sequence = [];
    for (const unit of units) {
        const selected = bestCompactCandidate(unit);
        if (unit.kind === "user" || unit.kind === "custom_message")
            continue;
        if (unit.kind === "assistant_reasoning") {
            sequence.push(`- Assistant reasoning: ${truncateToTokens(selected.text, 55, "…")}`);
        }
        else if (unit.kind === "tool_call") {
            sequence.push(`- Tool call: ${truncateToTokens(selected.text, 65, "…")}`);
        }
        else if (unit.kind === "tool_result" || unit.kind === "bash_execution") {
            const blockError = selected.metadata.isError === true || /(?:exit code:\s*[1-9]|\bfailed\b|\berror\b)/i.test(selected.text);
            sequence.push(`- Tool result${blockError ? " (failure/evidence)" : ""}: ${truncateToTokens(selected.text, blockError ? 85 : 50, "…")}`);
        }
        else if (unit.kind === "assistant_text" && unit !== final) {
            sequence.push(`- Assistant text: ${truncateToTokens(selected.text, 45, "…")}`);
        }
        if (sequence.length >= 22)
            break;
    }
    const parts = [];
    if (request)
        parts.push(`Request:\n${truncateToTokens(bestCompactCandidate(request).text, 120, "…")}`);
    if (sequence.length > 0)
        parts.push(`Sequence:\n${sequence.join("\n")}`);
    if (final)
        parts.push(`Result / last assistant state:\n${truncateToTokens(bestCompactCandidate(final).text, 120, "…")}`);
    return truncateToTokens(parts.join("\n\n"), config.maxEpisodeTokens, "\n…[additional episode steps omitted]…\n");
}
function makeEpisode(units, config) {
    const first = units[0];
    const last = units[units.length - 1];
    const sourceRefs = units.flatMap((unit) => unit.sourceRefs);
    const rawTokens = units.reduce((sum, unit) => sum + unit.rawTokens, 0);
    const body = episodeBody(units, config);
    const omissions = [
        {
            description: `${units.length} contiguous historical block(s) merged into one chronological task episode`,
        },
    ];
    const merged = {
        id: `episode:${first.id}:${last.id}:merged`,
        level: "merged",
        text: body,
        tokens: estimateTokensFromText(body),
        rawTokens,
        utility: 0.68,
        lossy: true,
        reducer: "task-episode",
        reducerVersion: "1.0.0",
        omissions,
        sourceRefs,
        metadata: { unitCount: units.length },
    };
    const markerText = `Completed historical task episode spanning ${first.sourceRefs[0]?.entryId ?? "?"}–${last.sourceRefs[last.sourceRefs.length - 1]?.entryId ?? "?"}. Detailed chronological steps omitted; exact range remains recoverable.`;
    const marker = {
        id: `episode:${first.id}:${last.id}:marker`,
        level: "marker",
        text: markerText,
        tokens: estimateTokensFromText(markerText),
        rawTokens,
        utility: 0.2,
        lossy: true,
        reducer: "task-episode-marker",
        reducerVersion: "1.0.0",
        omissions: [{ description: "Episode reduced to a historical range marker" }],
        sourceRefs,
        metadata: { unitCount: units.length },
    };
    return {
        id: `episode:${first.id}:${last.id}`,
        kind: "episode",
        label: "TASK EPISODE",
        startEntryIndex: first.startEntryIndex,
        endEntryIndex: last.endEntryIndex,
        sourceRefs,
        rawTokens,
        importance: Math.max(...units.map((unit) => unit.importance)) * 0.82,
        importanceReasons: unique(units.flatMap((unit) => unit.importanceReasons)),
        protectedExact: false,
        candidates: [marker, merged],
        toolCallIds: unique(units.flatMap((unit) => unit.toolCallIds)),
    };
}
function routineSegmentProtected(unit) {
    if (unit.protectedExact || unit.kind === "user" || unit.kind === "custom_message" || unit.kind === "assistant_text" || unit.kind === "episode")
        return true;
    return false;
}
function makeRoutineSegment(units, config, blocksByEntry) {
    const first = units[0];
    const last = units[units.length - 1];
    const sourceRefs = units.flatMap((unit) => unit.sourceRefs);
    const rawTokens = units.reduce((sum, unit) => sum + unit.rawTokens, 0);
    const sequence = units.map((unit) => {
        const selected = bestCompactCandidate(unit);
        return `- ${unit.label}: ${truncateToTokens(compactWhitespace(selected.text), 36, "…")}`;
    });
    const body = truncateToTokens(sequence.join("\n"), Math.min(config.maxEpisodeTokens, Math.max(100, units.length * 18)), "\n…[additional routine activity omitted]…\n");
    const omissions = [
        { description: "Routine details omitted." },
    ];
    const merged = {
        id: `activity:${first.id}:${last.id}:merged`,
        level: "merged",
        text: body,
        tokens: estimateTokensFromText(body),
        rawTokens,
        utility: 0.58,
        lossy: true,
        reducer: "routine-activity-segment",
        reducerVersion: "1.0.0",
        omissions,
        sourceRefs,
        metadata: { unitCount: units.length },
    };
    const failureLines = units.flatMap((unit) => {
        const failed = unit.sourceRefs.some((ref) => (blocksByEntry.get(ref.entryId) ?? []).some((block) => block.isError === true));
        if (!failed)
            return [];
        const entryId = unit.sourceRefs[0]?.entryId ?? "?";
        return [`- ${entryId}: ${truncateToTokens(compactWhitespace(bestCompactCandidate(unit).text), 12, "…")}`];
    });
    const markerText = [
        `Routine activity: ${units.length} blocks compacted.`,
        ...(failureLines.length > 0 ? ["Retained failure evidence:", ...failureLines] : []),
    ].join("\n");
    const marker = {
        id: `activity:${first.id}:${last.id}:marker`,
        level: "marker",
        text: markerText,
        tokens: estimateTokensFromText(markerText),
        rawTokens,
        utility: 0.16,
        lossy: true,
        reducer: "routine-activity-segment-marker",
        reducerVersion: "1.0.0",
        omissions,
        sourceRefs,
        metadata: { unitCount: units.length },
    };
    return {
        id: `activity:${first.id}:${last.id}`,
        kind: "episode",
        label: "ACTIVITY SEGMENT",
        startEntryIndex: first.startEntryIndex,
        endEntryIndex: last.endEntryIndex,
        sourceRefs,
        rawTokens,
        importance: Math.max(...units.map((unit) => unit.importance)) * 0.72,
        importanceReasons: unique(units.flatMap((unit) => unit.importanceReasons)),
        protectedExact: false,
        candidates: [marker, merged],
        toolCallIds: unique(units.flatMap((unit) => unit.toolCallIds)),
    };
}
/**
 * Reduce structural per-event overhead when a long unfinished task contains
 * hundreds of routine reasoning/tool blocks. Protected evidence remains as
 * individual units and each collapsed range remains exactly retrievable.
 */
export function mergeRoutineActivitySegments(units, blocks, config, targetTokens) {
    const desiredUnits = Math.max(40, Math.min(config.maxIndividualUnits, Math.floor(targetTokens / 200)));
    if (units.length <= desiredUnits)
        return [...units];
    const blocksByEntry = new Map();
    for (const block of blocks) {
        const existing = blocksByEntry.get(block.entryId) ?? [];
        existing.push(block);
        blocksByEntry.set(block.entryId, existing);
    }
    const recentStart = Math.max(0, units.length - Math.max(24, Math.floor(desiredUnits * 0.15)));
    const mergeableCount = units.reduce((count, unit, index) => count + (index < recentStart && !routineSegmentProtected(unit) ? 1 : 0), 0);
    const protectedCount = units.length - mergeableCount;
    const desiredSegments = Math.max(12, desiredUnits - Math.min(protectedCount, Math.floor(desiredUnits * 0.7)));
    const chunkSize = Math.max(3, Math.ceil(mergeableCount / desiredSegments));
    const output = [];
    let pending = [];
    const flush = () => {
        if (pending.length >= 2)
            output.push(makeRoutineSegment(pending, config, blocksByEntry));
        else
            output.push(...pending);
        pending = [];
    };
    units.forEach((unit, index) => {
        const mergeable = index < recentStart && !routineSegmentProtected(unit);
        if (!mergeable) {
            flush();
            output.push(unit);
            return;
        }
        pending.push(unit);
        if (pending.length >= chunkSize)
            flush();
    });
    flush();
    return output;
}
export function mergeOldCompletedEpisodes(units, blocks, config) {
    if (!config.mergeEpisodes || units.length === 0)
        return [...units];
    const blocksById = new Map(blocks.map((block) => [block.id, block]));
    const ranges = turnRanges(units, blocksById);
    const eligibleLimit = Math.floor(units.length * config.mergeBeforeFraction);
    const output = [];
    let cursor = 0;
    let rangeIndex = 0;
    while (rangeIndex < ranges.length) {
        const range = ranges[rangeIndex];
        if (range.start < cursor) {
            rangeIndex += 1;
            continue;
        }
        while (cursor < range.start)
            output.push(units[cursor++]);
        if (!range.completed || !range.mergeable || range.end >= eligibleLimit) {
            while (cursor <= range.end)
                output.push(units[cursor++]);
            rangeIndex += 1;
            continue;
        }
        let groupEndRange = rangeIndex;
        let rawTokens = 0;
        let unitCount = 0;
        while (groupEndRange < ranges.length && groupEndRange < rangeIndex + 6) {
            const candidateRange = ranges[groupEndRange];
            if (!candidateRange.completed || !candidateRange.mergeable || candidateRange.end >= eligibleLimit || candidateRange.start !== (ranges[groupEndRange - 1]?.end ?? range.start - 1) + 1) {
                break;
            }
            rawTokens += candidateRange.rawTokens;
            unitCount += candidateRange.end - candidateRange.start + 1;
            groupEndRange += 1;
            if (rawTokens >= config.minEpisodeRawTokens && unitCount >= 6)
                break;
        }
        if (rawTokens >= config.minEpisodeRawTokens && unitCount >= 6) {
            const groupEnd = ranges[groupEndRange - 1].end;
            output.push(makeEpisode(units.slice(range.start, groupEnd + 1), config));
            cursor = groupEnd + 1;
            rangeIndex = groupEndRange;
        }
        else {
            while (cursor <= range.end)
                output.push(units[cursor++]);
            rangeIndex += 1;
        }
    }
    while (cursor < units.length)
        output.push(units[cursor++]);
    return output;
}
//# sourceMappingURL=episodes.js.map