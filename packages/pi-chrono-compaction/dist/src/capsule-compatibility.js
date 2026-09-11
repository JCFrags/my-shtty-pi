import { createHash } from "node:crypto";
import { runCatalogWorker } from "./catalog-worker-client.js";
import { CAPSULE_TEXT_HASH, SEGMENT_CONTENT_HASH, isReducerEnvelope, } from "./capsule-contract.js";
import { candidateDependency, persistentCandidateKey, } from "./candidates.js";
import { REDUCER_VERSIONS } from "./reducers/index.js";
import { catalogHashUnit, createCatalogHash, finishCatalogHash } from "./catalog-parser-hash.js";
import { estimateTokensFromText, hashText, stableStringify } from "./utils.js";
export const CAPSULE_COMPATIBILITY_LIMITS = Object.freeze({
    bindings: 16,
    sourceRefs: 32,
    rawBytesPerSource: 64 * 1024,
    decodedBodyUnits: 32_768,
    totalSourceBytes: 1024 * 1024,
    candidateTextUnits: 64 * 1024,
    candidatesPerBlock: 8,
});
const VERIFIED = Symbol("m04-verified-capsule-binding");
const VERIFICATION_DIGEST = Symbol("m04-verified-capsule-binding-digest");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
function catalogView(view) {
    return {
        storeKey: view.storeKey,
        sessionKey: view.sessionKey,
        generation: view.generation,
        eventCut: view.eventCut,
        branchKey: view.branchKey,
        segments: view.segments.map(segment => ({ segment: segment.segment, cut: segment.cut })),
    };
}
function sourceShape(source) {
    const base = {
        catalogStoreKey: source.catalogStoreKey,
        sessionKey: source.sessionKey,
        catalogGeneration: source.catalogGeneration,
        shardKey: source.shardKey,
        segment: source.segment,
        eventSeq: source.eventSeq,
        ordinal: source.ordinal,
        descriptor: source.descriptor,
        blockIndex: source.blockIndex,
        field: source.field,
        raw: source.raw,
        entryId: source.entryId,
        coordinateKind: source.coordinateKind,
    };
    if (source.coordinateKind === "decoded-body") {
        return { ...base, decodedUtf16: source.decodedUtf16, bodyHashAlgorithm: source.bodyHashAlgorithm, bodyHash: source.bodyHash };
    }
    return { ...base, rawHashAlgorithm: source.rawHashAlgorithm, rawHash: source.rawHash };
}
function sourceKey(source) {
    return stableStringify(sourceShape(source));
}
function collectSourceRefs(envelope) {
    const refs = [envelope.source];
    if (envelope.pair)
        refs.push(envelope.pair.call, envelope.pair.result);
    for (const alternative of envelope.alternatives) {
        refs.push(...alternative.sourceRefs);
        for (const fact of alternative.facts)
            refs.push(fact.source);
        for (const cue of alternative.protectedCues)
            refs.push(cue.source);
        for (const omission of alternative.omissions)
            refs.push(omission.kind === "exact-range" ? omission.source : omission.affectedSource);
    }
    const unique = new Map();
    for (const ref of refs)
        unique.set(sourceKey(ref), ref);
    return [...unique.values()];
}
function segmentForEvent(view, eventSeq) {
    return view.segments.find(segment => eventSeq <= segment.cut)?.segment;
}
function bodyHash(text) {
    const state = createCatalogHash();
    for (let index = 0; index < text.length; index += 1)
        catalogHashUnit(state, text.charCodeAt(index));
    return finishCatalogHash(state);
}
function expectedBlockKind(envelope, block) {
    return envelope.source.entryId === block.entryId
        && (block.blockIndex === undefined || envelope.source.blockIndex === block.blockIndex);
}
function bindingDigest(block, envelope, view, refs) {
    return createHash("sha256").update(stableStringify({ block, envelope, view, refs: refs.map(sourceShape) })).digest("hex");
}
function decodeBody(bytes) {
    try {
        const decoded = JSON.parse(bytes.toString("utf8"));
        return typeof decoded === "string" ? decoded : undefined;
    }
    catch {
        return undefined;
    }
}
async function successfulResult(execute, request, signal, charge) {
    const response = await execute(request, { signal });
    charge(response.sourceBytes);
    if (!response.ok)
        throw new Error(response.code);
    return response.result;
}
async function verifyOneSource(source, input, execute, signal, charge) {
    if (source.catalogStoreKey !== input.view.storeKey || source.sessionKey !== input.view.sessionKey
        || source.catalogGeneration !== input.view.generation || segmentForEvent(input.view, source.eventSeq) !== source.segment) {
        throw new Error("source-scope-mismatch");
    }
    const base = { v: 1, catalogDirectory: input.catalogDirectory, sessionKey: input.view.sessionKey };
    const view = catalogView(input.view);
    const page = await successfulResult(execute, { ...base, op: "page", view, after: source.eventSeq - 1, limit: 1 }, signal, charge);
    const events = Array.isArray(page.events) ? page.events : [];
    const event = events[0];
    if (!object(event) || event.seq !== source.eventSeq || event.shardKey !== source.shardKey || event.ordinal !== source.ordinal) {
        throw new Error("catalog-event-mismatch");
    }
    const metadata = object(event.metadata) ? event.metadata : undefined;
    if (source.entryId !== undefined && metadata?.id !== source.entryId)
        throw new Error("catalog-entry-mismatch");
    const blocks = await successfulResult(execute, { ...base, op: "blocks", view, eventSeq: source.eventSeq, after: source.descriptor, limit: 1 }, signal, charge);
    const descriptors = Array.isArray(blocks.blocks) ? blocks.blocks : [];
    const row = descriptors[0];
    if (!object(row) || row.index !== source.descriptor || !object(row.metadata))
        throw new Error("catalog-descriptor-mismatch");
    const descriptor = row.metadata;
    const descriptorStart = descriptor.rawStart;
    const descriptorEnd = descriptor.rawEnd;
    if (!integer(descriptorStart) || !integer(descriptorEnd) || descriptorStart > source.raw.start || descriptorEnd < source.raw.end) {
        throw new Error("catalog-range-mismatch");
    }
    if (source.coordinateKind === "decoded-body") {
        if (descriptor.kind !== "body" || descriptor.rawStart !== source.raw.start || descriptor.rawEnd !== source.raw.end
            || descriptor.field !== source.field || descriptor.blockIndex !== source.blockIndex
            || descriptor.decodedStart !== source.decodedUtf16.start || descriptor.decodedEnd !== source.decodedUtf16.end
            || descriptor.hashAlgorithm !== CAPSULE_TEXT_HASH || descriptor.hash !== source.bodyHash) {
            throw new Error("catalog-body-descriptor-mismatch");
        }
        if (source.decodedUtf16.end - source.decodedUtf16.start > CAPSULE_COMPATIBILITY_LIMITS.decodedBodyUnits) {
            throw new Error("body-too-large");
        }
    }
    else if (descriptor.kind !== "block") {
        // The normalized block descriptor establishes the selected physical scope;
        // the exact subrange bytes and hash below establish the structural field.
        throw new Error("catalog-raw-descriptor-mismatch");
    }
    const length = source.raw.end - source.raw.start;
    if (length < 0 || length > CAPSULE_COMPATIBILITY_LIMITS.rawBytesPerSource)
        throw new Error("raw-range-too-large");
    const raw = await successfulResult(execute, { ...base, op: "raw", view, eventSeq: source.eventSeq, offset: source.raw.start, length }, signal, charge);
    if (raw.offset !== source.raw.start || raw.length !== length || raw.encoding !== "base64" || typeof raw.data !== "string") {
        throw new Error("catalog-raw-response-mismatch");
    }
    const bytes = Buffer.from(raw.data, "base64");
    if (bytes.length !== length || bytes.toString("base64") !== raw.data)
        throw new Error("catalog-raw-bytes-invalid");
    if (source.coordinateKind === "raw-json") {
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (source.rawHashAlgorithm !== SEGMENT_CONTENT_HASH || digest !== source.rawHash)
            throw new Error("raw-hash-mismatch");
        return { descriptor };
    }
    const text = decodeBody(bytes);
    if (text === undefined || text.length !== source.decodedUtf16.end - source.decodedUtf16.start || bodyHash(text) !== source.bodyHash) {
        throw new Error("body-hash-mismatch");
    }
    return { descriptor, bodyText: text };
}
function pairMatchesBlock(binding) {
    const { block, envelope } = binding;
    const pairedEntryId = block.attributes.pairedCallEntryId;
    const pairedBlockIndex = block.attributes.pairedCallBlockIndex;
    if (typeof pairedEntryId !== "string")
        return envelope.pair === undefined;
    if (!envelope.pair || envelope.pair.call.entryId !== pairedEntryId)
        return false;
    return pairedBlockIndex === undefined || envelope.pair.call.blockIndex === pairedBlockIndex;
}
/**
 * Establish bindings through actual M04 CatalogView selection and bounded exact
 * raw reads. An injected executor is a test seam only; the default is the
 * contained runCatalogWorker client.
 */
