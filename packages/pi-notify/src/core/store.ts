import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ACCEPTANCE_GUIDANCE } from "../contracts.ts";
import type { AckInput, Binding, BindingInput, BindInput, ClaimedDelivery, ClaimInput, DeliveryInput, DeliveryRecord, DestinationInput, DestinationRecord, EventAcceptance, EventInput, EventRecord, JobAcceptance, JobInput, JobRecord, LeaseInput, ListOptions, NoteFields, Page, ResourceNote, RetryPolicy } from "../contracts.ts";
import { canonical, fail, nextCron, validateDestination, validateEvent, validateJob, validateLease, validateNote } from "./validation.ts";

type Row = Record<string, any>;
const iso = (time: number) => new Date(time).toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const defaultRetry: RetryPolicy = { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 60_000 };
const pendingStates = "('accepted','leased','delivered')";
export interface StoreOptions { database: string; serviceId: string; note: NoteFields; now?: () => number }

/** Synchronous transactions keep event matching and delivery acceptance atomic. */
export class NotifyStore {
  readonly db: DatabaseSync;
  readonly serviceId: string;
  readonly now: () => number;
  constructor(options: StoreOptions) {
    this.serviceId = options.serviceId;
    this.now = options.now ?? Date.now;
    if (options.database !== ":memory:") {
      mkdirSync(dirname(options.database), { recursive: true, mode: 0o700 });
      const dir = statSync(dirname(options.database));
      if ((dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) fail("unsafe_database_directory", "Database directory must be owned by the service user and mode 0700.");
      try {
        const file = lstatSync(options.database);
        if (!file.isFile() || file.isSymbolicLink() || (process.getuid && file.uid !== process.getuid())) fail("unsafe_database_file", "An existing database must be a regular file owned by the service user, not a symlink.");
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    this.db = new DatabaseSync(options.database, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
    if (options.database !== ":memory:") chmodSync(options.database, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    const schema = this.db.prepare("PRAGMA user_version").get() as Row;
    if (schema.user_version !== 0 && schema.user_version !== 1) { this.db.close(); fail("unsupported_database", "Database schema is not supported. Use the matching service version."); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS destinations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL,
        binding_owner TEXT, binding_hash TEXT, binding_until INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, destination_id TEXT NOT NULL REFERENCES destinations(id), hash TEXT NOT NULL,
        document TEXT NOT NULL, state TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        next_run_at INTEGER, last_run_at INTEGER, skipped_runs INTEGER NOT NULL DEFAULT 0, expires_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, next_run_at);
      CREATE TABLE IF NOT EXISTS events (
        source TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, document TEXT NOT NULL,
        accepted_at INTEGER NOT NULL, PRIMARY KEY (source,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), destination_id TEXT NOT NULL REFERENCES destinations(id),
        dedupe_key TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        delivered_at INTEGER, completed_at INTEGER, expires_at INTEGER, available_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_hash TEXT, lease_binding_hash TEXT, lease_until INTEGER,
        result TEXT, last_error TEXT, UNIQUE(job_id, dedupe_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deliveries_ready ON deliveries(destination_id,state,available_at);
      CREATE TABLE IF NOT EXISTS notes (resource_id TEXT PRIMARY KEY, destination_id TEXT, document TEXT NOT NULL) STRICT;
      PRAGMA user_version=1;
    `);
    const identity = this.db.prepare("SELECT value FROM meta WHERE key='service_id'").get() as Row | undefined;
    if (identity && identity.value !== this.serviceId) { this.db.close(); fail("service_identity_mismatch", "Configured serviceId differs from the durable database identity."); }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('service_id', ?)").run(this.serviceId);
    const resourceId = `service:${this.serviceId}`;
    if (!this.db.prepare("SELECT resource_id FROM notes WHERE resource_id=?").get(resourceId)) {
      this.putNote({ schemaVersion: 1, resourceId, kind: "service", ...options.note });
    }
  }
  close() { this.db.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  #row(table: "jobs" | "destinations" | "deliveries", id: string): Row {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Row | undefined;
    if (!row) fail("not_found", `${table.slice(0, -1)} was not found.`, 404);
    return row;
  }
  createDestination(value: DestinationInput): DestinationRecord {
    const input = validateDestination(value);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM destinations WHERE id=?").get(input.id) as Row | undefined;
      if (existing) {
        if (canonical(JSON.parse(existing.document)) !== canonical(input)) fail("idempotency_conflict", "Destination ID is already registered with different content.", 409);
        return this.#destination(existing);
      }
      this.db.prepare("INSERT INTO destinations(id,kind,document,created_at) VALUES(?,?,?,?)").run(input.id, input.kind, JSON.stringify(input), this.now());
      this.putNote({ schemaVersion: 1, resourceId: `destination:${input.id}`, kind: "destination", ...input.note });
      return this.getDestination(input.id);
    });
  }
  #destination(row: Row): DestinationRecord {
    const input = JSON.parse(row.document) as DestinationInput;
    const note = this.getNote(`destination:${input.id}`);
    return { ...input, note: fields(note), createdAt: iso(row.created_at), binding: row.binding_until > this.now() ? { ownerId: row.binding_owner, expiresAt: iso(row.binding_until) } : null };
  }
  getDestination(id: string) { return this.#destination(this.#row("destinations", id)); }
  createJob(value: JobInput): JobAcceptance {
    const input = validateJob(value);
    return this.transaction(() => {
      const digest = hash(canonical(input));
      const existing = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(input.id) as Row | undefined;
      if (existing) {
        if (existing.hash !== digest) fail("idempotency_conflict", "Job ID is already registered with different content. Use a new ID for changed work.", 409);
        return { schemaVersion: 1, accepted: true, duplicate: true, job: this.#job(existing), guidance: ACCEPTANCE_GUIDANCE };
      }
      const destination = this.#row("destinations", input.destinationId);
      if (destination.kind === "pi" && !input.piTask) fail("missing_pi_task", "A Pi destination requires the complete typed piTask contract.");
      if (destination.kind !== "pi" && input.piTask) fail("unexpected_pi_task", "piTask is only supported at a Pi destination.");
      const now = this.now();
      const expiresAt = expiry(input);
      if (expiresAt !== null && expiresAt <= now) fail("already_expired", "The job validity has already expired.");
      const next = input.trigger.kind === "once" ? Date.parse(input.trigger.at) : input.trigger.kind === "cron" ? nextCron(input.trigger, input.trigger.startAt ? Date.parse(input.trigger.startAt) - 1 : now) : null;
      if (next !== null && expiresAt !== null && next >= expiresAt) fail("invalid_validity", "Job expiry must be later than its first scheduled occurrence.");
      this.db.prepare("INSERT INTO jobs(id,destination_id,hash,document,state,accepted_at,next_run_at,expires_at) VALUES(?,?,?,?,'active',?,?,?)")
        .run(input.id, input.destinationId, digest, JSON.stringify(input), now, next, expiresAt);
      this.putNote({ schemaVersion: 1, resourceId: `job:${input.id}`, kind: "job", ...input.note });
      return { schemaVersion: 1, accepted: true, duplicate: false, job: this.getJob(input.id), guidance: ACCEPTANCE_GUIDANCE };
    });
  }
  #job(row: Row): JobRecord {
    const input = JSON.parse(row.document) as JobInput;
    return { ...input, note: fields(this.getNote(`job:${input.id}`)), state: row.state, acceptedAt: iso(row.accepted_at), nextRunAt: row.next_run_at === null ? null : iso(row.next_run_at), lastRunAt: row.last_run_at === null ? null : iso(row.last_run_at), skippedRuns: row.skipped_runs };
  }
  getJob(id: string) { return this.#job(this.#row("jobs", id)); }
  controlJob(id: string, action: "pause" | "resume" | "cancel"): JobRecord {
    if (!["pause", "resume", "cancel"].includes(action)) fail("invalid_action", "Use pause, resume, or cancel.");
    return this.transaction(() => {
      const row = this.#row("jobs", id);
      if (action === "cancel") {
        this.db.prepare("UPDATE jobs SET state='cancelled',next_run_at=NULL WHERE id=?").run(id);
        this.db.prepare(`UPDATE deliveries SET state='cancelled',lease_until=NULL WHERE job_id=? AND state IN ${pendingStates}`).run(id);
      } else {
        if (!["active", "paused", "finished"].includes(row.state)) fail("terminal_job", "An expired or cancelled job cannot be paused or resumed.", 409);
        const job = JSON.parse(row.document) as JobInput;
        const resumed = job.trigger.kind === "once" && row.next_run_at === null ? "finished" : "active";
        this.db.prepare("UPDATE jobs SET state=? WHERE id=?").run(action === "pause" ? "paused" : resumed, id);
      }
      return this.getJob(id);
    });
  }
  publishEvent(value: EventInput): EventAcceptance {
    const input = validateEvent(value);
    return this.transaction(() => {
      const digest = hash(canonical(input));
      const prior = this.db.prepare("SELECT * FROM events WHERE source=? AND id=?").get(input.source, input.id) as Row | undefined;
      const key = `event:${canonical([input.source, input.id])}`;
      if (prior) {
        if (prior.hash !== digest) fail("idempotency_conflict", "Event source and ID already identify different content.", 409);
        return { schemaVersion: 1, accepted: true, duplicate: true, event: JSON.parse(prior.document), deliveryIds: this.#eventDeliveryIds(key) };
      }
      const now = this.now();
      const event: EventRecord = { ...input, acceptedAt: iso(now) };
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(input.source, input.id, digest, JSON.stringify(event), now);
      const jobs = this.db.prepare("SELECT * FROM jobs WHERE state='active' AND (expires_at IS NULL OR expires_at>?)").all(now) as Row[];
      for (const row of jobs) {
        const job = JSON.parse(row.document) as JobInput;
        const t = job.trigger;
        if (t.kind === "event" && t.source === input.source && t.types.includes(input.type) && (t.subject === undefined || t.subject === input.subject)) {
          this.#enqueue(row, key, { kind: "event", event }, now);
          this.db.prepare("UPDATE jobs SET last_run_at=? WHERE id=?").run(now, row.id);
        }
      }
      return { schemaVersion: 1, accepted: true, duplicate: false, event, deliveryIds: this.#eventDeliveryIds(key) };
    });
  }
  #eventDeliveryIds(key: string): string[] { return (this.db.prepare("SELECT id FROM deliveries WHERE dedupe_key=? ORDER BY id").all(key) as Row[]).map(row => row.id); }
  #enqueue(row: Row, key: string, input: DeliveryInput, now: number) {
    this.db.prepare("INSERT OR IGNORE INTO deliveries(id,job_id,destination_id,dedupe_key,input,state,accepted_at,expires_at,available_at) VALUES(?,?,?,?,?,'accepted',?,?,?)")
      .run(randomUUID(), row.id, row.destination_id, key, JSON.stringify(input), now, row.expires_at, now);
  }
  /** A bounded scheduler pass. No occurrence-by-occurrence replay after downtime. */
  tick() {
    this.transaction(() => {
      const now = this.now();
      this.db.prepare("UPDATE jobs SET state='expired',next_run_at=NULL WHERE state IN ('active','paused','finished') AND expires_at<=?").run(now);
      this.db.prepare(`UPDATE deliveries SET state='expired',lease_until=NULL WHERE state IN ${pendingStates} AND expires_at<=?`).run(now);
      this.db.prepare("UPDATE destinations SET binding_owner=NULL,binding_hash=NULL,binding_until=NULL WHERE binding_until<=?").run(now);
      const stale = this.db.prepare("SELECT d.* FROM deliveries d LEFT JOIN destinations t ON t.id=d.destination_id WHERE d.state IN ('leased','delivered') AND (d.lease_until<=? OR t.binding_hash IS NULL OR d.lease_binding_hash<>t.binding_hash)").all(now) as Row[];
      for (const row of stale) this.#retry(row, "lease_expired_or_owner_released", now);
      const due = this.db.prepare("SELECT * FROM jobs WHERE state='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT 100").all(now) as Row[];
      for (const row of due) {
        const job = JSON.parse(row.document) as JobInput;
        const missed = now - row.next_run_at > (job.graceMs ?? 60_000);
        const skip = missed && job.missedRun === "skip";
        if (!skip) this.#enqueue(row, `timer:${row.next_run_at}`, { kind: "timer", scheduledFor: iso(row.next_run_at), observedAt: iso(now), missed }, now);
        let next: number | null = null;
        if (job.trigger.kind === "cron") next = nextCron(job.trigger, now);
        this.db.prepare("UPDATE jobs SET next_run_at=?,last_run_at=?,skipped_runs=skipped_runs+?,state=? WHERE id=?")
          .run(next, skip ? row.last_run_at : row.next_run_at, skip ? 1 : 0, next === null ? "finished" : "active", row.id);
      }
    });
  }
  bind(id: string, value: BindInput): Binding {
    const input = validateLease(value, "bind") as BindInput;
    return this.transaction(() => {
      const row = this.#row("destinations", id); const now = this.now();
      if (row.binding_until > now) fail("destination_busy", "Destination has a current owner. Renew with its binding token or wait for expiry.", 409);
      const secret = token(); const until = now + (input.ttlMs ?? 60_000);
      this.db.prepare("UPDATE destinations SET binding_owner=?,binding_hash=?,binding_until=? WHERE id=?").run(input.ownerId, hash(secret), until, id);
      return { schemaVersion: 1, destinationId: id, ownerId: input.ownerId, bindingToken: secret, expiresAt: iso(until) };
    });
  }
  #binding(id: string, input: BindingInput): Row {
    const row = this.#row("destinations", id);
    if (row.binding_owner !== input.ownerId || row.binding_hash !== hash(input.bindingToken) || row.binding_until <= this.now()) fail("binding_lost", "Destination binding is expired or belongs to another owner. Do not continue work under the old binding.", 409);
    return row;
  }
  renewBinding(id: string, value: BindingInput): Binding {
    const input = validateLease(value, "binding") as BindingInput;
    return this.transaction(() => {
      this.#binding(id, input); const until = this.now() + (input.ttlMs ?? 60_000);
      this.db.prepare("UPDATE destinations SET binding_until=? WHERE id=?").run(until, id);
      return { schemaVersion: 1, destinationId: id, ownerId: input.ownerId, bindingToken: input.bindingToken, expiresAt: iso(until) };
    });
  }
  releaseBinding(id: string, value: BindingInput) {
    const input = validateLease(value, "binding") as BindingInput;
    this.transaction(() => {
      this.#binding(id, input);
      this.db.prepare("UPDATE destinations SET binding_owner=NULL,binding_hash=NULL,binding_until=NULL WHERE id=?").run(id);
      const rows = this.db.prepare("SELECT * FROM deliveries WHERE destination_id=? AND state IN ('leased','delivered')").all(id) as Row[];
      for (const row of rows) this.#retry(row, "owner_released", this.now());
    });
    return { schemaVersion: 1 as const, released: true as const };
  }
  claim(id: string, value: ClaimInput): ClaimedDelivery | null {
    const input = validateLease(value, "claim") as ClaimInput;
    this.tick();
    return this.transaction(() => {
      const binding = this.#binding(id, input); const now = this.now();
      const row = this.db.prepare("SELECT d.* FROM deliveries d JOIN jobs j ON j.id=d.job_id WHERE d.destination_id=? AND d.state='accepted' AND d.available_at<=? AND j.state IN ('active','finished') ORDER BY d.accepted_at,d.id LIMIT 1").get(id, now) as Row | undefined;
      if (!row) return null;
      const secret = token(); const until = Math.min(now + (input.leaseMs ?? 60_000), binding.binding_until, row.expires_at ?? Infinity);
      this.db.prepare("UPDATE deliveries SET state='leased',attempts=attempts+1,lease_owner=?,lease_hash=?,lease_binding_hash=?,lease_until=? WHERE id=?")
        .run(input.ownerId, hash(secret), binding.binding_hash, until, row.id);
      return { ...this.getDelivery(row.id), leaseToken: secret };
    });
  }
  #lease(id: string, input: LeaseInput): Row {
    const row = this.#row("deliveries", id);
    const binding = this.#binding(row.destination_id, input);
    if (row.lease_owner !== input.ownerId || row.lease_hash !== hash(input.leaseToken) || row.lease_binding_hash !== binding.binding_hash || row.lease_until <= this.now() || !["leased", "delivered"].includes(row.state) || (row.expires_at !== null && row.expires_at <= this.now())) {
      fail("lease_lost", "Delivery lease is expired, terminal, or belongs to another owner. Inspect the delivery before taking any further action.", 409);
    }
    return row;
  }
  renew(id: string, value: LeaseInput): ClaimedDelivery {
    const input = validateLease(value, "lease") as LeaseInput;
    return this.transaction(() => {
      const row = this.#lease(id, input); const binding = this.#row("destinations", row.destination_id);
      const until = Math.min(this.now() + (input.leaseMs ?? 60_000), binding.binding_until, row.expires_at ?? Infinity);
      this.db.prepare("UPDATE deliveries SET lease_until=? WHERE id=?").run(until, id);
      return { ...this.getDelivery(id), leaseToken: input.leaseToken };
    });
  }
  ack(id: string, value: AckInput): DeliveryRecord {
    const input = validateLease(value, "ack") as AckInput;
    return this.transaction(() => {
      const row = this.#lease(id, input); const now = this.now();
      if (input.outcome === "delivered") {
        this.db.prepare("UPDATE deliveries SET state='delivered',delivered_at=COALESCE(delivered_at,?) WHERE id=?").run(now, id);
      } else if (input.outcome === "completed") {
        this.db.prepare("UPDATE deliveries SET state='completed',delivered_at=COALESCE(delivered_at,?),completed_at=?,result=?,lease_until=NULL WHERE id=?")
          .run(now, now, input.result === undefined ? null : JSON.stringify(input.result), id);
      } else if (input.outcome === "failed") {
        this.db.prepare("UPDATE deliveries SET state='dead',last_error=?,result=?,lease_until=NULL WHERE id=?")
          .run(input.error ?? "consumer_reported_failure", input.result === undefined ? null : JSON.stringify(input.result), id);
      } else this.#retry(row, input.error ?? "consumer_requested_retry", now, input.retryAfterMs);
      return this.getDelivery(id);
    });
  }
  #retry(row: Row, error: string, now: number, requestedDelay?: number) {
    const job = JSON.parse(this.#row("jobs", row.job_id).document) as JobInput;
    const policy = job.retry ?? defaultRetry;
    const delay = Math.min(policy.maxDelayMs, Math.max(requestedDelay ?? 0, policy.initialDelayMs * 2 ** Math.max(0, row.attempts - 1)));
    const state = row.attempts >= policy.maxAttempts ? "dead" : "accepted";
    this.db.prepare("UPDATE deliveries SET state=?,available_at=?,lease_owner=NULL,lease_hash=NULL,lease_binding_hash=NULL,lease_until=NULL,last_error=? WHERE id=?")
      .run(state, now + delay, error, row.id);
  }
  #delivery(row: Row): DeliveryRecord {
    const job = JSON.parse(this.#row("jobs", row.job_id).document) as JobInput;
    return {
      schemaVersion: 1, id: row.id, jobId: row.job_id, destinationId: row.destination_id, state: row.state,
      input: JSON.parse(row.input), ...(job.piTask ? { piTask: job.piTask } : {}), acceptedAt: iso(row.accepted_at),
      deliveredAt: row.delivered_at === null ? null : iso(row.delivered_at), completedAt: row.completed_at === null ? null : iso(row.completed_at),
      expiresAt: row.expires_at === null ? null : iso(row.expires_at), availableAt: iso(row.available_at), attempts: row.attempts,
      leaseOwner: row.lease_owner, leaseUntil: row.lease_until === null ? null : iso(row.lease_until),
      result: row.result === null ? null : JSON.parse(row.result), lastError: row.last_error,
    };
  }
  getDelivery(id: string) { return this.#delivery(this.#row("deliveries", id)); }
  putNote(value: ResourceNote): ResourceNote {
    const note = validateNote(value);
    let destinationId: string | null = null;
    if (note.kind === "job") destinationId = this.#row("jobs", note.resourceId.slice(4)).destination_id;
    if (note.kind === "destination") destinationId = this.#row("destinations", note.resourceId.slice(12)).id;
    this.db.prepare("INSERT INTO notes VALUES(?,?,?) ON CONFLICT(resource_id) DO UPDATE SET document=excluded.document").run(note.resourceId, destinationId, JSON.stringify(note));
    return note;
  }
  getNote(resourceId: string): ResourceNote {
    const row = this.db.prepare("SELECT document FROM notes WHERE resource_id=?").get(resourceId) as Row | undefined;
    if (!row) fail("not_found", "Resource note was not found.", 404);
    return JSON.parse(row.document);
  }
  list(kind: "destinations", options?: ListOptions, allowedDestinations?: string[]): Page<DestinationRecord>;
  list(kind: "jobs", options?: ListOptions, allowedDestinations?: string[]): Page<JobRecord>;
  list(kind: "deliveries", options?: ListOptions, allowedDestinations?: string[]): Page<DeliveryRecord>;
  list(kind: "notes", options?: ListOptions, allowedDestinations?: string[]): Page<ResourceNote>;
  list(kind: "destinations" | "jobs" | "deliveries" | "notes", options: ListOptions = {}, allowedDestinations?: string[]): Page<any> {
    const limit = options.limit ?? 50; const offset = options.offset ?? 0;
    const conditions: string[] = []; const values: (string | number)[] = [];
    const destinationColumn = kind === "destinations" ? "id" : "destination_id";
    if (kind === "notes" && allowedDestinations) conditions.push("destination_id IS NOT NULL");
    if (allowedDestinations && !allowedDestinations.includes("*")) {
      conditions.push(`${destinationColumn} IN (${allowedDestinations.map(() => "?").join(",") || "NULL"})`);
      values.push(...allowedDestinations);
    }
    if (options.destinationId) { conditions.push(`${destinationColumn}=?`); values.push(options.destinationId); }
    if (options.jobId && kind === "deliveries") { conditions.push("job_id=?"); values.push(options.jobId); }
    const order = kind === "notes" ? "resource_id" : "id";
    const rows = this.db.prepare(`SELECT * FROM ${kind}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, limit + 1, offset) as Row[];
    const items = rows.slice(0, limit).map(row => kind === "destinations" ? this.#destination(row) : kind === "jobs" ? this.#job(row) : kind === "deliveries" ? this.#delivery(row) : JSON.parse(row.document));
    return { schemaVersion: 1, items, nextOffset: rows.length > limit ? offset + limit : null };
  }
}
function expiry(input: JobInput): number | null {
  const candidates = [input.expiresAt, input.piTask?.validity.expiresAt].filter((v): v is string => !!v).map(Date.parse);
  return candidates.length ? Math.min(...candidates) : null;
}
function fields(note: ResourceNote): NoteFields { return { purpose: note.purpose, owner: note.owner, references: note.references, repairContext: note.repairContext }; }
