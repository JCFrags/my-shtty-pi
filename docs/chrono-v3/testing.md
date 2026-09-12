# Verification and evidence boundaries

This page maps existing verification owners. It adds no test framework, campaign, or acceptance result. Apply the [candidate boundary](README.md#current-documentation-boundary) and the [decision protocol](decision-and-update-protocol.md).

## Select the existing check

| Question | Existing owner |
| --- | --- |
| Does the package typecheck and compile? | `typecheck` and `build` in the [package scripts](../../packages/pi-chrono-compaction/package.json). |
| Do normal deterministic and integration checks pass? | `test:normal` in the package. The [historical inventory](historical-test-inventory.md) explains restored coverage, not current-candidate results. |
| Do fixed-heap and fault lanes pass? | `test:fixed-heap` in the package and its existing bounded harness. |
| Is the selected native binding valid? | The controlled build and allocation-refusal probe in [ADR-002](adr/ADR-002-sqlite-catalog.md). A pragma readback alone is insufficient. |
| Do generated artifacts and repository inputs match? | Root `npm run verify`, the [baseline verifier](../../scripts/verify-chrono-v3-baseline.mjs), and the existing [CI workflow](../../.github/workflows/verify.yml). |
| Is outgoing material safe to publish? | The exact-scope checks in [privacy policy](privacy-policy.md). |
| Does actual Pi switching and recovery work? | The existing [logical Pi qualification harness](../../packages/pi-chrono-compaction/scripts/m11-logical-pi-qualification.mjs), with its own candidate-bound receipt. |
| Does the required multi-session scale work? | The [M11 qualification plan](reviews/M11-qualification-plan.md) and [scale harness](../../packages/pi-chrono-compaction/scripts/m11-scale-campaign.mjs). |
| Are intended local processes using the change? | The loaded-identity and practical checks in [deployment](deployment.md), separate from all build results. |

Use the assigned verification scope. A small documentation change needs link/content checks, not a new scale campaign. Do not repeat an active qualification run or extend a suite without a concrete need and the required authority.

## Execution prerequisites

Install from the committed lock without dependency scripts, then follow ADR-002's controlled native build. Any reinstall removes the prepared addon, so build/probe after the last reinstall. Finish the package build before tests or workers that load `dist`. Do not rebuild a shared package while those workers run. Keep giant synthetic data, private histories, and raw logs outside Git.

## Interpret results narrowly

Record the exact source/package identity, command, dataset scope, exit result, and unavailable measurements. Use `passed`, `failed`, and `not run` distinctly.

- A store or core fixture does not prove installed-Pi session replacement.
- An installed-Pi scenario does not prove billion-token multi-session scale.
- Process restart is not an operating-system reboot or device power-loss test.
- Source-helper bytes, native database I/O, worker RSS, and host RSS are different measurements.
- Ready checkpoints or complete selected categories are not semantic certification or proof that mandatory context fits.
- Provider-free composition fixtures do not establish model continuation quality.

The actual original large-session mandatory overflow is unresolved. Earlier revision results and the retained failed M11 preparation cannot become a final-candidate pass by documentation. No M11 or M12 acceptance is claimed.
