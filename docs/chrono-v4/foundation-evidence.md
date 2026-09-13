# Foundation practical evidence

## Scope and result

A small synthetic scenario exercised the Context Kit foundation from source commit `5a2b15179edcf4391f36144c0a8cbf393e988549` on installed Pi 0.85.1 and Node 24.18.0. A separate two-call model comparison checked whether the returned evidence supported the current decision and next action.

The native scenario passed. The model with current cards recovered all four scored facts. The baseline safely reported missing evidence. This is evidence that the cards were useful in this one case, not a general agent benchmark, a full V3 comparison, live installation acceptance, or qualification of replacement compaction.

## Installed Pi scenario

`DefaultResourceLoader` loaded Telemetry, Tasks, Notes, Workplan, and Recall without loader errors. A registered public command received actual Pi command context and invoked the registered tools. The driver supplied synthetic assistant calls and lifecycle events, then persisted actual results through `SessionManager`. This was a manual driver, not an autonomous model/tool loop.

The fixture contained an old append-only proposal, an accepted replace-atomic correction, a revised note, a workplan decision, pending checksum verification T1, and copy task T2 blocked by T1. The correction required preservation of the original.

- Twenty registered-tool operations and nine checks passed.
- Recall returned four cards in 2,897 serialized bytes with default limits.
- T2 retained its `blocked_by` reference to T1. Notes N1 contained the accepted correction at revision 2.
- The Workplan card reported omitted decisions and incomplete coverage. Native `workplan recover` returned the decision. The packet did not claim completeness.
- All returned native recovery instructions worked. Recall left native state unchanged.
- A new SDK session reopened the 52,236-byte fixture log and retained Notes N1 and Workplan WP1 revision 2.

Initial and reopened Recall driver timings were 2.599 ms and 0.634 ms. These include surrounding persistence and event work, not only Recall execution. They do not establish throughput or a latency improvement.

The first setup attempt omitted the native `record_decision` action's required `rationale`. The corrected fixture passed without a product change. No model call occurred during the failed setup.

## Frozen model comparison

The configured route was `openai-codex / gpt-6-astra`, API `openai-codex-responses`, through installed `ModelRuntime.completeSimple`. This identifies the configured route, not a separate verification of provider model branding.

Both single-turn calls used the same question and JSON output requirements. The baseline received a fixed old proposal that explicitly lacked current state. The candidate received that excerpt plus actual Recall provider cards, coverage, and omissions. Neither call could use tools.

The expected answers and scoring rules were frozen before both calls. Each call had an 8,192-byte complete input ceiling, 512 output tokens, minimal reasoning, a 60-second timeout, and zero retries. Read-only authentication required no refresh or credential write. Exactly two calls completed.

Each score awarded one point for the corrected decision and original-preservation requirement, the pending dependency, the specific safe next action, and supporting IDs for current claims.

| Measurement | Retained excerpt | Excerpt plus native cards |
| --- | ---: | ---: |
| Complete input bytes | 1,103 | 3,425 |
| Provider input tokens | 215 | 714 |
| Provider output tokens | 110 | 158 |
| Total tokens | 325 | 872 |
| Elapsed milliseconds | 9,579.715 | 6,942.439 |
| Current-fact score | 0/4 | 4/4 |
| Stale claims | 0 | 0 |
| Unsupported claims | 0 | 0 |

The baseline requested current evidence instead of treating the old proposal as accepted. That was safe abstention, not unsafe behavior. It did not earn points for facts absent from its input.

The candidate identified replace-atomic mode, preserved the original, selected pending T1 checksum verification before T2, and cited N1, T1, and T2. It explicitly noted that Workplan decisions were omitted.

Evidence availability differed by design. This check does not compare all possible native-tool use, show a token saving, estimate general accuracy, or prove that the candidate is faster. It demonstrates the use of retrieved current evidence in one controlled question.

## Independent telemetry

The successful collectors paired 16/16 and 4/4 tool operations. They reported no unpaired operations, observation errors, dropped records, or unconfirmed shutdown writes. Direct model usage was separate from these manually driven collectors.

One caller-reported retrieval pass produced `observed_not_verified`. The reopened collector started at `unknown`. Runtime successes did not create quality scores.

Three private slots, including the failed setup, held 82 records and 13,816 bytes at mode `0600`. Bounded screening found no case text, raw fixture session/leaf IDs, or private root path. This was a focused content check, not a security audit or long-duration storage test.

## Reuse the bounded procedure

1. Set private home, agent, working, and XDG directories before importing Pi. Disable unrelated resource discovery, compaction, and retries.
2. Load only intended source extensions. Bind them to a real `SessionManager` and run a registered command through `session.prompt('/command')` without a model turn.
3. When driving tools manually, persist matching synthetic assistant calls and actual tool results. Emit `message_end` for persisted results so native pending state clears. Disclose the manual driver.
4. Follow native recovery, compare state, close normally, and reopen the saved fixture with fresh bindings.
5. For an approved model comparison, freeze the inputs and scoring first. Use bounded direct calls with read-only authentication. Stop if refresh is required. Do not save credentials or raw authentication errors.

The private scripts and transcripts are not included because they contain local paths and fixture session identifiers. This page records screened measurements and the procedure. Existing focused component checks and required repository CI remain separate evidence.
