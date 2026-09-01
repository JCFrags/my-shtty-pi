import { compactWhitespace, estimateTokensFromText, getNumber, getRecord, getString, hashText, unique } from "./utils.js";
function normalizePath(path) {
    return path.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}
function toolPath(block) {
    const details = getRecord(block.attributes.details);
    const value = getString(block.toolArguments?.path)
        ?? getString(block.toolArguments?.file_path)
        ?? getString(block.toolArguments?.file)
        ?? getString(details?.path);
    return value ? normalizePath(value) : undefined;
}
function declaredRevision(block) {
    const details = getRecord(block.attributes.details);
    return getString(block.toolArguments?.revision)
        ?? getString(block.toolArguments?.ref)
        ?? getString(details?.revision)
        ?? getString(details?.hash);
}
function requestedRange(block, lines) {
    const start = getNumber(block.toolArguments?.offset) ?? getNumber(block.toolArguments?.startLine);
    const end = getNumber(block.toolArguments?.endLine);
    const limit = getNumber(block.toolArguments?.limit);
    if (start === undefined && end === undefined && limit === undefined)
        return undefined;
    const safeStart = Math.max(1, Math.floor(start ?? 1));
    const safeEnd = Math.max(safeStart, Math.floor(end ?? (safeStart + Math.max(0, (limit ?? lines) - 1))));
    return { start: safeStart, end: safeEnd };
}
function rollingChunkHashes(text, size = 8) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length <= size)
        return [hashText(lines.map((line) => line.trimEnd()).join("\n"))];
    const hashes = [];
    for (let index = 0; index + size <= lines.length; index += Math.max(1, Math.floor(size / 2))) {
        hashes.push(hashText(lines.slice(index, index + size).map((line) => line.trimEnd()).join("\n")));
    }
    return unique(hashes);
}
const SYMBOL = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|struct|trait|impl|fn)\s+([A-Za-z_$][\w$]*)/;
function symbolHashes(text) {
    const lines = text.split("\n");
    const found = {};
    for (let index = 0; index < lines.length; index += 1) {
        const name = lines[index]?.match(SYMBOL)?.[1];
        if (!name)
            continue;
        found[name] = hashText(lines.slice(index, Math.min(lines.length, index + 24)).join("\n"));
    }
    return Object.freeze(found);
}
function associatedCall(block, byToolCallId) {
    if (block.kind === "tool_call")
        return block;
    if (!block.toolCallId)
        return undefined;
    return byToolCallId.get(block.toolCallId)?.find((candidate) => candidate.kind === "tool_call");
}
function relationFor(name, text) {
    if (/diff|patch/i.test(name) || /^(?:diff --git |@@ )/m.test(text))
        return "diff";
    if (/edit|replace|patch/i.test(name))
        return "edit";
    if (/write|save|create/i.test(name))
        return "write";
    if (/read|cat|head|tail|view|open/i.test(name))
        return "read";
    if (/bash|shell|exec|run|test/i.test(name))
        return "run";
    return "observe";
}
function resourceIdentity(call, result) {
    const name = call.toolName ?? result.toolName ?? "unknown";
    const path = toolPath(call) ?? toolPath(result);
    if (path) {
        const kind = /evidence|report|manifest|custody/i.test(path) ? "evidence" : "file";
        return { kind, key: `${kind}:${path}`, display: path };
    }
    const url = getString(call.toolArguments?.url);
    if (url)
        return { kind: "url", key: `url:${url}`, display: url };
    const command = getString(call.toolArguments?.command) ?? getString(result.attributes.command);
    if (command) {
        const normalized = compactWhitespace(command);
        const kind = /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:test|run test)|\bnode --test\b/.test(normalized)
            ? "test"
            : /(?:systemctl|service|journalctl)/.test(normalized)
                ? "service"
                : /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|update|outdated|list|ls|view|pack)\b/.test(normalized)
                    ? "package"
                    : /(?:^|\s)(?:git|npm|pnpm|yarn)\s+config\b|\bgsettings\b/.test(normalized)
                        ? "setting"
                        : "command";
        return { kind, key: `${kind}:${hashText(normalized)}`, display: normalized.slice(0, 240) };
    }
    if (/setting|config/i.test(name)) {
        const target = getString(call.toolArguments?.key) ?? getString(call.toolArguments?.name) ?? name;
        return { kind: "setting", key: `setting:${target}`, display: target };
    }
    if (/package/i.test(name)) {
        const target = getString(call.toolArguments?.package) ?? getString(call.toolArguments?.name) ?? name;
        return { kind: "package", key: `package:${target}`, display: target };
    }
    if (/process|agent/i.test(name)) {
        const kind = /agent/i.test(name) ? "agent" : "process";
        const target = getString(call.toolArguments?.agent) ?? getString(call.toolArguments?.name)
            ?? getString(call.toolArguments?.target) ?? getString(call.toolArguments?.pid) ?? call.toolCallId ?? call.id;
        return { kind, key: `${kind}:${target}`, display: target };
    }
    return undefined;
}
function unionRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    const output = [];
    for (const range of sorted) {
        const previous = output[output.length - 1];
        if (!previous || range.start > previous.end + 1)
            output.push({ ...range });
        else
            output[output.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    }
    return output;
}
function observedLineHashes(text, range) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const start = range?.start ?? 1;
    return new Map(lines.map((line, index) => [start + index, hashText(line.trimEnd())]));
}
function inferVersionHash(identity, revision, relation, failed, text, range, inferred) {
    if (revision)
        return hashText(`${identity.key}\n${revision}`);
    if (identity.kind !== "file" && identity.kind !== "evidence")
        return hashText(text);
    if (failed)
        return hashText(`${identity.key}\nfailed\n${text}`);
    const lines = observedLineHashes(text, range);
    const previous = inferred.get(identity.key);
    const changed = relation !== "read" || (previous !== undefined && [...lines].some(([line, digest]) => {
        const old = previous.lineHashes.get(line);
        return old !== undefined && old !== digest;
    }));
    const generation = previous === undefined ? 0 : changed ? previous.generation + 1 : previous.generation;
    const versionHash = changed || previous === undefined
        ? hashText(`${identity.key}\nobserved-version:${generation}`)
        : previous.versionHash;
    const merged = changed || previous === undefined ? new Map() : new Map(previous.lineHashes);
    for (const [line, digest] of lines)
        merged.set(line, digest);
    inferred.set(identity.key, { generation, versionHash, lineHashes: merged });
    return versionHash;
}
export function buildResourceLineage(blocks) {
    const byToolCallId = new Map();
    for (const block of blocks) {
        if (!block.toolCallId)
            continue;
        const group = byToolCallId.get(block.toolCallId) ?? [];
        group.push(block);
        byToolCallId.set(block.toolCallId, group);
    }
    const observations = [];
    const inferredVersions = new Map();
    for (const block of blocks) {
        if (block.kind !== "tool_result" && block.kind !== "bash_execution")
            continue;
        const call = associatedCall(block, byToolCallId) ?? block;
        const identity = resourceIdentity(call, block);
        if (!identity)
            continue;
        const lines = block.exactText.replace(/\r\n?/g, "\n").split("\n");
        const revision = declaredRevision(call) ?? declaredRevision(block);
        const relation = relationFor(call.toolName ?? block.toolName ?? "unknown", block.exactText);
        const range = identity.kind === "file" || identity.kind === "evidence"
            ? requestedRange(call, lines.length) ?? (relation === "read" ? { start: 1, end: lines.length } : undefined)
            : undefined;
        const versionHash = inferVersionHash(identity, revision, relation, block.isError === true, block.exactText, range, inferredVersions);
        observations.push({
            blockId: block.id,
            entryId: block.entryId,
            entryIndex: block.entryIndex,
            resourceKind: identity.kind,
            resourceKey: identity.key,
            displayName: identity.display,
            // Declared revisions are authoritative. Normal Pi reads have no revision,
            // so compatible overlapping observations share one inferred version.
            // A conflicting overlap or write starts a new version deterministically.
            versionHash,
            ...(revision === undefined ? {} : { declaredRevision: revision }),
            ...(range === undefined ? {} : { range }),
            lineCount: lines.length,
            chunkHashes: rollingChunkHashes(block.exactText),
            symbolHashes: symbolHashes(block.exactText),
            relation,
            ...(block.toolCallId === undefined ? {} : { toolCallId: block.toolCallId }),
            failed: block.isError === true,
            unresolved: block.unresolved,
            protectedExact: block.protectedExact,
        });
    }
    observations.sort((a, b) => a.entryIndex - b.entryIndex || a.blockId.localeCompare(b.blockId));
    const grouped = new Map();
    for (const observation of observations) {
        const group = grouped.get(observation.resourceKey) ?? [];
        group.push(observation);
        grouped.set(observation.resourceKey, group);
    }
    const resources = new Map();
    for (const [key, group] of grouped) {
        const versionGroups = new Map();
        for (const observation of group) {
            const version = versionGroups.get(observation.versionHash) ?? [];
            version.push(observation);
            versionGroups.set(observation.versionHash, version);
        }
        const ordered = [...versionGroups].map(([versionHash, versionObservations]) => ({
            versionHash,
            observations: versionObservations,
            unionRanges: unionRanges(versionObservations.flatMap((observation) => observation.range ? [observation.range] : [])),
            firstEntryIndex: Math.min(...versionObservations.map((observation) => observation.entryIndex)),
            lastEntryIndex: Math.max(...versionObservations.map((observation) => observation.entryIndex)),
            superseded: false,
        })).sort((a, b) => a.lastEntryIndex - b.lastEntryIndex || a.versionHash.localeCompare(b.versionHash));
        const current = ordered[ordered.length - 1];
        const versions = ordered.map((version) => ({ ...version, superseded: version.versionHash !== current.versionHash }));
        resources.set(key, {
            kind: group[0].resourceKind,
            key,
            displayName: group[0].displayName,
            versions,
            currentVersionHash: current.versionHash,
            volatility: Math.max(0, versions.length - 1) / Math.max(1, group.length),
        });
    }
    return {
        resources,
        observationByBlockId: new Map(observations.map((observation) => [observation.blockId, observation])),
        generationHash: hashText(JSON.stringify(observations.map((observation) => ({
            blockId: observation.blockId,
            resourceKey: observation.resourceKey,
            versionHash: observation.versionHash,
            range: observation.range,
            chunks: observation.chunkHashes,
        })))),
    };
}
export function chunkSimilarity(left, right) {
    const a = new Set(left.chunkHashes);
    const b = new Set(right.chunkHashes);
    if (a.size === 0 && b.size === 0)
        return 1;
    const intersection = [...a].filter((hash) => b.has(hash)).length;
    return intersection / Math.max(1, new Set([...a, ...b]).size);
}
/** Require byte-exact reconstruction before near-duplicate factoring is valid. */
export function factorNearDuplicateTemplate(texts) {
    if (texts.length < 2 || texts.some((text) => text.length === 0))
        return undefined;
    const shortest = Math.min(...texts.map((text) => text.length));
    let prefix = 0;
    while (prefix < shortest && texts.every((text) => text[prefix] === texts[0]?.[prefix]))
        prefix += 1;
    let suffix = 0;
    while (suffix < shortest - prefix && texts.every((text) => text[text.length - 1 - suffix] === texts[0]?.[texts[0].length - 1 - suffix]))
        suffix += 1;
    const substitutions = texts.map((text) => text.slice(prefix, text.length - suffix));
    const template = `${texts[0].slice(0, prefix)}{{VALUE}}${suffix === 0 ? "" : texts[0].slice(-suffix)}`;
    const reconstructed = substitutions.map((value) => template.replace("{{VALUE}}", value));
    if (!reconstructed.every((text, index) => text === texts[index]))
        return undefined;
    const stable = prefix + suffix;
    const similarity = stable / Math.max(...texts.map((text) => text.length));
    if (similarity < 0.7)
        return undefined;
    return { template, substitutions, similarity };
}
function factoringSignature(block) {
    return `${block.kind}:${block.toolName ?? "unknown"}:${block.exactText.slice(0, 120)
        .replace(/\d+(?:\.\d+)?/g, "<n>")
        .replace(/\b[a-f0-9]{12,64}\b/gi, "<hash>")}`;
}
/** Add product-connected, exactly reconstructable candidates for routine near duplicates. */
export function addNearDuplicateFactoringCandidates(units, blocks) {
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const groups = new Map();
    for (const block of blocks) {
        if (block.protectedExact || block.unresolved || block.isError || !block.reproducible || block.exactText.length < 400)
            continue;
        if (block.kind !== "tool_result" && block.kind !== "bash_execution")
            continue;
        const unit = unitById.get(block.id);
        if (!unit?.candidates.some((candidate) => !candidate.lossy))
            continue;
        const key = factoringSignature(block);
        const group = groups.get(key) ?? [];
        group.push(block);
        groups.set(key, group);
    }
    const candidateById = new Map();
    for (const group of groups.values()) {
        if (group.length < 3)
            continue;
        const factored = factorNearDuplicateTemplate(group.map((block) => block.exactText));
        if (!factored)
            continue;
        const templateHash = hashText(factored.template);
        group.forEach((block, index) => {
            const unit = unitById.get(block.id);
            const text = [
                `Factored near-duplicate observation ${index + 1}/${group.length}.`,
                `Template ${templateHash}; similarity ${factored.similarity.toFixed(3)}.`,
                `Variable value: ${compactWhitespace(factored.substitutions[index] ?? "")}`,
                `Exact source: ${block.entryId}${block.blockIndex === undefined ? "" : ` block ${block.blockIndex}`}.`,
            ].join("\n");
            const tokens = estimateTokensFromText(text);
            if (tokens >= unit.rawTokens)
                return;
            candidateById.set(block.id, {
                id: `${unit.id}:reduced:near-duplicate-template`,
                level: "reduced",
                text,
                tokens,
                rawTokens: unit.rawTokens,
                utility: 0.84,
                lossy: true,
                reducer: "near-duplicate-template",
                reducerVersion: "2.0.1",
                omissions: [{ description: "Stable near-duplicate template text omitted; template plus substitution reconstructs the exact source and immutable history remains authoritative" }],
                sourceRefs: unit.sourceRefs,
                metadata: { template: factored.template, substitution: factored.substitutions[index] ?? "", templateHash },
            });
        });
    }
    return units.map((unit) => {
        const candidate = candidateById.get(unit.id);
        return candidate ? { ...unit, candidates: [...unit.candidates, candidate] } : unit;
    });
}
function ref(observation) {
    return observation.entryId;
}
function markerCandidate(unit, observation, text, reducer, utility) {
    return {
        id: `${unit.id}:marker:${reducer}`,
        level: "marker",
        text,
        tokens: estimateTokensFromText(text),
        rawTokens: unit.rawTokens,
        utility,
        lossy: true,
        reducer,
        reducerVersion: "2.0.0",
        omissions: [{ description: "Obsolete or overlapping resource content left active context; exact source remains recoverable" }],
        sourceRefs: unit.sourceRefs,
        metadata: { resourceKey: observation.resourceKey, versionHash: observation.versionHash },
    };
}
function laterObservations(lineage, observation) {
    return lineage.versions.flatMap((version) => version.observations).filter((candidate) => candidate.entryIndex > observation.entryIndex);
}
function rangeCovered(range, by) {
    return by.start <= range.start && by.end >= range.end;
}
/**
 * Make latest resource state the default active representation. A routine old
 * file snapshot cannot remain as full prompt text after a later covering read
 * or version. Failures, protected text, and unresolved evidence stay intact.
 */
