import { constants } from "node:fs";
import { open, realpath, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getVersion, type MicromarkToken, type Rule } from "markdownlint";
import { lint } from "markdownlint/sync";
import GithubSlugger from "github-slugger";
import { decodeString } from "micromark-util-decode-string";
import { parseDocument } from "yaml";
import type { AnalyzerContext, CheckOutcome, CheckResult, Finding } from "./check-types.ts";

// Only the package's public helper export is used. It does not ship declarations.
const { getReferenceLinkImageData } = createRequire(import.meta.url)("markdownlint/helpers") as {
  getReferenceLinkImageData(tokens: MicromarkToken[]): { definitions: Map<string, [number, string]> };
};

export const documentAnalyzerIds = ["markdown", "vale", "links-network"] as const;
const limits = Object.freeze({
  fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, documents: 200,
  links: 2000, findings: 500, anchorsPerDocument: 10_000, tokensPerDocument: 250_000,
  valeOutputBytes: 1024 * 1024, configBytes: 64 * 1024, styleFiles: 64,
});
const markdownExtensions = new Set([".md", ".mdown", ".markdown", ".markdn"]);
const bundleConfig = fileURLToPath(new URL("./vale/.vale.ini", import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const short = (value: string, length = 500) => value.length > length ? `${value.slice(0, length)} [truncated]` : value;
const within = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown) => (error as { code?: string })?.code;

class Incomplete extends Error {
  readonly outcome: CheckOutcome;
  constructor(outcome: CheckOutcome, message: string) { super(message); this.outcome = outcome; }
}
class OutsideRoot extends Error {}
interface Input { file: string; real: string; text: string; bytes: number; sha256: string }
interface Destination { text: string; line: number; column: number }
interface Analysis { anchors: Set<string>; anchorComplete: boolean; links: Destination[]; linted: boolean }

class DocumentRun {
  readonly context: AnalyzerContext;
  readonly root: string;
  private rootReal = "";
  readonly result: CheckResult;
  readonly inputs = new Map<string, Input>();
  readonly analyses = new Map<string, Analysis>();
  readonly metadata: Record<string, unknown>;
  private readonly incompleteOutcomes = new Set<CheckOutcome>();
  private readonly notes = new Set<string>();
  private readonly deadline: number;
  bytes = 0;
  linkCount = 0;
  remoteCount = 0;
  unverifiedCount = 0;

  constructor(context: AnalyzerContext, tool: "markdown" | "vale") {
    this.context = context;
    this.root = resolve(context.target.root);
    const timeout = Number.isFinite(context.timeoutMs) ? Math.max(1, Math.min(300_000, context.timeoutMs)) : 10_000;
    this.deadline = Date.now() + timeout;
    this.metadata = { profile: tool === "markdown" ? "grounded-markdown-v1" : "grounded-prose-v1", limits, networkUsed: false };
    this.result = {
      tool, kind: tool === "markdown" ? "markdown" : "prose", scope: context.target.scope,
      outcome: "skipped", completed: false, findings: [], environment: context.environment,
      target: context.target, filesAnalyzed: 0, notes: [], metadata: this.metadata,
    };
  }

  async initialize(): Promise<void> { this.guard(); this.rootReal = await realpath(this.root); }
  label(file: string): string { return relative(this.root, file).split(sep).join("/") || "."; }
  guard(): void {
    if (this.context.signal?.aborted) throw new Incomplete("cancelled", "Document check cancelled.");
    if (Date.now() >= this.deadline) throw new Incomplete("timeout", "Document check reached its total time budget.");
  }
  remaining(maximum = 10_000): number { this.guard(); return Math.max(1, Math.min(maximum, this.deadline - Date.now())); }
  note(message: string): void {
    if (this.notes.size < 100) this.notes.add(short(message, 1000));
    else this.metadata.notesTruncated = true;
  }
  incomplete(outcome: CheckOutcome, message: string): void { this.incompleteOutcomes.add(outcome); this.note(message); }
  recordError(error: unknown, label: string): void {
    this.incomplete(error instanceof Incomplete ? error.outcome : "failed", `${label}: ${short(errorMessage(error))}`);
  }
  add(finding: Finding): void {
    if (this.result.findings.length >= limits.findings) throw new Incomplete("output-limit", "Finding limit reached. Coverage is incomplete.");
    this.result.findings.push(finding);
  }
  finding(file: string, code: string, message: string, severity: Finding["severity"], line?: number, column?: number, kind: Finding["kind"] = "markdown"): void {
    this.add({ tool: this.result.tool, kind, file: this.label(file), code, message: short(message, 4000), severity, line, column, columnEncoding: "utf-16" });
  }

  async admitted(path: string): Promise<string> {
    this.guard();
    if (!within(this.root, path)) throw new OutsideRoot("Target leaves the admitted root.");
    try {
      const actual = await realpath(path);
      if (!within(this.rootReal, actual)) throw new OutsideRoot("Target follows a symlink outside the admitted root.");
      return actual;
    } catch (error) {
      // A missing child below an outside-root symlink must not appear to be a local missing file.
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        let ancestor = dirname(path);
        while (within(this.root, ancestor)) {
          try {
            const actual = await realpath(ancestor);
            if (!within(this.rootReal, actual)) throw new OutsideRoot("Target follows a symlink outside the admitted root.");
            break;
          } catch (parentError) {
            if (parentError instanceof OutsideRoot) throw parentError;
            if (errorCode(parentError) !== "ENOENT" && errorCode(parentError) !== "ENOTDIR") throw parentError;
          }
          if (ancestor === this.root) break;
          ancestor = dirname(ancestor);
        }
      }
      throw error;
    }
  }

  async input(file: string): Promise<Input> {
    const actual = await this.admitted(file);
    const cached = this.inputs.get(actual);
    if (cached) return { ...cached, file };
    if (this.inputs.size >= limits.documents) throw new Incomplete("output-limit", "Document/anchor-index limit reached.");
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Incomplete("unsupported", "Input is not a regular file.");
      if (info.size > limits.fileBytes || info.size + this.bytes > limits.totalBytes) {
        throw new Incomplete("output-limit", "Document byte limit reached.");
      }
      const capacity = Math.min(limits.fileBytes, limits.totalBytes - this.bytes);
      const buffer = Buffer.alloc(capacity + 1);
      let bytes = 0;
      while (bytes <= capacity) {
        this.guard();
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > capacity) throw new Incomplete("output-limit", "Document grew beyond the byte limit while reading.");
      const data = buffer.subarray(0, bytes);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      const input = { file, real: actual, text, bytes, sha256: hash(data) };
      this.inputs.set(actual, input);
      this.bytes += bytes;
      return input;
    } finally { await handle.close(); }
  }

  selected(): string[] {
    const files = [...new Set(this.context.target.files.map((file) => resolve(this.context.target.cwd, file)))];
    const supported = files.filter((file) => markdownExtensions.has(extname(file).toLowerCase()));
    if (supported.length > limits.documents) this.incomplete("output-limit", "Selected Markdown file limit reached.");
    const selected = supported.slice(0, limits.documents);
    const mdx = files.some((file) => extname(file).toLowerCase() === ".mdx");
    if (mdx) this.incomplete("unsupported", "MDX is not supported by the document profiles.");
    this.metadata.selectedFiles = selected.map((file) => this.label(file));
    this.metadata.nonMarkdownFiles = files.length - supported.length;
    if (!selected.length) this.note("No supported Markdown files were selected. No directory discovery was performed.");
    return selected;
  }

  finish(): CheckResult {
    const priorities: CheckOutcome[] = ["cancelled", "timeout", "output-limit", "busy", "unavailable", "failed", "unsupported"];
    const incomplete = priorities.find((outcome) => this.incompleteOutcomes.has(outcome));
    this.result.completed = !incomplete && (this.result.filesAnalyzed ?? 0) > 0;
    this.result.outcome = incomplete ?? (!this.result.completed ? "skipped" : this.result.findings.length ? "findings" : "passed");
    this.result.notes = [...this.notes];
    Object.assign(this.metadata, {
      inputs: [...this.inputs.values()].map((input) => ({ file: this.label(input.file), bytes: input.bytes, sha256: input.sha256 })),
      bytesRead: this.bytes, destinationsExamined: this.linkCount,
      remoteDestinationsNotChecked: this.remoteCount, unverifiedDestinations: this.unverifiedCount,
    });
    return this.result;
  }
}

