import { CAPSULE_LIMITS, isSourceBlockReducerInput } from "./capsule-contract.js";
import { CAPSULE_REDUCER_FAMILY_VERSIONS, buildReducerEnvelope, extractProtectedCues, } from "./capsule-reducer.js";
const HEAD_UNITS = 4 * 1024;
const TAIL_UNITS = 4 * 1024;
const ORDINARY_MAX_MATCH_UNITS = 256;
const ORDINARY_BOUNDARY_LOOKAHEAD_UNITS = 1;
const NEIGHBORHOOD_SIDE_UNITS = 128;
// A start before this frontier is settled only after the scanner contains the
// longest supported match and its complete right neighborhood. The retained
// scan also keeps the exact left neighborhood. Thus pending ordinary matches
// start inside retained text and are reconstructed, not serialized.
const ORDINARY_UNSETTLED_UNITS = ORDINARY_MAX_MATCH_UNITS
    + Math.max(ORDINARY_BOUNDARY_LOOKAHEAD_UNITS, NEIGHBORHOOD_SIDE_UNITS);
const RETAINED_SCAN_UNITS = ORDINARY_UNSETTLED_UNITS + NEIGHBORHOOD_SIDE_UNITS;
const MAX_PROTECTED_CUES = 16;
const MAX_PROTECTED_CUE_UNITS = 2 * 1024;
const MAX_NEIGHBORHOODS = 16;
const MAX_NEIGHBORHOOD_UNITS = 4 * 1024;
const MAX_FAILURE_WHITESPACE = 512;
const MAX_FAILURE_DIGITS = 32;
const MAX_COMPLEMENT_RANGES = 20;
const FAILURE_LITERAL = "exit code";
const OVERLONG_IDENTIFIER = /(?:https?:\/\/[^\s)\]}>"']{241}|(?:\.{0,2}\/|~\/)[A-Za-z0-9_.@+\-/]{241})/gu;
function span(start, text) {
    return { decodedUtf16: { start, end: start + text.length }, text };
}
function idleFailure(previousWord = false, pendingHighSurrogate = null) {
    return { stage: "idle", start: 0, literalIndex: 0, whitespace: 0, digits: 0, text: "", previousWord, pendingHighSurrogate };
}
function word(character) { return /[\p{L}\p{N}_]/u.test(character); }
function sameCue(a, b) {
    return a.kind === b.kind && a.decodedUtf16.start === b.decodedUtf16.start && a.decodedUtf16.end === b.decodedUtf16.end;
}
function sentenceBoundary(character) { return character === "\n" || character === "\r" || character === "." || character === "!" || character === "?"; }
export function beginCapsuleReduction(base, options) {
    const emptyWindow = { ...base, window: { decodedUtf16: { start: base.source.decodedUtf16.start, end: base.source.decodedUtf16.start }, text: "",
            completeBody: base.source.decodedUtf16.start === base.source.decodedUtf16.end, omittedBeforeUnits: 0,
            omittedAfterUnits: base.source.decodedUtf16.end - base.source.decodedUtf16.start } };
    if (!isSourceBlockReducerInput(emptyWindow) || base.source.decodedUtf16.start !== 0
        || options.familyVersion !== CAPSULE_REDUCER_FAMILY_VERSIONS[options.family]
        || options.reducerSetVersion !== base.identity.reducerSetVersion || options.configHash !== base.identity.configHash)
        throw new Error("capsule-stream-invalid-base");
    return { v: 4, base, options, nextDecodedOffset: base.source.decodedUtf16.start, head: [], tail: [], protectedCues: [], omissions: [],
        complete: base.source.decodedUtf16.start === base.source.decodedUtf16.end, scanCarry: "", scanCarryStart: base.source.decodedUtf16.start,
        scanSettledOffset: base.source.decodedUtf16.start, protectedCueUnits: 0, protectedCueOverflow: 0, protectedNeighborhoods: [],
        protectedNeighborhoodUnits: 0, lexicalOverflow: 0, pendingProtectedCues: [], failureGrammar: idleFailure() };
}
function scanFailureGrammar(prior, feed, complete, source) {
    let state = prior;
    const cues = [];
    let overflow = 0;
    const settle = () => {
        if (state.stage === "digits")
            cues.push({ kind: "failure", source, decodedUtf16: { start: state.start, end: state.start + state.text.length }, exactText: state.text });
        state = idleFailure(false);
    };
    const consume = (character, absolute) => {
        if (state.stage === "idle") {
            if (!state.previousWord && character.toLocaleLowerCase() === "e") {
                state = { stage: "literal", start: absolute, literalIndex: 1, whitespace: 0, digits: 0, text: character, previousWord: false, pendingHighSurrogate: null };
            }
            else
                state = idleFailure(word(character));
            return;
        }
        if (state.stage === "literal") {
            if (character.toLocaleLowerCase() === FAILURE_LITERAL[state.literalIndex]) {
                const nextIndex = state.literalIndex + 1;
                state = { ...state, literalIndex: nextIndex, text: state.text + character, stage: nextIndex === FAILURE_LITERAL.length ? "space" : "literal" };
                return;
            }
            // A malformed partial literal remains lexical context. In particular,
            // the second 'e' in "eexit" cannot start a fresh boundary match.
            state = idleFailure(word(character));
            return;
        }
        if (state.stage === "space") {
            if (/\s/u.test(character)) {
                if (state.whitespace === MAX_FAILURE_WHITESPACE) {
                    overflow += 1;
                    state = idleFailure(word(character));
                    return;
                }
                state = { ...state, whitespace: state.whitespace + 1, text: state.text + character };
                return;
            }
            if (/[1-9]/u.test(character)) {
                state = { ...state, stage: "digits", digits: 1, text: state.text + character };
                return;
            }
            state = idleFailure(word(character));
            return;
        }
        if (/[0-9]/u.test(character)) {
            if (state.digits === MAX_FAILURE_DIGITS) {
                overflow += 1;
                state = idleFailure(true);
                return;
            }
            state = { ...state, digits: state.digits + 1, text: state.text + character };
            return;
        }
        if (word(character)) {
            state = idleFailure(true);
            return;
        }
        settle();
        consume(character, absolute);
    };
    let index = 0;
    const pending = state.pendingHighSurrogate;
    if (pending) {
        state = { ...state, pendingHighSurrogate: null };
        const first = feed.text[0];
        if (first !== undefined && /[\udc00-\udfff]/u.test(first)) {
            consume(pending.unit + first, pending.start);
            index = 1;
        }
        else
            consume(pending.unit, pending.start);
    }
    while (index < feed.text.length) {
        const unit = feed.text[index];
        const absolute = feed.decodedUtf16.start + index;
        if (/[\ud800-\udbff]/u.test(unit)) {
            const next = feed.text[index + 1];
            if (next !== undefined && /[\udc00-\udfff]/u.test(next)) {
                consume(unit + next, absolute);
                index += 2;
                continue;
            }
            if (next === undefined && !complete) {
                state = { ...state, pendingHighSurrogate: { unit, start: absolute } };
                index += 1;
                continue;
            }
        }
        consume(unit, absolute);
        index += 1;
    }
    if (complete) {
        const trailing = state.pendingHighSurrogate;
        if (trailing) {
            state = { ...state, pendingHighSurrogate: null };
            consume(trailing.unit, trailing.start);
        }
        settle();
    }
    return { state, cues, overflow };
}
function addNeighborhoods(prior, scanned, scannedStart, feed, cues) {
    const next = prior.map(item => ({ ...item, decodedUtf16: { ...item.decodedUtf16 } }));
    for (let index = 0; index < next.length; index += 1) {
        const item = next[index];
        if (item.closed || item.decodedUtf16.end >= item.targetEnd || item.decodedUtf16.end >= feed.decodedUtf16.end)
            continue;
        const from = Math.max(item.decodedUtf16.end, feed.decodedUtf16.start);
        const available = feed.text.slice(from - feed.decodedUtf16.start, item.targetEnd - feed.decodedUtf16.start);
        let take = available.length;
        for (let at = 0; at < available.length; at += 1)
            if (sentenceBoundary(available[at])) {
                take = at + 1;
                break;
            }
        const added = available.slice(0, take);
        next[index] = { ...item, text: item.text + added, decodedUtf16: { start: item.decodedUtf16.start, end: item.decodedUtf16.end + added.length },
            closed: take < available.length || sentenceBoundary(added.at(-1) ?? "") || item.decodedUtf16.end + added.length >= item.targetEnd };
    }
    for (const cue of cues) {
        if (next.some(item => cue.decodedUtf16.start >= item.decodedUtf16.start
            && cue.decodedUtf16.end <= (item.closed ? item.decodedUtf16.end : item.targetEnd)))
            continue;
        const local = cue.decodedUtf16.start - scannedStart;
        let start = Math.max(0, local - NEIGHBORHOOD_SIDE_UNITS);
        for (let at = local - 1; at >= start; at -= 1)
            if (sentenceBoundary(scanned[at])) {
                start = at + 1;
                break;
            }
        let end = Math.min(scanned.length, cue.decodedUtf16.end - scannedStart + NEIGHBORHOOD_SIDE_UNITS);
        let closed = false;
        for (let at = cue.decodedUtf16.end - scannedStart; at < end; at += 1)
            if (sentenceBoundary(scanned[at])) {
                end = at + 1;
                closed = true;
                break;
            }
        const text = scanned.slice(start, end);
        next.push({ decodedUtf16: { start: scannedStart + start, end: scannedStart + end }, text,
            targetEnd: cue.decodedUtf16.end + NEIGHBORHOOD_SIDE_UNITS, closed });
    }
    return next.sort((a, b) => a.decodedUtf16.start - b.decodedUtf16.start || a.decodedUtf16.end - b.decodedUtf16.end);
}
export function feedCapsuleReduction(state, feed) {
    if (state.v !== 4 || state.complete || feed.text.length > CAPSULE_LIMITS.decodedChunkUnits || feed.decodedUtf16.start !== state.nextDecodedOffset
        || feed.decodedUtf16.end !== feed.decodedUtf16.start + feed.text.length || feed.decodedUtf16.end > state.base.source.decodedUtf16.end)
        throw new Error("capsule-stream-noncontiguous-feed");
    if (feed.text.length === 0)
        throw new Error("capsule-stream-empty-feed");
    const oldHead = state.head.map(item => item.text).join("");
    const headText = oldHead + feed.text.slice(0, Math.max(0, HEAD_UNITS - oldHead.length));
    const head = headText.length === 0 ? [] : [span(state.base.source.decodedUtf16.start, headText)];
    const combinedTail = state.tail.map(item => item.text).join("") + feed.text;
    const tailText = combinedTail.slice(-TAIL_UNITS);
    const tail = tailText.length === 0 ? [] : [span(feed.decodedUtf16.end - tailText.length, tailText)];
    const scanned = state.scanCarry + feed.text;
    const scannedStart = state.scanCarryStart;
    const completes = feed.decodedUtf16.end === state.base.source.decodedUtf16.end;
    // Batch ordinary bounded-regex work. One-unit feeds accumulate before a scan,
    // so work remains proportional to appended units rather than rescanning the
    // complete overlap after every unit. The explicit failure grammar is below.
    const shouldScan = completes || scanned.length >= ORDINARY_UNSETTLED_UNITS * 2;
    const settledThrough = completes ? feed.decodedUtf16.end : scannedStart + Math.max(0, scanned.length - ORDINARY_UNSETTLED_UNITS);
    const observedOrdinary = shouldScan ? extractProtectedCues(scanned, scannedStart, state.base.source) : [];
    const ordinary = observedOrdinary
        .filter(cue => cue.decodedUtf16.start >= state.scanSettledOffset && cue.decodedUtf16.start < settledThrough)
        // This grammar has explicit carry and over-limit behavior below; accepting
        // the regex copy would make neighborhoods depend on feed size.
        .filter(cue => !(cue.kind === "failure" && /^exit code/iu.test(cue.exactText)));
    OVERLONG_IDENTIFIER.lastIndex = 0;
    const observedOverflowStarts = shouldScan ? [...scanned.matchAll(OVERLONG_IDENTIFIER)].map(match => scannedStart + (match.index ?? 0)).filter(start => start >= state.scanSettledOffset && start < settledThrough) : [];
    const grammar = scanFailureGrammar(state.failureGrammar, feed, completes, state.base.source);
    const nextSettledOffset = shouldScan ? Math.max(state.scanSettledOffset, settledThrough) : state.scanSettledOffset;
    const identifierOverflow = new Set(observedOverflowStarts).size;
    const ordered = [...state.pendingProtectedCues, ...ordinary, ...grammar.cues]
        .filter(cue => !state.protectedCues.some(old => sameCue(old, cue)))
        .sort((a, b) => a.decodedUtf16.start - b.decodedUtf16.start || a.decodedUtf16.end - b.decodedUtf16.end || a.kind.localeCompare(b.kind));
    const unique = ordered.filter((cue, index) => index === 0 || !sameCue(ordered[index - 1], cue));
    // No cue reaches the cap until its start is behind the ordinary scanner's
    // frontier and the incremental scanner has completed it. This makes one
    // source-ordered admission decision independent of feeds and restarts.
    const candidates = unique.filter(cue => cue.decodedUtf16.start < nextSettledOffset);
    const pendingProtectedCues = unique.filter(cue => cue.decodedUtf16.start >= nextSettledOffset);
    const protectedCues = [...state.protectedCues];
    let cueUnits = state.protectedCueUnits, overflow = state.protectedCueOverflow;
    for (const cue of candidates) {
        if (protectedCues.some(old => sameCue(old, cue)))
            continue;
        if (protectedCues.length >= MAX_PROTECTED_CUES || cueUnits + cue.exactText.length > MAX_PROTECTED_CUE_UNITS) {
            overflow += 1;
            continue;
        }
        protectedCues.push(cue);
        cueUnits += cue.exactText.length;
    }
    protectedCues.sort((a, b) => a.decodedUtf16.start - b.decodedUtf16.start || a.decodedUtf16.end - b.decodedUtf16.end || a.kind.localeCompare(b.kind));
    const neighborhoodCandidates = candidates.filter(cue => !(cue.kind === "failure" && /^exit code/iu.test(cue.exactText)));
    let neighborhoods = addNeighborhoods(state.protectedNeighborhoods, scanned, scannedStart, feed, neighborhoodCandidates);
    let neighborhoodUnits = neighborhoods.reduce((sum, item) => sum + item.text.length, 0);
    while (neighborhoods.length > MAX_NEIGHBORHOODS || neighborhoodUnits > MAX_NEIGHBORHOOD_UNITS) {
        const removed = neighborhoods.pop();
        neighborhoodUnits -= removed.text.length;
        overflow += 1;
    }
    // Keep the unsettled suffix plus its left-neighborhood allowance. A pending
    // ordinary candidate therefore remains reconstructible with exact context.
    const carry = shouldScan ? scanned.slice(-RETAINED_SCAN_UNITS) : scanned, next = feed.decodedUtf16.end;
    return { ...state, nextDecodedOffset: next, head, tail, protectedCues, complete: next === state.base.source.decodedUtf16.end,
        scanCarry: carry, scanCarryStart: next - carry.length,
        scanSettledOffset: nextSettledOffset,
        protectedCueUnits: cueUnits, protectedCueOverflow: overflow, protectedNeighborhoods: neighborhoods,
        protectedNeighborhoodUnits: neighborhoodUnits, pendingProtectedCues,
        lexicalOverflow: state.lexicalOverflow + grammar.overflow + identifierOverflow, failureGrammar: grammar.state };
}
function mergeExactSpans(items) {
    const sorted = [...items].filter(item => item.text.length > 0 && item.decodedUtf16.end > item.decodedUtf16.start)
        .sort((a, b) => a.decodedUtf16.start - b.decodedUtf16.start || a.decodedUtf16.end - b.decodedUtf16.end);
    const merged = [];
    for (const item of sorted) {
        const previous = merged.at(-1);
        if (!previous || item.decodedUtf16.start > previous.decodedUtf16.end) {
            merged.push(item);
            continue;
        }
        if (item.decodedUtf16.end <= previous.decodedUtf16.end)
            continue;
        const overlap = previous.decodedUtf16.end - item.decodedUtf16.start;
        merged[merged.length - 1] = { decodedUtf16: { start: previous.decodedUtf16.start, end: item.decodedUtf16.end }, text: previous.text + item.text.slice(overlap) };
    }
    return merged;
}
function renderSpans(spans) {
    let text = "";
    const coverage = [];
    for (let index = 0; index < spans.length; index += 1) {
        const item = spans[index];
        const previous = spans[index - 1];
        if (previous && item.decodedUtf16.start > previous.decodedUtf16.end)
            text += "\n…[streamed source interval omitted]…\n";
        const outputStart = text.length;
        text += item.text;
        coverage.push({ source: item.decodedUtf16, output: { start: outputStart, end: text.length } });
    }
    return { text, coverage };
}
export function finalizeCapsuleReduction(state) {
    if (state.v !== 4 || !state.complete || state.pendingProtectedCues.length !== 0
        || state.nextDecodedOffset !== state.base.source.decodedUtf16.end)
        throw new Error("capsule-stream-incomplete");
    const exactCues = state.protectedCues.map(cue => span(cue.decodedUtf16.start, cue.exactText));
    const spans = mergeExactSpans([...state.head, ...state.tail, ...state.protectedNeighborhoods, ...exactCues]);
    const rendered = renderSpans(spans);
    const losses = [];
    const overflow = state.protectedCueOverflow + state.lexicalOverflow;
    if (overflow > 0)
        losses.push({ kind: "transformation-loss", reason: "budget", affectedSource: state.base.source,
            affectedDecodedUtf16: state.base.source.decodedUtf16, omittedUnits: "unknown",
            description: `${overflow} additional protected-cue match(es) exceeded fixed recognition or bounded-grammar budgets.` });
    if (spans.length > MAX_COMPLEMENT_RANGES)
        throw new Error("capsule-stream-complement-bound");
    return buildReducerEnvelope(state.base, state.options, { text: rendered.text, decodedUtf16: state.base.source.decodedUtf16,
        protectedCues: state.protectedCues, omissions: losses, completeBody: false, coverage: rendered.coverage, preserveExactSelection: true });
}
//# sourceMappingURL=capsule-reducer-stream.js.map