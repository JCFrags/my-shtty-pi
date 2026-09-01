import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReadTool,
  generateDiffString,
  generateUnifiedPatch,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { anchorDocument, resolveAnchorRange } from "@grounded/pi-core/anchors";
import { atomicWriteText } from "@grounded/pi-core/atomic";
import { capture } from "@grounded/pi-core/exec";
import { boundedOutput, persistOutput } from "@grounded/pi-core/output";
import { resolveToolPath } from "@grounded/pi-core/paths";
import {
  filterStructuredFileInventory,
  structuredFileSearch,
  structuredFuzzySearch,
  structuredTextSearch,
} from "@grounded/pi-core/search";
import {
  SESSION_FILE_RESOURCE_PROTOCOL_VERSION,
  SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
  SESSION_OPERATION_SERVICE_V2_READY_EVENT,
  SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT,
  SessionServiceError,
  type SessionFileResource,
  type SessionOperationServiceV2,
  type SessionOperationServiceV2RequestEvent,
} from "@grounded/pi-core/session-contract";
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

function remoteMutationQueuePath(resource: SessionFileResource, canonicalPath: string): string {
  return join(tmpdir(), "pi-grounded-remote-mutation", sha256(`${resource.queueIdentity}\0${canonicalPath}`));
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function compactSearchValue(value: string, maxCharacters = 72): string {
  const characters = [...value];
  const clipped = characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters - 1).join("")}…`
    : value;
  return JSON.stringify(clipped);
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
  sessionId: Type.Optional(Type.String({ description: "Explicit local session id; relative paths use the session working directory" })),
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
  sessionId: Type.Optional(Type.String({ description: "Explicit local session id; relative paths use the session working directory" })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Path to create or replace" }),
  content: Type.String({ description: "Complete literal file content" }),
  expectedDigest: Type.Optional(
    Type.String({ description: "Optional SHA-256 digest required to match an existing file" }),
  ),
  sessionId: Type.Optional(Type.String({ description: "Explicit local session id; relative paths use the session working directory" })),
});

export const LocalSearchParams = Type.Union([
  Type.Object({
    action: Type.Literal("capabilities"),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("query"),
    strategy: Type.Literal("text"),
    query: Type.String({ minLength: 1, description: "Literal text or regular expression" }),
    syntax: Type.Optional(StringEnum(["literal", "regex"] as const)),
    path: Type.Optional(Type.String({ description: "Directory or file scope" })),
    fileGlob: Type.Optional(Type.String({ description: "File glob filter" })),
    ignoreCase: Type.Optional(Type.Boolean()),
    contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String({ minLength: 1, description: "Opaque continuation cursor from the same query" })),
    sessionId: Type.Optional(Type.String({ description: "Explicit local session id; relative scope uses the session working directory" })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("query"),
    strategy: Type.Literal("files"),
    pathGlob: Type.String({ minLength: 1, description: "Full relative-path glob" }),
    path: Type.Optional(Type.String({ description: "Directory scope" })),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String({ minLength: 1, description: "Opaque continuation cursor from the same query" })),
    sessionId: Type.Optional(Type.String({ description: "Explicit local session id; relative scope uses the session working directory" })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("query"),
    strategy: Type.Literal("fuzzy"),
    query: Type.String({ minLength: 1, description: "Fuzzy file-name or path query" }),
    path: Type.Optional(Type.String({ description: "Directory scope" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    sessionId: Type.Optional(Type.String({ description: "Reserved for exact strategies; fuzzy session routing is not supported" })),
  }, { additionalProperties: false }),
]);

type SearchCursor = {
  version: 1;
  fingerprint: string;
  strategy: "text" | "files";
  offset: number;
};

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSearchCursor(value: string): SearchCursor {
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid local_search cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid local_search cursor");
  }
  const cursor = parsed as Partial<SearchCursor>;
  const keys = Object.keys(cursor).sort();
  if (keys.length !== 4 || keys.join(",") !== "fingerprint,offset,strategy,version"
    || cursor.version !== 1 || (cursor.strategy !== "text" && cursor.strategy !== "files")
    || typeof cursor.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(cursor.fingerprint)
    || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0) {
    throw new Error("Invalid local_search cursor");
  }
  return cursor as SearchCursor;
}


export interface GroundedEditInput {
  path: string;
  sessionId?: string;
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
  sessionId?: string;
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

function imageMime(raw: Buffer): string | undefined {
  if (raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return "image/jpeg";
  const header = raw.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (raw.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (raw.subarray(0, 4).toString("ascii") === "RIFF" && raw.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

async function remoteFullRead(
  raw: Buffer,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: Record<string, unknown> }> {
  const mimeType = imageMime(raw);
  if (mimeType) {
    return {
      content: [
        { type: "text", text: `Read remote image file [${mimeType}]` },
        { type: "image", data: raw.toString("base64"), mimeType },
      ],
      details: { remote: true, bytes: raw.length, mimeType },
    };
  }
  const allLines = raw.toString("utf8").split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  if (start >= allLines.length) throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  const end = limit === undefined ? allLines.length : Math.min(allLines.length, start + Math.max(0, limit));
  const selected = allLines.slice(start, end).join("\n");
  const bounded = await boundedOutput(selected, { prefix: "grounded-remote-read", direction: "head" });
  const continuation = end < allLines.length ? `\n\n[${allLines.length - end} more lines in file. Use offset=${end + 1} to continue.]` : "";
  const exactPath = bounded.truncated ? await persistOutput("grounded-remote-read-exact", raw) : undefined;
  const exactNotice = exactPath ? `\n\n[Complete original remote file bytes: ${exactPath}]` : "";
  return {
    content: [{ type: "text", text: bounded.text + continuation + exactNotice }],
    details: {
      remote: true,
      bytes: raw.length,
      totalFileLines: allLines.length,
      startLine: start + 1,
      endLine: end,
      truncated: bounded.truncated,
      fullOutputPath: exactPath ?? null,
      sourcePath: path,
    },
  };
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
  let sessionOperationService: SessionOperationServiceV2 | undefined;
  const acceptSessionOperationService = (service: SessionOperationServiceV2) => {
    if (service?.protocolVersion !== SESSION_OPERATION_SERVICE_PROTOCOL_VERSION || typeof service.withSession !== "function") {
      throw new SessionServiceError("SESSION_SERVICE_VERSION_UNSUPPORTED", "Invalid session operation service v2");
    }
    if (sessionOperationService && sessionOperationService !== service) {
      throw new SessionServiceError("SESSION_SERVICE_DUPLICATE", "A different session operation service is already registered");
    }
    sessionOperationService = service;
  };
  pi.events.on(SESSION_OPERATION_SERVICE_V2_READY_EVENT, (value) => {
    acceptSessionOperationService(value as SessionOperationServiceV2);
  });
  pi.events.emit(SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT, {
    protocolVersion: SESSION_OPERATION_SERVICE_PROTOCOL_VERSION,
    accept: acceptSessionOperationService,
  } satisfies SessionOperationServiceV2RequestEvent);

  async function withEffectiveSession<T>(
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    defaultCwd: string,
    operation: (cwd: string, resource: SessionFileResource | undefined, backend: "local" | "ssh") => Promise<T>,
  ): Promise<T> {
    if (sessionId === undefined) return operation(defaultCwd, undefined, "local");
    if (!sessionOperationService) {
      throw new SessionServiceError(
        "SESSION_SERVICE_UNAVAILABLE",
        "Session-aware file operations require the Grounded Process session service",
      );
    }
    return sessionOperationService.withSession(
      sessionId,
      (session) => {
        if (session.backend === "ssh" && (session.fileResource?.protocolVersion !== SESSION_FILE_RESOURCE_PROTOCOL_VERSION)) {
          throw new SessionServiceError(
            "SESSION_FILE_RESOURCE_UNAVAILABLE",
            `SSH session provider does not support exact file operations: ${session.providerId}`,
          );
        }
        return operation(session.cwd, session.fileResource, session.backend);
      },
      signal ? { signal } : undefined,
    );
  }

  async function runFileOperation<T extends { details?: unknown }>(
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
    defaultCwd: string,
    operation: (cwd: string, resource: SessionFileResource | undefined, backend: "local" | "ssh") => Promise<T>,
  ): Promise<T> {
    return withEffectiveSession(sessionId, signal, defaultCwd, async (cwd, resource, backend) => {
      const result = await operation(cwd, resource, backend);
      if (sessionId === undefined) return result;
      const details = result.details && typeof result.details === "object" && !Array.isArray(result.details)
        ? result.details as Record<string, unknown>
        : {};
      return {
        ...result,
        details: {
          ...details,
          sessionId,
          sessionCwd: cwd,
          sessionBackend: backend,
        },
      };
    });
  }

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
        if (request.input.sessionId !== undefined) {
          throw new SessionServiceError(
            "SESSION_REVIEW_UNSUPPORTED",
            "The inactive Review UI adapter cannot preview session-relative edit operations",
          );
        }
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
        if (request.input.sessionId !== undefined) {
          throw new SessionServiceError(
            "SESSION_REVIEW_UNSUPPORTED",
            "The inactive Review UI adapter cannot preview session-relative write operations",
          );
        }
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
    description: "Read files verbatim by default. Explicit outline, symbol, and stale-safe anchored modes are available. Optional sessionId uses an existing local or SSH session working directory; omission keeps normal local behavior.",
    promptSnippet: "Read exact file contents, with optional explicit outline, symbol, or anchor modes",
    promptGuidelines: [
      "Use read mode=full unless an outline, symbol window, or hash anchors are explicitly useful.",
      "Use read mode=anchors before an anchored edit; copy its snapshot digest and anchors exactly.",
      "Set sessionId only for an existing session when paths must follow that session and provider.",
    ],
    parameters: ReadParams,
    async execute(id, params, signal, onUpdate, ctx) {
      return runFileOperation(params.sessionId, signal, ctx.cwd, async (operationCwd, resource, backend) => {
        const mode = params.mode ?? "full";
        const remoteSnapshot = backend === "ssh"
          ? await resource!.read(params.path, { ...(signal ? { signal } : {}) })
          : undefined;
        const remoteRaw = remoteSnapshot?.exists
          ? Buffer.from(remoteSnapshot.dataBase64!, "base64")
          : undefined;
        if (mode === "full") {
          if (backend === "ssh") return remoteFullRead(remoteRaw!, params.path, params.offset, params.limit);
          const base = createReadTool(operationCwd);
          const result = await base.execute(id, {
            path: params.path,
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          }, signal, onUpdate);
          const details = result.details as { truncation?: { truncated?: boolean } } | undefined;
          if (!details?.truncation?.truncated) return result;

          throwIfAborted(signal);
          const raw = await readFile(resolveToolPath(operationCwd, params.path));
          const fullOutputPath = await persistOutput("grounded-read", raw);
          const content = result.content.map((block) => block.type === "text"
            ? { ...block, text: `${block.text}\n\n[Complete original file bytes: ${fullOutputPath}]` }
            : block);
          return { content, details: { ...details, fullOutputPath } };
        }

        const absolute = backend === "ssh" ? remoteSnapshot!.canonicalPath : resolveToolPath(operationCwd, params.path);
        if (backend === "local") await access(absolute, constants.R_OK);
      if (mode === "pdf_structure") {
        if (backend === "ssh") {
          throw new SessionServiceError("SESSION_READ_MODE_UNSUPPORTED", "mode=pdf_structure remains local-only");
        }
        if (!absolute.toLowerCase().endsWith(".pdf")) throw new Error("mode=pdf_structure requires a .pdf file");
        const runOptions = { cwd: operationCwd, ...(signal ? { signal } : {}), maxBytes: 100 * 1024 * 1024 };
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

      const raw = backend === "ssh" ? remoteRaw! : await readFile(absolute);
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
      });
    },
  });

  pi.registerTool({
    name: fileToolName("edit"),
    label: "edit (grounded)",
    description: "Apply strict, literal, non-overlapping edits against one file snapshot. No fuzzy relocation or silent correction. Optional sessionId uses an existing local or SSH session working directory.",
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
          ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
          edits: [{ oldText: input.oldText, newText: input.newText }],
        };
      }
      return args as never;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runFileOperation(params.sessionId, signal, ctx.cwd, async (operationCwd, resource, backend) => {
        const absolute = backend === "ssh"
          ? await resource!.resolve(params.path, signal ? { signal } : undefined)
          : resolveToolPath(operationCwd, params.path);
        const queueKey = backend === "ssh" ? remoteMutationQueuePath(resource!, absolute) : absolute;
        return withFileMutationQueue(queueKey, async () => {
          throwIfAborted(signal);
          let raw: string;
          let expectedRawDigest: string | undefined;
          if (backend === "ssh") {
            const snapshot = await resource!.read(params.path, { ...(signal ? { signal } : {}) });
            if (snapshot.canonicalPath !== absolute) throw new SessionServiceError("SESSION_FILE_CONFLICT", "Remote path identity changed before edit");
            raw = Buffer.from(snapshot.dataBase64!, "base64").toString("utf8");
            expectedRawDigest = snapshot.rawDigest;
          } else {
            await access(absolute, constants.R_OK | constants.W_OK);
            raw = await readFile(absolute, "utf8");
          }
          const proposed = constructGroundedEditContent(raw, params);
          const syntax = await checkSyntax(absolute, proposed.content, signal);
          if (!syntax.ok && syntaxGuard() === "block") {
            throw new Error(`Syntax guard blocked the edit (${syntax.engine}): ${syntax.message ?? "invalid syntax"}`);
          }
          throwIfAborted(signal);
          const write = backend === "ssh"
            ? await resource!.commit({
                path: params.path,
                canonicalPath: absolute,
                dataBase64: Buffer.from(proposed.content, "utf8").toString("base64"),
                expectedExists: true,
                ...(expectedRawDigest ? { expectedRawDigest } : {}),
              }, signal ? { signal } : undefined)
            : await atomicWriteText(absolute, proposed.content);
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
            ...("rollbackAvailable" in write ? {
              rollbackAvailable: write.rollbackAvailable,
              hardLinksBefore: write.hardLinksBefore,
              hardLinkTopologyRollback: false,
            } : {}),
          });
        });
      });
    },
  });

  pi.registerTool({
    name: fileToolName("write"),
    label: "write (grounded)",
    description: "Create or replace a complete text file literally using an atomic write where filesystem semantics permit. Optional sessionId uses an existing local or SSH session working directory.",
    promptSnippet: "Create or replace complete files atomically without summarizing content",
    promptGuidelines: ["Use write for complete files; prefer edit for targeted changes to existing files."],
    parameters: WriteParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return runFileOperation(params.sessionId, signal, ctx.cwd, async (operationCwd, resource, backend) => {
        const absolute = backend === "ssh"
          ? await resource!.resolve(params.path, signal ? { signal } : undefined)
          : resolveToolPath(operationCwd, params.path);
        const queueKey = backend === "ssh" ? remoteMutationQueuePath(resource!, absolute) : absolute;
        return withFileMutationQueue(queueKey, async () => {
          throwIfAborted(signal);
          let previous: string | undefined;
          let expectedRawDigest: string | undefined;
          let expectedExists = false;
          if (backend === "ssh") {
            const snapshot = await resource!.read(params.path, { allowMissing: true, ...(signal ? { signal } : {}) });
            if (snapshot.canonicalPath !== absolute) throw new SessionServiceError("SESSION_FILE_CONFLICT", "Remote path identity changed before write");
            expectedExists = snapshot.exists;
            if (snapshot.exists) {
              previous = Buffer.from(snapshot.dataBase64!, "base64").toString("utf8");
              expectedRawDigest = snapshot.rawDigest;
            }
          } else {
            try {
              previous = await readFile(absolute, "utf8");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          const proposed = constructGroundedWriteContent(previous, params);
          const syntax = await checkSyntax(absolute, proposed, signal);
          if (!syntax.ok && syntaxGuard() === "block") {
            throw new Error(`Syntax guard blocked the write (${syntax.engine}): ${syntax.message ?? "invalid syntax"}`);
          }
          throwIfAborted(signal);
          const result = backend === "ssh"
            ? await resource!.commit({
                path: params.path,
                canonicalPath: absolute,
                dataBase64: Buffer.from(proposed, "utf8").toString("base64"),
                expectedExists,
                ...(expectedRawDigest ? { expectedRawDigest } : {}),
              }, signal ? { signal } : undefined)
            : await atomicWriteText(absolute, proposed);
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
            ...("rollbackAvailable" in result ? {
              rollbackAvailable: result.rollbackAvailable,
              hardLinksBefore: result.hardLinksBefore,
              hardLinkTopologyRollback: false,
            } : {}),
          });
        });
      });
    },
  });

  pi.registerTool({
    name: "local_search",
    label: "Local search",
    description: "Unified local discovery with explicit text, files, and fuzzy strategies. Optional sessionId supports exact text and files queries in an existing local or SSH session; fuzzy rejects session routing.",
    promptSnippet: "Search local content or paths through explicit record-safe strategies",
    promptGuidelines: [
      "Use local_search for normal local discovery when an explicit text, files, or fuzzy strategy fits.",
      "Use local_search strategy=text for exhaustive literal or regex evidence, strategy=files for full relative-path globs, and strategy=fuzzy only for exploratory path ranking.",
      "Do not treat local_search strategy=fuzzy results as proof that a path does not exist.",
    ],
    parameters: LocalSearchParams,
    renderCall(args, theme) {
      const input = args as Record<string, unknown>;
      const title = theme.fg("toolTitle", theme.bold("local_search "));
      if (input.action === "capabilities") {
        return new Text(title + theme.fg("muted", "capabilities"), 0, 0);
      }

      const strategy = input.strategy === "files" || input.strategy === "fuzzy" ? input.strategy : "text";
      const searched = strategy === "files" ? String(input.pathGlob ?? "") : String(input.query ?? "");
      const scope = typeof input.path === "string" && input.path.length > 0 ? input.path : ".";
      const modifiers: string[] = [];
      if (strategy === "text" && input.syntax === "regex") modifiers.push("regex");
      if (strategy === "text" && typeof input.fileGlob === "string") {
        modifiers.push(`files ${compactSearchValue(input.fileGlob)}`);
      }
      if (strategy === "text" && input.ignoreCase === true) modifiers.push("ignore case");
      if (strategy === "text" && typeof input.contextLines === "number") {
        modifiers.push(`context ${input.contextLines}`);
      }
      if (typeof input.cursor === "string") modifiers.push("next page");
      if (typeof input.sessionId === "string") modifiers.push("session");

      const summary = [
        theme.fg("muted", strategy),
        theme.fg("accent", ` ${compactSearchValue(searched)}`),
        theme.fg("muted", ` in ${compactSearchValue(scope)}`),
        ...modifiers.map((modifier) => theme.fg("muted", ` · ${modifier}`)),
      ].join("");
      return new Text(title + summary, 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "capabilities") {
        return textResult([
          "local_search strategies:",
          "- text: structured ripgrep search; literal by default; paged by match hit",
          "- files: structured full relative-path glob search; paged by path hit",
          "- fuzzy: ranked path discovery with an optional visible Git-change boost",
          "Unavailable by design: auto, hybrid, ranked passages, and indexes.",
        ].join("\n"), {
          schemaVersion: 1,
          strategies: ["text", "files", "fuzzy"],
          defaults: { textSyntax: "literal", exactPageSize: 20, fuzzyLimit: 100 },
          unavailable: ["auto", "hybrid", "ranked"],
        });
      }

      if (params.strategy === "fuzzy" && params.sessionId !== undefined) {
        throw new SessionServiceError(
          "SESSION_SEARCH_STRATEGY_UNSUPPORTED",
          "local_search strategy=fuzzy does not support sessionId; use strategy=text or strategy=files",
        );
      }
      return runFileOperation(params.sessionId, signal, ctx.cwd, async (operationCwd, resource, backend) => {
        const scope = params.path ?? ".";
        if (params.strategy === "text") {
        const pageSize = params.pageSize ?? 20;
        const normalizedRequest = {
          action: "query" as const,
          strategy: "text" as const,
          query: params.query,
          syntax: params.syntax ?? "literal",
          path: scope,
          fileGlob: params.fileGlob ?? null,
          ignoreCase: params.ignoreCase ?? false,
          contextLines: params.contextLines ?? 2,
          pageSize,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId, sessionCwd: operationCwd } : {}),
        };
        const fingerprint = sha256(JSON.stringify({ ...normalizedRequest, pageSize: undefined }));
        let offset = 0;
        if (params.cursor) {
          const cursor = decodeSearchCursor(params.cursor);
          if (cursor.strategy !== "text" || cursor.fingerprint !== fingerprint) {
            throw new Error("local_search cursor does not match this query");
          }
          offset = cursor.offset;
        }
        const hits = backend === "ssh"
          ? (await resource!.searchText({
              query: params.query,
              path: scope,
              ...(params.fileGlob ? { fileGlob: params.fileGlob } : {}),
              ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
              literal: params.syntax !== "regex",
              ...(params.contextLines !== undefined ? { contextLines: params.contextLines } : {}),
            }, signal ? { signal } : undefined)).hits
          : await structuredTextSearch({
              cwd: operationCwd,
              query: params.query,
              path: scope,
              ...(params.fileGlob ? { fileGlob: params.fileGlob } : {}),
              ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
              literal: params.syntax !== "regex",
              ...(params.contextLines !== undefined ? { contextLines: params.contextLines } : {}),
              ...(signal ? { signal } : {}),
            });
        const page = hits.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < hits.length
          ? encodeSearchCursor({ version: 1, fingerprint, strategy: "text", offset: nextOffset })
          : undefined;
        const rendered = page.map((hit, index) => [
          `${offset + index + 1}. ${hit.path}:${hit.line}:${hit.byteColumn}`,
          `   exact submatches: ${hit.submatchCount}`,
          hit.snippet.split("\n").map((line) => `   ${line}`).join("\n"),
        ].join("\n")).join("\n\n");
        const qualifications = [
          "hidden-included", "dot-git-excluded", "ignore-without-git",
          "binary-ripgrep-policy", "symlinks-not-followed", "current-snapshot-continuation",
        ];
        const header = [
          "Strategy: text",
          "Coverage: exhaustive under the listed qualifications",
          `Returned: ${page.length} of ${hits.length}${nextCursor ? "; next cursor available" : ""}`,
          "Qualifications: hidden paths included; .git excluded; ignore rules honored without requiring a Git repository; binary and unreadable-file behavior follows ripgrep; symlinks are not followed; continuation reads the current filesystem snapshot.",
        ].join("\n");
        const bounded = await boundedOutput(`${header}${rendered ? `\n\n${rendered}` : "\n\nNo matches found"}`, {
          prefix: "grounded-local-search",
          direction: "head",
          maxBytes: 30 * 1024,
        });
        return textResult(bounded.text, {
          schemaVersion: 1,
          normalizedRequest,
          requestFingerprint: fingerprint,
          fingerprint,
          engine: "ripgrep-json",
          fallbackAttempted: false,
          strategy: "text",
          scope,
          outcome: hits.length === 0 ? "no_matches" : "matches",
          coverage: "exhaustive",
          coverageClass: "exhaustive",
          complete: true,
          absenceEvidence: hits.length === 0,
          qualifications,
          warnings: [],
          hits: page,
          totalHits: hits.length,
          nextCursor,
          page: { offset, pageSize, returned: page.length, total: hits.length, nextCursor: nextCursor ?? null },
          snapshot: "current-filesystem-per-call",
          fullOutputPath: bounded.fullOutputPath,
        });
      }

      if (params.strategy === "files") {
        const pageSize = params.pageSize ?? 20;
        const normalizedRequest = {
          action: "query" as const,
          strategy: "files" as const,
          pathGlob: params.pathGlob,
          path: scope,
          pageSize,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId, sessionCwd: operationCwd } : {}),
        };
        const fingerprint = sha256(JSON.stringify({ ...normalizedRequest, pageSize: undefined }));
        let offset = 0;
        if (params.cursor) {
          const cursor = decodeSearchCursor(params.cursor);
          if (cursor.strategy !== "files" || cursor.fingerprint !== fingerprint) {
            throw new Error("local_search cursor does not match this query");
          }
          offset = cursor.offset;
        }
        const hits = backend === "ssh"
          ? filterStructuredFileInventory({
              cwd: operationCwd,
              pathGlob: params.pathGlob,
              path: scope,
              inventory: (await resource!.searchFiles({ path: scope }, signal ? { signal } : undefined)).hits,
              ...(signal ? { signal } : {}),
            })
          : await structuredFileSearch({
              cwd: operationCwd,
              pathGlob: params.pathGlob,
              path: scope,
              ...(signal ? { signal } : {}),
            });
        const page = hits.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < hits.length
          ? encodeSearchCursor({ version: 1, fingerprint, strategy: "files", offset: nextOffset })
          : undefined;
        const rendered = page.map((hit, index) => `${offset + index + 1}. ${hit.path}`).join("\n");
        const qualifications = [
          "basename-glob-without-slash", "full-relative-path-glob-with-slash",
          "hidden-included", "dot-git-excluded", "ignore-without-git",
          "symlinks-not-followed", "current-snapshot-continuation",
        ];
        const header = [
          "Strategy: files",
          "Coverage: exhaustive under the listed qualifications",
          `Returned: ${page.length} of ${hits.length}${nextCursor ? "; next cursor available" : ""}`,
          "Qualifications: pathGlob matches a full relative path when it contains '/', otherwise it matches any basename; hidden paths included; .git excluded; ignore rules honored without requiring a Git repository; symlinks are not followed; continuation reads the current filesystem snapshot.",
        ].join("\n");
        const bounded = await boundedOutput(`${header}${rendered ? `\n\n${rendered}` : "\n\nNo paths found"}`, {
          prefix: "grounded-local-search",
          direction: "head",
          maxBytes: 30 * 1024,
        });
        return textResult(bounded.text, {
          schemaVersion: 1,
          normalizedRequest,
          requestFingerprint: fingerprint,
          fingerprint,
          engine: "fd-nul",
          fallbackAttempted: false,
          strategy: "files",
          scope,
          outcome: hits.length === 0 ? "no_matches" : "matches",
          coverage: "exhaustive",
          coverageClass: "exhaustive",
          complete: true,
          absenceEvidence: hits.length === 0,
          qualifications,
          warnings: [],
          hits: page,
          totalHits: hits.length,
          nextCursor,
          page: { offset, pageSize, returned: page.length, total: hits.length, nextCursor: nextCursor ?? null },
          snapshot: "current-filesystem-per-call",
          fullOutputPath: bounded.fullOutputPath,
        });
      }

      const limit = params.limit ?? 100;
      const normalizedRequest = {
        action: "query" as const,
        strategy: "fuzzy" as const,
        query: params.query,
        path: scope,
        limit,
      };
      const fingerprint = sha256(JSON.stringify(normalizedRequest));
      const fuzzy = await structuredFuzzySearch({
        cwd: operationCwd,
        query: params.query,
        path: scope,
        limit,
        ...(signal ? { signal } : {}),
      });
      const rendered = fuzzy.hits.map((hit, index) => `${index + 1}. ${hit.gitChanged ? "* " : ""}${hit.path} (score ${hit.score.toFixed(1)})`).join("\n");
      const qualifications = fuzzy.gitMetadataAvailable
        ? ["non-exhaustive", "git-change-boost-visible"]
        : ["non-exhaustive", "git-metadata-unavailable", "git-change-boost-disabled"];
      const warnings = fuzzy.gitMetadataAvailable
        ? []
        : ["Git metadata is unavailable; the fuzzy Git-change boost is disabled."];
      const bounded = await boundedOutput([
        "Strategy: fuzzy",
        "Coverage: ranked and non-exhaustive",
        `Returned: ${fuzzy.hits.length}`,
        fuzzy.gitMetadataAvailable
          ? "Qualification: zero results do not prove path absence; * marks a Git-changed path."
          : "Qualifications: zero results do not prove path absence; Git metadata is unavailable and the change boost is disabled.",
        "",
        rendered || "No fuzzy matches found",
      ].join("\n"), { prefix: "grounded-local-search", direction: "head", maxBytes: 30 * 1024 });
      return textResult(bounded.text, {
        schemaVersion: 1,
        normalizedRequest,
        requestFingerprint: fingerprint,
        fingerprint,
        engine: "fd-nul+grounded-fuzzy",
        fallbackAttempted: false,
        strategy: "fuzzy",
        scope,
        outcome: fuzzy.hits.length === 0 ? "no_matches" : "matches",
        coverage: "ranked",
        coverageClass: "ranked-non-exhaustive",
        complete: false,
        absenceEvidence: false,
        qualifications,
        warnings,
        hits: fuzzy.hits,
        page: { offset: 0, pageSize: limit, returned: fuzzy.hits.length, total: null, nextCursor: null },
        snapshot: "current-filesystem-per-call",
          fullOutputPath: bounded.fullOutputPath,
        });
      });
    }
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
