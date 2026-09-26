---
name: pi-feedback
description: Use when actual Pi work exposes tool friction, a missing capability, a reproducible or unverified bug, or when the user asks to review shared Pi feedback. Not for speculative wish lists or permission to fix reported problems.
---

# Pi feedback

Use GitHub Issues in `JCFrags/my-shtty-pi` for useful feedback from real work. Keep private diagnostic context local. Run `/skill:pi-feedback review` for a read-only review.

## Check before reporting

1. Check the available capabilities with `list_tools` and exact-name `tool_help`, when present. Read the relevant installed documentation and inspect current behavior. Do not report a missing capability that already exists but is not loaded.
2. Identify the component and the selected and actually loaded versions when known. Distinguish source versions from loaded versions. State `unknown` rather than infer activation from a checkout or build.
3. Read [private evidence](references/private-evidence.md) for the configuration and privacy checks. Read only the user-local `~/.config/pi-feedback/local.json`, not a repository copy. A protected, valid version-1 configuration with `repository: "JCFrags/my-shtty-pi"` and `reportingEnabled: true` records the user's standing approval to create screened issues and add relevant evidence comments in that repository only. Missing, false, invalid, or unsafe configuration means draft only.
4. This skill does not create or widen approval. Do not enable reporting, change the repository, or configure credentials without separate approval. A narrower current user request still applies. Reporting does not authorize fixes, merges, issue closure, or other scope changes.

## Find an existing report

Search both open and closed issues, including reports without the `agent-feedback` label. Search related pull requests, including merged and closed ones. Use the observed component, behavior, or sanitized error terms. Read likely matches, their comments, and linked pull requests before deciding.

Prefer WebX for public reads. Use `gh` for authenticated reads or precise repository queries when appropriate. For example, after setting `terms` to relevant public search terms:

```sh
gh issue list --repo github.com/JCFrags/my-shtty-pi --state all --search "$terms" --limit 100
gh pr list --repo github.com/JCFrags/my-shtty-pi --state all --search "$terms" --limit 100
```

A failed or truncated search does not establish that no report exists. Read results with WebX or `gh issue view` / `gh pr view`, with the same explicit `--repo` and `--comments`.

- If a report already covers the observation, add a comment only for useful new evidence, impact, reproduction details, or a materially different loaded version. Otherwise, return its link without another comment.
- If a closed report appears to recur, read its resolution first. Add relevant new evidence without reopening it. Create a separate issue only for a distinct problem, and link the prior report.
- For a new issue, choose one existing label: `bug`, `enhancement`, or `question`. Also use `agent-feedback`. Do not create a new label taxonomy. If a required label is absent, keep the draft and report the setup gap.

## Prepare and publish

1. If private context helps diagnosis, create or reuse an exact PF record as described in [private evidence](references/private-evidence.md). Do not allocate empty records for public-only reports.
2. Copy [the public report template](templates/report.md) into a separate local public draft outside Git. Replace its placeholders. For a comment, keep only the useful new information. Never use private `note.md` as the public draft or as a `--body-file`.
3. Keep the public report useful by itself. Include the component, versions, expected and actual behavior or missing capability, impact, reproduction or observations, related reports, and uncertainty. Mark unverified bugs as unverified. A proposed fix is optional, not a commitment.
4. Screen the exact title and body before submission. Remove secrets, credentials, raw sessions, personal information, private account or host identifiers, and private local paths. Never publish `evidenceRoot`, helper path output, private notes, or unscreened attachments. Identify the repository owner only as `JCFrags`. Check the intended GitHub account and destination without printing credentials.
5. Recheck the protected local configuration immediately before a write. Use `gh` with the explicit repository and a reviewed public `--body-file`. Set the variables below to the reviewed title, public draft path, chosen label, or an issue number from this repository. Run only the selected operation:

```sh
# New issue. kind is bug, enhancement, or question.
gh issue create --repo github.com/JCFrags/my-shtty-pi \
  --title "$title" --label "$kind" --label agent-feedback --body-file "$public_draft"

# Useful new evidence on an existing issue.
gh issue comment "$issue_number" --repo github.com/JCFrags/my-shtty-pi \
  --body-file "$public_draft"
```

6. Read the returned issue or comment URL. Confirm the repository and saved content. A timeout or uncertain response is not proof of failure. Search for the title or exact PF ID and inspect existing comments before retrying. Do not blindly repeat a write.
7. Record the verified issue URL in the private note, if one exists. Tell the user whether feedback was published, remains a draft, or was not needed because an existing report covers it.

Keep confirmed lessons in their owning skills or references. Follow `durable-learning` when installed, and include an issue link where useful. An issue does not replace durable guidance.

## Review

For `/skill:pi-feedback review`, read the `agent-feedback` issues and relevant related reports and pull requests. Include open and closed reports so resolved work is not presented as pending. Resolve private evidence only by exact PF ID and only within current local access approval.

Summarize the issue links, component, status, impact, known evidence, and gaps. State when evidence is unavailable or a fix is not known to be loaded. Review is read-only. Do not post comments, change issue state, implement fixes, or merge work merely because review was requested.