function headingText(token: MicromarkToken): string {
  let text = "";
  const stack = [...token.children].reverse();
  while (stack.length) {
    const child = stack.pop()!;
    if (["image", "resource", "reference", "htmlText"].includes(child.type)) continue;
    if (child.type === "codeTextData" || child.type === "data") text += child.text;
    else if (child.type === "characterEscape" || child.type === "characterReference") text += decodeString(child.text);
    else if (child.type === "lineEnding") text += " ";
    else for (let index = child.children.length - 1; index >= 0; index--) stack.push(child.children[index]);
  }
  return text;
}

interface LiteralTag { name: string; closing: boolean; selfClosing: boolean; attributes: Map<string, string | undefined> }
// This accepts one complete literal tag, not arbitrary HTML or an HTML document.
function literalTag(text: string): LiteralTag | undefined {
  const start = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(text);
  if (!start) return undefined;
  let rest = text.slice(start[0].length);
  const attributes = new Map<string, string | undefined>();
  while (!/^\s*\/?\s*>$/.test(rest)) {
    const attribute = /^\s+([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(rest);
    if (!attribute || start[1]) return undefined;
    const name = attribute[1].toLowerCase();
    if (attributes.has(name)) return undefined;
    attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4]);
    rest = rest.slice(attribute[0].length);
  }
  return { name: start[2].toLowerCase(), closing: !!start[1], selfClosing: /\/\s*>$/.test(rest), attributes };
}

