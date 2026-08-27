# `ask_user` version-1 contract

This document freezes the shared facade and provider contract. The TypeScript source in `packages/core/src/ask-user-v1.ts` is the machine-readable authority.

## Ownership

The `ask_user` facade owns strict input validation, mode routing, correlation IDs, provider lifecycle checks, and normalized tool results. It owns no question or answer store.

Dialog owns only blocking UI and in-memory blocking retry state. Signals owns all deferred persistence, revisions, answer IDs, delivery, replay, and acknowledgement. Neither owner imports the other.

The facade never changes a mode. A blocking request uses only the blocking channels. A deferred request uses only the deferred channels.

## Registration setting

The canonical tool is off by default. Set this package setting to opt in:

`~/.pi/agent/grounded-dialog.json`

```json
{
  "askUserV1": true
}
```

The extension only reads this file. It does not create or modify it. The setting controls only `ask_user` registration. The existing `ask_user_question` tool remains registered and unchanged.

## Frontend union

Every call must include an explicit `operation` and `mode`. Unknown properties fail validation.

### Blocking ask

- `operation: "ask"`
- `mode: "blocking"`
- `question`: 1 to 160 characters
- optional `explanation`: 1 to 4000 characters
- `response.kind: "single_or_text"`
- `response.options`: 2 to 4 options
- option `id`: `^[A-Za-z0-9_-]{1,32}$`, unique in the request
- option `label`: 1 to 160 characters
- optional option `description`: 1 to 500 characters
- optional option `preview`: 1 to 20000 characters
- `timeoutMs`: integer from 10000 through 86400000

A result has `schemaVersion: 1`, `operation: "ask"`, `mode: "blocking"`, the facade correlation ID, and one terminal status:

- `answered` with `{ kind: "option", optionId }` or `{ kind: "text", text }`
- `cancelled` with reason `user`, `abort`, `shutdown`, `reload`, or `provider_failure`
- `timed_out`

### Deferred ask

A deferred ask uses the current Signals create fields. It replaces frontend `blockingPolicy` with `escalationPolicy`. The facade maps `escalationPolicy` back to provider `blockingPolicy` without another semantic change.

Required fields are `operation: "ask"`, `mode: "deferred"`, `question`, `reason`, `class`, and `response`. Current optional Signals fields remain optional: `recommendation`, `recommendedOptionIds`, `recommendedText`, `temporaryDefault`, `priority`, `escalationPolicy`, `deliveryMode`, `affectedWork`, `continuingWork`, `attachments`, and `expiresAt`.

The facade normalizes omitted list fields to empty arrays before provider routing. Deferred option IDs keep the current Signals rule `^[a-z0-9][a-z0-9_-]{0,31}$`. Other bounds match `signal_board_question` version 1.

A successful result has:

```ts
{
  schemaVersion: 1;
  operation: "ask";
  mode: "deferred";
  correlationId: string;
  status: "queued";
  questionId: string;
  displayId: string;
  revision: number;
}
```

### Deferred cancel

A cancel has `operation: "cancel"`, `mode: "deferred"`, a durable `qst_...` ID or `Q-N` display ID, `expectedRevision >= 1`, and a reason from 1 to 1000 characters.

A successful result has the same IDs and new revision with `status: "cancelled"`.

## Same-process channels

These are the only version-1 provider channels:

| Direction | Exact channel |
|---|---|
| Facade to Dialog | `pi-ask-user:blocking-request-v1` |
| Dialog to facade | `pi-ask-user:blocking-response-v1` |
| Facade to Signals | `pi-ask-user:deferred-request-v1` |
| Signals to facade | `pi-ask-user:deferred-response-v1` |

All messages contain `schemaVersion: 1`, `correlationId`, and the exact mode. Request messages can contain the current tool `AbortSignal` as the optional same-process `signal` field. The signal is transport state. It is not part of retry identity and must not be persisted.

The correlation format is `ask_` plus a lowercase RFC 4122 version-4 UUID. The facade creates one correlation per Pi tool-call ID. An exact retry of the same tool-call ID reuses it. Reuse of that tool-call ID with different normalized input fails with `ASK_USER_CORRELATION_CONFLICT`.

