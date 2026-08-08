# pi-files-ui

`pi-files-ui` is a standalone Pi package that adds `/files`: a fullscreen repository tree, text preview, and context-selection browser rooted at the active session's `ctx.cwd`.

The browser only edits the existing Pi editor buffer through `ctx.ui.pasteToEditor`. Opening it, selecting files, previewing files, and inserting text never submits the editor or starts an agent turn.

## Requirements

- Node.js 22.19 or newer
- Pi with `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` available as core peer packages
- An interactive Pi TUI session

## Install

Install a local checkout:

```bash
pi install /absolute/path/to/pi-files-ui
```

For project-local installation:

```bash
pi install -l ./path/to/pi-files-ui
```

After npm publication, the equivalent package source is:

```bash
pi install npm:pi-files-ui
```

For development without changing Pi settings:

```bash
pi -e ./extensions/files/index.ts
```

## Usage

Run:

```text
/files
```

On wide terminals the overlay renders independent Tree and Preview panes. On terminals narrower than 78 columns, it switches to one pane with `Tree` and `Preview` tabs rather than producing unusably narrow columns.

The header reports the selected-file count and an approximate context cost. Header cost uses known selected-file sizes divided by four. The insertion budget uses the exact decoded Unicode character count and reports `ceil(characterCount / 4)` as **approximate tokens**.

## Mouse controls

Pi's first-class mouse API is used when the host exposes it. The package does not enable a raw terminal mouse mode as a fallback because that would interfere with Pi's application-owned text selection. Keyboard operation remains complete when a first-class mouse API is unavailable.

| Action | Mouse behavior |
|---|---|
| Expand or collapse a directory | Click its caret or row |
| Preview a file | Click its row |
| Select or unselect | Click the checkbox cell; directory checkboxes apply recursively to bounded, non-ignored file descendants currently allowed by the Hidden toggle |
| Select a range | Shift-click a row to extend a contiguous range in the current visible flat list |
| Scroll | Wheel over Tree or Preview; each pane has independent scroll state |
| Select preview text | Drag in Preview; row activation deliberately does not consume preview press, move, or release events |
| Activate an action | Press and release on the same button; moving or dragging away cancels activation |
| Right-click | Unused |

## Keyboard controls

| Key | Action |
|---|---|
| Up / Down | Move through visible tree rows, or scroll Preview when Preview is focused |
| Left | Collapse the focused directory; otherwise move to its visible parent |
| Right | Expand the focused directory; if already expanded, enter its first visible child |
| Space | Select or unselect the focused file or directory subtree |
| Shift+Up / Shift+Down | Extend a contiguous selection range |
| Tab / Shift+Tab | Cycle Tree, Preview, and the four action buttons |
| PageUp / PageDown | Scroll the focused pane by one page |
| Enter | Preview a file, expand/collapse a directory, or activate the focused action |
| `/` | Open the incremental filename/path filter |
| Escape | Clear the active filter first; otherwise close the budget dialog or browser |
| `H` | Toggle hidden files while Tree is focused |

Selection survives filtering. Selected files that are hidden, filtered out, or under collapsed directories appear in a supplemental `Selected (collapsed, hidden, or filtered)` section.

## Filesystem scope and ignore behavior

The model is rooted at the canonical path for `ctx.cwd` and uses Node filesystem APIs only. It does not call `find`, `ls`, `cat`, `git`, or another shell command.

Default behavior:

- directories are loaded only when expanded, selected recursively, searched, or required to restore a selected path;
- `.git/`, `node_modules/`, common build output, coverage, and cache directories are excluded;
- root and nested `.gitignore` files are applied, including comments, negation, anchored patterns, directory-only patterns, `*`, `?`, character classes, and `**`;
- hidden path segments are omitted until the visible `Hidden` toggle is enabled, except that an already selected hidden file remains visible in the supplemental selection section; recursive directory selection likewise excludes hidden descendants until Hidden is enabled;
- sorting is deterministic and locale-independent: directories first, then other entries, case-insensitive lexical order with the original spelling as a stable tie-breaker;
- one directory listing is capped at 10,000 entries and displays a truncation warning;
- filter traversal is bounded to 50,000 scanned entries and 5,000 displayed matches;
- errors are attached to the affected node and do not terminate the overlay.

The package does not install repository-wide recursive watchers. While open, it performs a bounded refresh every two seconds across selected files and a rotating subset of already loaded directories. All timers, searches, mouse listeners, and model state are disposed on close and on Pi session shutdown.

## Symlink policy