function anchorOnlyHtml(text: string): LiteralTag[] | undefined {
  const tags: LiteralTag[] = [];
  const nesting: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text[index] !== "<") return undefined;
    let quote = "";
    let end = index + 1;
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === "'" || character === '"') quote = character;
      else if (character === ">") break;
    }
    const tag = literalTag(text.slice(index, end + 1));
    if (!tag || /^(?:script|style|pre|code|textarea|iframe|h[1-6])$/.test(tag.name) || tag.attributes.has("href") || tag.attributes.has("src")) return undefined;
    if (tag.closing) { if (nesting.pop() !== tag.name) return undefined; }
    else if (!tag.selfClosing && !/^(?:br|hr|wbr)$/.test(tag.name)) nesting.push(tag.name);
    tags.push(tag);
    index = end + 1;
  }
  return nesting.length ? undefined : tags;
}

function maskFrontmatter(run: DocumentRun, input: Input, selected: boolean): string {
  const source = input.text.replace(/^\uFEFF/, " ");
  const lines = source.split(/\r\n|\r|\n/);
  const first = lines[0].trim();
  if (first === "{") run.incomplete("unsupported", `${run.label(input.file)}: JSON-style frontmatter is not supported.`);
  if (first !== "---" && first !== "+++") return source;
  let close = -1;
  for (let index = 1; index < Math.min(lines.length, 1001); index++) {
    if (lines[index].trim() === first || (first === "---" && lines[index].trim() === "...")) { close = index; break; }
  }
  if (close < 0) {
    const message = "Leading metadata delimiter has no bounded closing delimiter. It is treated as Markdown, not hidden metadata.";
    if (selected) run.finding(input.file, "frontmatter-not-closed", message, "warning", 1, 1);
    else run.note(`${run.label(input.file)}: ${message}`);
    if (lines.length > 1001) run.incomplete("output-limit", `${run.label(input.file)}: Frontmatter scan exceeded 1000 lines.`);
    return source;
  }
  let line = 0;
  return source.replace(/[^\r\n]+|\r\n|\r|\n/g, (part) => {
    if (/^[\r\n]/.test(part)) { line++; return part; }
    return line <= close ? part.replace(/[^ ]/g, " ") : part;
  });
}

