import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { anchorDocument } from "@grounded/pi-core/anchors";
import { normalizeLf, sha256, stripBom } from "@grounded/pi-core/text";
import type { TextPreview } from "./check-types.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_TOTAL_BYTES = 4 * MAX_FILE_BYTES;

export interface EditProposal {
  path: string;
  expectedDigest: string;
  edits: Array<{ startAnchor: string; endAnchor: string; contentLines: string[] }>;
  patch: string;
}

export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"));
}

export async function readPreviewFile(path: string, root: string): Promise<string> {
  const [canonicalRoot, canonicalPath, info] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  if (!inside(canonicalRoot, canonicalPath) || !info.isFile() || info.isSymbolicLink()) {
    throw new Error("Preview requires an existing regular file inside the caller's admitted root; symlink edits are unsupported");
  }
  if (info.size > MAX_FILE_BYTES) throw new Error(`Preview file exceeds ${MAX_FILE_BYTES} bytes`);
  const bytes = await readFile(path);
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error("Preview requires bounded UTF-8 text without NUL bytes");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // TextDecoder strips a BOM. LSP positions refer to the original document text.
  return bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? `\ufeff${text}` : text;
}

export async function textPreviewProposal(preview: TextPreview, root: string): Promise<EditProposal | undefined> {
  const current = await readPreviewFile(preview.path, root);
  if (current !== preview.original) throw new Error(`Preview snapshot changed: ${preview.path}. Request a new preview.`);
  const before = normalizeLf(stripBom(preview.original).text);
  const after = normalizeLf(stripBom(preview.proposed).text);
  if (before === after) return undefined;
  if (Buffer.byteLength(after) > MAX_FILE_BYTES) throw new Error("Proposed file exceeds preview bound");
  const document = anchorDocument(before);
  return {
    path: preview.path, expectedDigest: sha256(before),
    edits: [{ startAnchor: document.anchors[0]!, endAnchor: document.anchors.at(-1)!, contentLines: after.split("\n") }],
    patch: generateUnifiedPatch(preview.path, before, after),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function filePath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search || url.hash) {
    throw new Error("Only local file URIs can produce edit proposals");
  }
  return fileURLToPath(url);
}

function position(text: string, value: unknown): number {
  if (!record(value) || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character) || Number(value.line) < 0 || Number(value.character) < 0) {
    throw new Error("Invalid LSP UTF-16 position");
  }
  const lines = text.split("\n");
  const line = Number(value.line);
  if (line >= lines.length) throw new Error("LSP edit line is outside the snapshot");
  const content = lines[line]!.replace(/\r$/, "");
  const character = Number(value.character);
  if (character > content.length) throw new Error("LSP edit column is outside the snapshot");
  const previous = content.charCodeAt(character - 1);
  const next = content.charCodeAt(character);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) throw new Error("LSP edit splits a UTF-16 surrogate pair");
  let offset = character;
  for (let index = 0; index < line; index++) offset += lines[index]!.length + 1;
  return offset;
}

function editedText(original: string, edits: unknown): string {
  if (!Array.isArray(edits) || edits.length > 2048) throw new Error("Invalid or over-bound LSP text edit list");
  const replacements = edits.map((item) => {
    if (!record(item) || !record(item.range) || typeof item.newText !== "string" || item.newText.includes("\0") || item.insertTextFormat !== undefined) {
      throw new Error("Only plain LSP TextEdit replacements are supported");
    }
    const start = position(original, item.range.start);
    const end = position(original, item.range.end);
    if (end < start) throw new Error("LSP edit ends before its start");
    return { start, end, text: item.newText };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < replacements.length; index++) {
    const a = replacements[index - 1]!;
    const b = replacements[index]!;
    if (a.end > b.start || a.start === b.start) throw new Error("Overlapping or ambiguous LSP edits are unsupported");
  }
  const proposedBytes = replacements.reduce((bytes, edit) => bytes - Buffer.byteLength(original.slice(edit.start, edit.end)) + Buffer.byteLength(edit.text), Buffer.byteLength(original));
  if (proposedBytes > MAX_FILE_BYTES) throw new Error("Proposed file exceeds preview bound");
  let proposed = original;
  for (const edit of replacements.reverse()) proposed = proposed.slice(0, edit.start) + edit.text + proposed.slice(edit.end);
  return proposed;
}

export async function workspaceEditProposals(edit: unknown, options: {
  root: string;
  originPath: string;
  originText: string;
  documentVersion?: number;
}): Promise<{ proposals: EditProposal[]; notes: string[] }> {
  if (await readPreviewFile(options.originPath, options.root) !== options.originText) throw new Error("Issuing document changed during the LSP request");
  if (edit === null || edit === undefined) return { proposals: [], notes: ["The server returned no text edits."] };
  if (!record(edit)) throw new Error("Invalid LSP workspace edit");
  if (edit.changes !== undefined && edit.documentChanges !== undefined) throw new Error("Ambiguous workspace edit contains both changes forms");
  const entries: Array<{ path: string; edits: unknown; version?: number | null }> = [];
  if (record(edit.changes)) {
    for (const [uri, edits] of Object.entries(edit.changes)) entries.push({ path: filePath(uri), edits });
  } else if (edit.changes !== undefined) throw new Error("Invalid workspace changes");
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) throw new Error("Invalid workspace documentChanges");
    for (const item of edit.documentChanges) {
      if (!record(item) || item.kind !== undefined || !record(item.textDocument) || typeof item.textDocument.uri !== "string") {
        throw new Error("File create, rename, delete and unknown workspace operations cannot be applied through this preview");
      }
      const version = item.textDocument.version;
      if (version !== undefined && version !== null && !Number.isSafeInteger(version)) throw new Error("Invalid LSP edit version");
      entries.push({ path: filePath(item.textDocument.uri), edits: item.edits, version: version as number | null | undefined });
    }
  }
  if (entries.length > MAX_FILES || new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("Over-bound or repeated workspace edit files");
  let bytes = 0;
  const previews: TextPreview[] = [];
  for (const entry of entries) {
    const original = await readPreviewFile(entry.path, options.root);
    bytes += Buffer.byteLength(original);
    if (bytes > MAX_TOTAL_BYTES) throw new Error("Workspace preview exceeds total byte bound");
    if (entry.path === options.originPath && original !== options.originText) throw new Error("Issuing document changed during the LSP request");
    if (entry.version !== undefined && entry.version !== null) {
      if (entry.path !== options.originPath || entry.version !== options.documentVersion) throw new Error("Cannot validate this versioned workspace edit against its issuing snapshot");
    }
    const proposed = editedText(original, entry.edits);
    bytes += Buffer.byteLength(proposed);
    if (bytes > MAX_TOTAL_BYTES) throw new Error("Captured and proposed workspace text exceeds total byte bound");
    previews.push({ tool: "lsp", path: entry.path, original, proposed, notes: [] });
  }
  const proposals: EditProposal[] = [];
  for (const preview of previews) {
    const proposal = await textPreviewProposal(preview, options.root);
    if (proposal) proposals.push(proposal);
  }
  return {
    proposals,
    notes: ["Preview only. Review the patch and apply each proposal explicitly through edit. Multi-file application is not atomic.",
      "Unversioned edits are proposals, not proof of semantic correctness. Other files are checked against the disk snapshots read for this preview.",
      "The existing edit tool preserves BOM and line-ending style. No server command or resource operation is executed."],
  };
}
