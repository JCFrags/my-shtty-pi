import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalSessionProvider } from "@grounded/pi-core/local-session";
import { SessionServiceError } from "@grounded/pi-core/session-contract";

function request(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    env: { ...process.env },
    pty: false,
    openTimeoutMs: 10_000,
    commandTimeoutMs: 120_000,
    idleTimeoutMs: 30 * 60 * 1000,
    closeTimeoutMs: 5_000,
    ...overrides,
  } as any;
}

function streamBytes(result: Awaited<ReturnType<Awaited<ReturnType<LocalSessionProvider["open"]>>["execute"]>>, stream: "stdout" | "stderr" | "terminal") {
  return Buffer.concat(
    result.chunks
      .filter((chunk) => chunk.stream === stream)
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
}

test("local session preserves shell state, cwd, exact streams, and reusable nonzero completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "grounded-session-local-"));
  const child = join(root, "child");
  await mkdir(child);
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(root));
  try {
    const first = await session.execute(`export GROUNDED_VALUE=kept; cd child; printf 'out-one\\n'; printf 'err-one\\n' >&2`);
    assert.equal(first.exitCode, 0);
    assert.equal(first.cwd, child);
    assert.equal(streamBytes(first, "stdout").toString("utf8"), "out-one\n");
    assert.equal(streamBytes(first, "stderr").toString("utf8"), "err-one\n");
    assert.deepEqual(first.chunks.map((chunk) => chunk.sequence), first.chunks.map((_chunk, index) => index));

    const second = await session.execute(`printf '%s:%s\\n' "$GROUNDED_VALUE" "$PWD"; false`);
    assert.equal(second.exitCode, 1);
    assert.equal(streamBytes(second, "stdout").toString("utf8"), `kept:${child}\n`);
    assert.equal(session.status().state, "idle");

    const third = await session.execute("printf 'still-alive\\n'");
    assert.equal(third.exitCode, 0);
    assert.equal(streamBytes(third, "stdout").toString("utf8"), "still-alive\n");
    assert.equal((await stat(third.logPath)).mode & 0o777, 0o600);
    const log = (await readFile(third.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const thirdLog = log.filter((entry) => entry.requestId === third.requestId);
    assert.ok(thirdLog.some((entry) => Buffer.from(entry.dataBase64, "base64").includes(Buffer.from("still-alive"))));
  } finally {
    await session.close();
  }
  assert.equal(session.status().state, "closed");
});

test("local session framing corruption taints only that session", async () => {
  const provider = new LocalSessionProvider();
  const damaged = await provider.open(request(process.cwd()));
  const healthy = await provider.open(request(process.cwd()));
  try {
    await assert.rejects(
      () => damaged.execute("printf '\\000\\000\\000\\000' >&3"),
      (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_TAINTED",
    );
    assert.equal(damaged.status().state, "tainted");
    const result = await healthy.execute("printf 'healthy\\n'");
    assert.equal(streamBytes(result, "stdout").toString("utf8"), "healthy\n");
    assert.equal(healthy.status().state, "idle");
  } finally {
    await Promise.all([damaged.close(), healthy.close()]);
  }
});

test("local session close kills background descendants", async () => {
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(process.cwd()));
  const result = await session.execute("sleep 30 & printf '%s\\n' $!");
  const childPid = Number(streamBytes(result, "stdout").toString("utf8").trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
  await session.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});

test("local session rejects a regular file as the initial working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "grounded-session-cwd-"));
  const file = join(root, "not-a-directory");
  await writeFile(file, "x");
  const provider = new LocalSessionProvider();
  await assert.rejects(
    () => provider.open(request(file)),
    (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_CWD_INVALID",
  );
});

test("local PTY session returns one merged terminal stream and preserves state", async () => {
  const root = await mkdtemp(join(tmpdir(), "grounded-session-pty-"));
  const child = join(root, "child");
  await mkdir(child);
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(root, { pty: true }));
  try {
    assert.equal(session.pty, true);
    const first = await session.execute("export PTY_VALUE=kept; cd child; printf 'out\\n'; printf 'err\\n' >&2; test -t 0 && printf 'tty\\n'; stty size");
    assert.equal(first.exitCode, 0);
    assert.equal(first.cwd, child);
    assert.equal(first.stdoutBytes, 0);
    assert.equal(first.stderrBytes, 0);
    assert.equal(streamBytes(first, "terminal").toString("utf8"), "out\r\nerr\r\ntty\r\n24 80\r\n");
    assert.equal(first.terminalBytes, Buffer.byteLength("out\r\nerr\r\ntty\r\n24 80\r\n"));
    assert.ok(first.chunks.every((chunk) => chunk.stream === "terminal"));

    const second = await session.execute("printf '%s:%s\\n' \"$PTY_VALUE\" \"$PWD\"");
    assert.equal(streamBytes(second, "terminal").toString("utf8"), `kept:${child}\r\n`);
  } finally {
    await session.close();
  }
});

test("local PTY session accepts exact input bytes only while a command is running", async () => {
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(process.cwd(), { pty: true }));
  try {
    assert.throws(
      () => session.input(Buffer.from("idle")),
      (error: unknown) => error instanceof SessionServiceError && error.code === "SESSION_INPUT_NOT_RUNNING",
    );
    const command = session.execute(
      "__grounded_test_tty=$(stty -g); stty raw -echo; python3 -c 'import os,sys; sys.stdout.write(os.read(0,4).hex()); sys.stdout.flush()'; stty \"$__grounded_test_tty\"; unset __grounded_test_tty",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    session.input(Buffer.from([0x00, 0x41, 0x03, 0x42]));
    const result = await command;
    assert.equal(result.exitCode, 0);
    assert.equal(streamBytes(result, "terminal").toString("utf8"), "00410342");
  } finally {
    await session.close();
  }
});

test("local PTY interrupt cancels the foreground command and keeps the session reusable", async () => {
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(process.cwd(), { pty: true }));
  try {
    const command = session.execute("sleep 30; printf 'after-interrupt\\n'", { timeoutMs: 60_000 });
    setTimeout(() => session.interrupt(), 100).unref();
    const result = await command;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(session.status().state, "idle");
    const reuse = await session.execute("printf 'pty-reused\\n'");
    assert.equal(streamBytes(reuse, "terminal").toString("utf8"), "pty-reused\r\n");
  } finally {
    await session.close();
  }
});

test("local PTY close kills background descendants", async () => {
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(process.cwd(), { pty: true }));
  const result = await session.execute("sleep 30 & printf '%s\\n' $!");
  const childPid = Number(streamBytes(result, "terminal").toString("utf8").trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
  await session.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});

test("local session timeout interrupts the foreground process and reports timeout", async () => {
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(process.cwd()));
  try {
    const result = await session.execute("sleep 30; printf 'after-timeout\\n'", { timeoutMs: 100 });
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, true);
    assert.equal(session.status().state, "idle");
  } finally {
    await session.close();
  }
});

test("local session cancellation interrupts the foreground process and keeps a valid session reusable", async () => {
  const provider = new LocalSessionProvider();
  const session = await provider.open(request(process.cwd()));
  try {
    const controller = new AbortController();
    const command = session.execute("sleep 30; printf 'after-sleep\\n'", { signal: controller.signal, timeoutMs: 60_000 });
    setTimeout(() => controller.abort(), 100).unref();
    const result = await command;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(session.status().state, "idle");
    const reuse = await session.execute("printf 'reused\\n'");
    assert.equal(streamBytes(reuse, "stdout").toString("utf8"), "reused\n");
  } finally {
    await session.close();
  }
});
