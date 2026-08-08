import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RepositoryTree } from "../src/filesystem.ts";
import { decodeUtf8 } from "../src/file-read.ts";
import {
  approximateTokensFromCharacters,
  formatLengthDelimitedFiles,
  formatSelectedPaths,
  InsertBudgetModel,
  parseLengthDelimitedFiles,
  prepareInsertBudget,
} from "../src/insertion.ts";
import { PreviewService, expandTabs } from "../src/preview.ts";
import { sanitizeTerminalText } from "../src/ui/text.ts";
import type { InsertCandidate } from "../src/types.ts";
import { withTempDirectory, writeFile } from "./helpers.ts";

test("sanitizes terminal controls and bidirectional overrides in untrusted preview text", () => {
  const sanitized = sanitizeTerminalText("safe\u001b]52;c;payload\u0007\u202Eend");
  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.includes("\u0007"), false);
  assert.match(sanitized, /␛/);
  assert.match(sanitized, /␇/);
  assert.match(sanitized, /U\+202E/);
});

test("trims only a valid incomplete UTF-8 tail in a bounded preview", () => {
  const incomplete = decodeUtf8(Uint8Array.from([0x61, 0xe2, 0x82]), { allowTrimmedTail: true });
  assert.deepEqual(incomplete, { text: "a", invalid: false, bytesConsumed: 1 });

  const malformed = decodeUtf8(Uint8Array.from([0x61, 0xff]), { allowTrimmedTail: true });
  assert.equal(malformed.invalid, true);
  assert.equal(malformed.text, "a�");

  const overlongPrefix = decodeUtf8(Uint8Array.from([0x61, 0xe0, 0x80]), { allowTrimmedTail: true });
  assert.equal(overlongPrefix.invalid, true);
});

