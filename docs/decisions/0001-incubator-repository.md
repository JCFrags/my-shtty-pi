# Decision 0001: incubator repository

## Decision

Use one public repository for an independent community Pi package incubator. It contains seven products and fifteen release units. Each product and release unit has an independent package and release boundary.

The root is a private npm control plane. It is not a workspace and is not an install boundary. Root `private: true` prevents accidental root publication; it does not make the public GitHub repository private.

No package is stable, generally recommended, or publication-approved. The lifecycle model uses five descriptive statuses: `quarantined`, `experimental`, `host-dependent`, `blocked`, and `candidate`. See the [package status definitions](../package-status.md). Lifecycle status is not installation or publication approval. Stabilization and publication are package-specific decisions.

Private deployment and runtime state remain separate from this public repository. Foundation 0 does not change package behavior, readiness, publication, deployment, registrations, or live state.

## Consequences

Repository merge, package readiness, and package publication are separate decisions. Files UI is the intended first stabilization pilot. Future decisions may split products or release units when package scope, ownership, failure domains, or deployment boundaries require it. Such splits are deliberate future decisions, not assumptions made by this foundation work.
