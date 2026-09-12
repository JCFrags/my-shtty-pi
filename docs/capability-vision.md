# Capability vision

## Desired experience

Agents should always have enough concise awareness of available capabilities to select the right one. They should not need every instruction, command option, and parameter schema before they know what the task requires. Users should be able to request an outcome without knowing whether the work uses a native Pi tool, an independent command-line interface (CLI), a skill, or a useful combination.

The initial description should explain when to use a capability. It should name the important tasks, symptoms, and boundaries, not just a product or broad subject. "Extract text and tables from documents, fill forms, and handle scanned pages" helps selection. "Document utilities" does not. Necessary restrictions must remain clear at the point where they affect a decision.

Detailed instructions and schemas should become available when needed, before the agent attempts the operation. This separates awareness, learning how to use a capability, and using it. In Pi, a textual tool listing and the callable tool definitions supplied to the model are separate. Shortening the listing alone does not defer schemas or make an inactive tool callable.

## Use the form that fits the work

Native tools remain useful for basic operations, Pi-specific state, and interactive functions that depend on the current session. A native interface can provide structured input, direct feedback, and the controls needed for a safe interaction. The vision does not require replacing these functions with shell commands.

Independent software should remain useful outside Pi. A CLI can expose its operations to people, scripts, and other agents. A skill can explain when to use that software, its prerequisites, the correct workflow, and how to interpret results. This avoids making a standalone program depend on one agent harness.

Skills are capabilities in their own right, not a lower-class substitute for native tools. Their role is workflow guidance and documentation. A skill can coordinate several tools, explain decisions, or guide work that has no single executable operation. A reference describes the subject. A procedure explains how to perform the task. Both can support a skill without becoming separate native tools.

Thin combinations are useful when they provide a clear benefit. A native tool might manage an interactive session while a skill explains the surrounding workflow. A skill might use an independent CLI and a native file tool together. Such combinations should preserve useful standalone behavior and avoid duplicate implementations. There is no requirement to convert everything, choose one form for every capability, or create one native tool per operation.

## Progressive disclosure can have several levels

Progressive disclosure means showing enough information to choose the next step, then loading the detail needed for that step. Pi already does this for skills: the initial context lists names, descriptions, and locations, while the agent reads full skill instructions when a task matches.

A parent skill can apply the same approach within a subject. A document-processing skill could route scanned pages to `references/scanned-pages.md` and form work to `procedures/fill-forms.md`. The parent explains which file applies and when to read it. The agent does not need every procedure and reference for every document task.

Nesting must not hide useful functionality. If only the parent description is initially visible, it must expose the important task triggers, including less obvious supported work. A child file cannot help selection if the agent has no reason to look for it. Reading the parent does not automatically load its linked files or make nested skills separate prompt entries.

Each level should answer a practical question: does this capability fit, which procedure applies, or what detail is needed now? More levels are useful only when they make selection and use clearer. A short skill can stay short and direct.

## Keep ownership and boundaries clear

Documentation should stay aligned with the software that owns the behavior. Skills should point to maintained usage instructions and relevant references instead of copying large command manuals or schemas that can drift. Workflow guidance should state the prerequisites and version constraints that matter for safe use.

Awareness is not permission. A description, linked procedure, or tool-loading step must not bypass project trust, tool exclusions, access controls, or required user approval. Native tools, CLIs, and combinations remain subject to those boundaries. An unavailable or unapproved operation should be reported as such, not silently reached through another interface.

## Small steps toward the vision

This is a long-term direction, not approval for a broad migration. It does not prescribe an architecture, registry, protocol, automatic discovery mechanism, or how Progressive Tools must be built.

The immediate work can be small, manual, and usable: improve a short description, provide a clear route to existing help, or expose detail when a real task needs it. Perfect token savings and automatic discovery are not prerequisites.

Success means that agents select suitable capabilities, read the relevant guidance, respect limits, and complete the requested work with fewer guesses. Users keep useful native interactions and independent software. Maintainers keep clear ownership and less duplicated documentation. Any claims about token savings or runtime behavior still require measurement.
