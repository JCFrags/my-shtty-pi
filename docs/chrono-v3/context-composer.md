# Bounded context composition

The composer combines stored source-linked memory with the regular Pi summary and Pi's retained raw tail. It does not replace the regular summary, rebuild lifetime history, or add a provider. This page describes the [candidate](README.md#current-documentation-boundary), not acceptance of authoritative V3 use.

## Normal return path

When the memory engine or a valid canary is selected:

1. Pi supplies the prepared cut and retained tail. ChronoCompact checks the adjacent source boundary and tool-call/result safety.
2. The adapter pins a compatible state selection at the source cut. Missing mandatory category coverage or omissions refuse before the regular-summary request.
3. The existing Pi summary path produces a separate summary. Failure cancels compaction.
4. The composer renders protected restrictions and open work, selected older and recent chronological memory, supported bounded delta, and recovery references. Importance changes optional detail or selection, not the order of retained timeline rows.
5. Post-render validation checks mandatory coverage, the safe tail, and the fixed 30,000-token combined summary-and-tail ceiling. The adapter also rechecks session, branch leaf, and cancellation identity.
6. A successful return persists the minimal `chrono-v3-composed-context` envelope. Detailed rows and comparison data stay in owner-only artifacts.

Version 2.0.35 corrects settlement ordering: a triggered V3 compaction preserves the validated maintained search target before selection. Search retargeting is deferred while that request is pending and resumes after completion or refusal/error, subject to session, source, and epoch checks. Selection still requires a compatible prepared cut and validated coverage. It does not start ingestion, wait for catch-up, or retry compaction after refusal. Compatibility-mode incremental scheduling is unchanged.

The V3 return path uses Pi's prepared tail. Do not assume the compatibility path's dynamic-tail selection or a larger `targetContextTokens` value raises the V3 ceiling.

## Budgets and refusal

The charter's section-floor table is a design proposal, not the current configuration interface. The implementation uses bounded input/row sizes, separate mandatory category selection, optional-row reduction, and a hard combined cap. It never shortens a mandatory proposition merely to fit: its final condition or negation can change its meaning.

The pure composer supports degraded preview results such as last-good state or Pi-summary-plus-tail. That does not authorize the live adapter to return incomplete mandatory context. The normal adapter rejects incomplete protected/open-work coverage, unsafe tails, overflow, and a `pi-default-required` result. Selected V3 failures cancel compaction and preserve current context. They do not silently enter the legacy lifetime replay or invoke a rebuild.

The actual original large session still has unresolved mandatory-content overflow. State catch-up, packed proposition coverage, or `awaiting-cut-validation` is not evidence that this session can compact or roll over. Cut/category checks describe the implemented source extraction and selection, not semantic certification of every condition, approval, or unresolved task.

## Inspection and ownership

`/chrono-composition-preview [compaction-entry-id]` reads a supported recorded compaction and saves a bounded private comparison. It does not replace active context or enable the engine. A preview is not a live compaction, provider-continuation, or rollout result.

[ADR-010](adr/ADR-010-context-budgets-and-validation.md) records the budget and validation decision. [Configuration](configuration.md#composition-controls) owns effective controls. [Operations](operations.md#composition-behavior) owns the operator path. Implementation: [composer](../../packages/pi-chrono-compaction/src/context-composer.ts), [normal-return validation](../../packages/pi-chrono-compaction/src/composition-preview.ts), and [Pi hook](../../packages/pi-chrono-compaction/src/pi-extension.ts).
