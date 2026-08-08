import assert from "node:assert/strict";
import test from "node:test";
import { constructEditWithBuiltin, type EditToolFactory } from "../src/pi-semantics.js";

test("constructEditWithBuiltin captures the built-in write operation without touching disk or arguments", async () => {
  const input = { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] };
  const before = structuredClone(input);
  let accessed = false;
  let read = false;
  let writtenPath: string | undefined;

  const factory = ((_cwd: string, options?: { operations?: unknown }) => {
    const operations = options?.operations as {
      access(path: string): Promise<void>;
      readFile(path: string): Promise<Buffer>;
      writeFile(path: string, content: string): Promise<void>;
    };
    return {
      async execute(_id: string, receivedInput: typeof input): Promise<void> {
        assert.equal(receivedInput, input, "the original argument object is passed through");
        await operations.access("/virtual/file.txt");
        accessed = true;
        const current = await operations.readFile("/virtual/file.txt");
        read = true;
        assert.equal(current.toString("utf8"), "old\r\n");
        writtenPath = "/virtual/file.txt";
        await operations.writeFile(writtenPath, "new\r\n");
      },
    };
  }) as EditToolFactory;

  const result = await constructEditWithBuiltin(
    {
      cwd: "/virtual",
      input,
      current: Buffer.from("old\r\n"),
      currentExists: true,
    },
    factory,
  );

  assert.equal(result, "new\r\n");
  assert.equal(accessed, true);
  assert.equal(read, true);
  assert.equal(writtenPath, "/virtual/file.txt");
  assert.deepEqual(input, before, "preview construction must not mutate arguments");
});

test("constructEditWithBuiltin fails for a missing edit target", async () => {
  const factory = ((_cwd: string, options?: { operations?: unknown }) => {
    const operations = options?.operations as { access(path: string): Promise<void> };
    return {
      async execute(): Promise<void> {
        await operations.access("/virtual/missing.txt");
      },
    };
  }) as EditToolFactory;

  await assert.rejects(
    () =>
      constructEditWithBuiltin(
        {
          cwd: "/virtual",
          input: { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
          current: Buffer.alloc(0),
          currentExists: false,
        },
        factory,
      ),
    (error: unknown) =>
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("constructEditWithBuiltin fails closed if the built-in preview does not write", async () => {
  const factory = (() => ({ async execute(): Promise<void> {} })) as EditToolFactory;
  await assert.rejects(
    () =>
      constructEditWithBuiltin(
        {
          cwd: "/virtual",
          input: { path: "file.txt", edits: [{ oldText: "a", newText: "b" }] },
          current: Buffer.from("a"),
          currentExists: true,
        },
        factory,
      ),
    /without producing content/,
  );
});