function parseMarkdown(run: DocumentRun, input: Input, selected: boolean): Analysis {
  run.guard();
  const cached = run.analyses.get(input.file);
  if (cached && (!selected || cached.linted)) return cached;
  if (!cached && run.analyses.size >= limits.documents) throw new Incomplete("output-limit", "Anchor-index document limit reached.");
  const analysis: Analysis = { anchors: new Set(), anchorComplete: true, links: [], linted: selected };
  const slugger = new GithubSlugger();
  const explicit: Array<{ value: string; line: number; column: number }> = [];
  const quoteLines = new Set<number>();
  const authoredHeadings: Array<{ line: number; level: number }> = [];
  const source = maskFrontmatter(run, input, selected);
  const htmlLimit = () => { analysis.anchorComplete = false; };
  const addTag = (tag: LiteralTag, token: MicromarkToken) => {
    if (tag.closing) return;
    if (tag.attributes.has("href") || tag.attributes.has("src")) htmlLimit();
    const values = new Set<string>();
    for (const attribute of ["id", ...(tag.name === "a" ? ["name"] : [])]) {
      if (!tag.attributes.has(attribute)) continue;
      const raw = tag.attributes.get(attribute) ?? "";
      // Preserve literal backslashes. decodeString supplies entity decoding, not HTML escape semantics.
      if (/&[#A-Za-z]/.test(raw.replace(/&[^&\s;]*;/g, ""))) { htmlLimit(); continue; }
      const value = decodeString(raw.replaceAll("\\", "\\\\"));
      if (!value || /[\t\n\f\r ]/.test(value)) {
        htmlLimit();
        if (selected) run.finding(input.file, "invalid-explicit-anchor", "Literal HTML anchor is empty or contains ASCII whitespace.", "warning", token.startLine, token.startColumn);
        continue;
      }
      values.add(value);
    }
    for (const value of values) explicit.push({ value, line: token.startLine, column: token.startColumn });
  };
  const collector: Rule = {
    names: ["GROUNDEDDOCUMENTTOKENS"], description: "Collect bounded document tokens", tags: ["grounded"], parser: "micromark",
    function(params) {
      let tokenCount = 0;
      let suppressedHtml = "";
      const stack = [...params.parsers.micromark.tokens].reverse();
      while (stack.length) {
        const token = stack.pop()!;
        if (++tokenCount > limits.tokensPerDocument) throw new Incomplete("output-limit", "Markdown token limit reached.");
        if (["codeFenced", "codeIndented", "codeText"].includes(token.type)) {
          if (token.type === "codeFenced" && selected && !quoteLines.has(token.startLine) && token.children.filter((child) => child.type === "codeFencedFence").length < 2) {
            run.finding(input.file, "fence-not-explicitly-closed", "Fence has no explicit closing marker. CommonMark permits closure at the end of a document or container.", "warning", token.startLine, token.startColumn);
          }
          continue;
        }
        if (token.type === "blockQuote") for (let line = token.startLine; line <= token.endLine; line++) quoteLines.add(line);
        if (token.type === "htmlFlow") {
          if (token.text.startsWith("<!--")) continue;
          const tags = anchorOnlyHtml(token.text);
          if (tags) for (const tag of tags) addTag(tag, token);
          else htmlLimit();
          continue; // markdownlint reparses HTML flow. Those child tokens are not rendered Markdown.
        }
        if (token.type === "htmlText") {
          if (token.text.startsWith("<!--")) continue;
          const tag = literalTag(token.text);
          if (!tag) htmlLimit();
          else if (suppressedHtml) { if (tag.closing && tag.name === suppressedHtml) suppressedHtml = ""; }
          else if (/^(?:script|style|pre|code|textarea|iframe|h[1-6])$/.test(tag.name)) { htmlLimit(); if (!tag.closing && !tag.selfClosing) suppressedHtml = tag.name; }
          else addTag(tag, token);
          continue;
        }
        if (suppressedHtml) continue;
        if (token.type === "atxHeading" || token.type === "setextHeading") {
          const text = token.children.find((child) => child.type === "atxHeadingText" || child.type === "setextHeadingText");
          if (text) analysis.anchors.add(slugger.slug(headingText(text)));
          if (!quoteLines.has(token.startLine)) {
            const sequence = token.children.find((child) => child.type === "atxHeadingSequence" || child.type === "setextHeadingLine")!;
            authoredHeadings.push({ line: token.startLine, level: sequence.text[0] === "#" ? Math.min(6, sequence.text.length) : sequence.text[0] === "-" ? 2 : 1 });
          }
        }
        if (token.type === "resourceDestinationString") analysis.links.push({ text: token.text, line: token.startLine, column: token.startColumn });
        if (token.type.startsWith("directive") || ["mathFlow", "mathText", "gfmFootnoteDefinition"].includes(token.type)) htmlLimit();
        if (analysis.anchors.size + explicit.length > limits.anchorsPerDocument) throw new Incomplete("output-limit", "Anchor limit reached.");
        if (analysis.links.length > limits.links) throw new Incomplete("output-limit", "Destination limit reached.");
        for (let index = token.children.length - 1; index >= 0; index--) stack.push(token.children[index]);
      }
      for (const [label, [lineIndex, text]] of getReferenceLinkImageData(params.parsers.micromark.tokens).definitions) {
        if (!label.startsWith("^")) analysis.links.push({ text, line: lineIndex + 1, column: 1 });
      }
    },
  };
  const results = lint({
    strings: { document: source }, frontMatter: null, noInlineConfig: true, handleRuleFailures: false, customRules: [collector],
    config: {
      default: false, MD001: selected ? "warning" : false,
      MD040: selected ? { severity: "warning", allowed_languages: [], language_only: false } : false,
      MD052: selected ? { severity: "warning", shortcut_syntax: false, ignored_labels: [] } : false,
      GROUNDEDDOCUMENTTOKENS: true,
    },
  });
  run.guard();
  if (selected) {
    for (const error of results.document) {
      const code = error.ruleNames[0];
      if ((code === "MD001" && quoteLines.size) || (code === "MD040" && quoteLines.has(error.lineNumber))) continue;
      run.finding(input.file, code, `${error.ruleDescription}${error.errorDetail ? `: ${error.errorDetail}` : ""}`, "warning", error.lineNumber, error.errorRange?.[0]);
    }
    // Use the same parser's authored heading sequence when copied blockquotes would change MD001's predecessor.
    if (quoteLines.size) for (let index = 1; index < authoredHeadings.length; index++) {
      const previous = authoredHeadings[index - 1];
      const current = authoredHeadings[index];
      if (current.level > previous.level + 1) run.finding(input.file, "MD001", `Heading levels should only increment by one level at a time: Expected h${previous.level + 1}, actual h${current.level}.`, "warning", current.line);
    }
  }
  for (const anchor of explicit) {
    if (analysis.anchors.has(anchor.value) && selected) run.finding(input.file, "duplicate-explicit-anchor", `Literal HTML anchor '${short(anchor.value)}' duplicates an explicit or generated anchor.`, "warning", anchor.line, anchor.column);
    analysis.anchors.add(anchor.value);
  }
  if (analysis.anchors.size > limits.anchorsPerDocument || analysis.links.length > limits.links) throw new Incomplete("output-limit", "Document anchor/destination limit reached.");
  if (!analysis.anchorComplete && selected) run.incomplete("unsupported", `${run.label(input.file)}: Raw HTML links/headings, complex HTML blocks, or renderer extensions have incomplete coverage. Simple literal anchor-only tags are supported.`);
  run.analyses.set(input.file, analysis);
  return analysis;
}

function localUri(raw: string): { path: string; fragment: string } | "remote" | "unsupported" {
  const value = decodeString(raw);
  if (/^(?:https?:|\/\/)/i.test(value)) return "remote";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.includes("\\")) return "unsupported";
  const hashAt = value.indexOf("#");
  const beforeHash = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const encodedPath = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const fragment = decodeURIComponent(hashAt < 0 ? "" : value.slice(hashAt + 1));
  const segments = encodedPath.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (decoded.includes("/") || decoded.includes("\\")) throw new Incomplete("unsupported", "Encoded path separators are not supported.");
    return decoded;
  });
  const path = segments.join("/");
  if (path.includes("\0") || fragment.includes("\0")) throw new Error("Encoded NUL is not a valid local target.");
  return { path, fragment };
}

