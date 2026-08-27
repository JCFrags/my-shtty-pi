import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import groundedFiles, {
  constructGroundedEditContent,
  constructGroundedWriteContent,
  LocalSearchParams,
} from "../packages/files/index.ts";
import groundedProcess from "../packages/process/index.ts";
import {
  SESSION_PROVIDER_PROTOCOL_VERSION,
  SESSION_PROVIDER_REGISTER_EVENT,
  SessionServiceError,
} from "@grounded/pi-core/session-contract";

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

function renderToolCall(tool: any, args: Record<string, unknown>, width = 240): string[] {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  return tool.renderCall(args, theme).render(width).map((line: string) => line.trimEnd());
}

function createBus() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  return {
    on(name: string, handler: (value: unknown) => void) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
    emit(name: string, value: unknown) {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
}

function sessionHarness(order: "files-first" | "process-first") {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => any>>();
  const events = createBus();
  const pi = {
    events,
    on(name: string, handler: (event: any, ctx: any) => any) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  if (order === "files-first") {
    groundedFiles(pi as any);
    groundedProcess(pi as any);
  } else {
    groundedProcess(pi as any);
    groundedFiles(pi as any);
  }
  return {
    tools,
    events,
    async emitLifecycle(name: string, event: any = {}, ctx: any = {}) {
      for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function sessionContext(cwd: string) {
  return {
    cwd,
    thinkingLevel: "off",
    ui: { setStatus() {}, notify() {} },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
  } as any;
}

function digest(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function fakeSshProvider(initialCwd: string) {
  let cwd = initialCwd;
  let state: "idle" | "running" | "closed" = "idle";
  let closeSession!: () => void;
  const closed = new Promise<void>((resolveClosed) => { closeSession = resolveClosed; });
  const calls: string[] = [];
  const fileResource = {
    protocolVersion: 1 as const,
    queueIdentity: "fake-ssh:fixture",
    async resolve(path: string) {
      calls.push(`resolve:${path}`);
      return resolve(cwd, path);
    },
    async read(path: string, options: { allowMissing?: boolean } = {}) {
      calls.push(`read:${path}`);
      const canonicalPath = resolve(cwd, path);
      try {
        const [raw, info] = await Promise.all([readFile(canonicalPath), stat(canonicalPath)]);
        return {
          canonicalPath,
          exists: true,
          dataBase64: raw.toString("base64"),
          bytes: raw.length,
          rawDigest: digest(raw),
          mode: info.mode & 0o7777,
          hardLinks: info.nlink,
        };
      } catch (error) {
        if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return { canonicalPath, exists: false };
        throw error;
      }
    },
    async commit(request: {
      path: string;
      canonicalPath: string;
      dataBase64: string;
      expectedExists: boolean;
      expectedRawDigest?: string;
    }) {
      calls.push(`commit:${request.path}`);
      const canonicalPath = resolve(cwd, request.path);
      if (canonicalPath !== request.canonicalPath) throw new SessionServiceError("SESSION_FILE_CONFLICT", "path changed");
      let before: Buffer | undefined;
      try { before = await readFile(canonicalPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((before !== undefined) !== request.expectedExists || (before && request.expectedRawDigest !== digest(before))) {
        throw new SessionServiceError("SESSION_FILE_CONFLICT", "file changed");
      }
      const raw = Buffer.from(request.dataBase64, "base64");
      await writeFile(canonicalPath, raw);
      return {
        canonicalPath,
        bytes: raw.length,
        rawDigest: digest(raw),
        created: before === undefined,
        atomic: true,
        preservedHardLinks: false,
        hardLinksBefore: before === undefined ? 0 : 1,
        rollbackAvailable: true,
      };
    },
    async searchText(request: { query: string }) {
      calls.push(`searchText:${request.query}`);
      return {
        hits: ["a.txt", "b.txt"].map((path, index) => ({
          path,
          line: index + 1,
          byteColumn: 1,
          text: `${request.query} ${path}`,
          snippet: `${index + 1}: ${request.query} ${path}`,
          snippetStartLine: index + 1,
          snippetEndLine: index + 1,
          submatchCount: 1,
        })),
      };
    },
    async searchFiles() {
      calls.push("searchFiles");
      return { hits: [
        { path: "a.txt", kind: "file" as const },
        { path: "b.txt", kind: "file" as const },
        { path: "nested", kind: "directory" as const },
        { path: "nested/c.md", kind: "file" as const },
      ] };
    },
  };
  const handle = {
    providerId: "fake-ssh-v1",
    backend: "ssh" as const,
    pty: false,
    fileResource,
    status: () => ({ state, cwd, generation: 1, openedAt: 1, lastActivityAt: 1 }),
    async execute(command: string) {
      state = "running";
      if (command === "slow-cd-child") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        cwd = resolve(cwd, "child");
      }
      state = "idle";
      return {
        requestId: "fake",
        exitCode: 0,
        signal: null,
        cwd,
        cancelled: false,
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        terminalBytes: 0,
        truncated: false,
        chunks: [],
        logPath: "/tmp/fake-ssh-log",
      };
    },
    input() { throw new Error("not supported"); },
    interrupt() {},
    whenClosed: () => closed,
    async close() { state = "closed"; closeSession(); },
  };
  return {
    calls,
    provider: {
      id: "fake-ssh-v1",
      backend: "ssh" as const,
      protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
      capabilities: () => ({ backend: "ssh" as const, providerId: "fake-ssh-v1", protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION, pty: false, input: false }),
      async open() { return handle; },
    },
  };
}

test("additive trial mode keeps built-ins and exposes one local search tool", () => {
  const previous = process.env.GROUNDED_TRIAL_MODE;
  process.env.GROUNDED_TRIAL_MODE = "1";
  try {
    const tools = loadTools();
    for (const name of ["read", "edit", "write"]) {
      assert.equal(tools.has(name), false);
      assert.equal(tools.has(`grounded_${name}`), true);
    }
    for (const name of ["grep", "find", "fuzzy_find", "grounded_grep", "grounded_find"]) {
      assert.equal(tools.has(name), false);
    }
    assert.equal(tools.has("local_search"), true);
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

test("local_search schema strictly separates capabilities, text, files, and fuzzy", () => {
  assert.equal(Value.Check(LocalSearchParams, { action: "capabilities" }), true);
  assert.equal(Value.Check(LocalSearchParams, { action: "capabilities", strategy: "text" }), false);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "text", query: "x" }), true);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "text", query: "x", pathGlob: "*" }), false);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "files", pathGlob: "*.ts" }), true);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "files", pathGlob: "*.ts", query: "x" }), false);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "fuzzy", query: "x", limit: 500 }), true);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "fuzzy", query: "x", limit: 501 }), false);
  assert.equal(Value.Check(LocalSearchParams, { action: "query", strategy: "fuzzy", query: "x", pageSize: 10 }), false);
});

