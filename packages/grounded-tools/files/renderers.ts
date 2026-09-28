import { createToolPresentation, type PresentationView } from "pi-tool-controls/presentation";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const savedText = (result: { content: readonly unknown[] }): string => result.content.map(record).map((block) => block.type === "text" ? text(block.text) : "").filter(Boolean).join("\n");
const sessionLabel = (args: RecordValue): string => args.sessionId ? ` [session ${text(args.sessionId)}]` : "";

function fileCall(name: string, args: RecordValue): string {
  const path = text(args.path) || "(path pending)";
  const skill = /(?:^|\/)SKILL\.md$/.test(path) ? `skill ${path.split("/").at(-2) ?? "SKILL.md"}: ` : "";
  const mode = name === "read" && args.mode && args.mode !== "full" ? ` [${text(args.mode)}]` : "";
  const range = name === "read" ? `${args.offset !== undefined ? `:${args.offset}` : ""}${args.limit !== undefined ? ` [limit ${args.limit}]` : ""}` : "";
  return `${name} ${skill}${path}${range}${mode}${sessionLabel(args)}`;
}

function failure(body: string, partial: boolean): PresentationView {
  return {
    summary: partial ? "Partial result · error" : "Error · operation not confirmed",
    tone: "error",
    lines: body.split("\n"),
  };
}

function readNotices(details: RecordValue): string[] {
  const notices: string[] = [];
  if (details.truncated === true || record(details.truncation).truncated === true || details.fullOutputPath) notices.push("Returned excerpt · source omitted");
  const end = number(details.endLine);
  const total = number(details.totalLines) ?? number(details.totalFileLines);
  if (end !== undefined && total !== undefined && end < total) notices.push(`More source lines after ${end} of ${total}`);
  return notices;
}

