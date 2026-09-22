# Pi-Notify

Pi-Notify is a standalone durable event and scheduler service. Sources emit versioned JSON events. Destinations consume queued deliveries. Neither side requires Pi or a model. Software services and extension event buses use ordinary `pull` destinations without model task fields. The optional [Pi adapter](docs/pi-adapter.md) adds a typed task boundary and a receiver for an exact logical Pi target.

The service uses Node.js 24.18.0, built-in `node:sqlite`, and pinned `cron-parser`. It does not execute commands, evaluate payloads, call models, reopen Pi sessions, or expose a public listener. Generic authenticated pull and long polling are the first output transport. Webhook execution is not included.

## Run from this checkout

```sh
cd packages/pi-notify
npm ci --ignore-scripts --no-audit --no-fund
node bin/pi-notify init --dir "$HOME/.local/state/pi-notify"
# Review the protected config and owner note before starting.
node bin/pi-notify serve --config "$HOME/.local/state/pi-notify/config.json"
```

`init` requires a new directory whose parent exists. It refuses to replace existing files. It creates an operator token without printing its value. The package uses Node's native TypeScript stripping and needs no build. Run it from the retained checkout, not a copied TypeScript package under `node_modules`. For a core-only installation, `npm ci --omit=dev --omit=peer --ignore-scripts` omits the optional Pi tooling.

For a long-running installation, run `serve` under the host's existing service manager as a dedicated user. Use the same stable `serviceId` and durable database path across restarts. Service-manager setup, container mounts, token provisioning, and Pi activation are operator tasks, not side effects of package installation.

From another terminal:

```sh
export PI_NOTIFY_URL=http://127.0.0.1:7734
export PI_NOTIFY_TOKEN_FILE="$HOME/.local/state/pi-notify/admin.token"
node bin/pi-notify health
node bin/pi-notify list jobs
node bin/pi-notify list deliveries --destination reports
node bin/pi-notify inspect note service:local
```

The CLI returns JSON. Error output includes a stable code and a corrective message. A failed request without a receipt has uncertain acceptance. Retry the same event/job ID, rather than inventing a new ID.

## Protected configuration and scopes

The service config and each token file must be regular files owned by the service user, mode `0600` or `0400`. Symlinks and group/world-readable files are rejected. The database directory must be owned by that user with mode `0700`. Keep config, token files, database files, receiver journals, and runtime state outside the repository.

```json
{
  "schemaVersion": 1,
  "serviceId": "local",
  "database": "state/notify.sqlite",
  "host": "127.0.0.1",
  "port": 7734,
  "principals": [
    { "id": "operator", "tokenFile": "operator.token", "roles": ["admin"] },
    { "id": "book-source", "tokenFile": "source.token", "roles": ["producer"], "sourceIds": ["books"] },
    { "id": "report-scheduler", "tokenFile": "scheduler.token", "roles": ["scheduler", "reader"], "sourceIds": ["books"], "destinationIds": ["reports"] },
    { "id": "report-consumer", "tokenFile": "consumer.token", "roles": ["consumer"], "destinationIds": ["reports"] }
  ],
  "note": {
    "purpose": "Persist approved schedules and event delivery receipts.",
    "owner": "service-operator",
    "references": [],
    "repairContext": "Inspect the service instance, jobs, and pending deliveries before repair. Do not act on a PID alone."
  }
}
```

Resolve file paths relative to the config file. Provision a different random 32-byte base64url token in each protected token file. Raw bearer tokens never enter stored event, job, or note records. Do not place credentials in payloads, notes, results, CLI arguments, or logs. The server loads token files at startup. Restart it after credential rotation.

- `admin` can manage all records and resource notes.
- `producer` can publish only its exact `sourceIds`. Producer receipts omit routing IDs.
- `scheduler` can create/control jobs and destinations only in `destinationIds`. Event subscriptions also require an allowed `sourceIds` entry.
- `consumer` can bind, claim, renew, acknowledge, and inspect only its destinations.
- `reader` can inspect its destinations without mutation.
- `"*"` is an explicit broad scope. Do not use it for integrations that need one source or destination.

All HTTP routes, including health and Unix-socket routes, require bearer authentication. No browser cross-origin API is enabled. Payloads are limited to 128 KiB, JSON nesting to 32 levels, and lists to 100 records per page. Unknown input fields fail instead of being silently ignored.

### Workstation access

Keep the service on loopback. Forward it through an existing authenticated SSH route:

