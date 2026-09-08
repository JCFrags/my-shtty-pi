import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CatalogSqlite } from "./catalog-sqlite.js";
import { CatalogSource } from "./catalog-source.js";
import { createCatalogParserState, parseCatalogChunk } from "./catalog-parser.js";
import { CATALOG_LIMITS as L, isCatalogRequest } from "./catalog-contract.js";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const n = (r, k) => Number(r[k]);
const text = (r, k) => String(r[k]);
const json = (r, k) => JSON.parse(text(r, k));
const schema = [
    "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, session TEXT NOT NULL, active INTEGER NOT NULL, store TEXT NOT NULL)",
    "CREATE TABLE generations (g INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, state TEXT NOT NULL)",
    "CREATE INDEX generation_state ON generations(state,g)",
    "CREATE TABLE shards (g INTEGER NOT NULL, shard TEXT NOT NULL, branch TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, checkpoint TEXT NOT NULL, checkpointHash TEXT NOT NULL, snapshot TEXT NOT NULL, observed INTEGER NOT NULL, committed INTEGER NOT NULL, count INTEGER NOT NULL, caught INTEGER NOT NULL, PRIMARY KEY(g,shard), UNIQUE(g,ordinal))",
    "CREATE TABLE events (g INTEGER NOT NULL, seq INTEGER NOT NULL, shard TEXT NOT NULL, branch TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT, parentSeq INTEGER, segment INTEGER NOT NULL, rawStart INTEGER NOT NULL, rawEnd INTEGER NOT NULL, endByte INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(g,seq), UNIQUE(g,shard,ordinal))",
    "CREATE INDEX event_identity ON events(g,shard,id)",
    "CREATE INDEX event_segment ON events(g,segment,seq)",
    "CREATE TABLE segments (g INTEGER NOT NULL, segment INTEGER NOT NULL, parentSeq INTEGER, lastSeq INTEGER NOT NULL, PRIMARY KEY(g,segment))",
    "CREATE TABLE blocks (g INTEGER NOT NULL, seq INTEGER NOT NULL, idx INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(g,seq,idx))",
    "CREATE TABLE tool_calls (g INTEGER NOT NULL, segment INTEGER NOT NULL, callid TEXT NOT NULL, seq INTEGER NOT NULL, shard TEXT NOT NULL, ordinal INTEGER NOT NULL, blockIndex INTEGER NOT NULL, name TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY(g,seq,blockIndex))",
    "CREATE INDEX tool_call_identity ON tool_calls(g,segment,callid,seq)",
    "CREATE TABLE spans (g INTEGER NOT NULL, shard TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(g,shard,offset))",
];
/** Bounded private preparation, only for explicit write/start requests. Observed
 * checks do not claim protection against malicious same-UID ancestor races. */
