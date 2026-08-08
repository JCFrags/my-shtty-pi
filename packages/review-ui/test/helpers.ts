import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ReviewPreview } from "../src/preview.js";

export async function makeTempDir(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "pi-review-ui-test-"));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export const identityTheme: Theme = {
  fg(_name, text) {
    return text;
  },
  bg(_name, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

export class FakeTui implements TUI {
  readonly terminal = { rows: 40, columns: 100 };
  renderRequests = 0;

  requestRender(): void {
    this.renderRequests += 1;
  }
}

export function makeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      notify() {},
      async custom() {
        throw new Error("custom UI not configured in test");
      },
    },
    ...overrides,
  } as ExtensionContext;
}

export function makePreview(overrides: Partial<ReviewPreview> = {}): ReviewPreview {
  const cwd = process.cwd();
  return {
    tool: "write",
    toolCallId: "call-1",
    path: {
      inputPath: "file.txt",
      cwdPath: cwd,
      cwdRealPath: cwd,
      lexicalPath: join(cwd, "file.txt"),
      effectivePath: join(cwd, "file.txt"),
      displayPath: "file.txt",
      lexicalOutsideCwd: false,
      effectiveOutsideCwd: false,
      outsideCwd: false,
      usedSymlink: false,
      symlinkPaths: [],
      targetExists: true,
      targetKind: "file",
      missingParentDirectories: [],
    },
    current: {
      exists: true,
      bytes: 4,
      lines: 1,
      sha256: "a".repeat(64),
      containsNul: false,
      binaryLike: false,
    },
    proposed: {
      exists: true,
      bytes: 4,
      lines: 1,
      sha256: "b".repeat(64),
      containsNul: false,
      binaryLike: false,
    },
    proposedContent: "new\n",
    previewText: "--- file.txt\n+++ file.txt\n-old\n+new",
    warnings: [],
    binary: false,
    oversized: false,
    changed: true,
    ...overrides,
  };
}

export async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
