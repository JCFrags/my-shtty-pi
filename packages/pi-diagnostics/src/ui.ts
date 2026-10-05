import { getMarkdownTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, ScrollView, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CHECKS, OVERVIEW_CHECKS, QUICK_CHECKS } from "./audits.ts";
import { defaultReportPath, saveReport, type ReportFormat } from "./export.ts";
import { checkCatalog, renderMarkdown } from "./render.ts";
import type { Report, Request } from "./types.ts";

const PAGE_SIZE = 25;
const MENU = [
  "Overview",
  "Session/context",
  "Runtime telemetry",
  "Prompt inputs/tools",
  "Components/source",
  "Environment/resources",
  "Run read-only audit",
  "Save report",
  "Close",
];
const VIEWS: Record<string, Request> = {
  Overview: { topics: ["runtime", "session", "telemetry", "components"], checkIds: [...OVERVIEW_CHECKS], view: "summary" },
  "Session/context": { topics: ["session", "state"], view: "detailed" },
  "Runtime telemetry": { topics: ["telemetry"], view: "detailed" },
  "Prompt inputs/tools": { topics: ["tools"], view: "detailed" },
  "Components/source": { topics: ["components"], view: "detailed" },
  "Environment/resources": { topics: ["runtime", "resources"], view: "detailed" },
};

type Action = "back" | "close" | "refresh" | "save" | "details" | "next" | "previous" | "continue";
interface ScreenOptions {
  refresh?: boolean;
  save?: boolean;
  details?: boolean;
  next?: boolean;
  previous?: boolean;
  review?: boolean;
  page?: Report["page"];
}
interface Selection {
  title: string;
  request: Request;
  report: Report;
}

