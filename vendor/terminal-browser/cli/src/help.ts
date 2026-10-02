import { ACTION_MIGRATION } from "./errors";

interface CommandHelp {
  summary: string;
  usage: string;
  body: string;
}

const COMMANDS: Record<string, CommandHelp> = {
  open: {
    summary: "Open the browser in a terminal pane",
    usage: "terminal-browser open [url] [options]",
    body: `
Opens the browser in the current pane. Pass --split to open it in a new
split pane instead.

The url can be a normal url, a localhost port, or a path to an html file.
For native automation, supply both --session and --project. The project is
canonicalized at launch. Keep the terminal open and run agent or session tabs
from another shell with the same options. An owned launch never merges into a
neighbor browser and refuses a duplicate owner. No host-agent setup runs.

Options:
  --session <id>        Own this native session without Pi or Herdr
  --project <directory> Fixed project root for that session's files (with --session)
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     How much of the space the split takes (0.2 to 0.95)
  --ssh <user@host>     Perform all network requests through a remote server, then
                        proxy the result back to the local terminal-browser instance
  --ssh-bundle <dir>    Install and execute a bundle on a remote server. This is useful when paired with
                        --app-mode and --ssh, allowing you to run an application server on a
                        remote machine, then view the output over ssh
  --ssh-bundle-dir <dir>
                        The path --ssh-bundle should be installed to through the ssh server. Defaults to
                        \${XDG_DATA_HOME:-~/.local/share}/terminal-browser/bundles
  --preload=<path>      Run a script inside the context of a web page before it loads (uses electron's preload feature under the hood, runs in an isolated world).
                        terminal-browser specific api's are exposed on globalThis.terminalBrowser
                        {
                          theme: () => { background: [r,g,b], foreground: [r,g,b], ansi: ([r,g,b] | null)[] } | null, // null until the terminal reports its colors
                          onTheme: (cb: (theme: Theme) => void) => () => void, // returns unsubscribe
                          quit: () => void // closes this browser window
                        }
                        --terminal-browser-session=<key> is passed as extra arguments to the renderer process, available via process.argv
  --main-script=<path>  Run a node.js script in the same process as the browser (this is an electron main process)
  --open-tabs-in-popup-stack Links that would open a new tab open a popup over the
                        page instead.
  --allow-clipboard-read
                        Lets websites read from clipboard.
  --no-toolbar          No toolbar or tab strip
  --no-shortcuts        No browser shortcuts
  --no-context-menu     No right-click menu
  --no-overlays         No toasts or HUDs drawn over the page
  --no-frame            No border or padding around the web page
  --app-mode            Enables configuration to disable terminal-browser features to make optimal for application embedding
  --app-name=<name>     The name of the application
  --app-id=<id>         The identifier of the application
  --no-merge            Do not open the terminal-browser instance as a tab in a neighbor terminal-browser


Examples:
  terminal-browser open localhost:3000
  terminal-browser open ./report.html --split right
  terminal-browser open github.com/zenbu-labs --split down --size 0.4
  terminal-browser open --ssh dev@build-box localhost:8080
`,
  },
  ls: {
    summary: "List running browsers and their tabs",
    usage: "terminal-browser ls [options]",
    body: `
Lists the browsers running in this terminal tab, each with its tabs. The tab
ids it prints are what --tab takes in terminal-browser agent.

Options:
  --all               Every browser, not just this terminal tab
  --json              Machine readable, including browser keys and pane ids
`,
  },
  setup: {
    summary: "Configure terminals and agents so terminal-browser works best",
    usage: "terminal-browser setup",
    body: `
Sets up configuration to make terminal-browser work best, this includes:
- installing agent skills
- enabling configuration settings in terminals that is required for terminal-browser to work

`,
  },
  upgrade: {
    summary: "Upgrade to the latest release",
    usage: "terminal-browser upgrade",
    body: `
Checks this install's release channel and installs the latest version. Does
nothing when already up to date.
`,
  },
  "new-tab": {
    summary: "Open a tab here, and a browser too if there is none",
    usage: "terminal-browser new-tab [url] [options]",
    body: `
Opens a tab in a browser already open. By default, if there is a single
browser open in the current terminal tab, it will open a tab in that browser.
If there are no browsers, a new browser will be opened with the specified tab
as the initial (if ran from a shell without a TTY, it will open in a split to
the right). If there are multiple browsers, new-tab will error and a
--browser <key> is a required argument (<key> can be found by running
terminal-browser ls)

Options:
  --browser <key>     A browser key from terminal-browser ls

Examples:
  terminal-browser new-tab github.com
  terminal-browser new-tab --browser 90107-1 localhost:3000
`,
  },
  apps: {
    summary: "Lists registered terminal-browser apps",
    usage: "terminal-browser apps [--json]",
    body: `
Lists the id, name, and binary path of registered terminal-browser apps. Apps can be registered
using terminal-browser register-app. If an app is registered it can be opened through the terminal-browser
new tab command palette after searching for its name.
`,
  },
  "register-app": {
    summary: "Register a terminal-browser application",
    usage: "terminal-browser register-app --name <name> --bin <path> [--id <id>] [--args \"…\"]",
    body: `
Registers metadata for a terminal-browser application to ~/.local/share/terminal-browser-interop/apps/<id>.json. This enables functionality
when a user is using terminal-browser, and lets other applications discover terminal-browser apps.
`,
  },
  "unregister-app": {
    summary: "Unregister a terminal-browser application",
    usage: "terminal-browser unregister-app <id>",
    body: `
Remove application metadata from ~/.local/share/terminal-browser-interop/apps/<id>.json.
`,
  },
  shutdown: {
    summary: "Stop the daemon",
    usage: "terminal-browser shutdown",
    body: `
Every browser in a terminal pane shares one browser process as an optimization. To
fully quit terminal-browser operations, you can use this shutdown command. This will
close all open browsers.
`,
  },
  agent: {
    summary: "Observe, control, and act through native AgentCursor",
    usage: "terminal-browser agent <observe|upload|click|hover|drag|type|press-key|scroll|navigate|get-url|wait-for|dialog|blocking|status|pause|resume> [options]",
    body: `
Reads a fresh observation and performs native actions on the selected tab.
Success responses are JSON on stdout. Failures exit nonzero and write
{ok:false,error:{code,message}} on stderr. Startup failures also retain their
startup report fields. Observation-bound actions require the latest observation
and control epoch. Navigation invalidates earlier observations. Never replay a
possibly delivered action or resume human control without an explicit request.

Uploads accept 1–16 regular files within the owning project, at most 32 MiB each and 64 MiB total. Secret paths and symlink escapes are rejected. The launch project root stays fixed. Use another explicit session/project or reopen the Herdr companion to change it. CLI relative paths use the current working directory. A visible native click opens the chooser; no file contents are returned.
Downloads: session tabs --session <id> --project <directory> --action downloads [--tab <id>], or --action download_wait|download_cancel --download-id <id> [--timeout-ms <n>]. Herdr callers can use companion tabs. Saved files stay under .terminal-browser-downloads in the owning project and are never opened.

Commands:
  terminal-browser agent observe [options]
  terminal-browser agent upload (<ref> | --locator-json <steps>) --files-json '["relative/file.txt"]' --observation <id> --control-epoch <n> [options]
  terminal-browser agent click (<ref> | --locator-json <steps>) --observation <id> --control-epoch <n> [options]
  terminal-browser agent hover (<ref> | --locator-json <steps> | --x <n> --y <n>) --observation <id> --control-epoch <n> [options]
  terminal-browser agent drag (--from-ref <ref> | --from-locator-json <steps> | --from-x <n> --from-y <n>) (--to-ref <ref> | --to-locator-json <steps> | --to-x <n> --to-y <n>) --observation <id> --control-epoch <n> [options]
  terminal-browser agent type (<ref> | --locator-json <steps>) (--text <text> | --stdin) --observation <id> --control-epoch <n> [--replace] [options]
  terminal-browser agent press-key <key> --observation <id> --control-epoch <n> [options]
  terminal-browser agent scroll --dy <n> [--dx <n>] --observation <id> --control-epoch <n> [options]
  terminal-browser agent dialog --tab <context-id> --dialog-id <id> --control-epoch <n> (--accept | --dismiss) [--text <text> | --stdin]
  terminal-browser agent navigate <url> --control-epoch <n> [options]
  terminal-browser agent get-url --control-epoch <n> [options]
  terminal-browser agent wait-for (--ref <ref> | --locator-json <steps> | --text <text>) [--condition exists|visible|text|actionable] [--timeout-ms <n>] --observation <id> --control-epoch <n> [options]
  terminal-browser agent blocking status [options]
  terminal-browser agent blocking <enable|disable|clear-diagnostics|reload> --control-epoch <n> [options]
  terminal-browser agent blocking <allow-site|block-site> --site <site> --control-epoch <n> [options]
  terminal-browser agent status [--browser <key>]
  terminal-browser agent pause --control-epoch <n> [--browser <key>]
  terminal-browser agent resume --control-epoch <n> [--browser <key>]

Blocking status is read-only and remains available while paused. Every blocking
mutation requires the current control epoch. No command enables blocking or
resumes control implicitly. Blocking uses the same owner and --tab selectors.

Context waits: companion tabs --action wait --after-id <last-context-id> [--timeout-ms <0..60000>].
Use companion tabs --action list to read context IDs and opener IDs.
Dialogs never auto-accept. Use the exact dialog ID, context, and epoch returned by
observe or an interrupted action. A response can run while that action is blocked.

Common options:
  --session <id>        Select an exact native session (requires --project)
  --project <directory> Select its canonical owning project
  --browser <key>       Narrow the owner selection; never override ownership
  --tab <id>            Select a stable tab or native popup context ID
  --observation <id>    Observation id returned by observe
  --control-epoch <n>   Expected control epoch

Options for observe:
  --max-elements <n>    Return 1 to 500 elements (default 200)
  --filter-json <steps> Filter the element list with native locator steps
  --no-text             Omit visible page text
  --view <kind>         semantic (default), visual, or both
  --scope <kind>        viewport (default) or element
  --ref <ref>           Crop an element visual observation to this ref
  --image-output <path> Write visual PNG bytes to a new file with mode 0600

Locator steps use AgentCursor css, role/name, label, text, placeholder, testid, filter, and nth. Query steps scope the next query. Actions require one match. Arrays have 1–16 steps, each text at most 1024 characters. Disconnecting cancels pending input; already dispatched side effects are not undone.

Type reads stdin only with --stdin. Use --replace to select all and insert
text as one native edit. Status, pause, and resume are browser-wide and do not
accept --tab.
`,
  },
  session: {
    summary: "Manage native session contexts and downloads",
    usage: "terminal-browser session tabs --session <id> --project <directory> [options]",
    body: `
Uses the same native controller as agent and the Herdr companion adapter.
Open the visible browser first: terminal-browser open <url> --session work --project .

Options:
  --action <action>    list (default), open, activate, close, wait,
                       downloads, download_wait, or download_cancel
  --tab <id>           Exact context ID for activate/close; optional download filter
  --url <url>          URL for a new context
  --after-id <id>      Last context ID for wait
  --download-id <id>   Exact transfer ID for download_wait/download_cancel
  --timeout-ms <n>     Wait limit, 0 to 60000 (default 10000)

Success responses are JSON on stdout. Failures are JSON on stderr with a nonzero
exit. Context changes invalidate observations. File operations stay inside the
canonical launch project and use owner-scoped download history. Wait timeouts do
not replay actions. Tabs and popups use stable native context IDs, not CDP IDs.
`,
  },
  companion: {
    summary: "Open or manage this Herdr pane's browser companion",
    usage: "terminal-browser companion <open|tabs> [options]",
    body: `
The Herdr adapter retains exact workspace/tab/pane ownership. Open accepts an
optional URL, --new-tab, and --no-focus. Tabs uses the same options as session
tabs. Pi is optional. Without Herdr, use open --session <id> --project <directory>
and session tabs or agent with the same explicit owner.
`,
  },
  action: {
    summary: "Retired legacy route; prints native migration guidance",
    usage: "terminal-browser action --help",
    body: ACTION_MIGRATION,
  },
};

function block(text: string): string {
  return `${text.trim()}\n`;
}

export function rootHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, help]) => `  ${name.padEnd(width)}  ${help.summary}`,
  );
  return block(`
Usage: terminal-browser [url] [options]
       terminal-browser <command> [args]

${lines.join("\n")}

terminal-browser <command> --help for one command's options
terminal-browser --version prints the installed version
`);
}

export function commandHelp(name: string): string | null {
  const help = COMMANDS[name];
  if (!help) return null;
  return block(`Usage: ${help.usage}\n${help.body}`);
}

export function helpTopics(): string[] {
  return Object.keys(COMMANDS);
}
