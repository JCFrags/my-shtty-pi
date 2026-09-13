# V4 research inputs

Four scoped agents inspected the supplied public projects. Findings below are pinned to the inspected source, not a moving branch or download count. No third-party dependencies were installed and no third-party application, test, model or extension was executed. These are source findings, not reproduced performance results. The V4 implementation uses independently written code.

## Comparison

| Project and inspected revision | Useful mechanism | What not to adopt |
| --- | --- | --- |
| [thesys-core, `4020932e`](https://github.com/Sreehari05055/thesys-core/tree/4020932e7c1dd0663c3b10e8f0845ecd8dd7d190) | Search a precise child span but expose wider parent evidence. Diversify results by source family. Attach source identity in code around optional extraction. | Required model-driven chat, full-history reloads, whole-collection summarization and caches without observed eviction. |
| [Graphify, `fe663890`](https://github.com/Graphify-Labs/graphify/tree/fe66389083369c3159aa391117185c8f58b4d07c) | Separate source kind, category, relationship and derivation. Follow lexical seeds through source-backed directed relations. Invalidate derived contributions by source and producer. | A whole-history graph, simple edges that collapse distinct facts, soft output budgets and traversal without absolute work limits. |
| [Utopia, `32a8e836`](https://github.com/deeplethe/utopia/tree/32a8e836ecabb3a06d9790113cac981dd1dbc26c) | Separate raw episodes, pending proposals and accepted facts. Preserve recording time and validity time. Separate retrieval scoring from final agent outcomes. | A shared process/database as the independence model, growing whole-memory-log reindexing and nominal model budgets without atomic reservation. |
| [pi-blackhole, `23e4a075`](https://github.com/k0valik/pi-blackhole/tree/23e4a075a9d16d63108a604b94ef853f1eaecfd0) | Freeze a context projection at a checkpoint. Preserve a complete fallback and exact recovery routes. Select whole records under a complete budget. | Private Pi method patches, unbounded recall expansion, automatic model-context injection from supposedly human-only output and incomplete worker coverage presented as complete. |

## thesys-core

The [chunker](https://github.com/Sreehari05055/thesys-core/blob/4020932e7c1dd0663c3b10e8f0845ecd8dd7d190/backend/app/services/rag_service/chunking_service.py) creates approximately 64-token child units and 448-token parent units. These are packing targets, not hard limits. The [retrieval pipeline](https://github.com/Sreehari05055/thesys-core/blob/4020932e7c1dd0663c3b10e8f0845ecd8dd7d190/backend/app/services/rag_service/base_rag_pipeline.py) keeps the strongest child per parent and returns parent text with precise child coordinates.

The useful adaptation is a relevant excerpt plus a separately preserved route to wider evidence. Chrono already has cues and exact handles, so reuse those mechanisms rather than install a PDF retrieval stack. Do not deduplicate distinct historical events because their text matches.

The [history store](https://github.com/Sreehari05055/thesys-core/blob/4020932e7c1dd0663c3b10e8f0845ecd8dd7d190/backend/app/services/state_manager/local_history_store.py) reloads conversation rows without a limiting query. Source inspection found no tracked evaluation suite or measured agent-benefit evidence. Its architecture is not a bounded lifetime-history design.

The [root license](https://github.com/Sreehari05055/thesys-core/blob/4020932e7c1dd0663c3b10e8f0845ecd8dd7d190/LICENSE) is AGPL-3.0, while frontend package metadata says MIT. That conflict is not permission to copy frontend code under MIT. Use general concepts, not copied implementation.

## Graphify

Graphify's shipped query path can use lexical retrieval and local structure without a language model or graph database. Its useful distinction is between native structure, inferred relationships and ambiguous evidence. Categories must not become identity or authority.

For Chrono, a useful later addition is a small indexed relation expansion from a lexical hit to its action/result pair or explicit correction. Bound seeds, scanned adjacency rows, admitted relations, returned events and the complete response. Reuse the active checkpointed history path. Similar concepts in a legacy whole-history implementation are not a reason to reactivate that path.

At the inspected revision, [benchmark documentation](https://github.com/Graphify-Labs/graphify/blob/fe66389083369c3159aa391117185c8f58b4d07c/BENCHMARKS.md) reports conversational-memory results, but the named memory and cross-tool reproduction runners were absent from the public tree. The published dense/hybrid configurations are not the shipped lexical query. Do not transfer those scores to Chrono or call estimated token reduction a correctness result.

Current code is Apache-2.0 with NOTICE material and retained MIT terms for earlier portions. Any later code reuse needs the applicable notices, not an assumption that the whole tree is MIT. No code was copied for this slice.

## Utopia

The inspected development revision includes Memory writes even though parts of its README still describe them as future work. Raw episodes and pending extracted facts remain distinct. Revisions can retain both when a fact applies and when the system recorded that understanding.

Apply those ideas to revisable Memory with exact source and branch identity. Do not require a temporal graph for every Note or Todo. Raw text is still untrusted evidence even when a proposal gate keeps it out of accepted fact state.

The Memory ingestion path reads and reindexes a growing per-base memory log. Repeated appends can therefore produce increasing per-append work. That is a counterexample to reuse, not a model for Chrono's incremental stores.

Utopia has real [benchmark and evaluation code](https://github.com/deeplethe/utopia/tree/32a8e836ecabb3a06d9790113cac981dd1dbc26c). The relevant distinction is stored-information presence, retrieval, tool execution and final answers. Author-reported results remain revision- and corpus-bound. Loose substring/numeric scoring, excluded cases and same-corpus tuning limit what a reported score proves. Its usage accounting and audit log are not a ready-made bounded private telemetry system.

The source license is Apache-2.0. Bundled ontology data has separate terms. No code, data packs, corpora or branding were copied.

## pi-blackhole

The supplied [Pi package page](https://pi.dev/packages/pi-blackhole) resolves to `k0valik/pi-blackhole`. Inspected main and published 0.5.3 commit [`7e0c9d1f`](https://github.com/k0valik/pi-blackhole/tree/7e0c9d1ff06e7024989408e3f4b5eac8409c53e6) have the same tracked Git tree. The npm tarball was not independently compared.

The [compaction-chain implementation](https://github.com/k0valik/pi-blackhole/blob/7e0c9d1ff06e7024989408e3f4b5eac8409c53e6/src/core/compaction-chain.ts) freezes visibility and keeps an aggregate fallback. This supports a useful V4 selection receipt. Deterministic extraction alone does not prevent repeated information loss, so exact recovery and coverage remain necessary.

The [inline adapter](https://github.com/k0valik/pi-blackhole/blob/7e0c9d1ff06e7024989408e3f4b5eac8409c53e6/src/om/inline-compaction.ts) patches private Pi runtime methods. Installed Pi 0.85.1 already supplies native between-turn compaction and bounded overflow recovery. Use public hooks instead of adding that coupling.

The [recall command](https://github.com/k0valik/pi-blackhole/blob/7e0c9d1ff06e7024989408e3f4b5eac8409c53e6/src/commands/vcc-recall.ts) describes uncapped output as human-only, but sends it through `pi.sendMessage` with a triggered turn. Pi persists that output into model context. Other recall branches do not share one hard final response budget. This reinforces the need to count body, metadata, recovery routes and notices together.

The package has tests and CI. They do not independently establish long-run benefit inside our Pi installation. Its MIT license permits adaptation subject to notices, but substantial inherited code needs per-file provenance checks. No code was copied.

## Decisions for V4

1. Keep Chrono's immutable source, bounded stores, verified recovery and native checkpoints.
2. Add native provider records without a mandatory shared runtime or database. A missing peer must not prevent standalone state use.
3. Preserve precise evidence, lifecycle, revision and recovery metadata before spending space on wider context.
4. Treat categories and relation expansion as optional relevance aids, not truth or authority.
5. Freeze compaction inputs and account for the complete output. Use Pi's supported lifecycle.
6. Separate operational telemetry, source-known recall checks and actual agent outcomes. Test the programmatic baseline before optional model help.

These decisions can change when practical use contradicts them. None of the four repositories establishes that V4 has already improved an LLM's performance. The [V4 design](README.md) defines how to measure that result and how to change course.