A provider must emit `accepted` synchronously from its request listener. The facade waits 250 ms for `accepted`. No response, a malformed response, a wrong transition, or a terminal response for the wrong operation fails closed.

Provider rejection uses:

```ts
{
  code:
    | "ASK_USER_INVALID_REQUEST"
    | "ASK_USER_CORRELATION_CONFLICT"
    | "ASK_USER_PROVIDER_UNAVAILABLE"
    | "ASK_USER_PROVIDER_UNHEALTHY"
    | "ASK_USER_PROVIDER_FAILURE";
  message: string;
  retryable: boolean;
}
```

## Blocking provider lifecycle

The only successful lifecycle is:

`accepted -> open -> answered | cancelled | timed_out`

Dialog validates before `accepted`. A new valid call opens one UI. An identical request with the same correlation joins the open operation. An identical request after completion receives replayed `accepted`, `open`, and the cached terminal response. Different content with the same correlation receives `ASK_USER_CORRELATION_CONFLICT`.

Escape returns `cancelled/user`. Tool abort returns `cancelled/abort`. Session shutdown returns `cancelled/shutdown`. Reload returns `cancelled/reload`. A UI failure returns `cancelled/provider_failure`. The timeout returns `timed_out`.

A live call emits `herdr:blocked` active after validation and inactive in one terminal cleanup path. It emits one balanced pair for the underlying operation, including retries. The facade does not add `ask_user` to the name-only Herdr bridge because deferred calls must not appear blocked.

Dialog removes its provider listener on session shutdown. The facade removes each response listener on rejection, terminal response, provider failure, or acceptance timeout.

## Deferred provider implementation contract

The later Signals provider must listen only on `pi-ask-user:deferred-request-v1`. It must emit only on `pi-ask-user:deferred-response-v1`.

For each valid request:

1. Validate with `isDeferredProviderRequestV1` or an exact local copy.
2. Compute retry identity from all request fields except `signal`.
3. Reject different content for a reused correlation with `ASK_USER_CORRELATION_CONFLICT`.
4. Emit `accepted` synchronously before starting asynchronous persistence.
5. Use `tool:ask_user:<correlationId>` as the Signals service `commandId`.
6. For `operation: "ask"`, call the current create service. Pass provider `blockingPolicy` directly to Signals. Emit `queued` only after `question.created` has committed and reduced. Return the durable question ID, display ID, and revision.
7. For `operation: "cancel"`, call the current cancel service with the supplied ID, expected revision, and reason. Emit `cancelled` only after `question.cancelled` has committed and reduced. Return the durable question ID, display ID, and new revision.
8. Map every service failure to a strict rejected response. Do not report success after an append failure.
9. Keep durable success after response-delivery loss. An exact retry must use the same command ID and return the accepted entity without a second append.
10. Do not emit `herdr:blocked`. Do not import Dialog or Herdr. Do not add a facade store.

Deferred response states are exactly:

```ts
type DeferredResponse =
  | { schemaVersion: 1; correlationId: string; mode: "deferred"; state: "accepted" }
  | {
      schemaVersion: 1; correlationId: string; mode: "deferred"; state: "queued";
      operation: "ask"; questionId: string; displayId: string; revision: number;
    }
  | {
      schemaVersion: 1; correlationId: string; mode: "deferred"; state: "cancelled";
      operation: "cancel"; questionId: string; displayId: string; revision: number;
    }
  | {
      schemaVersion: 1; correlationId: string; mode: "deferred"; state: "rejected";
      error: AskUserProviderErrorV1;
    };
```

This provider layer does not change `signal_board_question`, `signal_board_ack`, `/signals`, `/signalboard`, `pi-signal-board/event`, or `pi-signal-board/answer`.

## Rollback

Set `askUserV1` to false or remove the setting to stop canonical tool registration. Remove the four provider listeners to remove the facade protocol. Existing Dialog and Signals entry points continue to work.
