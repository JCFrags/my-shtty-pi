import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import {
  createReadTool,
  generateDiffString,
  generateUnifiedPatch,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { anchorDocument, resolveAnchorRange } from "@grounded/pi-core/anchors";
import { atomicWriteText } from "@grounded/pi-core/atomic";
import { capture } from "@grounded/pi-core/exec";
import { boundedOutput, persistOutput } from "@grounded/pi-core/output";
import { resolveToolPath } from "@grounded/pi-core/paths";
import { exactFind, exactGrep, fuzzyFiles } from "@grounded/pi-core/search";
import { checkSyntax } from "@grounded/pi-core/syntax";
import {
  countOccurrences,
  detectLineEnding,
  normalizeLf,
  restoreLineEndings,
  sha256,
  stripBom,
} from "@grounded/pi-core/text";

type SyntaxGuard = "off" | "warn" | "block";

function fileToolName(name: string): string {
  return process.env.GROUNDED_TRIAL_MODE === "1" ? `grounded_${name}` : name;
}

function syntaxGuard(): SyntaxGuard {
  const value = process.env.GROUNDED_SYNTAX_GUARD?.toLowerCase();
  return value === "off" || value === "block" ? value : "warn";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

const ReadParams = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  mode: Type.Optional(
    StringEnum(["full", "anchors", "outline", "symbol", "pdf_structure"] as const, {
      description: "full is verbatim (default); other modes are explicit opt-ins",
    }),
  ),
  symbol: Type.Optional(Type.String({ description: "Symbol text to locate when mode=symbol" })),
});

const EditItem = Type.Object({
  oldText: Type.Optional(Type.String({ description: "Exact text for a normal replacement" })),
  newText: Type.Optional(Type.String({ description: "Literal replacement text for a normal replacement" })),
  startAnchor: Type.Optional(Type.String({ description: "First line anchor from read mode=anchors" })),
  endAnchor: Type.Optional(Type.String({ description: "Last line anchor from read mode=anchors" })),
  contentLines: Type.Optional(
    Type.Array(Type.String(), {
      description: "Complete replacement lines for an anchored edit; [] deletes the anchored lines",
    }),
  ),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Path to the existing file" }),
  edits: Type.Array(EditItem, { minItems: 1, description: "Non-overlapping edits matched against one snapshot" }),
  expectedDigest: Type.Optional(
    Type.String({ description: "Optional SHA-256 snapshot digest; required for anchored edits" }),
  ),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Path to create or replace" }),
  content: Type.String({ description: "Complete literal file content" }),
  expectedDigest: Type.Optional(
    Type.String({ description: "Optional SHA-256 digest required to match an existing file" }),
  ),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Search text or regular expression" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search" })),
  glob: Type.Optional(Type.String({ description: "File glob filter" })),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text" })),
  context: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
  cursor: Type.Optional(Type.Number({ minimum: 0, description: "Exact result-line offset from a prior call" })),
});