test("file schemas add only explicit local session routing", () => {
  const tools = loadTools();
  assert.equal(Value.Check(tools.get("read").parameters, { path: "a.txt", sessionId: "s_test" }), true);
  assert.equal(Value.Check(tools.get("edit").parameters, {
    path: "a.txt",
    edits: [{ oldText: "a", newText: "b" }],
    sessionId: "s_test",
  }), true);
  assert.equal(Value.Check(tools.get("write").parameters, {
    path: "a.txt",
    content: "x",
    sessionId: "s_test",
  }), true);
  assert.equal(Value.Check(LocalSearchParams, {
    action: "query",
    strategy: "text",
    query: "x",
    sessionId: "s_test",
  }), true);
  assert.equal(Value.Check(LocalSearchParams, {
    action: "query",
    strategy: "files",
    pathGlob: "*.txt",
    sessionId: "s_test",
  }), true);
  assert.equal(Value.Check(LocalSearchParams, {
    action: "capabilities",
    sessionId: "s_test",
  }), false);
});

test("session operation service discovery works in both extension load orders", async () => {
  for (const order of ["files-first", "process-first"] as const) {
    const cwd = await mkdtemp(join(tmpdir(), `grounded-files-${order}-`));
    await writeFile(join(cwd, "sample.txt"), `${order}\n`);
    const h = sessionHarness(order);
    const ctx = sessionContext(cwd);
    await h.emitLifecycle("session_start", {}, ctx);
    const opened = await h.tools.get("session").execute("s1", { action: "open", backend: "local" }, undefined, undefined, ctx);
    const sessionId = opened.details.snapshot.id as string;
    try {
      const result = await h.tools.get("read").execute("r1", {
        path: "sample.txt",
        sessionId,
      }, undefined, undefined, ctx);
      assert.match(result.content[0].text, new RegExp(order));
      assert.equal(result.details.sessionId, sessionId);
      assert.equal(result.details.sessionCwd, cwd);
    } finally {
      await h.tools.get("session").execute("s2", { action: "close", sessionId }, undefined, undefined, ctx).catch(() => undefined);
      await h.emitLifecycle("session_shutdown");
    }
  }
});

