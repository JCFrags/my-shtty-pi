# Pi adapter

Pi-Notify's service stores and schedules work without a model. This optional adapter delivers that work into one explicitly registered, saved Pi context. It supports Pi 0.85.1 and Node 24.18 or later in the Node 24 line.

## Install the adapter

Use the full retained checkout described in
[installation](../../../docs/installation.md). Set `REPO` to its absolute path.
Prepare runtime dependencies from the package-local lock in a new checkout, then
register the source-loaded adapter once:

```sh
npm ci --prefix "$REPO/packages/pi-notify" --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
pi install "$REPO/packages/pi-notify"
```

This runtime-only preparation installs `cron-parser` and its `luxon` dependency.
The installed Pi loader supplies coding-agent and TypeBox imports. No build is
needed. Local registration does not copy source, install dependencies, start the
service, provision tokens, or bind a destination. Keep the package's source,
extension, and dependency directories intact.

The adapter manifest declares Pi `>=0.85.1 <0.86.0`. Loading on a newer Pi host does
not widen that compatibility range or establish receipt, binding, and wake behavior.
Verify those operations on the intended host. Do not install another Pi runtime or
change the peer range to hide an unverified compatibility limit.

Prepare the service and protected consumer credential separately using the
[service instructions](../README.md#run-from-this-checkout). Keep queued work,
receiver journals, logical-session data, and credentials outside the checkout. A
code update must preserve their paths and identity. Do not initialize over an
existing service or open another receiver on the same saved session.

## Configuration and explicit registration

The extension factory registers tools, commands, and event-bus handlers only. It does not read credentials, create state, open sockets, or start timers. Configuration is read at `session_start`.

Create an owner-only JSON file at the Pi agent directory's `pi-notify.json`, or set `PI_NOTIFY_PI_CONFIG` to its absolute path:

```json
{
  "schemaVersion": 1,
  "baseUrl": "http://127.0.0.1:7734",
  "tokenFile": "/private/notify/consumer.token",
  "stateDirectory": "/private/notify/pi-state",
  "chronoRoot": "/private/chrono-logical-sessions"
}
```

The paths are examples. Use a protected local token file, never a token in a URL, task, event, resource note, or repository. Plain HTTP is limited to loopback. Use a protected forward for a service on another host. The Pi consumer token needs the consumer, scheduler, and reader roles scoped to its exact destination IDs. Event subscriptions also need the permitted source IDs. Do not use a publisher token as the Pi consumer token.

`stateDirectory` defaults to `pi-notify-state` under the Pi agent directory. Its owned directories use mode `0700`; records use `0600`. `chronoRoot` defaults to `chrono-logical-sessions` beside `PI_CHRONO_CONFIG_PATH`, or beside the default Chrono config. No Chrono files are changed.

1. Load the extension through the normal Pi package installation procedure.
2. Open the intended saved context. A new context must have reached Pi's normal disk-persistence boundary before it can be bound.
3. In that exact context, run `/notify bind <stable-agent-id>`.
4. Run `/notify status` or `notify` with `action: "status"` to inspect the registration and live state.

Registration is explicit. The adapter never selects the latest session, broadcasts to sessions, or derives the destination from a PID, pane, session display name, or `PI_SESSION_FILE` environment variable. The slash command is the binding interface. The model-facing tools cannot silently register a new context.

`/notify unbind` releases the live owner and suspends automatic rebinding. It preserves queued events and receipts. It does not cancel scheduled jobs. Use `notify cancel` for that separate operation.

## Identity and lifecycle

A private registry maps the stable destination to an exact session UUID, path, and branch anchor. A custom Pi binding entry must also exist. The service grants one renewable, token-protected live-owner lease per destination. A second owner is refused while that lease is live.

- Reload and resume restore only the registered context and selected branch. The adapter checks the authoritative local registry before further work.
- New sessions, native forks, and clones do not inherit the destination, even if Pi copies their custom entries.
- Native tree navigation suspends the binding. Explicitly bind the chosen context again if it should own the target.
- Chrono physical rollover can preserve the target only on the same registered logical session and branch, moving forward from a verified predecessor shard. A different Chrono branch does not inherit it.
- Ambiguous markers, incomplete rollover, changed manifest integrity, an inactive shard, a copied physical UUID/path binding, or missing lineage evidence stop automatic delivery.
- Bind after Chrono has adopted the session. An identity registered without Chrono evidence cannot infer lineage from a later replacement.

The read-only Chrono compatibility reader uses the version-1 `chrono-logical-adoption`, `chrono-logical-continuation`, and logical manifest contracts. It validates the canonical manifest hash, exact active physical identity, continuation content/hash binding, branch, and predecessor chain. It does not import a private installation path or modify Chrono's manifest.

Session shutdown and reload abort claims, cancel receiver timers, unregister bus listeners, and release live bindings. A normal replacement creates a fresh extension instance. Factories that never reach `session_start` have no receiver resources to close.

## Durable receipt is not completion

At safe idle, the adapter:

1. Appends a labeled `pi-notify-external-event-v1` custom message through the active extension's `sendMessage`, with `deliverAs: "followUp"` and `triggerTurn: false`.
2. Finds the exact entry in the physical JSONL file, verifies its content and session identity, checks that the path still names the verified file, and synchronizes the file and parent directory. Pi 0.85.1's `message_end` hook is not a durability boundary.
3. Saves its local delivery journal and acknowledges `delivered` to the service.
4. Sends a separate labeled wake message with `deliverAs: "followUp"` and `triggerTurn: true`.

The event includes the full scheduled task and external input. External input is data, not user approval. A task description cannot override current instructions or expand approved scope. The adapter never calls `sendUserMessage` for event delivery.

The service and adapter renew both ownership and delivery leases while work waits or runs. The adapter stops new injections and acknowledgments when ownership is lost. It cannot undo tool calls or other side effects that already started. The agent must stop related work when ownership is lost and must check saved work before repeating effects.

`notify_complete` records an explicit `completed` or `failed` outcome, with summary, evidence, and remaining work. It writes and verifies a separate Pi completion marker, saves the result locally, and reports the outcome to the service. Neither `agent_end`, `agent_settled`, a wake attempt, nor a saved event entry means completion.

Recovery is at least once:

- If the process stops after insertion but before receipt acknowledgment, the next claim reuses the verified current-branch entry.
- If it stops after receipt acknowledgment but before the wake, the service reoffers unfinished work after release or lease expiry. The next owner issues the missing wake.
- An unfinished reoffer gets another wake even if a prior wake was attempted. This can repeat model processing. There is no exactly-once side-effect guarantee.
- If it stops after a completion marker but before the local journal update, the next owner reconciles the exact source marker.
- If a local outcome exists but remote reporting is uncertain, the receiver reports it on reoffer without repeating the task. `notify inspect` can confirm a remotely committed result when its response was lost.

No rapid model retry loop runs at `agent_settled`. Each offered delivery gets one wake attempt per owner. A provider failure or unfinished task can remain delivered until explicit completion, cancellation, or a later reoffer. Service reconnection uses a model-free five-second retry. Binding leases normally last 60 seconds; renewal runs every 20 seconds. Retry count, delay, expiry, and cancellation can prevent another offer. Inspect a `dead` or expired delivery rather than assuming a wake will happen eventually.

Model-facing event messages are limited to 64 KiB. Tool replies are limited to 48 KiB. Use small inspection pages. Large task/event payloads must be reduced at the producer instead of relying on silent truncation.

## Agent tools

`notify` supports:

- `status`: registration, current live/offline state, pending delivery, and last safe error code.
- `create`: durable scheduling for the current registered target.
- `list` and `inspect`: jobs, deliveries, destinations, and resource notes.
- `pause`, `resume`, and `cancel`: an exact job owned by this target.
- `notes` and `note`: inspect or update resource notes through the service API.

`create` requires a complete `job.piTask`:

- Name and purpose.
- Exact target and matching trigger.
- Self-contained action instructions and context.
- Allowed actions and limits.
- Completion criteria.
- `resultDestination: {"kind":"delivery-result"}`.
- Expiry and stop conditions.

The result is stored with the delivery and remains inspectable. Version 1 does not forward the result to another destination. The task's `onWake` can instruct the agent to report to the current user within the approved scope.

A successful create returns the committed service acceptance and this instruction: "Accepted durably. Do not poll, sleep, or wait. End this turn; the receiver will wake the destination later." An unavailable service is not acceptance. If acceptance is uncertain, retry the same immutable job ID rather than creating a second task.

Use `notify_complete` only for the currently owned delivery. A failed remote acknowledgment is reported separately from a successfully saved local outcome. Resource notes and results are data, not authority to execute commands.

## Model-free event-bus API

A trusted Pi extension can consume an explicit `kind: "pull"` destination without registering the model's logical identity, adding `piTask`, or invoking the model. Create its destination and subscription job through the service client first.

```ts
import { subscribeNotifications } from "pi-notify/pi-bus";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let subscription;

  pi.on("session_start", async () => {
    subscription = await subscribeNotifications(pi.events, {
      consumerId: "build-status-widget",
      destinationId: "build-status-events",
      async handle(event) {
        // These application functions must save and deduplicate by delivery.id.
        await saveReceiptDurably(event.delivery);
        await event.acknowledge();
        const result = await updateWidgetIdempotently(event.delivery);
        await event.complete(result);
      },
    });
  });

  pi.on("session_shutdown", async () => {
    await subscription?.close();
  });
}
```

The application functions in this example are consumer-owned. The bus does not provide durable storage on the consumer's behalf.

`subscribeNotifications` emits `pi-notify:subscribe:v1`. Its immediate result confirms only local subscription registration, not a live service binding or durable receipt. This avoids a deadlock when extension `session_start` handlers run in a different order. If no adapter listener answers synchronously, the helper rejects with `notify_adapter_unavailable` instead of leaving startup waiting. `pi-notify:ready:v1` emits `{schemaVersion: 1, consumerId, destinationId, state: "live"}` after that consumer binds. A separate `{schemaVersion: 1, configured: true}` event means only that the adapter has loaded its configuration.

The callback receives public delivery data and four methods:

- `acknowledge()`: call after a durable consumer receipt.
- `complete(result)`: explicitly report the completed outcome.
- `retry(error)`: release for a bounded retry.
- `fail(error, result?)`: report a terminal failure.

Lease tokens are not exposed to the callback. One receiver holds at most one unfinished delivery. Register once per consumer and destination in each runtime. Close the returned subscription at shutdown. Handler errors become retry requests. An unavailable service leaves the work in the durable queue, and reconnection needs no model. Consumers must deduplicate their own side effects. The event bus is for trusted in-process extensions, not an authentication boundary for external publishers.

## Closed sessions and verification boundary

Version 1 queues work when the intended Pi process is closed or offline. It does not automatically reopen a saved session.

Pi's SDK `SessionManager.open(path)`, `AgentSessionRuntime.switchSession(path)`, and CLI `--session` can open an exact saved context only in a process owned by their caller. They do not attach to an arbitrary active TUI. Automatic cold resume therefore needs a separate managed lifecycle owner with exclusive session admission, exact context recovery, and a safe startup/teardown policy. Launching a second unmanaged process on the same file is not supported.

The focused adapter check uses the real Pi 0.85.1 SDK, a disposable service, synthetic saved sessions, and a deterministic local stream. It exercises factory inactivity, explicit binding and owner refusal, the receipt-before-wake crash window, persisted-entry deduplication, explicit completion, fork refusal, and a model-free consumer. A second bounded check validates the read-only Chrono v1 rollover identity contract. These checks do not prove live activation, real provider inference, a real Chrono rollover, or cold resume. The activation owner must verify the selected live installation separately.

For native Node 24 test execution, TypeScript imports use `.ts` and avoid constructor parameter properties. Node's strip-only loader does not transform that syntax.