async function checkDestination(run: DocumentRun, input: Input, destination: Destination): Promise<void> {
  run.guard();
  if (++run.linkCount > limits.links) throw new Incomplete("output-limit", "Aggregate destination limit reached.");
  const finding = (code: string, message: string, severity: Finding["severity"] = "error") => run.finding(input.file, code, message, severity, destination.line, destination.column, "links");
  const unverified = (message: string) => {
    run.unverifiedCount++;
    run.incomplete("unsupported", message);
    finding("local-target-unverified", message, "information");
  };
  let uri: ReturnType<typeof localUri>;
  try { uri = localUri(destination.text); }
  catch (error) {
    const message = `${short(destination.text)}: ${errorMessage(error)}`;
    if (error instanceof Incomplete) unverified(message);
    else finding("local-target-invalid", message);
    return;
  }
  if (uri === "remote") { run.remoteCount++; return; }
  if (uri === "unsupported") { unverified(`Scheme or platform-specific target is not checked: ${short(destination.text)}`); return; }
  const file = uri.path ? uri.path.startsWith("/") ? resolve(run.root, `.${uri.path}`) : resolve(dirname(input.file), uri.path) : input.file;
  let actual: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try { actual = await run.admitted(file); info = await stat(actual); }
  catch (error) {
    if (error instanceof OutsideRoot) finding("local-target-outside-root", `${short(destination.text)}: ${error.message}`);
    else if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") finding("local-target-missing", `Local target does not exist: ${short(destination.text)}`);
    else throw error;
    return;
  }
  if (!uri.fragment) return;
  if (!info.isFile() || !markdownExtensions.has(extname(file).toLowerCase())) {
    unverified(`Fragment on a directory or non-Markdown target is not checked: ${short(destination.text)}`); return;
  }
  const targetInput = file === input.file ? input : await run.input(file);
  const target = parseMarkdown(run, targetInput, false);
  if (target.anchors.has(uri.fragment) || uri.fragment === "top") return;
  if (/^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/.test(uri.fragment) || uri.fragment.includes(":~:text=")) {
    unverified(`Source-line or browser text fragment is not checked: ${short(destination.text)}`); return;
  }
  if (!target.anchorComplete) { unverified(`Anchor index is incomplete for ${run.label(file)}. Fragment '${short(uri.fragment)}' cannot be classified as missing.`); return; }
  finding("local-anchor-missing", `${run.label(file)} has no anchor '${short(uri.fragment)}' under profile github.`);
}