- Directory symlinks are displayed with their target but never traversed.
- File symlinks are displayed with their target.
- A symlink target must resolve inside the canonical `ctx.cwd` root before preview or insertion.
- Outside-root, broken, and non-file symlinks cannot be inserted.
- File content is revalidated immediately before preview and insertion, reducing time-of-check/time-of-use exposure.

## Preview limits

Text preview defaults to whichever limit is reached first:

- 200 KiB; or
- 5,000 lines.

The preview displays line numbers, an explicit UTF-8 assumption, invalid UTF-8 replacement status, byte/line truncation status, and a `file changed` indicator after an mtime or size change. Tabs are expanded to four-column tab stops for display only. Terminal control characters and bidirectional-formatting controls are rendered as visible, inert text so file names and previews cannot manipulate the TUI; exact valid UTF-8 payloads remain unchanged for insertion.

NUL bytes and common binary signatures—including image, archive, executable, database, PDF, WebAssembly, and compound-document signatures—produce metadata-only previews. File contents are never evaluated or executed.

## Inserting paths

`Insert paths` pastes an editable plain-text block using normalized relative paths:

```text
Files to inspect:
- relative/path/one.ts
- relative/path/two.md
```

Ordinary paths are inserted unchanged. Exceptional path backslashes, line breaks, terminal controls, and bidirectional-formatting controls use reversible visible escapes so each selected file remains one bullet. The package does not depend on undocumented `@file` quoting or expansion rules.

## Inserting contents and budget limits

`Insert contents` always opens a budget dialog before any editor modification.

Default limits:

- 100 KiB per file;
- 400 KiB total;
- approximate token estimate `ceil(characterCount / 4)`.

Binary files, invalid UTF-8 files, outside-root symlinks, unreadable files, and files over the per-file limit remain listed but cannot be included. Files that would exceed the total limit remain listed and excluded; deselect another eligible file to make room, then include the desired file.

### Length-delimited insertion format

The package uses `pi-files-ui:length-delimited-v1`:

```text
<selected_files format="pi-files-ui:length-delimited-v1">
<file path="relative/path/one.ts" encoding="utf-8" bytes="123" characters="120">
...exact decoded UTF-8 content...
</file>
</selected_files>
```

The `bytes` attribute is the UTF-8 byte length of the payload immediately following the file-header newline. A parser reads exactly that many bytes before interpreting the following newline and `</file>` delimiter. Therefore, a literal `</file>` sequence inside a selected file is unambiguous and remains unchanged. XML-sensitive characters are escaped in the `path` attribute, and path control, line-break, and bidirectional-formatting characters use numeric references so every header remains one inert line. Payload content is not XML-escaped or normalized.

After either insertion action, the overlay closes and leaves the inserted block editable in Pi's existing editor. It does not call a submit, prompt, send-message, or agent-turn API.

## Package structure

```text
pi-files-ui/
├── extensions/
│   └── files/
│       └── index.ts              # /files registration and Pi lifecycle integration
├── src/
│   ├── binary.ts                 # binary signatures and NUL detection
│   ├── constants.ts              # listing, preview, filter, and budget limits
│   ├── file-read.ts              # bounded byte reads and UTF-8 decoding
│   ├── filesystem.ts             # lazy repository tree and symlink containment
│   ├── gitignore.ts              # nested ignore-rule evaluation
│   ├── insertion.ts              # budgets and length-delimited serialization
│   ├── path-utils.ts             # normalization and deterministic comparison
│   ├── preview.ts                # cached, bounded preview service
│   ├── types.ts
│   └── ui/
│       ├── files-browser.ts      # fullscreen component and interaction state
│       ├── key.ts                # keyboard sequence decoding
│       ├── layout.ts             # responsive wide/narrow geometry
│       ├── mouse.ts              # first-class mouse capability adapter
│       └── text.ts               # ANSI-safe terminal-width rendering
├── test/                         # temporary-tree and UI behavior tests
├── scripts/
│   └── smoke.ts                  # packed-tarball load smoke test
├── types/pi.d.ts                 # compile-time Pi API surface used by the package
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm run validate
```

`npm run smoke` builds the package, creates an npm tarball with lifecycle scripts disabled for the nested pack operation, extracts it, verifies required source and compiled resources, imports the packed extension, registers `/files`, renders the browser against a temporary repository, confirms that opening it does not paste anything, and invokes session-shutdown cleanup.

## Uninstall

Remove the same package source used during installation:

```bash
pi remove /absolute/path/to/pi-files-ui
```

or, for an npm installation:

```bash
pi remove npm:pi-files-ui
```