export async function createVerifiedCapsuleBindings(input, options = {}) {
    if (input.associations.length > CAPSULE_COMPATIBILITY_LIMITS.bindings)
        throw new Error("capsule-binding-limit");
    if (input.maxTotalSourceBytes !== undefined
        && (!Number.isSafeInteger(input.maxTotalSourceBytes) || input.maxTotalSourceBytes < 1)) {
        throw new Error("capsule-source-read-budget-invalid");
    }
    const maximum = Math.min(CAPSULE_COMPATIBILITY_LIMITS.totalSourceBytes, input.maxTotalSourceBytes ?? CAPSULE_COMPATIBILITY_LIMITS.totalSourceBytes);
    const execute = options.executeCatalog ?? runCatalogWorker;
    const bindings = [];
    const rejected = [];
    const windowRefs = new Map();
    for (const association of input.associations) {
        for (const ref of collectSourceRefs(association.envelope))
            windowRefs.set(sourceKey(ref), ref);
    }
    if (windowRefs.size > CAPSULE_COMPATIBILITY_LIMITS.sourceRefs)
        throw new Error("capsule-source-ref-window-limit");
    const requestedRawBytes = [...windowRefs.values()].reduce((sum, ref) => sum + Math.max(0, ref.raw.end - ref.raw.start), 0);
    if (requestedRawBytes > maximum) {
        return { bindings, rejected: input.associations.map(association => ({ blockId: association.block.id, reason: "total-source-read-limit" })), sourceBytes: 0, requestedRawBytes };
    }
    let sourceBytes = 0;
    let exhausted = false;
    const charge = (bytes) => {
        sourceBytes += bytes;
        if (sourceBytes > maximum) {
            exhausted = true;
            throw new Error("total-source-read-limit");
        }
    };
    const verifiedWindow = new Map();
    for (const association of input.associations) {
        if (exhausted) {
            rejected.push({ blockId: association.block.id, reason: "total-source-read-limit" });
            continue;
        }
        try {
            if (options.signal?.aborted)
                throw options.signal.reason instanceof Error ? options.signal.reason : new Error("binding-aborted");
            if (!isReducerEnvelope(association.envelope) || !expectedBlockKind(association.envelope, association.block)
                || !pairMatchesBlock(association) || association.block.protectedExact || association.block.attributes.containsImage === true
                || ["data"].includes(association.envelope.source.field))
                throw new Error("unsupported-envelope");
            const refs = collectSourceRefs(association.envelope);
            if (refs.length > CAPSULE_COMPATIBILITY_LIMITS.sourceRefs)
                throw new Error("source-ref-limit");
            let mainText;
            const verifiedDescriptors = new Map();
            for (const ref of refs) {
                const key = sourceKey(ref);
                let verification = verifiedWindow.get(key);
                if (!verification) {
                    verification = verifyOneSource(ref, input, execute, options.signal, charge);
                    verifiedWindow.set(key, verification);
                }
                const verified = await verification;
                verifiedDescriptors.set(sourceKey(ref), verified.descriptor);
                if (sourceKey(ref) === sourceKey(association.envelope.source)) {
                    mainText = verified.bodyText;
                    if (verified.descriptor.provenance !== association.envelope.provenance)
                        throw new Error("provenance-mismatch");
                }
            }
            if (mainText === undefined || mainText !== association.block.exactText)
                throw new Error("block-body-mismatch");
            if (association.block.kind === "tool_result" && (association.envelope.source.blockIndex !== 0 || association.envelope.source.field !== "text")) {
                throw new Error("unsupported-tool-result-shape");
            }
            if (association.envelope.pair) {
                const callDescriptor = verifiedDescriptors.get(sourceKey(association.envelope.pair.call));
                if (callDescriptor?.kind !== "block" || callDescriptor.type !== "toolCall" || callDescriptor.id !== association.block.toolCallId
                    || callDescriptor.name !== association.block.toolName)
                    throw new Error("paired-call-mismatch");
            }
            const frozenRefs = Object.freeze(refs);
            bindings.push(Object.freeze({ block: association.block, envelope: association.envelope, view: input.view,
                sourceRefs: frozenRefs, [VERIFIED]: true,
                [VERIFICATION_DIGEST]: bindingDigest(association.block, association.envelope, input.view, frozenRefs) }));
        }
        catch (error) {
            rejected.push({ blockId: association.block.id, reason: error instanceof Error ? error.message : "capsule-binding-failed" });
        }
    }
    return { bindings, rejected, sourceBytes, requestedRawBytes };
}
const reducerMapping = Object.freeze({
    terminal: { reducer: "terminal", version: REDUCER_VERSIONS.terminal },
    "test-output": { reducer: "test-output", version: REDUCER_VERSIONS["test-output"] },
    "git-diff": { reducer: "git-diff", version: REDUCER_VERSIONS["git-diff"] },
    "generic-text": { reducer: "generic-text", version: REDUCER_VERSIONS["generic-text"] },
    "assistant-extractive": { reducer: "assistant-extractive", version: REDUCER_VERSIONS["assistant-extractive"] },
    "assistant-cleanup": { reducer: "assistant-cleanup", version: REDUCER_VERSIONS["assistant-cleanup"] },
    "small-json": { reducer: "structured-json", version: REDUCER_VERSIONS["structured-json"] },
});
function candidateShape(block, reducer) {
    if (reducer === "assistant-extractive" || reducer === "assistant-cleanup") {
        if (!["assistant_reasoning", "assistant_text", "branch_summary", "custom_message", "user"].includes(block.kind))
            return undefined;
        const level = block.kind === "assistant_reasoning" || block.kind === "assistant_text" ? "semantic" : "reduced";
        return { level, utility: level === "semantic" ? 0.76 : 0.82 };
    }
    if (["terminal", "test-output", "git-diff", "structured-json"].includes(reducer)) {
        return block.kind === "tool_result" || block.kind === "bash_execution" ? { level: "reduced", utility: 0.82 } : undefined;
    }
    if (reducer === "generic-text" && !["tool_call", "assistant_reasoning", "assistant_text", "branch_summary", "custom_message", "user"].includes(block.kind)) {
        return { level: "reduced", utility: 0.82 };
    }
    return undefined;
}
function recordIntegrityHash(blockId, key, candidates, block) {
    const metadata = { blockKind: block.kind, isError: Boolean(block.isError), unresolved: block.unresolved,
        reproducible: block.reproducible, identifierCount: block.exactIdentifiers.length };
    return hashText(stableStringify({ schema: 3, blockId, key, candidates, metadata }));
}
/** Convert only nominal, live-M04-verified bindings into the unchanged seam. */
export function adaptVerifiedCapsulesToPrecomputedCandidates(blocks, config, bindings) {
    if (bindings.length > CAPSULE_COMPATIBILITY_LIMITS.bindings || blocks.length > CAPSULE_COMPATIBILITY_LIMITS.bindings) {
        throw new Error("capsule-adapter-window-limit");
    }
    const blockById = new Map(blocks.map(block => [block.id, block]));
    const byBlock = new Map();
    const rejected = [];
    let accepted = 0;
    for (const binding of bindings) {
        const block = blockById.get(binding.block.id);
        try {
            if (binding[VERIFIED] !== true || block !== binding.block || binding.block.protectedExact
                || binding.sourceRefs.length > CAPSULE_COMPATIBILITY_LIMITS.sourceRefs
                || binding[VERIFICATION_DIGEST] !== bindingDigest(binding.block, binding.envelope, binding.view, binding.sourceRefs)
                || !isReducerEnvelope(binding.envelope))
                throw new Error("unverified-binding");
            const mapping = reducerMapping[binding.envelope.family];
            const shape = mapping && candidateShape(block, mapping.reducer);
            if (!mapping || !shape || binding.envelope.familyVersion !== mapping.version)
                throw new Error("unsupported-reducer");
            const candidates = byBlock.get(block.id) ?? [];
            if (binding.envelope.alternatives.length !== 1)
                throw new Error("unsupported-alternative-count");
            const alternative = binding.envelope.alternatives[0];
            if (!alternative || alternative.lossy !== true || alternative.omissions.length < 1
                || alternative.protectedCues.some(cue => !alternative.text.includes(cue.exactText)))
                throw new Error("loss-or-cue-mismatch");
            if (candidates.some(candidate => candidate.reducer === mapping.reducer))
                throw new Error("duplicate-reducer");
            const combined = candidates.reduce((sum, candidate) => sum + candidate.text.length, 0) + alternative.text.length;
            if (alternative.text.length > CAPSULE_COMPATIBILITY_LIMITS.candidateTextUnits || combined > CAPSULE_COMPATIBILITY_LIMITS.candidateTextUnits
                || candidates.length >= CAPSULE_COMPATIBILITY_LIMITS.candidatesPerBlock)
                throw new Error("candidate-ceiling");
            const candidate = Object.freeze({
                id: `${block.id}:${shape.level}:${mapping.reducer}`,
                level: shape.level,
                text: alternative.text,
                tokens: estimateTokensFromText(alternative.text),
                rawTokens: block.rawTokens,
                utility: shape.utility,
                lossy: true,
                reducer: mapping.reducer,
                reducerVersion: mapping.version,
                omissions: Object.freeze(alternative.omissions.map(omission => Object.freeze({ description: omission.description }))),
                sourceRefs: Object.freeze(block.sourceRefs.map(ref => Object.freeze({ ...ref }))),
                metadata: Object.freeze({
                    capsuleAlternative: alternative.alternative,
                    capsuleFamily: binding.envelope.family,
                    capsuleFamilyVersion: binding.envelope.familyVersion,
                    capsuleInputHash: binding.envelope.inputHash,
                    capsuleProvenance: binding.envelope.provenance,
                    capsuleLossKinds: alternative.omissions.map(omission => `${omission.kind}:${omission.reason}`).join(","),
                    capsuleCueKinds: alternative.protectedCues.map(cue => cue.kind).join(","),
                    capsulePhysicalSourceRefs: stableStringify(binding.sourceRefs.map(sourceShape)),
                }),
            });
            candidates.push(candidate);
            byBlock.set(block.id, candidates);
            accepted += 1;
        }
        catch (error) {
            rejected.push({ blockId: binding.block.id, reason: error instanceof Error ? error.message : "capsule-adapter-failed" });
        }
    }
    const records = new Map();
    for (const [blockId, candidates] of byBlock) {
        const block = blockById.get(blockId);
        const key = persistentCandidateKey(block, config);
        records.set(blockId, Object.freeze({
            blockId,
            key,
            dependency: candidateDependency(block),
            blockKind: block.kind,
            isError: Boolean(block.isError),
            unresolved: block.unresolved,
            reproducible: block.reproducible,
            identifierCount: block.exactIdentifiers.length,
            integrityHash: recordIntegrityHash(blockId, key, candidates, block),
            candidates: Object.freeze(candidates),
        }));
    }
    return { records, accepted, rejected };
}
//# sourceMappingURL=capsule-compatibility.js.map