export function applyResourceEvolutionCandidates(units, blocks, index = buildResourceLineage(blocks)) {
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    return units.map((unit) => {
        const observation = index.observationByBlockId.get(unit.id);
        const block = blockById.get(unit.id);
        if (!observation || !block || observation.failed || observation.unresolved || observation.protectedExact)
            return unit;
        if (observation.resourceKind !== "file" && observation.resourceKind !== "evidence")
            return unit;
        const lineage = index.resources.get(observation.resourceKey);
        if (!lineage)
            return unit;
        const later = laterObservations(lineage, observation);
        if (later.length === 0)
            return unit;
        const laterVersion = later.find((candidate) => candidate.versionHash !== observation.versionHash);
        if (laterVersion) {
            const similarity = chunkSimilarity(observation, laterVersion);
            const text = [
                `Superseded ${observation.resourceKind} version: ${observation.displayName}`,
                `Historical source ${ref(observation)}; current observed source ${ref(later[later.length - 1])}`,
                `Rolling-chunk similarity to next version: ${similarity.toFixed(3)}`,
                "The old full snapshot is outside active context. Keep it only for rollback, failure, or exact historical comparison.",
            ].join("\n");
            const marker = markerCandidate(unit, observation, text, "superseded-resource-version", Math.min(0.9, 0.74 + lineage.volatility * 0.12));
            return {
                ...unit,
                importanceReasons: unique([...unit.importanceReasons, "superseded resource version; latest state preferred"]),
                candidates: [marker],
            };
        }
        if (observation.range) {
            const covering = later.find((candidate) => candidate.versionHash === observation.versionHash && candidate.range && rangeCovered(observation.range, candidate.range));
            if (covering) {
                const text = [
                    `Overlapping ${observation.resourceKind} read omitted: ${observation.displayName} lines ${observation.range.start}–${observation.range.end}.`,
                    `A later read of the same version covers this range at ${ref(covering)}.`,
                    `Exact old read: ${ref(observation)}.`,
                ].join("\n");
                const marker = markerCandidate(unit, observation, text, "overlapping-read-union", 0.8);
                return {
                    ...unit,
                    importanceReasons: unique([...unit.importanceReasons, "range covered by later read of the same resource version"]),
                    candidates: [marker],
                };
            }
        }
        return unit;
    });
}
//# sourceMappingURL=resource-lineage.js.map