# Local source synchronization review

Date: 2026-08-20

This review compares the seven public products with declared current local source. It does not approve installation, publication, release, or a lifecycle change.

## Method

- Use a local project authority record or active package registration to identify current source.
- Compare regular file bytes by relative path.
- Exclude Git metadata, dependencies, generated output, runtime state, private evidence, and credentials.
- Accept a source update only when the mapping is exact, the bytes are newer, the license permits the copy, and review evidence covers the bytes.
- Keep the public lifecycle and approval flags unchanged.

## Decisions

| Product | Version | Authority and byte result | License | Lifecycle | Decision |
|---|---:|---|---|---|---|
| ChronoCompact | 2.0.0 | The accepted V2 correction 020 is the current registered source. Its canonical accepted identity is `c526ef44d76b5149578687d05fc01067591083b21480a930b76bc8110ef0954f`. The public tree already contains its product source plus later public benchmark and package-boundary corrections. The comparison found 82 local and 84 public regular files: five changed paths, three public-only paths, and one local-only build report. No reviewed newer local product bytes exist. | MIT | quarantined | Unchanged. Do not reverse the later public corrections or copy the private build report. |
| Grounded Tools | 0.1.0 | The declared current source is the accepted Gate A source tree. Production source bytes match the public tree. The comparison found 72 local and 73 public regular files. Differences are one public-only artifact document, the public README, and the packed-artifact test. The public test has later public artifact-verification hardening. A later local Pi 0.84.1 assertion correction does not supersede that hardened test. The host LSP command correction is configuration, not package source. | MIT | experimental | Unchanged. No newer product source is available. |
| Progressive Tools | 0.1.2 | The declared current package basis maps exactly. Extension, policy, documentation, example, schema, and configuration bytes match. The public tree has later package-boundary metadata, compatibility text, a synthetic test path, and a lockfile. The local manifest file and ignore file do not supersede those public corrections. | MIT | experimental | Unchanged. No newer reviewed local bytes exist. |
| Tool Controls | 0.1.0 | Provenance identifies a licensed Mouse-TUI source artifact. No project authority record or active package registration identifies a newer current local tree. | MIT | host-dependent | Unchanged because no exact current local mapping exists. |
| Review UI | 0.1.0 | Provenance identifies a licensed Mouse-TUI source artifact. No project authority record or active package registration identifies a newer current local tree. | MIT | blocked | Unchanged because no exact current local mapping exists. |
| Files UI | 0.1.0 | Provenance identifies a licensed Mouse-TUI source artifact. Files UI stabilization remains deferred. No project authority record or active package registration identifies a newer current local tree. | MIT | candidate | Unchanged because no exact current local mapping exists. |
| Herdr Status | 0.1.0 | Provenance identifies a licensed Mouse-TUI source artifact. No project authority record or active package registration identifies a newer current local tree. The separate Herdr deck is not this product. | MIT | candidate | Unchanged because no exact current local mapping exists. |

## Exclusions

The review did not copy source custody records, sessions, private evidence, host paths, runtime state, generated output, dependency trees, credentials, archives, or third-party dependency source. Historical and extracted Mouse-TUI trees were evidence only. Dirty historical Chrono trees were not candidates.

## Result

No public product bytes qualify for replacement. All lifecycle labels and all `false` approval flags remain unchanged. A later synchronization must repeat authority, byte, acceptance, provenance, and license checks against then-current state.
