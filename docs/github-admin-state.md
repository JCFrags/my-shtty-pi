# Applied GitHub administration state

- **Application date:** 2026-08-09
- **Repository:** `JCFrags/my-shtty-pi`
- **Pre-administration main:** `d1b5b4428f3e9591bbdcd314bc9ae216f3cae807`

## Branch protection

The active repository ruleset is **Protect main** (ID `20623625`). It targets the exact ref `refs/heads/main`. The ruleset is active. Its bypass list is empty, and `current_user_can_bypass` is `never`.

The ruleset requires pull requests and permits zero approving reviews. It does not require code-owner review, last-push approval, stale-review dismissal, or review-thread resolution. The allowed merge method is merge only. The required status check is **Repository integrity**, identified as the GitHub Actions slug `github-actions` with App ID `15368`. Strict base freshness is required. Branch deletion and non-fast-forward updates are blocked.

## Repository settings

Merge commits are enabled. Squash merges and rebase merges are disabled. Automatic branch deletion is false. Auto-merge is false.

The following material settings were deliberately left unchanged: repository name; repository visibility; default branch; issues and wiki; topics; description and homepage; archived and fork settings; Actions permissions and workflow approval; Dependabot; secret scanning; CodeQL; releases and tags; webhooks; collaborators; notifications; environments; deployment protection; other security products; GitHub CLI authentication settings; and private deployment state.

## Administration records

Private vulnerability reporting is enabled.

Milestone **#1 Foundation 0** is open during the administration-record PR. Seventeen managed labels are present:

- `foundation`
- `security`
- `packaging`
- `release`
- `documentation`
- `package:chrono-compact`
- `package:grounded-tools`
- `package:progressive-tools`
- `package:tool-controls`
- `package:review-ui`
- `package:files-ui`
- `package:herdr-status`
- `status:candidate`
- `status:experimental`
- `status:blocked`
- `status:host-dependent`
- `status:quarantined`

No package became ready, installable, or publishable. Files UI stabilization did not start.

During the administration-record PR, milestone #1 Foundation 0 is open. The controlled post-merge step closes it only after this PR merges and the main workflow succeeds. The completed administration handoff records its final state as closed.
