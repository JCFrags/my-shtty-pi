# Bounded context composition

The composer combines one chronological source-linked history with a small adaptive raw tail. An independent regular Pi summary can coexist when explicitly enabled. The baseline does not require a language model, rebuild lifetime history, or add a provider. Source implementation and local activation remain separate facts.

## Normal return path

When the memory engine or a valid canary is selected:

1. Pi supplies a prepared prefix and tail. ChronoCompact inspects at most 256 suffix entries to choose a complete tool-safe raw tail. It does not copy or traverse the lifetime prefix.
2. The adapter pins compatible existing state at the source cut. Missing optional detail or indexing lag uses compatible last-good state or bounded active-branch fallback. Incompatible source bindings still refuse.
3. If explicitly enabled and its extra input fits the bounded window, the existing Pi summary path can produce an independent summary. Its absence or failure does not cancel valid composition. User cancellation still cancels.
4. The composer renders restrictions, goals, decisions, blockers, unfinished work, routine history, and supported delta in one source-ordered history. Internal selection categories remain separate. Important events receive more detail than routine activity, with source excerpts and recovery references when full text does not fit. Importance changes optional detail or selection, not chronology. Each row retains source authority, status, and exact recovery.
5. Post-render validation checks disclosed coverage, the safe tail, and the effective configured summary-and-tail token ceiling. The adapter also rechecks session, branch leaf, and cancellation identity.
6. A successful return persists the `chrono-v3-composed-context` envelope or fallback receipt and chosen `retainedTail`. It includes `piSummary` only when independently generated. Optional summary input excludes Chrono replay. Private diagnostic artifact persistence is optional for normal return and remains required for an explicit preview.

Version 2.0.35 corrects settlement ordering: a triggered V3 compaction preserves the validated maintained search target before selection. Search retargeting is deferred while that request is pending and resumes after completion or refusal/error, subject to session, source, and epoch checks. Selection still requires a compatible prepared cut and validated coverage. It does not start ingestion, wait for catch-up, or retry compaction after refusal. Compatibility-mode incremental scheduling is unchanged.

V3 applies the owner's timeline and adjustable-token clarification. The default V3 tail is dynamic, 3,000 through 6,000 estimated tokens. The selector uses the current turn plus a 1,500-token continuity margin. It can keep less than the minimum when complete boundaries require that. It refuses when no complete suffix fits the maximum. V3 does not inherit Pi's 20,000-token tail or honor compatibility-only fixed/Pi tail modes.

The preparation adapter uses Pi 0.85.1's public `sessionEntryToContextMessages` and `estimateTokens`. It uses `generateSummaryWithUsage` only for optional independent summaries. Adaptive inspection is limited to 256 entries including an adjacent prefix entry. Token estimates saturate at 128,000, so an older large result does not block a smaller safe suffix. The selected cut cannot move before Pi's prepared boundary. If that boundary precedes the bounded window, optional summary expansion is skipped instead of scanning older entries.

The programmatic fallback inspects at most 128 recent prefix entries, 16 blocks per entry, 8,192 UTF-16 units per entry, and 128 Ki units in total. It reuses at most 128 Ki units and 4,000 tokens of Pi's previous branch summary as explicitly historical text. User requests and important events receive longer excerpts. Retained excerpts stay in branch order. The receipt discloses omitted history, possible stale memory, and unavailable retrieval. This path neither opens archives nor changes a stored source binding.

## Budgets and refusal

The charter's section-floor table is historical, not the current configuration interface. The existing `targetContextTokens` setting is the hard combined summary-and-tail limit. Its default stays 32,000, with a configurable range of 8,000 through 250,000. Each operation lowers it if needed to fit the selected model's context capacity after system-prompt tokens, Chrono's 1,500-token default context reserve, and Pi's response reserve. Normal compaction uses the supplied Pi reserve. Preview and logical continuation reserve 16,384 tokens. Missing capacity or less than 512 usable tokens refuses. Token counts are estimates, not tokenizer certification.

The composer still admits at most 256 rows, 64 delta rows, 16 KiB per row, 512 KiB total input/artifact, 128 KiB of regular summary, and 2 KiB per recovery reference. A larger token setting does not enlarge those finite byte, memory, native, I/O, or deadline controls. Worker `30,000 ms` deadlines are not token caps. The compatibility replay retains its separate 25,000-token limit. Mandatory categories remain internal selection indexes, with optional-row reduction under the effective combined cap. It labels shortened source text as an incomplete excerpt, not a complete instruction. Budget-driven omission is normal. The aim is useful approximate short-term memory plus recovery, not verbatim lifetime state in context.

The composer supports selective history, compatible last-good state, and bounded programmatic fallback. Incomplete restriction/work coverage is an honest disclosure, not a live refusal condition. Normal composition and logical continuation reject incompatible source identities, unsafe tails, overflow, and unusable results. They do not require every historical restriction or task to fit in context. Source incompatibility, unsafe tool structure, cancellation, or unusable budget still cancels compaction and preserves current context. Missing optional memory or diagnostic artifacts does not require refusal. No fallback silently enters the legacy lifetime replay or invokes a rebuild.

The earlier global mandatory-content overflow policy is superseded by the owner's selective-memory clarification. Practical compaction and rollover of the original large session remain unverified. State catch-up, packed proposition coverage, or `awaiting-cut-validation` is not evidence of practical success. Cut/category checks describe the implemented source extraction and selection, not semantic certification of every condition, approval, or unresolved task.

## Inspection and ownership

`/chrono-composition-preview [compaction-entry-id]` reads a supported recorded compaction and saves a bounded private comparison. It does not replace active context or enable the engine. A preview is not a live compaction, provider-continuation, or rollout result.

[ADR-010](adr/ADR-010-context-budgets-and-validation.md) records the budget and validation decision. [Configuration](configuration.md#composition-controls) owns effective controls. [Operations](operations.md#composition-behavior) owns the operator path. Implementation: [composer](../../packages/pi-chrono-compaction/src/context-composer.ts), [normal-return validation](../../packages/pi-chrono-compaction/src/composition-preview.ts), and [Pi hook](../../packages/pi-chrono-compaction/src/pi-extension.ts).