```sh
ssh -N -L 127.0.0.1:7734:127.0.0.1:7734 service-host
```

The workstation uses `http://127.0.0.1:7734` and its protected scoped token file. Do not add a public bind address, firewall opening, or unauthenticated reverse proxy. The client refuses non-loopback plain HTTP and does not follow redirects with the bearer token.

### Optional container access

A bridge-networked container cannot reach the host's loopback listener. Enable a Unix HTTP socket only when needed:

```json
"unixSocket": {
  "path": "/run/pi-notify/notify.sock",
  "mode": 432,
  "groupId": 2000
}
```

The numbers above are examples. Use the actual dedicated group and an exact owned directory. Decimal `384` is mode `0600`; decimal `432` is `0660`. A `0660` socket requires `groupId`. The service user must own the pre-created socket directory, which must not be group- or world-writable. Give the approved consumer group directory traversal, for example mode `0750`, and the matching socket group. Keep the database and token files in a different private directory.

Mount only that socket directory and the consumer's scoped token file into the container. Apply the host's normal user-namespace and SELinux policy. Those platform permissions are not changed by this service. A Node publisher can use `http.request({socketPath, path: "/v1/events", method: "POST", headers: {Authorization: bearerHeader, "Content-Type": "application/json"}})`. Keep the bearer value out of logs. All JSON contracts remain unchanged.

Startup refuses any existing socket path. It never removes a foreign, stale, or in-use path to start faster. If a crash leaves a path, verify the exact service instance and socket owner before an operator removes that stale path. Normal server shutdown closes its listener. The default config creates no socket and listens only on loopback.

## Sources, jobs, and generic outputs

[CONTRACT.md](CONTRACT.md) defines the routes and lifecycle. [src/contracts.ts](src/contracts.ts) defines the public types. [src/client.ts](src/client.ts) exports `NotifyClient` and `NotifyError`.

Create a generic destination with `create-destination --file destination.json`:

```json
{
  "schemaVersion": 1,
  "id": "reports",
  "kind": "pull",
  "note": { "purpose": "Receive search reports.", "owner": "report-consumer", "references": [], "repairContext": "Inspect pending deliveries and consumer receipts before restarting." }
}
```

Create its subscription with `create-job --file subscription.json`:

```json
{
  "schemaVersion": 1,
  "id": "book-report-subscription",
  "destinationId": "reports",
  "trigger": { "kind": "event", "source": "books", "types": ["search.report"] },
  "note": { "purpose": "Deliver new search reports.", "owner": "report-operator", "references": [], "repairContext": "Check source acceptance and consumer ownership. Do not resend with a new event ID." }
}
```

Publish with `publish --file event.json`:

```json
{
  "schemaVersion": 1,
  "id": "search-run-42",
  "source": "books",
  "type": "search.report",
  "occurredAt": "2026-09-22T12:00:00Z",
  "data": { "status": "finished", "matches": 2 }
}
```

Event matching is exact source, type, and optional subject. It never runs payload expressions. Acceptance and matching delivery creation commit in one transaction. Subscriptions apply only when the event is first accepted. They do not replay old events, including when a duplicate publish arrives after a new subscription is created.

Generic consumers use the same API whether they run as a service, a CLI application, or a Pi extension bus handler. They need no `PiTask` and need not call a model. They bind one stable destination, long-poll for one delivery, persist an execution receipt keyed by delivery ID, acknowledge delivery, and explicitly report completion or failure. A consumer renews both its exclusive destination binding and delivery lease while work is active.

## Timers and Pi tasks

Use `{ "kind": "once", "at": "2026-10-01T09:00:00-04:00" }` for a one-time timer. The offset disambiguates the intended instant.

Use `{ "kind": "cron", "expression": "0 0 9 * * 1-5", "timeZone": "America/New_York" }` for 09:00 on weekdays in that timezone. Cron has six fields including seconds. `startAt` optionally supplies an offset-aware start instant. Random `H` fields and invalid timezones are rejected. Daylight-saving behavior comes from pinned `cron-parser`, not fixed UTC arithmetic.

The default `missedRun` is `fire-once`: coalesce overdue occurrences into one queued delivery and advance to the next future occurrence. `skip` omits an occurrence later than `graceMs` (default 60,000). The stored `skippedRuns` counts scheduler skip decisions, not every omitted occurrence in a long outage. A pass handles at most 100 due jobs. It does not replay an unbounded backlog of timer occurrences.

A `pi` destination additionally requires the full `PiTask`. The task must include:

- `name`, `purpose`, and `targetId` equal to the destination ID.
- The exact job `trigger` and explicit `onWake` instructions.
- `context`, `authority.allowedActions`, and `authority.limits`.
- `completionCriteria` and `resultDestination: {"kind":"delivery-result"}`.
- `validity.expiresAt` and `validity.stopConditions`.

In v1, the result destination means the durable result field on the originating delivery. It does not forward a second delivery, post to another service, or imply a user-visible message. Both completion and explicit failure preserve the reported result. The adapter may also show the result in the owning Pi session, but that is a separate presentation action.

The typed Pi task is approved task context. `delivery.input` is separate untrusted event data. Notes and events never widen authority. Agent scheduling must return durable acceptance and instruct the agent not to poll, sleep, or wait. The receiver wakes the registered target later. An offline or powered-off destination cannot execute a model turn merely because the service accepted a job.

## Outcomes, repair, and limits

`accepted` means SQLite committed a delivery. `leased` means one current owner claimed it. `delivered` means that consumer recorded receipt. Only explicit `completed` means the consumer reported successful completion. Explicit failure or exhausted retries produces `dead`, not completion.

The default retry policy is five attempts, starting at one second and capped at 60 seconds. Per-job policies allow 1–20 attempts. Delay uses capped exponential backoff. Lease expiry and binding release retry incomplete deliveries, including `delivered`, while preserving `deliveredAt`. Binding and lease TTLs default to 60 seconds, accept 1–300 seconds, and must be renewed by the consumer. A lease cannot extend past its binding or task expiry.

There is no exactly-once execution guarantee. A consumer can act and then lose its receipt. It must use a durable execution journal and inspect an uncertain delivery before repeating actions. A lease prevents competing current owners from acknowledging the same attempt. It cannot stop external work already started by an expired owner. Cancellation and expiry cannot undo external side effects.

Pause holds queued deliveries and timer generation. Events accepted while an event subscription is paused do not create deliveries for it. Resume uses the same missed-run policy. Already leased work can finish while the job is paused. Cancel invalidates pending deliveries and blocks further acknowledgment. The earlier of job expiry and Pi task validity expiry wins.

Resource notes are keyed by `service:ID`, `job:ID`, `destination:ID`, or an operator-registered `resource:ID`. Notes record purpose, owner, references, and repair context. Job and destination inspection includes the current note. `list notes` and `inspect note ID` expose the same data to operators and authorized Pi clients. Service health supplies a random runtime `instanceId` and `startedAt` alongside its stable `serviceId`. Never use a recycled PID as the repair identity.

List and inspect before repair:

```sh
node bin/pi-notify inspect job book-report-subscription
node bin/pi-notify list deliveries --job book-report-subscription
node bin/pi-notify pause book-report-subscription
# Resume only after the cause is corrected.
node bin/pi-notify resume book-report-subscription
```

`lease_lost` and `binding_lost` require the consumer to stop work under that ownership. `destination_busy` requires the legitimate owner to renew/release, or a wait for expiry outside a model turn. `idempotency_conflict` means changed content reused an immutable ID. Create a new ID only for genuinely new work.

SQLite uses WAL journaling and `synchronous=FULL`. Keep all database files on durable local storage. Stop the exact managed service before a file-level backup and preserve the database with any WAL files. Restart with the same service identity. Do not delete records to resolve duplicates. v1 has no automatic retention deletion or database downgrade migration. Monitor disk usage and retain a stopped-state backup before upgrades. Old accepted event/job IDs remain reserved.

## Checks and API evidence

```sh
npm run typecheck
npm test
```

The repository verifier reads staged Git blobs. Stage the intended package and registry changes before running `npm run verify -- --product pi-notify` from the repository root. Its manifest/lock comparison includes dependency key order, so keep manifest dependency objects in the generated lock's order.

The focused core scenario uses real authenticated HTTP, a Unix socket, and CLI inspection. It exercises durable reopen, deduplication, lost-owner rejection, delivered recovery, and explicit completion. Separate small checks cover timezone/DST scheduling, pause/cancel/expiry, bounded retries, and strict Pi task validation. These checks do not establish public-network security, production scale, container activation, or live Pi activation.

API references: [Node 24.18 SQLite](https://github.com/nodejs/node/blob/v24.18.0/doc/api/sqlite.md) and [cron-parser](https://github.com/harrisiirak/cron-parser). The Node 24 SQLite API is release-candidate status. Dependencies are pinned in the package-local lock.