test("session-aware local file operations use the serialized session cwd and preserve exact semantics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-session-files-"));
  const child = join(cwd, "child");
  await mkdir(child);
  await writeFile(join(child, "sample.txt"), "\ufeffone\r\ntwo\r\n", { mode: 0o640 });
  await writeFile(join(child, "other.txt"), "needle other\n");
  const h = sessionHarness("files-first");
  const ctx = sessionContext(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const sessionTool = h.tools.get("session");
  const opened = await sessionTool.execute("s1", { action: "open", backend: "local" }, undefined, undefined, ctx);
  const sessionId = opened.details.snapshot.id as string;
  let secondSessionId: string | undefined;
  try {
    const move = h.tools.get("bash").execute("b1", {
      command: "sleep 0.05; cd child",
      sessionId,
    }, undefined, undefined, ctx);
    const queuedRead = h.tools.get("read").execute("r1", {
      path: "sample.txt",
      mode: "anchors",
      sessionId,
    }, undefined, undefined, ctx);
    await move;
    const anchored = await queuedRead;
    assert.equal(anchored.details.sessionCwd, child);
    assert.equal(anchored.details.sessionId, sessionId);
    const digest = anchored.content[0].text.split("\n")[0].slice("snapshot:".length);

    const edited = await h.tools.get("edit").execute("e1", {
      path: "sample.txt",
      expectedDigest: digest,
      edits: [{ oldText: "two", newText: "TWO" }],
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(edited.details.sessionCwd, child);
    assert.equal(await readFile(join(child, "sample.txt"), "utf8"), "\ufeffone\r\nTWO\r\n");
    assert.equal((await stat(join(child, "sample.txt"))).mode & 0o777, 0o640);

    const written = await h.tools.get("write").execute("w1", {
      path: "created.txt",
      content: "needle created\n",
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(written.details.sessionCwd, child);
    assert.equal(await readFile(join(child, "created.txt"), "utf8"), "needle created\n");

    const text = await h.tools.get("local_search").execute("q1", {
      action: "query",
      strategy: "text",
      query: "needle",
      path: ".",
      pageSize: 1,
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(text.details.sessionCwd, child);
    assert.equal(text.details.totalHits, 2);
    assert.ok(text.details.nextCursor);
    const textNext = await h.tools.get("local_search").execute("q2", {
      action: "query",
      strategy: "text",
      query: "needle",
      path: ".",
      pageSize: 1,
      cursor: text.details.nextCursor,
      sessionId,
    }, undefined, undefined, ctx);
    assert.notEqual(textNext.details.hits[0].path, text.details.hits[0].path);

    const files = await h.tools.get("local_search").execute("q3", {
      action: "query",
      strategy: "files",
      pathGlob: "*.txt",
      path: ".",
      sessionId,
    }, undefined, undefined, ctx);
    assert.deepEqual(files.details.hits.map((hit: any) => hit.path), ["created.txt", "other.txt", "sample.txt"]);

    const second = await sessionTool.execute("s2", {
      action: "open",
      backend: "local",
      cwd: "child",
    }, undefined, undefined, ctx);
    secondSessionId = second.details.snapshot.id as string;
    await assert.rejects(
      h.tools.get("local_search").execute("q4", {
        action: "query",
        strategy: "text",
        query: "needle",
        path: ".",
        pageSize: 1,
        cursor: text.details.nextCursor,
        sessionId: secondSessionId,
      }, undefined, undefined, ctx),
      /cursor does not match/,
    );

    await assert.rejects(
      h.tools.get("local_search").execute("q5", {
        action: "query",
        strategy: "fuzzy",
        query: "sample",
        sessionId,
      }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_SEARCH_STRATEGY_UNSUPPORTED",
    );
    await assert.rejects(
      h.tools.get("read").execute("missing", { path: "missing.txt", sessionId }, undefined, undefined, ctx),
      /ENOENT|no such file/i,
    );
    const reused = await h.tools.get("read").execute("r2", { path: "created.txt", sessionId }, undefined, undefined, ctx);
    assert.match(reused.content[0].text, /needle created/);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      h.tools.get("read").execute("aborted", { path: "created.txt", sessionId }, controller.signal, undefined, ctx),
      /Operation aborted/,
    );
  } finally {
    if (secondSessionId) {
      await sessionTool.execute("s3", { action: "close", sessionId: secondSessionId }, undefined, undefined, ctx).catch(() => undefined);
    }
    await sessionTool.execute("s4", { action: "close", sessionId }, undefined, undefined, ctx).catch(() => undefined);
    await h.emitLifecycle("session_shutdown");
  }
});

test("session-aware remote file operations use provider resources and the shared session FIFO", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-remote-session-files-"));
  const child = join(cwd, "child");
  await mkdir(child);
  await writeFile(join(child, "sample.txt"), "one\ntwo\n", { mode: 0o640 });
  const h = sessionHarness("files-first");
  const fake = fakeSshProvider(cwd);
  h.events.emit(SESSION_PROVIDER_REGISTER_EVENT, {
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    provider: fake.provider,
  });
  const ctx = sessionContext(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const sessionTool = h.tools.get("session");
  const opened = await sessionTool.execute("s1", {
    action: "open",
    backend: "ssh",
    target: "fixture",
  }, undefined, undefined, ctx);
  const sessionId = opened.details.snapshot.id as string;
  try {
    const move = h.tools.get("bash").execute("b1", {
      command: "slow-cd-child",
      sessionId,
    }, undefined, undefined, ctx);
    const queued = h.tools.get("read").execute("r1", {
      path: "sample.txt",
      mode: "anchors",
      sessionId,
    }, undefined, undefined, ctx);
    await move;
    const anchored = await queued;
    assert.equal(anchored.details.sessionBackend, "ssh");
    assert.equal(anchored.details.sessionCwd, child);
    const anchorText = anchored.content[0].text as string;
    const snapshotDigest = anchorText.split("\n")[0]!.slice("snapshot:".length);

    const edited = await h.tools.get("edit").execute("e1", {
      path: "sample.txt",
      expectedDigest: snapshotDigest,
      edits: [{ oldText: "two", newText: "TWO" }],
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(await readFile(join(child, "sample.txt"), "utf8"), "one\nTWO\n");
    assert.equal(edited.details.rollbackAvailable, true);
    assert.equal(edited.details.hardLinkTopologyRollback, false);

    const written = await h.tools.get("write").execute("w1", {
      path: "created.txt",
      content: "created\n",
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(await readFile(join(child, "created.txt"), "utf8"), "created\n");
    assert.equal(written.details.sessionBackend, "ssh");

    const first = await h.tools.get("local_search").execute("q1", {
      action: "query",
      strategy: "text",
      query: "needle",
      pageSize: 1,
      sessionId,
    }, undefined, undefined, ctx);
    assert.equal(first.details.totalHits, 2);
    assert.ok(first.details.nextCursor);
    const second = await h.tools.get("local_search").execute("q2", {
      action: "query",
      strategy: "text",
      query: "needle",
      pageSize: 1,
      cursor: first.details.nextCursor,
      sessionId,
    }, undefined, undefined, ctx);
    assert.notEqual(second.details.hits[0].path, first.details.hits[0].path);

    const files = await h.tools.get("local_search").execute("q3", {
      action: "query",
      strategy: "files",
      pathGlob: "nested/*.md",
      sessionId,
    }, undefined, undefined, ctx);
    assert.deepEqual(files.details.hits.map((hit: any) => hit.path), ["nested/c.md"]);
    assert.ok(fake.calls.includes("searchText:needle"));
    assert.ok(fake.calls.includes("searchFiles"));
    assert.ok(fake.calls.some((call) => call.startsWith("commit:")));

    await assert.rejects(
      h.tools.get("read").execute("pdf", {
        path: "sample.txt",
        mode: "pdf_structure",
        sessionId,
      }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_READ_MODE_UNSUPPORTED",
    );
    const reused = await h.tools.get("read").execute("r2", {
      path: "created.txt",
      sessionId,
    }, undefined, undefined, ctx);
    assert.match(reused.content[0].text, /created/);
  } finally {
    await sessionTool.execute("s2", { action: "close", sessionId }, undefined, undefined, ctx).catch(() => undefined);
    await h.emitLifecycle("session_shutdown");
  }
});

test("SSH sessions without a file resource fail closed without local fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-remote-resource-unavailable-"));
  await writeFile(join(cwd, "local-only.txt"), "must not be read\n");
  const h = sessionHarness("process-first");
  const fake = fakeSshProvider(cwd);
  const provider = {
    ...fake.provider,
    async open() {
      const handle = await fake.provider.open();
      const { fileResource: _omitted, ...withoutResource } = handle;
      return withoutResource;
    },
  };
  h.events.emit(SESSION_PROVIDER_REGISTER_EVENT, {
    protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION,
    provider,
  });
  const ctx = sessionContext(cwd);
  await h.emitLifecycle("session_start", {}, ctx);
  const sessionTool = h.tools.get("session");
  const opened = await sessionTool.execute("s1", { action: "open", backend: "ssh", target: "fixture" }, undefined, undefined, ctx);
  const sessionId = opened.details.snapshot.id as string;
  try {
    await assert.rejects(
      h.tools.get("read").execute("r1", { path: "local-only.txt", sessionId }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_FILE_RESOURCE_UNAVAILABLE",
    );
  } finally {
    await sessionTool.execute("s2", { action: "close", sessionId }, undefined, undefined, ctx).catch(() => undefined);
    await h.emitLifecycle("session_shutdown");
  }
});

test("session-aware file requests fail closed without Process or Review UI support", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-session-file-fail-closed-"));
  await writeFile(join(cwd, "sample.txt"), "old\n");
  let adapter: any;
  const tools = new Map<string, any>();
  const pi = {
    events: {
      on() { return () => {}; },
      emit(channel: string, value: unknown) {
        if (channel === "pi-review-ui:register-preview-adapter-v1") adapter = value;
      },
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
  };
  groundedFiles(pi as any);
  await assert.rejects(
    tools.get("read").execute("r1", { path: "sample.txt", sessionId: "s_unknown" }, undefined, undefined, context(cwd)),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_SERVICE_UNAVAILABLE",
  );
  await assert.rejects(
    adapter.semantics.constructEdit({
      input: { path: "sample.txt", edits: [{ oldText: "old", newText: "new" }], sessionId: "s_unknown" },
      current: Buffer.from("old\n"),
      currentExists: true,
    }),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_REVIEW_UNSUPPORTED",
  );
});

test("local_search renders the strategy, search value, scope, and safe modifiers", () => {
  const tool = loadTools().get("local_search");

  assert.deepEqual(renderToolCall(tool, { action: "capabilities" }), ["local_search capabilities"]);
  assert.deepEqual(renderToolCall(tool, {
    action: "query",
    strategy: "text",
    query: "needle\n\"quoted\"\\tail",
    path: "src dir",
    syntax: "regex",
    fileGlob: "**/*.ts",
    ignoreCase: true,
    contextLines: 4,
    cursor: "opaque-cursor-secret",
    sessionId: "opaque-session-secret",
  }), ['local_search text "needle\\n\\"quoted\\"\\\\tail" in "src dir" · regex · files "**/*.ts" · ignore case · context 4 · next page · session']);
  assert.deepEqual(renderToolCall(tool, {
    action: "query",
    strategy: "files",
    pathGlob: "src/**/*.ts",
    cursor: "opaque-cursor-secret",
    sessionId: "opaque-session-secret",
  }), ['local_search files "src/**/*.ts" in "." · next page · session']);
  assert.deepEqual(renderToolCall(tool, {
    action: "query",
    strategy: "fuzzy",
    query: "session auth",
    path: "packages",
  }), ['local_search fuzzy "session auth" in "packages"']);

  const longLines = renderToolCall(tool, {
    action: "query",
    strategy: "text",
    query: "x".repeat(200),
    path: ".",
  }, 40);
  assert.ok(longLines.some((line) => line.includes("…")));
  assert.ok(longLines.every((line) => line.length <= 40));
  assert.doesNotMatch(longLines.join("\n"), /opaque-(?:cursor|session)-secret/);
});

test("local_search exposes explicit strategies and structured hit pagination", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "grounded-local-search-"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "a.ts"), "needle one\n");
  await writeFile(join(cwd, "src", "b.ts"), "needle two\n");
  const tool = loadTools().get("local_search");

  const capabilities = await tool.execute("s0", { action: "capabilities" }, undefined, undefined, context(cwd));
  assert.deepEqual(capabilities.details.strategies, ["text", "files", "fuzzy"]);

  const first = await tool.execute("s1", {
    action: "query",
    strategy: "text",
    query: "needle",
    path: ".",
    pageSize: 1,
  }, undefined, undefined, context(cwd));
  assert.equal(first.details.schemaVersion, 1);
  assert.equal(first.details.engine, "ripgrep-json");
  assert.equal(first.details.coverage, "exhaustive");
  assert.equal(first.details.coverageClass, "exhaustive");
  assert.equal(first.details.complete, true);
  assert.equal(first.details.absenceEvidence, false);
  assert.equal(first.details.fallbackAttempted, false);
  assert.equal(first.details.scope, ".");
  assert.equal(first.details.hits.length, 1);
  assert.equal(first.details.totalHits, 2);
  assert.equal(first.details.page.returned, 1);
  assert.ok(first.details.nextCursor);

  const second = await tool.execute("s2", {
    action: "query",
    strategy: "text",
    query: "needle",
    path: ".",
    pageSize: 1,
    cursor: first.details.nextCursor,
  }, undefined, undefined, context(cwd));
  assert.equal(second.details.hits.length, 1);
  assert.notEqual(second.details.hits[0].path, first.details.hits[0].path);

  await assert.rejects(tool.execute("s3", {
    action: "query",
    strategy: "text",
    query: "different",
    path: ".",
    pageSize: 1,
    cursor: first.details.nextCursor,
  }, undefined, undefined, context(cwd)), /does not match/);

  const malformedCursor = Buffer.from(JSON.stringify({
    version: 1,
    strategy: "text",
    fingerprint: "0".repeat(64),
    offset: 0,
    extra: true,
  }), "utf8").toString("base64url");
  await assert.rejects(tool.execute("s3b", {
    action: "query",
    strategy: "text",
    query: "needle",
    path: ".",
    cursor: malformedCursor,
  }, undefined, undefined, context(cwd)), /Invalid local_search cursor/);

  const zero = await tool.execute("s3c", {
    action: "query",
    strategy: "text",
    query: "absent exact term",
    path: ".",
  }, undefined, undefined, context(cwd));
  assert.equal(zero.details.outcome, "no_matches");
  assert.equal(zero.details.complete, true);
  assert.equal(zero.details.absenceEvidence, true);
  assert.equal(zero.details.fallbackAttempted, false);
  assert.deepEqual(zero.details.hits, []);

  const files = await tool.execute("s4", {
    action: "query",
    strategy: "files",
    pathGlob: "src/*.ts",
    path: ".",
  }, undefined, undefined, context(cwd));
  assert.deepEqual(files.details.hits.map((hit: any) => hit.path), ["src/a.ts", "src/b.ts"]);
  assert.equal(files.details.engine, "fd-nul");
  assert.equal(files.details.complete, true);

  const fuzzy = await tool.execute("s5", {
    action: "query",
    strategy: "fuzzy",
    query: "ats",
    path: ".",
    limit: 10,
  }, undefined, undefined, context(cwd));
  assert.equal(fuzzy.details.coverage, "ranked");
  assert.equal(fuzzy.details.coverageClass, "ranked-non-exhaustive");
  assert.equal(fuzzy.details.complete, false);
  assert.equal(fuzzy.details.absenceEvidence, false);
  assert.equal(fuzzy.details.page.pageSize, 10);
  assert.ok(fuzzy.details.qualifications.includes("git-metadata-unavailable"));
  assert.equal(fuzzy.details.warnings.length, 1);
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
