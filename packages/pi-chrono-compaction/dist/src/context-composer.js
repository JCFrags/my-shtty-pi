import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { renderHybridCompaction } from "./pi-hybrid.js";
import { isScopedBodySourceRef, sourceRefWithinViewBounds } from "./capsule-contract.js";
import { byteCount, estimateTokensFromText, stableStringify, truncateToTokens } from "./utils.js";
export const SHADOW_COMPOSER_LIMITS = {
    maxRows: 256,
    maxDeltaRows: 64,
    maxRowBytes: 16 * 1024,
    maxInputBytes: 512 * 1024,
    maxRegularSummaryBytes: 128 * 1024,
    maxRecoveryBytes: 2 * 1024,
    minCombinedCeilingTokens: 512,
};
/** Adapt one contained selection. Missing/lagging rollups and delta deliberately
 * take the historical degradation path, never a synchronous reconstruction. */
export function composeStoredSelection(input, selection, recovery) {
    if (selection.requestedCut !== input.cut.sourceCutSeq || selection.sourceView.eventCut !== selection.requestedCut
        || selection.processedCut > selection.requestedCut || selection.processedMemoryCut < selection.processedCut) {
        throw new Error("stored selection does not match the actual composition cut");
    }
    const extended = selection;
    const protectedRows = [], openWork = [];
    const recent = [], older = [], deltaRows = [];
    const unsupportedProtected = [], unsupportedOpenWork = [], unsupportedOptional = [];
    const exactRow = (item, maximumCut) => {
        const evidence = item.evidence;
        const decoded = evidence?.decodedUtf16;
        const omissions = Array.isArray(evidence?.omissions) ? evidence.omissions : undefined;
        const omission = omissions?.length === 1
            ? omissions[0] : undefined;
        if (!evidence || !isScopedBodySourceRef(evidence.source) || !sourceRefWithinViewBounds(evidence.source, selection.sourceView)
            || evidence.source.eventSeq > maximumCut || typeof evidence.exactText !== "string" || !evidence.exactText
            || !decoded || !Number.isSafeInteger(decoded.start) || !Number.isSafeInteger(decoded.end)
            || decoded.end - decoded.start !== evidence.exactText.length
            || decoded.start < evidence.source.decodedUtf16.start || decoded.end > evidence.source.decodedUtf16.end
            || !omissions || omissions.length > 1
            || omissions.length === 0 && (decoded.start !== evidence.source.decodedUtf16.start
                || decoded.end !== evidence.source.decodedUtf16.end)
            || omissions.length === 1 && (!omission || !Number.isSafeInteger(omission.beforeUtf16) || !Number.isSafeInteger(omission.afterUtf16)
                || omission.beforeUtf16 !== decoded.start - evidence.source.decodedUtf16.start
                || omission.afterUtf16 !== evidence.source.decodedUtf16.end - decoded.end
                || (omission.beforeUtf16 > 0 || omission.afterUtf16 > 0) && evidence.contextComplete !== true))
            return undefined;
        return { id: item.stableKey, text: evidence.exactText, startSeq: evidence.source.eventSeq, endSeq: evidence.source.eventSeq,
            recovery: recovery(evidence.source), kind: item.kind === "restriction" ? "restriction" : "open-work",
            authority: "exact", sourceAuthority: item.authority, status: item.status, importance: 1 };
    };
    const addState = (item, maximumCut, delta) => {
        const row = exactRow(item, maximumCut);
        const mandatory = item.kind === "restriction" || item.kind === "openwork" || item.kind === "blocker" || item.kind === "goal";
        if (!row) {
            (item.kind === "restriction" ? unsupportedProtected : mandatory ? unsupportedOpenWork : unsupportedOptional).push(item.stableKey);
            return;
        }
        if (item.kind === "restriction")
            protectedRows.push(row);
        else if (item.kind === "openwork" || item.kind === "blocker" || item.kind === "goal")
            openWork.push(row);
        else
            (delta ? deltaRows : recent).push({ ...row, kind: "capsule" });
    };
    const addMember = (member, maximumCut, target, kind) => {
        if (!member.cue)
            return;
        if (member.eventSeq > maximumCut || !sourceRefWithinViewBounds(member.source, selection.sourceView)) {
            throw new Error("stored episode member exceeds the pinned selection");
        }
        target.push({ id: member.sourceKey, text: member.cue, startSeq: member.eventSeq, endSeq: member.eventSeq,
            recovery: recovery(member.source), kind, authority: "derived", status: "uncertain", importance: kind === "rollup" ? 0.6 : 0.7 });
    };
    for (const item of selection.protected)
        addState(item, selection.processedCut, false);
    for (const item of selection.current)
        addState(item, selection.processedCut, false);
    for (const member of selection.recent)
        addMember(member, selection.processedCut, recent, "episode");
    for (const member of extended.older ?? [])
        addMember(member, selection.processedCut, older, "episode");
    const delta = extended.delta;
    if (delta && delta.protected.length + delta.current.length + delta.recent.length > SHADOW_COMPOSER_LIMITS.maxDeltaRows) {
        throw new Error(`bounded delta row count exceeds ${SHADOW_COMPOSER_LIMITS.maxDeltaRows}`);
    }
    const verifiedDelta = delta?.verified === true && Number.isSafeInteger(delta.throughCut)
        && delta.throughCut >= selection.processedCut && delta.throughCut <= selection.requestedCut;
    if (delta && Number.isSafeInteger(delta.throughCut) && delta.throughCut >= selection.processedCut
        && delta.throughCut <= selection.requestedCut) {
        // Qualified or incomplete delta cannot close lag, but its individually
        // source-validated obligations remain useful as explicitly incomplete state.
        for (const item of delta.protected)
            addState(item, delta.throughCut, verifiedDelta);
        for (const item of delta.current)
            addState(item, delta.throughCut, verifiedDelta);
        // An unverified recent suffix is independently source-pinned through the requested cut;
        // delta.throughCut continues to describe state/delta completeness only.
        for (const member of delta.recent)
            addMember(member, verifiedDelta ? delta.throughCut : selection.requestedCut, verifiedDelta ? deltaRows : recent, "episode");
    }
    const extractionBaseComplete = selection.coverage.bodyComplete && selection.coverage.metadataComplete
        && !selection.coverage.partialMemory && !selection.coverage.qualifiedReducers;
    const sourceCutCovered = selection.processedCut === selection.requestedCut
        || Boolean(verifiedDelta && delta?.throughCut === selection.requestedCut);
    const protectedComplete = sourceCutCovered && (selection.coverage.restrictionsComplete ?? extractionBaseComplete) && unsupportedProtected.length === 0
        && !selection.omissions.protectedAtLeastOne;
    const openWorkComplete = sourceCutCovered && (selection.coverage.openWorkComplete ?? extractionBaseComplete) && unsupportedOpenWork.length === 0
        && !(selection.omissions.openWorkAtLeastOne ?? selection.omissions.currentAtLeastOne);
    const unsupportedExtraction = [
        ...(!selection.coverage.bodyComplete ? ["body extraction coverage is incomplete"] : []),
        ...(!selection.coverage.metadataComplete ? ["metadata extraction coverage is incomplete"] : []),
        ...(selection.coverage.partialMemory ? ["memory extraction is partial"] : []),
        ...(selection.coverage.qualifiedReducers ? ["qualified reducer output has scoped extraction gaps; semantic completeness is not claimed"] : []),
        ...(unsupportedProtected.length ? [`${unsupportedProtected.length} protected item(s) have unsupported exact evidence`] : []),
        ...(unsupportedOpenWork.length ? [`${unsupportedOpenWork.length} open-work item(s) have unsupported exact evidence`] : []),
        ...(unsupportedOptional.length ? [`${unsupportedOptional.length} optional item(s) have unsupported exact evidence`] : []),
    ];
    const selectionLoss = [
        ...(selection.omissions.openWorkAtLeastOne ? ["open-work selection omitted at least one item"] : []),
        ...(selection.omissions.protectedAtLeastOne ? ["protected selection omitted at least one item"] : []),
        ...(selection.omissions.currentAtLeastOne ? ["current-state selection omitted at least one item"] : []),
        ...(selection.omissions.recentAtLeastOne ? ["recent selection omitted at least one item"] : []),
        ...(selection.omissions.responseBudgetAtLeastOne ? ["selection response budget omitted at least one item"] : []),
    ];
    const lag = selection.processedCut < selection.requestedCut && !verifiedDelta
        ? [delta?.reason || `memory snapshot lags the source cut by ${selection.requestedCut - selection.processedCut} sequence(s)`] : [];
    const dedupeRows = (rows) => {
        const seen = new Set();
        return rows.filter(row => {
            const key = `${row.startSeq}\n${row.recovery}\n${row.sourceAuthority}\n${row.text}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    };
    // Mandatory source text is represented once. Optional upgrades must not repeat
    // that same event, and a source selected as older cannot also become recent/delta.
    const selectedProtected = dedupeRows(protectedRows), selectedOpenWork = dedupeRows(openWork);
    const represented = new Set([...selectedProtected, ...selectedOpenWork].map(row => `${row.startSeq}\n${row.recovery}`));
    const uniqueOptional = (rows) => rows.filter(row => {
        const key = `${row.startSeq}\n${row.recovery}`;
        if (represented.has(key))
            return false;
        represented.add(key);
        return true;
    });
    const selectedRecent = uniqueOptional(recent), selectedOlder = uniqueOptional(older), selectedDelta = uniqueOptional(deltaRows);
    return composeShadowContext({ ...input,
        memory: { generation: String(selection.stateGeneration), representedStartSeq: 0,
            representedEndSeq: selection.processedCut, committed: selection.stateGeneration > 0 },
        mandatoryCoverage: { protectedComplete, openWorkComplete },
        selected: { protected: selectedProtected, openWork: selectedOpenWork, recent: selectedRecent, older: selectedOlder },
        delta: { records: selectedDelta, completeThroughCut: selection.processedCut === selection.requestedCut
                || Boolean(verifiedDelta && delta?.throughCut === selection.requestedCut && unsupportedProtected.length === 0 && unsupportedOpenWork.length === 0) },
        limitations: { unsupportedExtraction, selectionLoss, lag },
    });
}
function assertInteger(name, value, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum)
        throw new Error(`${name} must be a safe integer >= ${minimum}`);
}
function assertRows(rows, delta) {
    const limit = delta ? SHADOW_COMPOSER_LIMITS.maxDeltaRows : SHADOW_COMPOSER_LIMITS.maxRows;
    if (rows.length > limit)
        throw new Error(`bounded composer row count exceeds ${limit}`);
    for (const row of rows) {
        if (!row.id || !row.text || !row.recovery)
            throw new Error("composer rows require id, text, and opaque recovery reference");
        assertInteger("row.startSeq", row.startSeq);
        assertInteger("row.endSeq", row.endSeq);
        if (row.endSeq < row.startSeq)
            throw new Error(`composer row ${row.id} has an inverted source range`);
        if (!Number.isFinite(row.importance) || row.importance < 0 || row.importance > 1) {
            throw new Error(`composer row ${row.id} importance must be between 0 and 1`);
        }
        if (byteCount(row.text) > SHADOW_COMPOSER_LIMITS.maxRowBytes)
            throw new Error(`composer row ${row.id} text exceeds its byte cap`);
        if (byteCount(row.recovery) > SHADOW_COMPOSER_LIMITS.maxRecoveryBytes)
            throw new Error(`composer row ${row.id} recovery reference exceeds its byte cap`);
    }
}
function validateInput(input) {
    if (!input.regularPiSummary)
        throw new Error("regular Pi summary must be present as a separate input");
    if (byteCount(input.regularPiSummary) > SHADOW_COMPOSER_LIMITS.maxRegularSummaryBytes) {
        throw new Error("regular Pi summary exceeds the bounded composer byte cap");
    }
    assertInteger("combinedCeilingTokens", input.combinedCeilingTokens, SHADOW_COMPOSER_LIMITS.minCombinedCeilingTokens);
    assertInteger("cut.sourceCutSeq", input.cut.sourceCutSeq);
    assertInteger("cut.firstKeptSeq", input.cut.firstKeptSeq);
    assertInteger("cut.rawTailTokens", input.cut.rawTailTokens);
    if (!input.cut.sourceCutEntryId || !input.cut.firstKeptEntryId)
        throw new Error("composer cut requires source and retained-tail entry IDs");
    if (input.cut.firstKeptSeq <= input.cut.sourceCutSeq)
        throw new Error("retained tail must begin after the summarized prefix cut");
    assertInteger("memory.representedStartSeq", input.memory.representedStartSeq);
    assertInteger("memory.representedEndSeq", input.memory.representedEndSeq);
    if (input.memory.representedEndSeq < input.memory.representedStartSeq)
        throw new Error("memory represented range is inverted");
    if (input.memory.representedEndSeq > input.cut.sourceCutSeq)
        throw new Error("memory generation is beyond the source cut");
    if (input.rollups) {
        assertInteger("rollups.representedStartSeq", input.rollups.representedStartSeq);
        assertInteger("rollups.representedEndSeq", input.rollups.representedEndSeq);
        if (input.rollups.representedEndSeq < input.rollups.representedStartSeq)
            throw new Error("rollup represented range is inverted");
        if (input.rollups.representedEndSeq > input.cut.sourceCutSeq)
            throw new Error("rollup generation is beyond the source cut");
    }
    const groups = [input.selected.protected, input.selected.openWork, input.selected.recent, input.selected.older];
    for (const rows of groups)
        assertRows(rows, false);
    assertRows(input.delta.records, true);
    if (input.selected.protected.some((row) => row.kind !== "restriction" || row.authority !== "exact")) {
        throw new Error("protected selections must be exact restriction rows");
    }
    if (input.selected.openWork.some((row) => row.kind !== "open-work")) {
        throw new Error("open-work selections must use the open-work kind");
    }
    for (const row of groups.flatMap((rows) => rows).concat(input.delta.records)) {
        if (row.endSeq > input.cut.sourceCutSeq)
            throw new Error(`composer row ${row.id} extends beyond the summarized prefix cut`);
    }
    const totalRows = groups.reduce((sum, rows) => sum + rows.length, 0) + input.delta.records.length;
    if (totalRows > SHADOW_COMPOSER_LIMITS.maxRows)
        throw new Error(`combined composer row count exceeds ${SHADOW_COMPOSER_LIMITS.maxRows}`);
    if (byteCount(stableStringify(input)) > SHADOW_COMPOSER_LIMITS.maxInputBytes)
        throw new Error("bounded composer input exceeds its total byte cap");
}
function chronological(rows) {
    return [...rows].sort((a, b) => a.startSeq - b.startSeq || a.endSeq - b.endSeq || a.id.localeCompare(b.id));
}
function renderRow(section, row, pinnedSnapshot) {
    const detailTokens = Math.max(48, Math.round(72 + row.importance * 184));
    // Never shorten a mandatory proposition: its final condition or negation may
    // change the obligation. A budget failure must take the explicit fallback.
    const body = section === "protected" || section === "open-work" ? row.text
        : truncateToTokens(row.text, detailTokens, "\n…[detail reduced; use recovery reference]…");
    const fidelity = row.authority === "exact" ? "exact copied source words" : "derived memory; verify against exact source";
    const semanticAuthority = row.sourceAuthority ? `source authority: ${row.sourceAuthority}` : "source authority: not asserted";
    const status = pinnedSnapshot
        ? `${row.status} at historical snapshot; not verified current at source cut`
        : row.status;
    const text = [
        `- [${row.startSeq}${row.endSeq === row.startSeq ? "" : `–${row.endSeq}`}] ${row.kind}; ${status}; ${fidelity}; ${semanticAuthority}`,
        `  ${body.replaceAll("\n", "\n  ")}`,
        `  Recovery: ${row.recovery}`,
    ].join("\n");
    return { section, row, text, renderedTokens: estimateTokensFromText(text) };
}
function degradationFor(input) {
    const reasons = [
        ...(input.limitations?.unsupportedExtraction ?? []).map(reason => `unsupported extraction: ${reason}`),
        ...(input.limitations?.selectionLoss ?? []).map(reason => `selection loss: ${reason}`),
        ...(input.limitations?.lag ?? []).map(reason => `snapshot lag: ${reason}`),
    ];
    if (!input.cut.toolPairSafe)
        return { level: "pi-default-required", reasons: [...reasons, "the supplied retained-tail cut failed tool-pair validation"] };
    if (!input.mandatoryCoverage.protectedComplete || !input.mandatoryCoverage.openWorkComplete) {
        if (!input.mandatoryCoverage.protectedComplete)
            reasons.push("protected-restriction coverage is incomplete");
        if (!input.mandatoryCoverage.openWorkComplete)
            reasons.push("open-work coverage is incomplete");
        // Preserve bounded supported history, but never label an incomplete
        // snapshot a complete current contract. Pi's separate summary remains.
        return { level: input.memory.committed ? "last-good-state-and-recent" : "pi-summary-and-tail", reasons };
    }
    if (!input.memory.committed)
        return { level: "pi-summary-and-tail", reasons: [...reasons, "no compatible committed memory generation is available"] };
    const memoryLag = Math.max(0, input.cut.sourceCutSeq - input.memory.representedEndSeq);
    if (memoryLag > 0 && !input.delta.completeThroughCut) {
        return { level: "committed-without-delta", reasons: [...reasons, `bounded delta does not completely cover the ${memoryLag}-sequence memory lag`] };
    }
    // Historical rollups need not cover the current cut. Source-linked older
    // episodes are also a supported historical selection, independent of state coverage.
    const hasOlderEpisodes = input.selected.older.some(row => row.kind === "episode");
    if ((!input.rollups || !input.rollups.complete) && !hasOlderEpisodes) {
        return { level: "last-good-state-and-recent", reasons: [...reasons, input.rollups ? "rollup coverage is incomplete" : "no compatible rollup range or older episode selection is available"] };
    }
    return { level: "committed-plus-delta", reasons };
}
function sectionsFor(input, level) {
    if (level === "pi-summary-and-tail" || level === "pi-default-required")
        return [];
    const rows = [];
    const snapshotLags = input.memory.representedEndSeq < input.cut.sourceCutSeq && !input.delta.completeThroughCut;
    rows.push(...chronological(input.selected.protected).map((row) => renderRow("protected", row, snapshotLags && row.endSeq <= input.memory.representedEndSeq)));
    rows.push(...chronological(input.selected.openWork).map((row) => renderRow("open-work", row, snapshotLags && row.endSeq <= input.memory.representedEndSeq)));
    if (level !== "last-good-state-summary-tail") {
        rows.push(...chronological(input.selected.recent).map((row) => renderRow("recent", row, snapshotLags && row.endSeq <= input.memory.representedEndSeq)));
    }
    if (level === "committed-plus-delta" || level === "committed-without-delta") {
        rows.push(...chronological(input.selected.older).map((row) => renderRow("older", row, snapshotLags && row.endSeq <= input.memory.representedEndSeq)));
    }
    else if (level === "last-good-state-and-recent") {
        // Bounded source-linked episode members do not require a rollup publication.
        rows.push(...chronological(input.selected.older).filter(row => row.kind === "episode")
            .map((row) => renderRow("older", row, snapshotLags && row.endSeq <= input.memory.representedEndSeq)));
    }
    if (level === "committed-plus-delta") {
        rows.push(...chronological(input.delta.records).map((row) => renderRow("delta", row, false)));
    }
    return rows;
}
function replayText(input, level, reasons, rows) {
    const memoryLag = Math.max(0, input.cut.sourceCutSeq - input.memory.representedEndSeq);
    const rollupLine = input.rollups
        ? `Rollups: generation ${input.rollups.generation}, represented sequence ${input.rollups.representedStartSeq}–${input.rollups.representedEndSeq}, source-cut lag ${Math.max(0, input.cut.sourceCutSeq - input.rollups.representedEndSeq)}.`
        : "Rollups: unavailable; no rollup-derived state is presented as current.";
    const intro = [
        "Source-linked bounded memory. Immutable Pi history remains authoritative.",
        `Composition mode: ${level}.`,
        `${input.memory.committed ? "Committed memory" : "Memory candidate (not committed; excluded)"}: generation ${input.memory.generation}, represented sequence ${input.memory.representedStartSeq}–${input.memory.representedEndSeq}, source-cut lag ${memoryLag}.`,
        rollupLine,
        reasons.length ? `Degradation: ${reasons.join("; ")}. Partial derived state is not presented as current.` : "Validation: committed memory and bounded delta cover the source cut.",
        `Retained raw tail begins at ${input.cut.firstKeptEntryId} (sequence ${input.cut.firstKeptSeq}); it is outside this text but included in the combined ceiling.`,
    ];
    const grouped = [
        ["protected", input.mandatoryCoverage.protectedComplete ? "PROTECTED CONTRACT" : "KNOWN PROTECTED ITEMS (INCOMPLETE COVERAGE)"],
        ["open-work", input.mandatoryCoverage.openWorkComplete ? "CURRENT OPEN WORK" : "KNOWN OPEN WORK (INCOMPLETE COVERAGE)"],
        ["older", "OLDER SELECTED MEMORY (CHRONOLOGICAL)"],
        ["recent", "RECENT CHRONOLOGICAL MEMORY"],
        ["delta", "BOUNDED UNINDEXED DELTA (CHRONOLOGICAL)"],
    ];
    const sections = grouped.flatMap(([key, title]) => {
        const selected = rows.filter((row) => row.section === key);
        return selected.length ? [`## ${title}\n\n${selected.map((row) => row.text).join("\n\n")}`] : [];
    });
    sections.push("## RECOVERY\n\nUse each opaque Recovery reference through the session adapter. Memory text is not exact evidence unless marked exact source.");
    return [...intro, ...sections].join("\n\n");
}
function hybridPreservingSummary(regularPiSummary, replay) {
    let marker = `__CHRONO_PI_SUMMARY_${createHash("sha256").update(regularPiSummary).digest("hex")}__`;
    while (regularPiSummary.includes(marker) || replay.includes(marker))
        marker += "_";
    return renderHybridCompaction(marker, replay).replace(marker, regularPiSummary);
}
function optionalDropOrder(rows) {
    const sectionRank = (section) => section === "older" ? 0 : section === "delta" ? 1 : 2;
    return [...rows]
        .filter((item) => item.section === "recent" || item.section === "older" || item.section === "delta")
        .sort((a, b) => a.row.importance - b.row.importance || sectionRank(a.section) - sectionRank(b.section) || a.row.startSeq - b.row.startSeq);
}
export function composeShadowContext(input) {
    validateInput(input);
    let { level, reasons } = degradationFor(input);
    let rows = sectionsFor(input, level);
    const omittedRowIds = [];
    let replay = replayText(input, level, reasons, rows);
    let text = level === "pi-default-required" ? "" : hybridPreservingSummary(input.regularPiSummary, replay);
    let renderedTokens = text ? estimateTokensFromText(text) : 0;
    for (const drop of optionalDropOrder(rows)) {
        if (renderedTokens + input.cut.rawTailTokens <= input.combinedCeilingTokens)
            break;
        rows = rows.filter((candidate) => candidate !== drop);
        omittedRowIds.push(drop.row.id);
        replay = replayText(input, level, reasons, rows);
        text = hybridPreservingSummary(input.regularPiSummary, replay);
        renderedTokens = estimateTokensFromText(text);
    }
    if (omittedRowIds.length > 0) {
        reasons = [...reasons, `render loss: hard ceiling omitted ${omittedRowIds.length} optional row(s), selected by importance without reordering retained rows`];
        replay = replayText(input, level, reasons, rows);
        text = hybridPreservingSummary(input.regularPiSummary, replay);
        renderedTokens = estimateTokensFromText(text);
    }
    if (level !== "pi-default-required" && renderedTokens + input.cut.rawTailTokens > input.combinedCeilingTokens && rows.length > 0) {
        level = "last-good-state-summary-tail";
        reasons = [...reasons, "render loss: recent and historical selections do not fit with mandatory state under the hard combined ceiling"];
        const priorRows = rows;
        rows = sectionsFor(input, level);
        omittedRowIds.push(...priorRows.filter((item) => !rows.some((kept) => kept.row.id === item.row.id)).map((item) => item.row.id));
        replay = replayText(input, level, reasons, rows);
        text = hybridPreservingSummary(input.regularPiSummary, replay);
        renderedTokens = estimateTokensFromText(text);
    }
    if (level !== "pi-default-required" && renderedTokens + input.cut.rawTailTokens > input.combinedCeilingTokens && rows.length > 0) {
        level = "pi-summary-and-tail";
        reasons = [...reasons, "render loss: mandatory rows and rendered overhead do not fit the hard combined ceiling; partial mandatory state was withheld"];
        omittedRowIds.push(...rows.map((item) => item.row.id));
        rows = [];
        replay = replayText(input, level, reasons, rows);
        text = hybridPreservingSummary(input.regularPiSummary, replay);
        renderedTokens = estimateTokensFromText(text);
    }
    if (level !== "pi-default-required" && renderedTokens + input.cut.rawTailTokens > input.combinedCeilingTokens) {
        level = "pi-default-required";
        reasons = [...reasons, "the byte-preserved regular Pi summary and retained raw tail cannot fit the hard combined ceiling"];
        text = "";
        renderedTokens = 0;
    }
    const validation = {
        safeTail: input.cut.toolPairSafe,
        withinCombinedCeiling: renderedTokens + input.cut.rawTailTokens <= input.combinedCeilingTokens,
        protectedCoverageComplete: input.mandatoryCoverage.protectedComplete && input.selected.protected.every(item => rows.some(kept => kept.section === "protected" && kept.row.id === item.id)),
        openWorkCoverageComplete: input.mandatoryCoverage.openWorkComplete && input.selected.openWork.every(item => rows.some(kept => kept.section === "open-work" && kept.row.id === item.id)),
    };
    const artifactBase = {
        schemaVersion: 1,
        createdFrom: "bounded-shadow-composer-input",
        degradation: level,
        degradationReasons: reasons,
        cut: input.cut,
        memory: input.memory,
        ...(input.rollups ? { rollups: input.rollups } : {}),
        selectedRows: rows.map((item) => ({ section: item.section, row: item.row, renderedTokens: item.renderedTokens })),
        omittedRowIds: [...new Set([...omittedRowIds, ...[...input.selected.protected, ...input.selected.openWork,
                    ...input.selected.older, ...input.selected.recent, ...input.delta.records]
                    .filter(item => !rows.some(kept => kept.row.id === item.id)).map(item => item.id)])],
        validation,
    };
    const artifact = artifactBase;
    const artifactHash = createHash("sha256").update(stableStringify(artifact)).digest("hex");
    const summaryHash = createHash("sha256").update(text).digest("hex");
    const envelope = {
        schemaVersion: 1,
        sourceCutEntryId: input.cut.sourceCutEntryId,
        sourceCutSeq: input.cut.sourceCutSeq,
        firstKeptEntryId: input.cut.firstKeptEntryId,
        memoryGeneration: input.memory.generation,
        memoryRepresentedRange: [input.memory.representedStartSeq, input.memory.representedEndSeq],
        memoryLag: Math.max(0, input.cut.sourceCutSeq - input.memory.representedEndSeq),
        ...(input.rollups ? {
            rollupGeneration: input.rollups.generation,
            rollupRepresentedRange: [input.rollups.representedStartSeq, input.rollups.representedEndSeq],
            rollupLag: Math.max(0, input.cut.sourceCutSeq - input.rollups.representedEndSeq),
        } : {}),
        degradation: level,
        summaryHash,
        renderedTokens,
        rawTailTokens: input.cut.rawTailTokens,
        combinedTokens: renderedTokens + input.cut.rawTailTokens,
        validation,
        payloadHash: artifactHash,
        artifactHash,
    };
    return {
        status: level === "pi-default-required" ? "pi-default-required" : "composed",
        text,
        firstKeptEntryId: input.cut.firstKeptEntryId,
        degradation: level,
        degradationReasons: reasons,
        envelope,
        artifact,
    };
}
async function validatePrivateDirectory(directory) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || directory === "/") {
        throw new Error("artifact directory must be an absolute canonical path");
    }
    const uid = process.getuid?.();
    if (uid === undefined)
        throw new Error("artifact persistence requires an owner-aware filesystem");
    let current = "/";
    for (const part of directory.split("/").filter(Boolean)) {
        current = join(current, part);
        const stat = await lstat(current);
        const unsafeWritable = (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0);
        if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || unsafeWritable) {
            throw new Error("artifact directory ancestry is unsafe");
        }
    }
    const stat = await lstat(directory);
    if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) {
        throw new Error("artifact directory must be owner-only (0700)");
    }
}
function artifactStringify(value, space = 0) {
    const ancestors = new WeakSet();
    const normalize = (input) => {
        if (input === null || typeof input !== "object")
            return input;
        if (ancestors.has(input))
            return "[Circular]";
        ancestors.add(input);
        try {
            if (Array.isArray(input))
                return input.map(normalize);
            const record = input, result = {};
            for (const key of Object.keys(record).sort())
                result[key] = normalize(record[key]);
            return result;
        }
        finally {
            ancestors.delete(input);
        }
    };
    return JSON.stringify(normalize(value), null, space);
}
export async function persistPrivateCompositionArtifact(directory, artifact) {
    const canonical = artifactStringify(artifact);
    const serialized = `${artifactStringify(artifact, 2)}\n`;
    if (byteCount(serialized) > SHADOW_COMPOSER_LIMITS.maxInputBytes)
        throw new Error("composition artifact exceeds its persistence byte cap");
    const artifactHash = createHash("sha256").update(canonical).digest("hex");
    const fileName = `composition-${artifactHash}.json`;
    await validatePrivateDirectory(dirname(directory));
    try {
        await mkdir(directory, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    await validatePrivateDirectory(directory);
    const target = join(directory, fileName);
    const temporary = join(directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
            await validatePrivateDirectory(directory);
            await link(temporary, target);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await existing.stat();
                if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > SHADOW_COMPOSER_LIMITS.maxInputBytes) {
                    throw new Error("existing artifact path is not a private regular file");
                }
                const existingBytes = await existing.readFile();
                if (createHash("sha256").update(existingBytes).digest("hex") !== createHash("sha256").update(serialized).digest("hex")) {
                    throw new Error("existing artifact content does not match its content-addressed name");
                }
            }
            finally {
                await existing.close();
            }
        }
        const directoryHandle = await open(directory, "r");
        try {
            await directoryHandle.sync();
        }
        finally {
            await directoryHandle.close();
        }
    }
    finally {
        if (handle)
            await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
    }
    return { artifactHash, artifactRef: fileName, bytes: byteCount(serialized) };
}
//# sourceMappingURL=context-composer.js.map