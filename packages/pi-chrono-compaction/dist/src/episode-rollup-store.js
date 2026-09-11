import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { canonicalJson } from "./capsule-segment.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { CatalogSqlite } from "./catalog-sqlite.js";
import { EPISODE_STATE_LIMITS, } from "./episode-state-contract.js";
import { readEpisodeRollupInputPage, } from "./episode-state-store.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
export const EPISODE_ROLLUP_SCHEMA_VERSION = 1;
export const EPISODE_ROLLUP_RULESET_VERSION = "episode-rollup-exact-v3";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const num = (row, key) => Number(row[key]);
const str = (row, key) => String(row[key]);
const lineage = (request) => sha(canonicalJson({ branchKey: request.view.branchKey,
    segments: request.view.segments.map(item => item.segment) }));
const schema = [
    "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, searchRoute TEXT NOT NULL, capsuleRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, ruleset TEXT NOT NULL, generation INTEGER NOT NULL)",
    "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, stateGeneration INTEGER NOT NULL, cursor TEXT, complete INTEGER NOT NULL, rootNodeId TEXT, generation INTEGER NOT NULL)",
    "CREATE TABLE frontier (lineage TEXT NOT NULL, level INTEGER NOT NULL, nodeIds TEXT NOT NULL, PRIMARY KEY(lineage,level)) WITHOUT ROWID",
    "CREATE TABLE nodes (nodeId TEXT PRIMARY KEY, contentHash TEXT NOT NULL, nodeType TEXT NOT NULL, level INTEGER NOT NULL, orderedChildren TEXT NOT NULL, sourceCoverageHash TEXT NOT NULL, startEventSeq INTEGER NOT NULL, startDescriptor INTEGER NOT NULL, endEventSeq INTEGER NOT NULL, endDescriptor INTEGER NOT NULL, episodeKey TEXT, fragmentIndex INTEGER, body TEXT NOT NULL, createdGeneration INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE TABLE publications (generation INTEGER PRIMARY KEY, lineage TEXT NOT NULL, branchKey TEXT NOT NULL, eventCut INTEGER NOT NULL, stateGeneration INTEGER NOT NULL, rootNodeId TEXT NOT NULL, complete INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE INDEX publications_lineage ON publications(lineage,generation)",
];
class Store {
    db;
    request;
    statements = 0;
    constructor(db, request) {
        this.db = db;
        this.request = request;
    }
    get(sql, ...values) { this.statements++; return this.db.prepare(sql).get(...values); }
    run(sql, ...values) { this.statements++; this.db.prepare(sql).run(...values); }
    rows(sql, maximum, ...values) { this.statements++; return [...this.db.prepare(sql).iterate(maximum, ...values)]; }
    transaction(fn) { return this.db.transaction(fn); }
    validate(bootstrap) {
        const exists = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
        if (!exists) {
            if (bootstrap && !this.get("SELECT name FROM sqlite_master LIMIT 1"))
                return;
            fail("search-v3-rollup-version-mismatch");
        }
        const meta = this.get("SELECT * FROM meta WHERE singleton=1");
        if (!meta || num(meta, "version") !== EPISODE_ROLLUP_SCHEMA_VERSION || str(meta, "identity") !== canonicalJson(this.request.identity)
            || str(meta, "searchRoute") !== this.request.searchDirectory || str(meta, "capsuleRoute") !== this.request.capsuleDirectory
            || str(meta, "catalogRoute") !== this.request.catalogDirectory || str(meta, "ruleset") !== EPISODE_ROLLUP_RULESET_VERSION)
            fail("search-v3-rollup-store-mismatch");
        for (const sql of schema) {
            const parts = sql.split(" "), name = parts[1] === "INDEX" ? parts[2] : parts[2];
            if (this.get("SELECT sql FROM sqlite_master WHERE name=?", name)?.sql !== sql)
                fail("search-v3-rollup-version-mismatch");
        }
    }
    initialize() {
        this.transaction(() => {
            this.validate(true);
            if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")) {
                for (const sql of schema)
                    this.run(sql);
                this.run("INSERT INTO meta VALUES(1,?,?,?,?,?,?,0)", EPISODE_ROLLUP_SCHEMA_VERSION, canonicalJson(this.request.identity), this.request.searchDirectory, this.request.capsuleDirectory, this.request.catalogDirectory, EPISODE_ROLLUP_RULESET_VERSION);
            }
        });
    }
}
function nodeWithIdentity(node) {
    const contentHash = sha(canonicalJson(node));
    return { ...node, nodeId: contentHash, contentHash };
}
function nodeBytes(node) { return Buffer.byteLength(canonicalJson(node)); }
/** Keep structural recovery routes intact. If optional material does not fit,
 * remove it deterministically and make every protected/metadata gap explicit. */