const FindParams = Type.Object({
  pattern: Type.String({ description: "Glob pattern" }),
  path: Type.Optional(Type.String({ description: "Directory to search" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
  cursor: Type.Optional(Type.Number({ minimum: 0, description: "Exact result offset from a prior call" })),
});

const FuzzyFindParams = Type.Object({
  query: Type.String({ description: "Fuzzy file-name/path query" }),
  path: Type.Optional(Type.String({ description: "Directory constraint" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
});

export interface GroundedEditInput {
  path: string;
  edits: Array<{
    oldText?: string;
    newText?: string;
    startAnchor?: string;
    endAnchor?: string;
    contentLines?: string[];
  }>;
  expectedDigest?: string;
}

export interface GroundedWriteInput {
  path: string;
  content: string;
  expectedDigest?: string;
}

export interface Replacement {
  editIndex: number;
  start: number;
  end: number;
  replacement: string;
}

export function strictReplacements(content: string, edits: Array<{
  oldText?: string;
  newText?: string;
  startAnchor?: string;
  endAnchor?: string;
  contentLines?: string[];
}>, expectedDigest?: string): Replacement[] {
  const anchored = anchorDocument(content);
  const replacements: Replacement[] = [];

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    const usesAnchors = edit.startAnchor !== undefined || edit.endAnchor !== undefined || edit.contentLines !== undefined;
    if (usesAnchors) {
      if (!expectedDigest) throw new Error(`edits[${index}] is anchored and requires expectedDigest from read mode=anchors`);
      if (expectedDigest !== anchored.digest) throw new Error("File snapshot is stale. Read again with mode=anchors.");
      if (!edit.startAnchor || !edit.endAnchor || !edit.contentLines) {
        throw new Error(`edits[${index}] must provide startAnchor, endAnchor, and contentLines together`);
      }
      const range = resolveAnchorRange(anchored, edit.startAnchor, edit.endAnchor);
      const starts: number[] = [];
      let cursor = 0;
      for (const line of anchored.lines) {
        starts.push(cursor);
        cursor += line.length + 1;
      }
      const start = starts[range.start]!;
      const includesTrailingNewline = range.end < anchored.lines.length - 1;
      const end = starts[range.end]! + anchored.lines[range.end]!.length + (includesTrailingNewline ? 1 : 0);
      const replacement = edit.contentLines.length === 0
        ? ""
        : `${edit.contentLines.join("\n")}${includesTrailingNewline ? "\n" : ""}`;
      replacements.push({ editIndex: index, start, end, replacement });
      continue;
    }

    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error(`edits[${index}] must provide oldText/newText or the anchored fields`);
    }
    if (!edit.oldText) throw new Error(`edits[${index}].oldText must not be empty`);
    const positions = countOccurrences(content, normalizeLf(edit.oldText));
    if (positions.length === 0) {
      throw new Error(`edits[${index}].oldText was not found exactly; reread the smallest relevant range and retry`);
    }
    if (positions.length > 1) {
      const locations = positions.slice(0, 10).map((position) => {
        const before = content.slice(0, position);
        const line = before.split("\n").length;
        const column = position - before.lastIndexOf("\n");
        return `${line}:${column}`;
      });
      const more = positions.length > locations.length ? ", …" : "";
      throw new Error(`edits[${index}].oldText matched ${positions.length} locations (${locations.join(", ")}${more}); reread those ranges with more context or use anchors`);
    }
    const start = positions[0]!;
    replacements.push({
      editIndex: index,
      start,
      end: start + normalizeLf(edit.oldText).length,
      replacement: normalizeLf(edit.newText),
    });
  }

  replacements.sort((a, b) => a.start - b.start);
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1]!;
    const current = replacements[index]!;
    if (previous.end > current.start) {
      throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap`);
    }
  }
  return replacements;
}

export function applyReplacements(content: string, replacements: Replacement[]): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]!;
    result = result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end);
  }
  return result;
}

export function constructGroundedEditContent(current: string, input: GroundedEditInput): {
  content: string;
  normalizedBefore: string;
  normalizedAfter: string;
  digestBefore: string;
} {
  const { bom, text } = stripBom(current);
  const ending = detectLineEnding(text);
  const normalizedBefore = normalizeLf(text);
  const digestBefore = sha256(normalizedBefore);
  if (input.expectedDigest && input.expectedDigest !== digestBefore) {
    throw new Error(`File snapshot is stale: expected ${input.expectedDigest}, current ${digestBefore}`);
  }
  const replacements = strictReplacements(normalizedBefore, input.edits, input.expectedDigest);
  const normalizedAfter = applyReplacements(normalizedBefore, replacements);
  if (normalizedAfter === normalizedBefore) throw new Error("No changes made; replacement content is identical");
  return {
    content: bom + restoreLineEndings(normalizedAfter, ending),
    normalizedBefore,
    normalizedAfter,
    digestBefore,
  };
}

export function constructGroundedWriteContent(
  current: string | undefined,
  input: GroundedWriteInput,
): string {
  if (input.expectedDigest) {
    if (current === undefined) throw new Error("expectedDigest was supplied but the file does not exist");
    const actual = sha256(normalizeLf(stripBom(current).text));
    if (actual !== input.expectedDigest) {
      throw new Error(`File snapshot is stale: expected ${input.expectedDigest}, current ${actual}`);
    }
  }
  return input.content;
}

export function outline(text: string): string {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/,
    /^\s*(?:export\s+)?class\s+\w+/,
    /^\s*(?:export\s+)?(?:interface|type|enum|namespace)\s+\w+/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=/,
    /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+\w+/,
    /^\s*(?:def|class)\s+\w+/,
    /^\s*(?:import|export)\b/,
  ];
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => patterns.some((pattern) => pattern.test(line)))
    .map(({ line, number }) => `${number}: ${line}`)
    .join("\n");
}

export default function groundedFiles(pi: ExtensionAPI) {
  const previewAdapter = {
    protocolVersion: 1 as const,
    id: "pi-grounded-tools/files-v1",
    ownerSourcePath: fileURLToPath(import.meta.url),
    tools: ["edit", "write"] as const,
    semantics: {
      async constructEdit(request: {
        input: GroundedEditInput;
        current: Buffer;
        currentExists: boolean;
        signal?: AbortSignal;
      }): Promise<string> {
        throwIfAborted(request.signal);
        if (!request.currentExists) throw Object.assign(new Error("file does not exist"), { code: "ENOENT" });
        return constructGroundedEditContent(request.current.toString("utf8"), request.input).content;
      },
      async constructWrite(request: {
        input: GroundedWriteInput;
        current: Buffer;
        currentExists: boolean;
        signal?: AbortSignal;
      }): Promise<string> {
        throwIfAborted(request.signal);
        const current = request.currentExists ? request.current.toString("utf8") : undefined;
        return constructGroundedWriteContent(current, request.input);
      },
      generateUnifiedDiff(path: string, oldContent: string, newContent: string): string {
        return generateUnifiedPatch(path, oldContent, newContent);
      },
    },
  };
  pi.events.on("pi-review-ui:request-preview-adapters-v1", (reply) => {
    if (typeof reply === "function") (reply as (value: unknown) => void)(previewAdapter);
  });
  pi.events.emit("pi-review-ui:register-preview-adapter-v1", previewAdapter);

  pi.registerTool({
    name: fileToolName("read"),
    label: "read (grounded)",
    description: "Read files verbatim by default. Explicit outline, symbol, and stale-safe anchored modes are available; no automatic compression or summary is performed.",
    promptSnippet: "Read exact file contents, with optional explicit outline, symbol, or anchor modes",
    promptGuidelines: [
      "Use read mode=full unless an outline, symbol window, or hash anchors are explicitly useful.",
      "Use read mode=anchors before an anchored edit; copy its snapshot digest and anchors exactly.",
    ],
    parameters: ReadParams,
    async execute(id, params, signal, onUpdate, ctx) {
      const mode = params.mode ?? "full";
      if (mode === "full") {
        const base = createReadTool(ctx.cwd);
        const result = await base.execute(id, {
          path: params.path,
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }, signal, onUpdate);
        const details = result.details as { truncation?: { truncated?: boolean } } | undefined;
        if (!details?.truncation?.truncated) return result;

        throwIfAborted(signal);
        const raw = await readFile(resolveToolPath(ctx.cwd, params.path));
        const fullOutputPath = await persistOutput("grounded-read", raw);
        const content = result.content.map((block) => block.type === "text"
          ? { ...block, text: `${block.text}\n\n[Complete original file bytes: ${fullOutputPath}]` }
          : block);
        return { content, details: { ...details, fullOutputPath } };
      }

      const absolute = resolveToolPath(ctx.cwd, params.path);
      await access(absolute, constants.R_OK);
      if (mode === "pdf_structure") {
        if (!absolute.toLowerCase().endsWith(".pdf")) throw new Error("mode=pdf_structure requires a .pdf file");
        const runOptions = { cwd: ctx.cwd, ...(signal ? { signal } : {}), maxBytes: 100 * 1024 * 1024 };
        const [metadata, extracted] = await Promise.all([
          capture("pdfinfo", [absolute], runOptions),
          capture("pdftotext", ["-layout", absolute, "-"], runOptions),
        ]).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("pdf_structure requires pdfinfo and pdftotext on PATH");
          throw error;
        });
        if (metadata.code !== 0) throw new Error(`pdfinfo failed: ${metadata.stderr.trim()}`);
        if (extracted.code !== 0) throw new Error(`pdftotext failed: ${extracted.stderr.trim()}`);
        const pages = extracted.stdout.split("\f");
        if (pages.at(-1) === "") pages.pop();
        const structured = [
          "PDF metadata:",
          metadata.stdout.replace(/\n$/, ""),
          "",
          ...pages.flatMap((page, index) => [`--- Page ${index + 1} ---`, page.replace(/\n$/, "")]),
        ].join("\n");
        const bounded = await boundedOutput(structured, { prefix: "grounded-pdf", direction: "head" });
        return textResult(bounded.text, { mode, pages: pages.length, fullOutputPath: bounded.fullOutputPath });
      }

      const raw = await readFile(absolute);
      if (raw.includes(0)) throw new Error("Non-text files can only be read with mode=full or mode=pdf_structure");
      const { text } = stripBom(raw.toString("utf8"));
      const normalized = normalizeLf(text);

      if (mode === "anchors") {
        const document = anchorDocument(normalized);
        const start = Math.max(0, (params.offset ?? 1) - 1);
        const end = params.limit ? Math.min(document.lines.length, start + params.limit) : document.lines.length;
        const rendered = [
          `snapshot:${document.digest}`,
          ...document.lines.slice(start, end).map((line, offset) => `${document.anchors[start + offset]}│${line}`),
        ].join("\n");
        const bounded = await boundedOutput(rendered, { prefix: "grounded-read", direction: "head" });
        const continuation = end < document.lines.length ? `\n\n[More lines available: offset=${end + 1}]` : "";
        return textResult(bounded.text + continuation, {
          digest: document.digest,
          startLine: start + 1,
          endLine: end,
          totalLines: document.lines.length,
          fullOutputPath: bounded.fullOutputPath,
        });
      }

      if (mode === "outline") {
        const result = outline(normalized) || "No outline declarations found.";
        const bounded = await boundedOutput(result, { prefix: "grounded-outline", direction: "head" });
        return textResult(bounded.text, { digest: sha256(normalized), mode, fullOutputPath: bounded.fullOutputPath });
      }

      if (!params.symbol) throw new Error("symbol is required when mode=symbol");
      const lines = normalized.split("\n");
      const expression = new RegExp(`\\b${params.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      const match = lines.findIndex((line) => expression.test(line));
      if (match < 0) throw new Error(`Symbol text not found: ${params.symbol}`);
      const start = Math.max(0, match - 5);
      const end = Math.min(lines.length, match + 16);
      return textResult(lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n"), {
        digest: sha256(normalized),
        mode,
        matchLine: match + 1,
      });
    },
  });

  pi.registerTool({
    name: fileToolName("edit"),
    label: "edit (grounded)",
    description: "Apply strict, literal, non-overlapping edits against one file snapshot. No fuzzy relocation or silent correction. Supports optional anchored line edits from read mode=anchors.",
    promptSnippet: "Apply strict atomic edits with optional stale-safe anchors",
    promptGuidelines: [
      "Use edit oldText/newText for normal strict replacements; oldText must be unique in the original file.",
      "For repeated or concurrently changing text, use read mode=anchors and edit with expectedDigest, startAnchor, endAnchor, and contentLines.",
    ],
    parameters: EditParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as never;
      const input = args as Record<string, unknown>;
      if (typeof input.oldText === "string" && typeof input.newText === "string" && !Array.isArray(input.edits)) {
        return {
          path: String(input.path ?? ""),
          ...(typeof input.expectedDigest === "string" ? { expectedDigest: input.expectedDigest } : {}),
          edits: [{ oldText: input.oldText, newText: input.newText }],
        };
      }
      return args as never;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const absolute = resolveToolPath(ctx.cwd, params.path);
      return withFileMutationQueue(absolute, async () => {
        throwIfAborted(signal);
        await access(absolute, constants.R_OK | constants.W_OK);
        const raw = await readFile(absolute, "utf8");
        const proposed = constructGroundedEditContent(raw, params);
        const syntax = await checkSyntax(absolute, proposed.content, signal);
        if (!syntax.ok && syntaxGuard() === "block") {
          throw new Error(`Syntax guard blocked the edit (${syntax.engine}): ${syntax.message ?? "invalid syntax"}`);
        }
        throwIfAborted(signal);
        const write = await atomicWriteText(absolute, proposed.content);
        const diff = generateDiffString(proposed.normalizedBefore, proposed.normalizedAfter);
        const patch = generateUnifiedPatch(params.path, proposed.normalizedBefore, proposed.normalizedAfter);
        const warning = !syntax.ok ? `\nSyntax warning (${syntax.engine}): ${syntax.message ?? "invalid syntax"}` : "";
        return textResult(`Successfully replaced ${params.edits.length} block(s) in ${params.path}.${warning}`, {
          diff: diff.diff,
          patch,
          firstChangedLine: diff.firstChangedLine,
          digestBefore: proposed.digestBefore,
          digestAfter: sha256(proposed.normalizedAfter),
          syntax,
          atomic: write.atomic,
          preservedHardLinks: write.preservedHardLinks,
        });
      });
    },
  });

  pi.registerTool({
    name: fileToolName("write"),
    label: "write (grounded)",
    description: "Create or replace a complete text file literally using an atomic write where filesystem semantics permit. Returns exact syntax diagnostics and overwrite diff metadata.",
    promptSnippet: "Create or replace complete files atomically without summarizing content",
    promptGuidelines: ["Use write for complete files; prefer edit for targeted changes to existing files."],
    parameters: WriteParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const absolute = resolveToolPath(ctx.cwd, params.path);
      return withFileMutationQueue(absolute, async () => {
        throwIfAborted(signal);
        let previous: string | undefined;
        try {
          previous = await readFile(absolute, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const proposed = constructGroundedWriteContent(previous, params);
        const syntax = await checkSyntax(absolute, proposed, signal);
        if (!syntax.ok && syntaxGuard() === "block") {
          throw new Error(`Syntax guard blocked the write (${syntax.engine}): ${syntax.message ?? "invalid syntax"}`);
        }
        throwIfAborted(signal);
        const result = await atomicWriteText(absolute, proposed);
        const oldText = previous ?? "";
        const diff = generateDiffString(oldText, proposed);
        const patch = generateUnifiedPatch(params.path, oldText, proposed);
        const warning = !syntax.ok ? `\nSyntax warning (${syntax.engine}): ${syntax.message ?? "invalid syntax"}` : "";
        return textResult(`Wrote ${params.content.length} characters to ${params.path}.${warning}`, {
          diff: diff.diff,
          patch,
          firstChangedLine: diff.firstChangedLine,
          digestAfter: sha256(normalizeLf(stripBom(proposed).text)),
          syntax,
          atomic: result.atomic,
          preservedHardLinks: result.preservedHardLinks,
        });
      });
    },
  });

  pi.registerTool({
    name: fileToolName("grep"),
    label: "grep (grounded)",
    description: "Exhaustive exact or regex search using ripgrep. Results are deterministic and paged without relevance filtering; full output is retained when the visible result is bounded.",
    promptSnippet: "Search exact text or regex exhaustively with deterministic pagination",
    parameters: GrepParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const page = await exactGrep({
        cwd: ctx.cwd,
        pattern: params.pattern,
        path: params.path ?? ".",
        ...(params.glob ? { glob: params.glob } : {}),
        ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
        ...(params.literal !== undefined ? { literal: params.literal } : {}),
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!page.output) return textResult("No matches found", { totalLines: 0 });
      const bounded = await boundedOutput(page.output, { prefix: "grounded-grep", direction: "head" });
      let fullOutputPath = bounded.fullOutputPath;
      if (page.nextCursor !== undefined && !fullOutputPath) fullOutputPath = await persistOutput("grounded-grep", page.allOutput);
      const suffix = page.nextCursor === undefined ? "" : `\n\n[More exact result lines available: cursor=${page.nextCursor}. Full output: ${fullOutputPath}]`;
      return textResult(bounded.text + suffix, {
        totalLines: page.totalLines,
        nextCursor: page.nextCursor,
        fullOutputPath,
      });
    },
  });

  pi.registerTool({
    name: fileToolName("find"),
    label: "find (grounded)",
    description: "Deterministic gitignore-aware file and directory glob search using fd, with exact cursor pagination.",
    promptSnippet: "Find paths deterministically by glob with exact pagination",
    parameters: FindParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const page = await exactFind({
        cwd: ctx.cwd,
        pattern: params.pattern,
        path: params.path ?? ".",
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!page.output) return textResult("No files found", { total: 0 });
      let fullOutputPath: string | undefined;
      if (page.nextCursor !== undefined) fullOutputPath = await persistOutput("grounded-find", page.allOutput);
      const suffix = page.nextCursor === undefined ? "" : `\n\n[More exact paths available: cursor=${page.nextCursor}. Full output: ${fullOutputPath}]`;
      return textResult(page.output + suffix, { total: page.totalLines, nextCursor: page.nextCursor, fullOutputPath });
    },
  });

  pi.registerTool({
    name: "fuzzy_find",
    label: "Fuzzy find",
    description: "Exploratory fuzzy file search. Results are explicitly ranked and Git-changed files receive a visible boost; use find/grep when exhaustive evidence is required.",
    promptSnippet: "Fuzzily locate likely files without replacing exhaustive find or grep",
    parameters: FuzzyFindParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const matches = await fuzzyFiles({
        cwd: ctx.cwd,
        query: params.query,
        path: params.path ?? ".",
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(signal ? { signal } : {}),
      });
      return textResult(
        matches.length
          ? matches.map((match) => `${match.gitChanged ? "*" : " "} ${match.path}\t(score ${match.score.toFixed(1)})`).join("\n")
          : "No fuzzy matches found",
        { matches },
      );
    },
  });

  pi.registerCommand("grounded-files", {
    description: "Show grounded file-tool policy",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Grounded files: strict exact edits, full-fidelity reads, deterministic search, syntaxGuard=${syntaxGuard()}`,
        "info",
      );
    },
  });
}
