import { CAPSULE_LIMITS, isSourceBlockReducerInput } from "./capsule-contract.js";
import { CAPSULE_REDUCER_FAMILY_VERSIONS, buildReducerEnvelope, extractProtectedCues, } from "./capsule-reducer.js";
const HEAD_UNITS = 4 * 1024;
const TAIL_UNITS = 4 * 1024;
const SCAN_OVERLAP_UNITS = 256;
const MAX_PROTECTED_CUES = 16;
const MAX_PROTECTED_CUE_UNITS = 2 * 1024;
const MAX_COMPLEMENT_RANGES = 20;
function span(start, text) {
    return { decodedUtf16: { start, end: start + text.length }, text };
}
function sameCue(a, b) {
    return a.kind === b.kind && a.decodedUtf16.start === b.decodedUtf16.start && a.decodedUtf16.end === b.decodedUtf16.end;
}
export function beginCapsuleReduction(base, options) {
    const emptyWindow = {
        ...base,
        window: {
            decodedUtf16: { start: base.source.decodedUtf16.start, end: base.source.decodedUtf16.start },
            text: "",
            completeBody: base.source.decodedUtf16.start === base.source.decodedUtf16.end,
            omittedBeforeUnits: 0,
            omittedAfterUnits: base.source.decodedUtf16.end - base.source.decodedUtf16.start,
        },
    };
    if (!isSourceBlockReducerInput(emptyWindow) || base.source.decodedUtf16.start !== 0
        || options.familyVersion !== CAPSULE_REDUCER_FAMILY_VERSIONS[options.family]
        || options.reducerSetVersion !== base.identity.reducerSetVersion || options.configHash !== base.identity.configHash) {
        throw new Error("capsule-stream-invalid-base");
    }
    return {
        v: 1,
        base,
        options,
        nextDecodedOffset: base.source.decodedUtf16.start,
        head: [],
        tail: [],
        protectedCues: [],
        omissions: [],
        complete: base.source.decodedUtf16.start === base.source.decodedUtf16.end,
        scanCarry: "",
        scanCarryStart: base.source.decodedUtf16.start,
        scanSettledOffset: base.source.decodedUtf16.start,
        protectedCueUnits: 0,
        protectedCueOverflow: 0,
    };
}
export function feedCapsuleReduction(state, feed) {
    if (state.complete || feed.text.length > CAPSULE_LIMITS.decodedChunkUnits
        || feed.decodedUtf16.start !== state.nextDecodedOffset
        || feed.decodedUtf16.end !== feed.decodedUtf16.start + feed.text.length
        || feed.decodedUtf16.end > state.base.source.decodedUtf16.end) {
        throw new Error("capsule-stream-noncontiguous-feed");
    }
    if (feed.text.length === 0)
        throw new Error("capsule-stream-empty-feed");
    const oldHead = state.head.map((item) => item.text).join("");
    const remainingHead = Math.max(0, HEAD_UNITS - oldHead.length);
    const addedHead = feed.text.slice(0, remainingHead);
    const headText = oldHead + addedHead;
    const head = headText.length === 0 ? [] : [span(state.base.source.decodedUtf16.start, headText)];
    const oldTail = state.tail.map((item) => item.text).join("");
    const combinedTail = oldTail + feed.text;
    const tailText = combinedTail.slice(-TAIL_UNITS);
    const tailStart = feed.decodedUtf16.end - tailText.length;
    const tail = tailText.length === 0 ? [] : [span(tailStart, tailText)];
    const scanned = state.scanCarry + feed.text;
    const feedCompletesBody = feed.decodedUtf16.end === state.base.source.decodedUtf16.end;
    const candidates = extractProtectedCues(scanned, state.scanCarryStart, state.base.source)
        .filter((cue) => cue.decodedUtf16.end > state.scanSettledOffset)
        // A word/identifier ending exactly at a non-final feed boundary may only be
        // a prefix. Keep it in the bounded overlap and accept it after a delimiter
        // or the exact body end settles the match.
        .filter((cue) => feedCompletesBody || cue.decodedUtf16.end < feed.decodedUtf16.end)
        .filter((cue) => !state.protectedCues.some((old) => sameCue(old, cue)));
    const protectedCues = [...state.protectedCues];
    let cueUnits = state.protectedCueUnits;
    let overflow = state.protectedCueOverflow;
    for (const cue of candidates) {
        if (protectedCues.length >= MAX_PROTECTED_CUES || cueUnits + cue.exactText.length > MAX_PROTECTED_CUE_UNITS) {
            overflow += 1;
            continue;
        }
        protectedCues.push(cue);
        cueUnits += cue.exactText.length;
    }
    protectedCues.sort((a, b) => a.decodedUtf16.start - b.decodedUtf16.start
        || a.decodedUtf16.end - b.decodedUtf16.end || a.kind.localeCompare(b.kind));
    const carry = scanned.slice(-SCAN_OVERLAP_UNITS);
    const next = feed.decodedUtf16.end;
    return {
        ...state,
        nextDecodedOffset: next,
        head,
        tail,
        protectedCues,
        complete: next === state.base.source.decodedUtf16.end,
        scanCarry: carry,
        scanCarryStart: next - carry.length,
        scanSettledOffset: feedCompletesBody ? next : Math.max(state.scanSettledOffset, next - 1),
        protectedCueUnits: cueUnits,
        protectedCueOverflow: overflow,
    };
}
function mergeRanges(ranges) {
    const sorted = [...ranges].filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const item of sorted) {
        const previous = merged.at(-1);
        if (previous !== undefined && item.start <= previous.end) {
            merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, item.end) };
        }
        else
            merged.push(item);
    }
    return merged;
}
function complementOmissions(state, selected) {
    const omissions = [];
    let cursor = state.base.source.decodedUtf16.start;
    const merged = mergeRanges(selected);
    for (const range of merged) {
        if (range.start > cursor) {
            omissions.push({
                kind: "exact-range",
                reason: "middle",
                source: state.base.source,
                decodedUtf16: { start: cursor, end: range.start },
                omittedUnits: range.start - cursor,
                description: "Unselected streamed source interval; exact source remains recoverable.",
            });
        }
        cursor = Math.max(cursor, range.end);
    }
    if (cursor < state.base.source.decodedUtf16.end) {
        omissions.push({
            kind: "exact-range",
            reason: "middle",
            source: state.base.source,
            decodedUtf16: { start: cursor, end: state.base.source.decodedUtf16.end },
            omittedUnits: state.base.source.decodedUtf16.end - cursor,
            description: "Unselected streamed source interval; exact source remains recoverable.",
        });
    }
    if (omissions.length > MAX_COMPLEMENT_RANGES)
        throw new Error("capsule-stream-complement-bound");
    if (state.protectedCueOverflow > 0) {
        if (omissions.length > 0) {
            const last = omissions.at(-1);
            omissions[omissions.length - 1] = {
                ...last,
                description: `${last.description} ${state.protectedCueOverflow} additional protected-cue match(es) exceeded the fixed cue budget.`,
            };
        }
        else {
            omissions.push({
                kind: "transformation-loss",
                reason: "budget",
                affectedSource: state.base.source,
                affectedDecodedUtf16: state.base.source.decodedUtf16,
                omittedUnits: "unknown",
                description: `${state.protectedCueOverflow} additional protected-cue match(es) exceeded the fixed cue budget.`,
            });
        }
    }
    return omissions;
}
export function finalizeCapsuleReduction(state) {
    if (!state.complete || state.nextDecodedOffset !== state.base.source.decodedUtf16.end) {
        throw new Error("capsule-stream-incomplete");
    }
    const head = state.head.map((item) => item.text).join("");
    const tailItem = state.tail[0];
    const headEnd = state.base.source.decodedUtf16.start + head.length;
    const tail = tailItem !== undefined && tailItem.decodedUtf16.start >= headEnd ? tailItem.text : "";
    const cueText = state.protectedCues
        .filter((cue) => cue.decodedUtf16.start >= headEnd && (tailItem === undefined || cue.decodedUtf16.end <= tailItem.decodedUtf16.start))
        .map((cue) => cue.exactText);
    const parts = [head];
    if (cueText.length > 0)
        parts.push("\n…[streamed middle; protected exact cues follow]…\n", cueText.join("\n"));
    if (tail.length > 0)
        parts.push("\n…[streamed middle omitted]…\n", tail);
    const selectedRanges = [
        ...state.head.map((item) => item.decodedUtf16),
        ...state.tail.map((item) => item.decodedUtf16),
        ...state.protectedCues.map((cue) => cue.decodedUtf16),
    ];
    const selected = {
        text: parts.join(""),
        decodedUtf16: state.base.source.decodedUtf16,
        protectedCues: state.protectedCues,
        omissions: complementOmissions(state, selectedRanges),
        completeBody: false,
    };
    return buildReducerEnvelope(state.base, state.options, selected);
}
//# sourceMappingURL=capsule-reducer-stream.js.map