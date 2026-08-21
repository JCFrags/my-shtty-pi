import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import groundedFiles, {
  constructGroundedEditContent,
  constructGroundedWriteContent,
} from "../packages/files/index.ts";

function loadTools() {
  const tools = new Map<string, any>();
  const pi = {
    events: { on() { return () => {}; }, emit() {} },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  groundedFiles(pi as any);
  return tools;
}

function context(cwd: string) {
  return { cwd } as any;
}

test("additive trial mode keeps built-ins and registers grounded replacement names", () => {
  const previous = process.env.GROUNDED_TRIAL_MODE;
  process.env.GROUNDED_TRIAL_MODE = "1";
  try {
    const tools = loadTools();
    for (const name of ["read", "edit", "write", "grep", "find"]) {
      assert.equal(tools.has(name), false);
      assert.equal(tools.has(`grounded_${name}`), true);
    }
    assert.equal(tools.has("fuzzy_find"), true);
  } finally {
    if (previous === undefined) delete process.env.GROUNDED_TRIAL_MODE;
    else process.env.GROUNDED_TRIAL_MODE = previous;
  }
});

test("file extension performs strict edits while preserving BOM, CRLF, and mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-files-"));
  const path = join(cwd, "sample.js");
  await writeFile(path, "\ufeffconst a = 1;\r\nconst b = 2;\r\n", { mode: 0o640 });
  const tools = loadTools();

  const anchored = await tools.get("read").execute("r1", { path: "sample.js", mode: "anchors" }, undefined, undefined, context(cwd));
  const anchorText = anchored.content[0].text as string;
  const digest = anchorText.split("\n")[0]!.slice("snapshot:".length);
  assert.equal(digest.length, 64);

  const edited = await tools.get("edit").execute("e1", {
    path: "sample.js",
    expectedDigest: digest,
    edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
  }, undefined, undefined, context(cwd));
  assert.match(edited.content[0]!.text, /Successfully replaced/);
  const raw = await readFile(path, "utf8");
  assert.equal(raw, "\ufeffconst a = 1;\r\nconst b = 3;\r\n");
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal(edited.details.syntax.ok, true);
});

test("preview construction matches Grounded edit and write bytes for BOM and CRLF", async () => {
  const original = "\ufeffone\r\ntwo\r\n";
  const editInput = { path: "sample.txt", edits: [{ oldText: "two\n", newText: "TWO\n" }] };
  const preview = constructGroundedEditContent(original, editInput).content;
  assert.equal(preview, "\ufeffone\r\nTWO\r\n");

  const cwd = await mkdtemp(join(tmpdir(), "grounded-preview-bytes-"));
  const path = join(cwd, "sample.txt");
  await writeFile(path, original);
  const tools = loadTools();
  await tools.get("edit").execute("e1", editInput, undefined, undefined, context(cwd));
  assert.deepEqual(await readFile(path), Buffer.from(preview, "utf8"));

  const writeInput = { path: "sample.txt", content: "\ufeffliteral\r\nbytes\r\n" };
  const writePreview = constructGroundedWriteContent(preview, writeInput);
  await tools.get("write").execute("w1", writeInput, undefined, undefined, context(cwd));
  assert.deepEqual(await readFile(path), Buffer.from(writePreview, "utf8"));
});

test("Grounded preview adapter is explicit and uses the files extension owner path", () => {
  let registered: any;
  const pi = {
    events: {
      on() { return () => {}; },
      emit(channel: string, value: unknown) {
        if (channel === "pi-review-ui:register-preview-adapter-v1") registered = value;
      },
    },
    registerTool() {},
    registerCommand() {},
  };
  groundedFiles(pi as any);
  assert.equal(registered.protocolVersion, 1);
  assert.equal(registered.id, "pi-grounded-tools/files-v1");
  assert.match(registered.ownerSourcePath, /packages\/files\/index\.ts$/);
  assert.deepEqual(registered.tools, ["edit", "write"]);
});

test("full reads expose complete exact bytes when visible output is truncated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-full-read-"));
  const path = join(cwd, "large.txt");
  const original = `\ufeff${Array.from({ length: 2200 }, (_, index) => `line ${index}\r\n`).join("")}`;
  await writeFile(path, original);
  const tools = loadTools();
  const result = await tools.get("read").execute("r1", { path: "large.txt" }, undefined, undefined, context(cwd));
  assert.equal(result.details.truncation.truncated, true);
  assert.ok(result.details.fullOutputPath);
  assert.equal(await readFile(result.details.fullOutputPath, "utf8"), original);
  assert.match(result.content[0]!.text, /Complete original file bytes:/);
});

test("explicit PDF structure mode returns page markers and metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-pdf-"));
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await writeFile(join(cwd, "sample.pdf"), "%PDF-fake");
  await writeFile(join(bin, "pdfinfo"), "#!/bin/sh\nprintf 'Pages: 2\\nTitle: Exact\\n'\n");
  await writeFile(join(bin, "pdftotext"), "#!/bin/sh\nprintf 'first page\\fsecond page\\f'\n");
  await chmod(join(bin, "pdfinfo"), 0o755);
  await chmod(join(bin, "pdftotext"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const tools = loadTools();
    const result = await tools.get("read").execute("r1", { path: "sample.pdf", mode: "pdf_structure" }, undefined, undefined, context(cwd));
    assert.match(result.content[0]!.text, /Title: Exact/);
    assert.match(result.content[0]!.text, /--- Page 2 ---\nsecond page/);
    assert.equal(result.details.pages, 2);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("file extension rejects stale digests before mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-stale-"));
  const path = join(cwd, "sample.txt");
  await writeFile(path, "old\n");
  const tools = loadTools();
  await assert.rejects(
    tools.get("edit").execute("e1", {
      path: "sample.txt",
      expectedDigest: "0".repeat(64),
      edits: [{ oldText: "old", newText: "new" }],
    }, undefined, undefined, context(cwd)),
    /stale/,
  );
  assert.equal(await readFile(path, "utf8"), "old\n");
});