async function runMarkdown(run: DocumentRun): Promise<void> {
  const profile = run.context.configuration?.markdownAnchorProfile;
  if (profile !== undefined && profile !== "github") throw new Incomplete("unsupported", "Only markdownAnchorProfile=github is supported.");
  Object.assign(run.metadata, { engine: { name: "markdownlint", version: getVersion() }, anchorProfile: "github", markdownlintRules: ["MD001", "MD040", "MD052"], definitions: "First effective definition, including unused definitions", inlineConfiguration: false });
  run.note("Remote URLs are not fetched. Existing directories/assets pass existence only. No landing pages or generated routes are guessed.");
  run.note("Style warnings skip copied blockquotes. Rendered Markdown links and headings in blockquotes remain checked. Undefined shortcut references are not reported.");
  run.note("Markdown parsing is synchronous. Time/cancellation checks run between bounded reads, parses, and destinations, not inside the parser.");
  for (const file of run.selected()) {
    try {
      const input = await run.input(file);
      const analysis = parseMarkdown(run, input, true);
      run.result.filesAnalyzed!++;
      for (const destination of analysis.links) await checkDestination(run, input, destination);
    } catch (error) {
      run.recordError(error, run.label(file));
      if (error instanceof Incomplete && ["cancelled", "timeout", "output-limit"].includes(error.outcome)) break;
    }
  }
}

interface ValeConfiguration { path: string; sha256: string; styles: Array<{ file: string; sha256: string }>; custom: boolean }
async function boundedConfig(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limits.configBytes) throw new Incomplete("unsupported", "Vale configuration/style must be a bounded regular file.");
    const buffer = Buffer.alloc(limits.configBytes + 1);
    let bytes = 0;
    while (bytes <= limits.configBytes) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > limits.configBytes) throw new Incomplete("output-limit", "Vale configuration/style byte limit reached.");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally { await handle.close(); }
}

async function valeConfiguration(run: DocumentRun): Promise<ValeConfiguration> {
  const requested = run.context.configuration?.valeConfig;
  if (requested !== undefined && typeof requested !== "string") throw new Incomplete("unsupported", "valeConfig must be an explicitly selected path string.");
  const custom = typeof requested === "string";
  if (custom && run.context.configuration?.allowCustomVale !== true) throw new Incomplete("unsupported", "Custom Vale configuration requires allowCustomVale=true from trusted configuration.");
  const path = await realpath(custom ? resolve(run.context.environment.cwd, requested!) : bundleConfig);
  const content = await boundedConfig(path);
  let section = "";
  let stylesPath = "";
  const basedOn = new Set<string>();
  const keys = new Set<string>();
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      // Accept Markdown-only glob sections, not format transforms, views, or language sections.
      if (!/^\[(?:[A-Za-z0-9_./*?-]*\.(?:md|mdown|markdown|markdn)|\*\.\{md,mdown,markdown,markdn\})\]$/.test(line)) throw new Incomplete("unsupported", "Custom Vale section is not a supported Markdown-only glob.");
      section = line;
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/.exec(line);
    if (!entry) throw new Incomplete("unsupported", "Vale config has unsupported syntax or an unsupported key.");
    const [, key, value] = entry;
    const identity = `${section}:${key.toLowerCase()}`;
    if (keys.has(identity)) throw new Incomplete("unsupported", "Duplicate Vale config keys are not supported.");
    keys.add(identity);
    if (!section && key === "StylesPath") stylesPath = value;
    else if (!section && key === "MinAlertLevel" && /^(?:suggestion|warning|error)$/.test(value)) { /* CLI requests every alert level. */ }
    else if (!section && (key === "IgnoredScopes" || key === "SkippedScopes") && /^[a-z][a-z, ]*$/.test(value)) { /* Static HTML scope lists. */ }
    else if (section && key === "BasedOnStyles" && /^[A-Za-z][A-Za-z0-9_-]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_-]*)*$/.test(value)) {
      for (const name of value.split(/\s*,\s*/)) basedOn.add(name);
    } else throw new Incomplete("unsupported", `Vale config key '${key}' is outside the offline allowlist. Packages, NLPEndpoint, transforms, scripts, and other layers are refused.`);
  }
  if (!stylesPath || !basedOn.size || isAbsolute(stylesPath) || stylesPath.includes("\0")) throw new Incomplete("unsupported", "Vale config needs a local relative StylesPath and at least one local BasedOnStyles entry.");
  const directory = dirname(path);
  const lexicalStyles = resolve(directory, stylesPath);
  if (!within(directory, lexicalStyles)) throw new Incomplete("unsupported", "Vale StylesPath leaves the configuration directory.");
  const actualStyles = await realpath(lexicalStyles);
  if (!within(directory, actualStyles)) throw new Incomplete("unsupported", "Vale StylesPath follows an outside-directory symlink.");
  const styles: ValeConfiguration["styles"] = [];
  const available = new Set<string>();
  for (const entry of await readdir(actualStyles, { withFileTypes: true })) {
    run.guard();
    if (!entry.isDirectory() || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(entry.name) || entry.name === "Vale") throw new Incomplete("unsupported", "StylesPath must contain only local style directories. Existing .vale-config pipelines and built-in styles are refused.");
    available.add(entry.name);
    for (const rule of await readdir(join(actualStyles, entry.name), { withFileTypes: true })) {
      if (!rule.isFile() || !/^[A-Za-z][A-Za-z0-9_-]*\.yml$/.test(rule.name)) throw new Incomplete("unsupported", "Vale style directories must contain only regular .yml rules, with no scripts, pipelines, or nested layers.");
      if (styles.length >= limits.styleFiles) throw new Incomplete("output-limit", "Vale style file limit reached.");
      const rulePath = join(actualStyles, entry.name, rule.name);
      const text = await boundedConfig(rulePath);
      const document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length || document.warnings.length) throw new Incomplete("unsupported", "Vale rule YAML has errors, aliases, or unsupported tags.");
      const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !["extends", "message", "level", "scope", "ignorecase", "tokens", "nonword"].includes(key)) || value.extends !== "existence") throw new Incomplete("unsupported", "Only static existence rules without actions or scripts are supported in offline Vale mode.");
      if (typeof value.message !== "string" || !["suggestion", "warning", "error"].includes(String(value.level)) || typeof value.scope !== "string" || !/^[A-Za-z0-9_. &|~!-]+$/.test(value.scope)) throw new Incomplete("unsupported", "Vale existence rule has unsupported message, severity, or scope fields.");
      if (!Array.isArray(value.tokens) || !value.tokens.length || value.tokens.length > 200 || value.tokens.some((token) => typeof token !== "string" || token.length > 2000)) throw new Incomplete("unsupported", "Vale existence tokens must be a bounded string array.");
      if ((value.ignorecase !== undefined && typeof value.ignorecase !== "boolean") || (value.nonword !== undefined && typeof value.nonword !== "boolean")) throw new Incomplete("unsupported", "Vale existence flags must be booleans.");
      styles.push({ file: `${entry.name}/${rule.name}`, sha256: hash(text) });
    }
  }
  if ([...basedOn].some((name) => !available.has(name))) throw new Incomplete("unavailable", "A selected local Vale style is missing.");
  return { path, sha256: hash(content), styles, custom };
}

