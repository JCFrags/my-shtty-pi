# Dialog Ask User facade

Dialog owns the single `ask_user` registration. Its factory reads
`getAgentDir()/grounded-dialog.json`; only `askUserV1: true` enables the facade.
When enabled, Dialog does not register `ask_user_question`. When disabled, the
legacy registration remains unchanged. The blocking provider is registered in
both cases. Providers must not register a second question facade or change this
setting. A settings or source change requires an approved runtime reload; tool
search alone does not refresh the factory or its schema.

## Deferred V1.1 behavior

- Use deferred questions only for preference, information, or reversible choices.
  Authorization requires an explicit blocking question. There is no automatic
  mode switch or escalation based on elapsed time or agent settlement.
- `deliveryMode` supports only `nextTurn` (also the provider default when omitted).
  Busy work continues. Answers are delivered at safe idle for the next natural
  turn, without immediate steering or an automatic follow-up response.
  `escalationPolicy` supports only `never` (also the provider default).
- These are facade restrictions, not changes to the shared V1 event contracts in
  `../core/src/ask-user-v1.ts`. The provider must also enforce these restrictions.
  Public `escalationPolicy` still maps to wire `blockingPolicy`.
- Deferred requests require a stable Pi session ID and tool call ID. Correlation
  uses the first 16 bytes of SHA-256 of the JSON tuple
  `["pi-ask-user:deferred-correlation-v1", sessionId, toolCallId]`, with version and
  variant bits set to match the existing `ask_UUIDv4` pattern. This is a
  deterministic hash in UUID form, not a randomly generated UUID. It includes
  neither question text nor raw identity in the emitted ID. It is not an
  authentication credential.
- The same session and tool call produce the same correlation after facade
  recreation. The provider must retain durable request fingerprints and receipts
  to reject changed content and prevent duplicate mutations. The facade's memory
  cache alone does not guarantee exactly-once behavior. A new tool call ID is a
  new operation; do not use one to retry an uncertain result.
- Acceptance must arrive within the existing 250 ms window. After acceptance,
  deferred provider work has a fixed 10-second terminal deadline. Repeated
  acceptance does not extend it. Abort, errors, and timeout remove response and
  abort listeners and clear timers. Pre-aborted requests are not emitted.
- Timeout or abort does not mean a question was cancelled or a mutation rolled
  back. An interrupted operation has an unknown outcome. Reconcile using the same
  session and tool call ID; the facade does not send a compensating cancel.
- Question expiry, durable answer delivery, owner checks, cancellation revisions,
  and receipt retention belong to the provider. The unchanged core guard rejects
  expired `expiresAt` values before dispatch, including retries after expiry.

Blocking question schema, correlation generation, provider lifecycle, and user
answer timeout remain unchanged. The deferred deadline does not apply to them.

## Focused verification

From the repository root, after preparing the locked dependencies:

```sh
node --experimental-transform-types --test packages/grounded-tools/dialog/test/facade.test.mjs
```

The tests use synthetic event buses and session contexts, real facade execution,
and the real blocking provider with fake UI. They check registration, schema
restrictions, stable correlations, conflict forwarding, deadlines, abort cleanup,
and blocking timeout behavior. They do not load private settings or ask live
questions. Production provider durability and active-session schema refresh need
separate integration verification.
