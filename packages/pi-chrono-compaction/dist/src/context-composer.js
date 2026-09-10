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
    const protectedRows = [], openWork = [], recent = [];
    let unsupported = false;
    for (const item of [...selection.protected, ...selection.current]) {
        const evidence = item.evidence;
        if (!evidence || !isScopedBodySourceRef(evidence.source) || !sourceRefWithinViewBounds(evidence.source, selection.sourceView)
            || evidence.source.eventSeq > selection.processedCut || typeof evidence.exactText !== "string" || !evidence.exactText
            || !Array.isArray(evidence.omissions) || evidence.omissions.length) {
            unsupported = true;
            continue;
        }
        const row = { id: item.stableKey, text: evidence.exactText,
            startSeq: evidence.source.eventSeq, endSeq: evidence.source.eventSeq, recovery: recovery(evidence.source),
            kind: item.kind === "restriction" ? "restriction" : "open-work", authority: "exact", status: item.status, importance: 1 };
        if (item.kind === "restriction")
            protectedRows.push(row);
        else if (item.kind === "openwork" || item.kind === "blocker")
            openWork.push(row);
        else
            recent.push({ ...row, kind: "capsule" });
    }
    for (const member of selection.recent) {
        if (!member.cue)
            continue;
        if (member.eventSeq > selection.processedCut || !sourceRefWithinViewBounds(member.source, selection.sourceView)) {
            throw new Error("stored episode member exceeds the pinned selection");
        }
        recent.push({ id: member.sourceKey, text: member.cue, startSeq: member.eventSeq, endSeq: member.eventSeq,
            recovery: recovery(member.source), kind: "episode", authority: "derived", status: "uncertain", importance: 0.7 });
    }
    const mandatoryComplete = !unsupported && selection.coverage.bodyComplete && selection.coverage.metadataComplete
        && !selection.coverage.qualifiedReducers && !selection.omissions.protectedAtLeastOne && !selection.omissions.responseBudgetAtLeastOne;
    return composeShadowContext({ ...input,
        memory: { generation: String(selection.stateGeneration), representedStartSeq: 0,
            representedEndSeq: selection.processedCut, committed: selection.stateGeneration > 0 },
        mandatoryCoverage: { protectedComplete: mandatoryComplete, openWorkComplete: mandatoryComplete },
        selected: { protected: protectedRows, openWork, recent, older: [] },
        delta: { records: [], completeThroughCut: selection.processedCut === selection.requestedCut },
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
    const authority = row.authority === "exact" ? "exact source" : "derived memory; verify before relying on it as evidence";
    const status = pinnedSnapshot
        ? `${row.status} at historical snapshot; not verified current at source cut`
        : row.status;
    const text = [
        `- [${row.startSeq}${row.endSeq === row.startSeq ? "" : `–${row.endSeq}`}] ${row.kind}; ${status}; ${authority}`,
        `  ${body.replaceAll("\n", "\n  ")}`,
        `  Recovery: ${row.recovery}`,
    ].join("\n");
    return { section, row, text, renderedTokens: estimateTokensFromText(text) };
}
function degradationFor(input) {
    const reasons = [];
    if (!input.cut.toolPairSafe)
        return { level: "pi-default-required", reasons: ["the supplied retained-tail cut failed tool-pair validation"] };
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
        return { level: "pi-summary-and-tail", reasons: ["no compatible committed memory generation is available"] };
    const memoryLag = Math.max(0, input.cut.sourceCutSeq - input.memory.representedEndSeq);
    if (memoryLag > 0 && !input.delta.completeThroughCut) {
        return { level: "committed-without-delta", reasons: [`bounded delta does not completely cover the ${memoryLag}-sequence memory lag`] };
    }
    if (!input.rollups || !input.rollups.complete) {
        return { level: "last-good-state-and-recent", reasons: [input.rollups ? "rollup coverage is incomplete" : "no compatible rollup range is available"] };
    }
    if (input.rollups.representedEndSeq < input.memory.representedEndSeq) {
        return {
            level: "last-good-state-and-recent",
            reasons: [`rollups lag committed memory by ${input.memory.representedEndSeq - input.rollups.representedEndSeq} sequence(s)`],
        };
    }
    return { level: "committed-plus-delta", reasons };
}
function sectionsFor(input, level) {
    if (level === "pi-summary-and-tail" || level === "pi-default-required")
        return [];
    const rows = [];
    const pinnedSnapshot = level !== "committed-plus-delta";
    rows.push(...chronological(input.selected.protected).map((row) => renderRow("protected", row, pinnedSnapshot)));
    rows.push(...chronological(input.selected.openWork).map((row) => renderRow("open-work", row, pinnedSnapshot)));
    if (level !== "last-good-state-summary-tail") {
        rows.push(...chronological(input.selected.recent).map((row) => renderRow("recent", row, pinnedSnapshot)));
    }
    if (level === "committed-plus-delta" || level === "committed-without-delta") {
        rows.push(...chronological(input.selected.older).map((row) => renderRow("older", row, pinnedSnapshot)));
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
        ["protected", level === "committed-plus-delta" ? "PROTECTED CONTRACT" : "KNOWN PROTECTED ITEMS AT HISTORICAL CUT (INCOMPLETE)"],
        ["open-work", level === "committed-plus-delta" ? "CURRENT OPEN WORK" : "KNOWN WORK AT HISTORICAL CUT (INCOMPLETE)"],
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
        reasons = [...reasons, `hard ceiling omitted ${omittedRowIds.length} optional row(s), selected by importance without reordering retained rows`];
        replay = replayText(input, level, reasons, rows);
        text = hybridPreservingSummary(input.regularPiSummary, replay);
        renderedTokens = estimateTokensFromText(text);
    }
    if (level !== "pi-default-required" && renderedTokens + input.cut.rawTailTokens > input.combinedCeilingTokens && rows.length > 0) {
        level = "last-good-state-summary-tail";
        reasons = [...reasons, "recent and historical selections do not fit with mandatory state under the hard combined ceiling"];
        const priorRows = rows;
        rows = sectionsFor(input, level);
        omittedRowIds.push(...priorRows.filter((item) => !rows.some((kept) => kept.row.id === item.row.id)).map((item) => item.row.id));
        replay = replayText(input, level, reasons, rows);
        text = hybridPreservingSummary(input.regularPiSummary, replay);
        renderedTokens = estimateTokensFromText(text);
    }
    if (level !== "pi-default-required" && renderedTokens + input.cut.rawTailTokens > input.combinedCeilingTokens && rows.length > 0) {
        level = "pi-summary-and-tail";
        reasons = [...reasons, "mandatory rows and rendered overhead do not fit the hard combined ceiling; partial mandatory state was withheld"];
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
export async function persistPrivateCompositionArtifact(directory, artifact) {
    const serialized = `${stableStringify(artifact, 2)}\n`;
    if (byteCount(serialized) > SHADOW_COMPOSER_LIMITS.maxInputBytes)
        throw new Error("composition artifact exceeds its persistence byte cap");
    const artifactHash = createHash("sha256").update(stableStringify(artifact)).digest("hex");
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