test("detects binary previews and reports metadata instead of text", async () => {
  await withTempDirectory("pi-files-binary", async (root) => {
    await writeFile(root, "image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]));
    await writeFile(root, "nul.bin", Uint8Array.from([0x41, 0x00, 0x42]));
    await writeFile(root, "late-nul.bin", Buffer.concat([Buffer.alloc(9_000, 0x41), Buffer.from([0x00, 0x42])]));
    const tree = new RepositoryTree(root);
    await tree.initialize();
    const preview = new PreviewService(tree);
    const image = await preview.load("image.png");
    assert.equal(image.metadata.binary, true);
    assert.equal(image.metadata.binaryKind, "PNG image");
    assert.deepEqual(image.lines, []);
    const nul = await preview.load("nul.bin");
    assert.equal(nul.metadata.binary, true);
    assert.match(nul.metadata.binaryKind ?? "", /binary/i);
    const lateNul = await preview.load("late-nul.bin");
    assert.equal(lateNul.metadata.binary, true, "NUL detection scans the full bounded preview, not only the first 8 KiB");
    tree.dispose();
  });
});

test("truncates previews by bytes and lines, assumes UTF-8, and expands tabs only visually", async () => {
  await withTempDirectory("pi-files-preview-cap", async (root) => {
    const source = "a\tb\nline2\nline3\nline4";
    await writeFile(root, "source.txt", source);
    const tree = new RepositoryTree(root);
    await tree.initialize();

    const byLines = await new PreviewService(tree, { maxBytes: 1024, maxLines: 2 }).load("source.txt");
    assert.equal(byLines.metadata.truncated, true);
    assert.equal(byLines.metadata.truncatedBy, "lines");
    assert.deepEqual(byLines.lines, ["a\tb", "line2"]);
    assert.equal(byLines.metadata.encoding, "utf-8");
    assert.equal(expandTabs(byLines.lines[0] ?? "", 4), "a   b");
    assert.equal(byLines.rawText, source);

    const byBytes = await new PreviewService(tree, { maxBytes: 5, maxLines: 5000 }).load("source.txt");
    assert.equal(byBytes.metadata.truncated, true);
    assert.equal(byBytes.metadata.truncatedBy, "bytes");
    assert.ok(byBytes.metadata.bytesRead <= 5);
    tree.dispose();
  });
});

test("re-reads changed files and exposes a one-refresh file changed indicator", async () => {
  await withTempDirectory("pi-files-changed", async (root) => {
    await writeFile(root, "change.txt", "before");
    const tree = new RepositoryTree(root);
    await tree.initialize();
    const preview = new PreviewService(tree);
    const first = await preview.load("change.txt");
    assert.equal(first.metadata.changed, false);

    await fs.writeFile(path.join(root, "change.txt"), "after and larger");
    const now = new Date(Date.now() + 2000);
    await fs.utimes(path.join(root, "change.txt"), now, now);
    const changed = await preview.load("change.txt");
    assert.equal(changed.metadata.changed, true);
    assert.equal(changed.rawText, "after and larger");
    const stable = await preview.load("change.txt");
    assert.equal(stable.metadata.changed, false);
    tree.dispose();
  });
});

test("length-delimited insertion preserves exact content including literal closing tags", () => {
  const content = "first\n</file>\nlast\n";
  const pathValue = 'src/a&b"<tag>\n\u202E.ts';
  const candidate: InsertCandidate = {
    path: pathValue,
    absolutePath: "/tmp/example",
    bytes: Buffer.byteLength(content),
    characters: [...content].length,
    approximateTokens: approximateTokensFromCharacters([...content].length),
    content,
    binary: false,
    invalidUtf8: false,
    eligible: true,
    included: true,
  };
  const formatted = formatLengthDelimitedFiles([candidate]);
  assert.match(formatted, /format="pi-files-ui:length-delimited-v1"/);
  assert.match(formatted, new RegExp(`bytes="${Buffer.byteLength(content)}"`));
  const parsed = parseLengthDelimitedFiles(formatted);
  assert.deepEqual(parsed, [{ path: pathValue, content, bytes: Buffer.byteLength(content) }]);
});


test("paths insertion keeps one inert bullet per selected file", () => {
  const formatted = formatSelectedPaths(["normal/file.ts", "odd\\name\n\u202E.txt"]);
  assert.equal(formatted.split("\n").length, 3);
  assert.match(formatted, /- normal\/file\.ts/);
  assert.match(formatted, /odd\\\\name\\n\\u\{202E\}\.txt/);
});

test("content budgets exclude binary and oversized files and use ceil(characterCount / 4)", async () => {
  await withTempDirectory("pi-files-budget", async (root) => {
    await writeFile(root, "a.txt", "abcdef");
    await writeFile(root, "b.txt", "ghijkl");
    await writeFile(root, "large.txt", "x".repeat(21));
    await writeFile(root, "binary.dat", Uint8Array.from([65, 0, 66]));
    await writeFile(root, "late-binary.dat", Buffer.concat([Buffer.alloc(9_000, 0x41), Buffer.from([0x00])]));
    const tree = new RepositoryTree(root);
    await tree.initialize();
    const budget = await prepareInsertBudget(tree, ["a.txt", "b.txt", "large.txt", "binary.dat"], {
      perFileMaxBytes: 20,
      totalMaxBytes: 10,
    });
    const a = budget.candidates.find((candidate) => candidate.path === "a.txt");
    const b = budget.candidates.find((candidate) => candidate.path === "b.txt");
    const large = budget.candidates.find((candidate) => candidate.path === "large.txt");
    const binary = budget.candidates.find((candidate) => candidate.path === "binary.dat");
    assert.equal(a?.included, true);
    assert.equal(a?.approximateTokens, 2);
    assert.equal(b?.included, false);
    assert.equal(b?.reason, "total-limit");
    assert.equal(large?.reason, "per-file-limit");
    assert.equal(binary?.reason, "binary");
    assert.equal(budget.approximateTokens, 2);

    const model = new InsertBudgetModel(budget);
    assert.equal(model.toggle("a.txt"), true);
    assert.equal(model.toggle("b.txt"), true);
    assert.deepEqual(model.includedCandidates().map((candidate) => candidate.path), ["b.txt"]);
    assert.equal(model.budget.includedBytes, 6);

    const lateBinaryBudget = await prepareInsertBudget(tree, ["late-binary.dat"], {
      perFileMaxBytes: 10_000,
      totalMaxBytes: 10_000,
    });
    assert.equal(lateBinaryBudget.candidates[0]?.reason, "binary");
    tree.dispose();
  });
});
