# Immediate Next Steps

## 1. Install and run the audit

Install the package and run `/tool-audit` in a normal project.

Record:

- Tool names.
- Exact source values.
- Exact paths.
- Active schema token estimate.
- Tools with prompt guidelines.
- Tools that replace core names.

## 2. Approve a small first set

Do not approve all non-built-in tools at once.

Start with one trusted extension or three to five exact tool names. Add one capability area and useful task aliases.

Use name rules first when you are not sure that every tool from the source should be hidden.

## 3. Test ten real tasks

Use normal work, not synthetic prompts.

For each task, record whether the model:

- Called `search_tools` when needed.
- Found the correct tool.
- Loaded too many tools.
- Used a generic workaround instead.
- Said that a capability was unavailable.

## 4. Improve aliases and descriptions

Fix missed searches with small metadata changes:

- Add service names.
- Add common task verbs.
- Add abbreviations.
- Add workflow phrases.
- Fix weak tool descriptions in the source extension when possible.

Do not add embeddings yet.

## 5. Review large or prompt-heavy tools

For every `large-schema` or `prompt-guidelines` warning, choose one action:

- Leave it unmanaged.
- Patch it.
- Split it.
- Add a smaller adapter.
- Accept the cost because the tool is important.

## 6. Check cache behavior

Compare normal requests before and after a search.

Confirm that search activation is additive. Avoid removing tools during an active agent run. Use `/tool-reset` only at a clear turn boundary.

## 7. Add one trusted source rule

After name-based testing, replace repeated exact names with one source or path rule only when the complete source is trusted.

This rule will also manage future tools from that source.

## 8. Decide whether automatic routing is needed

Add automatic routing only when the logs show that the model often fails to call `search_tools` for clear requests.

The first automatic rules should use strong signals, such as an exact service URL or service name. Keep uncertain cases on model-directed search.

## 9. Propose a manifest format

After two or three extensions work well, define the smallest shared capability manifest. Do not design the complete stretch system before real use shows which fields are needed.
