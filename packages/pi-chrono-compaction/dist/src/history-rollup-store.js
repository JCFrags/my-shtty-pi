import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile, } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseHistoricalBlocks } from "./blocks.js";
import { readSourceLedgerEntries, resolveSourceLedgerBranch } from "./ledger-branch.js";
import { acquireHistoryRollupLock } from "./history-rollup-lock.js";
import { extractHistoryValues, historyStaticValue, } from "./history-value.js";
import { updateSourceLedger } from "./source-ledger.js";
export const HISTORY_ROLLUP_SCHEMA_VERSION = 2;
export const HISTORY_ROLLUP_SUFFIX = ".chrono-history-rollups-v2";
export const HISTORY_ROLLUP_V1_SUFFIX = ".chrono-history-rollups-v1";
export const DEFAULT_HISTORY_ROLLUP_CONFIG = {
    targetLeafSourceBytes: 4 * 1024 * 1024,
    targetLeafEntries: 2048,
    targetLeafBlocks: 4096,
    fanout: 8,
    maximumStructuredRecords: 1024,
    maximumCueTokens: 8000,
    maximumNodeBytes: 1024 * 1024,
    recentBranchLimit: 16,
    nodeCacheBytes: 16 * 1024 * 1024,
    maximumQueryNodes: 64,
    maximumQueryNodeBytes: 8 * 1024 * 1024,
    maximumQueryRecords: 512,
    recentLeafSafetyLimit: 32,
};
const EXTRACTOR_VERSION = fullHash("chrono-history-rollup-extractor-v2");
function fullHash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function stableStringify(value) {
    const stack = new WeakSet();
    const normalize = (input) => {
        if (input === null || typeof input !== "object")
            return input;
        if (stack.has(input))
            return "[Circular]";
        stack.add(input);
        let output;
        if (Array.isArray(input))
            output = input.map(normalize);
        else {
            const record = input;
            const sorted = {};
            for (const key of Object.keys(record).sort())
                sorted[key] = normalize(record[key]);
            output = sorted;
        }
        stack.delete(input);
        return output;
    };
    return JSON.stringify(normalize(value));
}
function withIntegrity(value) {
    return { ...value, integrityHash: fullHash(stableStringify(value)) };
}
function verifyIntegrity(value) {
    if (typeof value.integrityHash !== "string" || value.integrityHash.length !== 64)
        return false;
    const copy = { ...value };
    delete copy.integrityHash;
    return fullHash(stableStringify(copy)) === value.integrityHash;
}
function nodeIdentity(value) {
    const contentHash = fullHash(stableStringify(value));
    return { nodeId: contentHash, contentHash };
}
async function syncDirectory(path) {
    try {
        const handle = await open(path, "r");
        await handle.sync();
        await handle.close();
    }
    catch {
        // Some platforms do not permit directory fsync.
    }
}
async function atomicJson(path, value, directorySync = syncDirectory) {
    const text = `${stableStringify(value)}\n`;
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, text, { mode: 0o600 });
    const handle = await open(temporary, "r");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
    await directorySync(dirname(path));
    return Buffer.byteLength(text);
}
export function historyRollupStorePath(sessionPath) {
    return `${sessionPath}${HISTORY_ROLLUP_SUFFIX}`;
}
export function historyRollupV1StorePath(sessionPath) {
    return `${sessionPath}${HISTORY_ROLLUP_V1_SUFFIX}`;
}
export function createHistoryRollupRuntime(sessionPath, config = {}) {
    return {
        sessionPath,
        directory: historyRollupStorePath(sessionPath),
        config: { ...DEFAULT_HISTORY_ROLLUP_CONFIG, ...config },
        cache: new Map(),
        cacheBytes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheEvictions: 0,
        nodesLoaded: 0,
        nodeBytesRead: 0,
    };
}
function configurationHash(config) {
    return fullHash(stableStringify(config));
}
async function loadJson(path) {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.schemaVersion !== 2 || !verifyIntegrity(value))
        throw new Error("history-rollup-integrity");
    return value;
}
export async function loadHistoryRollupManifest(runtime) {
    try {
        const manifest = await loadJson(join(runtime.directory, "manifest.json"));
        runtime.manifest = manifest;
        return manifest;
    }
    catch {
        runtime.manifest = undefined;
        return undefined;
    }
}
export async function loadHistoryBranchManifest(runtime, reference) {
    const ref = reference ?? runtime.manifest?.activeBranchManifestReference;
    if (!ref)
        return undefined;
    try {
        const branch = await loadJson(join(runtime.directory, "branches", ref));
        if (!reference || reference === runtime.manifest?.activeBranchManifestReference)
            runtime.branchManifest = branch;
        return branch;
    }
    catch {
        if (!reference)
            runtime.branchManifest = undefined;
        return undefined;
    }
}
export async function loadHistoryNode(runtime, nodeId) {
    const cached = runtime.cache.get(nodeId);
    if (cached) {
        runtime.cache.delete(nodeId);
        runtime.cache.set(nodeId, cached);
        runtime.cacheHits++;
        return cached.node;
    }
    runtime.cacheMisses++;
    const text = await readFile(join(runtime.directory, "nodes", `${nodeId}.json`), "utf8");
    const node = JSON.parse(text);
    const record = node;
    if (node.schemaVersion !== 2 ||
        node.nodeId !== nodeId ||
        node.contentHash !== nodeId ||
        node.nodeId.length !== 64 ||
        !verifyIntegrity(record))
        throw new Error("history-rollup-node-corrupt");
    const bytes = Buffer.byteLength(text);
    runtime.nodesLoaded++;
    runtime.nodeBytesRead += bytes;
    runtime.cache.set(nodeId, { node, bytes });
    runtime.cacheBytes += bytes;
    while (runtime.cacheBytes > runtime.config.nodeCacheBytes && runtime.cache.size > 1) {
        const oldest = runtime.cache.entries().next().value;
        if (!oldest)
            break;
        runtime.cache.delete(oldest[0]);
        runtime.cacheBytes -= oldest[1].bytes;
        runtime.cacheEvictions++;
    }
    return node;
}
async function writeNode(runtime, node, directorySync) {
    const text = `${stableStringify(node)}\n`;
    const bytes = Buffer.byteLength(text);
    if (bytes > runtime.config.maximumNodeBytes) {
        throw Object.assign(new Error("history-rollup-node-too-large"), { code: "history-rollup-node-too-large", context: { nodeBytes: bytes, nodeTypeCode: node.nodeType === "leaf" ? 1 : 2 } });
    }
    const path = join(runtime.directory, "nodes", `${node.nodeId}.json`);
    try {
        const existingText = await readFile(path, "utf8");
        const existing = JSON.parse(existingText);
        if (existing.schemaVersion !== 2 ||
            existing.nodeId !== node.nodeId ||
            existing.contentHash !== node.contentHash ||
            !verifyIntegrity(existing) ||
            existingText !== text)
            throw new Error("history-rollup-existing-node-corrupt");
        return { created: false, bytes: Buffer.byteLength(existingText) };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    await atomicJson(path, node, directorySync);
    return { created: true, bytes };
}
function queryTermHashes(records, querySalt) {
    const terms = new Set();
    for (const record of records) {
        if (record.exactSourceRequired)
            continue;
        for (const term of (record.cue ?? "").toLowerCase().match(/[a-z][a-z0-9_.:/-]{2,}/g) ?? []) {
            terms.add(fullHash(`${querySalt}:${term}`));
            if (terms.size >= 256)
                break;
        }
    }
    return [...terms].sort();
}
function makeQueryIndex(records, start, end, querySalt) {
    const priorityOrder = ["A", "B", "C", "D", "E"];
    const base = {
        termHashes: queryTermHashes(records, querySalt),
        categories: [...new Set(records.map(record => record.category))].sort(),
        maximumPriority: records.map(record => record.priority).sort((a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b))[0] ?? "E",
        lifecycleFlags: [...new Set(records.map(record => record.lifecycle))].sort(),
        resourceIdentities: boundedIndexValues(records.flatMap(record => record.resourceIdentity ? [record.resourceIdentity] : []), 256, 32 * 1024),
        taskIdentities: boundedIndexValues(records.flatMap(record => record.taskIdentity ? [record.taskIdentity] : []), 256, 32 * 1024),
        failureIdentities: boundedIndexValues(records.flatMap(record => record.failureIdentity ? [record.failureIdentity] : []), 256, 32 * 1024),
        sourceOrderRange: { start, end },
        recordCount: records.length,
        hasCurrentState: records.some(record => ["current", "unresolved", "open", "conflict"].includes(record.lifecycle)),
    };
    return { ...base, hash: fullHash(stableStringify(base)) };
}
function boundedIndexValues(values, maximumCount, maximumBytes) {
    const output = [];
    let bytes = 0;
    for (const value of [...new Set(values)].sort()) {
        const valueBytes = Buffer.byteLength(value) + 4;
        if (output.length >= maximumCount)
            break;
        if (bytes + valueBytes > maximumBytes)
            continue;
        output.push(value);
        bytes += valueBytes;
    }
    return output;
}
function makeRollupQueryIndex(records, children, start, end, querySalt) {
    const local = makeQueryIndex(records, start, end, querySalt);
    const base = {
        ...local,
        termHashes: boundedIndexValues(children.flatMap(child => child.queryIndex.termHashes), 1024, 96 * 1024),
        categories: [...new Set(children.flatMap(child => child.queryIndex.categories))].sort(),
        lifecycleFlags: [...new Set(children.flatMap(child => child.queryIndex.lifecycleFlags))].sort(),
        resourceIdentities: boundedIndexValues(children.flatMap(child => child.queryIndex.resourceIdentities), 128, 32 * 1024),
        taskIdentities: boundedIndexValues(children.flatMap(child => child.queryIndex.taskIdentities), 128, 32 * 1024),
        failureIdentities: boundedIndexValues(children.flatMap(child => child.queryIndex.failureIdentities), 128, 32 * 1024),
        recordCount: children.reduce((sum, child) => sum + child.queryIndex.recordCount, 0),
        hasCurrentState: children.some(child => child.queryIndex.hasCurrentState),
    };
    const { hash: _ignored, ...withoutHash } = base;
    return { ...withoutHash, hash: fullHash(stableStringify(withoutHash)) };
}
function archiveRecord(records, omitted) {
    if (!omitted || !records.length)
        return undefined;
    const ordered = [...records].sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id));
    const first = ordered[0];
    const last = ordered.at(-1);
    const id = fullHash(`archive-v2:${first.id}:${last.id}:${omitted}`);
    return {
        schemaVersion: 2,
        id,
        category: "archive-range",
        sourceAuthority: "derived",
        lifecycle: "closed",
        priority: "E",
        sourceRefs: [first.sourceRefs[0], last.sourceRefs.at(-1)],
        sourceRange: { startEntryId: first.sourceRange.startEntryId, endEntryId: last.sourceRange.endEntryId },
        sourceOrder: { start: first.sourceOrder.start, end: last.sourceOrder.end },
        sourceTokens: records.reduce((total, record) => total + record.sourceTokens, 0),
        renderedTokenEstimate: 24,
        evidenceType: "deterministic-derived",
        uniqueness: "unique",
        recoveryCost: 20,
        reproductionCost: 20,
        compressionRisk: 10,
        staticImportance: 10,
        staticSignals: ["archive"],
        stateKey: `archive:${id}`,
        normalizedClaimHash: fullHash(`archive:${first.id}:${last.id}`),
        relations: [],
        confidence: "deterministic-inference",
        cue: `Reduced archive range; ${omitted} typed records omitted.`,
        exactSourceRequired: false,
    };
}
function selectRecords(records, config, nodeFraction = 0.6) {
    const important = (record) => record.priority === "A" ||
        record.lifecycle === "conflict" ||
        record.category === "blocker" ||
        record.lifecycle === "unresolved" ||
        record.category === "resource-state" ||
        record.lifecycle === "open";
    const sorted = [...records].sort((a, b) => Number(important(b)) - Number(important(a)) ||
        historyStaticValue(b) - historyStaticValue(a) ||
        a.sourceOrder.start - b.sourceOrder.start ||
        a.id.localeCompare(b.id));
    const kept = [];
    const omitted = {};
    let cueTokens = 0;
    let recordBytes = 0;
    for (const record of sorted) {
        const bytes = Buffer.byteLength(stableStringify(record));
        const fits = kept.length < config.maximumStructuredRecords &&
            recordBytes + bytes <= Math.floor(config.maximumNodeBytes * nodeFraction) &&
            (important(record) || cueTokens + record.renderedTokenEstimate <= config.maximumCueTokens);
        if (fits) {
            kept.push(record);
            cueTokens += record.renderedTokenEstimate;
            recordBytes += bytes;
        }
        else
            omitted[record.category] = (omitted[record.category] ?? 0) + 1;
    }
    const archive = archiveRecord(records, Object.values(omitted).reduce((sum, count) => sum + count, 0));
    return { kept, omitted, archives: archive ? [archive] : [] };
}
function relationAuthority(authority) {
    return { derived: 0, assistant: 1, tool: 2, user: 3, project: 4 }[authority];
}
function explicitRelation(record, kind, targetId) {
    return record.relations.some(relation => relation.kind === kind && relation.targetRecordId === targetId);
}
export function aggregateHistoryState(records) {
    const ordered = [...records].sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id));
    const current = [];
    const conflicts = [];
    const byKey = new Map();
    for (const record of ordered) {
        const stateful = [
            "restriction",
            "failure",
            "blocker",
            "goal",
            "decision",
            "next-action",
            "task-episode",
            "resource-state",
        ].includes(record.category);
        const key = stateful ? record.stateKey : `record:${record.id}`;
        const prior = byKey.get(key);
        if (!prior) {
            byKey.set(key, record);
            continue;
        }
        if (record.normalizedClaimHash === prior.normalizedClaimHash) {
            byKey.set(key, { ...record, relations: [...record.relations, { kind: "duplicate", targetRecordId: prior.id, basis: "exact-normalized-claim" }] });
            continue;
        }
        const restrictionSupersession = record.category === "restriction" &&
            prior.category === "restriction" &&
            record.subjectFingerprint === prior.subjectFingerprint &&
            relationAuthority(record.sourceAuthority) >= relationAuthority(prior.sourceAuthority) &&
            record.correctionIntent === true;
        const resourceUpdate = record.category === "resource-state" &&
            prior.category === "resource-state" &&
            record.resourceIdentity === prior.resourceIdentity &&
            record.resourceRole === prior.resourceRole;
        if (restrictionSupersession || resourceUpdate || explicitRelation(record, "supersession", prior.id)) {
            byKey.set(key, {
                ...record,
                relations: [...record.relations, {
                        kind: restrictionSupersession ? "supersession" : "resource-update",
                        targetRecordId: prior.id,
                        basis: restrictionSupersession ? "same-subject-explicit-replacement-authority" : "same-resource-compatible-role",
                    }],
            });
            continue;
        }
        const sources = [prior.sourceRefs[0], record.sourceRefs.at(-1)];
        conflicts.push({ ...prior, lifecycle: "conflict", conflictSources: sources, relations: [...prior.relations, { kind: "conflict", targetRecordId: record.id, basis: "same-state-key-no-supersession" }] }, { ...record, lifecycle: "conflict", conflictSources: sources, relations: [...record.relations, { kind: "conflict", targetRecordId: prior.id, basis: "same-state-key-no-supersession" }] });
        byKey.delete(key);
    }
    current.push(...byKey.values());
    return { current, conflicts };
}
export function resolveHistoryLifecycles(records) {
    const ordered = [...records].sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id));
    const signatures = new Map();
    const commandResources = new Map();
    const explicitTasks = new Map();
    const explicitRelations = new Map();
    const taskClosers = new Map();
    const add = (map, key, record) => {
        if (!key)
            return;
        const values = map.get(key) ?? [];
        values.push(record);
        map.set(key, values);
    };
    for (const candidate of ordered) {
        if (candidate.successEvidence === true) {
            add(signatures, candidate.failureSignature, candidate);
            add(commandResources, candidate.commandIdentity && candidate.resourceIdentity
                ? `${candidate.commandIdentity}\0${candidate.resourceIdentity}`
                : undefined, candidate);
            if (/\b(resolve|correct|fix)\b/i.test(candidate.cue ?? ""))
                add(explicitTasks, candidate.taskIdentity, candidate);
            for (const relation of candidate.relations) {
                if (relation.kind === "resolution")
                    add(explicitRelations, relation.targetRecordId, candidate);
            }
        }
        const userAcceptance = candidate.sourceAuthority === "user" && /\b(accept(?:ed|ance)?|approved)\b/i.test(candidate.cue ?? "");
        const recorded = candidate.sourceAuthority === "project" && /\bcompleted\b/i.test(candidate.cue ?? "");
        const validation = candidate.resourceRole === "validation" && candidate.successEvidence === true;
        if (userAcceptance || recorded || validation)
            add(taskClosers, candidate.taskIdentity, candidate);
    }
    const firstAfter = (values, sourceOrder) => {
        if (!values?.length)
            return undefined;
        let low = 0;
        let high = values.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (values[middle].sourceOrder.start <= sourceOrder)
                low = middle + 1;
            else
                high = middle;
        }
        return values[low];
    };
    const earliest = (values) => values.filter((value) => value !== undefined)
        .sort((a, b) => a.sourceOrder.start - b.sourceOrder.start || a.id.localeCompare(b.id))[0];
    return ordered.map(record => {
        if (record.category === "failure" && record.lifecycle === "unresolved") {
            const resolver = earliest([
                firstAfter(signatures.get(record.failureSignature ?? ""), record.sourceOrder.end),
                firstAfter(commandResources.get(record.commandIdentity && record.resourceIdentity
                    ? `${record.commandIdentity}\0${record.resourceIdentity}`
                    : ""), record.sourceOrder.end),
                firstAfter(explicitTasks.get(record.taskIdentity ?? ""), record.sourceOrder.end),
                firstAfter(explicitRelations.get(record.id), record.sourceOrder.end),
            ]);
            if (resolver)
                return {
                    ...record,
                    lifecycle: "resolved",
                    relations: [...record.relations, { kind: "resolution", targetRecordId: resolver.id, basis: "linked-success-evidence" }],
                };
        }
        if (record.category === "task-episode" && record.lifecycle === "open") {
            const closer = firstAfter(taskClosers.get(record.taskIdentity ?? ""), record.sourceOrder.end);
            if (closer)
                return {
                    ...record,
                    lifecycle: "closed",
                    relations: [...record.relations, { kind: "validation", targetRecordId: closer.id, basis: "linked-task-completion" }],
                };
        }
        return record;
    });
}
function combinedRecords(children) {
    return children.flatMap(child => child.nodeType === "leaf"
        ? child.valueRecords
        : [
            ...child.currentStateRecords,
            ...child.conflictRecords,
            ...child.unresolvedFailureRecords,
            ...child.currentResourceRecords,
            ...child.openTaskRecords,
            ...child.selectedImportantEvidence,
            ...child.closedEpisodeCapsules,
            ...child.archiveRangeRecords,
        ]);
}
function makeRollup(children, level, config, querySalt) {
    const combined = combinedRecords(children);
    const records = resolveHistoryLifecycles([...new Map(combined.map(record => [record.id, record])).values()]);
    const state = aggregateHistoryState(records.filter(record => record.category !== "archive-range"));
    const stateSelected = selectRecords(state.current, config, 0.25);
    const conflictSelected = selectRecords(state.conflicts, config, 0.15);
    const evidenceSelected = selectRecords(records.filter(record => !["archive-range"].includes(record.category)), config, 0.15);
    const archiveSelected = selectRecords(records.filter(record => record.category === "archive-range"), config, 0.1);
    const first = children[0];
    const last = children.at(-1);
    const counts = {};
    for (const child of children) {
        if (child.nodeType === "rollup") {
            for (const [category, count] of Object.entries(child.aggregateCounts)) {
                counts[category] = (counts[category] ?? 0) + count;
            }
        }
        else {
            for (const record of child.valueRecords)
                counts[record.category] = (counts[record.category] ?? 0) + 1;
        }
    }
    const base = {
        schemaVersion: 2,
        nodeType: "rollup",
        level,
        childNodeIds: children.map(child => child.nodeId),
        sourceRange: { startEntryId: first.sourceRange.startEntryId, endEntryId: last.sourceRange.endEntryId },
        branchOrderRange: { start: first.branchOrderRange.start, end: last.branchOrderRange.end },
        sourceEntryCount: children.reduce((sum, child) => sum + child.sourceEntryCount, 0),
        sourceTokenEstimate: children.reduce((sum, child) => sum + child.sourceTokenEstimate, 0),
        currentStateRecords: stateSelected.kept.filter(record => ["restriction", "goal", "decision", "next-action", "blocker", "status"].includes(record.category)),
        conflictRecords: conflictSelected.kept,
        unresolvedFailureRecords: stateSelected.kept.filter(record => record.category === "failure" && record.lifecycle === "unresolved"),
        currentResourceRecords: stateSelected.kept.filter(record => record.category === "resource-state"),
        openTaskRecords: stateSelected.kept.filter(record => record.category === "task-episode" && record.lifecycle === "open"),
        selectedImportantEvidence: evidenceSelected.kept.filter(record => !["restriction", "goal", "decision", "next-action", "blocker", "status", "failure", "resource-state", "task-episode", "archive-range"].includes(record.category)),
        closedEpisodeCapsules: stateSelected.kept.filter(record => record.category === "task-episode" && record.lifecycle === "closed"),
        archiveRangeRecords: [...archiveSelected.kept, ...archiveSelected.archives, ...stateSelected.archives, ...conflictSelected.archives, ...evidenceSelected.archives],
        aggregateCounts: counts,
        omittedRecordCounts: evidenceSelected.omitted,
        queryIndex: makeRollupQueryIndex(records, children, first.branchOrderRange.start, last.branchOrderRange.end, querySalt),
    };
    const ids = nodeIdentity(base);
    return withIntegrity({ ...base, ...ids });
}
function leafContexts(entries) {
    const contexts = new Map();
    for (const entry of entries) {
        if (entry.type !== "message")
            continue;
        const message = entry.message;
        if (!message)
            continue;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            const id = typeof part.id === "string" ? part.id : typeof part.toolCallId === "string" ? part.toolCallId : undefined;
            if (!id)
                continue;
            const toolName = typeof part.name === "string" ? part.name : typeof part.toolName === "string" ? part.toolName : undefined;
            const args = part.arguments && typeof part.arguments === "object" ? part.arguments : undefined;
            contexts.set(id, { toolName, toolArguments: args });
        }
    }
    return contexts;
}
function makeLeaf(contextEntries, ownEntries, ledgerEntries, branchStart, config, querySalt) {
    const blocks = parseHistoricalBlocks([...contextEntries, ...ownEntries], {
        includeHistoricalCompactions: false,
        includeMetadata: false,
    });
    const ownIds = new Set(ledgerEntries.map(entry => entry.entryId));
    const contexts = leafContexts(contextEntries);
    const ownBlocks = blocks.filter(block => ownIds.has(block.entryId));
    const selected = selectRecords(extractHistoryValues(ownBlocks, contexts).map(record => ({
        ...record,
        sourceOrder: {
            start: record.sourceOrder.start - contextEntries.length + branchStart,
            end: record.sourceOrder.end - contextEntries.length + branchStart,
        },
    })), config);
    const records = [...selected.kept, ...selected.archives];
    const first = ledgerEntries[0];
    const last = ledgerEntries.at(-1);
    const completedToolCallIds = new Set(blocks
        .filter(block => block.kind === "tool_result" && block.toolCallId)
        .map(block => block.toolCallId));
    const openCalls = [];
    let openCallBytes = 0;
    for (const block of blocks.slice().reverse()) {
        if (block.kind !== "tool_call" || !block.toolCallId || completedToolCallIds.has(block.toolCallId))
            continue;
        const bytes = Buffer.byteLength(block.entryId) + 16;
        if (openCalls.length >= 256)
            break;
        if (openCallBytes + bytes > 32 * 1024)
            continue;
        openCalls.push({ entryId: block.entryId });
        openCallBytes += bytes;
    }
    openCalls.reverse();
    const base = {
        schemaVersion: 2,
        nodeType: "leaf",
        sourceRange: { startEntryId: first.entryId, endEntryId: last.entryId },
        branchOrderRange: { start: branchStart, end: branchStart + ledgerEntries.length - 1 },
        sourceEntryCount: ledgerEntries.length,
        sourceTokenEstimate: ownBlocks.reduce((sum, block) => sum + block.rawTokens, 0),
        sourceByteRange: { start: first.sourceByteOffset, end: last.sourceByteOffset + last.sourceByteLength },
        firstSourceRef: { entryId: first.entryId },
        lastSourceRef: { entryId: last.entryId },
        sourceBlockCount: ownBlocks.length,
        valueRecords: records,
        archiveCoverage: selected.archives.map(record => structuredClone(record)),
        openContext: {
            openTaskIds: boundedIndexValues(records.filter(record => record.lifecycle === "open").flatMap(record => record.taskIdentity ? [record.taskIdentity] : []), 256, 32 * 1024),
            unresolvedFailureKeys: boundedIndexValues(records.filter(record => record.lifecycle === "unresolved").map(record => record.failureIdentity ?? record.stateKey), 256, 32 * 1024),
            openToolCallRefs: openCalls,
        },
        childCount: 0,
        queryIndex: makeQueryIndex(records, branchStart, branchStart + ledgerEntries.length - 1, querySalt),
    };
    const ids = nodeIdentity(base);
    return withIntegrity({ ...base, ...ids });
}
function extendLeaf(old, added, config, querySalt) {
    const selected = selectRecords([...old.valueRecords, ...added.valueRecords], config);
    const records = [...selected.kept, ...selected.archives];
    const base = {
        schemaVersion: 2,
        nodeType: "leaf",
        sourceRange: { startEntryId: old.sourceRange.startEntryId, endEntryId: added.sourceRange.endEntryId },
        branchOrderRange: { start: old.branchOrderRange.start, end: added.branchOrderRange.end },
        sourceEntryCount: old.sourceEntryCount + added.sourceEntryCount,
        sourceTokenEstimate: old.sourceTokenEstimate + added.sourceTokenEstimate,
        sourceByteRange: { start: old.sourceByteRange.start, end: added.sourceByteRange.end },
        firstSourceRef: old.firstSourceRef,
        lastSourceRef: added.lastSourceRef,
        sourceBlockCount: old.sourceBlockCount + added.sourceBlockCount,
        valueRecords: records,
        archiveCoverage: [...old.archiveCoverage, ...added.archiveCoverage, ...selected.archives].map(record => structuredClone(record)),
        openContext: {
            openTaskIds: [...new Set([...old.openContext.openTaskIds, ...added.openContext.openTaskIds])],
            unresolvedFailureKeys: [...new Set([...old.openContext.unresolvedFailureKeys, ...added.openContext.unresolvedFailureKeys])],
            openToolCallRefs: added.openContext.openToolCallRefs,
        },
        childCount: 0,
        queryIndex: makeQueryIndex(records, old.branchOrderRange.start, added.branchOrderRange.end, querySalt),
    };
    const ids = nodeIdentity(base);
    return withIntegrity({ ...base, ...ids });
}
function initialGroups(entries, start, config) {
    const groups = [];
    let at = start;
    while (at < entries.length) {
        let end = at;
        let bytes = 0;
        while (end < entries.length) {
            const nextBytes = bytes + entries[end].sourceByteLength;
            if (end > at && (end - at >= config.targetLeafEntries || nextBytes > config.targetLeafSourceBytes))
                break;
            bytes = nextBytes;
            end++;
        }
        groups.push({ start: at, end });
        at = end;
    }
    return groups;
}
async function boundedLeafGroups(runtime, ledger, entries, start) {
    const result = [];
    for (const group of initialGroups(entries, start, runtime.config)) {
        let cursor = group.start;
        while (cursor < group.end) {
            let end = group.end;
            while (end > cursor + 1) {
                const loaded = await readSourceLedgerEntries(runtime.sessionPath, ledger, entries.slice(cursor, end), { maximumGapBytes: 0 });
                const blocks = parseHistoricalBlocks(loaded.entries, { includeHistoricalCompactions: false, includeMetadata: false });
                if (blocks.length <= runtime.config.targetLeafBlocks)
                    break;
                end = Math.max(cursor + 1, cursor + Math.floor((end - cursor) / 2));
            }
            result.push({ start: cursor, end });
            cursor = end;
        }
    }
    return result;
}
function exactAppendSuffix(ledger, previous, requestedLeafId) {
    if (requestedLeafId === previous.branchLeafId)
        return [];
    const reverse = [];
    let current = ledger.entryById.get(requestedLeafId);
    const maximum = ledger.sourceOrder.length - previous.sourceBranchEntryCount + 1;
    while (current && current.entryId !== previous.branchLeafId && reverse.length <= maximum) {
        reverse.push(current);
        current = current.parentId ? ledger.entryById.get(current.parentId) : undefined;
    }
    if (!current || current.entryId !== previous.branchLeafId)
        return undefined;
    return reverse.reverse();
}
function emptyMetrics(transition, previous) {
    return {
        transition,
        sourceBytesRead: 0,
        entriesParsed: 0,
        blocksParsed: 0,
        nodesCreated: 0,
        nodesReused: previous?.reachableNodeCount ?? 0,
        leafNodesCreated: 0,
        rollupNodesCreated: 0,
        treeLevels: previous?.treeLevels ?? 0,
        updateElapsedMs: 0,
        maximumUpdateTimerDelayMs: 0,
        sourceBranchEntries: previous?.sourceBranchEntryCount ?? 0,
        sourceByteCoverage: previous?.sourceByteCoverage ?? 0,
        reachableNodeBytes: previous?.reachableNodeBytes ?? 0,
        manifestBytes: 0,
        sourceLedgerEntriesVisited: 0,
        newBranchEntriesVisited: 0,
        oldBranchEntriesVisited: 0,
        oldLeafDigestsChecked: 0,
        nodeDirectoryEntriesScanned: 0,
        oldNodesLoaded: 0,
        newNodesLoaded: 0,
        treePathNodesCreated: 0,
        exactHitFilesWritten: 0,
        integrityOk: true,
    };
}
export async function updateHistoryRollupStore(runtime, branchLeafId, options = {}) {
    const started = performance.now();
    let maximumDelay = 0;
    let expected = performance.now() + 10;
    await mkdir(join(runtime.directory, "nodes"), { recursive: true, mode: 0o700 });
    await mkdir(join(runtime.directory, "branches"), { recursive: true, mode: 0o700 });
    await mkdir(join(runtime.directory, "tmp"), { recursive: true, mode: 0o700 });
    await chmod(runtime.directory, 0o700);
    const release = await acquireHistoryRollupLock(runtime.directory, options.lockOptions);
    const timer = setInterval(() => {
        const now = performance.now();
        maximumDelay = Math.max(maximumDelay, now - expected);
        expected = now + 10;
    }, 10);
    try {
        await options.lockAcquired?.();
        if (options.signal?.aborted)
            throw new Error("history-rollup-aborted");
        const manifestExists = await stat(join(runtime.directory, "manifest.json")).then(() => true).catch(() => false);
        const oldMain = await loadHistoryRollupManifest(runtime);
        const previous = oldMain ? await loadHistoryBranchManifest(runtime) : undefined;
        const ledgerBefore = runtime.ledger;
        const ledger = runtime.ledger = await updateSourceLedger(runtime.sessionPath, ledgerBefore);
        const configHash = configurationHash(runtime.config);
        let transition = oldMain ? "append" : manifestExists ? "manifest-corruption" : "new";
        let prior = previous;
        if (ledger.metrics.transition.startsWith("rebuild-")) {
            transition = ledger.metrics.transition === "rebuild-truncation"
                ? "source-truncation"
                : ledger.metrics.transition === "rebuild-replacement"
                    ? "source-replacement"
                    : "source-tail-rewrite";
            prior = undefined;
        }
        else if (oldMain && (oldMain.configurationHash !== configHash || oldMain.extractorVersionHash !== EXTRACTOR_VERSION)) {
            transition = oldMain.configurationHash !== configHash ? "configuration-change" : "extractor-change";
            prior = undefined;
        }
        if (prior && branchLeafId === prior.branchLeafId && ledger.metrics.transition === "exact-hit") {
            const metrics = emptyMetrics("exact-hit", prior);
            metrics.updateElapsedMs = performance.now() - started;
            metrics.maximumUpdateTimerDelayMs = maximumDelay;
            metrics.sourceLedgerEntriesVisited = ledger.metrics.entriesAppended;
            return metrics;
        }
        const suffix = prior ? exactAppendSuffix(ledger, prior, branchLeafId) : undefined;
        let branchEntries;
        let appendedStart = 0;
        if (prior && suffix) {
            transition = prior.openLeafState ? "append-open-leaf" : "append";
            branchEntries = suffix;
            appendedStart = prior.sourceBranchEntryCount;
        }
        else {
            const resolved = resolveSourceLedgerBranch(ledger, branchLeafId).entries;
            branchEntries = resolved;
            appendedStart = 0;
            if (prior)
                transition = "branch-switch-rebuild-tail";
        }
        const querySalt = oldMain?.querySalt ?? fullHash(`query:${ledger.sourceIdentity.deviceId}:${ledger.sourceIdentity.inodeId}`);
        const descriptors = prior && suffix ? [...prior.leafNodes] : [];
        let oldNodesLoaded = 0;
        let newNodesLoaded = 0;
        let sourceBytesRead = 0;
        let entriesParsed = 0;
        let blocksParsed = 0;
        let nodesCreated = 0;
        let nodesReused = descriptors.length;
        let leafNodesCreated = 0;
        let rollupNodesCreated = 0;
        let reachableNodeBytes = prior && suffix ? prior.reachableNodeBytes : 0;
        let cursor = 0;
        let activeOpenToolRefs = prior?.openToolCallRefs ?? [];
        let allEntries;
        if (prior && suffix) {
            allEntries = suffix;
            if (prior.openLeafState && descriptors.at(-1)?.sealed === false) {
                const oldDescriptor = descriptors.pop();
                const oldNode = await loadHistoryNode(runtime, oldDescriptor.nodeId);
                oldNodesLoaded++;
                if (oldNode.nodeType !== "leaf")
                    throw new Error("history-rollup-node-type");
                let fill = 0;
                let bytes = oldDescriptor.sourceBytes;
                let count = oldDescriptor.entryCount;
                while (fill < suffix.length) {
                    const next = suffix[fill];
                    if (fill > 0 && (count >= runtime.config.targetLeafEntries || bytes + next.sourceByteLength > runtime.config.targetLeafSourceBytes))
                        break;
                    bytes += next.sourceByteLength;
                    count++;
                    fill++;
                    if (count >= runtime.config.targetLeafEntries || bytes >= runtime.config.targetLeafSourceBytes)
                        break;
                }
                if (fill) {
                    const selected = suffix.slice(0, fill);
                    const contextRefs = prior.openToolCallRefs;
                    const contextLedger = contextRefs.flatMap(ref => ledger.entryById.get(ref.entryId) ?? []);
                    const contextLoaded = contextLedger.length
                        ? await readSourceLedgerEntries(runtime.sessionPath, ledger, contextLedger, { maximumGapBytes: 0 })
                        : { entries: [], metrics: { totalSourceBytesRead: 0 } };
                    const loaded = await readSourceLedgerEntries(runtime.sessionPath, ledger, selected, { maximumGapBytes: 0 });
                    const addition = makeLeaf(contextLoaded.entries, loaded.entries, selected, appendedStart, runtime.config, querySalt);
                    const node = extendLeaf(oldNode, addition, runtime.config, querySalt);
                    sourceBytesRead += loaded.metrics.totalSourceBytesRead + contextLoaded.metrics.totalSourceBytesRead;
                    entriesParsed += loaded.entries.length;
                    blocksParsed += addition.sourceBlockCount;
                    const written = await writeNode(runtime, node, options.directorySync);
                    if (written.created) {
                        nodesCreated++;
                        leafNodesCreated++;
                        reachableNodeBytes += written.bytes;
                    }
                    else
                        nodesReused++;
                    const sealed = fill < suffix.length || count >= runtime.config.targetLeafEntries || bytes >= runtime.config.targetLeafSourceBytes || node.sourceBlockCount >= runtime.config.targetLeafBlocks;
                    activeOpenToolRefs = node.openContext.openToolCallRefs;
                    descriptors.push({
                        nodeId: node.nodeId,
                        branchStart: oldDescriptor.branchStart,
                        branchEnd: appendedStart + fill - 1,
                        firstEntryId: oldDescriptor.firstEntryId,
                        lastEntryId: selected.at(-1).entryId,
                        entryCount: oldDescriptor.entryCount + fill,
                        sourceBytes: bytes,
                        sourceBlocks: node.sourceBlockCount,
                        sealed,
                        nodeBytes: written.bytes,
                    });
                    cursor = fill;
                }
            }
        }
        else
            allEntries = branchEntries;
        const groupStartOrder = prior && suffix ? appendedStart + cursor : cursor;
        const groups = await boundedLeafGroups(runtime, ledger, allEntries, cursor);
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            if (options.signal?.aborted)
                throw new Error("history-rollup-aborted");
            const group = groups[groupIndex];
            const selected = allEntries.slice(group.start, group.end);
            const contextRefs = activeOpenToolRefs;
            const contextLedger = contextRefs.flatMap(ref => ledger.entryById.get(ref.entryId) ?? []);
            const contextLoaded = contextLedger.length
                ? await readSourceLedgerEntries(runtime.sessionPath, ledger, contextLedger, { maximumGapBytes: 0 })
                : { entries: [], metrics: { totalSourceBytesRead: 0 } };
            const loaded = await readSourceLedgerEntries(runtime.sessionPath, ledger, selected, { maximumGapBytes: 0 });
            const branchStart = (prior && suffix ? appendedStart : 0) + group.start;
            const node = makeLeaf(contextLoaded.entries, loaded.entries, selected, branchStart, runtime.config, querySalt);
            const prospectiveNodeBytes = Buffer.byteLength(stableStringify(node)) + 1;
            if (prospectiveNodeBytes > runtime.config.maximumNodeBytes && selected.length > 1) {
                const middle = group.start + Math.floor(selected.length / 2);
                groups.splice(groupIndex, 1, { start: group.start, end: middle }, { start: middle, end: group.end });
                groupIndex -= 1;
                continue;
            }
            sourceBytesRead += loaded.metrics.totalSourceBytesRead + contextLoaded.metrics.totalSourceBytesRead;
            entriesParsed += loaded.entries.length;
            blocksParsed += node.sourceBlockCount;
            const written = await writeNode(runtime, node, options.directorySync);
            if (written.created) {
                nodesCreated++;
                leafNodesCreated++;
                reachableNodeBytes += written.bytes;
            }
            else
                nodesReused++;
            const selectedBytes = selected.reduce((sum, entry) => sum + entry.sourceByteLength, 0);
            const sealed = groupIndex < groups.length - 1 ||
                selected.length >= runtime.config.targetLeafEntries ||
                selectedBytes >= runtime.config.targetLeafSourceBytes ||
                node.sourceBlockCount >= runtime.config.targetLeafBlocks;
            activeOpenToolRefs = node.openContext.openToolCallRefs;
            descriptors.push({
                nodeId: node.nodeId,
                branchStart,
                branchEnd: branchStart + selected.length - 1,
                firstEntryId: selected[0].entryId,
                lastEntryId: selected.at(-1).entryId,
                entryCount: selected.length,
                sourceBytes: selectedBytes,
                sourceBlocks: node.sourceBlockCount,
                sealed,
                nodeBytes: written.bytes,
            });
        }
        const levels = [];
        const levelNodeBytes = [];
        let ids = descriptors.map(descriptor => descriptor.nodeId);
        let level = 1;
        while (ids.length > 1) {
            const next = [];
            const nextBytes = [];
            for (let at = 0; at < ids.length; at += runtime.config.fanout) {
                const childIds = ids.slice(at, at + runtime.config.fanout);
                const oldId = prior?.levels[level - 1]?.[Math.floor(at / runtime.config.fanout)];
                const oldChildren = level === 1
                    ? prior?.leafNodes.slice(at, at + childIds.length).map(descriptor => descriptor.nodeId)
                    : prior?.levels[level - 2]?.slice(at, at + childIds.length);
                if (oldId && oldChildren && childIds.every((id, index) => oldChildren[index] === id)) {
                    next.push(oldId);
                    nextBytes.push(prior?.levelNodeBytes[level - 1]?.[Math.floor(at / runtime.config.fanout)] ?? 0);
                    nodesReused++;
                    continue;
                }
                const children = await Promise.all(childIds.map(async (id) => {
                    const node = await loadHistoryNode(runtime, id);
                    if (prior && prior.levels.flat().includes(id))
                        oldNodesLoaded++;
                    else
                        newNodesLoaded++;
                    return node;
                }));
                const node = makeRollup(children, level, runtime.config, querySalt);
                const written = await writeNode(runtime, node, options.directorySync);
                if (written.created) {
                    nodesCreated++;
                    rollupNodesCreated++;
                    reachableNodeBytes += written.bytes;
                }
                else
                    nodesReused++;
                next.push(node.nodeId);
                nextBytes.push(written.bytes);
            }
            levels.push(next);
            levelNodeBytes.push(nextBytes);
            ids = next;
            level++;
        }
        if (ids.length === 1 && levels.length === 0) {
            levels.push(ids);
            levelNodeBytes.push([descriptors[0]?.nodeBytes ?? 0]);
        }
        const root = ids[0];
        const now = new Date().toISOString();
        const sourceBranchEntryCount = prior && suffix ? prior.sourceBranchEntryCount + suffix.length : branchEntries.length;
        const sourceByteCoverage = descriptors.reduce((sum, descriptor) => sum + descriptor.sourceBytes, 0);
        const openLeaf = descriptors.at(-1);
        const rootNode = root ? await loadHistoryNode(runtime, root) : undefined;
        const openContext = openLeaf ? await loadHistoryNode(runtime, openLeaf.nodeId) : undefined;
        const openLeafNode = openContext?.nodeType === "leaf" ? openContext : undefined;
        const reachableBytesById = new Map();
        for (const descriptor of descriptors)
            reachableBytesById.set(descriptor.nodeId, descriptor.nodeBytes);
        for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
            for (let nodeIndex = 0; nodeIndex < levels[levelIndex].length; nodeIndex++) {
                reachableBytesById.set(levels[levelIndex][nodeIndex], levelNodeBytes[levelIndex][nodeIndex] ?? 0);
            }
        }
        const reachableNodeCount = reachableBytesById.size;
        reachableNodeBytes = [...reachableBytesById.values()].reduce((sum, bytes) => sum + bytes, 0);
        const rollupCount = Math.max(0, reachableNodeCount - descriptors.length);
        const branchBase = {
            schemaVersion: 2,
            branchLeafId,
            branchRootId: descriptors[0]?.firstEntryId ?? branchLeafId,
            sourceLedgerIdentity: {
                deviceId: ledger.sourceIdentity.deviceId,
                inodeId: ledger.sourceIdentity.inodeId,
                checkpointHash: ledger.checkpoint.ledgerRecordHash,
            },
            sourceLedgerIntegrityState: "verified",
            sourceBranchEntryCount,
            sourceByteCoverage,
            leafNodes: descriptors,
            levels,
            levelNodeBytes,
            rootRollupNodeId: root,
            openLeafState: openLeaf && !openLeaf.sealed
                ? { nodeId: openLeaf.nodeId, start: openLeaf.branchStart, end: openLeaf.branchEnd }
                : null,
            openTaskState: openLeafNode?.openContext.openTaskIds ?? [],
            unresolvedFailureState: openLeafNode?.openContext.unresolvedFailureKeys ?? [],
            openToolCallRefs: openLeafNode?.openContext.openToolCallRefs ?? [],
            storeConfigurationHash: configHash,
            extractorVersionHash: EXTRACTOR_VERSION,
            branchGeneration: (prior?.branchGeneration ?? 0) + 1,
            creationTime: prior?.creationTime ?? now,
            updateTime: now,
            reachableNodeCount,
            reachableNodeBytes,
            leafCount: descriptors.length,
            rollupCount,
            treeLevels: levels.length,
            sourceEntryCount: sourceBranchEntryCount,
        };
        const branch = withIntegrity(branchBase);
        const branchRef = `${fullHash(stableStringify(branch))}.json`;
        await atomicJson(join(runtime.directory, "branches", branchRef), branch, options.directorySync);
        const recent = [branchRef, ...(oldMain?.recentBranchManifestReferences ?? []).filter(ref => ref !== branchRef)]
            .slice(0, runtime.config.recentBranchLimit);
        const mainBase = {
            schemaVersion: 2,
            sourceIdentity: ledger.sourceIdentity,
            sourceSessionIdentity: ledger.sourceSessionIdentity,
            activeBranchManifestReference: branchRef,
            recentBranchManifestReferences: recent,
            querySalt,
            configurationHash: configHash,
            extractorVersionHash: EXTRACTOR_VERSION,
            manifestGeneration: (oldMain?.manifestGeneration ?? 0) + 1,
            reachableNodeCount,
            reachableNodeBytes,
            leafCount: descriptors.length,
            rollupCount,
            treeLevels: levels.length,
            sourceEntryCount: sourceBranchEntryCount,
            sourceByteCoverage,
        };
        const main = withIntegrity(mainBase);
        await options.beforePublish?.();
        if (options.signal?.aborted)
            throw new Error("history-rollup-aborted");
        const manifestBytes = await atomicJson(join(runtime.directory, "manifest.json"), main, options.directorySync);
        runtime.manifest = main;
        runtime.branchManifest = branch;
        if (transition === "branch-switch-rebuild-tail" && nodesReused > 0)
            transition = "branch-switch-reuse";
        const metrics = {
            transition,
            sourceBytesRead,
            entriesParsed,
            blocksParsed,
            nodesCreated,
            nodesReused,
            leafNodesCreated,
            rollupNodesCreated,
            treeLevels: levels.length,
            updateElapsedMs: performance.now() - started,
            maximumUpdateTimerDelayMs: maximumDelay,
            sourceBranchEntries: sourceBranchEntryCount,
            sourceByteCoverage,
            reachableNodeBytes,
            manifestBytes,
            sourceLedgerEntriesVisited: ledger.metrics.entriesAppended,
            newBranchEntriesVisited: suffix?.length ?? branchEntries.length,
            oldBranchEntriesVisited: suffix ? 0 : prior?.sourceBranchEntryCount ?? 0,
            oldLeafDigestsChecked: 0,
            nodeDirectoryEntriesScanned: 0,
            oldNodesLoaded,
            newNodesLoaded,
            treePathNodesCreated: rollupNodesCreated,
            exactHitFilesWritten: 0,
            integrityOk: Boolean(rootNode),
        };
        return metrics;
    }
    finally {
        clearInterval(timer);
        await release();
    }
}
export async function readCurrentHistorySnapshot(runtime) {
    const manifest = runtime.manifest ?? await loadHistoryRollupManifest(runtime);
    const branch = runtime.branchManifest ?? await loadHistoryBranchManifest(runtime);
    if (!manifest || !branch)
        return undefined;
    return loadHistoryNode(runtime, branch.rootRollupNodeId);
}
export async function loadRecentHistoryLeavesByTokens(runtime, sourceTokens) {
    const branch = runtime.branchManifest ?? await loadHistoryBranchManifest(runtime);
    if (!branch)
        return [];
    const selected = [];
    let tokens = 0;
    for (let index = branch.leafNodes.length - 1; index >= 0 && selected.length < runtime.config.recentLeafSafetyLimit; index--) {
        const descriptor = branch.leafNodes[index];
        selected.push(descriptor);
        const node = await loadHistoryNode(runtime, descriptor.nodeId);
        tokens += node.sourceTokenEstimate;
        if (tokens >= sourceTokens)
            break;
    }
    const nodes = await Promise.all(selected.reverse().map(descriptor => loadHistoryNode(runtime, descriptor.nodeId)));
    return nodes.map(node => {
        if (node.nodeType !== "leaf")
            throw new Error("history-rollup-node-type");
        return node;
    });
}
export async function loadRecentHistoryLeaves(runtime, limit = 2) {
    const branch = runtime.branchManifest ?? await loadHistoryBranchManifest(runtime);
    if (!branch)
        return [];
    const descriptors = branch.leafNodes.slice(-Math.max(1, limit));
    const nodes = await Promise.all(descriptors.map(descriptor => loadHistoryNode(runtime, descriptor.nodeId)));
    return nodes.map(node => {
        if (node.nodeType !== "leaf")
            throw new Error("history-rollup-node-type");
        return node;
    });
}
export async function cleanupHistoryRollupStore(runtime) {
    const release = await acquireHistoryRollupLock(runtime.directory);
    try {
        const manifest = runtime.manifest ?? await loadHistoryRollupManifest(runtime);
        if (!manifest)
            return { nodesRemoved: 0, branchesRemoved: 0 };
        // Physical cleanup is intentionally a separate maintenance operation.
        // It may scan the store, unlike normal update and exact-hit paths.
        const { readdir } = await import("node:fs/promises");
        const keepBranches = new Set([manifest.activeBranchManifestReference, ...manifest.recentBranchManifestReferences]);
        const keepNodes = new Set();
        for (const ref of keepBranches) {
            const branch = await loadHistoryBranchManifest(runtime, ref);
            if (!branch)
                continue;
            for (const leaf of branch.leafNodes)
                keepNodes.add(leaf.nodeId);
            for (const id of branch.levels.flat())
                keepNodes.add(id);
        }
        let branchesRemoved = 0;
        for (const file of await readdir(join(runtime.directory, "branches"))) {
            if (!keepBranches.has(file)) {
                await rm(join(runtime.directory, "branches", file), { force: true });
                branchesRemoved++;
            }
        }
        let nodesRemoved = 0;
        for (const file of await readdir(join(runtime.directory, "nodes"))) {
            if (file.endsWith(".json") && !keepNodes.has(file.slice(0, -5))) {
                await rm(join(runtime.directory, "nodes", file), { force: true });
                runtime.cache.delete(file.slice(0, -5));
                nodesRemoved++;
            }
        }
        return { nodesRemoved, branchesRemoved };
    }
    finally {
        await release();
    }
}
//# sourceMappingURL=history-rollup-store.js.map