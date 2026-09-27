---
title: Context selection and recall
audience: [agents, maintainers]
status: current reference
purpose: Explain what enters the model request and how omitted detail is recovered.
related:
  - ../README.md
---

# Context selection and recall

The [session-agent compaction contract](session-agent-compaction.md) defines the approved correction now in development: the session agent's own continuation summary, compressed chronological events, and only the necessary exact tail. Actual output and activation are not yet accepted. The pages below also describe the retained 4.0.1 implementation and must not override that corrected target.

- [Compaction and budgets](compaction-and-budgets.md): public Pi hook, V3 and V4 paths, frozen receipts, fitting, and refusal.
- [Retention and tool-result projections](retention-and-projections.md): graded detail, advisory hints, and stable text between compactions.
- [Current-state Recall](recall.md): bounded native cards, active-tool requirements, coverage, and recovery.

Compaction selects data. It does not change provider state, delete history, or grant authority.

[Documentation index](../README.md) · [Configuration](../operations/menu-and-configuration.md)