async function showScreen(ctx: ExtensionCommandContext, title: string, text: string, options: ScreenOptions = {}): Promise<Action> {
  return ctx.ui.custom<Action>((tui, theme, keybindings, done) => {
    const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
    const scroll = new ScrollView(markdown, { follow: "none", scrollbar: "hidden" });
    let finished = false;
    const finish = (action: Action) => {
      if (finished) return;
      finished = true;
      done(action);
    };
    return {
      render(width: number): string[] {
        const columns = Math.max(1, width);
        const height = Math.max(3, Math.min(42, Math.floor(tui.terminal.rows * 0.9) - 2));
        const actions = ["Esc/b Back", ...(options.refresh ? ["r Refresh"] : []), ...(options.save ? ["s Save"] : []), "q Close"];
        const pages = [...(options.details ? ["d Details"] : []), ...(options.previous ? ["p/Left Previous page"] : []), ...(options.next ? ["n/Right Next page"] : [])];
        const hints = [actions.join(" | "), "Up/Down scroll | PgUp/PgDn | Home/End", ...(pages.length ? [pages.join(" | ")] : []), ...(options.review ? ["Enter: reviewed, choose save format"] : [])];
        const footer = hints.flatMap(line => wrapTextWithAnsi(theme.fg("dim", line), columns));
        const footerLimit = Math.max(1, height - 4);
        const visibleFooter = footer.slice(0, footerLimit);
        const bodyHeight = Math.max(1, height - visibleFooter.length - 2);
        const lines = scroll.render(columns);
        // Regular custom screens need an explicit viewport. Fullscreen uses the same bound.
        scroll.updateLayout(lines.length, bodyHeight, () => tui.requestRender());
        const visible = lines.slice(scroll.scrollTop, scroll.scrollTop + bodyHeight);
        while (visible.length < bodyHeight) visible.push("");
        const page = options.page;
        const pageText = page ? ` | Detail items ${page.total === 0 ? 0 : Math.min(page.offset + 1, page.total)}-${Math.min(page.offset + page.limit, page.total)}/${page.total}` : "";
        const position = `${lines.length === 0 ? 0 : scroll.scrollTop + 1}-${Math.min(scroll.scrollTop + bodyHeight, lines.length)}/${lines.length} lines${pageText}`;
        return [
          theme.fg("accent", truncateToWidth(title, columns)),
          ...visible,
          theme.fg("muted", truncateToWidth(position, columns)),
          ...visibleFooter,
        ].map(line => truncateToWidth(line, columns));
      },
      invalidate() {
        scroll.invalidate();
      },
      handleInput(data: string) {
        if (finished) return;
        if (matchesKey(data, "q")) finish("close");
        else if (matchesKey(data, "b") || keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) finish("back");
        else if (options.review && keybindings.matches(data, "tui.select.confirm")) finish("continue");
        else if (options.refresh && matchesKey(data, "r")) finish("refresh");
        else if (options.save && matchesKey(data, "s")) finish("save");
        else if (options.details && matchesKey(data, "d")) finish("details");
        else if (options.next && (matchesKey(data, "n") || matchesKey(data, Key.right))) finish("next");
        else if (options.previous && (matchesKey(data, "p") || matchesKey(data, Key.left))) finish("previous");
        else if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.altScreen.lineUp")) scroll.scrollBy(-1);
        else if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.altScreen.lineDown")) scroll.scrollBy(1);
        else if (keybindings.matches(data, "tui.altScreen.pageUp") || matchesKey(data, Key.pageUp)) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
        else if (keybindings.matches(data, "tui.altScreen.pageDown") || matchesKey(data, Key.pageDown)) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
        else if (keybindings.matches(data, "tui.altScreen.top") || matchesKey(data, Key.home)) scroll.scrollToStart();
        else if (keybindings.matches(data, "tui.altScreen.bottom") || matchesKey(data, Key.end)) scroll.scrollToEnd();
        if (!finished) tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", margin: 1, anchor: "center" } });
}

async function chooseAudit(ctx: ExtensionCommandContext): Promise<{ title: string; request: Request } | "close" | undefined> {
  const quick = "Quick current-session audit";
  const catalog = "List checks and evidence limits";
  const labels = CHECKS.map(check => `${check.id}: ${check.purpose}`);
  while (true) {
    const choice = await ctx.ui.select("Read-only audit. Select a fixed group or one check.", [quick, catalog, ...labels, "Back", "Close"]);
    if (!choice || choice === "Back") return undefined;
    if (choice === "Close") return "close";
    if (choice === catalog) {
      if (await showScreen(ctx, "Audit catalog. Listing does not run checks.", renderMarkdown(checkCatalog())) === "close") return "close";
      continue;
    }
    const check = CHECKS[labels.indexOf(choice)];
    if (choice !== quick && !check) continue;
    const ids = choice === quick ? [...QUICK_CHECKS] : [check.id];
    const topics = [...new Set(CHECKS.filter(item => ids.includes(item.id)).flatMap(item => item.topics))];
    return { title: choice === quick ? quick : check.id, request: { topics, checkIds: ids, view: "detailed", offset: 0, limit: PAGE_SIZE } };
  }
}

async function saveSelection(ctx: ExtensionCommandContext, selection: Selection): Promise<"back" | "close"> {
  const report = selection.report;
  const review = await showScreen(ctx, "Review the selected report before Save", renderMarkdown(report), { review: true, page: report.page });
  if (review !== "continue") return review === "close" ? "close" : "back";
  const formatChoice = await ctx.ui.select("Save this report only. Other pages are not collected.", ["Markdown", "JSON", "Back", "Close"]);
  if (formatChoice === "Close") return "close";
  if (formatChoice !== "Markdown" && formatChoice !== "JSON") return "back";
  const format: ReportFormat = formatChoice === "Markdown" ? "markdown" : "json";
  const defaultPath = defaultReportPath(report, format);
  const destinationChoice = await ctx.ui.select("Local private report destination", ["Private default directory", "Custom absolute local filename", "Back", "Close"]);
  if (destinationChoice === "Close") return "close";
  if (!destinationChoice || destinationChoice === "Back") return "back";
  let destination = defaultPath;
  if (destinationChoice === "Custom absolute local filename") {
    const consent = await ctx.ui.confirm("Custom destination privacy", "Reports can contain private local paths and runtime metadata. Nothing is uploaded. Use an existing directory that you own. A new owner-only file is created. Symlinks, unsafe paths, and existing files are refused. Review the location before sharing the report.");
    if (!consent) return "back";
    const custom = await ctx.ui.input("Absolute local report filename. The directory must exist.", defaultPath);
    if (!custom) return "back";
    destination = custom;
  } else if (destinationChoice !== "Private default directory") return "back";
  const consent = await ctx.ui.confirm("Save reviewed private report?", `Report: ${report.reportId}\nCollected: ${report.endedAt}\nFormat: ${formatChoice}\nDestination: ${destination}\nOnly this selected report/page is saved. File mode: 0600. Existing files and permissions are never changed. Nothing is uploaded.`);
  if (!consent) return "back";
  try {
    const path = await saveReport(report, format, destination);
    ctx.ui.notify(`Private report saved: ${path}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : "The report could not be saved.", "error");
  }
  return "back";
}

/** Open an idle menu. Collection starts only after an explicit topic or audit choice. */
export async function showDiagnostics(ctx: ExtensionCommandContext, getReport: (request: Request) => Promise<Report>): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Diagnostics menu requires TUI mode. No controls or report collection are available here.", "warning");
    return;
  }
  let selected: Selection | undefined;
  while (true) {
    const choice = await ctx.ui.select("Pi diagnostics. Select a topic to collect a report.", MENU);
    if (!choice || choice === "Close") return;
    if (choice === "Save report") {
      if (!selected) ctx.ui.notify("Select a topic or run an audit before saving a report.", "info");
      else if (await saveSelection(ctx, selected) === "close") return;
      continue;
    }
    let pending: { title: string; request: Request } | undefined;
    if (choice === "Run read-only audit") {
      const audit = await chooseAudit(ctx);
      if (audit === "close") return;
      pending = audit;
    } else if (VIEWS[choice]) {
      pending = { title: choice, request: { ...VIEWS[choice], offset: 0, limit: PAGE_SIZE } };
    }
    if (!pending) continue;
    let request = pending.request;
    try {
      selected = { ...pending, request, report: await getReport(request) };
    } catch {
      ctx.ui.notify("Diagnostics could not collect this report. No control action was run.", "error");
      continue;
    }
    while (selected) {
      const report = selected.report;
      const action = await showScreen(ctx, `${selected.title}. Values can change; collection is not atomic.`, renderMarkdown(report), {
        refresh: true, save: true, details: request.view !== "detailed",
        next: request.view === "detailed" && report.page.nextOffset !== null,
        previous: request.view === "detailed" && report.page.offset > 0,
        page: request.view === "detailed" ? report.page : undefined,
      });
      if (action === "close") return;
      if (action === "back") break;
      if (action === "save") {
        if (await saveSelection(ctx, selected) === "close") return;
        continue;
      }
      if (action === "details") request = { ...request, view: "detailed", offset: 0 };
      else if (action === "next" && report.page.nextOffset !== null) request = { ...request, offset: report.page.nextOffset };
      else if (action === "previous") request = { ...request, offset: Math.max(0, report.page.offset - report.page.limit) };
      else if (action !== "refresh") continue;
      try {
        const nextReport = await getReport(request);
        selected = { ...selected, request, report: nextReport };
      } catch {
        request = selected.request;
        ctx.ui.notify("Diagnostics could not refresh this report. The previous report remains selected.", "error");
      }
    }
  }
}
