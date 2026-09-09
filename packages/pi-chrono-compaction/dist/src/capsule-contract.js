/**
 * Pure M05 protocol and persisted-value contract. Importing this module performs
 * no filesystem work, loads no SQLite binding, and starts no worker.
 */
export const CAPSULE_PROTOCOL_VERSION = 1;
/** Pipeline identity for corrected reducer selection/scanning semantics. */
export const CAPSULE_REDUCER_PIPELINE_VERSION = "capsule-pure-v5";
export const CAPSULE_SCHEMA_VERSION = 1;
export const DERIVED_SCHEMA_VERSION = 2;
export const CHUNK_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const CAPSULE_TEXT_HASH = "chrono-utf16le-chain-sha256-v1";
export const CHUNK_CONTENT_HASH = "sha256-utf16le-v1";
export const SEGMENT_CONTENT_HASH = "sha256-bytes-v1";
export const CAPSULE_LIMITS = Object.freeze({
    requestBytes: 64 * 1024,
    responseBytes: 256 * 1024,
    sourceBytesPerJob: 8 * 1024 * 1024,
    sourceReadBytes: 64 * 1024,
    nativeSqliteBytes: 64 * 1024 * 1024,
    decodedChunkUnits: 32_768,
    decodedChunkBytes: 65_536,
    deriveEvents: 64,
    deriveDescriptors: 256,
    page: 16,
    rangeChunks: 16,
    reducerInputUnits: 32_768,
    reducerAlternatives: 8,
    reducerOutputUnits: 64 * 1024,
    ancestry: 64,
    manifestSegments: 16,
    segmentBytes: 8 * 1024 * 1024,
    workerV8Bytes: 128 * 1024 * 1024,
    workerRssBytes: 256 * 1024 * 1024,
    workerDeadlineMs: 30_000,
});
export const SOURCE_REDUCER_FAMILIES = Object.freeze([
    "terminal", "test-output", "git-diff", "generic-text", "assistant-extractive",
    "assistant-cleanup", "lossless-normalizer", "small-json",
]);
/** These decisions need request/cut context and cannot be persisted as source-local reducer output. */
export const ADAPTER_ONLY_DECISIONS = Object.freeze([
    "contextual-relevance", "file-read", "search-results", "llm-semantic",
    "repeat-factoring", "resource-lineage", "current-state", "cut-selection",
]);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (x) => Number.isSafeInteger(x) && Number(x) >= 0;
const positive = (x) => integer(x) && Number(x) > 0;
const key = (x) => typeof x === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const version = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(x);
const uuid = (x) => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const hash = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const path = (x) => typeof x === "string" && x.startsWith("/") && x.length <= 4096 && !x.includes("\0") && !/[\ud800-\udfff]/u.test(x);
const range = (x) => object(x) && integer(x.start) && integer(x.end) && x.start <= x.end;
const boundedText = (x, units) => typeof x === "string" && x.length <= units;
const enumValue = (values, x) => typeof x === "string" && values.includes(x);
const byteSizeWithin = (value, limit) => {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8") <= limit;
    }
    catch {
        return false;
    }
};
export function isDerivedStoreIdentity(value) {
    if (!object(value))
        return false;
    return uuid(value.storeKey) && key(value.sessionKey) && uuid(value.catalogStoreKey) && positive(value.catalogGeneration)
        && value.derivedSchemaVersion === DERIVED_SCHEMA_VERSION && value.capsuleSchemaVersion === CAPSULE_SCHEMA_VERSION
        && value.chunkSchemaVersion === CHUNK_SCHEMA_VERSION && version(value.reducerSetVersion) && hash(value.configHash);
}
export function isCapsuleCatalogView(value) {
    if (!object(value) || !uuid(value.storeKey) || !key(value.sessionKey) || !positive(value.generation)
        || !positive(value.eventCut) || !key(value.branchKey) || !Array.isArray(value.segments)
        || value.segments.length < 1 || value.segments.length > CAPSULE_LIMITS.ancestry)
        return false;
    const seen = new Set();
    for (const segment of value.segments) {
        if (!object(segment) || !positive(segment.segment) || !positive(segment.cut) || segment.cut > value.eventCut || seen.has(segment.segment))
            return false;
        seen.add(segment.segment);
    }
    return true;
}
function identitiesMatch(identity, view) {
    return identity.sessionKey === view.sessionKey && identity.catalogStoreKey === view.storeKey && identity.catalogGeneration === view.generation;
}
export function isScopedSourceRef(value) {
    if (!object(value) || !uuid(value.catalogStoreKey) || !key(value.sessionKey) || !positive(value.catalogGeneration)
        || !key(value.shardKey) || !positive(value.segment) || !positive(value.eventSeq) || !positive(value.ordinal)
        || !integer(value.descriptor) || (value.blockIndex !== undefined && !integer(value.blockIndex))
        || typeof value.field !== "string" || value.field.length < 1 || value.field.length > 64 || !range(value.raw)
        || (value.entryId !== undefined && (typeof value.entryId !== "string" || value.entryId.length > 1024)))
        return false;
    if (value.coordinateKind === "decoded-body") {
        return range(value.decodedUtf16) && value.bodyHashAlgorithm === CAPSULE_TEXT_HASH && hash(value.bodyHash);
    }
    return value.coordinateKind === "raw-json" && value.rawHashAlgorithm === SEGMENT_CONTENT_HASH && hash(value.rawHash);
}
export function isScopedRawSourceRef(value) {
    return isScopedSourceRef(value) && value.coordinateKind === "raw-json";
}
export function isScopedBodySourceRef(value) {
    return isScopedSourceRef(value) && value.coordinateKind === "decoded-body";
}
/** Structural bound check only. The worker must still select the ref through M04 CatalogView. */
export function sourceRefWithinViewBounds(source, view) {
    if (source.catalogStoreKey !== view.storeKey || source.sessionKey !== view.sessionKey || source.catalogGeneration !== view.generation || source.eventSeq > view.eventCut)
        return false;
    const segment = view.segments.find((candidate) => candidate.segment === source.segment);
    return segment !== undefined && source.eventSeq <= segment.cut;
}
function sameSource(a, b) {
    if (a.coordinateKind !== b.coordinateKind)
        return false;
    const base = a.catalogStoreKey === b.catalogStoreKey && a.sessionKey === b.sessionKey && a.catalogGeneration === b.catalogGeneration
        && a.shardKey === b.shardKey && a.segment === b.segment && a.eventSeq === b.eventSeq && a.ordinal === b.ordinal
        && a.descriptor === b.descriptor && a.blockIndex === b.blockIndex && a.field === b.field
        && a.raw.start === b.raw.start && a.raw.end === b.raw.end;
    return base && (a.coordinateKind === "decoded-body"
        ? b.coordinateKind === "decoded-body" && a.decodedUtf16.start === b.decodedUtf16.start && a.decodedUtf16.end === b.decodedUtf16.end && a.bodyHash === b.bodyHash
        : b.coordinateKind === "raw-json" && a.rawHash === b.rawHash);
}
function sameEventScope(a, b) {
    return a.catalogStoreKey === b.catalogStoreKey && a.sessionKey === b.sessionKey && a.catalogGeneration === b.catalogGeneration
        && a.shardKey === b.shardKey && a.segment === b.segment && a.eventSeq === b.eventSeq && a.ordinal === b.ordinal;
}
function position(source, view) {
    const rank = view.segments.findIndex((candidate) => candidate.segment === source.segment);
    return rank < 0 ? undefined : [rank, source.eventSeq, source.descriptor];
}
function before(a, b, view) {
    const pa = position(a, view);
    const pb = position(b, view);
    if (!pa || !pb)
        return false;
    return pa[0] < pb[0] || (pa[0] === pb[0] && (pa[1] < pb[1] || (pa[1] === pb[1] && pa[2] < pb[2])));
}
export function isCapsuleBodyDescriptor(value) {
    if (!object(value) || value.v !== 1 || !isScopedBodySourceRef(value.source) || !integer(value.decodedUnits)
        || value.utf16leBytes !== value.decodedUnits * 2 || !integer(value.chunkCount)
        || value.chunkCount !== Math.ceil(value.decodedUnits / CAPSULE_LIMITS.decodedChunkUnits)
        || value.bodyHashAlgorithm !== CAPSULE_TEXT_HASH || value.bodyHash !== value.source.bodyHash
        || value.decodedUnits !== value.source.decodedUtf16.end || !enumValue(["original", "generated", "mixed"], value.provenance)
        || !enumValue(["none", "image", "data"], value.opaque))
        return false;
    return value.source.decodedUtf16.start === 0;
}
export function isDecodedChunkDescriptor(value) {
    if (!object(value) || value.v !== 1 || !isScopedBodySourceRef(value.source) || !integer(value.chunkIndex)
        || !range(value.decodedUtf16) || value.decodedUtf16.start !== value.chunkIndex * CAPSULE_LIMITS.decodedChunkUnits
        || value.decodedUtf16.end > value.source.decodedUtf16.end
        || value.decodedUtf16.end - value.decodedUtf16.start > CAPSULE_LIMITS.decodedChunkUnits
        || value.utf16leBytes !== (value.decodedUtf16.end - value.decodedUtf16.start) * 2
        || value.contentHashAlgorithm !== CHUNK_CONTENT_HASH || !hash(value.contentHash) || !hash(value.segmentHash) || !integer(value.segmentOffset))
        return false;
    return value.decodedUtf16.end > value.decodedUtf16.start;
}
export function isChunkDecodeCursor(value) {
    if (!object(value) || value.v !== 1 || !isScopedBodySourceRef(value.source) || !integer(value.rawOffset) || !integer(value.decodedOffset)
        || value.rawOffset < value.source.raw.start || value.rawOffset > value.source.raw.end
        || value.decodedOffset < value.source.decodedUtf16.start || value.decodedOffset > value.source.decodedUtf16.end
        || typeof value.opened !== "boolean" || typeof value.jsonEscape !== "boolean" || !object(value.boundedHash) || value.boundedHash.algorithm !== CAPSULE_TEXT_HASH
        || !hash(value.boundedHash.chain) || !Array.isArray(value.boundedHash.pendingBytes) || value.boundedHash.pendingBytes.length > 2046
        || value.boundedHash.pendingBytes.length % 2 !== 0 || !value.boundedHash.pendingBytes.every((byte) => integer(byte) && byte <= 255)
        || !integer(value.boundedHash.units) || value.boundedHash.units !== value.decodedOffset
        || value.boundedHash.pendingBytes.length !== (value.complete ? 0 : (value.boundedHash.units % 1024) * 2)
        || !(value.chunkCarryUtf16le instanceof Uint8Array) || value.chunkCarryUtf16le.byteLength >= CAPSULE_LIMITS.decodedChunkBytes
        || value.chunkCarryUtf16le.byteLength % 2 !== 0 || typeof value.complete !== "boolean"
        || value.chunkCarryUtf16le.byteLength / 2 !== (value.complete ? 0 : value.decodedOffset % CAPSULE_LIMITS.decodedChunkUnits))
        return false;
    if (value.pendingUnicodeEscape !== null && (!object(value.pendingUnicodeEscape) || !integer(value.pendingUnicodeEscape.value)
        || !integer(value.pendingUnicodeEscape.digits) || value.pendingUnicodeEscape.digits > 3 || value.pendingUnicodeEscape.value > 0xffff))
        return false;
    if (value.pendingUtf8 !== null && (!object(value.pendingUtf8) || !integer(value.pendingUtf8.value)
        || !integer(value.pendingUtf8.bytesLeft) || value.pendingUtf8.bytesLeft < 1 || value.pendingUtf8.bytesLeft > 3
        || !integer(value.pendingUtf8.minimum) || value.pendingUtf8.minimum > 0x10000))
        return false;
    return !value.complete || (value.opened && value.rawOffset === value.source.raw.end && value.decodedOffset === value.source.decodedUtf16.end
        && !value.jsonEscape && value.pendingUnicodeEscape === null && value.pendingUtf8 === null && value.chunkCarryUtf16le.byteLength === 0);
}
export function isSourceBlockReducerInput(value) {
    if (!object(value) || value.v !== 1 || !isDerivedStoreIdentity(value.identity) || !isCapsuleCatalogView(value.view)
        || !identitiesMatch(value.identity, value.view) || !isScopedBodySourceRef(value.source) || !sourceRefWithinViewBounds(value.source, value.view)
        || !enumValue(["user", "assistant-reasoning", "assistant-text", "tool-call", "tool-result", "bash-execution", "branch-summary", "custom-message", "model-change", "thinking-level-change", "historical-compaction", "metadata", "unknown"], value.kind)
        || !enumValue(["original", "generated", "mixed"], value.provenance) || !object(value.structural) || !object(value.window)
        || !range(value.window.decodedUtf16) || value.window.decodedUtf16.start < value.source.decodedUtf16.start
        || value.window.decodedUtf16.end > value.source.decodedUtf16.end || !boundedText(value.window.text, CAPSULE_LIMITS.reducerInputUnits)
        || value.window.text.length !== value.window.decodedUtf16.end - value.window.decodedUtf16.start
        || typeof value.window.completeBody !== "boolean" || !integer(value.window.omittedBeforeUnits) || !integer(value.window.omittedAfterUnits)
        || value.window.omittedBeforeUnits !== value.window.decodedUtf16.start - value.source.decodedUtf16.start
        || value.window.omittedAfterUnits !== value.source.decodedUtf16.end - value.window.decodedUtf16.end)
        return false;
    if (value.window.completeBody !== (value.window.omittedBeforeUnits === 0 && value.window.omittedAfterUnits === 0))
        return false;
    if (value.window.completeBody && value.source.decodedUtf16.end - value.source.decodedUtf16.start > CAPSULE_LIMITS.reducerInputUnits)
        return false;
    const s = value.structural;
    const fields = ["role", "toolName", "toolCallId", "exitCode", "isError", "cancelled", "originallyTruncated"];
    if (Object.keys(s).some(key => key !== "sources" && !fields.includes(key)))
        return false;
    if (s.sources !== undefined && (!object(s.sources) || Object.keys(s.sources).some(key => !fields.includes(key) || s[key] === undefined)))
        return false;
    for (const field of fields) {
        if (s[field] === undefined)
            continue;
        if (!object(s.sources) || !isScopedRawSourceRef(s.sources[field]) || !sameEventScope(s.sources[field], value.source))
            return false;
    }
    return (s.role === undefined || boundedText(s.role, 64)) && (s.toolName === undefined || boundedText(s.toolName, 128))
        && (s.toolCallId === undefined || boundedText(s.toolCallId, 1024)) && (s.exitCode === undefined || Number.isSafeInteger(s.exitCode))
        && (s.isError === undefined || typeof s.isError === "boolean") && (s.cancelled === undefined || typeof s.cancelled === "boolean")
        && (s.originallyTruncated === undefined || typeof s.originallyTruncated === "boolean");
}
function sourceRangeWithin(child, source) {
    return child.start >= source.decodedUtf16.start && child.end <= source.decodedUtf16.end;
}
function isFact(value, capsuleSource) {
    if (!object(value) || !enumValue(["structural", "extractive"], value.kind) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 64
        || (!["string", "number", "boolean"].includes(typeof value.value) && value.value !== null)
        || !isScopedSourceRef(value.source) || !sameEventScope(value.source, capsuleSource))
        return false;
    if (value.kind === "structural")
        return isScopedRawSourceRef(value.source) && value.decodedUtf16 === undefined;
    return isScopedBodySourceRef(value.source) && range(value.decodedUtf16) && sourceRangeWithin(value.decodedUtf16, value.source);
}
function isCue(value, source) {
    return object(value) && enumValue(["condition", "exception", "negation", "failure", "unknown", "cancelled", "pending-approval", "restriction", "identifier"], value.kind)
        && isScopedBodySourceRef(value.source) && sameSource(value.source, source) && range(value.decodedUtf16)
        && sourceRangeWithin(value.decodedUtf16, source) && boundedText(value.exactText, 8192)
        && value.exactText.length === value.decodedUtf16.end - value.decodedUtf16.start;
}
function isOmission(value, source) {
    if (!object(value) || !boundedText(value.description, 512))
        return false;
    if (value.kind === "exact-range") {
        return enumValue(["outside-window", "middle", "routine", "opaque", "budget", "unsupported"], value.reason)
            && isScopedBodySourceRef(value.source) && sameSource(value.source, source) && range(value.decodedUtf16)
            && sourceRangeWithin(value.decodedUtf16, source) && positive(value.omittedUnits)
            && value.omittedUnits === value.decodedUtf16.end - value.decodedUtf16.start;
    }
    return value.kind === "transformation-loss" && enumValue(["repeated", "normalization", "routine", "middle", "budget"], value.reason)
        && isScopedBodySourceRef(value.affectedSource) && sameSource(value.affectedSource, source)
        && range(value.affectedDecodedUtf16) && sourceRangeWithin(value.affectedDecodedUtf16, source)
        && value.omittedUnits === "unknown";
}
export function isReducerEnvelope(value) {
    if (!object(value) || value.v !== 1 || value.capsuleSchemaVersion !== CAPSULE_SCHEMA_VERSION
        || !isDerivedStoreIdentity(value.identity) || !isScopedBodySourceRef(value.source)
        || !enumValue(["original", "generated", "mixed"], value.provenance)
        || value.source.catalogStoreKey !== value.identity.catalogStoreKey || value.source.sessionKey !== value.identity.sessionKey
        || value.source.catalogGeneration !== value.identity.catalogGeneration || !enumValue(SOURCE_REDUCER_FAMILIES, value.family)
        || !version(value.familyVersion) || value.reducerSetVersion !== value.identity.reducerSetVersion || value.configHash !== value.identity.configHash
        || !object(value.budget) || !positive(value.budget.maxTokens) || !positive(value.budget.maxUtf16Units)
        || value.budget.maxUtf16Units > CAPSULE_LIMITS.reducerOutputUnits || !positive(value.budget.maxAlternatives)
        || value.budget.maxAlternatives > CAPSULE_LIMITS.reducerAlternatives || !hash(value.inputHash)
        || !Array.isArray(value.alternatives) || value.alternatives.length < 1 || value.alternatives.length > value.budget.maxAlternatives)
        return false;
    const source = value.source;
    const budget = value.budget;
    if (value.pair !== undefined) {
        const pair = value.pair;
        if (!object(pair) || pair.kind !== "paired-call" || pair.verifiedBy !== "catalog-view-ancestry-v1"
            || !isScopedSourceRef(pair.call) || !isScopedBodySourceRef(pair.result) || !sameSource(pair.result, source)
            || pair.call.catalogStoreKey !== source.catalogStoreKey || pair.call.sessionKey !== source.sessionKey
            || pair.call.catalogGeneration !== source.catalogGeneration
            || !(pair.call.eventSeq < pair.result.eventSeq || pair.call.eventSeq === pair.result.eventSeq && pair.call.descriptor < pair.result.descriptor))
            return false;
    }
    const pairedCall = value.pair !== undefined && object(value.pair) && isScopedSourceRef(value.pair.call) ? value.pair.call : undefined;
    const alternatives = value.alternatives;
    for (let index = 0; index < alternatives.length; index += 1) {
        const item = alternatives[index];
        if (!object(item) || item.alternative !== index || item.family !== value.family || item.familyVersion !== value.familyVersion
            || item.maxTokens !== budget.maxTokens || item.lossy !== true || !boundedText(item.text, budget.maxUtf16Units)
            || !Array.isArray(item.facts) || !item.facts.every((fact) => isFact(fact, source))
            || !Array.isArray(item.protectedCues) || !item.protectedCues.every((cue) => isCue(cue, source))
            || !Array.isArray(item.omissions) || !item.omissions.every((omission) => isOmission(omission, source))
            || !Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1
            || !item.sourceRefs.every((candidate) => isScopedSourceRef(candidate) && (sameEventScope(candidate, source)
                || pairedCall !== undefined && sameSource(candidate, pairedCall)))
            || !item.sourceRefs.some((candidate) => isScopedSourceRef(candidate) && sameSource(candidate, source)) || !object(item.outcome))
            return false;
        const facts = item.facts;
        if (item.outcome.status === "unknown") {
            if (Object.keys(item.outcome).length !== 1)
                return false;
        }
        else if (item.outcome.status === "supported") {
            if (!enumValue(["success", "failure", "cancelled", "pending-approval"], item.outcome.value)
                || !Array.isArray(item.outcome.facts) || item.outcome.facts.length < 1
                || !item.outcome.facts.every((factIndex) => typeof factIndex === "number" && integer(factIndex) && factIndex < facts.length
                    && object(facts[factIndex]) && facts[factIndex].kind === "structural"))
                return false;
        }
        else
            return false;
    }
    return byteSizeWithin(value, CAPSULE_LIMITS.responseBytes);
}
export function isDeriveCursor(value) {
    if (!object(value) || value.v !== 1 || !isDerivedStoreIdentity(value.identity) || !isCapsuleCatalogView(value.view)
        || !identitiesMatch(value.identity, value.view) || !integer(value.afterEventSeq) || value.afterEventSeq > value.view.eventCut
        || !integer(value.afterDescriptor) || !integer(value.bodyRawOffset) || !integer(value.bodyDecodedOffset))
        return false;
    if (value.afterEventSeq === 0 && value.afterDescriptor !== 0)
        return false;
    if (value.partialBody !== undefined) {
        if (!object(value.partialBody) || !isScopedBodySourceRef(value.partialBody.source) || !hash(value.partialBody.stateHash)
            || !sourceRefWithinViewBounds(value.partialBody.source, value.view) || value.afterEventSeq !== value.partialBody.source.eventSeq
            || value.afterDescriptor !== value.partialBody.source.descriptor || value.bodyRawOffset < value.partialBody.source.raw.start
            || value.bodyRawOffset > value.partialBody.source.raw.end || value.bodyDecodedOffset < value.partialBody.source.decodedUtf16.start
            || value.bodyDecodedOffset > value.partialBody.source.decodedUtf16.end)
            return false;
    }
    else if (value.bodyRawOffset !== 0 || value.bodyDecodedOffset !== 0)
        return false;
    return true;
}
function order3(a, b) {
    return a.eventSeq < b.eventSeq || (a.eventSeq === b.eventSeq && (a.descriptor < b.descriptor
        || (a.descriptor === b.descriptor && (a.chunkIndex ?? 0) <= (b.chunkIndex ?? 0))));
}
function isCapsuleSegment(value) {
    return object(value) && value.kind === "capsules" && value.schemaVersion === CAPSULE_SCHEMA_VERSION && value.hashAlgorithm === SEGMENT_CONTENT_HASH
        && hash(value.hash) && positive(value.bytes) && value.bytes <= CAPSULE_LIMITS.segmentBytes && positive(value.records) && object(value.first) && object(value.last)
        && positive(value.first.eventSeq) && integer(value.first.descriptor) && positive(value.last.eventSeq) && integer(value.last.descriptor)
        && order3(value.first, value.last);
}
function isChunkSegment(value) {
    return object(value) && value.kind === "chunks" && value.schemaVersion === CHUNK_SCHEMA_VERSION && value.hashAlgorithm === SEGMENT_CONTENT_HASH
        && hash(value.hash) && positive(value.bytes) && value.bytes <= CAPSULE_LIMITS.segmentBytes && positive(value.chunks) && object(value.first) && object(value.last)
        && positive(value.first.eventSeq) && integer(value.first.descriptor) && integer(value.first.chunkIndex)
        && positive(value.last.eventSeq) && integer(value.last.descriptor) && integer(value.last.chunkIndex)
        && order3(value.first, value.last);
}
export function isDerivedManifest(value) {
    if (!object(value) || value.v !== 1 || value.schemaVersion !== MANIFEST_SCHEMA_VERSION || !isDerivedStoreIdentity(value.identity)
        || !enumValue(["capsules", "chunks"], value.layer) || value.hashAlgorithm !== SEGMENT_CONTENT_HASH || !hash(value.hash))
        return false;
    return value.layer === "capsules" ? isCapsuleSegment(value.segment) : isChunkSegment(value.segment);
}
export function isDerivedPublicationReceipt(value) {
    if (!object(value) || value.v !== 1 || !isDerivedStoreIdentity(value.identity) || !isCapsuleCatalogView(value.view)
        || !identitiesMatch(value.identity, value.view) || (value.predecessorReceiptHash !== undefined && !hash(value.predecessorReceiptHash))
        || !Array.isArray(value.manifestHashes) || value.manifestHashes.length < 1 || value.manifestHashes.length > CAPSULE_LIMITS.manifestSegments
        || !value.manifestHashes.every(hash) || !isDeriveCursor(value.cursor) || value.hashAlgorithm !== SEGMENT_CONTENT_HASH
        || !hash(value.receiptHash) || value.publication !== "durable")
        return false;
    return value.cursor.identity.storeKey === value.identity.storeKey && value.cursor.view.eventCut === value.view.eventCut
        && value.cursor.view.branchKey === value.view.branchKey;
}
function isLayerReadiness(value, layer, cut) {
    if (!object(value) || value.layer !== layer || !enumValue(["ready", "partial", "unsupported", "failed", "excluded"], value.state)
        || !integer(value.eligible) || !integer(value.ready) || !integer(value.unsupported) || !integer(value.failed) || !integer(value.excluded)
        || value.ready + value.unsupported + value.failed > value.eligible
        || !integer(value.afterEventSeq) || value.afterEventSeq > cut || !integer(value.afterDescriptor) || typeof value.resumable !== "boolean"
        || (value.marker !== undefined && !boundedText(value.marker, 256)))
        return false;
    if (value.state === "ready" && (value.ready !== value.eligible || value.unsupported !== 0 || value.failed !== 0))
        return false;
    if (value.state === "unsupported" && value.unsupported < 1)
        return false;
    if (value.state === "failed" && value.failed < 1)
        return false;
    if (value.state === "excluded" && value.excluded < 1)
        return false;
    return true;
}
export function isCapsuleReadiness(value) {
    return object(value) && value.v === 1 && isDerivedStoreIdentity(value.identity) && isCapsuleCatalogView(value.view)
        && identitiesMatch(value.identity, value.view) && enumValue(["pinned", "lagging", "unavailable"], value.catalog)
        && isLayerReadiness(value.capsules, "capsules", value.view.eventCut) && isLayerReadiness(value.chunks, "chunks", value.view.eventCut);
}
function viewExtendsCursor(view, cursor) {
    if (view.branchKey !== cursor.view.branchKey || view.eventCut < cursor.view.eventCut || view.segments.length < cursor.view.segments.length)
        return false;
    return cursor.view.segments.every((old, index) => {
        const current = view.segments[index];
        return current !== undefined && current.segment === old.segment && current.cut >= old.cut;
    });
}
export function isCapsuleWorkerRequest(value) {
    if (!byteSizeWithin(value, CAPSULE_LIMITS.requestBytes) || !object(value) || value.v !== 1 || !path(value.derivedDirectory)
        || !path(value.catalogDirectory) || value.catalogDirectory === value.derivedDirectory || !isDerivedStoreIdentity(value.identity))
        return false;
    const identity = value.identity;
    const matches = (candidate) => isCapsuleCatalogView(candidate) && identitiesMatch(identity, candidate);
    switch (value.op) {
        case "status": return value.view === undefined || matches(value.view);
        case "derivePage": return matches(value.view) && (value.cursor === undefined || isDeriveCursor(value.cursor)
            && value.cursor.identity.storeKey === identity.storeKey && viewExtendsCursor(value.view, value.cursor))
            && (value.maxEvents === undefined || positive(value.maxEvents) && value.maxEvents <= CAPSULE_LIMITS.deriveEvents)
            && (value.maxDescriptors === undefined || positive(value.maxDescriptors) && value.maxDescriptors <= CAPSULE_LIMITS.deriveDescriptors);
        case "capsulePage": return matches(value.view) && (value.afterEventSeq === undefined || integer(value.afterEventSeq) && value.afterEventSeq <= value.view.eventCut)
            && (value.afterDescriptor === undefined || integer(value.afterDescriptor)) && (value.limit === undefined || positive(value.limit) && value.limit <= CAPSULE_LIMITS.page);
        case "chunkRange": return matches(value.view) && isScopedBodySourceRef(value.source) && sourceRefWithinViewBounds(value.source, value.view)
            && integer(value.decodedStart) && positive(value.decodedLength) && value.decodedLength <= CAPSULE_LIMITS.decodedChunkUnits
            && value.decodedStart >= value.source.decodedUtf16.start && value.decodedStart + value.decodedLength <= value.source.decodedUtf16.end
            && (value.limit === undefined || positive(value.limit) && value.limit <= CAPSULE_LIMITS.rangeChunks);
        default: return false;
    }
}
//# sourceMappingURL=capsule-contract.js.map