function skillExcerpt(body: string, path: string): string[] {
  // Filename convention only, not a claim that the skill is registered or loaded.
  const returned = body.split("\n");
  const descriptionIndex = returned.findIndex((line) => /^description:/.test(line));
  let description = returned[descriptionIndex]?.replace(/^description:[ \t]*/, "").trim();
  if (description && /^[>|][-+]?\s*$/.test(description)) {
    const continuation: string[] = [];
    for (let index = descriptionIndex + 1; index < returned.length && /^[ \t]+\S/.test(returned[index]!); index++) continuation.push(returned[index]!.trim());
    description = continuation.join(" ");
  }
  const headings = returned.filter((line) => /^#{1,6}\s+\S/.test(line));
  const lines = [`Path: ${path}`];
  if (description) lines.push(`Description: ${description}`);
  if (headings.length) lines.push(...headings);
  return lines.length > 1 ? lines : body.split("\n");
}

export const readPresentation = createToolPresentation({
  call: (args) => fileCall("read", args),
  result(result, options, context) {
    const body = savedText(result);
    if (context.isError) return failure(body, options.isPartial);
    const details = record(result.details);
    const notices = readNotices(details);
    // A native limited read can return no details. Describe the request, not
    // arbitrary file prose or an inferred number of remaining source lines.
    if (number(context.args?.limit) !== undefined) notices.push(`Requested slice: ${context.args.limit} ${context.args.limit === 1 ? "line" : "lines"}`);
    if (options.isPartial) notices.unshift("Partial read · still running");
    const path = text(context.args?.path);
    const skill = /(?:^|\/)SKILL\.md$/.test(path) && (!context.args?.mode || context.args.mode === "full");
    return {
      quiet: !options.isPartial && notices.length === 0,
      summary: options.isPartial ? "Read in progress" : "Saved read",
      notices,
      lines: options.expanded ? (skill ? skillExcerpt(body, path) : body.split("\n")) : [],
      omitted: notices.length > 0 || (options.expanded && skill),
    };
  },
});

function mutationNotices(details: RecordValue, body: string): string[] {
  const notices: string[] = [];
  const syntax = record(details.syntax);
  if (syntax.ok === false) notices.push(`Syntax warning (${text(syntax.engine) || "checker"}): ${text(syntax.message) || "invalid syntax"}`);
  else if (syntax.checked === false) notices.push(`Syntax not checked${syntax.message ? `: ${text(syntax.message)}` : ""}`);
  const lsp = record(details.groundedLsp);
  if (lsp.error) notices.push(`LSP error: ${text(lsp.error)}`);
  if (Array.isArray(lsp.diagnostics) && lsp.diagnostics.length) {
    const errors = lsp.diagnostics.filter((item) => record(item).severity === 1).length;
    notices.push(`LSP: ${lsp.diagnostics.length} diagnostics (${errors} errors)`);
  }
  if (!Object.keys(syntax).length || !Object.keys(lsp).length) {
    notices.push(...body.split("\n").filter((line) => (!Object.keys(syntax).length && /^Syntax warning/.test(line)) || (!Object.keys(lsp).length && /^LSP diagnostics/.test(line))));
  }
  if (details.atomic === false) notices.push("Write was not atomic");
  if (details.hardLinkTopologyRollback === false && number(details.hardLinksBefore)! > 1) notices.push("Hard-link topology cannot be rolled back");
  if (lsp.fullOutputPath) notices.push("LSP result excerpt · full output linked");
  return notices;
}

function diffExcerpt(diff: string, expanded: boolean): string[] {
  const rows = diff.split("\n");
  const changed = rows.flatMap((row, index) => /^[+-]\s*\d+ /.test(row) ? [index] : []);
  const selected = new Set<number>();
  for (const prefix of ["-", "+"]) {
    const index = changed.find((index) => rows[index]!.startsWith(prefix));
    if (index !== undefined) selected.add(index);
  }
  for (const index of changed) {
    if (selected.size >= (expanded ? 4 : 2)) break;
    selected.add(index);
  }
  if (expanded && selected.size) {
    const before = Math.min(...selected) - 1;
    if (before >= 0 && /^\s+\d+ /.test(rows[before]!)) selected.add(before);
  }
  const indices = [...selected].sort((a, b) => a - b);
  return indices.flatMap((index, position) => [
    ...(position > 0 && index > indices[position - 1]! + 1 ? ["… diff gap …"] : []),
    rows[index]!,
  ]);
}

function mutationPresentation(name: "edit" | "write") {
  return createToolPresentation({
    call: (args) => fileCall(name, args),
    result(result, options, context) {
      const body = savedText(result);
      if (context.isError) return failure(body, options.isPartial);
      const details = record(result.details);
      const diff = text(details.diff);
      const notices = mutationNotices(details, body);
      if (options.isPartial) notices.unshift("Partial mutation · not yet confirmed");
      const rows = diff.split("\n");
      const added = rows.filter((line) => /^\+\s*\d+ /.test(line)).length;
      const removed = rows.filter((line) => /^-\s*\d+ /.test(line)).length;
      const lines = diff ? diffExcerpt(diff, options.expanded) : body.split("\n");
      if (options.expanded) {
        const lsp = record(details.groundedLsp);
        if (Array.isArray(lsp.diagnostics)) {
          lines.unshift(...lsp.diagnostics.map((value) => {
            const diagnostic = record(value);
            const line = number(record(record(diagnostic.range).start).line);
            return `LSP${line !== undefined ? ` line ${line + 1}` : ""}: ${text(diagnostic.message)}`;
          }));
        }
      }
      return {
        summary: options.isPartial ? "Mutation in progress" : diff ? `Saved change: +${added} -${removed}` : "Returned result · no saved diff",
        notices,
        lines,
        omitted: Boolean(diff) || notices.length > 0,
      };
    },
  });
}

export const editPresentation = mutationPresentation("edit");
export const writePresentation = mutationPresentation("write");

const qualifications: Record<string, string> = {
  "hidden-included": "hidden included",
  "dot-git-excluded": ".git excluded",
  "ignore-without-git": "ignore rules honored",
  "binary-ripgrep-policy": "binary/unreadable: ripgrep policy",
  "symlinks-not-followed": "symlinks not followed",
  "current-snapshot-continuation": "each page rescans current filesystem",
  "basename-glob-without-slash": "glob without / matches basename",
  "full-relative-path-glob-with-slash": "glob with / matches full relative path",
  "non-exhaustive": "not exhaustive; no absence proof",
  "git-change-boost-visible": "Git-changed paths boosted",
  "git-metadata-unavailable": "Git metadata unavailable",
  "git-change-boost-disabled": "Git-change boost disabled",
};

export const searchPresentation = createToolPresentation({
  call(args) {
    if (args.action === "capabilities") return "local_search capabilities";
    return `local_search ${text(args.strategy)} ${text(args.pathGlob) || text(args.query)} in ${text(args.path) || "."}${args.cursor ? " [next page]" : ""}${sessionLabel(args)}`;
  },
  result(result, options, context) {
    const body = savedText(result);
    if (context.isError) return failure(body, options.isPartial);
    const details = record(result.details);
    if (context.args?.action === "capabilities") return { summary: "Search strategies", lines: body.split("\n") };
    const hits = Array.isArray(details.hits) ? details.hits.map(record) : [];
    const fuzzy = details.strategy === "fuzzy" || context.args?.strategy === "fuzzy";
    const total = number(details.totalHits);
    const notices = strings(details.warnings).map((warning) => `Warning: ${warning}`);
    if (options.isPartial) notices.unshift("Partial search · still running");
    if (fuzzy) notices.unshift("Fuzzy · no absence proof");
    else if (details.complete === true) notices.unshift("Exact under qualifications");
    else notices.unshift("Coverage not confirmed");
    if (details.nextCursor || record(details.page).nextCursor) notices.push("More results · next cursor available");
    if (details.fullOutputPath) notices.push("Returned text excerpt · full output linked");
    const qualified = strings(details.qualifications).map((value) => qualifications[value] ?? value);
    const lines = options.expanded && qualified.length ? [`Scope: ${qualified.join("; ")}`] : [];
    lines.push(...hits.map((hit) => `${text(hit.path)}${number(hit.line) !== undefined ? `:${hit.line}` : ""}${hit.gitChanged ? " [Git changed]" : ""}`));
    if (!Array.isArray(details.hits)) lines.push(...body.split("\n"));
    return {
      summary: details.outcome === "no_matches" ? "No matches in searched scope" : `${hits.length} returned${total !== undefined ? ` of ${total}` : ""}`,
      notices,
      lines,
      omitted: qualified.length > 0 || hits.length > 0,
    };
  },
});
