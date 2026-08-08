import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeObservedPath,
  redactHomePathPrefixes,
  sanitizeFirstCommandLine,
  sanitizeSummary,
  sanitizeVisible,
} from "../src/sanitize.ts";

test("command summaries use only the first line and redact common credential forms", () => {
  const command =
    "EXAMPLE_TOKEN=demo npm test -- --api-key another --password=demo-pass\ncat /etc/passwd";
  const sanitized = sanitizeFirstCommandLine(command);

  assert.equal(sanitizeFirstCommandLine("EXAMPLE=demo"), "EXAMPLE=demo");
  assert.match(sanitized, /^EXAMPLE_TOKEN=<redacted> npm test -- --api-key /u);
  assert.ok(Array.from(sanitized).length <= 52);
  assert.doesNotMatch(sanitized, /demo|another|demo-pass|passwd/u);
  assert.doesNotMatch(sanitized, /[\r\n]/u);
});

test("command summaries redact URL userinfo and authorization material", () => {
  const sanitized = sanitizeFirstCommandLine(
    "curl -H 'Authorization: Bearer demo-token' https://user:demo-pass@example.test/path",
  );
  assert.doesNotMatch(sanitized, /demo-token|user:pass/u);
  assert.match(sanitized, /<redacted>/u);
});

test("command summaries do not expose an absolute home-directory prefix", () => {
  assert.equal(
    sanitizeFirstCommandLine("cat /workspace/alice/private/notes.txt", "/workspace/alice"),
    "cat ~/private/notes.txt",
  );
  assert.equal(
    redactHomePathPrefixes("type C:\\Users\\Alice\\private.txt", "C:\\Users\\Alice"),
    "type ~\\private.txt",
  );
});

test("command summaries redact prefixed secret options, user credentials, and secret headers", () => {
  assert.equal(sanitizeFirstCommandLine("curl -u admin:demo-pass"), "curl -u <redacted>");
  assert.equal(
    sanitizeFirstCommandLine("tool --client-secret demo"),
    "tool --client-secret <redacted>",
  );
  assert.equal(
    sanitizeFirstCommandLine("curl -H 'X-Api-Key: demo-token'"),
    "curl -H 'X-Api-Key: <redacted>'",
  );
  assert.equal(
    sanitizeFirstCommandLine("curl https://demo-token@example.test"),
    "curl https://<redacted>@example.test",
  );
});

test("visible metadata removes controls and stays within the requested character limit", () => {
  const sanitized = sanitizeVisible("abc\u0000\n\u001b[31mdefghijkl", 8);
  assert.equal(Array.from(sanitized).length, 8);
  assert.doesNotMatch(sanitized, /[\u0000-\u001F\u007F-\u009F]/u);
  assert.doesNotMatch(sanitized, /\u001b\[/u);
});

test("summary metadata is capped at 60 visible code points", () => {
  const summary = sanitizeSummary("x".repeat(200));
  assert.equal(Array.from(summary).length, 60);
  assert.ok(summary.endsWith("…"));
});

test("paths are normalized and displayed relative to cwd", () => {
  const normalized = normalizeObservedPath(
    "/workspace/alice/project/src/../src/auth/session.ts",
    "/workspace/alice/project",
    "/workspace/alice",
  );

  assert.deepEqual(normalized, {
    key: "/workspace/alice/project/src/auth/session.ts",
    display: "src/auth/session.ts",
  });
});

test("absolute home prefixes are not exposed outside cwd", () => {
  const normalized = normalizeObservedPath(
    "/workspace/alice/private/notes.txt",
    "/workspace/alice/project",
    "/workspace/alice",
  );

  assert.equal(normalized?.display, "~/private/notes.txt");
  assert.doesNotMatch(normalized?.display ?? "", /^\/home\/alice/u);
});

test("absolute paths outside cwd and home fall back to a basename", () => {
  const normalized = normalizeObservedPath(
    "/var/tmp/build/output.log",
    "/workspace/alice/project",
    "/workspace/alice",
  );
  assert.equal(normalized?.display, "output.log");
});
