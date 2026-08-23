# ChronoCompact background value worker

## Status

This is a personal-project feature. It is not release approval. The feature is off by default. No real provider quality evaluation was performed for this work.

## Purpose

The worker gives bounded value advice for immutable candidate segments. It replaces the active extension path for the old compaction-time history editor.

## Product boundary

The worker is retrospective only. It does not change tool results before the main model receives them. It does not write final context. Deterministic code owns final text, chronology, source links, lifecycle state, token limits, recovery, and validation.

## Modes

`off` creates no advice work. `shadow` stores advice but does not change replay. `advisory` changes only bounded deterministic value scores. Compaction never waits for the worker.

## Model selection

Use `main` or an exact `provider/model`. ChronoCompact does not fall back to the main model when an exact model is unavailable.

## Thinking level

Use `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi model metadata controls support. An unsupported level prevents the call. The selected level reaches Pi through the per-call `reasoning` option.

## Prompt privacy

Protected exact text is never sent. User and project instruction text is never sent. After explicit enablement, the worker can send bounded assistant and tool excerpts from deterministic candidates. It never sends the session path, source entry IDs, source references, credentials, full tool arguments, or full tool output. Candidate excerpts are accepted only when the deterministic candidate is smaller than its source form. A final sanitizer removes known source IDs, identifier shapes, home paths, and credential shapes.

## Advice schema

Schema version 1 uses opaque batch-local item IDs and bounded enums. Advice cannot assign authority, completion, resolution, source claims, quotations, paths, commands, or context text.

## Batching

One immutable candidate segment is processed at a time. Jobs default to 40 items, 6,000 input tokens, 1,500 output tokens, and 600 excerpt characters per item. Oversized work is split deterministically.

## Advice store

The owner-only `.chrono-value-advice-v1` derived store uses immutable advice files and an atomic integrity-checked manifest. Full SHA-256 identities bind each normalized record to its candidate record and configuration. Old model and configuration files remain immutable and reusable. One stale record or corrupt file is ignored independently. A later worker run rebuilds a corrupt manifest from verified compatible immutable files. It starts a new complete manifest when no compatible file can be verified. It does not delete old files. It stores no prompt, raw response, full source text, path, or credential. Missing, stale, busy, or corrupt advice keeps deterministic behavior.

## Scheduling

Work starts only after segmented candidate preprocessing is ready. Scheduling is asynchronous and coalesced. Session switch, fork, shutdown, and settings changes cancel pending work. A separate host-wide value-model slot namespace uses PID, Linux process-start identity, nonce, inode checks, and owner-only files.

## Budgets

Call, input-token, and output-token budgets always apply. Defaults are 100 calls, 250,000 input tokens, and 50,000 output tokens per session. Provider attempts and repair calls count. A failed attempt conservatively reserves its bounded input, output, and enforceable cost allowance before any retry. Totals persist in the owner-only manifest across jobs and Pi restarts. One owner-verified per-session run lock prevents concurrent processes from crossing a hard budget.

## Cost estimation

Money uses integer micro-USD, where one USD is 1,000,000 micro-USD. Before every provider or repair call, ChronoCompact prices the bounded input and maximum output with Pi model metadata and rounds upward. A configured limit prevents a call when pricing is unavailable or when the upper bound would cross the limit. After a call, provider-returned total cost has priority; otherwise actual usage uses Pi input, output, cache-read, and cache-write prices. ChronoCompact does not guess missing prices.

## Retry policy

The worker makes one initial attempt plus zero through two configured retries. It retries only structured timeout, rate-limit, temporary HTTP, and connection failures. Backoff is deterministic and bounded at 250 ms then 1,000 ms. Cancellation, deadline, circuit, and every hard budget are checked before each attempt. One optional repair call is used only for invalid top-level JSON, version, or item-array shape. An invalid individual item does not trigger repair. The repair prompt contains only the schema and bounded opaque IDs recovered from the invalid response. It does not repeat source excerpts, paths, source references, or the original item metadata.

## Circuit breaker

Closed, open, and half-open state persists in the manifest. One batch failure is counted after retries and optional repair finish. The default failure limit is three and the default cooldown is 1,800 seconds. After cooldown, an owner-locked claim permits one half-open batch across Pi processes. Success closes the circuit and failure reopens it. Model, thinking, prompt-schema, or advice-schema changes reset active circuit state. Manual reset cancels pending work, closes the circuit, and preserves valid advice.

## Advisory safety

Advice below 0.60 confidence is ignored. An increase is at most 25 importance points. A decrease is at most 15 points. Protected, user, custom-message, blocker, unresolved, exact-evidence, current-resource, and hard-keep units cannot be lowered. Advice selects no text directly. Final validation and hard limits remain.

## Status commands

`/chrono-value-worker-status` shows aggregate state, attempts, repair calls, token and cache usage, cost, budgets, pending segments, slot limit, and circuit state. It shows no source identity or advice text. `/chrono-value-worker-reset` cancels process-local pending work, resets the persisted circuit, and preserves advice and source-derived stores.

## Privacy

No prompt or raw response is persisted. The worker does not log opaque-to-source mappings. Scheduler records contain no session, project, model prompt, or source identity.

## Current limits

Pi 0.84.2 does not expose one uniform structured provider-error object across every adapter. ChronoCompact uses HTTP status, provider code, Node error code, error type, and cancellation state when present. It does not classify by unrestricted raw error text. Errors without safe structured classification are not retried. Real provider advice quality and provider-specific error coverage need a later explicitly funded evaluation. The old history editor remains as a deprecated direct package API, but the Pi extension does not call it. The legacy setting only produces a warning and cannot create model spend.
