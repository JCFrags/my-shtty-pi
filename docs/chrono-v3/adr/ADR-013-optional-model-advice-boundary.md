# ADR-013: Optional model advice privacy and authority

Status: records the existing optional-advice boundary. It authorizes no provider call, new provider, or expanded model authority.

## Context

The package retains an optional value-advice subsystem from the compatibility path. That subsystem must not become a dependency of deterministic V3 ingestion or gain authority over protected instructions, source order, state, or final replay.

## Decision

Keep value advice separate and off by default. Existing modes are `off`, `shadow`, and `advisory`. The prompt builder uses opaque item IDs and bounded redacted excerpts only for eligible unprotected assistant/tool candidates. User/custom content, protected exact content, and unresolved safety-floor items receive no excerpt. Advice is typed and validated, not accepted as replacement replay text.

The deterministic application layer controls whether a bounded importance adjustment is allowed. Safety-floor items cannot be downgraded. Optional failure or absence leaves the core memory path available. The existing regular Pi summary is a different operation and remains required by the composer.

[A-0004](../amendments/A-0004-v3-timeline-and-catalog-scope.md) grants no new model authority, provider calls, or protected-input access. This record does not change that boundary. See [configuration](../configuration.md#retired-and-separate-controls) and [privacy policy](../privacy-policy.md).

## Alternatives

- Model-authored final replay can invent facts or remove conditions without deterministic provenance.
- Sending full history or protected instructions expands the privacy boundary.
- Mandatory model advice makes optional provider failure a core-memory failure.
- New embeddings or semantic workers are deferred, not implied by the existing subsystem.

## Consequences

Advice can only influence eligible bounded choices. Redaction is not proof that arbitrary private text is safe to send. Any authorized use still needs the existing explicit mode, budget, authentication, and privacy controls. No such call is needed to document or operate the deterministic stores.

## Migration

Preserve the default-off setting. Do not map older optional-advice configuration into a V3 enablement grant. The [prompt builder](../../../packages/pi-chrono-compaction/src/value-worker-prompt.ts), [settings/types](../../../packages/pi-chrono-compaction/src/value-worker-types.ts), and [application layer](../../../packages/pi-chrono-compaction/src/value-advice-application.ts) own the existing mechanics.

## Reversal path

Set the subsystem off through an authorized configuration change and cancel its own pending work at a safe boundary. Retain local advice records as private derived data. Do not change source history or deterministic memory identity to remove advice.
