import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeCapsuleRequest } from "./capsule-store.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { canonicalJson } from "./capsule-segment.js";
import { stableStringify } from "./utils.js";
import { CatalogSqlite } from "./catalog-sqlite.js";
import { EPISODE_STATE_LIMITS, EPISODE_STATE_RULESET_VERSION, EPISODE_STATE_SCHEMA_VERSION, isEpisodeStateRequest, } from "./episode-state-contract.js";
import { reduceEpisodeStateEnvelope } from "./episode-state-reducer.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const num = (row, key) => Number(row[key]);
const str = (row, key) => String(row[key]);
const sourceKey = (source) => sha(canonicalJson(source));
const lineage = (request) => sha(canonicalJson({ branchKey: request.view.branchKey, segments: request.view.segments.map(item => item.segment) }));
const viewHash = (request) => sha(canonicalJson(request.view));
const schema = [
    "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, searchRoute TEXT NOT NULL, capsuleRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, ruleset TEXT NOT NULL, generation INTEGER NOT NULL)",
    "CREATE TABLE cuts (lineage TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(lineage,eventSeq,descriptor)) WITHOUT ROWID",
    "CREATE TABLE coverage (lineage TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, generation INTEGER NOT NULL, restrictionGap INTEGER NOT NULL, openWorkGap INTEGER NOT NULL, optionalGap INTEGER NOT NULL, PRIMARY KEY(lineage,eventSeq,descriptor)) WITHOUT ROWID",
    "CREATE INDEX coverage_restriction ON coverage(lineage,restrictionGap,eventSeq,generation)",
    "CREATE INDEX coverage_work ON coverage(lineage,openWorkGap,eventSeq,generation)",
    "CREATE INDEX coverage_optional ON coverage(lineage,optionalGap,eventSeq,generation)",
    "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, afterEventSeq INTEGER NOT NULL, afterDescriptor INTEGER NOT NULL, metadataAfterEventSeq INTEGER NOT NULL, generation INTEGER NOT NULL, complete INTEGER NOT NULL, metadataComplete INTEGER NOT NULL, partialCount INTEGER NOT NULL)",
    "CREATE TABLE episodes (lineage TEXT NOT NULL, episodeKey TEXT NOT NULL, startEventSeq INTEGER NOT NULL, startDescriptor INTEGER NOT NULL, endEventSeq INTEGER NOT NULL, endDescriptor INTEGER NOT NULL, open INTEGER NOT NULL, memberCount INTEGER NOT NULL, objective TEXT NOT NULL, objectiveEvidence TEXT NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,episodeKey,createdGeneration)) WITHOUT ROWID",
    "CREATE INDEX episodes_page ON episodes(lineage,createdGeneration,startEventSeq,startDescriptor,episodeKey)",
    "CREATE TABLE episode_membership (lineage TEXT NOT NULL, episodeKey TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, sourceKey TEXT NOT NULL, source TEXT NOT NULL, cue TEXT NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,episodeKey,eventSeq,descriptor,sourceKey)) WITHOUT ROWID",
    "CREATE INDEX episode_member_source ON episode_membership(lineage,sourceKey,episodeKey)",
    "CREATE VIRTUAL TABLE episode_fts USING fts5(lineage UNINDEXED,episodeKey UNINDEXED,body,tokenize='unicode61')",
    "CREATE VIRTUAL TABLE episode_member_fts USING fts5(lineage UNINDEXED,episodeKey UNINDEXED,sourceKey UNINDEXED,body,tokenize='unicode61')",
    "CREATE TABLE state_items (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, propositionKey TEXT NOT NULL, spanKey TEXT NOT NULL, subject TEXT NOT NULL, revision TEXT NOT NULL, kind TEXT NOT NULL, authority TEXT NOT NULL, confidence TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, resolutionEvidence TEXT, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
    "CREATE INDEX state_page ON state_items(lineage,createdGeneration,eventSeq,descriptor,stableKey,supersededGeneration)",
    "CREATE INDEX state_transition ON state_items(lineage,propositionKey,authority,status,createdGeneration,supersededGeneration)",
    "CREATE VIRTUAL TABLE state_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
    "CREATE TABLE resources (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, resourceKind TEXT NOT NULL, resourceKey TEXT NOT NULL, relation TEXT NOT NULL, revision TEXT, revisionBasis TEXT NOT NULL, currentRevision TEXT NOT NULL, knownThrough INTEGER NOT NULL, failed INTEGER, executionOutcome TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
    "CREATE INDEX resource_page ON resources(lineage,createdGeneration,eventSeq,descriptor,stableKey,supersededGeneration)",
    "CREATE INDEX resource_current ON resources(lineage,resourceKey,revision,createdGeneration,supersededGeneration)",
    "CREATE VIRTUAL TABLE resource_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
    "CREATE TABLE memory_items (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, memoryId TEXT NOT NULL, action TEXT NOT NULL, text TEXT NOT NULL, scope TEXT NOT NULL, confidence REAL NOT NULL, sourceRef TEXT NOT NULL, eventHash TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, supersededGeneration INTEGER, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
    "CREATE INDEX memory_page ON memory_items(lineage,createdGeneration,eventSeq,stableKey,supersededGeneration,state)",
    "CREATE INDEX memory_current ON memory_items(lineage,memoryId,createdGeneration,supersededGeneration)",
    "CREATE VIRTUAL TABLE memory_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
    "CREATE TABLE retention_hints (lineage TEXT NOT NULL, stableKey TEXT NOT NULL, data TEXT NOT NULL, evidence TEXT NOT NULL, eventSeq INTEGER NOT NULL, createdGeneration INTEGER NOT NULL, PRIMARY KEY(lineage,stableKey)) WITHOUT ROWID",
    "CREATE INDEX retention_page ON retention_hints(lineage,createdGeneration,eventSeq,stableKey)",
    "CREATE VIRTUAL TABLE retention_fts USING fts5(lineage UNINDEXED,stableKey UNINDEXED,body,tokenize='unicode61')",
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
            fail("search-v3-state-version-mismatch");
        }
        const meta = this.get("SELECT * FROM meta WHERE singleton=1");
        if (!meta || num(meta, "version") !== EPISODE_STATE_SCHEMA_VERSION || str(meta, "identity") !== canonicalJson(this.request.identity)
            || str(meta, "searchRoute") !== this.request.searchDirectory || str(meta, "capsuleRoute") !== this.request.capsuleDirectory
            || str(meta, "catalogRoute") !== this.request.catalogDirectory || str(meta, "ruleset") !== EPISODE_STATE_RULESET_VERSION)
            fail("search-v3-state-store-mismatch");
        for (const sql of schema) {
            const parts = sql.split(" "), name = parts[1] === "VIRTUAL" ? parts[3] : parts[2];
            if (this.get("SELECT sql FROM sqlite_master WHERE name=?", name)?.sql !== sql)
                fail("search-v3-state-version-mismatch");
        }
    }
    initialize() {
        this.transaction(() => {
            this.validate(true);
            if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")) {
                for (const sql of schema)
                    this.run(sql);
                this.run("INSERT INTO meta VALUES(1,?,?,?,?,?,?,0)", EPISODE_STATE_SCHEMA_VERSION, canonicalJson(this.request.identity), this.request.searchDirectory, this.request.capsuleDirectory, this.request.catalogDirectory, EPISODE_STATE_RULESET_VERSION);
            }
        });
    }
}
function prepareDirectory(path) {
    const uid = process.getuid?.();
    if (uid === undefined || resolve(path) !== path || path === "/")
        fail("search-v3-state-storage-unsafe");
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o700)
        fail("search-v3-state-storage-unsafe");
}
async function capsuleCall(request, executor, budget, extra) {
    const response = await executor({ v: 1, derivedDirectory: request.capsuleDirectory, catalogDirectory: request.catalogDirectory,
        identity: request.identity.capsule, ...extra });
    budget.bytes += response.sourceBytes;
    if (budget.bytes > EPISODE_STATE_LIMITS.sourceBytesPerJob)
        fail("search-v3-state-source-budget");
    if (!response.ok)
        return fail(response.code === "capsule-source-changed" ? "search-v3-state-source-changed" : "search-v3-state-capsule-unavailable");
    return response.result;
}
async function body(request, envelope, executor, budget) {
    const length = envelope.source.decodedUtf16.end - envelope.source.decodedUtf16.start;
    if (length > EPISODE_STATE_LIMITS.wholeBodyUtf16Units)
        return undefined;
    if (length === 0)
        return "";
    const result = await capsuleCall(request, executor, budget, { op: "chunkRange", view: request.view, source: envelope.source,
        decodedStart: envelope.source.decodedUtf16.start, decodedLength: length, limit: 2 });
    const bytes = Buffer.from(String(result.data), "base64"), text = bytes.toString("utf16le");
    if (bytes.length !== length * 2 || text.length !== length)
        fail("search-v3-state-source-invalid");
    return text;
}
async function catalogCall(request, executor, budget, extra) {
    const response = await executor({ v: 1, catalogDirectory: request.catalogDirectory, sessionKey: request.identity.capsule.sessionKey, ...extra });
    budget.bytes += response.sourceBytes;
    if (budget.bytes > EPISODE_STATE_LIMITS.sourceBytesPerJob)
        fail("search-v3-state-source-budget");
    if (!response.ok)
        return fail(response.code === "catalog-source-changed" ? "search-v3-state-source-changed" : "search-v3-state-catalog-unavailable");
    return response.result;
}
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function rawFact(request, envelope, event, rawText, field, value) {
    const encoded = JSON.stringify(value), expression = new RegExp(`"${escapeRegex(field)}"\\s*:\\s*${escapeRegex(encoded)}`, "gu");
    const matches = [...rawText.matchAll(expression)];
    if (matches.length !== 1)
        return undefined;
    const tokenAt = matches[0].index + matches[0][0].lastIndexOf(encoded), byteAt = Buffer.byteLength(rawText.slice(0, tokenAt)), tokenBytes = Buffer.from(encoded);
    const segment = (request.view.segments.find(item => envelope.source.eventSeq <= item.cut) ?? fail("search-v3-state-source-invalid")).segment;
    const source = { catalogStoreKey: request.identity.capsule.catalogStoreKey, sessionKey: request.identity.capsule.sessionKey,
        catalogGeneration: request.identity.capsule.catalogGeneration, shardKey: event.shardKey, segment, eventSeq: event.seq, ordinal: event.ordinal,
        descriptor: envelope.source.descriptor, ...(envelope.source.blockIndex === undefined ? {} : { blockIndex: envelope.source.blockIndex }), field,
        raw: { start: event.rawStart + byteAt, end: event.rawStart + byteAt + tokenBytes.length }, coordinateKind: "raw-json",
        rawHashAlgorithm: "sha256-bytes-v1", rawHash: createHash("sha256").update(tokenBytes).digest("hex") };
    return { value, source };
}
async function exactStructural(request, envelope, executor, budget) {
    const page = await catalogCall(request, executor, budget, { op: "page", view: request.view, after: Math.max(0, envelope.source.eventSeq - 1), limit: 1 });
    const candidate = page.events?.[0];
    if (!candidate || candidate.seq !== envelope.source.eventSeq || !Number.isSafeInteger(candidate.rawStart) || !Number.isSafeInteger(candidate.rawEnd))
        return fail("search-v3-state-source-invalid");
    const event = candidate;
    const length = event.rawEnd - event.rawStart;
    if (length < 1 || length > 64 * 1024)
        return undefined;
    const raw = await catalogCall(request, executor, budget, { op: "raw", view: request.view, eventSeq: event.seq, offset: event.rawStart, length });
    const bytes = Buffer.from(String(raw.data), "base64");
    if (bytes.length !== length)
        fail("search-v3-state-source-invalid");
    let parsed;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    }
    catch {
        return undefined;
    }
    const message = parsed?.message;
    if (!message || typeof message !== "object")
        return undefined;
    const rawText = bytes.toString("utf8"), block = Array.isArray(message.content) && envelope.source.blockIndex !== undefined ? message.content[envelope.source.blockIndex] : undefined;
    const role = typeof message.role === "string" ? rawFact(request, envelope, event, rawText, "role", message.role) : undefined;
    const toolValue = typeof block?.name === "string" ? block.name : typeof message.toolName === "string" ? message.toolName : undefined;
    const toolName = toolValue === undefined ? undefined : rawFact(request, envelope, event, rawText, typeof block?.name === "string" ? "name" : "toolName", toolValue);
    const errorValue = typeof message.isError === "boolean" ? message.isError : typeof block?.isError === "boolean" ? block.isError : undefined;
    const isError = errorValue === undefined ? undefined : rawFact(request, envelope, event, rawText, "isError", errorValue);
    const exitValue = typeof message.exitCode === "number" ? message.exitCode : typeof block?.exitCode === "number" ? block.exitCode : undefined;
    const exitCode = exitValue === undefined ? undefined : rawFact(request, envelope, event, rawText, "exitCode", exitValue);
    const cancelledValue = typeof message.cancelled === "boolean" ? message.cancelled : typeof block?.cancelled === "boolean" ? block.cancelled : undefined;
    const cancelled = cancelledValue === undefined ? undefined : rawFact(request, envelope, event, rawText, "cancelled", cancelledValue);
    return { ...(role ? { role } : {}), ...(toolName ? { toolName } : {}), ...(isError ? { isError } : {}), ...(exitCode ? { exitCode } : {}), ...(cancelled ? { cancelled } : {}) };
}
const memoryActions = new Set(["remember", "update", "promote", "touch", "demote", "forget"]);
function rawEventSource(request, event, bytes) {
    const segment = (request.view.segments.find(item => event.seq <= item.cut) ?? fail("search-v3-state-source-invalid")).segment;
    return { catalogStoreKey: request.identity.capsule.catalogStoreKey, sessionKey: request.identity.capsule.sessionKey,
        catalogGeneration: request.identity.capsule.catalogGeneration, shardKey: event.shardKey, segment, eventSeq: event.seq,
        ordinal: event.ordinal, descriptor: 0, field: "data", raw: { start: event.rawStart, end: event.rawEnd }, coordinateKind: "raw-json",
        rawHashAlgorithm: "sha256-bytes-v1", rawHash: createHash("sha256").update(bytes).digest("hex") };
}
function validMemoryEvent(data, previousHash) {
    if (!data || data.schemaVersion !== 2 || typeof data.eventId !== "string" || typeof data.memoryId !== "string"
        || !memoryActions.has(data.action) || typeof data.timestamp !== "string" || !Number.isSafeInteger(data.turn) || data.turn < 0
        || data.previousEventHash !== previousHash || typeof data.eventHash !== "string" || typeof data.sourceRef !== "string"
        || typeof data.scope !== "string" || data.authority !== "ordinary" || !/^(?:memory-tool|history-recall):[^\s]{1,1024}$/u.test(data.sourceRef) || typeof data.confidence !== "number"
        || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1)
        return false;
    if ((data.action === "remember" || data.action === "update") && (typeof data.text !== "string" || !data.text.trim()))
        return false;
    const { eventHash, ...payload } = data;
    return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 20) === eventHash;
}
function validRetentionHint(data) {
    if (!data || typeof data !== "object" || Array.isArray(data))
        return false;
    const allowed = new Set(["currentUnresolvedWork", "preserveExact", "olderEvidenceLikelyNeeded", "completedRangesSafeToCompress", "abandonedApproaches"]);
    return Object.keys(data).length > 0 && Object.keys(data).every(key => allowed.has(key) && typeof data[key] === "string" && data[key].trim().length > 0 && data[key].length <= 4096);
}
function attachMetadataMember(store, request, eventSeq, source, cue, generation) {
    const line = lineage(request);
    const episode = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.startEventSeq<=? AND e.createdGeneration<=? AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line, eventSeq, generation, generation);
    if (episode) {
        const memberSourceKey = sourceKey(source), episodeKey = str(episode, "episodeKey"), boundedCue = cue.slice(0, 2048);
        const exists = store.get("SELECT 1 AS found FROM episode_membership WHERE lineage=? AND episodeKey=? AND eventSeq=? AND descriptor=0 AND sourceKey=?", line, episodeKey, eventSeq, memberSourceKey);
        if (!exists) {
            store.run("INSERT INTO episode_membership VALUES(?,?,?,?,?,?,?,?)", line, episodeKey, eventSeq, 0, memberSourceKey, canonicalJson(source), boundedCue, generation);
            store.run("INSERT INTO episode_member_fts(lineage,episodeKey,sourceKey,body) VALUES(?,?,?,?)", line, episodeKey, memberSourceKey, boundedCue);
            if (num(episode, "createdGeneration") === generation)
                store.run("UPDATE episodes SET memberCount=memberCount+1 WHERE lineage=? AND episodeKey=? AND createdGeneration=?", line, episodeKey, generation);
            else
                store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, episodeKey, num(episode, "startEventSeq"), num(episode, "startDescriptor"), Math.max(num(episode, "endEventSeq"), eventSeq), num(episode, "endDescriptor"), num(episode, "open"), num(episode, "memberCount") + 1, str(episode, "objective"), str(episode, "objectiveEvidence"), generation);
        }
        return true;
    }
    return false;
}
function insertMemoryMetadata(store, request, data, source, generation) {
    const line = lineage(request), prior = store.get("SELECT * FROM memory_items WHERE lineage=? AND memoryId=? AND supersededGeneration IS NULL ORDER BY createdGeneration DESC LIMIT 1", line, data.memoryId);
    if ((data.action === "remember") === Boolean(prior))
        return false;
    const text = typeof data.text === "string" ? data.text.trim() : prior ? str(prior, "text") : "";
    const scope = typeof data.scope === "string" ? data.scope : prior ? str(prior, "scope") : "session";
    if (!text && data.action !== "remember")
        return false;
    if (prior)
        store.run("UPDATE memory_items SET supersededGeneration=? WHERE lineage=? AND stableKey=?", generation, line, str(prior, "stableKey"));
    if (typeof data.supersedesMemoryId === "string")
        store.run("UPDATE memory_items SET supersededGeneration=? WHERE lineage=? AND memoryId=? AND supersededGeneration IS NULL", generation, line, data.supersedesMemoryId);
    const state = data.action === "demote" || data.action === "forget" ? "demoted" : data.action === "touch" && prior ? str(prior, "state") : "current";
    const stableKey = sha(`memory\n${data.memoryId}\n${data.eventHash}`);
    store.run("INSERT OR IGNORE INTO memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, stableKey, data.memoryId, data.action, text, scope, data.confidence, data.sourceRef, data.eventHash, state, canonicalJson({ source, exactText: stableStringify(data) }), source.eventSeq, generation, null);
    store.run("INSERT INTO memory_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, stableKey, `${data.memoryId} ${scope} ${text}`);
    store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, source.eventSeq, 0, generation);
    attachMetadataMember(store, request, source.eventSeq, source, `memory ${data.action} ${data.memoryId}: ${text}`, generation);
    return true;
}
function insertRetentionMetadata(store, request, data, source, generation) {
    const line = lineage(request), stableKey = sha(`retention\n${canonicalJson(source)}`);
    store.run("INSERT OR IGNORE INTO retention_hints VALUES(?,?,?,?,?,?)", line, stableKey, canonicalJson(data), canonicalJson({ source, exactText: stableStringify(data) }), source.eventSeq, generation);
    store.run("INSERT INTO retention_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, stableKey, Object.values(data).join(" "));
    store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, source.eventSeq, 0, generation);
    attachMetadataMember(store, request, source.eventSeq, source, `retention hint: ${Object.values(data).join(" ")}`, generation);
}
async function materializeMetadata(request, store, executor, budget, afterEventSeq, currentGeneration, throughEventSeq) {
    const page = await catalogCall(request, executor, budget, { op: "page", view: request.view, after: afterEventSeq, limit: EPISODE_STATE_LIMITS.materializeCapsules });
    const events = (page.events ?? []).filter(event => event.seq <= throughEventSeq);
    let generation = currentGeneration, acceptedMemoryEvents = 0, acceptedRetentionHints = 0, partial = 0;
    const lastMemory = store.get("SELECT eventHash FROM memory_items WHERE lineage=? ORDER BY createdGeneration DESC LIMIT 1", lineage(request));
    let previousHash = lastMemory ? str(lastMemory, "eventHash") : "0".repeat(64);
    for (const event of events) {
        const customType = event.metadata?.customType ?? event.metadata?.messageCustomType;
        if (customType !== "chrono-memory-v2-event" && customType !== "chrono-compact-retention-hint")
            continue;
        const length = event.rawEnd - event.rawStart;
        if (length < 1 || length > 64 * 1024) {
            partial++;
            continue;
        }
        const raw = await catalogCall(request, executor, budget, { op: "raw", view: request.view, eventSeq: event.seq, offset: event.rawStart, length });
        const bytes = Buffer.from(String(raw.data), "base64");
        if (bytes.length !== length)
            fail("search-v3-state-source-invalid");
        let record;
        try {
            record = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            partial++;
            continue;
        }
        if (record?.type !== "custom" || record.customType !== customType) {
            partial++;
            continue;
        }
        const data = record.data;
        const source = rawEventSource(request, event, bytes);
        if (customType === "chrono-memory-v2-event") {
            if (data && typeof data.eventHash === "string" && store.get("SELECT stableKey FROM memory_items WHERE lineage=? AND eventHash=?", lineage(request), data.eventHash)) {
                continue; // A repeated mirror must not rewind the producer hash chain.
            }
            if (!validMemoryEvent(data, previousHash)) {
                partial++;
                continue;
            }
            const nextGeneration = generation + 1;
            let inserted = false;
            store.transaction(() => {
                inserted = insertMemoryMetadata(store, request, data, source, nextGeneration);
                if (inserted)
                    store.run("UPDATE meta SET generation=? WHERE singleton=1", nextGeneration);
            });
            if (!inserted) {
                partial++;
                continue;
            }
            generation = nextGeneration;
            previousHash = data.eventHash;
            acceptedMemoryEvents++;
        }
        else if (validRetentionHint(data)) {
            const stableKey = sha(`retention\n${canonicalJson(source)}`);
            if (store.get("SELECT stableKey FROM retention_hints WHERE lineage=? AND stableKey=?", lineage(request), stableKey))
                continue;
            const nextGeneration = generation + 1;
            store.transaction(() => { insertRetentionMetadata(store, request, data, source, nextGeneration); store.run("UPDATE meta SET generation=? WHERE singleton=1", nextGeneration); });
            generation = nextGeneration;
            acceptedRetentionHints++;
        }
        else
            partial++;
    }
    const next = events.length ? events[events.length - 1].seq : afterEventSeq;
    const complete = throughEventSeq >= request.view.eventCut && (next >= request.view.eventCut || (page.events ?? []).length < EPISODE_STATE_LIMITS.materializeCapsules);
    return { afterEventSeq: next, complete, processedEvents: events.length, acceptedMemoryEvents, acceptedRetentionHints, partial, generation };
}
function extendsView(current, old) {
    return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
        && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index].cut >= item.cut);
}
function insertReduced(store, request, reduced, generation) {
    const line = lineage(request), eventSeq = reduced.source.eventSeq, descriptor = reduced.source.descriptor;
    if (reduced.startsEpisode) {
        const previous = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
        if (previous) {
            if (num(previous, "createdGeneration") === generation)
                store.run("UPDATE episodes SET endEventSeq=?,endDescriptor=?,open=0 WHERE lineage=? AND episodeKey=? AND createdGeneration=?", eventSeq, descriptor, line, str(previous, "episodeKey"), generation);
            else
                store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, str(previous, "episodeKey"), num(previous, "startEventSeq"), num(previous, "startDescriptor"), eventSeq, descriptor, 0, num(previous, "memberCount"), str(previous, "objective"), str(previous, "objectiveEvidence"), generation);
        }
        const episodeKey = sha(`${line}\n${eventSeq}\n${descriptor}`).slice(0, 32);
        store.run("INSERT OR IGNORE INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, episodeKey, eventSeq, descriptor, eventSeq, descriptor, 1, 1, reduced.objective?.exactText ?? "", canonicalJson(reduced.objective ?? { source: reduced.source, partial: true }), generation);
        store.run("INSERT INTO episode_fts(lineage,episodeKey,body) SELECT ?,?,? WHERE changes()>0", line, episodeKey, reduced.objective?.exactText ?? "");
    }
    else {
        const open = store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
        if (open) {
            if (num(open, "createdGeneration") === generation)
                store.run("UPDATE episodes SET endEventSeq=?,endDescriptor=?,memberCount=memberCount+1 WHERE lineage=? AND episodeKey=? AND createdGeneration=?", eventSeq, descriptor, line, str(open, "episodeKey"), generation);
            else
                store.run("INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?,?,?)", line, str(open, "episodeKey"), num(open, "startEventSeq"), num(open, "startDescriptor"), eventSeq, descriptor, 1, num(open, "memberCount") + 1, str(open, "objective"), str(open, "objectiveEvidence"), generation);
        }
    }
    const episode = store.get("SELECT e.episodeKey FROM episodes e WHERE e.lineage=? AND e.open=1 AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey) ORDER BY e.startEventSeq DESC,e.startDescriptor DESC LIMIT 1", line);
    const cue = [reduced.capsuleCue, ...reduced.states.map(item => `${item.kind}: ${item.evidence.exactText}`),
        ...reduced.resources.map(item => `${item.relation} ${item.resourceKey}: ${item.executionOutcome}`)].filter(Boolean).join("\n").slice(0, 2048);
    if (episode) {
        const memberSourceKey = sourceKey(reduced.source);
        store.run("INSERT OR IGNORE INTO episode_membership VALUES(?,?,?,?,?,?,?,?)", line, str(episode, "episodeKey"), eventSeq, descriptor, memberSourceKey, canonicalJson(reduced.source), cue, generation);
        store.run("INSERT INTO episode_member_fts(lineage,episodeKey,sourceKey,body) SELECT ?,?,?,? WHERE changes()>0", line, str(episode, "episodeKey"), memberSourceKey, cue);
    }
    for (const item of reduced.states) {
        if (item.transition) {
            const old = store.rows("SELECT stableKey,evidence FROM state_items WHERE lineage=? AND propositionKey=? AND authority=? AND kind='restriction' AND supersededGeneration IS NULL AND createdGeneration<? ORDER BY eventSeq,descriptor,stableKey LIMIT ?", EPISODE_STATE_LIMITS.page, line, item.transition.targetPropositionKey, item.authority, generation, EPISODE_STATE_LIMITS.page);
            for (const row of old)
                store.run("UPDATE state_items SET supersededGeneration=?,resolutionEvidence=? WHERE lineage=? AND stableKey=?", generation, canonicalJson(item.evidence), line, str(row, "stableKey"));
        }
        store.run("INSERT OR IGNORE INTO state_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, item.stableKey, item.propositionKey, item.spanKey, item.subject, item.revision, item.kind, item.authority, item.confidence, item.status, canonicalJson(item.evidence), eventSeq, descriptor, generation, null, null);
        store.run("INSERT INTO state_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, item.stableKey, `${item.kind} ${item.subject} ${item.evidence.exactText}`);
    }
    for (const item of reduced.resources) {
        // An observation never changes current revision without exact revision identity.
        // Retain revision observations as evolution; a later mention is not supersession.
        store.run("INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", line, item.stableKey, item.resourceKind, item.resourceKey, item.relation, item.revision, item.revisionBasis, item.currentRevision, item.knownThrough, item.failed === null ? null : item.failed ? 1 : 0, item.executionOutcome, canonicalJson(item.evidence), eventSeq, descriptor, generation, null);
        store.run("INSERT INTO resource_fts(lineage,stableKey,body) SELECT ?,?,? WHERE changes()>0", line, item.stableKey, `${item.resourceKind} ${item.resourceKey} ${item.relation} ${item.revision ?? "unknown"}`);
    }
}
async function materialize(request, store, executor, catalogExecutor, budget) {
    const line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
    if (head) {
        const old = JSON.parse(str(head, "view"));
        if (!extendsView(request.view, old))
            fail("search-v3-state-view-incompatible");
    }
    const afterEventSeq = request.after?.eventSeq ?? (head ? num(head, "afterEventSeq") : 0);
    const afterDescriptor = request.after?.descriptor ?? (head ? num(head, "afterDescriptor") : 0);
    const metadataAfterEventSeq = head ? num(head, "metadataAfterEventSeq") : 0;
    if (request.after && head && (afterEventSeq !== num(head, "afterEventSeq") || afterDescriptor !== num(head, "afterDescriptor")))
        fail("search-v3-state-cursor-invalid");
    const result = await capsuleCall(request, executor, budget, { op: "capsulePage", view: request.view, afterEventSeq, afterDescriptor,
        limit: Math.min(request.limit ?? EPISODE_STATE_LIMITS.materializeCapsules, EPISODE_STATE_LIMITS.materializeCapsules) });
    const capsules = (result.capsules ?? []), reduced = [];
    for (const envelope of capsules)
        reduced.push(reduceEpisodeStateEnvelope(envelope, await body(request, envelope, executor, budget), await exactStructural(request, envelope, catalogExecutor, budget)));
    const current = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation"), bodyGeneration = current + capsules.length;
    const nextEventSeq = Number(result.next?.afterEventSeq ?? afterEventSeq), nextDescriptor = Number(result.next?.afterDescriptor ?? afterDescriptor);
    const bodyComplete = Boolean(result.complete), priorPartial = head ? num(head, "partialCount") : 0;
    const bodyPartial = reduced.filter(item => item.partial).length;
    store.transaction(() => {
        for (const [index, item] of reduced.entries()) {
            const itemGeneration = current + index + 1;
            insertReduced(store, request, item, itemGeneration);
            store.run("INSERT OR REPLACE INTO coverage VALUES(?,?,?,?,?,?,?)", line, item.source.eventSeq, item.source.descriptor, itemGeneration, item.coverage.restrictionGap ? 1 : 0, item.coverage.openWorkGap ? 1 : 0, item.partial ? 1 : 0);
            store.run("INSERT OR REPLACE INTO cuts VALUES(?,?,?,?)", line, item.source.eventSeq, item.source.descriptor, itemGeneration);
        }
        if (capsules.length)
            store.run("UPDATE meta SET generation=? WHERE singleton=1", bodyGeneration);
        store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?,?,?)", line, canonicalJson(request.view), nextEventSeq, nextDescriptor, metadataAfterEventSeq, bodyGeneration, bodyComplete ? 1 : 0, metadataAfterEventSeq >= request.view.eventCut ? 1 : 0, priorPartial + bodyPartial);
    });
    const metadata = await materializeMetadata(request, store, catalogExecutor, budget, metadataAfterEventSeq, bodyGeneration, bodyComplete ? request.view.eventCut : Math.max(0, nextEventSeq - 1));
    const generation = metadata.generation, complete = bodyComplete && metadata.complete;
    const partialCount = priorPartial + bodyPartial + metadata.partial;
    store.transaction(() => {
        if (generation !== bodyGeneration)
            store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
        store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?,?,?)", line, canonicalJson(request.view), nextEventSeq, nextDescriptor, metadata.afterEventSeq, generation, bodyComplete ? 1 : 0, metadata.complete ? 1 : 0, partialCount);
    });
    // A non-final capsule page can stop between descriptors in nextEventSeq.
    // Report only the preceding event as fully materialized in that case.
    const knownThroughCut = complete ? request.view.eventCut : Math.max(0, Math.min(request.view.eventCut, nextEventSeq - 1, metadata.afterEventSeq));
    return { stateGeneration: generation, branchKey: request.view.branchKey, knownThroughCut, knownThrough: knownThroughCut, partial: !complete || partialCount > 0,
        complete, next: { eventSeq: nextEventSeq, descriptor: nextDescriptor, generation }, metadata: { afterEventSeq: metadata.afterEventSeq,
            complete: metadata.complete, processedEvents: metadata.processedEvents, acceptedMemoryEvents: metadata.acceptedMemoryEvents,
            acceptedRetentionHints: metadata.acceptedRetentionHints }, metrics: { capsules: capsules.length, partialRecords: reduced.filter(item => item.partial).length + metadata.partial,
            sqliteStatements: store.statements } };
}
function pin(request, store) {
    const cut = store.get("SELECT MAX(generation) AS generation FROM cuts WHERE lineage=? AND eventSeq<=?", lineage(request), request.view.eventCut);
    const current = cut ? num(cut, "generation") : 0, generation = request.after?.generation ?? current;
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > current)
        fail("search-v3-state-cursor-invalid");
    return generation;
}
function ftsQuery(text) {
    const terms = (text.toLowerCase().match(/[\p{L}\p{N}_./:+-]{2,}/gu) ?? []).slice(0, 12);
    if (!terms.length)
        fail("search-v3-state-query-invalid");
    return [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
function keyset(after, alias, keyColumn = "stableKey") {
    if (!after)
        return { sql: "", values: [] };
    return { sql: ` AND (${alias}.eventSeq>? OR (${alias}.eventSeq=? AND (${alias}.descriptor>? OR (${alias}.descriptor=? AND ${alias}.${keyColumn}>?))))`,
        values: [after.eventSeq, after.eventSeq, after.descriptor, after.descriptor, after.stableKey ?? ""] };
}
function visibleMemberCue(store, row, generation, cut) {
    const source = JSON.parse(str(row, "source"));
    if (source.coordinateKind !== "raw-json")
        return str(row, "cue");
    const memory = store.get("SELECT * FROM memory_items WHERE lineage=? AND eventSeq=? LIMIT 1", str(row, "lineage"), num(row, "eventSeq"));
    if (!memory)
        return str(row, "cue");
    const active = store.get("SELECT state,stableKey FROM memory_items WHERE lineage=? AND memoryId=? AND createdGeneration<=? AND eventSeq<=? ORDER BY createdGeneration DESC LIMIT 1", str(row, "lineage"), str(memory, "memoryId"), generation, cut);
    return active && str(active, "state") === "current" && str(active, "stableKey") === str(memory, "stableKey")
        ? str(row, "cue") : "Inactive memory metadata; exact archived source remains available.";
}
function recall(request, store) {
    const generation = pin(request, store), line = lineage(request), level = request.level ?? "state", limit = request.limit ?? EPISODE_STATE_LIMITS.page;
    const after = keyset(request.after, level === "episode" ? "m" : level === "resource" ? "r" : "s", level === "episode" ? "sourceKey" : "stableKey");
    const source = request.source ? sourceKey(request.source) : undefined;
    let rows, items;
    if (level === "episode") {
        const match = request.query ? ftsQuery(request.query) : undefined;
        let targetEpisode;
        if (source)
            targetEpisode = store.get("SELECT episodeKey FROM episode_membership WHERE lineage=? AND sourceKey=? AND createdGeneration<=? ORDER BY createdGeneration DESC LIMIT 1", line, source, generation)?.episodeKey;
        else if (match)
            targetEpisode = store.get("SELECT m.episodeKey FROM episode_member_fts JOIN episode_membership m ON m.lineage=episode_member_fts.lineage AND m.sourceKey=episode_member_fts.sourceKey WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=? AND episode_member_fts MATCH ? ORDER BY m.eventSeq,m.descriptor,m.sourceKey LIMIT 1", line, generation, request.view.eventCut, match)?.episodeKey;
        rows = targetEpisode === undefined && (source || match) ? [] : store.rows(`SELECT m.*,e.startEventSeq,e.startDescriptor,e.endEventSeq,e.endDescriptor,e.open,e.memberCount,e.objective,e.objectiveEvidence FROM episode_membership m JOIN episodes e ON e.lineage=m.lineage AND e.episodeKey=m.episodeKey AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=? AND v.endEventSeq<=?) WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=?${targetEpisode ? " AND m.episodeKey=?" : ""}${after.sql} ORDER BY m.eventSeq,m.descriptor,m.sourceKey LIMIT ?`, limit + 1, generation, request.view.eventCut, line, generation, request.view.eventCut, ...(targetEpisode ? [targetEpisode] : []), ...after.values, limit + 1);
        items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "sourceKey"), episodeKey: str(row, "episodeKey"),
            episode: { start: { eventSeq: num(row, "startEventSeq"), descriptor: num(row, "startDescriptor") }, end: { eventSeq: num(row, "endEventSeq"), descriptor: num(row, "endDescriptor") },
                open: num(row, "open") === 1, memberCount: num(row, "memberCount"), objective: str(row, "objective"), objectiveEvidence: JSON.parse(str(row, "objectiveEvidence")) },
            member: { eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), source: JSON.parse(str(row, "source")), cue: visibleMemberCue(store, row, generation, request.view.eventCut) } }));
    }
    else if (level === "resource") {
        const match = request.query ? ftsQuery(request.query) : undefined;
        rows = store.rows(`SELECT r.* FROM resources r${match ? " JOIN resource_fts ON resource_fts.lineage=r.lineage AND resource_fts.stableKey=r.stableKey" : ""} WHERE r.lineage=? AND r.createdGeneration<=? AND r.eventSeq<=? AND (r.supersededGeneration IS NULL OR r.supersededGeneration>?)${match ? " AND resource_fts MATCH ?" : ""}${source ? " AND json_extract(r.evidence,'$.source')=?" : ""}${after.sql} ORDER BY r.eventSeq,r.descriptor,r.stableKey LIMIT ?`, limit + 1, line, generation, request.view.eventCut, generation, ...(match ? [match] : []), ...(source ? [canonicalJson(request.source)] : []), ...after.values, limit + 1);
        items = rows.slice(0, limit).map(row => ({ level, stableKey: str(row, "stableKey"), resourceKind: str(row, "resourceKind"), resourceKey: str(row, "resourceKey"),
            relation: str(row, "relation"), validationFreshness: "unknown; observation is not full-resource validation", revision: row.revision, revisionBasis: str(row, "revisionBasis"), currentRevision: str(row, "currentRevision"), knownThrough: num(row, "knownThrough"),
            failed: row.failed === null ? null : num(row, "failed") === 1, executionOutcome: str(row, "executionOutcome"),
            verification: "not-established-by-execution", evidence: JSON.parse(str(row, "evidence")) }));
    }
    else {
        const match = request.query ? ftsQuery(request.query) : undefined;
        const stateRows = store.rows(`SELECT s.*,'state' AS metadataKind FROM state_items s${match ? " JOIN state_fts ON state_fts.lineage=s.lineage AND state_fts.stableKey=s.stableKey" : ""} WHERE s.lineage=? AND s.createdGeneration<=? AND s.eventSeq<=? AND (s.supersededGeneration IS NULL OR s.supersededGeneration>? OR json_extract(s.resolutionEvidence,'$.source.eventSeq')>?)${match ? " AND state_fts MATCH ?" : ""}${source ? " AND json_extract(s.evidence,'$.source')=?" : ""}${after.sql} ORDER BY s.eventSeq,s.descriptor,s.stableKey LIMIT ?`, limit + 1, line, generation, request.view.eventCut, generation, request.view.eventCut, ...(match ? [match] : []), ...(source ? [canonicalJson(request.source)] : []), ...after.values, limit + 1);
        const metadataAfterSql = (alias) => request.after ? ` AND (${alias}.eventSeq>? OR (${alias}.eventSeq=? AND (0>? OR (0=? AND ${alias}.stableKey>?))))` : "";
        const metadataAfterValues = request.after ? [request.after.eventSeq, request.after.eventSeq, request.after.descriptor, request.after.descriptor, request.after.stableKey ?? ""] : [];
        const memoryRows = source ? [] : store.rows(`SELECT m.*,0 AS descriptor,'memory' AS metadataKind FROM memory_items m${match ? " JOIN memory_fts ON memory_fts.lineage=m.lineage AND memory_fts.stableKey=m.stableKey" : ""} WHERE m.lineage=? AND m.createdGeneration<=? AND m.eventSeq<=? AND (m.supersededGeneration IS NULL OR m.supersededGeneration>? OR EXISTS(SELECT 1 FROM memory_items transition WHERE transition.lineage=m.lineage AND transition.createdGeneration=m.supersededGeneration AND transition.eventSeq>?)) AND m.state='current'${match ? " AND memory_fts MATCH ?" : ""}${metadataAfterSql("m")} ORDER BY m.eventSeq,m.stableKey LIMIT ?`, limit + 1, line, generation, request.view.eventCut, generation, request.view.eventCut, ...(match ? [match] : []), ...metadataAfterValues, limit + 1);
        const retentionRows = source ? [] : store.rows(`SELECT h.*,0 AS descriptor,'retention-hint' AS metadataKind FROM retention_hints h${match ? " JOIN retention_fts ON retention_fts.lineage=h.lineage AND retention_fts.stableKey=h.stableKey" : ""} WHERE h.lineage=? AND h.createdGeneration<=? AND h.eventSeq<=?${match ? " AND retention_fts MATCH ?" : ""}${metadataAfterSql("h")} ORDER BY h.eventSeq,h.stableKey LIMIT ?`, limit + 1, line, generation, request.view.eventCut, ...(match ? [match] : []), ...metadataAfterValues, limit + 1);
        rows = [...stateRows, ...memoryRows, ...retentionRows].sort((a, b) => num(a, "eventSeq") - num(b, "eventSeq") || num(a, "descriptor") - num(b, "descriptor") || str(a, "stableKey").localeCompare(str(b, "stableKey"))).slice(0, limit + 1);
        items = rows.slice(0, limit).map(row => {
            const metadataKind = str(row, "metadataKind");
            if (metadataKind === "memory")
                return { level, stableKey: str(row, "stableKey"), metadataKind, kind: "memory", subject: `memory:${str(row, "memoryId")}`,
                    revision: str(row, "eventHash"), authority: "ordinary-memory", confidence: "advisory", status: "current", memoryId: str(row, "memoryId"),
                    action: str(row, "action"), scope: str(row, "scope"), memoryConfidence: Number(row.confidence), text: str(row, "text"), sourceRef: str(row, "sourceRef"), evidence: JSON.parse(str(row, "evidence")) };
            if (metadataKind === "retention-hint")
                return { level, stableKey: str(row, "stableKey"), metadataKind, kind: "retentionhint", subject: "retention:compaction",
                    revision: "advisory", authority: "ordinary-memory", confidence: "advisory", status: "current", hint: JSON.parse(str(row, "data")), evidence: JSON.parse(str(row, "evidence")) };
            return { level, stableKey: str(row, "stableKey"), propositionKey: str(row, "propositionKey"), spanKey: str(row, "spanKey"), subject: str(row, "subject"),
                revision: str(row, "revision"), kind: str(row, "kind"), authority: str(row, "authority"), confidence: str(row, "confidence"), status: str(row, "status"), evidence: JSON.parse(str(row, "evidence")) };
        });
    }
    while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > EPISODE_STATE_LIMITS.recallUtf8Bytes)
        items.pop();
    const selected = rows.slice(0, items.length), last = selected.at(-1), eventColumn = "eventSeq", descriptorColumn = "descriptor", keyColumn = level === "episode" ? "sourceKey" : "stableKey";
    const head = store.get("SELECT * FROM heads WHERE lineage=?", line);
    // A cursor can stop inside an event, or pin an earlier materialization generation.
    // Only a completed head visible to that generation certifies its whole view.
    const visibleCut = store.get("SELECT eventSeq FROM cuts WHERE lineage=? AND generation<=? AND eventSeq<=? ORDER BY eventSeq DESC,descriptor DESC LIMIT 1", line, generation, request.view.eventCut);
    const completedView = head && num(head, "complete") === 1 && num(head, "metadataComplete") === 1 && generation >= num(head, "generation")
        ? JSON.parse(str(head, "view")) : undefined;
    const knownThrough = completedView ? Math.min(request.view.eventCut, completedView.eventCut)
        : Math.max(0, Math.min((visibleCut ? num(visibleCut, "eventSeq") : 0) - 1, head ? num(head, "metadataAfterEventSeq") : 0));
    return { stateGeneration: generation, branchKey: request.view.branchKey, knownThrough, partial: !head || !completedView || knownThrough < request.view.eventCut || num(head, "partialCount") > 0,
        level, items, ...(rows.length > items.length && last ? { next: { eventSeq: num(last, eventColumn), descriptor: num(last, descriptorColumn), stableKey: str(last, keyColumn), generation } } : {}),
        metrics: { sqliteStatements: store.statements } };
}
function selectionItem(row, effectiveAtCut) {
    return { stableKey: str(row, "stableKey"), propositionKey: str(row, "propositionKey"), spanKey: str(row, "spanKey"),
        subject: str(row, "subject"), revision: str(row, "revision"), kind: str(row, "kind"),
        authority: str(row, "authority"), confidence: str(row, "confidence"),
        status: str(row, "status"), effectiveAtCut, evidence: JSON.parse(str(row, "evidence")) };
}
/** M09 selection reads one common body and metadata prefix without materialization or source-body access. */
function composeStateSelection(request, store) {
    const line = lineage(request), requestedCut = request.view.eventCut;
    const head = store.get("SELECT * FROM heads WHERE lineage=?", line) ?? fail("search-v3-state-not-ready");
    let indexed;
    try {
        indexed = JSON.parse(str(head, "view"));
    }
    catch {
        return fail("search-v3-state-checkpoint-corrupt");
    }
    if (!extendsView(indexed, request.view) && !extendsView(request.view, indexed))
        fail("search-v3-state-view-incompatible");
    const bodyCut = num(head, "complete") === 1 ? Math.min(requestedCut, indexed.eventCut)
        : Math.max(0, Math.min(requestedCut, num(head, "afterEventSeq") - 1));
    const processedMemoryCut = Math.max(0, Math.min(requestedCut, indexed.eventCut, num(head, "metadataAfterEventSeq")));
    const processedCut = Math.min(bodyCut, processedMemoryCut);
    const generationRow = store.get("SELECT MAX(generation) AS generation FROM cuts WHERE lineage=? AND eventSeq<=?", line, processedCut);
    const stateGeneration = generationRow?.generation === null || generationRow?.generation === undefined ? 0 : num(generationRow, "generation");
    if (stateGeneration > num(head, "generation"))
        fail("search-v3-state-checkpoint-corrupt");
    const active = "createdGeneration<=? AND eventSeq<=? AND (supersededGeneration IS NULL OR supersededGeneration>? OR json_extract(resolutionEvidence,'$.source.eventSeq')>?)";
    // Partition before LIMIT. The combined retained mandatory cap remains 24.
    const categoryRows = (condition, limit) => store.rows(`SELECT * FROM state_items WHERE lineage=? AND ${active} AND ${condition} ORDER BY eventSeq DESC,descriptor DESC,stableKey DESC LIMIT ?`, limit + 1, line, stateGeneration, processedCut, stateGeneration, processedCut, limit + 1);
    const restrictionRows = categoryRows("kind='restriction'", EPISODE_STATE_LIMITS.composeRestrictions);
    // User goals and pending approvals outrank incidental execution failures.
    const workRows = store.rows(`SELECT * FROM state_items WHERE lineage=? AND ${active}
    AND kind IN ('goal','openwork','blocker') ORDER BY CASE WHEN authority='user' THEN 0 WHEN authority='assistant-report' THEN 1 ELSE 2 END,
    eventSeq DESC,descriptor DESC,stableKey DESC LIMIT ?`, EPISODE_STATE_LIMITS.composeOpenWork + 1, line, stateGeneration, processedCut, stateGeneration, processedCut, EPISODE_STATE_LIMITS.composeOpenWork + 1);
    const currentRows = store.rows(`SELECT * FROM state_items WHERE lineage=? AND ${active} AND kind IN ('decision','approval') ORDER BY eventSeq DESC,descriptor DESC,stableKey DESC LIMIT ?`, EPISODE_STATE_LIMITS.composeState + 1, line, stateGeneration, processedCut, stateGeneration, processedCut, EPISODE_STATE_LIMITS.composeState + 1);
    // Select successive experience across boundaries, not only the latest episode.
    const latestEpisode = store.get("SELECT startEventSeq FROM episodes WHERE lineage=? AND createdGeneration<=? AND startEventSeq<=? ORDER BY startEventSeq DESC,createdGeneration DESC LIMIT 1", line, stateGeneration, processedCut);
    const recentEnd = store.rows("SELECT * FROM episode_membership WHERE lineage=? AND createdGeneration<=? AND eventSeq<=? ORDER BY eventSeq DESC,descriptor DESC,sourceKey DESC LIMIT ?", EPISODE_STATE_LIMITS.composeRecentMembers + 1, line, stateGeneration, processedCut, EPISODE_STATE_LIMITS.composeRecentMembers + 1);
    const recentStartRows = latestEpisode ? store.rows("SELECT * FROM episode_membership WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? ORDER BY eventSeq,descriptor,sourceKey LIMIT 6", 6, line, stateGeneration, num(latestEpisode, "startEventSeq"), processedCut) : [];
    const recentBySource = new Map([...recentStartRows, ...recentEnd.slice(0, 6)].map(row => [str(row, "sourceKey"), row]));
    const recentRows = [...recentBySource.values()].sort((a, b) => num(b, "eventSeq") - num(a, "eventSeq") || num(b, "descriptor") - num(a, "descriptor"));
    const member = (row) => {
        const episode = store.get("SELECT * FROM episodes WHERE lineage=? AND episodeKey=? AND createdGeneration<=? AND endEventSeq<=? ORDER BY createdGeneration DESC LIMIT 1", line, str(row, "episodeKey"), stateGeneration, processedCut) ?? fail("search-v3-state-checkpoint-corrupt");
        return { episodeKey: str(row, "episodeKey"), eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"),
            source: JSON.parse(str(row, "source")), cue: visibleMemberCue(store, row, stateGeneration, processedCut), episode: {
                start: { eventSeq: num(episode, "startEventSeq"), descriptor: num(episode, "startDescriptor") },
                end: { eventSeq: num(episode, "endEventSeq"), descriptor: num(episode, "endDescriptor") }, open: num(episode, "open") === 1,
                objective: str(episode, "objective"), objectiveEvidence: JSON.parse(str(episode, "objectiveEvidence"))
            } };
    };
    const protectedItems = [...restrictionRows.slice(0, EPISODE_STATE_LIMITS.composeRestrictions),
        ...workRows.slice(0, EPISODE_STATE_LIMITS.composeOpenWork)].map(row => selectionItem(row, processedCut));
    protectedItems.sort((a, b) => a.evidence.source.eventSeq - b.evidence.source.eventSeq);
    const currentItems = currentRows.slice(0, EPISODE_STATE_LIMITS.composeState).reverse().map(row => selectionItem(row, processedCut));
    const recentItems = recentRows.slice(0, EPISODE_STATE_LIMITS.composeRecentMembers).reverse().map(member);
    // Older experience is selected through existing obligation-to-episode membership,
    // not a new score. It stays historical and remains exactly recoverable.
    const olderItems = [];
    const seenSources = new Set(recentItems.map(item => item.sourceKey));
    const recentStart = recentItems[0]?.eventSeq ?? processedCut + 1;
    for (const item of protectedItems.slice(0, 3)) {
        const evidence = item.evidence;
        if (!evidence.source || evidence.source.eventSeq >= recentStart)
            continue;
        const enclosing = store.get("SELECT episodeKey FROM episode_membership WHERE lineage=? AND sourceKey=? AND createdGeneration<=? LIMIT 1", line, sourceKey(evidence.source), stateGeneration);
        if (!enclosing)
            continue;
        const rows = store.rows("SELECT * FROM episode_membership WHERE lineage=? AND episodeKey=? AND createdGeneration<=? AND eventSeq<? ORDER BY eventSeq DESC,descriptor DESC,sourceKey DESC LIMIT 4", 4, line, str(enclosing, "episodeKey"), stateGeneration, recentStart);
        for (const row of rows.reverse())
            if (!seenSources.has(str(row, "sourceKey"))) {
                seenSources.add(str(row, "sourceKey"));
                olderItems.push(member(row));
            }
    }
    olderItems.sort((a, b) => a.eventSeq - b.eventSeq || a.descriptor - b.descriptor || a.sourceKey.localeCompare(b.sourceKey));
    let protectedAtLeastOne = restrictionRows.length > EPISODE_STATE_LIMITS.composeRestrictions;
    let openWorkAtLeastOne = workRows.length > EPISODE_STATE_LIMITS.composeOpenWork;
    let currentAtLeastOne = currentRows.length > EPISODE_STATE_LIMITS.composeState;
    let recentAtLeastOne = recentEnd.length > recentRows.length;
    let responseBudgetAtLeastOne = false;
    const bodyComplete = bodyCut >= requestedCut, metadataComplete = processedMemoryCut >= requestedCut;
    const partialMemory = !metadataComplete;
    const gap = (column) => Boolean(store.get(`SELECT eventSeq FROM coverage WHERE lineage=? AND ${column}=1 AND eventSeq<=? AND generation<=? LIMIT 1`, line, processedCut, stateGeneration));
    const restrictionsComplete = bodyComplete && metadataComplete && !gap("restrictionGap");
    const openWorkComplete = bodyComplete && metadataComplete && !gap("openWorkGap");
    const qualifiedReducers = gap("optionalGap");
    const build = () => {
        const partial = !bodyComplete || !metadataComplete || qualifiedReducers || protectedAtLeastOne || openWorkAtLeastOne || currentAtLeastOne || recentAtLeastOne || responseBudgetAtLeastOne;
        return { stateGeneration, branchKey: request.view.branchKey, sourceView: request.view, requestedCut, processedCut, processedMemoryCut, complete: !partial, partial,
            coverage: { bodyComplete, metadataComplete, partialMemory, qualifiedReducers, restrictionsComplete, openWorkComplete }, protected: protectedItems, current: currentItems, recent: recentItems, older: olderItems,
            omissions: { protectedAtLeastOne, openWorkAtLeastOne, currentAtLeastOne, recentAtLeastOne, responseBudgetAtLeastOne }, metrics: { sqliteStatements: store.statements } };
    };
    while (Buffer.byteLength(JSON.stringify(build())) > EPISODE_STATE_LIMITS.composeUtf8Bytes) {
        responseBudgetAtLeastOne = true;
        if (olderItems.length) {
            olderItems.shift();
            continue;
        }
        if (currentItems.length) {
            currentItems.shift();
            currentAtLeastOne = true;
            continue;
        }
        if (recentItems.length) {
            recentItems.splice(Math.floor(recentItems.length / 2), 1);
            recentAtLeastOne = true;
            continue;
        }
        const workIndex = protectedItems.findIndex(item => item.kind !== "restriction");
        if (workIndex >= 0) {
            protectedItems.splice(workIndex, 1);
            openWorkAtLeastOne = true;
            continue;
        }
        if (protectedItems.length) {
            protectedItems.pop();
            protectedAtLeastOne = true;
            continue;
        }
        fail("search-v3-state-response-limit");
    }
    return build();
}
/** Resolve bounded surrounding context without changing stored evidence or its authority. */
async function selectionContext(request, selection, options, budget) {
    const cache = new Map();
    const enrich = async (item) => {
        const evidence = item.evidence;
        const source = evidence?.source;
        if (!source || source.coordinateKind !== "decoded-body" || !evidence.decodedUtf16 || typeof evidence.exactText !== "string")
            return item;
        if (evidence.decodedUtf16.start === source.decodedUtf16.start && evidence.decodedUtf16.end === source.decodedUtf16.end)
            return item;
        // A whole bounded source retains preceding conditions and following exceptions.
        // Larger sources stay explicitly unsupported rather than certifying a guessed clause boundary.
        if (source.decodedUtf16.end - source.decodedUtf16.start > 8192)
            return item;
        const key = sourceKey(source);
        if (!cache.has(key))
            cache.set(key, await body(request, { source }, options.capsuleExecutor ?? executeCapsuleRequest, budget));
        const text = cache.get(key);
        if (text === undefined || Buffer.byteLength(text) > 16 * 1024)
            return item;
        if (text.slice(evidence.decodedUtf16.start - source.decodedUtf16.start, evidence.decodedUtf16.end - source.decodedUtf16.start) !== evidence.exactText)
            fail("search-v3-state-source-invalid");
        const clauseStart = evidence.decodedUtf16.start - source.decodedUtf16.start;
        const clauseEnd = evidence.decodedUtf16.end - source.decodedUtf16.start;
        // Blank-line paragraphs retain wrapped conditions and exceptions as one unit.
        // Never split a paragraph merely to fit the response budget.
        const before = [...text.slice(0, clauseStart).matchAll(/\n[ \t]*\n/gu)].at(-1);
        const after = /\n[ \t]*\n/u.exec(text.slice(clauseEnd));
        const start = before ? before.index + before[0].length : 0;
        const end = after ? clauseEnd + after.index : text.length;
        const context = text.slice(start, end);
        return { ...item, evidence: { ...evidence, exactText: context,
                decodedUtf16: { start: source.decodedUtf16.start + start, end: source.decodedUtf16.start + end },
                retainedClause: { exactText: evidence.exactText, decodedUtf16: evidence.decodedUtf16 },
                omissions: [{ beforeUtf16: start, afterUtf16: text.length - end }], contextComplete: true } };
    };
    const result = { ...selection, protected: [...selection.protected], current: [...selection.current],
        recent: [...selection.recent], older: [...(selection.older ?? [])], omissions: { ...selection.omissions },
        delta: selection.delta ? { ...selection.delta, protected: [...selection.delta.protected], current: [...selection.delta.current] } : undefined };
    result.protected.sort((a, b) => Number(b.kind === "restriction") - Number(a.kind === "restriction"));
    const groups = [result.protected, result.current, ...(result.delta ? [result.delta.protected, result.delta.current] : [])];
    for (const group of groups)
        for (let index = 0; index < group.length; index++) {
            const original = group[index];
            group[index] = await enrich(original);
            // Allocate using actual context bytes, not an up-front percentage that
            // discards chronology even when the final response has room for it.
            // Mandatory context takes precedence over optional detail. Never remove a
            // different obligation to make this expansion fit.
            if (group === result.protected) {
                while (Buffer.byteLength(JSON.stringify(result)) > EPISODE_STATE_LIMITS.composeUtf8Bytes) {
                    result.omissions.responseBudgetAtLeastOne = true;
                    if (result.older.length) {
                        result.older.pop();
                        continue;
                    }
                    if (result.current.length) {
                        result.current.pop();
                        result.omissions.currentAtLeastOne = true;
                        continue;
                    }
                    if (result.recent.length) {
                        result.recent.splice(Math.floor(result.recent.length / 2), 1);
                        result.omissions.recentAtLeastOne = true;
                        continue;
                    }
                    break;
                }
            }
            if (Buffer.byteLength(JSON.stringify(result)) > EPISODE_STATE_LIMITS.composeUtf8Bytes)
                group[index] = original;
        }
    const loss = Object.values(result.omissions).some(Boolean);
    return { ...result, partial: result.partial || loss, complete: result.complete && !loss };
}
/** Read a small committed capsule delta, never derive missing capsules or replay lifetime state. */
async function selectionDelta(request, selection, options, budget) {
    const start = selection.processedCut, end = selection.requestedCut;
    const empty = (reason) => ({ ...selection, delta: { verified: start === end, throughCut: start,
            reason, protected: [], current: [], recent: [] } });
    if (start === end)
        return empty("already-processed");
    const catalog = options.catalogExecutor ?? executeCatalogStoreRequest, capsules = options.capsuleExecutor ?? executeCapsuleRequest;
    if (end - start > 64) {
        // Independent recent experience can be useful despite an unbridgeable state lag.
        // It does not certify or reconstruct the gap between memory and this suffix.
        try {
            const page = await capsuleCall(request, capsules, budget, { op: "capsulePage", view: request.view,
                afterEventSeq: Math.max(start, end - EPISODE_STATE_LIMITS.composeRecentMembers), afterDescriptor: Number.MAX_SAFE_INTEGER, limit: 8 });
            const recent = [];
            for (const envelope of (page.capsules ?? [])) {
                if (envelope.source.eventSeq <= start || envelope.source.eventSeq > end)
                    fail("search-v3-state-source-invalid");
                const reduced = reduceEpisodeStateEnvelope(envelope, undefined);
                if (reduced.capsuleCue)
                    recent.push({ episodeKey: `recent-capsule:${envelope.source.eventSeq}`, eventSeq: envelope.source.eventSeq,
                        descriptor: envelope.source.descriptor, sourceKey: sourceKey(envelope.source), source: envelope.source, cue: reduced.capsuleCue,
                        episode: { start: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor },
                            end: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor }, open: true, objective: "", objectiveEvidence: null } });
            }
            const result = { ...selection, delta: { verified: false, throughCut: start, reason: "lag-exceeds-bounded-delta; recent-window-only",
                    protected: [], current: [], recent } };
            return Buffer.byteLength(JSON.stringify(result)) <= EPISODE_STATE_LIMITS.composeUtf8Bytes ? result : empty("recent-response-budget-exceeded");
        }
        catch (error) {
            if (error.code === "search-v3-state-capsule-unavailable")
                return empty("lag-exceeds-bounded-delta; recent-capsules-unavailable");
            throw error;
        }
    }
    const events = await catalogCall(request, catalog, budget, { op: "page", view: request.view, after: start, limit: 64 });
    const metadata = (events.events ?? []);
    // Metadata writers require their maintained reducer/checkpoint, not an ad-hoc overlay.
    if (metadata.some(event => ["chrono-memory-v2-event", "chrono-compact-retention-hint"].includes(String(event.metadata?.customType))))
        return empty("delta-requires-metadata-materialization");
    const protectedItems = [], current = [], recent = [];
    let afterEventSeq = start, afterDescriptor = Number.MAX_SAFE_INTEGER, complete = false, qualified = false;
    for (let pageIndex = 0; pageIndex < 8 && !complete; pageIndex++) {
        const page = await capsuleCall(request, capsules, budget, { op: "capsulePage", view: request.view, afterEventSeq, afterDescriptor, limit: 8 });
        for (const envelope of (page.capsules ?? [])) {
            if (envelope.source.eventSeq <= start || envelope.source.eventSeq > end)
                fail("search-v3-state-source-invalid");
            const reduced = reduceEpisodeStateEnvelope(envelope, await body(request, envelope, capsules, budget), await exactStructural(request, envelope, catalog, budget));
            qualified ||= reduced.partial || reduced.states.some(item => !!item.transition);
            for (const item of reduced.states) {
                const selected = { ...item, effectiveAtCut: end };
                if (["restriction", "openwork", "blocker"].includes(item.kind))
                    protectedItems.push(selected);
                else if (["goal", "decision"].includes(item.kind))
                    current.push(selected);
            }
            if (reduced.capsuleCue)
                recent.push({ episodeKey: `delta:${envelope.source.eventSeq}`, eventSeq: envelope.source.eventSeq,
                    descriptor: envelope.source.descriptor, sourceKey: sourceKey(envelope.source), source: envelope.source, cue: reduced.capsuleCue,
                    episode: { start: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor },
                        end: { eventSeq: envelope.source.eventSeq, descriptor: envelope.source.descriptor }, open: true,
                        objective: reduced.objective?.exactText ?? "", objectiveEvidence: reduced.objective ?? null } });
        }
        complete = page.complete === true;
        if (!complete && (!page.next || (page.next.afterEventSeq === afterEventSeq && page.next.afterDescriptor === afterDescriptor)))
            fail("search-v3-state-cursor-invalid");
        afterEventSeq = Number(page.next?.afterEventSeq ?? afterEventSeq);
        afterDescriptor = Number(page.next?.afterDescriptor ?? afterDescriptor);
    }
    if (protectedItems.length + current.length + recent.length > 64)
        return empty("delta-row-budget-exceeded");
    const delta = { verified: complete && !qualified && metadata.at(-1)?.seq === end, throughCut: complete ? end : start,
        reason: !complete ? "delta-capsules-incomplete" : qualified ? "delta-extraction-qualified" : "bounded-committed-delta",
        protected: protectedItems, current, recent };
    const result = { ...selection, delta };
    if (Buffer.byteLength(JSON.stringify(result)) > EPISODE_STATE_LIMITS.composeUtf8Bytes)
        return empty("delta-response-budget-exceeded");
    return result;
}
function status(request, store) {
    const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation"), head = store.get("SELECT * FROM heads WHERE lineage=?", lineage(request));
    if (!head)
        return { identity: request.identity, ruleset: EPISODE_STATE_RULESET_VERSION, stateGeneration: generation, knownThroughCut: 0, knownThrough: 0, partial: true,
            readiness: "missing", metadata: { afterEventSeq: 0, complete: false }, requestedView: { branchKey: request.view.branchKey, eventCut: request.view.eventCut, hash: viewHash(request) }, metrics: { sqliteStatements: store.statements } };
    let indexed;
    try {
        indexed = JSON.parse(str(head, "view"));
    }
    catch {
        return fail("search-v3-state-checkpoint-corrupt");
    }
    const compatible = extendsView(request.view, indexed) || extendsView(indexed, request.view), knownThrough = compatible ? Math.min(request.view.eventCut, num(head, "afterEventSeq")) : 0;
    const complete = compatible && num(head, "complete") === 1 && num(head, "metadataComplete") === 1 && indexed.eventCut >= request.view.eventCut;
    const knownThroughCut = complete ? request.view.eventCut : Math.max(0, Math.min(knownThrough - 1, num(head, "metadataAfterEventSeq")));
    const partial = !complete || knownThroughCut < request.view.eventCut || num(head, "partialCount") > 0;
    return { identity: request.identity, ruleset: EPISODE_STATE_RULESET_VERSION, stateGeneration: generation, knownThroughCut, knownThrough: knownThroughCut, complete, partial,
        readiness: compatible ? partial ? "partial" : "ready" : "incompatible", requestedView: { branchKey: request.view.branchKey, eventCut: request.view.eventCut, hash: viewHash(request) },
        indexedView: { branchKey: indexed.branchKey, eventCut: indexed.eventCut, complete },
        cursor: { eventSeq: num(head, "afterEventSeq"), descriptor: num(head, "afterDescriptor"), generation: num(head, "generation") },
        metadata: { afterEventSeq: num(head, "metadataAfterEventSeq"), complete: num(head, "metadataComplete") === 1 }, metrics: { sqliteStatements: store.statements } };
}
/** Bounded read-only export for M08. It never creates or mutates state-v3.sqlite. */
export async function readEpisodeRollupInputPage(request, cursor, options = {}, budget = { bytes: 0 }) {
    let db;
    try {
        prepareDirectory(request.searchDirectory);
        const path = join(request.searchDirectory, "state-v3.sqlite");
        db = CatalogSqlite.open(path, candidate => new Store(candidate, request).validate(false));
        const store = new Store(db, request), line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
        const headRow = head ?? fail("search-v3-rollup-state-not-ready");
        const indexed = JSON.parse(str(headRow, "view"));
        if (!extendsView(indexed, request.view) && !extendsView(request.view, indexed))
            fail("search-v3-rollup-state-not-ready");
        const priorSnapshot = cursor?.snapshot;
        if (priorSnapshot && (!extendsView(request.view, priorSnapshot.sourceView) || priorSnapshot.requestedCut !== priorSnapshot.sourceView.eventCut
            || priorSnapshot.processedCut > priorSnapshot.requestedCut || priorSnapshot.processedMemoryCut > priorSnapshot.requestedCut
            || priorSnapshot.stateGeneration > num(headRow, "generation")))
            fail("search-v3-rollup-state-snapshot-invalid");
        const requestedCut = priorSnapshot?.requestedCut ?? request.view.eventCut;
        const bodyCut = num(headRow, "complete") === 1 ? Math.min(requestedCut, indexed.eventCut)
            : Math.max(0, Math.min(requestedCut, num(headRow, "afterEventSeq") - 1));
        const processedMemoryCut = priorSnapshot?.processedMemoryCut
            ?? Math.max(0, Math.min(requestedCut, num(headRow, "metadataAfterEventSeq")));
        const processedCut = priorSnapshot?.processedCut ?? Math.min(bodyCut, processedMemoryCut);
        const stateGeneration = priorSnapshot?.stateGeneration ?? num(headRow, "generation");
        const sourceView = priorSnapshot?.sourceView ?? request.view;
        const snapshot = { stateGeneration, requestedCut, processedCut, processedMemoryCut, sourceView };
        const sourceRequest = { ...request, view: sourceView };
        const same = Boolean(cursor && !cursor.episodeComplete);
        const episode = same
            ? store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.episodeKey=? AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?) AND e.open=0 AND e.endEventSeq<=?", line, cursor.episodeKey, stateGeneration, processedCut)
            : store.get("SELECT e.* FROM episodes e WHERE e.lineage=? AND e.createdGeneration=(SELECT MAX(v.createdGeneration) FROM episodes v WHERE v.lineage=e.lineage AND v.episodeKey=e.episodeKey AND v.createdGeneration<=?) AND e.open=0 AND e.endEventSeq<=? AND (e.startEventSeq>? OR (e.startEventSeq=? AND (e.startDescriptor>? OR (e.startDescriptor=? AND e.episodeKey>?)))) ORDER BY e.startEventSeq,e.startDescriptor,e.episodeKey LIMIT 1", line, stateGeneration, processedCut, cursor?.episodeStartEventSeq ?? 0, cursor?.episodeStartEventSeq ?? 0, cursor?.episodeStartDescriptor ?? 0, cursor?.episodeStartDescriptor ?? 0, cursor?.episodeKey ?? "");
        if (!episode)
            return { stateGeneration, requestedCut, processedCut, processedMemoryCut, knownThroughCut: processedCut, complete: true,
                next: cursor ? { ...cursor, snapshot } : { episodeStartEventSeq: 0, episodeStartDescriptor: 0, episodeKey: "", memberEventSeq: 0,
                    memberDescriptor: 0, memberSourceKey: "", episodeComplete: true, fragmentIndex: 0, snapshot } };
        const episodeKey = str(episode, "episodeKey"), afterEvent = same ? cursor.memberEventSeq : 0, afterDescriptor = same ? cursor.memberDescriptor : 0, afterSource = same ? cursor.memberSourceKey : "";
        const rows = store.rows("SELECT * FROM episode_membership WHERE lineage=? AND episodeKey=? AND createdGeneration<=? AND eventSeq<=? AND (eventSeq>? OR (eventSeq=? AND (descriptor>? OR (descriptor=? AND sourceKey>?)))) ORDER BY eventSeq,descriptor,sourceKey LIMIT ?", EPISODE_STATE_LIMITS.rollupLeafMembers + 1, line, episodeKey, stateGeneration, processedCut, afterEvent, afterEvent, afterDescriptor, afterDescriptor, afterSource, EPISODE_STATE_LIMITS.rollupLeafMembers + 1);
        const selected = rows.slice(0, EPISODE_STATE_LIMITS.rollupLeafMembers), members = [];
        for (const row of selected) {
            const source = JSON.parse(str(row, "source"));
            if (source.coordinateKind === "decoded-body") {
                const exact = await body(sourceRequest, { source }, options.capsuleExecutor ?? executeCapsuleRequest, budget);
                members.push({ eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"), source,
                    cue: visibleMemberCue(store, row, stateGeneration, processedCut), ...(exact === undefined ? { exactBodyOmitted: "bounded-source" } : { exactBody: exact }) });
            }
            else
                members.push({ eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"), source,
                    cue: visibleMemberCue(store, row, stateGeneration, processedCut) });
        }
        if (!members.length)
            fail("search-v3-rollup-input-invalid");
        const protectedRows = store.rows("SELECT stableKey,kind,status,authority,confidence,evidence FROM state_items WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? AND kind IN ('restriction','blocker','openwork') AND (supersededGeneration IS NULL OR supersededGeneration>? OR json_extract(resolutionEvidence,'$.source.eventSeq')>?) ORDER BY eventSeq,descriptor,stableKey LIMIT ?", EPISODE_STATE_LIMITS.rollupProtectedPerNode + 1, line, stateGeneration, num(episode, "startEventSeq"), num(episode, "endEventSeq"), stateGeneration, processedCut, EPISODE_STATE_LIMITS.rollupProtectedPerNode + 1);
        const memoryRows = store.rows("SELECT stableKey,'memory' AS kind,text AS data,evidence FROM memory_items WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? ORDER BY eventSeq,stableKey LIMIT ?", EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1, line, stateGeneration, num(episode, "startEventSeq"), num(episode, "endEventSeq"), EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1);
        const retentionRows = store.rows("SELECT stableKey,'retention-hint' AS kind,data,evidence FROM retention_hints WHERE lineage=? AND createdGeneration<=? AND eventSeq>=? AND eventSeq<=? ORDER BY eventSeq,stableKey LIMIT ?", EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1, line, stateGeneration, num(episode, "startEventSeq"), num(episode, "endEventSeq"), EPISODE_STATE_LIMITS.rollupMetadataPerNode + 1);
        const metadataRows = [...memoryRows, ...retentionRows].sort((a, b) => str(a, "stableKey").localeCompare(str(b, "stableKey")));
        const last = selected.at(-1), episodeComplete = rows.length <= EPISODE_STATE_LIMITS.rollupLeafMembers;
        const next = last ? { episodeStartEventSeq: num(episode, "startEventSeq"), episodeStartDescriptor: num(episode, "startDescriptor"), episodeKey,
            memberEventSeq: num(last, "eventSeq"), memberDescriptor: num(last, "descriptor"), memberSourceKey: str(last, "sourceKey"), episodeComplete,
            fragmentIndex: same ? cursor.fragmentIndex + 1 : 0, snapshot } : undefined;
        return { stateGeneration, requestedCut, processedCut, processedMemoryCut, knownThroughCut: processedCut, complete: false, ...(next ? { next } : {}), episode: { episodeKey,
                start: { eventSeq: num(episode, "startEventSeq"), descriptor: num(episode, "startDescriptor") },
                end: { eventSeq: num(episode, "endEventSeq"), descriptor: num(episode, "endDescriptor") }, closure: "next-episode-boundary",
                memberCount: num(episode, "memberCount"), objective: str(episode, "objective"), objectiveEvidence: JSON.parse(str(episode, "objectiveEvidence")),
                fragmentIndex: same ? cursor.fragmentIndex + 1 : 0,
                episodeFragment: !episodeComplete || same, members,
                protected: protectedRows.slice(0, EPISODE_STATE_LIMITS.rollupProtectedPerNode).map(row => ({ stableKey: str(row, "stableKey"), kind: str(row, "kind"), status: str(row, "status"), authority: str(row, "authority"), confidence: str(row, "confidence"), evidence: JSON.parse(str(row, "evidence")) })),
                omittedProtectedCount: Math.max(0, protectedRows.length - EPISODE_STATE_LIMITS.rollupProtectedPerNode),
                metadata: metadataRows.slice(0, EPISODE_STATE_LIMITS.rollupMetadataPerNode).map(row => {
                    const kind = str(row, "kind");
                    // Immutable leaves can outlive later demotion/forget events, so their hints are always historical records.
                    return { stableKey: str(row, "stableKey"), kind, effectiveAuthority: "ordinary-memory", effectiveConfidence: "advisory",
                        temporalStatus: "historical", data: kind === "retention-hint" ? JSON.parse(str(row, "data")) : str(row, "data"),
                        evidence: JSON.parse(str(row, "evidence")) };
                }),
                omittedMetadataCount: Math.max(0, metadataRows.length - EPISODE_STATE_LIMITS.rollupMetadataPerNode) } };
    }
    finally {
        try {
            db?.close();
        }
        catch { /* read-only close */ }
    }
}
/** Direct executor for tests and the existing contained search-v3 worker. */
export async function executeEpisodeStateRequest(value, options = {}) {
    if (!isEpisodeStateRequest(value))
        return { v: 1, ok: false, code: "search-v3-state-request-invalid", sourceBytes: 0,
            sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes, resumable: false };
    const request = value;
    if (request.op === "materializeRollup" || request.op === "rollupStatus" || request.op === "recallRollup") {
        const { executeEpisodeRollupRequest } = await import("./episode-rollup-store.js");
        return executeEpisodeRollupRequest(request, options);
    }
    const create = request.op === "materializeState";
    let db;
    const budget = { bytes: 0 };
    try {
        prepareDirectory(request.searchDirectory);
        // Authorize this exact view and current physical source even for read-only memory.
        await catalogCall(request, options.catalogExecutor ?? executeCatalogStoreRequest, budget, { op: "page", view: request.view, after: request.view.eventCut, limit: 1 });
        const action = async () => {
            const path = join(request.searchDirectory, "state-v3.sqlite"), validate = (candidate) => new Store(candidate, request).validate(create);
            if (request.op === "stateStatus" || request.op === "composeStateSelection") {
                try {
                    lstatSync(path);
                }
                catch (error) {
                    if (error.code === "ENOENT")
                        fail("search-v3-state-store-missing");
                    throw error;
                }
            }
            db = create ? CatalogSqlite.create(path, validate) : CatalogSqlite.open(path, validate);
            const store = new Store(db, request);
            if (create)
                store.initialize();
            else
                store.validate(false);
            const result = request.op === "materializeState" ? await materialize(request, store, options.capsuleExecutor ?? executeCapsuleRequest, options.catalogExecutor ?? executeCatalogStoreRequest, budget)
                : request.op === "recallState" ? recall(request, store)
                    : request.op === "composeStateSelection" ? await selectionContext(request, await selectionDelta(request, composeStateSelection(request, store), options, budget), options, budget) : status(request, store);
            const response = { v: 1, ok: true, result: { ...result,
                    coverageScope: "Body capsules plus structurally validated ordinary writer metadata. Custom type and hash-chain checks are not producer authentication; no metadata gains instruction authority.",
                }, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes };
            if (Buffer.byteLength(JSON.stringify(response)) > EPISODE_STATE_LIMITS.responseBytes)
                fail("search-v3-state-response-limit");
            if (create)
                try {
                    db.checkpoint();
                }
                catch { /* committed WAL remains authoritative */ }
            return response;
        };
        return create ? await withRuntimeMutex(join(request.searchDirectory, "state-publication.lock"), action) : await action();
    }
    catch (error) {
        const candidate = error.code;
        const mapped = { "catalog-storage-unsafe": "search-v3-state-storage-unsafe", "catalog-sqlite-busy": "search-v3-state-store-busy",
            "catalog-sqlite-corrupt": "search-v3-state-store-corrupt", "catalog-sqlite-capability": "search-v3-state-store-capability", "catalog-sqlite-limit": "search-v3-state-store-limit",
            "catalog-sqlite-failed": "search-v3-state-store-failed", "catalog-sqlite-unavailable": "search-v3-state-store-capability" };
        const code = candidate?.startsWith("search-v3-state-") ? candidate : candidate && mapped[candidate] ? mapped[candidate] : candidate === "ENOSPC" ? "search-v3-state-storage-full" : "search-v3-state-storage-io";
        return { v: 1, ok: false, code, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes,
            resumable: !["search-v3-state-request-invalid", "search-v3-state-store-mismatch", "search-v3-state-version-mismatch", "search-v3-state-storage-unsafe"].includes(code) };
    }
    finally {
        try {
            db?.close();
        }
        catch { /* preserve bounded response */ }
    }
}
//# sourceMappingURL=episode-state-store.js.map