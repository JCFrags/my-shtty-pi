# Pi-Notify contract v1

The standalone service accepts events and schedules deliveries without Pi, a model, shell commands, or evaluation of payloads. All JSON inputs and responses use `schemaVersion: 1`. `src/contracts.ts` is the shared TypeScript contract. `src/client.ts` supplies `NotifyClient` for external publishers and consumers.

## Boundaries

- A source publishes `EventInput` through `POST /v1/events`. `(source, id)` is the idempotency key. Reuse with different content returns `409 idempotency_conflict`.
- A stable destination has `kind: "pull"` or `kind: "pi"`. Destination IDs never mean a PID, terminal pane, or the newest session.
- `JobInput` has a stable `id`, `destinationId`, `trigger`, and resource note. Triggers are `once`, timezone-aware six-field `cron`, or an exact `event` subscription. Jobs are immutable except pause, resume, and cancellation.
- Only a Pi destination requires `piTask`. The typed task contains name, purpose, targetId, matching trigger, onWake instructions, context, authority/limits, completion criteria, result destination, and validity/stop conditions. Event data stays in `delivery.input`, separate from the approved `piTask`.
- `piTask.resultDestination` is `{kind: "delivery-result"}` in v1. Successful completion and explicit failure store the consumer's result on that delivery. No second destination is forwarded or claimed as delivered.
- Acceptance means a committed SQLite record. Delivery means a consumer acknowledged receipt. Completion means that consumer explicitly reported completion. This is bounded at-least-once delivery, not exactly-once execution. Consumers must keep their own durable execution deduplication.

## HTTP interface

All routes require `Authorization: Bearer <token>`. Tokens come from protected files outside the database and repository. TCP binds only loopback. Use an SSH forward for another host. An optional `unixSocket: {path, mode, groupId?}` listener supports local container publishers through the same authenticated routes. `path` is an exact absolute path in an owned, non-group/world-writable directory. Mode is decimal 384 (0600) or 432 (0660). Mode 0660 requires an explicit groupId. The service refuses every pre-existing socket path instead of removing it.

| Method and route | Request | Response |
| --- | --- | --- |
| GET `/v1/health` | none | `HealthResponse` |
| POST `/v1/events` | `EventInput` | `EventAcceptance` (202) |
| POST `/v1/destinations` | `DestinationInput` | `DestinationRecord` (201) |
| GET `/v1/destinations[/:id]` | none | `Page<DestinationRecord>` or record |
| POST `/v1/jobs` | `JobInput` | `JobAcceptance` (202) |
| GET `/v1/jobs[/:id]` | none | `Page<JobRecord>` or record |
| POST `/v1/jobs/:id/control` | `{schemaVersion, action: "pause" \| "resume" \| "cancel"}` | `JobRecord` |
| POST `/v1/destinations/:id/bind` | `BindInput` | `Binding` |
| POST `/v1/destinations/:id/renew-binding` | `BindingInput` | `Binding` |
| POST `/v1/destinations/:id/release-binding` | `BindingInput` | `{schemaVersion, released: true}` |
| POST `/v1/destinations/:id/claim` | `ClaimInput` | `ClaimResponse` (delivery or null) |
| POST `/v1/deliveries/:id/renew` | `LeaseInput` | `ClaimedDelivery` |
| POST `/v1/deliveries/:id/ack` | `AckInput` | `DeliveryRecord` |
| GET `/v1/deliveries[/:id]` | optional `jobId`, `destinationId` | `Page<DeliveryRecord>` or record |
| PUT `/v1/notes/:resourceId` | `ResourceNote` | stored note |
| GET `/v1/notes[/:resourceId]` | none | `Page<ResourceNote>` or note |

Lists accept `limit` (1–100) and `offset` (default 0), and return `nextOffset`. Encode each ID as a URL component. Error bodies are `{schemaVersion: 1, error: {code, message}}`. No token or payload is included in server error logs.

## Consumer sequence

1. Bind the exact destination with a unique process `ownerId`. An unexpired binding cannot be taken over. Keep the returned `bindingToken` private.
2. Call `claim` with that binding. `waitMs` is 0–25,000 for model-free long polling. The service returns at most one delivery with `leaseToken` and `leaseUntil`.
3. Renew the binding and delivery lease while work is active. Both default to 60 seconds and allow 1–300 seconds. Lost ownership returns `409 lease_lost` or `409 binding_lost`.
4. Acknowledge `delivered` after the consumer durably records receipt. Report `completed` with a result only after the work completes. Report `retry` for a recoverable failure or `failed` for a terminal failure.
5. Release the binding on shutdown. Lease expiry or release permits retry, subject to bounded attempts, delay, cancellation, and expiry. A delivered record can be redelivered after a crash before completion.

A Pi scheduling tool returns the durable acceptance ID and tells the agent: "Accepted durably. Do not poll, sleep, or wait. End this turn; the receiver will wake the destination later." An unavailable service is not acceptance. The receiver is responsible for exact current logical-session ownership and must not open a competing process for a saved session.

## Scheduling and retention

Cron uses an explicit IANA timezone and six fields including seconds. Random `H` expressions are rejected. DST behavior is the pinned `cron-parser` behavior. `missedRun: "fire-once"` coalesces all overdue runs into one delivery. `"skip"` omits runs later than `graceMs` and advances to the next future run. No unbounded catch-up occurs. Paused jobs do not emit or offer queued deliveries. Resume applies the same missed-run policy. Paused event subscriptions ignore events accepted while paused. Cancellation and expiry invalidate pending deliveries but cannot undo work already started by a consumer.

Events match subscriptions atomically at acceptance. There is no retroactive subscription replay. Matching uses exact source/type/optional subject, not code or payload expressions. Immutable events remain stored for deduplication. Jobs and terminal deliveries remain inspectable. A producer without admin scope receives an empty `deliveryIds` list rather than learning other destinations' routing. There is no automatic deletion in v1.

Resource notes use stable `service:`, `job:`, `destination:`, or `resource:` identities. They record purpose, owner, references, and repair context. Notes are inspectable data, not authority to run commands. Runtime process metadata uses a random instance ID and start time. A displayed PID is observational only and must never be used as proof of process identity.