function boundedNode(node) {
    const summary = [...node.summary], protectedReferences = [...node.protectedReferences], metadataHints = [...node.metadataHints];
    let omittedProtectedCount = node.omittedProtectedCount, omittedMetadataCount = node.omittedMetadataCount;
    while (true) {
        const candidate = nodeWithIdentity({ ...node, summary, protectedReferences, omittedProtectedCount,
            metadataHints, omittedMetadataCount });
        if (nodeBytes(candidate) <= EPISODE_STATE_LIMITS.rollupNodeUtf8Bytes)
            return candidate;
        if (summary.length) {
            summary.pop();
            continue;
        }
        if (metadataHints.length) {
            metadataHints.pop();
            omittedMetadataCount++;
            continue;
        }
        if (protectedReferences.length) {
            protectedReferences.pop();
            omittedProtectedCount++;
            continue;
        }
        return fail("search-v3-rollup-node-limit");
    }
}
function nodeText(node) {
    const text = canonicalJson(node);
    if (Buffer.byteLength(text) > EPISODE_STATE_LIMITS.rollupNodeUtf8Bytes)
        fail("search-v3-rollup-node-limit");
    return text;
}
function writeNode(store, node, generation) {
    const text = nodeText(node), old = store.get("SELECT body FROM nodes WHERE nodeId=?", node.nodeId);
    if (old) {
        if (str(old, "body") !== text)
            fail("search-v3-rollup-node-corrupt");
        return false;
    }
    store.run("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", node.nodeId, node.contentHash, node.nodeType, node.level, canonicalJson(node.orderedChildren), node.sourceCoverageHash, node.range.start.eventSeq, node.range.start.descriptor, node.range.end.eventSeq, node.range.end.descriptor, node.nodeType === "episode-fragment" ? node.episodeKey : null, node.nodeType === "episode-fragment" ? node.fragmentIndex : null, text, generation);
    return true;
}
function loadNode(store, nodeId) {
    const row = store.get("SELECT body,contentHash FROM nodes WHERE nodeId=?", nodeId);
    if (!row)
        fail("search-v3-rollup-node-missing");
    let node;
    try {
        node = JSON.parse(str(row, "body"));
    }
    catch {
        return fail("search-v3-rollup-node-corrupt");
    }
    const { nodeId: ignoredId, contentHash: ignoredHash, ...base } = node;
    if (ignoredId !== nodeId || ignoredHash !== nodeId || str(row, "contentHash") !== nodeId || sha(canonicalJson(base)) !== nodeId)
        fail("search-v3-rollup-node-corrupt");
    return node;
}
function boundedUnique(items, key, maximum) {
    const seen = new Set(), kept = [];
    for (const item of items) {
        const id = String(item[key] ?? canonicalJson(item));
        if (seen.has(id))
            continue;
        seen.add(id);
        if (kept.length < maximum)
            kept.push(item);
    }
    return { kept, omitted: Math.max(0, seen.size - kept.length) };
}
function leafFrom(page) {
    const sources = page.members.map(member => ({ eventSeq: member.eventSeq, descriptor: member.descriptor, sourceKey: member.sourceKey,
        source: member.source, exactBodyHash: member.exactBody === undefined ? undefined : sha(member.exactBody), exactBodyOmitted: member.exactBodyOmitted }));
    const summary = [page.objective, ...page.members.map(member => member.exactBody ?? member.cue)].filter(Boolean).map(text => String(text).slice(0, 2048));
    const base = { schemaVersion: 1, ruleset: EPISODE_ROLLUP_RULESET_VERSION, nodeType: "episode-fragment", level: 0,
        orderedChildren: [], sourceCoverageHash: sha(canonicalJson(sources.map(source => ({ sourceKey: source.sourceKey, exactBodyHash: source.exactBodyHash })))),
        range: page.start.eventSeq <= page.end.eventSeq ? { start: page.start, end: page.end } : fail("search-v3-rollup-input-invalid"),
        summary, protectedReferences: page.protected, omittedProtectedCount: page.omittedProtectedCount,
        metadataHints: page.metadata, omittedMetadataCount: page.omittedMetadataCount,
        remainingDetail: "reachable-through-sources", episodeCount: page.fragmentIndex === 0 ? 1 : 0, memberCount: page.members.length,
        episodeKey: page.episodeKey, fragmentIndex: page.fragmentIndex, episodeFragment: page.episodeFragment,
        closure: page.closure, objective: page.objective, objectiveEvidence: page.objectiveEvidence, sources };
    return boundedNode(base);
}
function parentFrom(children) {
    if (!children.length || children.length > EPISODE_STATE_LIMITS.rollupFanout)
        fail("search-v3-rollup-frontier-invalid");
    const protectedSelected = boundedUnique(children.flatMap(child => child.protectedReferences), "stableKey", EPISODE_STATE_LIMITS.rollupProtectedPerNode);
    const metadataSelected = boundedUnique(children.flatMap(child => child.metadataHints), "stableKey", EPISODE_STATE_LIMITS.rollupMetadataPerNode);
    const base = { schemaVersion: 1, ruleset: EPISODE_ROLLUP_RULESET_VERSION, nodeType: "rollup",
        level: Math.max(...children.map(child => child.level)) + 1, orderedChildren: children.map(child => child.nodeId),
        sourceCoverageHash: sha(canonicalJson(children.map(child => child.sourceCoverageHash))),
        range: { start: children[0].range.start, end: children.at(-1).range.end },
        summary: children.flatMap(child => child.summary).slice(0, EPISODE_STATE_LIMITS.rollupFanout).map(text => text.slice(0, 2048)),
        protectedReferences: protectedSelected.kept,
        omittedProtectedCount: children.reduce((sum, child) => sum + child.omittedProtectedCount, 0) + protectedSelected.omitted,
        metadataHints: metadataSelected.kept,
        omittedMetadataCount: children.reduce((sum, child) => sum + child.omittedMetadataCount, 0) + metadataSelected.omitted,
        remainingDetail: "reachable-through-children", episodeCount: children.reduce((sum, child) => sum + child.episodeCount, 0),
        memberCount: children.reduce((sum, child) => sum + child.memberCount, 0) };
    return boundedNode(base);
}
function frontier(store, line) {
    return new Map(store.rows("SELECT level,nodeIds FROM frontier WHERE lineage=? ORDER BY level", EPISODE_STATE_LIMITS.rollupTreeLevels, line)
        .map(row => [num(row, "level"), JSON.parse(str(row, "nodeIds"))]));
}
function saveFrontier(store, line, value) {
    store.run("DELETE FROM frontier WHERE lineage=?", line);
    for (const [level, ids] of [...value].sort((a, b) => a[0] - b[0]))
        store.run("INSERT INTO frontier VALUES(?,?,?)", line, level, canonicalJson(ids));
}
function appendFrontier(store, value, leaf, generation, created) {
    let level = 0, node = leaf;
    while (true) {
        if (level >= EPISODE_STATE_LIMITS.rollupTreeLevels)
            fail("search-v3-rollup-tree-limit");
        const ids = [...(value.get(level) ?? []), node.nodeId];
        if (ids.length < EPISODE_STATE_LIMITS.rollupFanout) {
            value.set(level, ids);
            return;
        }
        if (ids.length !== EPISODE_STATE_LIMITS.rollupFanout)
            fail("search-v3-rollup-frontier-invalid");
        value.delete(level);
        node = parentFrom(ids.map(id => loadNode(store, id)));
        if (writeNode(store, node, generation))
            created.count++;
        level++;
    }
}
function buildRoot(store, value, generation, created) {
    let nodes = [...value.values()].flatMap(ids => ids.map(id => loadNode(store, id)))
        .sort((a, b) => a.range.start.eventSeq - b.range.start.eventSeq || a.range.start.descriptor - b.range.start.descriptor
        || a.range.end.eventSeq - b.range.end.eventSeq || a.range.end.descriptor - b.range.end.descriptor || b.level - a.level
        || (a.nodeType === "episode-fragment" ? a.fragmentIndex : 0) - (b.nodeType === "episode-fragment" ? b.fragmentIndex : 0)
        || a.nodeId.localeCompare(b.nodeId));
    if (!nodes.length)
        return undefined;
    if (nodes.length === 1) {
        const root = parentFrom(nodes);
        if (writeNode(store, root, generation))
            created.count++;
        return root;
    }
    while (nodes.length > 1) {
        const next = [];
        for (let at = 0; at < nodes.length; at += EPISODE_STATE_LIMITS.rollupFanout) {
            const parent = parentFrom(nodes.slice(at, at + EPISODE_STATE_LIMITS.rollupFanout));
            if (writeNode(store, parent, generation))
                created.count++;
            next.push(parent);
        }
        nodes = next;
    }
    return nodes[0];
}
function handle(request, row) {
    return { schemaVersion: 1, ruleset: EPISODE_ROLLUP_RULESET_VERSION, branchKey: request.view.branchKey, eventCut: num(row, "eventCut"),
        stateGeneration: num(row, "stateGeneration"), rollupGeneration: num(row, "generation"), rootNodeId: str(row, "rootNodeId") };
}
function compatibleView(current, old) {
    return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
        && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index].cut >= item.cut);
}
function withoutSnapshot(cursor) {
    if (!cursor)
        return undefined;
    const { snapshot: ignored, ...position } = cursor;
    return position;
}
function remainingWork(requestedCut, processedCut, exhausted, addedLeaves) {
    if (!exhausted)
        return "eligible-episodes";
    if (processedCut < requestedCut)
        return "state-catch-up";
    return addedLeaves === 0 ? "no-eligible-episode" : "none";
}
async function materialize(request, store, options, budget) {
    const line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
    if (head && !compatibleView(request.view, JSON.parse(str(head, "view"))))
        fail("search-v3-rollup-view-incompatible");
    let cursor = head?.cursor ? JSON.parse(str(head, "cursor")) : undefined;
    // A completed cycle retains its chronological position but deliberately repins state and source view for appended work.
    if (head && num(head, "complete") === 1)
        cursor = withoutSnapshot(cursor);
    else if (head && cursor && !cursor.snapshot) {
        // Continue pre-correction rollup-v1 progress without rewriting its frontier or immutable nodes.
        const oldView = JSON.parse(str(head, "view"));
        const oldPublication = store.get("SELECT eventCut FROM publications WHERE lineage=? AND generation=?", line, num(head, "generation"));
        const oldProcessedCut = oldPublication ? num(oldPublication, "eventCut") : 0;
        cursor = { ...cursor, snapshot: { stateGeneration: num(head, "stateGeneration"), requestedCut: oldView.eventCut,
                processedCut: oldProcessedCut, processedMemoryCut: oldProcessedCut, sourceView: oldView } };
    }
    const maximum = request.limit ?? EPISODE_STATE_LIMITS.rollupLeavesPerJob, pages = [];
    let exhausted = false, stateGeneration = head ? num(head, "stateGeneration") : 0, requestedCut = request.view.eventCut, processedCut = 0, processedMemoryCut = 0;
    for (let count = 0; count < maximum; count++) {
        const page = await readEpisodeRollupInputPage(request, cursor, options, budget);
        stateGeneration = page.stateGeneration;
        requestedCut = page.requestedCut;
        processedCut = page.processedCut;
        processedMemoryCut = page.processedMemoryCut;
        if (!page.episode) {
            cursor = page.next;
            exhausted = true;
            break;
        }
        pages.push(page);
        cursor = page.next;
        if (!cursor)
            fail("search-v3-rollup-input-invalid");
    }
    if (!exhausted && pages.length < maximum)
        exhausted = true;
    const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation") + 1;
    const value = frontier(store, line), created = { count: 0 };
    let root;
    store.transaction(() => {
        for (const page of pages) {
            const leaf = leafFrom(page.episode);
            if (writeNode(store, leaf, generation))
                created.count++;
            appendFrontier(store, value, leaf, generation, created);
        }
        root = buildRoot(store, value, generation, created);
        if (created.count > EPISODE_STATE_LIMITS.rollupNodesPerJob)
            fail("search-v3-rollup-job-node-limit");
        saveFrontier(store, line, value);
        store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
        store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?)", line, canonicalJson(request.view), stateGeneration, cursor ? canonicalJson(cursor) : null, exhausted ? 1 : 0, root?.nodeId ?? null, generation);
        if (root)
            store.run("INSERT INTO publications VALUES(?,?,?,?,?,?,?)", generation, line, request.view.branchKey, processedCut, stateGeneration, root.nodeId, exhausted ? 1 : 0);
    });
    const publication = root ? store.get("SELECT * FROM publications WHERE generation=?", generation) : undefined;
    const pending = remainingWork(requestedCut, processedCut, exhausted, pages.length);
    const representedClosedRange = root ? root.range : null;
    return { readiness: root ? exhausted ? "ready" : "partial" : "missing", rollupGeneration: generation, stateGeneration,
        branchKey: request.view.branchKey, requestedCut, processedCut, processedMemoryCut, knownThroughCut: processedCut, complete: exhausted,
        closedIntervalsOnly: true, representedClosedRange, closedThroughCut: root?.range.end.eventSeq ?? 0, excludedOpenTail: Boolean(root),
        remainingWork: pending, noEligibleEpisode: pages.length === 0,
        ...(publication ? { handle: handle(request, publication), rootReference: { kind: "rollup-node", handle: handle(request, publication), nodeId: root.nodeId, path: [root.nodeId] } } : {}),
        next: cursor, metrics: { leafPages: pages.length, nodesCreated: created.count, sqliteStatements: store.statements } };
}
function publicationFor(request, store) {
    const line = lineage(request), generation = request.handle?.rollupGeneration ?? request.generation;
    if (!generation)
        fail("search-v3-rollup-generation-required");
    const row = store.get("SELECT * FROM publications WHERE lineage=? AND generation=?", line, generation);
    if (!row || num(row, "eventCut") > request.view.eventCut || str(row, "branchKey") !== request.view.branchKey
        || request.handle && (request.handle.rootNodeId !== str(row, "rootNodeId") || request.handle.stateGeneration !== num(row, "stateGeneration")
            || request.handle.eventCut !== num(row, "eventCut") || request.handle.branchKey !== str(row, "branchKey")))
        fail("search-v3-rollup-publication-missing");
    return row;
}
function matches(node, query) {
    if (!query)
        return true;
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_./:+-]{2,}/gu) ?? [];
    const text = canonicalJson({ summary: node.summary, protected: node.protectedReferences, metadata: node.metadataHints }).toLowerCase();
    return terms.some(term => text.includes(term));
}
function nodeReference(h, node, path) {
    return { kind: "rollup-node", handle: h, nodeId: node.nodeId, path, nodeType: node.nodeType, level: node.level,
        range: node.range, sourceCoverageHash: node.sourceCoverageHash };
}
function verifiedPath(store, rootId, targetId, supplied) {
    if (targetId === rootId) {
        if (supplied && (supplied.length !== 1 || supplied[0] !== rootId))
            fail("search-v3-rollup-path-invalid");
        return { path: [rootId], visited: 0 };
    }
    if (!supplied || supplied.length < 2 || supplied.length > EPISODE_STATE_LIMITS.rollupTreeLevels
        || supplied[0] !== rootId || supplied.at(-1) !== targetId)
        fail("search-v3-rollup-path-invalid");
    const route = [...supplied];
    for (let index = 0; index < route.length - 1; index++) {
        const parent = loadNode(store, route[index]);
        if (!parent.orderedChildren.includes(route[index + 1]))
            fail("search-v3-rollup-path-invalid");
    }
    return { path: route, visited: route.length - 1 };
}
function episodeItem(h, node, path) {
    return { reference: { kind: "episode", handle: h, nodeId: node.nodeId, path, episodeKey: node.episodeKey,
            fragmentIndex: node.fragmentIndex, episodeFragment: node.episodeFragment, closure: node.closure, boundaries: node.range },
        summary: node.summary, objective: node.objective, protectedReferences: node.protectedReferences,
        omittedProtectedCount: node.omittedProtectedCount, metadataHints: node.metadataHints, omittedMetadataCount: node.omittedMetadataCount,
        remainingDetail: node.remainingDetail };
}
function recall(request, store) {
    const publication = publicationFor(request, store), h = handle(request, publication), rootId = str(publication, "rootNodeId");
    const targetId = request.nodeId ?? rootId, route = verifiedPath(store, rootId, targetId, request.path);
    const target = loadNode(store, targetId), level = request.level ?? "root", limit = request.limit ?? EPISODE_STATE_LIMITS.page;
    const queryHash = sha(canonicalJson({ query: request.query?.trim() ?? "", level, nodeId: targetId, path: route.path,
        view: { branchKey: request.view.branchKey, eventCut: request.view.eventCut } }));
    if (request.after && (request.after.generation !== h.rollupGeneration || request.after.nodeId !== targetId
        || request.after.level !== level || request.after.queryHash !== queryHash))
        fail("search-v3-rollup-cursor-invalid");
    const start = request.after?.itemIndex ?? 0, wanted = Math.min(EPISODE_STATE_LIMITS.rollupNodesPerRecall, start + limit + 1);
    let visited = route.visited + 1, traversalLimited = false;
    const candidates = [];
    if (level === "root" || level === "child") {
        if (target.nodeType !== "rollup")
            fail("search-v3-rollup-level-invalid");
        for (const id of target.orderedChildren) {
            if (visited >= EPISODE_STATE_LIMITS.rollupNodesPerRecall) {
                traversalLimited = true;
                break;
            }
            candidates.push({ node: loadNode(store, id), path: [...route.path, id] });
            visited++;
        }
    }
    else if (!(level === "source" && target.nodeType === "episode-fragment")) {
        const queue = [{ node: target, path: route.path }];
        while (queue.length && candidates.length < wanted) {
            const current = queue.shift();
            if (current.node.nodeType === "episode-fragment") {
                if (matches(current.node, request.query))
                    candidates.push(current);
                continue;
            }
            if (visited + current.node.orderedChildren.length > EPISODE_STATE_LIMITS.rollupNodesPerRecall) {
                traversalLimited = true;
                break;
            }
            const children = current.node.orderedChildren.map(id => ({ node: loadNode(store, id), path: [...current.path, id] }));
            visited += children.length;
            children.sort((a, b) => Number(matches(b.node, request.query)) - Number(matches(a.node, request.query))
                || a.node.range.start.eventSeq - b.node.range.start.eventSeq || a.node.nodeId.localeCompare(b.node.nodeId));
            queue.push(...children);
        }
    }
    let allItems;
    if (level === "root" || level === "child")
        allItems = candidates.map(item => ({ reference: nodeReference(h, item.node, item.path),
            summary: item.node.summary, episodeCount: item.node.episodeCount, memberCount: item.node.memberCount,
            protectedCount: item.node.protectedReferences.length, omittedProtectedCount: item.node.omittedProtectedCount,
            metadataHintCount: item.node.metadataHints.length, omittedMetadataCount: item.node.omittedMetadataCount,
            remainingDetail: item.node.remainingDetail }));
    else if (level === "episode")
        allItems = candidates.filter((item) => item.node.nodeType === "episode-fragment")
            .map(item => episodeItem(h, item.node, item.path));
    else if (target.nodeType === "episode-fragment")
        allItems = target.sources.map(source => ({ reference: { kind: "exact-source",
                parentReference: episodeItem(h, target, route.path).reference, sourceKey: source.sourceKey }, source: source.source,
            exactBodyHash: source.exactBodyHash, exactBodyOmitted: source.exactBodyOmitted }));
    else
        allItems = candidates.filter((item) => item.node.nodeType === "episode-fragment")
            .flatMap(item => item.node.sources.map(source => ({ reference: { kind: "exact-source", parentReference: episodeItem(h, item.node, item.path).reference,
                sourceKey: source.sourceKey }, source: source.source, exactBodyHash: source.exactBodyHash, exactBodyOmitted: source.exactBodyOmitted })))
            .slice(0, EPISODE_STATE_LIMITS.rollupNodesPerRecall);
    const selected = allItems.slice(start, start + limit);
    const build = () => {
        const more = start + selected.length < allItems.length;
        const partialReasons = [...(more ? ["pagination"] : []), ...(traversalLimited ? ["bounded-node-traversal"] : [])];
        return { handle: h, parentReference: { ...nodeReference(h, target, route.path), requestedLevel: level, query: request.query },
            level, node: { summary: target.summary, episodeCount: target.episodeCount, memberCount: target.memberCount,
                protectedCount: target.protectedReferences.length, omittedProtectedCount: target.omittedProtectedCount,
                metadataHintCount: target.metadataHints.length, omittedMetadataCount: target.omittedMetadataCount, remainingDetail: target.remainingDetail },
            items: selected, ...(more ? { next: { nodeId: target.nodeId, itemIndex: start + selected.length, generation: h.rollupGeneration,
                    level, queryHash } } : {}), partial: partialReasons.length > 0, partialReasons,
            metrics: { nodesVisited: visited, nodeLimit: EPISODE_STATE_LIMITS.rollupNodesPerRecall, sqliteStatements: store.statements } };
    };
    // A legal count can still exceed the byte envelope. Preserve exact pagination
    // instead of refusing a page containing several individually valid large nodes.
    while (selected.length > 1 && Buffer.byteLength(JSON.stringify(build())) > EPISODE_STATE_LIMITS.responseBytes - 4096)
        selected.pop();
    return build();
}
function status(request, store) {
    const head = store.get("SELECT * FROM heads WHERE lineage=?", lineage(request));
    if (!head)
        return { readiness: "missing", rollupGeneration: num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation"),
            branchKey: request.view.branchKey, requestedCut: request.view.eventCut, processedCut: 0, processedMemoryCut: 0, knownThroughCut: 0,
            complete: false, closedIntervalsOnly: true, representedClosedRange: null, remainingWork: "state-catch-up", noEligibleEpisode: true,
            metrics: { sqliteStatements: store.statements } };
    const cursor = head.cursor ? JSON.parse(str(head, "cursor")) : undefined;
    const snapshot = cursor?.snapshot;
    if (!head.rootNodeId) {
        const processedCut = snapshot?.processedCut ?? 0, processedMemoryCut = snapshot?.processedMemoryCut ?? processedCut;
        const complete = num(head, "complete") === 1;
        return { readiness: "missing", rollupGeneration: num(head, "generation"), stateGeneration: num(head, "stateGeneration"),
            branchKey: request.view.branchKey, requestedCut: request.view.eventCut, processedCut, processedMemoryCut, knownThroughCut: processedCut,
            complete, closedIntervalsOnly: true, representedClosedRange: null,
            remainingWork: remainingWork(request.view.eventCut, processedCut, complete, 0), noEligibleEpisode: true, cursor,
            metrics: { sqliteStatements: store.statements } };
    }
    const publication = store.get("SELECT * FROM publications WHERE generation=?", num(head, "generation"));
    const publicationRow = publication ?? fail("search-v3-rollup-publication-missing");
    if (str(publicationRow, "branchKey") !== request.view.branchKey || num(publicationRow, "eventCut") > request.view.eventCut)
        return { readiness: "incompatible", rollupGeneration: num(publicationRow, "generation"), branchKey: request.view.branchKey,
            requestedCut: request.view.eventCut, processedCut: 0, processedMemoryCut: 0, knownThroughCut: 0, complete: false,
            closedIntervalsOnly: true, representedClosedRange: null, remainingWork: "state-catch-up", noEligibleEpisode: true,
            metrics: { sqliteStatements: store.statements } };
    const h = handle(request, publicationRow), root = loadNode(store, h.rootNodeId), complete = num(head, "complete") === 1;
    const rootRow = store.get("SELECT createdGeneration FROM nodes WHERE nodeId=?", h.rootNodeId);
    const noEligibleEpisode = complete && Boolean(rootRow) && num(rootRow, "createdGeneration") < h.rollupGeneration;
    return { readiness: complete ? "ready" : "partial", rollupGeneration: h.rollupGeneration,
        stateGeneration: h.stateGeneration, branchKey: h.branchKey, requestedCut: request.view.eventCut, processedCut: h.eventCut,
        processedMemoryCut: snapshot?.processedMemoryCut ?? h.eventCut, knownThroughCut: h.eventCut, complete,
        closedIntervalsOnly: true, representedClosedRange: root.range, closedThroughCut: root.range.end.eventSeq,
        excludedOpenTail: true, remainingWork: remainingWork(request.view.eventCut, h.eventCut, complete, noEligibleEpisode ? 0 : 1), noEligibleEpisode,
        handle: h, rootReference: { kind: "rollup-node", handle: h, nodeId: h.rootNodeId, path: [h.rootNodeId] },
        cursor, metrics: { sqliteStatements: store.statements } };
}
export async function executeEpisodeRollupRequest(request, options = {}) {
    const create = request.op === "materializeRollup", budget = { bytes: 0 };
    let db;
    try {
        const catalog = await (options.catalogExecutor ?? executeCatalogStoreRequest)({ v: 1, catalogDirectory: request.catalogDirectory,
            sessionKey: request.identity.capsule.sessionKey, op: "page", view: request.view, after: request.view.eventCut, limit: 1 });
        budget.bytes += catalog.sourceBytes;
        if (!catalog.ok)
            fail(catalog.code === "catalog-source-changed" ? "search-v3-rollup-source-changed" : "search-v3-rollup-catalog-unavailable");
        const action = async () => {
            const path = join(request.searchDirectory, "rollup-v3.sqlite"), validate = (candidate) => new Store(candidate, request).validate(create);
            if (request.op === "rollupStatus") {
                try {
                    lstatSync(path);
                }
                catch (error) {
                    if (error.code === "ENOENT")
                        fail("search-v3-rollup-store-missing");
                    throw error;
                }
            }
            db = create ? CatalogSqlite.create(path, validate) : CatalogSqlite.open(path, validate);
            const store = new Store(db, request);
            if (create)
                store.initialize();
            else
                store.validate(false);
            const result = request.op === "materializeRollup" ? await materialize(request, store, options, budget)
                : request.op === "recallRollup" ? recall(request, store) : status(request, store);
            const response = { v: 1, ok: true, result: { ...result,
                    coverageScope: "Closed episode intervals and exact M07 source references. Interval closure is not task completion. Protected omissions stay explicit and detail remains reachable through children or exact sources." },
                sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes };
            if (Buffer.byteLength(JSON.stringify(response)) > EPISODE_STATE_LIMITS.responseBytes)
                fail("search-v3-rollup-response-limit");
            if (create)
                try {
                    db.checkpoint();
                }
                catch { /* committed WAL remains authoritative */ }
            return response;
        };
        return create ? await withRuntimeMutex(join(request.searchDirectory, "rollup-publication.lock"), action) : await action();
    }
    catch (error) {
        const candidate = error.code;
        const mapped = { "catalog-storage-unsafe": "search-v3-rollup-storage-unsafe", "catalog-sqlite-busy": "search-v3-rollup-store-busy",
            "catalog-sqlite-corrupt": "search-v3-rollup-store-corrupt", "catalog-sqlite-capability": "search-v3-rollup-store-capability",
            "catalog-sqlite-limit": "search-v3-rollup-store-limit", "catalog-sqlite-failed": "search-v3-rollup-store-failed",
            "catalog-sqlite-unavailable": "search-v3-rollup-store-capability" };
        const code = candidate?.startsWith("search-v3-rollup-") ? candidate : candidate && mapped[candidate] ? mapped[candidate] :
            candidate === "ENOSPC" ? "search-v3-rollup-storage-full" : "search-v3-rollup-storage-io";
        return { v: 1, ok: false, code, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes,
            resumable: !["search-v3-rollup-store-mismatch", "search-v3-rollup-version-mismatch", "search-v3-rollup-storage-unsafe"].includes(code) };
    }
    finally {
        try {
            db?.close();
        }
        catch { /* preserve bounded response */ }
    }
}
//# sourceMappingURL=episode-rollup-store.js.map