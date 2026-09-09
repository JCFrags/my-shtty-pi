import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { SEARCH_V3_LIMITS, SEARCH_V3_SCHEMA_VERSION, isSearchV3Request, } from "./search-v3-contract.js";
import { CAPSULE_LIMITS } from "./capsule-contract.js";
import { executeCapsuleRequest } from "./capsule-store.js";
import { CatalogSqlite } from "./catalog-sqlite.js";
import { canonicalJson } from "./capsule-segment.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const num = (row, key) => Number(row[key]);
const str = (row, key) => String(row[key]);
const LINEAGE = (view) => sha256(canonicalJson({ branchKey: view.branchKey, segments: view.segments.map(item => item.segment) }));
const VIEW = (view) => sha256(canonicalJson(view));
const INGEST_ENUMERATION_PAGES = 4;
const INGEST_ENUMERATION_DESCRIPTORS = 64;
const schema = [
    "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, searchRoute TEXT NOT NULL, capsuleRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, generation INTEGER NOT NULL)",
    "CREATE TABLE documents (sourceKey TEXT PRIMARY KEY, source TEXT NOT NULL, segment INTEGER NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, blockIndex INTEGER, shardKey TEXT NOT NULL, kind TEXT NOT NULL, provenance TEXT NOT NULL, toolName TEXT, error INTEGER, cue TEXT NOT NULL, identifiers TEXT NOT NULL, paths TEXT NOT NULL, indexGeneration INTEGER NOT NULL)",
    "CREATE INDEX documents_generation ON documents(indexGeneration,eventSeq,descriptor)",
    "CREATE TABLE membership (lineage TEXT NOT NULL, sourceKey TEXT NOT NULL, eventSeq INTEGER NOT NULL, descriptor INTEGER NOT NULL, PRIMARY KEY(lineage,eventSeq,descriptor,sourceKey)) WITHOUT ROWID",
    "CREATE INDEX membership_source ON membership(lineage,sourceKey)",
    "CREATE TABLE chunks (sourceKey TEXT NOT NULL, chunkIndex INTEGER NOT NULL, decodedStart INTEGER NOT NULL, decodedEnd INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(sourceKey,chunkIndex)) WITHOUT ROWID",
    "CREATE VIRTUAL TABLE cue_fts USING fts5(sourceKey UNINDEXED,cue,identifiers,paths,tokenize='unicode61')",
    "CREATE VIRTUAL TABLE raw_fts USING fts5(sourceKey UNINDEXED,chunkIndex UNINDEXED,text,tokenize='unicode61')",
    "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, afterEventSeq INTEGER NOT NULL, afterDescriptor INTEGER NOT NULL, active TEXT, generation INTEGER NOT NULL, cueReady INTEGER NOT NULL, rawReady INTEGER NOT NULL, excluded INTEGER NOT NULL, complete INTEGER NOT NULL)",
];
function prepareDirectory(path, create) {
    const uid = process.getuid?.();
    if (resolve(path) !== path || path === "/" || uid === undefined)
        fail("search-v3-storage-unsafe");
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 64)
        fail("search-v3-storage-unsafe");
    let at = "", made = 0;
    for (const part of parts) {
        at += `/${part}`;
        try {
            const st = lstatSync(at), final = at === path;
            if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== uid)
                || ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))
                || (final && (st.uid !== uid || (st.mode & 0o7777) !== 0o700)))
                fail("search-v3-storage-unsafe");
        }
        catch (error) {
            if (error.code !== "ENOENT" || !create || ++made > 8)
                throw error;
            mkdirSync(at, { mode: 0o700 });
        }
    }
}
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
            fail("search-v3-version-mismatch");
        }
        const meta = this.get("SELECT * FROM meta WHERE singleton=1");
        if (!meta || num(meta, "version") !== SEARCH_V3_SCHEMA_VERSION || str(meta, "identity") !== canonicalJson(this.request.identity)
            || str(meta, "searchRoute") !== this.request.searchDirectory || str(meta, "capsuleRoute") !== this.request.capsuleDirectory
            || str(meta, "catalogRoute") !== this.request.catalogDirectory)
            fail("search-v3-store-mismatch");
        for (const sql of schema) {
            const parts = sql.split(" "), name = parts[1] === "VIRTUAL" ? parts[3] : parts[2];
            if (this.get("SELECT sql FROM sqlite_master WHERE name=?", name)?.sql !== sql)
                fail("search-v3-version-mismatch");
        }
    }
    initialize() {
        this.transaction(() => {
            this.validate(true);
            if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")) {
                for (const sql of schema)
                    this.run(sql);
                this.run("INSERT INTO meta VALUES(1,?,?,?,?,?,0)", SEARCH_V3_SCHEMA_VERSION, canonicalJson(this.request.identity), this.request.searchDirectory, this.request.capsuleDirectory, this.request.catalogDirectory);
            }
        });
    }
}
function sourceKey(source) { return sha256(canonicalJson(source)); }
function terms(text) {
    return [...new Set((text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ").match(/[\p{L}\p{N}_./:@+\-]{2,}/gu) ?? [])
            .flatMap(value => [value.toLowerCase(), ...value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_./:@+\-]+|\s+/).map(part => part.toLowerCase())])
            .filter(value => value.length >= 2))];
}
function paths(text) {
    const found = text.match(/(?:\.?\.?\/|\/)[\w@.+\-~]+(?:\/[\w@.+\-~]+)+|[\w@.+\-]+(?:\/[\w@.+\-]+)+/g) ?? [];
    return [...new Set(found.map(value => value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase()))].slice(0, 64);
}
function identifiers(text) {
    return [...new Set(text.match(/\b(?:[a-f0-9]{7,64}|[A-Za-z_$][A-Za-z0-9_$.-]{4,127})\b/g) ?? [])].slice(0, 128);
}
function capsuleMetadata(envelope) {
    const alternative = envelope.alternatives[0], exact = alternative.protectedCues.map(item => item.exactText).join("\n");
    const cue = `${alternative.text}\n${exact}`.slice(0, SEARCH_V3_LIMITS.cueUnits);
    const toolFact = alternative.facts.find(item => item.kind === "structural" && item.name === "toolName" && typeof item.value === "string");
    return { source: envelope.source, cue, identifiers: identifiers(cue).join(" "), paths: paths(cue).join(" "), kind: envelope.family,
        provenance: envelope.provenance, toolName: toolFact && typeof toolFact.value === "string" ? toolFact.value : null,
        error: alternative.outcome.status === "unknown" ? null : alternative.outcome.value === "failure" ? 1 : 0,
        nextDecoded: envelope.source.decodedUtf16.start, carry: "" };
}
function sourceMetadata(source, provenance) {
    return { source, cue: "", identifiers: "", paths: "", kind: "unknown", provenance, toolName: null, error: null,
        nextDecoded: source.decodedUtf16.start, carry: "" };
}
function extendsView(current, old) {
    return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
        && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index].cut >= item.cut);
}
async function capsuleCall(request, executor, sourceBudget, extra) {
    const base = { v: 1, derivedDirectory: request.capsuleDirectory, catalogDirectory: request.catalogDirectory, identity: request.identity.capsule };
    const response = await executor({ ...base, ...extra });
    sourceBudget.bytes += response.sourceBytes;
    if (sourceBudget.bytes > SEARCH_V3_LIMITS.sourceBytesPerJob)
        fail("search-v3-source-budget");
    if (!response.ok)
        return fail(response.code === "capsule-source-changed" ? "search-v3-source-changed" : "search-v3-capsule-unavailable");
    return response.result;
}
function parseActive(text) {
    if (text === null)
        return undefined;
    try {
        return JSON.parse(String(text));
    }
    catch {
        fail("search-v3-checkpoint-corrupt");
    }
}
async function ingest(request, store, executor, sourceBudget) {
    const lineage = LINEAGE(request.view), row = store.get("SELECT * FROM heads WHERE lineage=?", lineage);
    let afterEventSeq = row ? num(row, "afterEventSeq") : 0, afterDescriptor = row ? num(row, "afterDescriptor") : 0;
    let active = row ? parseActive(row.active ?? null) : undefined;
    let generation = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation");
    let cueReady = row ? num(row, "cueReady") : 0, rawReady = row ? num(row, "rawReady") : 0, excluded = row ? num(row, "excluded") : 0;
    if (row) {
        const old = JSON.parse(str(row, "view"));
        if (!extendsView(request.view, old))
            fail("search-v3-cursor-invalid");
    }
    let sources = 0, chunks = 0, enumerationPages = 0, complete = false;
    while (sources < (request.maxSources ?? SEARCH_V3_LIMITS.ingestSources) && chunks < (request.maxChunks ?? SEARCH_V3_LIMITS.ingestChunks)
        && (active !== undefined || enumerationPages < INGEST_ENUMERATION_PAGES)) {
        if (!active) {
            enumerationPages++;
            const page = await capsuleCall(request, executor, sourceBudget, { op: "chunkSourcePage", view: request.view, afterEventSeq, afterDescriptor, limit: 1,
                maxDescriptors: INGEST_ENUMERATION_DESCRIPTORS });
            const item = page.sources?.[0];
            if (!item) {
                afterEventSeq = Number(page.next?.afterEventSeq ?? afterEventSeq);
                afterDescriptor = Number(page.next?.afterDescriptor ?? afterDescriptor);
                complete = Boolean(page.complete);
                if (complete)
                    break;
                continue;
            }
            active = item.capsule ? capsuleMetadata(item.capsule) : sourceMetadata(item.source, item.provenance);
        }
        const key = sourceKey(active.source);
        if (active.provenance === "generated") {
            active.nextDecoded = active.source.decodedUtf16.end;
            excluded++;
        }
        else if (active.nextDecoded < active.source.decodedUtf16.end) {
            const length = Math.min(CAPSULE_LIMITS.decodedChunkUnits, active.source.decodedUtf16.end - active.nextDecoded);
            const result = await capsuleCall(request, executor, sourceBudget, { op: "chunkRange", view: request.view, source: active.source,
                decodedStart: active.nextDecoded, decodedLength: length, limit: 2 });
            const bytes = Buffer.from(String(result.data), "base64"), text = bytes.toString("utf16le");
            if (bytes.length !== length * 2 || text.length !== length)
                fail("search-v3-chunk-invalid");
            const chunkIndex = Math.floor(active.nextDecoded / CAPSULE_LIMITS.decodedChunkUnits), indexed = active.carry + text;
            const indexedStart = active.nextDecoded - active.carry.length;
            store.transaction(() => {
                const prior = store.get("SELECT decodedStart,decodedEnd,text FROM chunks WHERE sourceKey=? AND chunkIndex=?", key, chunkIndex);
                if (prior) {
                    if (num(prior, "decodedStart") !== indexedStart || num(prior, "decodedEnd") !== active.nextDecoded + length || str(prior, "text") !== indexed)
                        fail("search-v3-chunk-conflict");
                }
                else {
                    store.run("INSERT INTO chunks VALUES(?,?,?,?,?)", key, chunkIndex, indexedStart, active.nextDecoded + length, indexed);
                    // The exact chunk row and its FTS row commit atomically. A present
                    // chunk therefore proves the FTS insertion without scanning FTS.
                    store.run("INSERT INTO raw_fts(sourceKey,chunkIndex,text) VALUES(?,?,?)", key, chunkIndex, indexed);
                }
            });
            active.paths = [...new Set([...active.paths.split(" ").filter(Boolean), ...paths(text)])].slice(0, 64).join(" ");
            active.identifiers = [...new Set([...active.identifiers.split(" ").filter(Boolean), ...identifiers(text)])].slice(0, 128).join(" ");
            active.carry = text.slice(-Math.min(SEARCH_V3_LIMITS.queryUnits - 1, text.length));
            active.nextDecoded += length;
            chunks++;
        }
        if (active.nextDecoded === active.source.decodedUtf16.end) {
            const completed = active, candidateGeneration = generation + 1;
            let inserted = false;
            store.transaction(() => {
                const prior = store.get("SELECT * FROM documents WHERE sourceKey=?", key);
                if (prior) {
                    if (str(prior, "source") !== canonicalJson(completed.source))
                        fail("search-v3-document-conflict");
                }
                else {
                    store.run("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", key, canonicalJson(completed.source), completed.source.segment, completed.source.eventSeq, completed.source.descriptor, completed.source.blockIndex ?? null, completed.source.shardKey, completed.kind, completed.provenance, completed.toolName, completed.error, completed.cue, completed.identifiers, completed.paths, candidateGeneration);
                    // Document and cue FTS rows share one transaction. Never probe FTS
                    // columns as a substitute for the indexed document identity.
                    store.run("INSERT INTO cue_fts(sourceKey,cue,identifiers,paths) VALUES(?,?,?,?)", key, completed.cue, completed.identifiers, completed.paths);
                    store.run("UPDATE meta SET generation=? WHERE singleton=1", candidateGeneration);
                    inserted = true;
                }
                store.run("INSERT OR IGNORE INTO membership VALUES(?,?,?,?)", lineage, key, completed.source.eventSeq, completed.source.descriptor);
            });
            if (inserted)
                generation = candidateGeneration;
            cueReady++;
            if (completed.provenance !== "generated")
                rawReady++;
            afterEventSeq = completed.source.eventSeq;
            afterDescriptor = completed.source.descriptor + 1;
            active = undefined;
            sources++;
        }
    }
    store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?,?,?,?)", lineage, canonicalJson(request.view), afterEventSeq, afterDescriptor, active ? canonicalJson(active) : null, generation, cueReady, rawReady, excluded, complete && !active ? 1 : 0);
    return { complete: complete && !active, cursor: { afterEventSeq, afterDescriptor, activeDecodedOffset: active?.nextDecoded ?? 0 }, indexGeneration: generation,
        readiness: { cue: complete && !active ? "ready" : "partial", raw: complete && !active ? "ready" : "partial", cueReady, rawReady, excluded,
            cursor: { afterEventSeq, afterDescriptor, activeDecodedOffset: active?.nextDecoded ?? 0 } },
        metrics: { sources, chunks, enumerationPages, enumerationDescriptorsLimit: INGEST_ENUMERATION_PAGES * INGEST_ENUMERATION_DESCRIPTORS, sqliteStatements: store.statements } };
}
function ftsQuery(query) {
    const values = terms(query).filter(value => value.length >= 2).slice(0, 12);
    return values.length ? values.map(value => `"${value.replaceAll('"', '""')}"`).join(" OR ") : undefined;
}
function normalizePath(value) { return value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase() || "/"; }
function viewBoundsSql(view, alias = "d") {
    const clauses = view.segments.map(() => `(${alias}.segment=? AND ${alias}.eventSeq<=?)`);
    return { sql: ` AND (${clauses.join(" OR ")})`, values: view.segments.flatMap(item => [item.segment, item.cut]) };
}
function filterSql(filters, alias = "d") {
    const clauses = [], values = [];
    if (filters?.kinds?.length) {
        clauses.push(`${alias}.kind IN (${filters.kinds.map(() => "?").join(",")})`);
        values.push(...filters.kinds);
    }
    if (filters?.provenance?.length) {
        clauses.push(`${alias}.provenance IN (${filters.provenance.map(() => "?").join(",")})`);
        values.push(...filters.provenance);
    }
    if (filters?.shardKeys?.length) {
        clauses.push(`${alias}.shardKey IN (${filters.shardKeys.map(() => "?").join(",")})`);
        values.push(...filters.shardKeys);
    }
    if (filters?.toolNames?.length) {
        clauses.push(`${alias}.toolName IN (${filters.toolNames.map(() => "?").join(",")})`);
        values.push(...filters.toolNames);
    }
    if (filters?.error !== undefined) {
        clauses.push(`${alias}.error=?`);
        values.push(filters.error ? 1 : 0);
    }
    if (filters?.path !== undefined) {
        clauses.push(`${alias}.paths LIKE ?`);
        values.push(`%${normalizePath(filters.path)}%`);
    }
    if (filters?.identifier !== undefined) {
        clauses.push(`lower(${alias}.identifiers) LIKE ?`);
        values.push(`%${filters.identifier.toLowerCase()}%`);
    }
    return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", values };
}
function cursorEncode(value) { return Buffer.from(canonicalJson(value)).toString("base64url"); }
function cursorDecode(cursor) { try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object")
        throw 0;
    return value;
}
catch {
    return fail("search-v3-cursor-invalid");
} }
function handle(request, view, generation, row, candidate) {
    const source = JSON.parse(str(row, "source"));
    return { v: 1, searchStoreKey: request.identity.storeKey, capsuleStoreKey: request.identity.capsule.storeKey,
        catalogStoreKey: request.identity.capsule.catalogStoreKey, catalogGeneration: request.identity.capsule.catalogGeneration,
        sessionKey: request.identity.capsule.sessionKey, branchKey: view.branchKey, eventCut: view.eventCut, indexGeneration: generation, source,
        evidence: candidate?.evidence ?? (str(row, "provenance") === "generated" ? "generated-cue" : "raw-source"),
        ...(candidate?.start === undefined ? {} : { decodedUtf16: { start: candidate.start, end: candidate.end } }) };
}
function pinnedGeneration(store, request, queryHash) {
    const current = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation");
    if (!request.cursor)
        return { generation: current, offset: 0, scanOffset: 0, afterEventSeq: 0, afterDescriptor: 0, afterSourceKey: "", afterChunkIndex: 0 };
    const parsed = cursorDecode(request.cursor);
    if (parsed.storeKey !== request.identity.storeKey || parsed.viewHash !== VIEW(request.view) || parsed.queryHash !== queryHash
        || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1 || Number(parsed.generation) > current
        || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || !Number.isSafeInteger(parsed.scanOffset) || Number(parsed.scanOffset) < 0
        || !Number.isSafeInteger(parsed.afterEventSeq ?? 0) || Number(parsed.afterEventSeq ?? 0) < 0
        || !Number.isSafeInteger(parsed.afterDescriptor ?? 0) || Number(parsed.afterDescriptor ?? 0) < 0
        || typeof (parsed.afterSourceKey ?? "") !== "string" || !/^(?:|[a-f0-9]{64})$/.test(String(parsed.afterSourceKey ?? ""))
        || !Number.isSafeInteger(parsed.afterChunkIndex ?? 0) || Number(parsed.afterChunkIndex ?? 0) < 0)
        fail("search-v3-cursor-invalid");
    return { generation: Number(parsed.generation), offset: Number(parsed.offset), scanOffset: Number(parsed.scanOffset), afterEventSeq: Number(parsed.afterEventSeq ?? 0),
        afterDescriptor: Number(parsed.afterDescriptor ?? 0), afterSourceKey: String(parsed.afterSourceKey ?? ""), afterChunkIndex: Number(parsed.afterChunkIndex ?? 0) };
}
function hit(request, candidate, generation) {
    const cue = str(candidate.row, "cue").replace(/\s+/g, " ").trim();
    const snippet = candidate.evidence === "raw-source" ? str(candidate.row, "text").slice(Math.max(0, (candidate.start ?? 0) - num(candidate.row, "decodedStart") - 80), Math.max(0, (candidate.start ?? 0) - num(candidate.row, "decodedStart") - 80) + 240).replace(/\s+/g, " ").trim() : cue.slice(0, 240);
    return { handle: handle(request, request.view, generation, candidate.row, candidate), eventSeq: num(candidate.row, "eventSeq"), descriptor: num(candidate.row, "descriptor"),
        kind: str(candidate.row, "kind"), provenance: str(candidate.row, "provenance"), cue: snippet, score: candidate.score, scoreReason: candidate.reason,
        exactSourceAvailable: true, independentEvidence: candidate.evidence === "raw-source" };
}
function compileRegex(query, caseSensitive = false) { try {
    return new RegExp(query, caseSensitive ? "u" : "iu");
}
catch {
    return fail("search-v3-query-invalid");
} }
function query(request, store) {
    if ((request.filters?.currentState !== undefined && request.filters.currentState !== "any") || request.filters?.unresolved !== undefined
        || request.filters?.kinds !== undefined)
        fail("search-v3-filter-unsupported");
    const mode = request.mode ?? "ranked", filter = filterSql(request.filters), bounds = viewBoundsSql(request.view);
    if (mode === "regex" && !request.scan)
        fail("search-v3-scan-required");
    const match = request.scan || mode === "regex" ? undefined : ftsQuery(request.query);
    if (mode === "literal" && !match && !request.scan)
        fail("search-v3-scan-required");
    const queryHash = sha256(canonicalJson({ op: "query", view: request.view, query: request.query, mode,
        caseSensitive: request.caseSensitive ?? false, filters: request.filters ?? null, scan: request.scan ?? null }));
    const pin = pinnedGeneration(store, request, queryHash), lineage = LINEAGE(request.view), maximum = SEARCH_V3_LIMITS.candidates;
    let candidates = [], scanOffset = pin.scanOffset, scanComplete = true;
    let scanLast = { eventSeq: pin.afterEventSeq, descriptor: pin.afterDescriptor, sourceKey: pin.afterSourceKey, chunkIndex: pin.afterChunkIndex };
    if (match) {
        if (mode === "ranked") {
            const cueRows = store.rows(`SELECT d.* FROM cue_fts JOIN documents d ON d.sourceKey=cue_fts.sourceKey JOIN membership m ON m.sourceKey=d.sourceKey AND m.lineage=? WHERE cue_fts MATCH ? AND d.eventSeq<=? AND d.indexGeneration<=?${bounds.sql}${filter.sql} LIMIT ?`, maximum + 1, lineage, match, request.view.eventCut, pin.generation, ...bounds.values, ...filter.values, maximum + 1);
            if (cueRows.length > maximum)
                fail("search-v3-query-budget");
            candidates.push(...cueRows.map(row => ({ row, score: 1_000, evidence: "generated-cue", reason: "bounded capsule cue lexical match" })));
        }
        const rawRows = store.rows(`SELECT d.*,c.decodedStart,c.decodedEnd,c.text,c.chunkIndex FROM raw_fts JOIN chunks c ON c.sourceKey=raw_fts.sourceKey AND c.chunkIndex=raw_fts.chunkIndex JOIN documents d ON d.sourceKey=c.sourceKey JOIN membership m ON m.sourceKey=d.sourceKey AND m.lineage=? WHERE raw_fts MATCH ? AND d.eventSeq<=? AND d.indexGeneration<=?${bounds.sql}${filter.sql} LIMIT ?`, maximum + 1, lineage, match, request.view.eventCut, pin.generation, ...bounds.values, ...filter.values, maximum + 1);
        if (rawRows.length > maximum)
            fail("search-v3-query-budget");
        const literalPattern = mode === "literal" ? compileRegex(request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), request.caseSensitive ?? false) : undefined;
        for (const row of rawRows) {
            const text = str(row, "text"), at = literalPattern ? literalPattern.exec(text)?.index ?? -1 : -1;
            if (mode !== "ranked" && at < 0)
                continue;
            const found = at < 0 ? terms(request.query).map(term => text.toLowerCase().indexOf(term)).find(index => index >= 0) ?? 0 : at;
            candidates.push({ row, score: 1_000_000, evidence: "raw-source", start: num(row, "decodedStart") + found,
                end: num(row, "decodedStart") + found + Math.max(1, request.query.length),
                reason: mode === "literal" ? "verified exact raw phrase" : "raw lexical match" });
        }
    }
    else if ((mode === "regex" || mode === "literal") && request.scan) {
        const source = mode === "literal" ? request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : request.query;
        const started = Date.now(), pattern = compileRegex(source, request.caseSensitive ?? false);
        const rows = store.rows(`SELECT d.*,c.decodedStart,c.decodedEnd,c.text,c.chunkIndex FROM chunks c JOIN documents d ON d.sourceKey=c.sourceKey JOIN membership m ON m.sourceKey=d.sourceKey AND m.lineage=? WHERE d.eventSeq<=? AND d.indexGeneration<=?${bounds.sql}${filter.sql} AND (d.eventSeq>? OR (d.eventSeq=? AND (d.descriptor>? OR (d.descriptor=? AND (d.sourceKey>? OR (d.sourceKey=? AND c.chunkIndex>?)))))) ORDER BY d.eventSeq,d.descriptor,d.sourceKey,c.chunkIndex LIMIT ?`, request.scan.maxChunks, lineage, request.view.eventCut, pin.generation, ...bounds.values, ...filter.values, pin.afterEventSeq, pin.afterEventSeq, pin.afterDescriptor, pin.afterDescriptor, pin.afterSourceKey, pin.afterSourceKey, pin.afterChunkIndex, request.scan.maxChunks);
        let consumed = 0;
        for (const row of rows) {
            if (Date.now() - started >= request.scan.maxMs) {
                scanComplete = false;
                break;
            }
            consumed++;
            scanLast = { eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"), sourceKey: str(row, "sourceKey"), chunkIndex: num(row, "chunkIndex") };
            const found = pattern.exec(str(row, "text"));
            if (found) {
                candidates.push({ row, score: 1_000_000, evidence: "raw-source", start: num(row, "decodedStart") + found.index,
                    end: num(row, "decodedStart") + found.index + found[0].length, reason: mode === "literal" ? "explicit bounded exact literal scan" : "explicit bounded raw regex scan" });
                if (candidates.length >= (request.limit ?? SEARCH_V3_LIMITS.page)) {
                    scanComplete = false;
                    break;
                }
            }
        }
        scanOffset += consumed;
        scanComplete = scanComplete && rows.length < request.scan.maxChunks;
    }
    else
        fail("search-v3-query-unsupported");
    const bySource = new Map();
    candidates.sort((a, b) => b.score - a.score || num(b.row, "eventSeq") - num(a.row, "eventSeq") || num(a.row, "descriptor") - num(b.row, "descriptor"));
    for (const candidate of candidates) {
        const key = str(candidate.row, "sourceKey"), prior = bySource.get(key);
        if (!prior || candidate.evidence === "raw-source" && prior.evidence !== "raw-source")
            bySource.set(key, candidate);
    }
    const diverse = [...bySource.values()], limit = request.limit ?? SEARCH_V3_LIMITS.page;
    const selected = diverse.slice(pin.offset, pin.offset + limit).sort((a, b) => num(a.row, "eventSeq") - num(b.row, "eventSeq") || num(a.row, "descriptor") - num(b.row, "descriptor"));
    const nextOffset = pin.offset + selected.length, hasMore = nextOffset < diverse.length || !scanComplete;
    const nextCursor = hasMore ? cursorEncode({ storeKey: request.identity.storeKey, viewHash: VIEW(request.view), queryHash, generation: pin.generation,
        offset: nextOffset < diverse.length ? nextOffset : 0, scanOffset, afterEventSeq: scanLast.eventSeq, afterDescriptor: scanLast.descriptor,
        afterSourceKey: scanLast.sourceKey, afterChunkIndex: scanLast.chunkIndex }) : undefined;
    const exhaustive = request.scan !== undefined || mode !== "literal";
    return { indexGeneration: pin.generation, branchKey: request.view.branchKey, eventCut: request.view.eventCut, hits: selected.map(item => hit(request, item, pin.generation)),
        ...(nextCursor ? { nextCursor } : {}), complete: exhaustive && !hasMore, exhaustive,
        coverage: request.scan ? "explicit-bounded-raw-scan" : mode === "literal" ? "indexed-token-candidates" : "indexed-cue-and-token-candidates",
        scan: request.scan ? { explicit: true, complete: scanComplete, chunksScanned: scanOffset - pin.scanOffset } : undefined,
        cache: { hit: false, bytes: 0, limitBytes: SEARCH_V3_LIMITS.cacheBytes }, metrics: { candidates: diverse.length, sqliteStatements: store.statements } };
}
async function recall(request, store, executor, sourceBudget) {
    const h = request.handle;
    if (h.searchStoreKey !== request.identity.storeKey || h.capsuleStoreKey !== request.identity.capsule.storeKey || h.catalogStoreKey !== request.view.storeKey
        || h.catalogGeneration !== request.view.generation || h.sessionKey !== request.view.sessionKey || h.branchKey !== request.view.branchKey
        || h.eventCut > request.view.eventCut)
        fail("search-v3-handle-invalid");
    const key = sourceKey(h.source), row = store.get("SELECT d.* FROM documents d JOIN membership m ON m.sourceKey=d.sourceKey AND m.lineage=? WHERE d.sourceKey=? AND d.eventSeq<=? AND d.indexGeneration<=?", LINEAGE(request.view), key, h.eventCut, h.indexGeneration);
    if (!row || str(row, "source") !== canonicalJson(h.source))
        fail("search-v3-handle-invalid");
    const requestedStart = request.decodedStart ?? Math.max(h.source.decodedUtf16.start, (h.decodedUtf16?.start ?? h.source.decodedUtf16.start) - 256);
    const desired = request.decodedLength ?? Math.min(1024, h.source.decodedUtf16.end - requestedStart);
    const start = Math.max(h.source.decodedUtf16.start, Math.min(requestedStart, h.source.decodedUtf16.end));
    const length = Math.min(desired, h.source.decodedUtf16.end - start);
    if (length <= 0)
        fail("search-v3-range-invalid");
    const result = await capsuleCall(request, executor, sourceBudget, { op: "chunkRange", view: request.view, source: h.source, decodedStart: start, decodedLength: length, limit: 2 });
    const bytes = Buffer.from(String(result.data), "base64"), text = bytes.toString("utf16le");
    if (bytes.length !== length * 2 || text.length !== length)
        fail("search-v3-chunk-invalid");
    return { handle: h, source: h.source, decodedUtf16: { start, end: start + length }, text, exact: true,
        independentEvidence: h.evidence === "raw-source", generatedRetrieval: h.evidence === "generated-cue", metrics: { sqliteStatements: store.statements } };
}
function sources(request, store) {
    const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation"), limit = request.limit ?? SEARCH_V3_LIMITS.page;
    const bounds = viewBoundsSql(request.view);
    const rows = store.rows(`SELECT d.* FROM documents d JOIN membership m ON m.sourceKey=d.sourceKey AND m.lineage=? WHERE d.eventSeq=? AND d.eventSeq<=?${bounds.sql}
    AND d.descriptor>? AND (? IS NULL OR d.blockIndex=?) AND d.indexGeneration<=? ORDER BY d.descriptor,d.sourceKey LIMIT ?`, limit + 1, LINEAGE(request.view), request.eventSeq, request.view.eventCut, ...bounds.values, request.afterDescriptor ?? -1, request.blockIndex ?? null, request.blockIndex ?? null, generation, limit + 1);
    const selected = rows.slice(0, limit), last = selected.at(-1);
    return { indexGeneration: generation, branchKey: request.view.branchKey, eventCut: request.view.eventCut,
        sources: selected.map(row => ({ handle: handle(request, request.view, generation, row), descriptor: num(row, "descriptor"),
            blockIndex: row.blockIndex === null ? undefined : num(row, "blockIndex"), kind: str(row, "kind"), provenance: str(row, "provenance") })),
        nextAfterDescriptor: rows.length > limit && last ? num(last, "descriptor") : undefined, complete: rows.length <= limit,
        metrics: { sqliteStatements: store.statements } };
}
function range(request, store) {
    const queryHash = sha256(canonicalJson({ op: "range", view: request.view })), pin = pinnedGeneration(store, request, queryHash), limit = request.limit ?? SEARCH_V3_LIMITS.page;
    if (pin.offset !== 0)
        fail("search-v3-cursor-invalid");
    const bounds = viewBoundsSql(request.view);
    const rows = store.rows(`SELECT d.* FROM documents d JOIN membership m ON m.sourceKey=d.sourceKey AND m.lineage=? WHERE d.eventSeq<=? AND d.indexGeneration<=?${bounds.sql}
    AND (d.eventSeq>? OR (d.eventSeq=? AND (d.descriptor>? OR (d.descriptor=? AND d.sourceKey>?)))) ORDER BY d.eventSeq,d.descriptor,d.sourceKey LIMIT ?`, limit + 1, LINEAGE(request.view), request.view.eventCut, pin.generation, ...bounds.values, pin.afterEventSeq, pin.afterEventSeq, pin.afterDescriptor, pin.afterDescriptor, pin.afterSourceKey, limit + 1);
    const selected = rows.slice(0, limit), last = selected.at(-1);
    return { indexGeneration: pin.generation, branchKey: request.view.branchKey, eventCut: request.view.eventCut,
        items: selected.map(row => ({ handle: handle(request, request.view, pin.generation, row), eventSeq: num(row, "eventSeq"), descriptor: num(row, "descriptor"),
            kind: str(row, "kind"), provenance: str(row, "provenance"), cue: str(row, "cue").replace(/\s+/g, " ").slice(0, 240) })),
        ...(rows.length > limit && last ? { nextCursor: cursorEncode({ storeKey: request.identity.storeKey, viewHash: VIEW(request.view), queryHash,
                generation: pin.generation, offset: 0, scanOffset: 0, afterEventSeq: num(last, "eventSeq"), afterDescriptor: num(last, "descriptor"),
                afterSourceKey: str(last, "sourceKey"), afterChunkIndex: 0 }) } : {}),
        complete: rows.length <= limit, metrics: { sqliteStatements: store.statements } };
}
async function execute(request, store, executor, sourceBudget) {
    if (request.op === "ingestPage")
        return ingest(request, store, executor, sourceBudget);
    if (request.op === "query")
        return query(request, store);
    if (request.op === "recall")
        return recall(request, store, executor, sourceBudget);
    if (request.op === "sources")
        return sources(request, store);
    if (request.op === "range")
        return range(request, store);
    const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1"), "generation");
    if (!request.view)
        return { identity: request.identity, indexGeneration: generation, readiness: { cue: "view-required", raw: "view-required" },
            cache: { bytes: 0, limitBytes: SEARCH_V3_LIMITS.cacheBytes }, metrics: { sqliteStatements: store.statements } };
    const row = store.get("SELECT * FROM heads WHERE lineage=?", LINEAGE(request.view));
    return { identity: request.identity, indexGeneration: generation, readiness: row ? { cue: num(row, "complete") ? "ready" : "partial", raw: num(row, "complete") ? "ready" : "partial",
            cueReady: num(row, "cueReady"), rawReady: num(row, "rawReady"), excluded: num(row, "excluded"),
            cursor: { afterEventSeq: num(row, "afterEventSeq"), afterDescriptor: num(row, "afterDescriptor"), active: row.active !== null } }
            : { cue: "missing", raw: "missing", cueReady: 0, rawReady: 0, excluded: 0 }, metrics: { sqliteStatements: store.statements } };
}
/** Direct executor for tests and the contained worker entry. */
export async function executeSearchV3Request(value, options = {}) {
    if (!isSearchV3Request(value))
        return { v: 1, ok: false, code: "search-v3-request-invalid", sourceBytes: 0,
            sqliteNativeLimitBytes: SEARCH_V3_LIMITS.nativeSqliteBytes, resumable: false };
    const request = value, create = request.op === "ingestPage";
    let db;
    const sourceBudget = { bytes: 0 };
    try {
        prepareDirectory(request.searchDirectory, create);
        const action = async () => {
            const dbPath = join(request.searchDirectory, "search.sqlite"), validate = (candidate) => new Store(candidate, request).validate(create);
            db = create ? CatalogSqlite.create(dbPath, validate) : CatalogSqlite.open(dbPath, validate);
            const store = new Store(db, request);
            if (create)
                store.initialize();
            else
                store.validate(false);
            const result = await execute(request, store, options.capsuleExecutor ?? executeCapsuleRequest, sourceBudget);
            const response = { v: 1, ok: true, result, sourceBytes: sourceBudget.bytes, sqliteNativeLimitBytes: SEARCH_V3_LIMITS.nativeSqliteBytes };
            if (Buffer.byteLength(JSON.stringify(response)) > SEARCH_V3_LIMITS.responseBytes)
                fail("search-v3-response-limit");
            try {
                db.checkpoint();
            }
            catch { /* committed WAL remains authoritative */ }
            return response;
        };
        return create ? await withRuntimeMutex(join(request.searchDirectory, "publication.lock"), action) : await action();
    }
    catch (error) {
        const candidate = error.code;
        const mapped = { "catalog-storage-unsafe": "search-v3-storage-unsafe", "catalog-sqlite-busy": "search-v3-store-busy",
            "catalog-sqlite-corrupt": "search-v3-store-corrupt", "catalog-sqlite-capability": "search-v3-store-capability", "catalog-sqlite-limit": "search-v3-store-limit",
            "catalog-sqlite-failed": "search-v3-store-failed", "catalog-sqlite-unavailable": "search-v3-store-capability" };
        const code = candidate?.startsWith("search-v3-") ? candidate : candidate && mapped[candidate] ? mapped[candidate] : candidate === "ENOSPC" ? "search-v3-storage-full" : "search-v3-storage-io";
        return { v: 1, ok: false, code, sourceBytes: sourceBudget.bytes, sqliteNativeLimitBytes: SEARCH_V3_LIMITS.nativeSqliteBytes,
            resumable: !["search-v3-request-invalid", "search-v3-store-mismatch", "search-v3-version-mismatch", "search-v3-storage-unsafe"].includes(code) };
    }
    finally {
        try {
            db?.close();
        }
        catch { /* preserve bounded response */ }
    }
}
//# sourceMappingURL=search-v3-store.js.map