function boundedValeEvidence(alert: Record<string, unknown>): unknown {
  const selected = Object.fromEntries(["Check", "Severity", "Message", "Match", "Line", "Span", "Action", "Suggestions"].filter((key) => key in alert).map((key) => [key, alert[key]]));
  const serialized = JSON.stringify(selected);
  return serialized.length <= 8192 ? selected : { truncated: true, preview: serialized.slice(0, 8192) };
}

async function runVale(run: DocumentRun): Promise<void> {
  const files = run.selected();
  if (!files.length) return;
  const config = await valeConfiguration(run);
  Object.assign(run.metadata, { config: { source: config.custom ? "trusted-custom" : "bundled", path: config.path, sha256: config.sha256, styles: config.styles }, severityPolicy: run.context.configuration?.valeUseConfigSeverity === true ? "config" : "warning-first", rangeEnd: "exclusive", rawValeSpanEnd: "inclusive" });
  const env = { ...process.env };
  delete env.VALE_CONFIG_PATH;
  delete env.VALE_STYLES_PATH;
  const command = run.context.commands.vale ?? "vale";
  const cwd = run.context.environment.cwd;
  const version = await run.context.execute({ command, args: ["--version"], cwd, env, timeoutMs: run.remaining(3000), maxOutputBytes: 32 * 1024, signal: run.context.signal });
  run.result.execution = version;
  if (version.outcome !== "completed" || version.exitCode !== 0) throw new Incomplete(version.outcome === "completed" ? "failed" : version.outcome, "Vale version probe did not complete successfully.");
  const parsedVersion = /\b(?:v)?(\d+)\.(\d+)\.(\d+)\b/.exec(`${version.stdout}\n${version.stderr}`);
  if (!parsedVersion || Number(parsedVersion[1]) !== 3 || Number(parsedVersion[2]) < 23) throw new Incomplete("unavailable", "This quote-aware Vale profile requires Vale 3.23 or later in major version 3.");
  run.metadata.engine = { name: "Vale", version: parsedVersion[0] };
  run.metadata.workingDirectory = cwd;
  run.note("Vale is check-only: no sync, downloads, fix, apply, or suggestion actions. Explicit config and --no-global are used. VALE_CONFIG_PATH and VALE_STYLES_PATH are removed.");
  run.note(config.custom ? "Trusted custom mode admits only Markdown sections and local static existence rules. Its scopes may differ from bundled exclusions. Configuration validation is not an adversarial filesystem sandbox." : "Bundled warnings exclude code, blockquotes, frontmatter, and Vale's recognized quotation scopes. Straight single quotes, guillemets, unmarked interface quotations, and quotes that cross inline formatting are not excluded reliably. Vale controls can suppress prose findings.");
  run.note("Vale cannot establish truth, preserved meaning, genuine uncertainty, or actor identity. Unicode columns are engine evidence, not safe edit ranges.");
  const executions: unknown[] = [];
  const alerts: unknown[] = [];
  run.metadata.executions = executions;
  run.metadata.alerts = alerts;
  for (const file of files) {
    try {
      const input = await run.input(file);
      const execution = await run.context.execute({
        command, args: [`--config=${config.path}`, "--no-global", "--output=JSON", "--minAlertLevel=suggestion", "--ext=.md", `--path=${run.label(file)}`],
        cwd, env, stdin: input.text, timeoutMs: run.remaining(), maxOutputBytes: limits.valeOutputBytes, signal: run.context.signal,
      });
      run.result.execution = execution;
      executions.push({ file: run.label(file), outcome: execution.outcome, exitCode: execution.exitCode, stdoutLog: execution.stdoutLog, stderrLog: execution.stderrLog, durationMs: execution.durationMs });
      // Vale exits 1 for lint errors. Preserve those alerts instead of treating them as a crash.
      const normalLintExit = !execution.signal && (execution.exitCode === 0 || execution.exitCode === 1) &&
        (execution.outcome === "completed" || (execution.outcome === "failed" && execution.exitCode === 1 && !execution.message));
      if (!normalLintExit) throw new Incomplete(execution.outcome === "completed" || execution.outcome === "failed" ? "failed" : execution.outcome, "Vale lint execution did not produce a completed check.");
      let output: unknown;
      try { output = JSON.parse(execution.stdout); }
      catch { throw new Incomplete("failed", "Vale stdout was not complete JSON."); }
      if (!output || typeof output !== "object" || Array.isArray(output) || Object.values(output).some((value) => !Array.isArray(value))) throw new Incomplete("failed", "Vale JSON did not contain a file-to-alert-array object.");
      for (const values of Object.values(output) as unknown[][]) for (const value of values) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Incomplete("failed", "Vale returned a malformed alert.");
        const alert = value as Record<string, unknown>;
        if (typeof alert.Check !== "string" || typeof alert.Message !== "string" || !["error", "warning", "suggestion"].includes(String(alert.Severity))) throw new Incomplete("failed", "Vale alert lacks a supported check, message, or severity.");
        const enforce = run.context.configuration?.valeUseConfigSeverity === true;
        const severity: Finding["severity"] = enforce ? alert.Severity === "suggestion" ? "information" : alert.Severity as "error" | "warning" : "warning";
        const line = typeof alert.Line === "number" && Number.isInteger(alert.Line) && alert.Line > 0 ? alert.Line : undefined;
        const span = Array.isArray(alert.Span) && alert.Span.length === 2 && alert.Span.every((column) => Number.isInteger(column) && column > 0) && alert.Span[1] >= alert.Span[0] ? alert.Span as number[] : undefined;
        const multiline = typeof alert.Match === "string" && /[\r\n]/.test(alert.Match);
        run.add({ tool: "vale", kind: "prose", file: run.label(file), code: alert.Check, message: short(alert.Message, 4000), severity, line, ...(!multiline && span ? { column: span[0], endColumn: span[1] + 1, endLine: line, columnEncoding: "unicode" as const } : {}) });
        alerts.push({ file: run.label(file), raw: boundedValeEvidence(alert) });
      }
      if (execution.exitCode === 1 && !(Object.values(output) as unknown[][]).some((values) => values.length)) throw new Incomplete("failed", "Vale exited for lint errors but returned no alerts.");
      run.result.filesAnalyzed!++;
    } catch (error) {
      run.recordError(error, run.label(file));
      if (error instanceof Incomplete && ["cancelled", "timeout", "output-limit", "busy", "unavailable"].includes(error.outcome)) break;
    }
  }
}

export async function runDocumentAnalyzer(id: string, context: AnalyzerContext): Promise<CheckResult> {
  if (id !== "markdown" && id !== "vale") return {
    tool: id, kind: "links", scope: context.target.scope, outcome: "unsupported", completed: false,
    findings: [], environment: context.environment, target: context.target, filesAnalyzed: 0,
    notes: [id === "links-network" ? "Network link checks are not implemented. No request was sent, even when allowNetwork=true. A separate destination, DNS, redirect, privacy, and response safety contract is required." : "Unknown document analyzer."],
    metadata: { networkUsed: false },
  };
  const run = new DocumentRun(context, id);
  try {
    await run.initialize();
    if (id === "markdown") await runMarkdown(run);
    else await runVale(run);
  } catch (error) { run.recordError(error, id); }
  return run.finish();
}