function prepareDirectory(directory) {
    if (resolve(directory) !== directory)
        fail("catalog-storage-unsafe");
    const parts = directory.split("/").filter(Boolean);
    if (parts.length > 64)
        fail("catalog-storage-unsafe");
    const missing = [];
    let path = "";
    const check = (path, final = false) => {
        const st = lstatSync(path);
        if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== process.getuid()) ||
            ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0)) ||
            (final && (st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700)))
            fail("catalog-storage-unsafe");
    };
    try {
        for (const component of parts) {
            path += `/${component}`;
            if (missing.length) {
                missing.push(path);
                continue;
            }
            try {
                check(path, path === directory);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                missing.push(path);
            }
        }
        if (missing.length > 8)
            fail("catalog-storage-unsafe");
        for (const path of missing) {
            try {
                mkdirSync(path, { mode: 0o700 });
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
            check(path, true);
        }
        check(directory, true);
    }
    catch {
        fail("catalog-storage-unsafe");
    }
}
/** One instance per contained job. No source content or lifetime identity maps. */
class Engine {
    db;
    request;
    bytes = 0;
    statements = 0;
    started = Date.now();
    constructor(db, request) {
        this.db = db;
        this.request = request;
    }
    get(sql, ...v) { this.statements++; return this.db.prepare(sql).get(...v); }
    run(sql, ...v) { this.statements++; this.db.prepare(sql).run(...v); }
    rows(sql, limit, ...v) { this.statements++; return [...this.db.prepare(sql).iterate(limit, ...v)]; }
    transaction(fn) {
        let domainError;
        try {
            return this.db.transaction(() => {
                try {
                    return fn();
                }
                catch (error) {
                    if (/^catalog-[a-z0-9-]+$/.test(String(error?.code)))
                        domainError = error;
                    throw error;
                }
            });
        }
        catch (error) {
            throw domainError ?? error;
        }
    }
    initialize() {
        this.transaction(() => {
            const exists = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
            if (!exists) {
                if (this.get("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"))
                    fail("catalog-version-mismatch");
                for (const sql of schema)
                    this.run(sql);
                this.run("INSERT INTO meta VALUES(1,1,?,1,?)", this.request.sessionKey, randomUUID());
                this.run("INSERT INTO generations VALUES(1,'initial','active')");
            }
            const m = this.get("SELECT * FROM meta WHERE singleton=1");
            if (n(m, "version") !== 1 || text(m, "session") !== this.request.sessionKey)
                fail("catalog-version-mismatch");
        });
    }
    generation(requested) {
        const g = requested ?? n(this.get("SELECT active FROM meta WHERE singleton=1"), "active");
        if (!this.get("SELECT g FROM generations WHERE g=?", g))
            fail("catalog-generation-missing");
        return g;
    }
    shard(g, shard) { return this.get("SELECT * FROM shards WHERE g=? AND shard=?", g, shard) ?? fail("catalog-shard-missing"); }
    checkpoint(s) {
        const checkpoint = text(s, "checkpoint");
        if (Buffer.byteLength(checkpoint) > L.checkpointBytes || hash(checkpoint) !== text(s, "checkpointHash"))
            fail("catalog-checkpoint-corrupt");
        const state = JSON.parse(checkpoint);
        if (state.version !== 1 || !Number.isSafeInteger(state.byteOffset) || state.byteOffset < 0 || (state.error && !/^catalog-[a-z0-9-]+$/.test(state.error.code)))
            fail("catalog-checkpoint-corrupt");
        return state;
    }
    event(g, seq) { return this.get("SELECT * FROM events WHERE g=? AND seq=?", g, seq) ?? fail("catalog-event-missing"); }
    resolve(g, shard, id) {
        const rows = this.rows("SELECT * FROM events WHERE g=? AND shard=? AND id=? LIMIT 2", 2, g, shard, JSON.stringify(id));
        if (rows.length !== 1)
            fail(rows.length ? "catalog-reference-ambiguous" : "catalog-parent-missing");
        return rows[0];
    }
    source(s, fn) {
        const source = new CatalogSource(text(s, "path"));
        try {
            if (source.size < n(s, "observed"))
                fail("catalog-source-changed");
            source.verify(json(s, "snapshot"));
            return fn(source);
        }
        finally {
            this.bytes += source.bytesRead;
            source.close();
        }
    }
    saveRecord(g, s, record) {
        const shard = text(s, "shard");
        let parent;
        if (record.parentId !== undefined && record.parentId !== null) {
            const local = this.rows("SELECT * FROM events WHERE g=? AND shard=? AND id=? LIMIT 2", 2, g, shard, JSON.stringify(record.parentId));
            if (local.length > 1)
                fail("catalog-reference-ambiguous");
            parent = local[0];
            if (!parent) {
                const declaration = json(s, "parent");
                if (!declaration.shardKey || declaration.eventId !== record.parentId)
                    fail("catalog-parent-missing");
                parent = this.resolve(g, declaration.shardKey, record.parentId);
            }
        }
        let toolCallSource;
        if (record.role === "toolResult" && record.toolName === undefined) {
            if (record.toolCallId === undefined || !parent)
                fail("catalog-tool-call-missing");
            const scope = this.pin(g, text(parent, "branch"), n(parent, "seq"));
            let matched;
            for (const segment of scope.segments) {
                const calls = this.rows("SELECT * FROM tool_calls WHERE g=? AND segment=? AND callid=? AND seq<=? LIMIT 2", 2, g, segment.segment, JSON.stringify(record.toolCallId), segment.cut);
                if (calls.length > 1 || (matched && calls.length))
                    fail("catalog-reference-ambiguous");
                if (calls.length)
                    matched = calls[0];
            }
            if (!matched)
                fail("catalog-tool-call-missing");
            if (matched) {
                record.toolName = json(matched, "name");
                toolCallSource = { shardKey: text(matched, "shard"), ordinal: n(matched, "ordinal"), blockIndex: n(matched, "blockIndex") };
                if (text(matched, "provenance") === "generated") {
                    record.provenance = "generated";
                    for (const block of record.blocks)
                        block.provenance = "generated";
                }
            }
        }
        const seq = Number(this.get("SELECT MAX(seq) AS seq FROM events WHERE g=?", g)?.seq ?? 0) + 1;
        let segment = seq;
        if (parent && text(parent, "branch") === text(s, "branch")) {
            const previous = this.get("SELECT lastSeq FROM segments WHERE g=? AND segment=?", g, n(parent, "segment"));
            if (n(previous, "lastSeq") === n(parent, "seq"))
                segment = n(parent, "segment");
        }
        if (segment === seq)
            this.run("INSERT INTO segments VALUES(?,?,?,?)", g, segment, parent ? n(parent, "seq") : null, seq);
        else
            this.run("UPDATE segments SET lastSeq=? WHERE g=? AND segment=?", seq, g, segment);
        const { blocks, bodies, cwd: _cwd, parentSession: _privateParent, ...metadata } = record;
        const ordinal = n(s, "count") + 1;
        this.run("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", g, seq, shard, text(s, "branch"), ordinal, record.id === undefined ? null : JSON.stringify(record.id), parent ? n(parent, "seq") : null, segment, record.rawStart, record.rawEnd, record.endByte, JSON.stringify({ ...metadata, ...(toolCallSource ? { toolCallSource } : {}) }));
        // Normalize each body, so even a maximal record never becomes one wire row.
        let idx = 0;
        for (const body of bodies)
            this.run("INSERT INTO blocks VALUES(?,?,?,?)", g, seq, idx++, JSON.stringify({ kind: "body", provenance: record.provenance, ...body }));
        for (const block of blocks) {
            const { bodies: blockBodies, ...header } = block;
            if (record.role === "assistant" && block.type === "toolCall" && block.id !== undefined && block.name !== undefined)
                this.run("INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?,?)", g, segment, JSON.stringify(block.id), seq, shard, ordinal, block.index, JSON.stringify(block.name), block.provenance);
            this.run("INSERT INTO blocks VALUES(?,?,?,?)", g, seq, idx++, JSON.stringify({ kind: "block", ...header }));
            for (const body of blockBodies)
                this.run("INSERT INTO blocks VALUES(?,?,?,?)", g, seq, idx++, JSON.stringify({ kind: "body", blockIndex: block.index, provenance: block.provenance, ...body }));
        }
        s.count = ordinal;
        s.committed = record.endByte;
    }
    ingest(r) {
        return this.transaction(() => {
            this.run("UPDATE meta SET active=active WHERE singleton=1"); // Acquire writer before loading checkpoint.
            const g = this.generation(r.generation);
            const generation = this.get("SELECT state FROM generations WHERE g=?", g);
            if (text(generation, "state") === "retired")
                fail("catalog-generation-retired");
            const parentJson = JSON.stringify(r.parent ? { shardKey: r.parent.shardKey, eventId: r.parent.eventId } : {});
            let s = this.get("SELECT * FROM shards WHERE g=? AND shard=?", g, r.shardKey);
            if (!s) {
                const latest = this.get("SELECT ordinal,caught FROM shards WHERE g=? ORDER BY ordinal DESC LIMIT 1", g);
                if (latest && (r.shardOrdinal <= n(latest, "ordinal") || n(latest, "caught") !== 1))
                    fail("catalog-shard-order");
                if (n(this.get("SELECT COUNT(*) AS count FROM shards WHERE g=?", g), "count") >= 1024)
                    fail("catalog-shard-limit");
                const source = new CatalogSource(r.sourcePath);
                let snapshot;
                try {
                    snapshot = source.snapshot(0);
                }
                finally {
                    this.bytes += source.bytesRead;
                    source.close();
                }
                const checkpoint = JSON.stringify(createCatalogParserState());
                this.run("INSERT INTO shards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", g, r.shardKey, r.branchKey, r.shardOrdinal, r.sourcePath, parentJson, checkpoint, hash(checkpoint), JSON.stringify(snapshot), source.size, 0, 0, 0);
                s = this.shard(g, r.shardKey);
            }
            if (text(s, "path") !== r.sourcePath || text(s, "branch") !== r.branchKey || n(s, "ordinal") !== r.shardOrdinal || text(s, "parent") !== parentJson)
                fail("catalog-source-declaration-mismatch");
            const shard = s;
            return this.source(shard, source => {
                const state = this.checkpoint(shard);
                if (source.size > state.byteOffset && this.get("SELECT ordinal FROM shards WHERE g=? AND ordinal>? LIMIT 1", g, r.shardOrdinal))
                    fail("catalog-shard-order");
                if (state.error)
                    return { generation: g, records: 0, offset: state.byteOffset, committed: n(shard, "committed"), error: state.error.code, caughtUp: false };
                if (state.byteOffset === source.size && (n(shard, "caught") === 1 || state.recordStart !== state.byteOffset)) {
                    source.assertCurrent();
                    return { generation: g, records: 0, offset: state.byteOffset, committed: n(shard, "committed"), caughtUp: n(shard, "caught") === 1, incompleteTail: state.recordStart !== state.byteOffset };
                }
                let records = 0, delta = 0;
                while (state.byteOffset < source.size && delta < L.sourceDelta && records < L.records && this.statements < L.statements - 1536 && Date.now() - this.started < L.jobMs) {
                    const start = state.byteOffset;
                    const bytes = source.read(start, Math.min(65536, source.size - start, L.sourceDelta - delta));
                    let consumed = 0;
                    while (consumed < bytes.length && records < L.records && this.statements < L.statements - 1536 && Date.now() - this.started < L.jobMs) {
                        const result = parseCatalogChunk(state, bytes.subarray(consumed), 1);
                        consumed += result.consumedBytes;
                        for (const record of result.records) {
                            this.saveRecord(g, shard, record);
                            records++;
                        }
                        if (result.error || !result.consumedBytes)
                            break;
                    }
                    if (consumed)
                        this.run("INSERT INTO spans VALUES(?,?,?,?,?)", g, r.shardKey, start, consumed, hash(bytes.subarray(0, consumed)));
                    // Charge all bytes read, including a bounded unread suffix discarded at a job cut.
                    delta += bytes.length;
                    if (state.error || !consumed)
                        break;
                }
                const saved = JSON.stringify(state);
                if (Buffer.byteLength(saved) > L.checkpointBytes)
                    fail("catalog-checkpoint-limit");
                source.assertCurrent();
                const snapshot = source.snapshot(state.byteOffset);
                const parseError = state.error;
                const caught = state.byteOffset === source.size && !parseError && state.recordStart === state.byteOffset;
                this.run("UPDATE shards SET checkpoint=?,checkpointHash=?,snapshot=?,observed=?,committed=?,count=?,caught=? WHERE g=? AND shard=?", saved, hash(saved), JSON.stringify(snapshot), source.size, n(shard, "committed"), n(shard, "count"), caught ? 1 : 0, g, r.shardKey);
                return { generation: g, records, offset: state.byteOffset, committed: n(shard, "committed"), caughtUp: caught, incompleteTail: state.byteOffset === source.size && state.recordStart !== state.byteOffset, ...(parseError ? { error: parseError.code } : {}) };
            });
        });
    }
    pin(g, branch, seq) {
        const leaf = this.event(g, seq);
        if (text(leaf, "branch") !== branch)
            fail("catalog-branch-mismatch");
        const segments = [];
        let event = leaf;
        while (event) {
            if (segments.length === L.ancestry)
                fail("catalog-ancestry-limit");
            const segment = n(event, "segment");
            segments.push({ segment, cut: n(event, "seq") });
            const row = this.get("SELECT parentSeq FROM segments WHERE g=? AND segment=?", g, segment);
            event = row.parentSeq === null ? undefined : this.event(g, n(row, "parentSeq"));
        }
        return { storeKey: text(this.get("SELECT store FROM meta WHERE singleton=1"), "store"), sessionKey: this.request.sessionKey, generation: g, eventCut: seq, branchKey: branch, segments: segments.reverse() };
    }
    validateView(view) {
        // Reconstruct only bounded indexed segments, never the complete event chain.
        if (view.sessionKey !== this.request.sessionKey || view.storeKey !== text(this.get("SELECT store FROM meta WHERE singleton=1"), "store"))
            fail("catalog-view-invalid");
        const expected = this.pin(view.generation, view.branchKey, view.eventCut);
        if (expected.segments.length !== view.segments.length || expected.segments.some((s, i) => s.segment !== view.segments[i].segment || s.cut !== view.segments[i].cut))
            fail("catalog-view-invalid");
    }
    selected(view, seq) {
        this.validateView(view);
        const e = this.event(view.generation, seq);
        if (!view.segments.some(s => s.segment === n(e, "segment") && seq <= s.cut))
            fail("catalog-event-outside-view");
        return e;
    }
    execute() {
        const r = this.request;
        if (r.op === "ingestStep")
            return this.ingest(r);
        if (r.op === "rebuildStep")
            return this.transaction(() => {
                this.run("UPDATE meta SET active=active WHERE singleton=1");
                if (r.action === "start") {
                    const existing = this.get("SELECT g FROM generations WHERE token=?", `rebuild:${r.rebuildKey}`);
                    if (existing)
                        return { generation: n(existing, "g") };
                    const g = n(this.get("SELECT MAX(g) AS g FROM generations"), "g") + 1;
                    this.run("INSERT INTO generations VALUES(?,?,'building')", g, `rebuild:${r.rebuildKey}`);
                    return { generation: g };
                }
                const g = this.generation(r.generation);
                const counts = this.get("SELECT COUNT(*) AS count,MIN(caught) AS caught FROM shards WHERE g=?", g);
                if (n(counts, "count") !== r.expectedShards || n(counts, "caught") !== 1)
                    fail("catalog-rebuild-incomplete");
                const state = text(this.get("SELECT state FROM generations WHERE g=?", g), "state");
                if (state === "retired")
                    fail("catalog-generation-retired");
                this.run("UPDATE generations SET state='retired' WHERE state='active' AND g<>?", g);
                this.run("UPDATE generations SET state='active' WHERE g=?", g);
                this.run("UPDATE meta SET active=? WHERE singleton=1", g);
                return { generation: g, published: true };
            });
        if (r.op === "status") {
            const g = this.generation(r.generation);
            if (!r.shardKey)
                return { generation: g, storeKey: text(this.get("SELECT store FROM meta WHERE singleton=1"), "store") };
            const s = this.shard(g, r.shardKey), state = this.checkpoint(s);
            return { generation: g, offset: state.byteOffset, committed: n(s, "committed"), records: n(s, "count"), caughtUp: n(s, "caught") === 1, ...(state.error ? { error: state.error.code } : {}) };
        }
        if (r.op === "pin") {
            const g = this.generation(r.generation);
            const leaf = "eventId" in r.leaf ? this.resolve(g, r.leaf.shardKey, r.leaf.eventId)
                : this.get("SELECT * FROM events WHERE g=? AND shard=? AND ordinal=?", g, r.leaf.shardKey, r.leaf.ordinal) ?? fail("catalog-event-missing");
            return { view: this.pin(g, r.branchKey, n(leaf, "seq")) };
        }
        if (r.op === "page") {
            this.validateView(r.view);
            const events = [];
            let pageBytes = 0;
            pageLoop: for (const segment of r.view.segments) {
                if (events.length >= (r.limit ?? L.page))
                    break;
                for (const row of this.rows("SELECT * FROM events WHERE g=? AND segment=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?", r.limit ?? L.page, r.view.generation, segment.segment, r.after ?? 0, segment.cut, (r.limit ?? L.page) - events.length)) {
                    const item = { seq: n(row, "seq"), shardKey: text(row, "shard"), branchKey: text(row, "branch"), ordinal: n(row, "ordinal"), rawStart: n(row, "rawStart"), rawEnd: n(row, "rawEnd"), endByte: n(row, "endByte"), metadata: json(row, "metadata") };
                    const size = Buffer.byteLength(JSON.stringify(item));
                    if (pageBytes + size > 192 * 1024)
                        break pageLoop;
                    events.push(item);
                    pageBytes += size;
                }
            }
            return { events, after: events.length ? events.at(-1).seq : r.after ?? 0 };
        }
        if (r.op === "blocks") {
            this.selected(r.view, r.eventSeq);
            const blocks = [];
            let pageBytes = 0;
            for (const row of this.rows("SELECT idx,metadata FROM blocks WHERE g=? AND seq=? AND idx>=? ORDER BY idx LIMIT ?", r.limit ?? L.page, r.view.generation, r.eventSeq, r.after ?? 0, r.limit ?? L.page)) {
                const item = { index: n(row, "idx"), metadata: json(row, "metadata") };
                const size = Buffer.byteLength(JSON.stringify(item));
                if (pageBytes + size > 192 * 1024)
                    break;
                blocks.push(item);
                pageBytes += size;
            }
            return { blocks, after: blocks.length ? blocks.at(-1).index + 1 : r.after ?? 0 };
        }
        if (r.op === "raw") {
            const event = this.selected(r.view, r.eventSeq);
            if (r.offset < n(event, "rawStart") || r.length > n(event, "endByte") - r.offset || r.offset > n(event, "endByte"))
                fail("catalog-source-range");
            return this.source(this.shard(r.view.generation, text(event, "shard")), source => {
                const output = Buffer.alloc(r.length);
                let at = r.offset;
                while (at < r.offset + r.length) {
                    const span = this.get("SELECT * FROM spans WHERE g=? AND shard=? AND offset<=? ORDER BY offset DESC LIMIT 1", r.view.generation, text(event, "shard"), at) ?? fail("catalog-span-missing");
                    const start = n(span, "offset"), length = n(span, "length");
                    if (at >= start + length)
                        fail("catalog-span-missing");
                    const bytes = source.verifyRange({ offset: start, length, sha256: text(span, "hash") });
                    const count = Math.min(start + length - at, r.offset + r.length - at);
                    bytes.copy(output, at - r.offset, at - start, at - start + count);
                    at += count;
                    if (this.statements > L.statements)
                        fail("catalog-job-limit");
                }
                source.assertCurrent();
                return { offset: r.offset, length: r.length, encoding: "base64", data: output.toString("base64") };
            });
        }
        const g = this.generation(r.generation), s = this.shard(g, r.shardKey);
        return this.source(s, source => {
            let after = r.after ?? 0, verified = 0;
            const size = json(s, "snapshot").size;
            if (after > size)
                fail("catalog-integrity-cursor");
            const spans = this.rows("SELECT * FROM spans WHERE g=? AND shard=? AND offset>=? AND offset<? ORDER BY offset LIMIT 96", 96, g, r.shardKey, after, size);
            for (const span of spans) {
                if (n(span, "offset") !== after)
                    fail("catalog-integrity-cursor");
                source.verifyRange({ offset: after, length: n(span, "length"), sha256: text(span, "hash") });
                after += n(span, "length");
                verified++;
            }
            source.assertCurrent();
            if (!spans.length && after !== size)
                fail("catalog-integrity-cursor");
            return { generation: g, after, verified, complete: after === size };
        });
    }
}
/** Must only run inside M03 worker containment. Errors never include source paths/content. */
export function executeCatalogRequest(request) {
    if (!isCatalogRequest(request))
        return { v: 1, ok: false, code: "catalog-request-invalid", sourceBytes: 0 };
    let db, engine;
    try {
        for (const path of [request.catalogDirectory, ...(request.op === "ingestStep" ? [request.sourcePath] : [])]) {
            if (Buffer.from(path, "utf8").toString("utf8") !== path)
                fail("catalog-identity-unsafe");
        }
        if (request.op === "ingestStep" || (request.op === "rebuildStep" && request.action === "start"))
            prepareDirectory(request.catalogDirectory);
        db = CatalogSqlite.open(join(request.catalogDirectory, `catalog-${hash(request.sessionKey)}.sqlite`));
        engine = new Engine(db, request);
        engine.initialize();
        const result = engine.execute();
        const response = { v: 1, ok: true, result, sourceBytes: engine.bytes };
        if (Buffer.byteLength(JSON.stringify(response)) > L.wireBytes)
            fail("catalog-response-limit");
        // A failed passive maintenance attempt must not turn an already committed
        // ingest into an apparent rollback. WAL remains the committed authority.
        try {
            db.checkpoint();
        }
        catch { /* retry maintenance on a later bounded job */ }
        return response;
    }
    catch (error) {
        const candidate = error?.code;
        return { v: 1, ok: false, code: candidate && /^catalog-[a-z0-9-]+$/.test(candidate) ? candidate : "catalog-failed", sourceBytes: engine?.bytes ?? 0 };
    }
    finally {
        try {
            db?.close();
        }
        catch { /* original bounded result remains authoritative */ }
    }
}
//# sourceMappingURL=catalog-engine.js.map